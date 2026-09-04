//! Spawn a remote BYOA agent over SSH and expose stdio pipes (ACP transport).
//!
//! MVP: separate `ssh` process (does not share the SFTP mux session). Uses system
//! OpenSSH so `~/.ssh/config`, agent, and ProxyJump work.

use crate::core::error::AppError;
use crate::core::install_dirs;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

const SSH_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const SSH_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const SSH_SERVER_ALIVE_INTERVAL_SECS: u64 = 30;
const SSH_SERVER_ALIVE_COUNT_MAX: u8 = 3;

/// Prepend common tool install roots for non-interactive SSH.
///
/// BatchMode `bash -lc` often skips interactive-only brew/nvm snippets in
/// `.bashrc`, so Linuxbrew (`/home/linuxbrew/.linuxbrew/bin`) and nvm bins are
/// missing from PATH even when the binary exists — matching interactive
/// `command -v` fails. Candidate dirs come from `core::install_dirs` (shared
/// with the local GUI PATH patch in `features/agent/discover.rs`).
fn remote_path_bootstrap() -> String {
    let mut dirs: Vec<String> = install_dirs::HOME_BIN_DIRS
        .iter()
        .map(|d| format!("\"$HOME/{d}\""))
        .collect();
    dirs.push(format!("\"$HOME/{}\"", install_dirs::LINUXBREW_HOME_BIN));
    dirs.push(install_dirs::LINUXBREW_ABS_BIN.to_string());
    dirs.extend(install_dirs::ABS_BIN_DIRS.iter().map(|d| d.to_string()));
    dirs.push(format!(
        "\"$HOME\"/{}/*/bin",
        install_dirs::NVM_VERSIONS_DIR
    ));
    format!(
        r#"
# Agentero: non-interactive SSH PATH bootstrap (brew / npm user prefixes / nvm / cargo).
for _d in \
  {dirs}
do
  [ -d "$_d" ] || continue
  case ":$PATH:" in *":$_d:"*) ;; *) PATH="$_d:$PATH" ;; esac
done
if [ -x /home/linuxbrew/.linuxbrew/bin/brew ]; then
  eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv 2>/dev/null)" || true
elif [ -x "$HOME/.linuxbrew/bin/brew" ]; then
  eval "$("$HOME/.linuxbrew/bin/brew" shellenv 2>/dev/null)" || true
fi
export PATH
"#,
        dirs = dirs.join(" \\\n  "),
    )
}

/// Build a remote shell command that `cd`s into the vault and execs the agent.
///
/// Uses `bash -lc` plus [`remote_path_bootstrap`] so non-interactive SSH still
/// sees Linuxbrew / `~/.local/bin` (interactive-only profile snippets are skipped).
///
/// Optional `env_exports` (e.g. `HTTP_PROXY`) are applied on the remote before
/// `cd` / `exec` so Settings → Agent proxy works for remote BYOA the same way
/// as local (proxy must be reachable from the **server**).
pub fn remote_agent_shell_command(
    remote_cwd: &str,
    command: &str,
    args: &[String],
    env_exports: &[(&str, &str)],
) -> String {
    let mut parts = Vec::with_capacity(1 + args.len());
    parts.push(shell_quote(command));
    for a in args {
        parts.push(shell_quote(a));
    }
    let cmd = parts.join(" ");
    let mut prefix = String::new();
    for (k, v) in env_exports {
        if k.is_empty() || v.is_empty() {
            continue;
        }
        // Only allow simple env keys (proxy vars from Host settings).
        if !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            continue;
        }
        prefix.push_str(&format!("export {}={}; ", k, shell_quote(v)));
    }
    let inner = format!(
        "{bootstrap}{prefix}cd {} && exec {}",
        shell_quote(remote_cwd),
        cmd,
        bootstrap = remote_path_bootstrap(),
    );
    format!("bash -lc {}", shell_quote(&inner))
}

/// Env keys mirrored into the remote agent process (proxy + Codex UA / config).
pub const REMOTE_PROXY_ENV_KEYS: &[&str] = &[
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    // Custom User-Agent for Codex/Claude / mid-station affinity (#207).
    "AGENTERO_USER_AGENT",
    "CODEX_CONFIG",
    "MODEL_PROVIDER",
    "ANTHROPIC_CUSTOM_HEADERS",
];

/// Collect proxy / Codex UA env pairs from an agent descriptor (after registry apply).
pub fn proxy_env_from_map(
    env: &std::collections::HashMap<String, String>,
) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for key in REMOTE_PROXY_ENV_KEYS {
        if let Some(v) = env.get(*key) {
            let t = v.trim();
            if !t.is_empty() {
                out.push(((*key).to_string(), t.to_string()));
            }
        }
    }
    out
}

fn shell_quote(s: &str) -> String {
    // Single-quote POSIX style
    if s.is_empty() {
        return "''".into();
    }
    if s.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-' | '=' | ':' | '+'))
    {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}

/// Discover whether a binary exists on the remote host.
///
/// Non-interactive SSH often omits Linuxbrew from PATH (interactive-only
/// `brew shellenv` in `.bashrc`). We bootstrap PATH then `command -v`, and fall
/// back to known install roots including `/home/linuxbrew/.linuxbrew/bin`.
pub async fn remote_which(destination: &str, bin: &str) -> Result<Option<String>, AppError> {
    let bin_q = shell_quote(bin);
    // Explicit candidates from the shared install-dir list (absolute checks).
    let mut cands = String::new();
    for d in install_dirs::HOME_BIN_DIRS {
        cands.push_str(&format!("cands+=(\"$HOME/{d}/{bin_q}\")\n"));
    }
    cands.push_str(&format!(
        "cands+=(\"$HOME/{}/{bin_q}\")\n",
        install_dirs::LINUXBREW_HOME_BIN
    ));
    cands.push_str(&format!(
        "cands+=(\"{}/{bin_q}\")\n",
        install_dirs::LINUXBREW_ABS_BIN
    ));
    for d in install_dirs::ABS_BIN_DIRS {
        cands.push_str(&format!("cands+=(\"{d}/{bin_q}\")\n"));
    }
    // Keep the remote script free of unquoted user input.
    let script = format!(
        r#"
set +e
{bootstrap}
if p=$(command -v {bin_q} 2>/dev/null) && [ -n "$p" ]; then
  printf '%s\n' "$p"
  exit 0
fi
cands=()
{cands}
if np=$(npm prefix -g 2>/dev/null); then
  cands+=("$np/bin/{bin_q}")
fi
if [ -d "$HOME/{nvm}" ]; then
  for d in "$HOME"/{nvm}/*/bin; do
    [ -d "$d" ] && cands+=("$d/{bin_q}")
  done
fi
for p in "${{cands[@]}}"; do
  if [ -x "$p" ] || [ -L "$p" ] || [ -f "$p" ]; then
    printf '%s\n' "$p"
    exit 0
  fi
done
exit 1
"#,
        bootstrap = remote_path_bootstrap(),
        nvm = install_dirs::NVM_VERSIONS_DIR,
    );
    let remote = format!("bash -lc {}", shell_quote(script.trim()));
    let output = timeout(
        SSH_COMMAND_TIMEOUT,
        Command::new("ssh")
            .arg("-T")
            .arg("-o")
            .arg("BatchMode=yes")
            .arg("-o")
            .arg(format!("ConnectTimeout={}", SSH_CONNECT_TIMEOUT.as_secs()))
            .arg("-o")
            .arg(format!(
                "ServerAliveInterval={SSH_SERVER_ALIVE_INTERVAL_SECS}"
            ))
            .arg("-o")
            .arg(format!("ServerAliveCountMax={SSH_SERVER_ALIVE_COUNT_MAX}"))
            .arg(destination)
            .arg(remote)
            .output(),
    )
    .await
    .map_err(|_| {
        AppError::message(format!(
            "ssh which timeout after {}s",
            SSH_COMMAND_TIMEOUT.as_secs()
        ))
    })?
    .map_err(|e| AppError::message(format!("ssh which: {e}")))?;
    if !output.status.success() {
        return Ok(None);
    }
    let path = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.contains('\0'))
        .map(str::to_string);
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_and_builds_exec() {
        let s = remote_agent_shell_command("/data/vault", "opencode", &["acp".into()], &[]);
        assert!(s.contains("bash -lc"));
        assert!(s.contains("cd /data/vault"));
        assert!(s.contains("exec opencode acp"));
        // PATH bootstrap so Linuxbrew / nvm bins are found under BatchMode SSH.
        assert!(s.contains("linuxbrew"));
        assert!(s.contains(".nvm/versions/node"));
    }

    #[test]
    fn quotes_spaces() {
        let s = remote_agent_shell_command("/tmp/my vault", "my agent", &[], &[]);
        assert!(s.contains("bash -lc"));
        assert!(s.contains("/tmp/my vault"));
        assert!(s.contains("my agent"));
    }

    #[test]
    fn exports_proxy_before_cd() {
        let s = remote_agent_shell_command(
            "/data/vault",
            "opencode",
            &["acp".into()],
            &[("HTTP_PROXY", "http://127.0.0.1:7890")],
        );
        assert!(s.contains("export HTTP_PROXY="));
        assert!(s.contains("127.0.0.1:7890"));
        assert!(s.contains("cd /data/vault"));
    }
}
