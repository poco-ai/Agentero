use crate::core::error::AppError;
use crate::features::agent::acp::client::{
    effective_local_agent_env, resolve_command_in_agent_env,
};
use crate::features::agent::models::{AgentDescriptor, AgentTemplate};
use crate::features::agent::registry::lifecycle::{
    emit_lifecycle_progress, lifecycle_cancel_requested,
};
use crate::features::agent::registry::{template_info, AgentRegistry};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::Command;

const HOST_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Package-manager installs (winget / brew) download and unpack, so they need a
/// far longer budget than the `--version` probes.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum NodeInstallOutcome {
    Installed,
    Failed,
    NoPackageManager,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum HostToolStatus {
    Available,
    Missing,
    Unusable,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HostToolDiagnostic {
    pub status: HostToolStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum CodexAuthStatus {
    Authenticated,
    Unauthenticated,
    NotApplicable,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CodexAuthDiagnostic {
    pub status: CodexAuthStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HostDoctorReport {
    pub node: HostToolDiagnostic,
    pub npm: HostToolDiagnostic,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub npm_prefix: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NodeInstallResult {
    pub outcome: NodeInstallOutcome,
    /// Package manager used (winget / brew), when one was available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installer: Option<String>,
    /// Failure detail when the outcome is `failed`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Host probe re-run after the install attempt.
    pub report: HostDoctorReport,
}

struct CommandOutput {
    success: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

fn codex_descriptor(registry: &AgentRegistry) -> Result<AgentDescriptor, AppError> {
    if let Some(descriptor) = registry
        .snapshot()?
        .agents
        .into_iter()
        .find(|agent| agent.template == AgentTemplate::CodexAcp)
    {
        return Ok(descriptor);
    }

    let template = template_info("codex-acp")
        .ok_or_else(|| AppError::message("Codex catalog template is unavailable"))?;
    Ok(AgentDescriptor {
        id: "catalog-codex-acp".to_string(),
        name: template.name,
        template: AgentTemplate::CodexAcp,
        command: template.command,
        args: template.args,
        env: HashMap::new(),
        available: false,
        last_error: None,
        last_probe_ok: None,
        last_probe_agent_name: None,
        last_probe_error: None,
        last_probed_at: None,
    })
}

fn diagnostic_command(path: &Path, args: &[&str]) -> Command {
    let mut command = base_command(path, args);
    crate::core::process::hide_console_window_tokio(&mut command);
    command
}

fn base_command(path: &Path, args: &[&str]) -> Command {
    #[cfg(windows)]
    {
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if matches!(extension.as_str(), "cmd" | "bat") {
            let mut command = Command::new("cmd");
            command.args(["/D", "/C"]).arg(path).args(args);
            return command;
        }
        if extension == "ps1" {
            let mut command = Command::new("powershell");
            command
                .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
                .arg(path)
                .args(args);
            return command;
        }
    }

    let mut command = Command::new(path);
    command.args(args);
    command
}

async fn run_command(
    path: &Path,
    args: &[&str],
    environment: &HashMap<String, String>,
) -> Result<CommandOutput, String> {
    run_command_with_timeout(path, args, environment, HOST_PROBE_TIMEOUT).await
}

async fn run_command_with_timeout(
    path: &Path,
    args: &[&str],
    environment: &HashMap<String, String>,
    timeout: Duration,
) -> Result<CommandOutput, String> {
    let mut command = diagnostic_command(path, args);
    command.env_clear().envs(environment);
    let output = tokio::time::timeout(timeout, crate::core::process::command_output(&mut command))
        .await
        .map_err(|_| format!("timed out after {}s", timeout.as_secs()))?
        .map_err(|error| format!("failed to start: {error}"))?;
    Ok(CommandOutput {
        success: output.status.success(),
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// Result of a cancellable package-manager run.
enum CancellableOutcome {
    Output(CommandOutput),
    /// The caller asked to cancel the background task.
    Cancelled,
}

/// Run a package manager with progress events and cooperative cancellation.
///
/// The child is owned by a spawned task. Aborting that task drops the process
/// tree, which on Windows also kills launcher descendants such as `node.exe`.
async fn run_installer_cancellable(
    path: &Path,
    args: &[String],
    environment: &HashMap<String, String>,
    app: Option<&AppHandle>,
    task_id: Option<&str>,
    phase: &str,
) -> Result<CancellableOutcome, String> {
    let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    let mut command = diagnostic_command(path, &arg_refs);
    command.env_clear().envs(environment);
    let mut joined =
        tokio::spawn(async move { crate::core::process::command_output(&mut command).await });
    let started = Instant::now();
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    loop {
        tokio::select! {
            result = &mut joined => {
                let output = result
                    .map_err(|error| format!("installer task failed: {error}"))?
                    .map_err(|error| format!("failed to start: {error}"))?;
                return Ok(CancellableOutcome::Output(CommandOutput {
                    success: output.status.success(),
                    code: output.status.code(),
                    stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                    stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
                }));
            }
            _ = tokio::time::sleep(Duration::from_millis(150)) => {
                if task_id.is_some_and(lifecycle_cancel_requested) {
                    joined.abort();
                    return Ok(CancellableOutcome::Cancelled);
                }
                if started.elapsed() >= INSTALL_TIMEOUT {
                    joined.abort();
                    return Err(format!("timed out after {}s", INSTALL_TIMEOUT.as_secs()));
                }
                if last_emit.elapsed() >= Duration::from_millis(750) {
                    let elapsed_secs = started.elapsed().as_secs().min(30) as u8;
                    emit_lifecycle_progress(
                        app,
                        task_id,
                        phase,
                        Some((5 + elapsed_secs * 2).min(65)),
                    );
                    last_emit = Instant::now();
                }
            }
        }
    }
}

fn first_output_line(output: &CommandOutput) -> Option<String> {
    output
        .stdout
        .lines()
        .chain(output.stderr.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(160).collect())
}

pub(crate) async fn diagnose_tool(
    command: &str,
    environment: &HashMap<String, String>,
) -> HostToolDiagnostic {
    let Some(path) = resolve_command_in_agent_env(command, environment) else {
        return HostToolDiagnostic {
            status: HostToolStatus::Missing,
            resolved_path: None,
            version: None,
            detail: None,
        };
    };
    let resolved_path = Some(path.display().to_string());
    match run_command(&path, &["--version"], environment).await {
        Ok(output) if output.success => HostToolDiagnostic {
            status: HostToolStatus::Available,
            resolved_path,
            version: first_output_line(&output),
            detail: None,
        },
        Ok(output) => HostToolDiagnostic {
            status: HostToolStatus::Unusable,
            resolved_path,
            version: None,
            detail: Some(match output.code {
                Some(code) => format!("exited with status {code}"),
                None => "terminated without an exit status".to_string(),
            }),
        },
        Err(detail) => HostToolDiagnostic {
            status: HostToolStatus::Unusable,
            resolved_path,
            version: None,
            detail: Some(detail),
        },
    }
}

fn auth_method(output: &str) -> String {
    let lower = output.to_ascii_lowercase();
    if lower.contains("chatgpt") {
        "chatgpt".to_string()
    } else if lower.contains("api key") || lower.contains("api-key") {
        "api-key".to_string()
    } else {
        "authenticated".to_string()
    }
}

fn parse_auth_output(output: &CommandOutput) -> CodexAuthDiagnostic {
    let combined = format!("{}\n{}", output.stdout, output.stderr);
    let lower = combined.to_ascii_lowercase();
    if output.success {
        return CodexAuthDiagnostic {
            status: CodexAuthStatus::Authenticated,
            method: Some(auth_method(&combined)),
            detail: None,
        };
    }
    if lower.contains("not logged in")
        || lower.contains("login required")
        || lower.contains("not authenticated")
        || lower.contains("unauthenticated")
    {
        return CodexAuthDiagnostic {
            status: CodexAuthStatus::Unauthenticated,
            method: None,
            detail: None,
        };
    }
    CodexAuthDiagnostic {
        status: CodexAuthStatus::Unknown,
        method: None,
        detail: Some(match output.code {
            Some(code) => format!("status command exited with {code}"),
            None => "status command terminated without an exit status".to_string(),
        }),
    }
}

async fn run_auth_status(
    path: &Path,
    args: &[&str],
    environment: &HashMap<String, String>,
) -> CodexAuthDiagnostic {
    match run_command(path, args, environment).await {
        Ok(output) => parse_auth_output(&output),
        Err(detail) => CodexAuthDiagnostic {
            status: CodexAuthStatus::Unknown,
            method: None,
            detail: Some(detail),
        },
    }
}

async fn codex_app_server_result(
    lines: &mut Lines<BufReader<tokio::process::ChildStdout>>,
    id: i64,
) -> Option<serde_json::Value> {
    loop {
        let line = lines.next_line().await.ok()??;
        let response: serde_json::Value = serde_json::from_str(&line).ok()?;
        if response.get("id").and_then(serde_json::Value::as_i64) == Some(id) {
            return response.get("result").cloned();
        }
    }
}

/// The CLI login command checks OpenAI credentials even when Codex is configured
/// to use a provider that does not require them. Ask the same Codex CLI used by
/// the ACP adapter whether OpenAI authentication is needed for this environment.
async fn codex_account_auth_status(
    adapter: &Path,
    environment: &HashMap<String, String>,
) -> Option<CodexAuthDiagnostic> {
    let mut command = diagnostic_command(adapter, &["cli", "app-server"]);
    command
        .env_clear()
        .envs(environment)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    tokio::time::timeout(HOST_PROBE_TIMEOUT, async {
        let mut child = command.spawn().ok()?;
        let mut stdin = child.stdin.take()?;
        let stdout = child.stdout.take()?;
        let mut lines = BufReader::new(stdout).lines();

        let initialize = serde_json::json!({
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": {
                    "name": "Agentero",
                    "version": env!("CARGO_PKG_VERSION"),
                },
                "capabilities": null,
            },
        });
        stdin
            .write_all(format!("{initialize}\n").as_bytes())
            .await
            .ok()?;
        codex_app_server_result(&mut lines, 1).await?;
        stdin
            .write_all(
                b"{\"id\":2,\"method\":\"account/read\",\"params\":{\"refreshToken\":false}}\n",
            )
            .await
            .ok()?;
        let account = codex_app_server_result(&mut lines, 2).await?;
        let required = account.get("requiresOpenaiAuth")?.as_bool()?;
        let has_account = !account.get("account")?.is_null();
        drop(stdin);
        let _ = tokio::time::timeout(Duration::from_millis(250), child.wait()).await;

        Some(CodexAuthDiagnostic {
            status: if !required {
                CodexAuthStatus::NotApplicable
            } else if has_account {
                CodexAuthStatus::Authenticated
            } else {
                CodexAuthStatus::Unauthenticated
            },
            method: None,
            detail: None,
        })
    })
    .await
    .ok()
    .flatten()
}

async fn diagnose_codex_auth_in_env(
    desc: &AgentDescriptor,
    environment: &HashMap<String, String>,
) -> CodexAuthDiagnostic {
    let Some(adapter) = resolve_command_in_agent_env(&desc.command, environment) else {
        return CodexAuthDiagnostic {
            status: CodexAuthStatus::NotApplicable,
            method: None,
            detail: Some("codex-acp is not installed".to_string()),
        };
    };

    let adapter_result =
        run_auth_status(adapter.as_path(), &["cli", "login", "status"], environment).await;
    if adapter_result.status == CodexAuthStatus::Authenticated {
        return adapter_result;
    }
    if let Some(status) = codex_account_auth_status(adapter.as_path(), environment).await {
        return status;
    }
    if adapter_result.status == CodexAuthStatus::Unauthenticated {
        // A failed account/read cannot distinguish missing OpenAI login from a
        // custom provider that does not require it.
        return CodexAuthDiagnostic {
            status: CodexAuthStatus::Unknown,
            method: None,
            detail: Some("Codex app-server account status unavailable".to_string()),
        };
    }

    let Some(codex) = resolve_command_in_agent_env("codex", environment) else {
        return adapter_result;
    };
    let native_result = run_auth_status(codex.as_path(), &["login", "status"], environment).await;
    if native_result.status == CodexAuthStatus::Unauthenticated {
        return CodexAuthDiagnostic {
            status: CodexAuthStatus::Unknown,
            method: None,
            detail: Some("Codex app-server account status unavailable".to_string()),
        };
    }
    native_result
}

pub(crate) async fn diagnose_codex_auth(desc: &AgentDescriptor) -> CodexAuthDiagnostic {
    let environment = effective_local_agent_env(desc);
    diagnose_codex_auth_in_env(desc, &environment).await
}

/// Claude Code auth state via `claude auth status` (JSON with a `loggedIn` flag).
pub(crate) async fn diagnose_claude_auth(desc: &AgentDescriptor) -> CodexAuthDiagnostic {
    let environment = effective_local_agent_env(desc);
    let Some(claude) = resolve_command_in_agent_env("claude", &environment) else {
        return CodexAuthDiagnostic {
            status: CodexAuthStatus::NotApplicable,
            method: None,
            detail: Some("claude is not installed".to_string()),
        };
    };
    match run_command(claude.as_path(), &["auth", "status"], &environment).await {
        Ok(output) => parse_claude_auth_output(&output),
        Err(detail) => CodexAuthDiagnostic {
            status: CodexAuthStatus::Unknown,
            method: None,
            detail: Some(detail),
        },
    }
}

/// `claude auth status` prints JSON like `{"loggedIn": true, "authMethod": "oauth_token"}`
/// regardless of the exit code; fall back to the text heuristics when the shape differs.
fn parse_claude_auth_output(output: &CommandOutput) -> CodexAuthDiagnostic {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&output.stdout) {
        match value.get("loggedIn").and_then(serde_json::Value::as_bool) {
            Some(true) => {
                return CodexAuthDiagnostic {
                    status: CodexAuthStatus::Authenticated,
                    method: value
                        .get("authMethod")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string),
                    detail: None,
                };
            }
            Some(false) => {
                return CodexAuthDiagnostic {
                    status: CodexAuthStatus::Unauthenticated,
                    method: None,
                    detail: None,
                };
            }
            None => {}
        }
    }
    parse_auth_output(output)
}

async fn npm_prefix(
    npm: &HostToolDiagnostic,
    environment: &HashMap<String, String>,
) -> Option<String> {
    if npm.status != HostToolStatus::Available {
        return None;
    }
    let path = PathBuf::from(npm.resolved_path.as_ref()?);
    let output = run_command(&path, &["prefix", "-g"], environment)
        .await
        .ok()?;
    if !output.success {
        return None;
    }
    first_output_line(&output)
}

fn append_npm_prefix(environment: &mut HashMap<String, String>, prefix: &str) {
    let bin = if cfg!(windows) {
        PathBuf::from(prefix)
    } else {
        PathBuf::from(prefix).join("bin")
    };
    let mut paths = environment
        .get("PATH")
        .map(|value| std::env::split_paths(value).collect::<Vec<_>>())
        .unwrap_or_default();
    if !paths.iter().any(|path| path == &bin) {
        paths.push(bin);
    }
    if let Ok(value) = std::env::join_paths(paths) {
        environment.insert("PATH".to_string(), value.to_string_lossy().into_owned());
    }
}

pub async fn diagnose_host(registry: &AgentRegistry) -> Result<HostDoctorReport, AppError> {
    let descriptor = codex_descriptor(registry)?;
    let mut environment = effective_local_agent_env(&descriptor);
    let npm = diagnose_tool("npm", &environment).await;
    let npm_prefix = npm_prefix(&npm, &environment).await;
    if let Some(prefix) = npm_prefix.as_deref() {
        append_npm_prefix(&mut environment, prefix);
    }
    let node = diagnose_tool("node", &environment).await;
    Ok(HostDoctorReport {
        node,
        npm,
        npm_prefix,
    })
}

async fn diagnose_host_in_env(environment: &HashMap<String, String>) -> HostDoctorReport {
    let npm = diagnose_tool("npm", environment).await;
    let npm_prefix = npm_prefix(&npm, environment).await;
    let node = diagnose_tool("node", environment).await;
    HostDoctorReport {
        node,
        npm,
        npm_prefix,
    }
}

/// winget package id for the official Node.js LTS installer.
#[cfg(windows)]
const NODE_WINGET_PACKAGE: &str = "OpenJS.NodeJS.LTS";

/// The system package manager that can install Node.js on this host.
fn node_installer() -> Option<(&'static str, Vec<String>)> {
    #[cfg(windows)]
    {
        if which::which("winget").is_ok() {
            return Some((
                "winget",
                vec![
                    "install".to_string(),
                    NODE_WINGET_PACKAGE.to_string(),
                    "--silent".to_string(),
                    "--accept-package-agreements".to_string(),
                    "--accept-source-agreements".to_string(),
                ],
            ));
        }
    }
    #[cfg(not(windows))]
    {
        if which::which("brew").is_ok() {
            return Some(("brew", vec!["install".to_string(), "node".to_string()]));
        }
    }
    None
}

/// A GUI app inherits PATH from its launcher, so a fresh winget install is
/// invisible to this process. Merge the machine + user PATH from the registry
/// so the re-probe can find the new node.
#[cfg(windows)]
fn refresh_path_from_registry(environment: &mut HashMap<String, String>) {
    let Ok(powershell) = which::which("powershell").or_else(|_| which::which("pwsh")) else {
        return;
    };
    let script = "$m=[Environment]::GetEnvironmentVariable('Path','Machine');$u=[Environment]::GetEnvironmentVariable('Path','User');@($m,$u) -join ';'";
    let Ok(output) = std::process::Command::new(powershell)
        .args(["-NoProfile", "-Command", script])
        .output()
    else {
        return;
    };
    let merged = String::from_utf8_lossy(&output.stdout);
    let mut paths = environment
        .get("PATH")
        .map(|value| std::env::split_paths(value).collect::<Vec<_>>())
        .unwrap_or_default();
    for entry in std::env::split_paths(merged.as_ref()) {
        if !entry.as_os_str().is_empty() && !paths.contains(&entry) {
            paths.push(entry);
        }
    }
    if let Ok(value) = std::env::join_paths(paths) {
        environment.insert("PATH".to_string(), value.to_string_lossy().into_owned());
    }
}

#[cfg(not(windows))]
fn refresh_path_from_registry(_environment: &mut HashMap<String, String>) {}

/// One-click install of Node.js through the host's package manager, followed by
/// a fresh host probe. Linux is intentionally excluded: it has no single
/// package manager and installs need sudo, so the UI falls back to manual
/// guidance there.
///
/// `app` / `task_id` surface progress and cooperative cancel
/// (`agent_lifecycle_cancel`) through the shared Agent lifecycle channel; both
/// the Doctor button and the npm-not-found toast use the background runner.
pub async fn install_node(
    registry: &AgentRegistry,
    app: Option<&AppHandle>,
    task_id: Option<&str>,
) -> Result<NodeInstallResult, AppError> {
    let descriptor = codex_descriptor(registry)?;
    let mut environment = effective_local_agent_env(&descriptor);

    let Some((installer, args)) = node_installer() else {
        let report = diagnose_host_in_env(&environment).await;
        return Ok(NodeInstallResult {
            outcome: NodeInstallOutcome::NoPackageManager,
            installer: None,
            error: None,
            report,
        });
    };

    let path = which::which(installer).map_err(|error| {
        AppError::message(format!(
            "resolved {installer} but failed to start it: {error}"
        ))
    })?;
    let install_error = match run_installer_cancellable(
        &path,
        &args,
        &environment,
        app,
        task_id,
        "agent-lifecycle-install",
    )
    .await
    {
        // Propagate user-initiated cancel as the stable cancel message so the
        // UI suppresses the error toast and marks the task cancelled.
        Ok(CancellableOutcome::Cancelled) => {
            return Err(AppError::message("background task cancelled"));
        }
        Ok(CancellableOutcome::Output(output)) if output.success => None,
        Ok(CancellableOutcome::Output(output)) => Some(format!(
            "{} install failed: {}",
            installer,
            first_output_line(&output).unwrap_or_else(|| "no output".to_string())
        )),
        Err(detail) => Some(format!("{installer} install failed: {detail}")),
    };
    let outcome = match install_error {
        Some(_) => NodeInstallOutcome::Failed,
        None => NodeInstallOutcome::Installed,
    };

    refresh_path_from_registry(&mut environment);

    let report = diagnose_host_in_env(&environment).await;
    let report_ok = report.node.status == HostToolStatus::Available;
    let error = match install_error {
        Some(detail) => Some(detail),
        None if !report_ok => Some("node still unavailable after install".to_string()),
        None => None,
    };
    Ok(NodeInstallResult {
        outcome,
        installer: Some(installer.to_string()),
        error,
        report,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output(success: bool, code: i32, stdout: &str, stderr: &str) -> CommandOutput {
        CommandOutput {
            success,
            code: Some(code),
            stdout: stdout.to_string(),
            stderr: stderr.to_string(),
        }
    }

    #[test]
    #[cfg(windows)]
    fn diagnostic_command_routes_scripts_through_shells() {
        // `hide_console_window` has no std getter, so guard the routing that the
        // console-hiding wrapper sits on top of.
        let cmd = diagnostic_command(Path::new("probe.cmd"), &["--version"]);
        assert_eq!(cmd.as_std().get_program(), "cmd");

        let ps1 = diagnostic_command(Path::new("probe.ps1"), &["--version"]);
        assert_eq!(ps1.as_std().get_program(), "powershell");

        let exe = diagnostic_command(Path::new("hermes.exe"), &["--version"]);
        assert_eq!(exe.as_std().get_program(), "hermes.exe");
    }

    #[test]
    fn parses_authenticated_chatgpt_from_stderr() {
        let result = parse_auth_output(&output(true, 0, "", "Logged in using ChatGPT\n"));
        assert_eq!(result.status, CodexAuthStatus::Authenticated);
        assert_eq!(result.method.as_deref(), Some("chatgpt"));
        assert!(result.detail.is_none());
    }

    #[test]
    fn parses_logged_out_without_returning_raw_output() {
        let result = parse_auth_output(&output(
            false,
            1,
            "",
            "Not logged in: private@example.com\n",
        ));
        assert_eq!(result.status, CodexAuthStatus::Unauthenticated);
        assert!(result.method.is_none());
        assert!(result.detail.is_none());
    }

    #[test]
    fn leaves_unrecognized_auth_failure_unknown() {
        let result = parse_auth_output(&output(false, 7, "", "unexpected failure\n"));
        assert_eq!(result.status, CodexAuthStatus::Unknown);
        assert_eq!(
            result.detail.as_deref(),
            Some("status command exited with 7")
        );
    }

    fn fake_codex_auth(
        requires_openai_auth: Option<bool>,
    ) -> (tempfile::TempDir, HashMap<String, String>) {
        let bin = tempfile::tempdir().unwrap();
        let response = match requires_openai_auth {
            Some(true) => "true",
            Some(false) => "false",
            None => "null",
        };
        #[cfg(windows)]
        {
            std::fs::write(
                bin.path().join("codex-acp.cmd"),
                "@echo off\r\nif \"%~1\"==\"cli\" if \"%~2\"==\"app-server\" (\r\nset /p init=\r\necho {\"id\":1,\"result\":{}}\r\nset /p account=\r\necho {\"id\":2,\"result\":{\"account\":null,\"requiresOpenaiAuth\":__REQUIRED__}}\r\nexit /b 0\r\n)\r\necho Not logged in 1>&2\r\nexit /b 1\r\n"
                    .replace("__REQUIRED__", response),
            )
            .unwrap();
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let adapter = bin.path().join("codex-acp");
            std::fs::write(
                &adapter,
                "#!/bin/sh\nif [ \"$1\" = cli ] && [ \"$2\" = app-server ]; then\n  IFS= read -r init\n  printf '%s\\n' '{\"id\":1,\"result\":{}}'\n  IFS= read -r account\n  printf '%s\\n' '{\"id\":2,\"result\":{\"account\":null,\"requiresOpenaiAuth\":__REQUIRED__}}'\n  exit 0\nfi\necho 'Not logged in' >&2\nexit 1\n"
                    .replace("__REQUIRED__", response),
            )
            .unwrap();
            std::fs::set_permissions(&adapter, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let mut environment: HashMap<_, _> = std::env::vars().collect();
        let path = std::env::join_paths(
            std::iter::once(bin.path().to_path_buf()).chain(
                environment
                    .get("PATH")
                    .into_iter()
                    .flat_map(std::env::split_paths),
            ),
        )
        .unwrap();
        environment.insert("PATH".to_string(), path.to_string_lossy().into_owned());
        (bin, environment)
    }

    fn fake_codex_descriptor() -> AgentDescriptor {
        AgentDescriptor {
            id: "catalog-codex-acp".into(),
            name: "Codex".into(),
            template: AgentTemplate::CodexAcp,
            command: "codex-acp".into(),
            args: vec![],
            env: HashMap::new(),
            available: true,
            last_error: None,
            last_probe_ok: None,
            last_probe_agent_name: None,
            last_probe_error: None,
            last_probed_at: None,
        }
    }

    #[tokio::test]
    async fn codex_custom_provider_does_not_require_openai_login() {
        let (_bin, environment) = fake_codex_auth(Some(false));
        let result = diagnose_codex_auth_in_env(&fake_codex_descriptor(), &environment).await;
        assert_eq!(result.status, CodexAuthStatus::NotApplicable);
    }

    #[tokio::test]
    async fn codex_openai_provider_still_requires_login() {
        let (_bin, environment) = fake_codex_auth(Some(true));
        let result = diagnose_codex_auth_in_env(&fake_codex_descriptor(), &environment).await;
        assert_eq!(result.status, CodexAuthStatus::Unauthenticated);
    }

    #[tokio::test]
    async fn codex_unavailable_account_query_is_not_assumed_logged_out() {
        let (_bin, environment) = fake_codex_auth(None);
        let result = diagnose_codex_auth_in_env(&fake_codex_descriptor(), &environment).await;
        assert_eq!(result.status, CodexAuthStatus::Unknown);
    }

    #[test]
    fn parses_claude_logged_in_json() {
        let result = parse_claude_auth_output(&output(
            true,
            0,
            "{\"loggedIn\": true, \"authMethod\": \"oauth_token\"}\n",
            "",
        ));
        assert_eq!(result.status, CodexAuthStatus::Authenticated);
        assert_eq!(result.method.as_deref(), Some("oauth_token"));
        assert!(result.detail.is_none());
    }

    #[test]
    fn parses_claude_logged_out_json_even_on_failure_exit() {
        let result = parse_claude_auth_output(&output(false, 1, "{\"loggedIn\": false}\n", ""));
        assert_eq!(result.status, CodexAuthStatus::Unauthenticated);
        assert!(result.method.is_none());
        assert!(result.detail.is_none());
    }

    #[test]
    fn falls_back_to_text_auth_parsing_for_unexpected_claude_output() {
        let result = parse_claude_auth_output(&output(
            false,
            1,
            "",
            "Not logged in: private@example.com\n",
        ));
        assert_eq!(result.status, CodexAuthStatus::Unauthenticated);
    }
}
