//! Silent install / update / uninstall for catalog Agent CLIs.
//!
//! Ported from CC Switch's tool-lifecycle patterns (official installer first,
//! npm fallback; login-shell PATH for GUI apps; no `curl | bash` pipes).
//! Scoped to Motif catalog templates.

#[cfg(target_os = "windows")]
use crate::features::agent::registry::discovery::path_entries;
use crate::features::agent::registry::discovery::resolve_command;
use crate::features::agent::registry::templates::{
    dsh_entrypoint_exists, dsh_launcher_dir, kimi_launcher_dir, template_info,
    CLAUDE_ACP_INSTALL_COMMAND, PI_ACP_INSTALL_COMMAND, PI_HOST_INSTALL_COMMAND,
};
use serde::Serialize;
use std::fs;
use std::io::{self, Read};
use std::process::{Command, Output, Stdio};
use std::sync::{Mutex, MutexGuard, OnceLock, TryLockError};
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

#[cfg(target_os = "windows")]
static WINDOWS_BATCH_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Catalog template ids that support silent install/update.
pub const LIFECYCLE_TEMPLATES: &[&str] = &[
    "opencode",
    "openclaw",
    "claude-acp",
    "codex-acp",
    "gemini",
    "hermes",
    "grok-build",
    "pi",
    "dsh",
    "kimi-code",
];

/// dsh ACP demo + plugin stack, published together on npm. Pinning the full set
/// to one verified version keeps cordis.yml plugin loading in sync.
pub const DSH_ACP_PACKAGES: &[&str] = &[
    "@deepseek-ai/dsh-acp-demo@0.1.1-rc.2",
    "@deepseek-ai/dsh-llm-deepseek@0.1.1-rc.2",
    "@deepseek-ai/dsh-sandbox-local@0.1.1-rc.2",
    "@deepseek-ai/dsh-sandbox-policy@0.1.1-rc.2",
    "@deepseek-ai/dsh-subprocess-local@0.1.1-rc.2",
    "@deepseek-ai/dsh-bash-sandbox@0.1.1-rc.2",
    "@deepseek-ai/dsh-user-approval@0.1.1-rc.2",
    "@deepseek-ai/dsh-fs-sandbox@0.1.1-rc.2",
    "@deepseek-ai/dsh-tool-fs@0.1.1-rc.2",
];

/// Default dsh composition written into the launcher dir on first install
/// (never overwrites an existing file). Mirrors the canonical spine of
/// deepseek-harness `examples/acp-agent/cordis.yml`: DeepSeek adapter, sandboxed
/// bash + fs tools, user approval, and the ACP demo app. DEEPSEEK_API_KEY is
/// read from the launcher dir's `.env`; sessions persist under `./.sessions`.
pub const DSH_ACP_CORDIS_YML: &str = r#"- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    thinking: enabled
    reasoningEffort: max
    models:
      - id: deepseek-v4-flash
      - id: deepseek-v4-pro
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: workspace-write
- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'
- id: bash
  name: '@deepseek-ai/dsh-bash-sandbox'
  config:
    timeoutMs: 60000
- id: approval
  name: '@deepseek-ai/dsh-user-approval'
  config:
    policy: ask
- id: fs-sandbox
  name: '@deepseek-ai/dsh-fs-sandbox'
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
- id: acp-agent
  name: '@deepseek-ai/dsh-acp-demo'
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
    persistenceRoot: ./.sessions
    persistenceCompression: zstd
    workspaceContext:
      maxBytes: 65536
    persona: |
      You are a coding assistant powered by the {{model}} model. Your working directory is {{cwd}}. Your bash tool runs under a file sandbox — a `[sandbox: file access denied …]` result is policy, not a command bug.

      Verify your work by running the code or tests. Keep answers brief and factual.
"#;

/// npm install for the dsh stack into its launcher dir (npm i is idempotent,
/// so install and update run the same command with pinned versions).
pub fn dsh_npm_install_command() -> String {
    let packages = DSH_ACP_PACKAGES.join(" ");
    #[cfg(target_os = "windows")]
    {
        format!(
            "cd /d \"%USERPROFILE%\\.agentero\\dsh-acp\"\r\nnpm i --no-audit --no-fund {packages}"
        )
    }
    #[cfg(not(target_os = "windows"))]
    {
        format!("cd \"$HOME/.agentero/dsh-acp\" && npm i --no-audit --no-fund {packages}")
    }
}

/// Minimal project manifest for the launcher dir. Without it, npm walks up to
/// a user's `~/package.json` and installs the dsh stack into `~/node_modules`.
const DSH_ACP_PACKAGE_JSON: &str = r#"{
  "name": "agentero-dsh-acp",
  "private": true,
  "version": "0.1.1-rc.2"
}
"#;

/// Ensure the launcher dir, default cordis.yml and project manifest exist.
/// Idempotent and non-destructive — never overwrites user-modified files.
pub fn prepare_dsh_launcher() -> Result<(), String> {
    let launcher = dsh_launcher_dir();
    std::fs::create_dir_all(&launcher)
        .map_err(|e| format!("failed to create dsh launcher dir: {e}"))?;
    let config = launcher.join("cordis.yml");
    if !config.exists() {
        std::fs::write(&config, DSH_ACP_CORDIS_YML)
            .map_err(|e| format!("failed to write dsh cordis.yml: {e}"))?;
    }
    let manifest = launcher.join("package.json");
    if !manifest.exists() {
        std::fs::write(&manifest, DSH_ACP_PACKAGE_JSON)
            .map_err(|e| format!("failed to write dsh package.json: {e}"))?;
    }
    Ok(())
}

/// dsh lifecycle: prepare launcher dir + defaults, then `npm i` the pinned
/// package stack. Install skips the download when dsh is already reachable
/// (launcher, home npm root or PATH); update always refreshes the launcher copy.
fn run_dsh_lifecycle(
    action: ToolLifecycleAction,
    app: Option<&AppHandle>,
    task_id: Option<&str>,
) -> Result<(), String> {
    prepare_dsh_launcher()?;
    let reachable = dsh_entrypoint_exists() || resolve_command("dsh-acp-demo").is_some();
    log::info!(
        target: "agentero::agent",
        "dsh_lifecycle action={:?} launcher={} reachable={reachable}",
        action,
        dsh_launcher_dir().display()
    );
    if matches!(action, ToolLifecycleAction::Install) && reachable {
        return Ok(());
    }
    run_tool_lifecycle_silently(
        &dsh_npm_install_command(),
        app,
        task_id,
        "agent-lifecycle-install",
    )
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
const OPENCODE_INSTALL_UNIX: &str = "bash -c 'tmp=$(mktemp) && curl -fsSL https://opencode.ai/install -o $tmp && bash $tmp; status=$?; rm -f $tmp; exit $status'";
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

pub fn supports_lifecycle(template_id: &str) -> bool {
    LIFECYCLE_TEMPLATES.contains(&template_id)
}

/// What a silent uninstall would remove for a catalog template.
///
/// `npm_commands` are complete `npm uninstall` invocations (including the
/// `--prefix` mirroring install); `dirs` are Agentero-managed directories.
/// `None` means the template has no managed uninstall (e.g. hermes installs
/// via an official script we cannot reverse).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallInfo {
    pub npm_commands: Vec<String>,
    pub dirs: Vec<String>,
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

    let npm_commands = match template_id {
        "opencode" => vec!["npm uninstall -g opencode-ai".to_string()],
        "openclaw" => vec!["npm uninstall -g openclaw".to_string()],
        "claude-acp" => vec![
            "npm uninstall -g @anthropic-ai/claude-code".to_string(),
            claude_acp,
        ],
        "codex-acp" => vec![
            "npm uninstall -g @openai/codex".to_string(),
            "npm uninstall -g @agentclientprotocol/codex-acp".to_string(),
        ],
        "gemini" => vec!["npm uninstall -g @google/gemini-cli".to_string()],
        "pi" => vec![
            "npm uninstall -g @earendil-works/pi-coding-agent".to_string(),
            pi_acp,
        ],
        "grok-build" => vec!["npm uninstall -g @xai-official/grok".to_string()],
        "dsh" => Vec::new(),
        "kimi-code" => vec!["npm uninstall -g @moonshot-ai/kimi-code".to_string()],
        // hermes: official-script-only install, nothing we can reverse.
        _ => return None,
    };
    let dirs = match template_id {
        "dsh" => vec![dsh_launcher_dir().display().to_string()],
        "kimi-code" => vec![kimi_launcher_dir().display().to_string()],
        _ => Vec::new(),
    };
    Some(UninstallInfo { npm_commands, dirs })
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
/// Must bypass `run_dsh_lifecycle` — its `prepare_dsh_launcher` recreates the
/// launcher dir.
fn run_template_uninstall(
    template_id: &str,
    app: Option<&AppHandle>,
    task_id: Option<&str>,
) -> Result<(), String> {
    let Some(info) = uninstall_info(template_id) else {
        return Ok(());
    };
    if template_id == "dsh" {
        return remove_managed_dir(&dsh_launcher_dir());
    }
    if !info.npm_commands.is_empty() {
        // A fully `|| true` chain would silently succeed when npm is missing.
        if resolve_command("npm").is_none() {
            return Err("npm is not available on PATH; cannot uninstall npm packages".to_string());
        }
        run_tool_lifecycle_silently(
            &best_effort_chain(&info.npm_commands),
            app,
            task_id,
            "agent-lifecycle-uninstall",
        )?;
    }
    for dir in &info.dirs {
        remove_managed_dir(std::path::Path::new(dir))?;
    }
    Ok(())
}

/// Build and run install/update/uninstall for a catalog template. Host decides
/// host-vs-adapter scope from current PATH state (not from free-form UI strings).
pub fn run_template_lifecycle(
    template_id: &str,
    action: ToolLifecycleAction,
    app: Option<&AppHandle>,
    task_id: Option<&str>,
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
        return run_template_uninstall(template_id, app, task_id);
    }

    // dsh is a project-dir npm install (not on PATH): Rust writes cordis.yml
    // and the shell only runs the pinned `npm i` inside the launcher dir.
    if template_id == "dsh" {
        return run_dsh_lifecycle(action, app, task_id);
    }

    let detect = info
        .detect_command
        .as_deref()
        .unwrap_or(info.command.as_str());
    let host_present = resolve_command(detect).is_some();
    let acp_present = resolve_command(&info.command).is_some();
    // Same binary for host and ACP (opencode, openclaw, gemini, hermes, grok via npx).
    let needs_separate_adapter = info
        .detect_command
        .as_ref()
        .is_some_and(|d| d != &info.command);

    let command = match action {
        ToolLifecycleAction::Install => {
            if needs_separate_adapter {
                if host_present && !acp_present {
                    adapter_install_command(template_id)?
                } else if !host_present {
                    chain_host_and_adapter(
                        host_install_command(template_id)?,
                        adapter_install_command(template_id)?,
                    )
                } else {
                    // Host + adapter both present — treat install as update.
                    update_command(
                        template_id,
                        host_present,
                        acp_present,
                        needs_separate_adapter,
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
    run_tool_lifecycle_silently(&command, app, task_id, "agent-lifecycle-install")
}

fn update_command(
    template_id: &str,
    host_present: bool,
    acp_present: bool,
    needs_separate_adapter: bool,
) -> Result<String, String> {
    if needs_separate_adapter {
        let mut parts = Vec::new();
        if host_present {
            parts.push(host_update_command(template_id)?);
        } else {
            parts.push(host_install_command(template_id)?);
        }
        if !acp_present || host_present {
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
        "codex-acp" => Ok("npm i -g @agentclientprotocol/codex-acp@latest".to_string()),
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
            "gemini" => Ok("npm i -g @google/gemini-cli@latest".to_string()),
            "opencode" => Ok("npm i -g opencode-ai@latest".to_string()),
            "openclaw" => Ok("npm i -g openclaw@latest".to_string()),
            "hermes" => Ok(hermes_install_windows_command()),
            "pi" => Ok(PI_HOST_INSTALL_COMMAND.to_string()),
            "dsh" => Ok(dsh_npm_install_command()),
            "kimi-code" => Ok(chain_or(
                &kimi_install_windows_command(),
                KIMI_NPM_INSTALL_COMMAND,
            )),
            "grok-build" => Ok(chain_or(
                &grok_install_windows_command(),
                "npm i -g @xai-official/grok@latest",
            )),
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
            "gemini" => Ok("npm i -g @google/gemini-cli@latest".to_string()),
            "opencode" => Ok(chain_or(
                OPENCODE_INSTALL_UNIX,
                "npm i -g opencode-ai@latest",
            )),
            "openclaw" => Ok("npm i -g openclaw@latest".to_string()),
            "hermes" => Ok(HERMES_INSTALL_UNIX.to_string()),
            "pi" => Ok(PI_HOST_INSTALL_COMMAND.to_string()),
            "dsh" => Ok(dsh_npm_install_command()),
            "kimi-code" => Ok(chain_or(KIMI_INSTALL_UNIX, KIMI_NPM_INSTALL_COMMAND)),
            "grok-build" => Ok(chain_or(
                GROK_INSTALL_UNIX,
                "npm i -g @xai-official/grok@latest",
            )),
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
        "gemini" => Ok("npm i -g @google/gemini-cli@latest".to_string()),
        "openclaw" => Ok(chain_or(
            "openclaw update --yes",
            "npm i -g openclaw@latest",
        )),
        "pi" => Ok(chain_or("pi update --self", PI_HOST_INSTALL_COMMAND)),
        // `kimi upgrade` is interactive (prints an update prompt and waits for a
        // selection), so silent update re-runs the idempotent official installer
        // (latest version) with the npm install as fallback.
        "kimi-code" => Ok(host_install_command(template_id)?),
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
                Ok("npm i -g opencode-ai@latest".to_string())
            }
            #[cfg(not(target_os = "windows"))]
            {
                Ok(chain_or(
                    "opencode upgrade",
                    &chain_or(OPENCODE_INSTALL_UNIX, "npm i -g opencode-ai@latest"),
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
npm i -g @agentclientprotocol/codex-acp@latest
# Gemini CLI
npm i -g @google/gemini-cli@latest
# OpenCode
npm i -g opencode-ai@latest
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
# Dsh (DeepSeek Harness ACP demo — Agentero writes cordis.yml + runs this)
{dsh}"#,
            claude_acp = CLAUDE_ACP_INSTALL_COMMAND,
            pi_host = PI_HOST_INSTALL_COMMAND,
            pi_acp = PI_ACP_INSTALL_COMMAND,
            hermes = hermes_install_windows_command(),
            grok = grok_install_windows_command(),
            kimi = kimi_install_windows_command(),
            dsh = dsh_npm_install_command(),
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
npm i -g @agentclientprotocol/codex-acp@latest
# Gemini CLI
npm i -g @google/gemini-cli@latest
# OpenCode
{opencode} || npm i -g opencode-ai@latest
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
# Dsh (DeepSeek Harness ACP demo — Agentero writes cordis.yml + runs this)
{dsh}"#,
            claude_host = CLAUDE_INSTALL_UNIX,
            claude_acp = CLAUDE_ACP_INSTALL_COMMAND,
            opencode = OPENCODE_INSTALL_UNIX,
            pi_host = PI_HOST_INSTALL_COMMAND,
            pi_acp = PI_ACP_INSTALL_COMMAND,
            hermes = HERMES_INSTALL_UNIX,
            grok = GROK_INSTALL_UNIX,
            kimi = KIMI_INSTALL_UNIX,
            dsh = dsh_npm_install_command(),
        )
    }
}

fn run_tool_lifecycle_silently(
    command_line: &str,
    app: Option<&AppHandle>,
    task_id: Option<&str>,
    phase: &str,
) -> Result<(), String> {
    let _guard = acquire_lifecycle_lock(app, task_id)?;
    check_lifecycle_cancelled(task_id)?;
    emit_lifecycle_progress(app, task_id, phase, Some(5));

    #[cfg(not(target_os = "windows"))]
    {
        let script = format!("set -e\nset -o pipefail\n{command_line}\n");
        let mut cmd = Command::new("bash");
        cmd.arg("-c").arg(script);
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
        let output = run_command_with_cancellation(cmd, app, task_id, phase);
        let _ = fs::remove_file(&bat_file);
        check_lifecycle_cancelled(task_id)?;
        finish_lifecycle_output(&output.map_err(format_lifecycle_process_error)?)
    }
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
    if task_id.is_some_and(crate::core::background_tasks::is_cancelled) {
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
        if task_id.is_some_and(crate::core::background_tasks::is_cancelled) {
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
    fn host_install_nonempty() {
        for id in LIFECYCLE_TEMPLATES {
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
    fn adapter_commands_for_acp_templates() {
        assert!(adapter_install_command("claude-acp")
            .unwrap()
            .contains("claude-agent-acp"));
        assert!(adapter_install_command("codex-acp")
            .unwrap()
            .contains("codex-acp"));
        assert!(adapter_install_command("pi").unwrap().contains("pi-acp"));
        assert!(adapter_install_command("gemini").is_err());
    }

    #[test]
    fn manual_text_lists_agents() {
        let text = manual_install_commands_text();
        assert!(text.contains("Claude"));
        assert!(text.contains("Gemini"));
        assert!(text.contains("OpenCode"));
        assert!(text.contains("OpenClaw"));
        assert!(text.contains("Hermes"));
        assert!(text.contains("Grok"));
        assert!(text.contains("Pi"));
        assert!(text.contains("Kimi"));
        assert!(text.contains("Dsh"));
    }

    #[test]
    fn kimi_install_prefers_official_script_with_npm_fallback() {
        let cmd = host_install_command("kimi-code").expect("kimi install");
        assert!(
            cmd.contains("code.kimi.com/kimi-code"),
            "kimi install must use the official script"
        );
        assert!(!cmd.contains("curl | bash"), "must not pipe curl to bash");
        assert!(
            cmd.contains("@moonshot-ai/kimi-code"),
            "kimi install must fall back to npm"
        );
        let update = host_update_command("kimi-code").expect("kimi update");
        assert_eq!(update, cmd, "kimi update re-runs the official installer");
    }

    #[test]
    fn dsh_lifecycle_command_pins_packages() {
        let cmd = host_install_command("dsh").expect("dsh install");
        for pkg in DSH_ACP_PACKAGES {
            assert!(cmd.contains(pkg), "missing {pkg}");
        }
        assert!(!cmd.contains("curl"));
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
            assert!(
                !info.npm_commands.is_empty() || !info.dirs.is_empty(),
                "{id}"
            );
            for cmd in &info.npm_commands {
                assert!(!cmd.contains("@latest"), "{id}: {cmd}");
            }
        }
        assert!(uninstall_info("qodercli").is_none());
        assert!(uninstall_info("custom").is_none());
    }

    #[test]
    fn uninstall_commands_mirror_install_packages() {
        let opencode = uninstall_info("opencode").unwrap();
        assert!(opencode.npm_commands[0].contains("opencode-ai"));
        let codex = uninstall_info("codex-acp").unwrap();
        assert!(codex
            .npm_commands
            .iter()
            .any(|c| c.contains("@openai/codex")));
        assert!(codex.npm_commands.iter().any(|c| c.contains("codex-acp")));
        let claude = uninstall_info("claude-acp").unwrap();
        assert!(claude
            .npm_commands
            .iter()
            .any(|c| c.contains("@anthropic-ai/claude-code")));
        assert!(uninstall_info("kimi-code")
            .unwrap()
            .npm_commands
            .iter()
            .any(|c| c.contains("@moonshot-ai/kimi-code")));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn uninstall_prefix_mirrors_install() {
        let claude = uninstall_info("claude-acp").unwrap();
        assert!(claude
            .npm_commands
            .iter()
            .any(|c| c.contains("--prefix \"$HOME/.local\"")));
        let pi = uninstall_info("pi").unwrap();
        assert!(pi
            .npm_commands
            .iter()
            .any(|c| c.contains("--prefix \"$HOME/.local\"")));
    }

    #[test]
    fn uninstall_dirs_for_managed_installs() {
        let dsh = uninstall_info("dsh").unwrap();
        assert!(dsh.npm_commands.is_empty());
        assert_eq!(dsh.dirs, vec![dsh_launcher_dir().display().to_string()]);
        let kimi = uninstall_info("kimi-code").unwrap();
        assert_eq!(kimi.dirs, vec![kimi_launcher_dir().display().to_string()]);
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
}
