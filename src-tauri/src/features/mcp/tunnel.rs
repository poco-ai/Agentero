//! Built-in ChatGPT Secure MCP Tunnel supervisor (Settings → MCP server).
//!
//! Spawns and owns a `tunnel-client run` child so the loopback MCP surface is
//! reachable from ChatGPT without the user keeping a terminal open. The child
//! lives and dies with Agentero on purpose — same lifetime as the MCP listener
//! it fronts. See `docs/backend/mcp.md`.

use crate::core::http::effective_proxy_url;
use crate::core::paths::mcp_tunnel_dir;
use crate::features::agent::discover::resolve_command;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::process::Command;

/// Event name follows `docs/development/lifecycle-events.md` (one domain, one colon).
pub const MCP_TUNNEL_STATUS_EVENT: &str = "mcp:tunnel-status";

pub const TUNNEL_CLIENT_BIN: &str = "tunnel-client";

/// Surfaced on the status payload so the install hint stays out of i18n.
pub const TUNNEL_INSTALL_COMMAND: &str = "brew install openai/tools/tunnel-client";

const READY_POLL_EVERY: Duration = Duration::from_millis(1500);
/// `run` retries auth failures forever instead of exiting, so "started" is not
/// "connected"; after this budget the dot gives up and reports why.
const READY_BUDGET: Duration = Duration::from_secs(30);
const KEEPALIVE_POLL_EVERY: Duration = Duration::from_secs(10);
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const LOG_TAIL_CHARS: usize = 800;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum McpTunnelPhase {
    /// `tunnel-client` is not on PATH / common install dirs.
    BinaryMissing,
    Stopped,
    /// Child is up but no successful control-plane poll yet.
    Starting,
    Ready,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTunnelStatus {
    pub phase: McpTunnelPhase,
    /// Child process is alive (independent of `phase == ready`).
    pub running: bool,
    pub pid: Option<u32>,
    /// Loopback MCP URL handed to the tunnel as its target.
    pub mcp_url: Option<String>,
    pub install_command: String,
    pub last_error: Option<String>,
}

struct Inner {
    phase: McpTunnelPhase,
    running: bool,
    pid: Option<u32>,
    mcp_url: Option<String>,
    last_error: Option<String>,
    child: Option<Arc<tokio::sync::Mutex<tokio::process::Child>>>,
    /// Bumped on every start so poller/waiter tasks from a superseded run
    /// (e.g. an MCP port change) can retire instead of resurrecting the old one.
    generation: u64,
    app: Option<AppHandle>,
}

fn idle_status() -> McpTunnelStatus {
    McpTunnelStatus {
        phase: McpTunnelPhase::Stopped,
        running: false,
        pid: None,
        mcp_url: None,
        install_command: TUNNEL_INSTALL_COMMAND.to_string(),
        last_error: None,
    }
}

fn status_from(g: &Inner) -> McpTunnelStatus {
    McpTunnelStatus {
        phase: g.phase,
        running: g.running,
        pid: g.pid,
        mcp_url: g.mcp_url.clone(),
        install_command: TUNNEL_INSTALL_COMMAND.to_string(),
        last_error: g.last_error.clone(),
    }
}

/// True for the documented OpenAI shape: `tunnel_` + 32 lowercase hex.
///
/// Enforced host-side because the value is passed as argv: a leading `--`
/// would otherwise let a pasted string become a flag.
pub fn tunnel_id_shape_ok(id: &str) -> bool {
    let Some(hex) = id.strip_prefix("tunnel_") else {
        return false;
    };
    hex.len() == 32
        && hex
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Flags for `tunnel-client run`. The API key is deliberately absent: only the
/// *name* of the env var crosses argv, never the secret (which would show up in
/// `ps`). A private `--profile-dir` also keeps a user's own
/// `~/.config/tunnel-client/*.yaml` from leaking into this run.
fn run_args(
    tunnel_id: &str,
    mcp_url: &str,
    profile_dir: &Path,
    health_url_file: &Path,
    log_file: &Path,
    proxy: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        "run".to_string(),
        "--profile-dir".to_string(),
        profile_dir.display().to_string(),
        "--control-plane.tunnel-id".to_string(),
        tunnel_id.to_string(),
        "--control-plane.api-key".to_string(),
        "env:CONTROL_PLANE_API_KEY".to_string(),
        "--mcp.server-url".to_string(),
        mcp_url.to_string(),
        // Ephemeral port: a manually-run tunnel-client on the default 8080
        // must not make this one fail to bind.
        "--health.listen-addr".to_string(),
        "127.0.0.1:0".to_string(),
        "--health.url-file".to_string(),
        health_url_file.display().to_string(),
        "--log.file".to_string(),
        log_file.display().to_string(),
        "--log.level".to_string(),
        "info".to_string(),
    ];
    if proxy.is_some() {
        // Only the control plane should use the user's proxy. MCP traffic is
        // loopback and must stay direct; tunnel-client does not honor
        // NO_PROXY for the MCP route, so a global --http-proxy would break it.
        args.push("--control-plane.http-proxy".to_string());
        args.push("env:AGENTERO_TUNNEL_PROXY".to_string());
    }
    args
}

fn health_args(url_file: &Path, pid: u32) -> Vec<String> {
    vec![
        "health".to_string(),
        "--url-file".to_string(),
        url_file.display().to_string(),
        "--pid".to_string(),
        pid.to_string(),
        "--json".to_string(),
        // `/readyz` answers 200 "ready" even with a bogus key, so the only
        // honest connectivity signal is "did a control-plane poll succeed".
        "--require-control-plane-poll".to_string(),
    ]
}

/// Last lines of the child's log, folded into `last_error` so a config-level
/// failure (unknown flag, missing env) is actionable without opening a terminal.
fn log_tail(path: &Path, max_chars: usize) -> String {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(_) => return String::new(),
    };
    let lines: Vec<&str> = raw
        .lines()
        .rev()
        .filter(|l| !l.trim().is_empty())
        .take(6)
        .collect();
    let joined = lines.into_iter().collect::<Vec<_>>().join(" | ");
    let chars: Vec<char> = joined.chars().collect();
    if chars.len() <= max_chars {
        return joined;
    }
    chars[chars.len() - max_chars..].iter().collect()
}

impl Default for McpTunnelController {
    fn default() -> Self {
        Self::new()
    }
}

pub struct McpTunnelController {
    inner: Mutex<Inner>,
}

impl McpTunnelController {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                phase: McpTunnelPhase::Stopped,
                running: false,
                pid: None,
                mcp_url: None,
                last_error: None,
                child: None,
                generation: 0,
                app: None,
            }),
        }
    }

    pub fn set_app_handle(&self, app: AppHandle) {
        if let Ok(mut g) = self.inner.lock() {
            g.app = Some(app);
        }
    }

    pub fn status(&self) -> McpTunnelStatus {
        self.inner
            .lock()
            .map(|g| status_from(&g))
            .unwrap_or_else(|_| idle_status())
    }

    pub fn is_running(&self) -> bool {
        self.inner.lock().map(|g| g.running).unwrap_or(false)
    }

    /// Current tunnel target URL, if any (used to detect an MCP port change).
    fn bound_mcp_url(&self) -> Option<String> {
        self.inner.lock().ok().and_then(|g| g.mcp_url.clone())
    }

    fn emit_status(&self) {
        let (app, status) = match self.inner.lock() {
            Ok(g) => (g.app.clone(), status_from(&g)),
            Err(_) => return,
        };
        if let Some(app) = app {
            let _ = app.emit(MCP_TUNNEL_STATUS_EVENT, &status);
        }
    }

    pub async fn start(
        self: &Arc<Self>,
        mcp_url: String,
        tunnel_id: String,
        api_key: String,
    ) -> McpTunnelStatus {
        if self.is_running() {
            return self.status();
        }
        if !tunnel_id_shape_ok(&tunnel_id) {
            let mut g = match self.inner.lock() {
                Ok(g) => g,
                Err(e) => e.into_inner(),
            };
            g.phase = McpTunnelPhase::Error;
            g.running = false;
            g.last_error =
                Some("Tunnel ID should look like tunnel_ plus 32 hex characters.".to_string());
            let status = status_from(&g);
            drop(g);
            self.emit_status();
            return status;
        }

        let Some(binary) = resolve_command(TUNNEL_CLIENT_BIN) else {
            if let Ok(mut g) = self.inner.lock() {
                g.phase = McpTunnelPhase::BinaryMissing;
                g.running = false;
                g.pid = None;
                g.mcp_url = Some(mcp_url);
                g.last_error = None;
            }
            self.emit_status();
            return self.status();
        };

        let dir = mcp_tunnel_dir();
        if let Err(e) = std::fs::create_dir_all(&dir) {
            return self.fail(format!("create {}: {e}", dir.display()));
        }
        let profile_dir = dir.join("profiles");
        if let Err(e) = std::fs::create_dir_all(&profile_dir) {
            return self.fail(format!("create {}: {e}", profile_dir.display()));
        }
        let health_url_file = dir.join("health.url");
        let log_file = dir.join("tunnel-client.log");
        // Stale files would let a probe adopt a *different* daemon's health
        // server, so clear them before spawning.
        let _ = std::fs::remove_file(&health_url_file);
        let _ = std::fs::remove_file(&log_file);

        let proxy = effective_proxy_url();
        let args = run_args(
            &tunnel_id,
            &mcp_url,
            &profile_dir,
            &health_url_file,
            &log_file,
            proxy.as_deref(),
        );

        let mut cmd = Command::new(&binary);
        cmd.args(&args)
            .stdin(Stdio::null())
            // Logs go to --log.file: an unread pipe would stall the daemon at
            // its 64 KB buffer limit.
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .env("CONTROL_PLANE_API_KEY", &api_key)
            .env("NO_PROXY", "127.0.0.1,localhost")
            .env_remove("HTTP_PROXY")
            .env_remove("HTTPS_PROXY")
            .kill_on_drop(true);
        if let Some(url) = proxy.as_deref() {
            cmd.env("AGENTERO_TUNNEL_PROXY", url);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let child = match cmd.spawn() {
            Ok(child) => child,
            Err(e) => {
                log::warn!(
                    target: "agentero::mcp::tunnel",
                    "failed to spawn {}: {e}",
                    binary.display()
                );
                return self.fail(format!("failed to start tunnel-client: {e}"));
            }
        };
        let pid = child.id();
        log::info!(
            target: "agentero::mcp::tunnel",
            "tunnel start pid={pid:?} mcp_url={mcp_url} tunnel_id={tunnel_id}"
        );

        let generation = {
            let mut g = match self.inner.lock() {
                Ok(g) => g,
                Err(e) => e.into_inner(),
            };
            g.generation += 1;
            g.phase = McpTunnelPhase::Starting;
            g.running = true;
            g.pid = pid;
            g.mcp_url = Some(mcp_url.clone());
            g.last_error = None;
            g.child = Some(Arc::new(tokio::sync::Mutex::new(child)));
            g.generation
        };
        self.emit_status();

        let ctrl = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            ctrl.watch_exit(generation, log_file).await;
        });
        let ctrl = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            ctrl.poll_readiness(generation, binary, health_url_file)
                .await;
        });

        self.status()
    }

    /// Stop the child. Sync by design: it also runs from the `RunEvent::Exit`
    /// arm, where there is no runtime left to await on.
    pub fn stop(&self) {
        let child = match self.inner.lock() {
            Ok(mut g) => {
                g.generation += 1;
                let child = g.child.take();
                g.running = false;
                g.pid = None;
                if g.phase != McpTunnelPhase::BinaryMissing {
                    g.phase = McpTunnelPhase::Stopped;
                }
                g.last_error = None;
                child
            }
            Err(_) => return,
        };
        let Some(child) = child else {
            self.emit_status();
            return;
        };
        // `start_kill` (not `kill`) so no runtime is needed; the exit is reaped
        // by `watch_exit`, and `kill_on_drop` is the backstop.
        if let Ok(mut guard) = child.try_lock() {
            let _ = guard.start_kill();
        }
        self.emit_status();
    }

    /// If the MCP listener port changed while the tunnel is running, stop it.
    /// The user can press Start again; auto-restarting here would need the
    /// runtime API key at a point where we only have the redacted settings.
    pub async fn mcp_url_changed(self: &Arc<Self>, mcp_url: String) -> McpTunnelStatus {
        if !self.is_running() {
            return self.status();
        }
        if self.bound_mcp_url().as_deref() == Some(mcp_url.as_str()) {
            return self.status();
        }
        self.stop();
        self.status()
    }

    fn fail(&self, message: String) -> McpTunnelStatus {
        if let Ok(mut g) = self.inner.lock() {
            g.phase = McpTunnelPhase::Error;
            g.running = false;
            g.pid = None;
            g.child = None;
            g.last_error = Some(message);
        }
        self.emit_status();
        self.status()
    }

    async fn watch_exit(self: Arc<Self>, generation: u64, log_file: PathBuf) {
        let child = self.inner.lock().ok().and_then(|g| {
            (g.generation == generation)
                .then(|| g.child.clone())
                .flatten()
        });
        let Some(child) = child else { return };
        let status = {
            let mut guard = child.lock().await;
            guard.wait().await
        };
        let stale = self
            .inner
            .lock()
            .map(|g| g.generation != generation)
            .unwrap_or(true);
        if stale {
            return;
        }
        let code = status.map(|s| s.code().unwrap_or(-1)).ok();
        log::info!(target: "agentero::mcp::tunnel", "tunnel exited code={code:?}");
        let unexpected = code.is_none();
        if let Ok(mut g) = self.inner.lock() {
            g.running = false;
            g.pid = None;
            g.child = None;
            if unexpected {
                g.phase = McpTunnelPhase::Error;
                let tail = log_tail(&log_file, LOG_TAIL_CHARS);
                g.last_error = Some(if tail.is_empty() {
                    "tunnel-client stopped".to_string()
                } else {
                    tail
                });
            } else {
                g.phase = McpTunnelPhase::Stopped;
            }
        }
        self.emit_status();
    }

    async fn poll_readiness(self: Arc<Self>, generation: u64, binary: PathBuf, url_file: PathBuf) {
        let mut elapsed = Duration::ZERO;
        let mut interval = READY_POLL_EVERY;
        loop {
            tokio::time::sleep(interval).await;
            let alive = self
                .inner
                .lock()
                .map(|g| g.generation == generation && g.running)
                .unwrap_or(false);
            if !alive {
                return;
            }
            elapsed += interval;
            let pid = self
                .inner
                .lock()
                .map(|g| g.pid)
                .unwrap_or(None)
                .unwrap_or(std::process::id());
            let (ready, reason) = probe_ready(&binary, &url_file, pid).await;
            let changed = {
                let mut g = match self.inner.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                if g.generation != generation || !g.running {
                    return;
                }
                let next_phase = match (ready, elapsed >= READY_BUDGET) {
                    (true, _) => McpTunnelPhase::Ready,
                    (false, false) => McpTunnelPhase::Starting,
                    (false, true) => McpTunnelPhase::Error,
                };
                let next_error = if ready {
                    None
                } else {
                    reason.clone().or_else(|| {
                        (elapsed >= READY_BUDGET).then(|| {
                            "Tunnel is running but never reached the control plane.".to_string()
                        })
                    })
                };
                let changed = g.phase != next_phase || g.last_error != next_error;
                g.phase = next_phase;
                g.last_error = next_error;
                changed
            };
            if changed {
                self.emit_status();
            }
            if ready {
                interval = KEEPALIVE_POLL_EVERY;
            } else if elapsed >= READY_BUDGET + KEEPALIVE_POLL_EVERY {
                // Keep probing (a key may start working) but stop emitting spam.
                interval = KEEPALIVE_POLL_EVERY;
            }
        }
    }
}

/// Run `tunnel-client health --json` and read the connectivity verdict.
async fn probe_ready(binary: &Path, url_file: &Path, pid: u32) -> (bool, Option<String>) {
    if !url_file.is_file() {
        return (false, None);
    }
    let cmd = Command::new(binary)
        .args(health_args(url_file, pid))
        .stdin(Stdio::null())
        .output();
    let out = match tokio::time::timeout(PROBE_TIMEOUT, cmd).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return (false, Some(format!("health probe failed: {e}"))),
        Err(_) => return (false, Some("health probe timed out".to_string())),
    };
    let Ok(json) = String::from_utf8(out.stdout) else {
        return (false, None);
    };
    let Ok(value) = serde_json::from_str::<Value>(&json) else {
        return (false, None);
    };
    // `/readyz` reports 200 even with a bogus API key, and `result` can be
    // "fail" simply because readyz is not ready yet. The only honest signal
    // is whether the control-plane poll succeeded.
    let ok = value
        .get("control_plane_poll")
        .and_then(|p| p.get("ok"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let reason = poll_error(&value).or_else(|| {
        let tail = String::from_utf8_lossy(&out.stderr).trim().to_string();
        (!tail.is_empty()).then(|| tail.chars().take(LOG_TAIL_CHARS).collect::<String>())
    });
    (ok, reason)
}

fn poll_error(value: &Value) -> Option<String> {
    value
        .get("control_plane_poll")
        .and_then(|p| p.get("error"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn tunnel_id_shape() {
        assert!(tunnel_id_shape_ok(
            "tunnel_0123456789abcdef0123456789abcdef"
        ));
        assert!(!tunnel_id_shape_ok(
            "tunnel_0123456789abcdef0123456789abcde"
        ));
        assert!(!tunnel_id_shape_ok(
            "Tunnel_0123456789abcdef0123456789abcdef"
        ));
        assert!(!tunnel_id_shape_ok(
            "--tunnel_0123456789abcdef0123456789abcdef"
        ));
        assert!(!tunnel_id_shape_ok(""));
    }

    #[test]
    fn run_args_never_include_api_key() {
        let args = run_args(
            "tunnel_0123456789abcdef0123456789abcdef",
            "http://127.0.0.1:8765/mcp",
            &PathBuf::from("/tmp/profiles"),
            &PathBuf::from("/tmp/health.url"),
            &PathBuf::from("/tmp/t.log"),
            Some("http://127.0.0.1:7890"),
        );
        let joined = args.join(" ");
        assert!(joined.contains("--control-plane.tunnel-id"));
        assert!(joined.contains("env:CONTROL_PLANE_API_KEY"));
        assert!(!joined.contains("sk-secret"));
        assert!(joined.contains("--control-plane.http-proxy env:AGENTERO_TUNNEL_PROXY"));
        assert!(!joined.contains("--http-proxy"));
        assert!(joined.contains("127.0.0.1:0"));
    }
}
