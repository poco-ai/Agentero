//! Silent install / update / uninstall for catalog Agent CLIs.
//!
//! Ported from CC Switch's tool-lifecycle patterns (official installer first,
//! npm fallback; login-shell PATH for GUI apps; no `curl | bash` pipes).
//! Scoped to Motif catalog templates.

use crate::features::agent::registry::antigravity;
#[cfg(target_os = "windows")]
use crate::features::agent::registry::discovery::path_entries;
use crate::features::agent::registry::discovery::resolve_command;
use crate::features::agent::registry::templates::{
    antigravity_install_dir, antigravity_server_name, kimi_launcher_dir, template_info,
    CLAUDE_ACP_INSTALL_COMMAND, CODEX_ACP_INSTALL_COMMAND, DSH_INSTALL_COMMAND,
    MINIMAX_CODE_INSTALL_COMMAND, PI_ACP_INSTALL_COMMAND, PI_HOST_INSTALL_COMMAND,
    ZCODE_ACP_INSTALL_COMMAND,
};
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::io::{self, Read};
use std::process::{Command, Output, Stdio};
use std::sync::{Mutex, MutexGuard, OnceLock, TryLockError};
use std::time::{SystemTime, UNIX_EPOCH};
use std::{
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "windows")]
use std::fs::OpenOptions;
#[cfg(target_os = "windows")]
use std::io::Write;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(target_os = "windows")]
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

static TOOL_LIFECYCLE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// Cancel requests for in-flight tool lifecycle runs, keyed by the
/// frontend-generated per-run task id. The id is unique per run and the entry
/// is cleared when the command exits, so a stale request can never kill a
/// later run.
static LIFECYCLE_CANCEL_REQUESTED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn lifecycle_cancel_set() -> &'static Mutex<HashSet<String>> {
    LIFECYCLE_CANCEL_REQUESTED.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Request cooperative cancellation of an in-flight tool lifecycle run (the
/// Settings / onboarding cancel button kills the installer child process).
pub fn request_lifecycle_cancel(task_id: &str) {
    if let Ok(mut ids) = lifecycle_cancel_set().lock() {
        ids.insert(task_id.to_string());
    }
}

/// Drop the cancel request when a lifecycle command exits.
pub fn clear_lifecycle_cancel(task_id: &str) {
    if let Ok(mut ids) = lifecycle_cancel_set().lock() {
        ids.remove(task_id);
    }
}

fn lifecycle_cancel_requested(task_id: &str) -> bool {
    lifecycle_cancel_set()
        .lock()
        .is_ok_and(|ids| ids.contains(task_id))
}

#[cfg(target_os = "windows")]
static WINDOWS_BATCH_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Catalog template ids that support silent install/update.
pub const LIFECYCLE_TEMPLATES: &[&str] = &[
    "opencode",
    "openclaw",
    "claude-acp",
    "codex-acp",
    "hermes",
    "grok-build",
    "pi",
    "dsh",
    "kimi-code",
    "zcode",
    "minimax-code",
    #[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
    "antigravity-acp",
];

/// Launcher directory of the retired dsh ACP-demo scheme (managed `npm i` of
/// the pinned `@deepseek-ai/dsh-acp-demo` stack). Kept only so uninstall can
/// clean up installations made before the move to the umbrella CLI's built-in
/// `dsh --profile acp`.
fn legacy_dsh_launcher_dir() -> std::path::PathBuf {
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("USERPROFILE")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from("C:\\"));
        base.join(".agentero").join("dsh-acp")
    }
    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_default();
        home.join(".agentero").join("dsh-acp")
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolLifecycleProgress {
    task_id: String,
    phase: String,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    progress: Option<u8>,
}

/// Official shell installers download to a temp file then exec (never `curl | bash`),
/// so curl failures propagate under WSL/subshells without relying on pipefail.
/// Windows builds use npm / PowerShell installers instead — keep these out of that target.
#[cfg(not(target_os = "windows"))]
const CLAUDE_INSTALL_UNIX: &str = "bash -c 'tmp=$(mktemp) && curl -fsSL https://claude.ai/install.sh -o $tmp && bash $tmp; status=$?; rm -f $tmp; exit $status'";
#[cfg(not(target_os = "windows"))]
const OPENCODE_INSTALL_UNIX: &str = "bash -c 'tmp=$(mktemp) && curl -fsSL https://opencode.ai/v2/install -o $tmp && bash $tmp; status=$?; rm -f $tmp; exit $status'";
const OPENCODE_NPM_INSTALL_COMMAND: &str = "npm i -g @opencode/cli@latest";
#[cfg(not(target_os = "windows"))]
const GROK_INSTALL_UNIX: &str = "bash -c 'tmp=$(mktemp) && curl -fsSL https://x.ai/cli/install.sh -o $tmp && bash $tmp; status=$?; rm -f $tmp; exit $status'";
#[cfg(not(target_os = "windows"))]
const HERMES_INSTALL_UNIX: &str = "bash -c 'tmp=$(mktemp) && curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh -o $tmp && bash $tmp; status=$?; rm -f $tmp; exit $status'";
#[cfg(not(target_os = "windows"))]
const HERMES_UPDATE_UNIX: &str = "hermes update || bash -c 'tmp=$(mktemp) && curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh -o $tmp && bash $tmp; status=$?; rm -f $tmp; exit $status'";

/// Kimi Code official installer (single binary, no Node needed). Same
/// download-then-exec shape as the other official installers — never pipe
/// curl into bash. Defaults to `~/.kimi-code` and writes it into the shell rc.
#[cfg(not(target_os = "windows"))]
const KIMI_INSTALL_UNIX: &str = "bash -c 'tmp=$(mktemp) && curl -fsSL https://code.kimi.com/kimi-code/install.sh -o $tmp && bash $tmp; status=$?; rm -f $tmp; exit $status'";

/// npm fallback for Kimi Code (npm installs the same `kimi` binary).
pub const KIMI_NPM_INSTALL_COMMAND: &str = "npm i -g @moonshot-ai/kimi-code@latest";

#[cfg(target_os = "windows")]
const GROK_INSTALL_WINDOWS_SCRIPT: &str = "irm https://x.ai/cli/install.ps1 | iex";
#[cfg(target_os = "windows")]
const HERMES_INSTALL_WINDOWS_SCRIPT: &str =
    "irm https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1 | iex";
#[cfg(target_os = "windows")]
const KIMI_INSTALL_WINDOWS_SCRIPT: &str = "irm https://code.kimi.com/kimi-code/install.ps1 | iex";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolLifecycleAction {
    Install,
    Update,
    Uninstall,
}

impl ToolLifecycleAction {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "install" => Ok(Self::Install),
            "update" => Ok(Self::Update),
            "uninstall" => Ok(Self::Uninstall),
            _ => Err(format!("unsupported tool action: {value}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UninstallScope {
    Agent,
    Acp,
    All,
}

impl UninstallScope {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "agent" => Ok(Self::Agent),
            "acp" => Ok(Self::Acp),
            "all" => Ok(Self::All),
            _ => Err(format!("unsupported uninstall scope: {value}")),
        }
    }
}

pub fn supports_lifecycle(template_id: &str) -> bool {
    if template_id == "antigravity-acp" && cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        return false;
    }
    LIFECYCLE_TEMPLATES.contains(&template_id)
}

/// Per-scope uninstall payload (host CLI vs ACP adapter).
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UninstallScopeInfo {
    pub npm_commands: Vec<String>,
    pub dirs: Vec<String>,
}

/// What a silent uninstall would remove for a catalog template.
///
/// `agent` covers the host CLI / main binary; `acp` covers the ACP adapter.
/// `None` means the template has no managed uninstall (e.g. hermes installs
/// via an official script we cannot reverse).
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UninstallInfo {
    pub agent: UninstallScopeInfo,
    pub acp: UninstallScopeInfo,
}

impl UninstallInfo {
    pub fn is_empty(&self) -> bool {
        self.agent.npm_commands.is_empty()
            && self.agent.dirs.is_empty()
            && self.acp.npm_commands.is_empty()
            && self.acp.dirs.is_empty()
    }

    pub fn for_scope(&self, scope: UninstallScope) -> UninstallScopeInfo {
        match scope {
            UninstallScope::Agent => self.agent.clone(),
            UninstallScope::Acp => self.acp.clone(),
            UninstallScope::All => UninstallScopeInfo {
                npm_commands: self
                    .agent
                    .npm_commands
                    .iter()
                    .chain(self.acp.npm_commands.iter())
                    .cloned()
                    .collect(),
                dirs: self
                    .agent
                    .dirs
                    .iter()
                    .chain(self.acp.dirs.iter())
                    .cloned()
                    .collect(),
            },
        }
    }
}

pub fn uninstall_info(template_id: &str) -> Option<UninstallInfo> {
    #[cfg(target_os = "windows")]
    let claude_acp = "npm uninstall -g @agentclientprotocol/claude-agent-acp".to_string();
    #[cfg(not(target_os = "windows"))]
    let claude_acp =
        "npm uninstall -g @agentclientprotocol/claude-agent-acp --prefix \"$HOME/.local\""
            .to_string();
    #[cfg(target_os = "windows")]
    let pi_acp = "npm uninstall -g pi-acp".to_string();
    #[cfg(not(target_os = "windows"))]
    let pi_acp = "npm uninstall -g pi-acp --prefix \"$HOME/.local\"".to_string();
    #[cfg(target_os = "windows")]
    let zcode_acp = "npm uninstall -g zcode-acp-server".to_string();
    #[cfg(not(target_os = "windows"))]
    let zcode_acp = "npm uninstall -g zcode-acp-server --prefix \"$HOME/.local\"".to_string();
    // Mirrors CODEX_ACP_INSTALL_COMMAND: uninstall must target the same prefix
    // the install used, or a user-prefix adapter leaves an orphan on Unix.
    let codex_acp = if cfg!(windows) {
        "npm uninstall -g @agentclientprotocol/codex-acp".to_string()
    } else {
        "npm uninstall -g @agentclientprotocol/codex-acp --prefix \"$HOME/.local\"".to_string()
    };
    #[cfg(target_os = "windows")]
    let dsh_host = "npm uninstall -g @deepseek-ai/dsh".to_string();
    #[cfg(not(target_os = "windows"))]
    let dsh_host = "npm uninstall -g @deepseek-ai/dsh --prefix \"$HOME/.local\"".to_string();

    let (agent_commands, acp_commands): (Vec<String>, Vec<String>) = match template_id {
        // Single-package agents: host CLI and ACP are the same binary.
        "opencode" => (
            vec![
                "npm uninstall -g @opencode/cli".to_string(),
                "npm uninstall -g opencode-ai".to_string(),
            ],
            Vec::new(),
        ),
        "openclaw" => (vec!["npm uninstall -g openclaw".to_string()], Vec::new()),
        "claude-acp" => (
            vec!["npm uninstall -g @anthropic-ai/claude-code".to_string()],
            vec![claude_acp],
        ),
        "codex-acp" => (
            vec!["npm uninstall -g @openai/codex".to_string()],
            vec![codex_acp],
        ),
        "pi" => (
            vec!["npm uninstall -g @earendil-works/pi-coding-agent".to_string()],
            vec![pi_acp],
        ),
        "grok-build" => (
            vec!["npm uninstall -g @xai-official/grok".to_string()],
            Vec::new(),
        ),
        // The ACP profile lives inside the umbrella CLI; the dir entry below
        // only cleans up the retired dsh-acp-demo launcher.
        "dsh" => (vec![dsh_host], Vec::new()),
        "kimi-code" => (
            vec!["npm uninstall -g @moonshot-ai/kimi-code".to_string()],
            Vec::new(),
        ),
        "minimax-code" => (
            vec!["npm uninstall -g @minimax-ai/code".to_string()],
            Vec::new(),
        ),
        // Single-package adapter: the ACP bridge is the only npm artifact
        // (the zcode CLI itself ships inside the ZCode desktop app).
        "zcode" => (vec![zcode_acp], Vec::new()),
        "antigravity-acp" => (Vec::new(), Vec::new()),
        // hermes: official-script-only install, nothing we can reverse.
        _ => return None,
    };
    let (agent_dirs, acp_dirs): (Vec<String>, Vec<String>) = match template_id {
        "dsh" => (
            Vec::new(),
            vec![legacy_dsh_launcher_dir().display().to_string()],
        ),
        "kimi-code" => (vec![kimi_launcher_dir().display().to_string()], Vec::new()),
        "antigravity-acp" => (
            Vec::new(),
            vec![antigravity_install_dir().display().to_string()],
        ),
        _ => (Vec::new(), Vec::new()),
    };
    Some(UninstallInfo {
        agent: UninstallScopeInfo {
            npm_commands: agent_commands,
            dirs: agent_dirs,
        },
        acp: UninstallScopeInfo {
            npm_commands: acp_commands,
            dirs: acp_dirs,
        },
    })
}

/// Chain best-effort uninstall commands: each failure is non-fatal (idempotent
/// uninstall, packages may be absent or root-owned). Unix `|| true`; Windows
/// `|| echo skip` (cmd has no `true`, and `exit /b 0` would abort the bat).
fn best_effort_chain(cmds: &[String]) -> String {
    #[cfg(target_os = "windows")]
    {
        cmds.iter()
            .map(|c| format!("{c} || echo skip"))
            .collect::<Vec<_>>()
            .join("\r\n")
    }
    #[cfg(not(target_os = "windows"))]
    {
        cmds.iter()
            .map(|c| format!("{c} || true"))
            .collect::<Vec<_>>()
            .join("; ")
    }
}

fn remove_managed_dir(dir: &std::path::Path) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    fs::remove_dir_all(dir).map_err(|e| format!("failed to remove {}: {e}", dir.display()))
}

/// Uninstall path: npm uninstall chains plus managed directory removal.
/// `scope` lets the user remove only the host CLI, only the ACP adapter, or both.
pub fn run_partial_template_uninstall(
    template_id: &str,
    scope: UninstallScope,
    app: Option<&AppHandle>,
    task_id: Option<&str>,
    proxy_enabled: bool,
    proxy_url: &str,
) -> Result<(), String> {
    let Some(info) = uninstall_info(template_id) else {
        return Ok(());
    };
    let payload = info.for_scope(scope);
    if !payload.npm_commands.is_empty() {
        // A fully `|| true` chain would silently succeed when npm is missing.
        if resolve_command("npm").is_none() {
            return Err("npm is not available on PATH; cannot uninstall npm packages".to_string());
        }
        run_tool_lifecycle_silently(
            &best_effort_chain(&payload.npm_commands),
            app,
            task_id,
            "agent-lifecycle-uninstall",
            proxy_enabled,
            proxy_url,
        )?;
    }
    for dir in &payload.dirs {
        remove_managed_dir(std::path::Path::new(dir))?;
    }
    Ok(())
}

fn run_template_uninstall(
    template_id: &str,
    app: Option<&AppHandle>,
    task_id: Option<&str>,
    proxy_enabled: bool,
    proxy_url: &str,
) -> Result<(), String> {
    run_partial_template_uninstall(
        template_id,
        UninstallScope::All,
        app,
        task_id,
        proxy_enabled,
        proxy_url,
    )
}

/// Build and run install/update/uninstall for a catalog template. Host decides
/// host-vs-adapter scope from current PATH state (not from free-form UI strings).
pub fn run_template_lifecycle(
    template_id: &str,
    action: ToolLifecycleAction,
    app: Option<&AppHandle>,
    task_id: Option<&str>,
    proxy_enabled: bool,
    proxy_url: &str,
) -> Result<(), String> {
    check_lifecycle_cancelled(task_id)?;
    if !supports_lifecycle(template_id) {
        return Err(format!(
            "no silent install support for template: {template_id}"
        ));
    }
    let info = template_info(template_id)
        .ok_or_else(|| format!("unknown catalog template: {template_id}"))?;

    if matches!(action, ToolLifecycleAction::Uninstall) {
        return run_template_uninstall(template_id, app, task_id, proxy_enabled, proxy_url);
    }

    if template_id == "antigravity-acp" {
        return install_antigravity(app, task_id, proxy_enabled, proxy_url);
    }

    let detect = info
        .detect_command
        .as_deref()
        .unwrap_or(info.command.as_str());
    let host_present = resolve_command(detect).is_some();
    let acp_path_present = resolve_command(&info.command).is_some();
    // Bundled adapter tier keeps the ACP layer ready without an npm install;
    // it only counts when nothing is PATH-installed (PATH always wins) and it
    // can actually spawn. While active, install/update refresh the host only —
    // the bundled adapter moves with app releases.
    let bundled_tier_active = !acp_path_present && super::bundled::bundled_spawnable(template_id);
    let acp_present = acp_path_present || bundled_tier_active;
    // Same binary for host and ACP (opencode, openclaw, hermes, grok via npx).
    let needs_separate_adapter = info
        .detect_command
        .as_ref()
        .is_some_and(|d| d != &info.command);

    let command = match action {
        ToolLifecycleAction::Install => {
            if needs_separate_adapter {
                if host_present && !acp_present {
                    adapter_install_command(template_id)?
                } else if !host_present && !bundled_tier_active {
                    chain_host_and_adapter(
                        host_install_command(template_id)?,
                        adapter_install_command(template_id)?,
                    )
                } else if !host_present {
                    // Bundled adapter already covers the ACP layer.
                    host_install_command(template_id)?
                } else {
                    // Host + adapter both present — treat install as update.
                    update_command(
                        template_id,
                        host_present,
                        acp_present,
                        needs_separate_adapter,
                        bundled_tier_active,
                    )?
                }
            } else if host_present {
                host_update_command(template_id)?
            } else {
                host_install_command(template_id)?
            }
        }
        ToolLifecycleAction::Update => update_command(
            template_id,
            host_present,
            acp_present,
            needs_separate_adapter,
            bundled_tier_active,
        )?,
        // Diverted to `run_template_uninstall` above.
        ToolLifecycleAction::Uninstall => {
            unreachable!("uninstall handled before command selection")
        }
    };

    if command.trim().is_empty() {
        return Err(format!("empty lifecycle command for {template_id}"));
    }

    log::info!(
        target: "agentero::agent",
        "tool_lifecycle template={template_id} action={:?} cmd_len={}",
        action,
        command.len()
    );
    run_tool_lifecycle_silently(
        &command,
        app,
        task_id,
        "agent-lifecycle-install",
        proxy_enabled,
        proxy_url,
    )
}

/// Download and stage the official Antigravity ACP server without invoking a
/// shell or touching the user's Google login. The release (version + archive)
/// comes from the ACP registry, so the installer always follows the version
/// Google publishes; the archive is extracted into a temporary sibling
/// directory and swapped into place only after both required files are present.
fn install_antigravity(
    app: Option<&AppHandle>,
    task_id: Option<&str>,
    proxy_enabled: bool,
    proxy_url: &str,
) -> Result<(), String> {
    // Registry lookup before the lifecycle lock: another install must not be
    // held up by a manifest request, and an unreachable registry fails with a
    // clear error here instead of installing a guessed version.
    let release = antigravity::resolve_release(proxy_enabled, proxy_url)?;
    let _guard = acquire_lifecycle_lock(app, task_id)?;
    check_lifecycle_cancelled(task_id)?;
    emit_lifecycle_progress(app, task_id, "agent-lifecycle-download", Some(5));
    log::info!(
        target: "agentero::agent",
        "antigravity install version={} archive={}",
        release.version,
        release.archive_url
    );

    let client = antigravity::build_client(
        &format!("Agentero/antigravity-acp/{}", release.version),
        proxy_enabled,
        proxy_url,
        Duration::from_secs(180),
    )?;
    let mut response = client
        .get(&release.archive_url)
        .send()
        .map_err(|e| format!("Antigravity download failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Antigravity download failed with HTTP {}",
            response.status()
        ));
    }

    let total = response.content_length();
    let mut archive = Vec::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|e| format!("Antigravity download read failed: {e}"))?;
        if read == 0 {
            break;
        }
        check_lifecycle_cancelled(task_id)?;
        archive.extend_from_slice(&buffer[..read]);
        let progress = total.map(|size| ((archive.len() as u64 * 70) / size).min(70) as u8);
        emit_lifecycle_progress(app, task_id, "agent-lifecycle-download", progress);
    }
    if archive.is_empty() {
        return Err("Antigravity download was empty".to_string());
    }

    let install_dir = antigravity_install_dir();
    let parent = install_dir
        .parent()
        .ok_or_else(|| "invalid Antigravity install directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("failed to create Agentero install directory: {e}"))?;
    let staging = parent.join(format!(
        ".antigravity-acp-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| format!("failed to create staging name: {e}"))?
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging)
        .map_err(|e| format!("failed to create Antigravity staging directory: {e}"))?;

    let extraction = extract_antigravity_zip(&archive, &staging);
    if let Err(error) = extraction {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    let server_name = antigravity_server_name();
    if let Err(error) = normalize_antigravity_layout(&staging, server_name) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    if let Err(error) = check_lifecycle_cancelled(task_id) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    if !staging.join(server_name).is_file() || !has_localharness_external(&staging) {
        let _ = fs::remove_dir_all(&staging);
        return Err(
            "Antigravity archive is missing the ACP server or localharness_external".to_string(),
        );
    }
    #[cfg(unix)]
    if let Err(error) = make_antigravity_executables(&staging) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    // The release marker travels with the payload: it is written into the
    // staging directory, so it appears only for a successful install and is
    // rolled back with the rest when the swap fails. version_check reads it
    // instead of running the ACP server.
    if let Err(error) = antigravity::write_version_marker(&staging, &release.version) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    emit_lifecycle_progress(app, task_id, "agent-lifecycle-install", Some(90));
    if let Err(error) = replace_antigravity_install(&staging, &install_dir) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    emit_lifecycle_progress(app, task_id, "agent-lifecycle-install", Some(100));
    Ok(())
}

fn replace_antigravity_install(
    staging: &std::path::Path,
    install_dir: &std::path::Path,
) -> Result<(), String> {
    if !install_dir.exists() {
        return fs::rename(staging, install_dir)
            .map_err(|e| format!("failed to install Antigravity ACP server: {e}"));
    }
    let backup = install_dir.with_extension(format!(
        "old-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| format!("failed to create backup name: {e}"))?
            .as_nanos()
    ));
    fs::rename(install_dir, &backup)
        .map_err(|e| format!("failed to prepare Antigravity update: {e}"))?;
    if let Err(error) = fs::rename(staging, install_dir) {
        let _ = fs::rename(&backup, install_dir);
        return Err(format!("failed to install Antigravity ACP server: {error}"));
    }
    let _ = fs::remove_dir_all(backup);
    Ok(())
}

fn extract_antigravity_zip(archive: &[u8], dest: &std::path::Path) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(archive))
        .map_err(|e| format!("invalid Antigravity archive: {e}"))?;
    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|e| format!("invalid Antigravity archive entry: {e}"))?;
        let name = std::path::Path::new(entry.name());
        if name.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir | std::path::Component::RootDir
            )
        }) {
            return Err("Antigravity archive contains an unsafe path".to_string());
        }
        let output = dest.join(name);
        if entry.is_dir() {
            fs::create_dir_all(&output).map_err(|e| format!("failed to extract archive: {e}"))?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("failed to extract archive: {e}"))?;
        }
        let mut file =
            fs::File::create(&output).map_err(|e| format!("failed to extract archive: {e}"))?;
        std::io::copy(&mut entry, &mut file)
            .map_err(|e| format!("failed to extract archive: {e}"))?;
    }
    Ok(())
}

fn normalize_antigravity_layout(root: &std::path::Path, server_name: &str) -> Result<(), String> {
    if root.join(server_name).is_file() {
        return Ok(());
    }
    let Some(server) = walkdir::WalkDir::new(root)
        .into_iter()
        .flatten()
        .find(|entry| entry.file_type().is_file() && entry.file_name() == server_name)
    else {
        return Ok(());
    };
    let Some(parent) = server.path().parent() else {
        return Ok(());
    };
    if parent == root {
        return Ok(());
    }
    for entry in fs::read_dir(parent).map_err(|e| format!("failed to normalize archive: {e}"))? {
        let entry = entry.map_err(|e| format!("failed to normalize archive: {e}"))?;
        let target = root.join(entry.file_name());
        fs::rename(entry.path(), target)
            .map_err(|e| format!("failed to normalize archive: {e}"))?;
    }
    Ok(())
}

fn has_localharness_external(root: &std::path::Path) -> bool {
    walkdir::WalkDir::new(root)
        .into_iter()
        .flatten()
        .any(|entry| {
            entry.file_type().is_file()
                && entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("localharness_external")
        })
}

#[cfg(unix)]
fn make_antigravity_executables(root: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    for entry in walkdir::WalkDir::new(root).into_iter().flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        if name == "agy_acp_server.par" || name.starts_with("localharness_external") {
            let mut permissions = fs::metadata(entry.path())
                .map_err(|e| format!("failed to inspect extracted file: {e}"))?
                .permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(entry.path(), permissions)
                .map_err(|e| format!("failed to mark extracted file executable: {e}"))?;
        }
    }
    Ok(())
}

fn host_update_includes_adapter(template_id: &str) -> bool {
    // Must match any host_update_command branch that already chains the
    // adapter install. Currently only pi does this to keep pi-acp in sync.
    template_id == "pi"
}

fn update_command(
    template_id: &str,
    host_present: bool,
    acp_present: bool,
    needs_separate_adapter: bool,
    bundled_tier_active: bool,
) -> Result<String, String> {
    if needs_separate_adapter {
        let mut parts = Vec::new();
        if host_present {
            parts.push(host_update_command(template_id)?);
        } else {
            parts.push(host_install_command(template_id)?);
        }
        let host_update_has_adapter = host_present && host_update_includes_adapter(template_id);
        // While the bundled tier is the active adapter, update refreshes the
        // host only; a PATH-installed adapter (bundled_tier_active=false)
        // restores the chained refresh below.
        if !bundled_tier_active && !host_update_has_adapter && (!acp_present || host_present) {
            // Always refresh adapter on update when host path exists; install if missing.
            parts.push(adapter_install_command(template_id)?);
        }
        Ok(chain_commands(&parts))
    } else if host_present {
        host_update_command(template_id)
    } else {
        host_install_command(template_id)
    }
}

fn adapter_install_command(template_id: &str) -> Result<String, String> {
    match template_id {
        "claude-acp" => Ok(CLAUDE_ACP_INSTALL_COMMAND.to_string()),
        "codex-acp" => Ok(CODEX_ACP_INSTALL_COMMAND.to_string()),
        "pi" => Ok(PI_ACP_INSTALL_COMMAND.to_string()),
        _ => Err(format!("no ACP adapter install for {template_id}")),
    }
}

fn host_install_command(template_id: &str) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        match template_id {
            "claude-acp" => Ok("npm i -g @anthropic-ai/claude-code@latest".to_string()),
            "codex-acp" => Ok("npm i -g @openai/codex@latest".to_string()),
            "opencode" => Ok(OPENCODE_NPM_INSTALL_COMMAND.to_string()),
            "openclaw" => Ok("npm i -g openclaw@latest".to_string()),
            "hermes" => Ok(hermes_install_windows_command()),
            "pi" => Ok(PI_HOST_INSTALL_COMMAND.to_string()),
            "dsh" => Ok(DSH_INSTALL_COMMAND.to_string()),
            "kimi-code" => Ok(chain_or(
                &kimi_install_windows_command(),
                KIMI_NPM_INSTALL_COMMAND,
            )),
            "minimax-code" => Ok(MINIMAX_CODE_INSTALL_COMMAND.to_string()),
            "grok-build" => Ok(chain_or(
                &grok_install_windows_command(),
                "npm i -g @xai-official/grok@latest",
            )),
            "zcode" => Ok(ZCODE_ACP_INSTALL_COMMAND.to_string()),
            _ => Err(format!("no host install for {template_id}")),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        match template_id {
            "claude-acp" => Ok(chain_or(
                CLAUDE_INSTALL_UNIX,
                "npm i -g @anthropic-ai/claude-code@latest",
            )),
            "codex-acp" => Ok("npm i -g @openai/codex@latest".to_string()),
            "opencode" => Ok(chain_or(
                OPENCODE_INSTALL_UNIX,
                OPENCODE_NPM_INSTALL_COMMAND,
            )),
            "openclaw" => Ok("npm i -g openclaw@latest".to_string()),
            "hermes" => Ok(HERMES_INSTALL_UNIX.to_string()),
            "pi" => Ok(PI_HOST_INSTALL_COMMAND.to_string()),
            "dsh" => Ok(DSH_INSTALL_COMMAND.to_string()),
            "kimi-code" => Ok(chain_or(KIMI_INSTALL_UNIX, KIMI_NPM_INSTALL_COMMAND)),
            "minimax-code" => Ok(MINIMAX_CODE_INSTALL_COMMAND.to_string()),
            "grok-build" => Ok(chain_or(
                GROK_INSTALL_UNIX,
                "npm i -g @xai-official/grok@latest",
            )),
            "zcode" => Ok(ZCODE_ACP_INSTALL_COMMAND.to_string()),
            _ => Err(format!("no host install for {template_id}")),
        }
    }
}

fn host_update_command(template_id: &str) -> Result<String, String> {
    // Prefer official self-update where safe; fall back to reinstall chain.
    // Codex self-update can report success without refreshing platform bins — use npm.
    // OpenCode upgrade on Windows may prompt interactively — use npm only.
    match template_id {
        "claude-acp" => {
            #[cfg(target_os = "windows")]
            {
                Ok(chain_or(
                    "claude update",
                    "npm i -g @anthropic-ai/claude-code@latest",
                ))
            }
            #[cfg(not(target_os = "windows"))]
            {
                Ok(chain_or(
                    "claude update",
                    &chain_or(
                        CLAUDE_INSTALL_UNIX,
                        "npm i -g @anthropic-ai/claude-code@latest",
                    ),
                ))
            }
        }
        "codex-acp" => Ok("npm i -g @openai/codex@latest".to_string()),
        "openclaw" => Ok(chain_or(
            "openclaw update --yes",
            "npm i -g openclaw@latest",
        )),
        "pi" => {
            // pi is a host CLI plus a community ACP adapter. Updating only the
            // host frequently leaves the adapter out of sync after a `pi` release,
            // which then fails during ACP initialize. Chain both together.
            let host = chain_or("pi update --self", PI_HOST_INSTALL_COMMAND);
            Ok(chain_host_and_adapter(
                host,
                PI_ACP_INSTALL_COMMAND.to_string(),
            ))
        }
        // `kimi upgrade` is interactive (prints an update prompt and waits for a
        // selection), so silent update re-runs the idempotent official installer
        // (latest version) with the npm install as fallback.
        "kimi-code" => Ok(host_install_command(template_id)?),
        "minimax-code" => Ok(MINIMAX_CODE_INSTALL_COMMAND.to_string()),
        "hermes" => {
            #[cfg(target_os = "windows")]
            {
                Ok(chain_or("hermes update", &hermes_install_windows_command()))
            }
            #[cfg(not(target_os = "windows"))]
            {
                Ok(HERMES_UPDATE_UNIX.to_string())
            }
        }
        "opencode" => {
            #[cfg(target_os = "windows")]
            {
                Ok(OPENCODE_NPM_INSTALL_COMMAND.to_string())
            }
            #[cfg(not(target_os = "windows"))]
            {
                Ok(chain_or(
                    "opencode upgrade",
                    &chain_or(OPENCODE_INSTALL_UNIX, OPENCODE_NPM_INSTALL_COMMAND),
                ))
            }
        }
        "grok-build" => {
            #[cfg(target_os = "windows")]
            {
                Ok(chain_or(
                    "grok update",
                    &chain_or(
                        &grok_install_windows_command(),
                        "npm i -g @xai-official/grok@latest",
                    ),
                ))
            }
            #[cfg(not(target_os = "windows"))]
            {
                Ok(chain_or(
                    "grok update",
                    &chain_or(GROK_INSTALL_UNIX, "npm i -g @xai-official/grok@latest"),
                ))
            }
        }
        _ => host_install_command(template_id),
    }
}

fn chain_or(primary: &str, fallback: &str) -> String {
    format!("{primary} || {fallback}")
}

fn chain_host_and_adapter(host: String, adapter: String) -> String {
    chain_commands(&[host, adapter])
}

fn chain_commands(parts: &[String]) -> String {
    #[cfg(target_os = "windows")]
    {
        // Sequential in a bat: first fails → exit; use `&&` via separate errorlevel checks
        // built by wrap_windows_script.
        parts.join("\r\n")
    }
    #[cfg(not(target_os = "windows"))]
    {
        parts.join(" && ")
    }
}

#[cfg(target_os = "windows")]
fn powershell_encoded_command(script: &str) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let mut bytes = Vec::with_capacity(script.len() * 2);
    for unit in script.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    STANDARD.encode(bytes)
}

#[cfg(target_os = "windows")]
fn grok_install_windows_command() -> String {
    format!(
        "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand {}",
        powershell_encoded_command(GROK_INSTALL_WINDOWS_SCRIPT)
    )
}

#[cfg(target_os = "windows")]
fn hermes_install_windows_command() -> String {
    format!(
        "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand {}",
        powershell_encoded_command(HERMES_INSTALL_WINDOWS_SCRIPT)
    )
}

#[cfg(target_os = "windows")]
fn kimi_install_windows_command() -> String {
    format!(
        "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand {}",
        powershell_encoded_command(KIMI_INSTALL_WINDOWS_SCRIPT)
    )
}

/// Manual one-click install text for Settings (copyable). Matches backend install chains.
pub fn manual_install_commands_text() -> String {
    #[cfg(target_os = "windows")]
    {
        format!(
            r#"# Claude Code + ACP adapter
npm i -g @anthropic-ai/claude-code@latest
{claude_acp}
# Codex + ACP adapter
npm i -g @openai/codex@latest
{codex_acp}
# OpenCode
npm i -g @opencode/cli@latest
# OpenClaw
npm i -g openclaw@latest
# Pi + ACP adapter
{pi_host}
{pi_acp}
# Hermes Agent
{hermes}
# Grok Build
{grok}
# (or) npm i -g @xai-official/grok@latest
# Kimi Code
{kimi}
# (or) npm i -g @moonshot-ai/kimi-code@latest
# MiniMax Code
{minimax}
# Dsh (DeepSeek Harness, ACP via dsh --profile acp)
{dsh}"#,
            claude_acp = CLAUDE_ACP_INSTALL_COMMAND,
            codex_acp = CODEX_ACP_INSTALL_COMMAND,
            pi_host = PI_HOST_INSTALL_COMMAND,
            pi_acp = PI_ACP_INSTALL_COMMAND,
            hermes = hermes_install_windows_command(),
            grok = grok_install_windows_command(),
            kimi = kimi_install_windows_command(),
            minimax = MINIMAX_CODE_INSTALL_COMMAND,
            dsh = DSH_INSTALL_COMMAND,
        )
    }
    #[cfg(not(target_os = "windows"))]
    {
        format!(
            r#"# Claude Code + ACP adapter
{claude_host} || npm i -g @anthropic-ai/claude-code@latest
{claude_acp}
# Codex + ACP adapter
npm i -g @openai/codex@latest
{codex_acp}
# OpenCode
{opencode} || npm i -g @opencode/cli@latest
# OpenClaw
npm i -g openclaw@latest
# Pi + ACP adapter
{pi_host}
{pi_acp}
# Hermes Agent
{hermes}
# Grok Build
{grok} || npm i -g @xai-official/grok@latest
# Kimi Code
{kimi} || npm i -g @moonshot-ai/kimi-code@latest
# MiniMax Code
{minimax}
# Dsh (DeepSeek Harness, ACP via dsh --profile acp)
{dsh}"#,
            claude_host = CLAUDE_INSTALL_UNIX,
            claude_acp = CLAUDE_ACP_INSTALL_COMMAND,
            codex_acp = CODEX_ACP_INSTALL_COMMAND,
            opencode = OPENCODE_INSTALL_UNIX,
            pi_host = PI_HOST_INSTALL_COMMAND,
            pi_acp = PI_ACP_INSTALL_COMMAND,
            hermes = HERMES_INSTALL_UNIX,
            grok = GROK_INSTALL_UNIX,
            kimi = KIMI_INSTALL_UNIX,
            minimax = MINIMAX_CODE_INSTALL_COMMAND,
            dsh = DSH_INSTALL_COMMAND,
        )
    }
}

fn run_tool_lifecycle_silently(
    command_line: &str,
    app: Option<&AppHandle>,
    task_id: Option<&str>,
    phase: &str,
    proxy_enabled: bool,
    proxy_url: &str,
) -> Result<(), String> {
    let _guard = acquire_lifecycle_lock(app, task_id)?;
    check_lifecycle_cancelled(task_id)?;
    emit_lifecycle_progress(app, task_id, phase, Some(5));

    #[cfg(not(target_os = "windows"))]
    {
        let script = format!("set -e\nset -o pipefail\n{command_line}\n");
        let mut cmd = Command::new("bash");
        cmd.arg("-c").arg(script);
        apply_proxy_env_to_command(&mut cmd, proxy_enabled, proxy_url);
        apply_npm_cache_env(&mut cmd, effective_npm_cache_dir().as_deref());
        if let Some(login_path) = login_shell_path() {
            let inherited = std::env::var("PATH").unwrap_or_default();
            cmd.env("PATH", merge_path_segments(&login_path, &inherited));
        }
        let output = run_command_with_cancellation(cmd, app, task_id, phase)
            .map_err(format_lifecycle_process_error)?;
        check_lifecycle_cancelled(task_id)?;
        finish_lifecycle_output(&output)
    }

    #[cfg(target_os = "windows")]
    {
        let bat_file = write_windows_batch_file(command_line)?;
        let merged_path = std::env::join_paths(path_entries())
            .map_err(|e| format!("failed to build install PATH: {e}"))?;
        let mut cmd = Command::new("cmd");
        cmd.arg("/D")
            .arg("/C")
            .arg(&bat_file)
            .env("PATH", merged_path)
            .creation_flags(CREATE_NO_WINDOW);
        apply_proxy_env_to_command(&mut cmd, proxy_enabled, proxy_url);
        apply_npm_cache_env(&mut cmd, effective_npm_cache_dir().as_deref());
        let output = run_command_with_cancellation(cmd, app, task_id, phase);
        let _ = fs::remove_file(&bat_file);
        check_lifecycle_cancelled(task_id)?;
        finish_lifecycle_output(&output.map_err(format_lifecycle_process_error)?)
    }
}

/// Mirror `store::apply_proxy_to_agent`: inject HTTP_PROXY/HTTPS_PROXY/ALL_PROXY
/// into the lifecycle child when the Agentero proxy is enabled, so curl/npm
/// based installers (Kimi, Claude, Grok, Hermes, OpenCode, …)
/// can reach the network through the user's configured proxy.
fn apply_proxy_env_to_command(cmd: &mut Command, proxy_enabled: bool, proxy_url: &str) {
    for key in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] {
        cmd.env_remove(key);
    }
    if proxy_enabled {
        let proxy_url = proxy_url.trim();
        if !proxy_url.is_empty() {
            for key in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] {
                cmd.env(key, proxy_url);
            }
        }
    }
}

/// Isolate managed installs from an unwritable system npm cache (the classic
/// Windows `npm error EPERM ... cache` failure). npm honors `npm_config_cache`,
/// so the child gets an Agentero-owned cache directory when the effective
/// system cache cannot be written. A healthy cache is left untouched so users
/// keep their warm download cache.
fn apply_npm_cache_env(cmd: &mut Command, default_cache: Option<&std::path::Path>) {
    if npm_cache_override(default_cache).is_none() {
        return;
    }
    let managed = managed_npm_cache_dir();
    if fs::create_dir_all(&managed).is_ok() {
        cmd.env("npm_config_cache", managed);
    }
}

/// None when `default_cache` is usable; Some(managed dir) when managed
/// installs must bypass an unwritable system cache.
fn npm_cache_override(default_cache: Option<&std::path::Path>) -> Option<std::path::PathBuf> {
    if default_cache.is_some_and(npm_cache_writable) {
        return None;
    }
    Some(managed_npm_cache_dir())
}

/// The cache root may still be user-writable while a root-owned `_cacache`
/// entry rejects writes: macOS `sudo` keeps `$HOME`, so one `sudo npm` run
/// creates `_cacache/tmp`, `index-v5`, `content-v2` owned by root inside the
/// user's own `~/.npm`. A root-only probe passes, no override happens, and npm
/// then fails mid-install with the intermittent
/// `EPERM: operation not permitted` users see "sometimes". Check the subtree
/// npm actually writes into, not just the root.
fn npm_cache_writable(dir: &std::path::Path) -> bool {
    if !dir_is_writable(dir) {
        return false;
    }
    let cacache = dir.join("_cacache");
    if !cacache.is_dir() {
        return true;
    }
    dir_is_writable(&cacache)
        && std::fs::read_dir(&cacache).is_ok_and(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.path().is_dir())
                .all(|entry| dir_is_writable(&entry.path()))
        })
}

/// npm's effective cache for this user: an explicit `npm_config_cache` wins,
/// then the platform default (`npm-cache` under %LOCALAPPDATA% on Windows,
/// `~/.npm` elsewhere). `.npmrc` overrides need an npm spawn to resolve; a
/// healthy probe of the default then simply keeps today's behavior.
fn effective_npm_cache_dir() -> Option<std::path::PathBuf> {
    if let Ok(from_env) = std::env::var("npm_config_cache") {
        if !from_env.trim().is_empty() {
            return Some(std::path::PathBuf::from(from_env));
        }
    }
    #[cfg(target_os = "windows")]
    {
        dirs::data_local_dir().map(|d| d.join("npm-cache"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        dirs::home_dir().map(|d| d.join(".npm"))
    }
}

fn managed_npm_cache_dir() -> std::path::PathBuf {
    dirs::data_local_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("Agentero")
        .join("npm-cache")
}

/// True when `dir` exists (or can be created) and accepts a new file.
fn dir_is_writable(dir: &std::path::Path) -> bool {
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".agentero-write-probe");
    let writable = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&probe)
        .is_ok();
    let _ = fs::remove_file(&probe);
    writable
}

fn acquire_lifecycle_lock(
    app: Option<&AppHandle>,
    task_id: Option<&str>,
) -> Result<MutexGuard<'static, ()>, String> {
    let lock = TOOL_LIFECYCLE_LOCK.get_or_init(|| Mutex::new(()));
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    loop {
        check_lifecycle_cancelled(task_id)?;
        match lock.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::WouldBlock) => {
                if last_emit.elapsed() >= Duration::from_millis(750) {
                    emit_lifecycle_progress(app, task_id, "agent-lifecycle-waiting", Some(1));
                    last_emit = Instant::now();
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(TryLockError::Poisoned(_)) => {
                return Err("failed to acquire lifecycle lock".to_string())
            }
        }
    }
}

fn check_lifecycle_cancelled(task_id: Option<&str>) -> Result<(), String> {
    if task_id.is_some_and(lifecycle_cancel_requested) {
        return Err("background task cancelled".to_string());
    }
    Ok(())
}

fn run_command_with_cancellation(
    mut command: Command,
    app: Option<&AppHandle>,
    task_id: Option<&str>,
    phase: &str,
) -> io::Result<Output> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let mut stdout = child
        .stdout
        .take()
        .map(|mut pipe| thread::spawn(move || read_pipe_to_end(&mut pipe)));
    let mut stderr = child
        .stderr
        .take()
        .map(|mut pipe| thread::spawn(move || read_pipe_to_end(&mut pipe)));
    let started_at = Instant::now();
    let mut last_emit = Instant::now() - Duration::from_secs(1);

    loop {
        if task_id.is_some_and(lifecycle_cancel_requested) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = join_pipe_reader(stdout.take());
            let _ = join_pipe_reader(stderr.take());
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "background task cancelled",
            ));
        }
        if let Some(status) = child.try_wait()? {
            return Ok(Output {
                status,
                stdout: join_pipe_reader(stdout.take())?,
                stderr: join_pipe_reader(stderr.take())?,
            });
        }
        if last_emit.elapsed() >= Duration::from_millis(750) {
            let elapsed_secs = started_at.elapsed().as_secs().min(30) as u8;
            emit_lifecycle_progress(app, task_id, phase, Some((5 + elapsed_secs * 2).min(65)));
            last_emit = Instant::now();
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn emit_lifecycle_progress(
    app: Option<&AppHandle>,
    task_id: Option<&str>,
    phase: &str,
    progress: Option<u8>,
) {
    let (Some(app), Some(task_id)) = (app, task_id) else {
        return;
    };
    let _ = app.emit(
        "agent-lifecycle:progress",
        ToolLifecycleProgress {
            task_id: task_id.to_string(),
            phase: phase.to_string(),
            downloaded_bytes: 0,
            total_bytes: None,
            progress,
        },
    );
}

fn read_pipe_to_end<R: Read>(pipe: &mut R) -> io::Result<Vec<u8>> {
    let mut buf = Vec::new();
    pipe.read_to_end(&mut buf)?;
    Ok(buf)
}

fn join_pipe_reader(
    handle: Option<thread::JoinHandle<io::Result<Vec<u8>>>>,
) -> io::Result<Vec<u8>> {
    match handle {
        Some(handle) => handle
            .join()
            .map_err(|_| io::Error::other("failed to join lifecycle output reader"))?,
        None => Ok(Vec::new()),
    }
}

fn format_lifecycle_process_error(error: io::Error) -> String {
    if error.kind() == io::ErrorKind::Interrupted {
        "background task cancelled".to_string()
    } else {
        format!("failed to start install process: {error}")
    }
}

#[cfg(target_os = "windows")]
fn write_windows_batch_file(command_line: &str) -> Result<std::path::PathBuf, String> {
    let temp_dir = std::env::temp_dir();
    let pid = std::process::id();
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("failed to read system time: {e}"))?
        .as_nanos();

    for _ in 0..32 {
        let seq = WINDOWS_BATCH_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = temp_dir.join(format!("agentero_tool_{pid}_{stamp}_{seq}.bat"));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                let bat = build_windows_batch(command_line);
                file.write_all(bat.as_bytes())
                    .map_err(|e| format!("failed to write batch file: {e}"))?;
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("failed to create batch file: {e}")),
        }
    }

    Err("failed to create unique batch file".to_string())
}

#[cfg(target_os = "windows")]
fn build_windows_batch(command_line: &str) -> String {
    let mut bat = String::from("@echo off\r\nchcp 65001 >nul\r\n");
    for line in command_line.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('@') {
            continue;
        }
        if line.starts_with("call ") || line.starts_with("powershell ") || line.starts_with("chcp ")
        {
            bat.push_str(line);
        } else {
            bat.push_str("call ");
            bat.push_str(line);
        }
        bat.push_str("\r\nif errorlevel 1 exit /b %errorlevel%\r\n");
    }
    bat
}

fn finish_lifecycle_output(output: &Output) -> Result<(), String> {
    if output.status.success() {
        return Ok(());
    }
    let stderr = decode_process_output(&output.stderr);
    let stdout = decode_process_output(&output.stdout);
    let raw = match (stderr.trim(), stdout.trim()) {
        ("", "") => "",
        ("", out) => out,
        (err, "") => err,
        (err, out) => return Err(last_lines(&format!("{err}\n{out}"), 8)),
    };
    let detail = last_lines(raw, 8);
    Err(if detail.is_empty() {
        format!("command failed (exit code: {:?})", output.status.code())
    } else {
        detail
    })
}

fn decode_process_output(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }
    #[cfg(target_os = "windows")]
    {
        let (text, _, _) = encoding_rs::GBK.decode(bytes);
        text.into_owned()
    }
    #[cfg(not(target_os = "windows"))]
    String::from_utf8_lossy(bytes).into_owned()
}

fn last_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

/// GUI apps inherit a narrow PATH; install scripts need the login shell PATH
/// so bare `npm` / `brew` resolve like a normal terminal session.
#[cfg(not(target_os = "windows"))]
fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let output = Command::new(&shell)
        .args(["-lic", "printf '%s' \"$PATH\""])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

#[cfg(not(target_os = "windows"))]
fn merge_path_segments(primary: &str, extra: &str) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut parts = Vec::new();
    for segment in primary
        .split(':')
        .chain(extra.split(':'))
        .filter(|s| !s.is_empty())
    {
        if seen.insert(segment.to_string()) {
            parts.push(segment.to_string());
        }
    }
    parts.join(":")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycle_templates_match_catalog() {
        for id in LIFECYCLE_TEMPLATES {
            assert!(template_info(id).is_some(), "missing template {id}");
            assert!(supports_lifecycle(id));
        }
        assert!(!supports_lifecycle("qodercli"));
        assert!(!supports_lifecycle("custom"));
    }

    #[test]
    #[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
    fn antigravity_lifecycle_has_registry_platform_and_managed_uninstall() {
        // The registry manifest, not Agentero, decides version and archive URL
        // (parsed in `registry::antigravity`).
        assert!(antigravity::current_platform_key().is_some());
        let info = uninstall_info("antigravity-acp").expect("antigravity uninstall");
        assert!(info.agent.npm_commands.is_empty());
        assert_eq!(
            info.acp.dirs,
            vec![antigravity_install_dir().display().to_string()]
        );
        assert!(template_info("antigravity-acp")
            .expect("antigravity template")
            .command
            .ends_with(antigravity_server_name()));
    }

    #[test]
    fn antigravity_zip_extraction_rejects_traversal_and_keeps_runtime_files() {
        use std::io::Write;
        let mut bytes = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut bytes));
            let options = zip::write::SimpleFileOptions::default();
            writer.start_file("agy_acp_server.par", options).unwrap();
            writer.write_all(b"server").unwrap();
            writer.start_file("localharness_external", options).unwrap();
            writer.write_all(b"helper").unwrap();
            writer.finish().unwrap();
        }
        let root = tempfile::tempdir().unwrap();
        extract_antigravity_zip(&bytes, root.path()).unwrap();
        assert!(root.path().join("agy_acp_server.par").is_file());
        assert!(has_localharness_external(root.path()));

        let mut unsafe_bytes = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut unsafe_bytes));
            let options = zip::write::SimpleFileOptions::default();
            writer.start_file("../escape", options).unwrap();
            writer.write_all(b"bad").unwrap();
            writer.finish().unwrap();
        }
        assert!(extract_antigravity_zip(&unsafe_bytes, root.path()).is_err());
    }

    #[test]
    fn antigravity_install_swap_replaces_managed_copy() {
        let root = tempfile::tempdir().unwrap();
        let install = root.path().join("antigravity-acp");
        let staging = root.path().join(".staging");
        std::fs::create_dir_all(&install).unwrap();
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(install.join("version"), b"old").unwrap();
        std::fs::write(staging.join("version"), b"new").unwrap();
        antigravity::write_version_marker(&staging, "1.2.0").unwrap();
        replace_antigravity_install(&staging, &install).unwrap();
        assert_eq!(std::fs::read(install.join("version")).unwrap(), b"new");
        // The release marker travels with the swapped payload, so the Settings
        // version check sees it without running the server.
        assert_eq!(
            antigravity::installed_version_in(&install).as_deref(),
            Some("1.2.0")
        );
        assert!(!staging.exists());
    }

    #[test]
    fn host_install_nonempty() {
        for id in LIFECYCLE_TEMPLATES {
            if *id == "antigravity-acp" {
                continue;
            }
            let cmd = host_install_command(id).expect(id);
            assert!(!cmd.is_empty(), "{id}");
            assert!(
                !cmd.contains("curl | bash"),
                "{id} must not pipe curl to bash"
            );
            assert!(!cmd.contains("curl|bash"), "{id}");
        }
    }

    #[test]
    fn antigravity_has_no_shell_install_command() {
        assert!(template_info("antigravity-acp")
            .expect("antigravity template")
            .install_command
            .is_none());
        assert!(host_install_command("antigravity-acp").is_err());
    }

    #[test]
    fn bundled_tier_update_refreshes_host_only() {
        // Bundled tier active (no PATH adapter): update refreshes the host and
        // must not npm-install an adapter over the bundled one.
        let update =
            update_command("claude-acp", true, true, true, true).expect("claude-acp update");
        assert!(
            !update.contains("claude-agent-acp"),
            "bundled tier active: adapter refresh not expected: {update}"
        );
        assert!(
            update.contains("claude update") || update.contains("@anthropic-ai/claude-code"),
            "host update expected: {update}"
        );
        // PATH adapter installed (bundled inactive): the adapter refresh returns.
        let chained = update_command("claude-acp", true, true, true, false).unwrap();
        assert!(
            chained.contains("claude-agent-acp"),
            "PATH tier active: adapter refresh expected: {chained}"
        );
    }

    #[test]
    fn adapter_commands_for_acp_templates() {
        assert!(adapter_install_command("claude-acp")
            .unwrap()
            .contains("claude-agent-acp"));
        assert!(adapter_install_command("codex-acp")
            .unwrap()
            .contains("codex-acp"));
        assert!(adapter_install_command("pi").unwrap().contains("pi-acp"));
    }

    /// Codex was the last adapter installed into the global npm prefix on Unix,
    /// where a root-owned prefix makes `npm i -g` fail with EPERM. Install and
    /// uninstall must both target the user prefix there (Windows keeps the
    /// plain global install, matching claude/pi/zcode/dsh).
    #[test]
    fn codex_acp_commands_match_the_other_adapters() {
        let install = adapter_install_command("codex-acp").unwrap();
        let codex = uninstall_info("codex-acp").unwrap();
        let uninstall = codex.acp.npm_commands[0].as_str();
        let claude = adapter_install_command("claude-acp").unwrap();
        assert_eq!(
            install.contains("--prefix"),
            claude.contains("--prefix"),
            "codex-acp must follow the claude-acp prefix pattern: {install}"
        );
        assert_eq!(
            install.contains("--prefix"),
            uninstall.contains("--prefix"),
            "codex-acp uninstall must mirror the install prefix: {uninstall}"
        );
    }

    #[test]
    fn pi_update_keeps_host_and_adapter_in_sync() {
        let host_update = host_update_command("pi").expect("pi host update");
        assert!(
            host_update.contains("pi update --self")
                || host_update.contains(PI_HOST_INSTALL_COMMAND),
            "pi host update must update the host CLI"
        );
        assert!(
            host_update.contains("pi-acp"),
            "pi host update must also refresh pi-acp"
        );

        let full_update = update_command("pi", true, true, true, false).expect("pi full update");
        assert_eq!(
            full_update.matches("pi-acp").count(),
            1,
            "pi-acp must appear exactly once in the combined update: {full_update}"
        );

        let install_when_missing =
            update_command("pi", false, false, true, false).expect("pi install when missing");
        assert_eq!(
            install_when_missing.matches("pi-acp").count(),
            1,
            "adapter must still be installed when the host is missing: {install_when_missing}"
        );
    }

    #[test]
    fn manual_text_lists_agents() {
        let text = manual_install_commands_text();
        assert!(text.contains("Claude"));
        assert!(text.contains("OpenCode"));
        assert!(text.contains("OpenClaw"));
        assert!(text.contains("Hermes"));
        assert!(text.contains("Grok"));
        assert!(text.contains("Pi"));
        assert!(text.contains("Kimi"));
        assert!(text.contains("Dsh"));
    }

    /// PowerShell `-EncodedCommand` payloads hide the script inside base64, so
    /// decode them back to text for assertions.
    fn decode_encoded_commands(cmd: &str) -> String {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        cmd.split("-EncodedCommand ")
            .skip(1)
            .filter_map(|rest| {
                let bytes = STANDARD.decode(rest.split_whitespace().next()?).ok()?;
                let units: Vec<u16> = bytes
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .copied()
                    .map(u16::from_le_bytes)
                    .collect();
                Some(String::from_utf16_lossy(&units))
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn kimi_install_prefers_official_script_with_npm_fallback() {
        let cmd = host_install_command("kimi-code").expect("kimi install");
        // Windows runs the official script through an EncodedCommand payload.
        let script = if cfg!(target_os = "windows") {
            decode_encoded_commands(&cmd)
        } else {
            cmd.clone()
        };
        assert!(
            script.contains("code.kimi.com/kimi-code"),
            "kimi install must use the official script"
        );
        assert!(
            !script.contains("curl | bash"),
            "must not pipe curl to bash"
        );
        assert!(
            cmd.contains("@moonshot-ai/kimi-code"),
            "kimi install must fall back to npm"
        );
        let update = host_update_command("kimi-code").expect("kimi update");
        assert_eq!(update, cmd, "kimi update re-runs the official installer");
    }

    #[test]
    fn dsh_install_uses_global_npm_package() {
        let cmd = host_install_command("dsh").expect("dsh install");
        assert!(cmd.contains("@deepseek-ai/dsh@latest"), "{cmd}");
        assert!(!cmd.contains("dsh-acp-demo"), "{cmd}");
        assert!(!cmd.contains("curl"));
        // Update re-runs the idempotent npm install (no official self-update).
        let update = host_update_command("dsh").expect("dsh update");
        assert_eq!(update, cmd);
    }

    #[test]
    fn minimax_install_allows_native_sqlite_dependencies() {
        let cmd = host_install_command("minimax-code").expect("MiniMax Code install");
        assert!(cmd.contains("@minimax-ai/code@latest"), "{cmd}");
        assert!(cmd.contains("--ignore-scripts=false"), "{cmd}");
        assert!(cmd.contains("--include=optional"), "{cmd}");
        assert!(
            cmd.contains("--allow-scripts=@minimax-ai/code,better-sqlite3"),
            "{cmd}"
        );
        assert!(cmd.contains("--foreground-scripts"), "{cmd}");

        let update = host_update_command("minimax-code").expect("MiniMax Code update");
        assert_eq!(update, cmd);
    }

    #[test]
    fn last_lines_trims() {
        let t = "a\nb\nc\nd\ne";
        assert_eq!(last_lines(t, 2), "d\ne");
    }

    #[test]
    fn decode_process_output_handles_utf8() {
        assert_eq!(
            decode_process_output("ok: 安装失败".as_bytes()),
            "ok: 安装失败"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn decode_process_output_handles_gbk() {
        let (encoded, _, _) = encoding_rs::GBK.encode("命令失败");
        assert_eq!(decode_process_output(&encoded), "命令失败");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_batch_sets_utf8_and_wraps_cmd_shims() {
        let bat = build_windows_batch("npm i -g foo\r\npowershell -NoProfile test");
        assert!(bat.starts_with("@echo off\r\nchcp 65001 >nul\r\n"));
        assert!(bat.contains("call npm i -g foo\r\nif errorlevel 1 exit /b %errorlevel%"));
        assert!(bat.contains("powershell -NoProfile test\r\nif errorlevel 1 exit /b %errorlevel%"));
    }

    #[test]
    fn parse_accepts_uninstall() {
        assert!(matches!(
            ToolLifecycleAction::parse("uninstall"),
            Ok(ToolLifecycleAction::Uninstall)
        ));
        assert!(ToolLifecycleAction::parse("remove").is_err());
    }

    #[test]
    fn uninstall_info_covers_lifecycle_templates() {
        for id in LIFECYCLE_TEMPLATES {
            if *id == "hermes" {
                assert!(uninstall_info(id).is_none(), "{id}");
                continue;
            }
            let info = uninstall_info(id).expect(id);
            let all = info.for_scope(UninstallScope::All);
            assert!(!all.npm_commands.is_empty() || !all.dirs.is_empty(), "{id}");
            for cmd in &all.npm_commands {
                assert!(!cmd.contains("@latest"), "{id}: {cmd}");
            }
        }
        assert!(uninstall_info("qodercli").is_none());
        assert!(uninstall_info("custom").is_none());
    }

    #[test]
    fn uninstall_commands_mirror_install_packages() {
        let opencode = uninstall_info("opencode").unwrap();
        assert!(opencode
            .agent
            .npm_commands
            .iter()
            .any(|c| c.contains("@opencode/cli")));
        assert!(opencode
            .agent
            .npm_commands
            .iter()
            .any(|c| c.contains("opencode-ai")));
        let codex = uninstall_info("codex-acp").unwrap();
        assert!(codex
            .agent
            .npm_commands
            .iter()
            .any(|c| c.contains("@openai/codex")));
        assert!(codex
            .acp
            .npm_commands
            .iter()
            .any(|c| c.contains("codex-acp")));
        let claude = uninstall_info("claude-acp").unwrap();
        assert!(claude
            .agent
            .npm_commands
            .iter()
            .any(|c| c.contains("@anthropic-ai/claude-code")));
        assert!(uninstall_info("kimi-code")
            .unwrap()
            .agent
            .npm_commands
            .iter()
            .any(|c| c.contains("@moonshot-ai/kimi-code")));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn uninstall_prefix_mirrors_install() {
        let claude = uninstall_info("claude-acp").unwrap();
        assert!(claude
            .acp
            .npm_commands
            .iter()
            .any(|c| c.contains("--prefix \"$HOME/.local\"")));
        let pi = uninstall_info("pi").unwrap();
        assert!(pi
            .acp
            .npm_commands
            .iter()
            .any(|c| c.contains("--prefix \"$HOME/.local\"")));
    }

    #[test]
    fn uninstall_dirs_for_managed_installs() {
        let dsh = uninstall_info("dsh").unwrap();
        assert!(dsh
            .agent
            .npm_commands
            .iter()
            .any(|c| c.contains("@deepseek-ai/dsh")));
        // The acp dir entry only cleans up the retired dsh-acp-demo launcher.
        assert_eq!(
            dsh.acp.dirs,
            vec![legacy_dsh_launcher_dir().display().to_string()]
        );
        let kimi = uninstall_info("kimi-code").unwrap();
        assert_eq!(
            kimi.agent.dirs,
            vec![kimi_launcher_dir().display().to_string()]
        );
    }

    #[test]
    fn uninstall_for_scope_selects_agent_or_acp() {
        let codex = uninstall_info("codex-acp").unwrap();
        let agent = codex.for_scope(UninstallScope::Agent);
        assert!(agent
            .npm_commands
            .iter()
            .any(|c| c.contains("@openai/codex")));
        assert!(!agent.npm_commands.iter().any(|c| c.contains("codex-acp")));
        let acp = codex.for_scope(UninstallScope::Acp);
        assert!(acp.npm_commands.iter().any(|c| c.contains("codex-acp")));
        assert!(acp
            .npm_commands
            .iter()
            .all(|c| !c.contains("@openai/codex")));
        let all = codex.for_scope(UninstallScope::All);
        assert_eq!(all.npm_commands.len(), 2);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn best_effort_chain_windows_echo() {
        let chain = best_effort_chain(&["npm uninstall -g a".to_string()]);
        assert_eq!(chain, "npm uninstall -g a || echo skip");
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn best_effort_chain_unix_true() {
        let chain = best_effort_chain(&[
            "npm uninstall -g a".to_string(),
            "npm uninstall -g b".to_string(),
        ]);
        assert_eq!(
            chain,
            "npm uninstall -g a || true; npm uninstall -g b || true"
        );
    }

    #[test]
    fn proxy_env_is_injected_into_lifecycle_command() {
        let mut cmd = std::process::Command::new("env");
        apply_proxy_env_to_command(&mut cmd, true, "http://127.0.0.1:7890");
        let output = cmd.output().expect("run env");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(stdout.contains("HTTP_PROXY=http://127.0.0.1:7890"));
        assert!(stdout.contains("HTTPS_PROXY=http://127.0.0.1:7890"));
        assert!(stdout.contains("ALL_PROXY=http://127.0.0.1:7890"));
    }

    #[test]
    fn proxy_env_is_cleared_when_disabled() {
        let mut cmd = std::process::Command::new("env");
        // Start with a proxy var in the inherited env.
        cmd.env("HTTP_PROXY", "http://old");
        apply_proxy_env_to_command(&mut cmd, false, "http://127.0.0.1:7890");
        let output = cmd.output().expect("run env");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(!stdout.contains("HTTP_PROXY"));
        assert!(!stdout.contains("HTTPS_PROXY"));
        assert!(!stdout.contains("ALL_PROXY"));
    }

    #[test]
    fn npm_cache_env_keeps_a_writable_default() {
        let writable = std::env::temp_dir().join("agentero-npm-cache-test-ok");
        fs::create_dir_all(&writable).expect("create probe dir");
        let mut cmd = std::process::Command::new("env");
        apply_npm_cache_env(&mut cmd, Some(&writable));
        let output = cmd.output().expect("run env");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            !stdout.contains("npm_config_cache="),
            "a healthy cache must be left alone: {stdout}"
        );
        let _ = fs::remove_dir_all(&writable);
    }

    #[test]
    fn npm_cache_override_bypasses_an_unwritable_default() {
        // A regular file can never host a cache dir, so create_dir_all fails.
        let file = std::env::temp_dir().join("agentero-npm-cache-test-file");
        fs::write(&file, b"x").expect("write probe file");
        assert!(!dir_is_writable(&file));
        let managed = npm_cache_override(Some(&file)).expect("override expected");
        assert!(managed.ends_with("npm-cache"), "{managed:?}");
        // Unknown default (no home/data dir): fail safe to the managed cache.
        assert!(npm_cache_override(None).is_some());
        let _ = fs::remove_file(&file);
    }

    #[test]
    fn npm_cache_env_injects_managed_cache_when_default_unwritable() {
        let file = std::env::temp_dir().join("agentero-npm-cache-test-file-2");
        fs::write(&file, b"x").expect("write probe file");
        let mut cmd = std::process::Command::new("env");
        apply_npm_cache_env(&mut cmd, Some(&file));
        let output = cmd.output().expect("run env");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            stdout.contains("npm_config_cache="),
            "unwritable default must be replaced: {stdout}"
        );
        let _ = fs::remove_file(&file);
    }

    /// A writable cache root with an unwritable `_cacache` child (what one
    /// `sudo npm` run leaves behind on macOS, where sudo keeps `$HOME`): npm
    /// fails mid-install even though the root probe passes, so the override
    /// must look one level deeper. Unix-only: the simulation chmods a dir.
    #[cfg(unix)]
    #[test]
    fn npm_cache_override_catches_root_owned_cacache_entries() {
        use std::os::unix::fs::PermissionsExt;
        let cache = std::env::temp_dir().join("agentero-npm-cache-test-poisoned");
        let _ = fs::remove_dir_all(&cache);
        let cacache = cache.join("_cacache");
        let tmp = cacache.join("tmp");
        fs::create_dir_all(&tmp).expect("create probe cache");
        assert!(
            npm_cache_override(Some(&cache)).is_none(),
            "a healthy cache must not be overridden"
        );
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o000)).expect("chmod tmp to 000");
        let managed = npm_cache_override(Some(&cache)).expect("poisoned cache must be overridden");
        assert!(managed.ends_with("npm-cache"), "{managed:?}");
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755)).expect("restore tmp");
        let _ = fs::remove_dir_all(&cache);
    }
}

/// Anti-drift: bind the owned `AgentLifecycleProgressEvent` mirror (in
/// `app::events_contract`, feeding the `agent-lifecycle:progress` payload type
/// in bindings.ts) to the private `ToolLifecycleProgress` actually emitted
/// here: serde shapes and field types must stay identical.
#[cfg(test)]
mod events_contract_shape_tests {
    use super::ToolLifecycleProgress;
    use crate::app::events_contract::AgentLifecycleProgressEvent as MirrorAgentLifecycleProgress;

    fn samples() -> (ToolLifecycleProgress, MirrorAgentLifecycleProgress) {
        (
            ToolLifecycleProgress {
                task_id: "task-1".to_string(),
                phase: "download".to_string(),
                downloaded_bytes: 1024,
                total_bytes: Some(4096),
                progress: Some(25),
            },
            MirrorAgentLifecycleProgress {
                task_id: "task-1".to_string(),
                phase: "download".to_string(),
                downloaded_bytes: 1024,
                total_bytes: Some(4096),
                progress: Some(25),
            },
        )
    }

    #[test]
    fn agent_lifecycle_progress_mirror_matches_emit_payload_shape() {
        let (real, mirror) = samples();
        assert_eq!(
            serde_json::to_value(&real).unwrap(),
            serde_json::to_value(&mirror).unwrap(),
            "AgentLifecycleProgressEvent mirror drifted from ToolLifecycleProgress"
        );
    }

    #[test]
    fn agent_lifecycle_progress_mirror_field_types_match() {
        fn eq_type<T>(_: &T, _: &T) {}
        let (real, mirror) = samples();
        eq_type(&real.task_id, &mirror.task_id);
        eq_type(&real.phase, &mirror.phase);
        eq_type(&real.downloaded_bytes, &mirror.downloaded_bytes);
        eq_type(&real.total_bytes, &mirror.total_bytes);
        eq_type(&real.progress, &mirror.progress);
    }
}
