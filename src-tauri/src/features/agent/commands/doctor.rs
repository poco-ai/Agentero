#[cfg(not(target_os = "ios"))]
use crate::app::terminal::{open_terminal_agent_cli, open_terminal_confirm_login};
use crate::core::error::{map_err, ApiResult};
#[cfg(not(target_os = "ios"))]
use crate::features::agent::acp::client::{
    effective_local_agent_env, local_login_shell_env, resolve_command_in_agent_env,
};
use crate::features::agent::doctor::{
    diagnose_host, install_node, HostDoctorReport, NodeInstallResult,
};
use crate::features::agent::doctor_agents::{diagnose_agents, AgentAcpDiagnostic};
use crate::features::agent::registry::{interactive_cli, template_info};
use crate::features::agent::{AgentRegistry, AgentWarmGate};
#[cfg(not(target_os = "ios"))]
use crate::features::system::settings::AppSettingsStore;
#[cfg(not(target_os = "ios"))]
use std::collections::HashMap;
#[cfg(not(target_os = "ios"))]
use std::path::Path;
use tauri::{AppHandle, State};

#[tauri::command]
#[specta::specta]
pub async fn doctor_check_host(
    registry: State<'_, AgentRegistry>,
) -> Result<ApiResult<HostDoctorReport>, String> {
    Ok(match diagnose_host(registry.inner()).await {
        Ok(report) => ApiResult::ok(report),
        Err(error) => map_err(error),
    })
}

/// One-click install of Node.js via the host package manager (winget / brew),
/// then re-probe. Can take several minutes while the installer downloads.
///
/// `taskId` opts into background progress (`agent-lifecycle:progress`) and
/// cooperative cancel via `agent_lifecycle_cancel`.
#[tauri::command]
#[specta::specta]
pub async fn doctor_install_node(
    app: AppHandle,
    registry: State<'_, AgentRegistry>,
    task_id: Option<String>,
) -> Result<ApiResult<NodeInstallResult>, String> {
    let result = install_node(registry.inner(), Some(&app), task_id.as_deref()).await;
    if let Some(task_id) = task_id.as_deref() {
        crate::features::agent::registry::lifecycle::clear_lifecycle_cancel(task_id);
    }
    Ok(match result {
        Ok(result) => ApiResult::ok(result),
        Err(error) => map_err(error),
    })
}

/// Re-probe every registered Agent over ACP and return classified failures.
/// Can take up to ~30s per slow agent (probes run with limited concurrency).
#[tauri::command]
#[specta::specta]
pub async fn doctor_check_agents(
    app: AppHandle,
    registry: State<'_, AgentRegistry>,
    warm_gate: State<'_, AgentWarmGate>,
) -> Result<ApiResult<Vec<AgentAcpDiagnostic>>, String> {
    Ok(
        match diagnose_agents(registry.inner(), warm_gate.inner(), &app).await {
            Ok(report) => ApiResult::ok(report),
            Err(error) => map_err(error),
        },
    )
}

/// Open the template-owned CLI login command in a confirm-to-run terminal.
#[cfg(not(target_os = "ios"))]
#[tauri::command]
#[specta::specta]
pub fn doctor_open_agent_login_terminal(
    registry: State<'_, AgentRegistry>,
    store: State<'_, AppSettingsStore>,
    template_id: String,
) -> ApiResult<()> {
    let Some(info) = template_info(&template_id) else {
        return map_err(crate::core::error::AppError::message(
            "unknown agent template",
        ));
    };
    let Some(command) = info
        .login_command
        .as_deref()
        .map(str::trim)
        .filter(|command| !command.is_empty())
    else {
        return map_err(crate::core::error::AppError::message(
            "agent template does not define a login command",
        ));
    };
    let environment = login_command_environment(registry.inner(), &template_id);
    let command = resolve_login_command(command, &environment);
    match open_terminal_confirm_login(&command, &terminal_preference(&store)) {
        Ok(()) => ApiResult::ok(()),
        Err(error) => map_err(error),
    }
}

/// Open the installed Agent's interactive host CLI in a terminal.
///
/// Uses the template's interactive CLI (`registry::interactive_cli`), which is
/// usually `detect_command` but can differ (Antigravity's `agy`). The command is
/// resolved against the registered Agent env like
/// [`doctor_open_agent_login_terminal`].
#[cfg(not(target_os = "ios"))]
#[tauri::command]
#[specta::specta]
pub fn doctor_open_agent_cli_terminal(
    registry: State<'_, AgentRegistry>,
    store: State<'_, AppSettingsStore>,
    template_id: String,
) -> ApiResult<()> {
    let Some(info) = template_info(&template_id) else {
        return map_err(crate::core::error::AppError::message(
            "unknown agent template",
        ));
    };
    let Some(binary) = interactive_cli(&info) else {
        return map_err(crate::core::error::AppError::message(
            "agent template does not define a CLI command",
        ));
    };
    let environment = login_command_environment(registry.inner(), &template_id);
    let command = resolve_login_command(&binary, &environment);
    match open_terminal_agent_cli(&command, &terminal_preference(&store)) {
        Ok(()) => ApiResult::ok(()),
        Err(error) => map_err(error),
    }
}

/// Settings `terminalApp` used by both Agent terminal buttons. A poisoned lock or
/// redacted settings fall back to the system default instead of blocking the
/// action.
#[cfg(not(target_os = "ios"))]
fn terminal_preference(store: &AppSettingsStore) -> String {
    store
        .get()
        .map(|result| result.settings.terminal_app)
        .unwrap_or_default()
}

/// Environment used to resolve a template login command: the registered Agent's
/// merged env when one exists, otherwise the bare login-shell env.
#[cfg(not(target_os = "ios"))]
fn login_command_environment(
    registry: &AgentRegistry,
    template_id: &str,
) -> HashMap<String, String> {
    registry
        .snapshot()
        .ok()
        .and_then(|state| {
            state
                .agents
                .into_iter()
                .find(|agent| agent.template.as_str() == template_id)
        })
        .map_or_else(local_login_shell_env, |desc| {
            effective_local_agent_env(&desc)
        })
}

/// Rewrite a login command's leading executable to its resolved absolute path.
///
/// The confirm-to-run terminal launches `bash -lc`, which ignores the user's
/// zsh config, so a bare `claude` / `codex` can miss `~/.local/bin` in PATH
/// (issue #686). Returns the command unchanged when the binary is already
/// absolute or cannot be resolved.
#[cfg(not(target_os = "ios"))]
fn resolve_login_command(command: &str, environment: &HashMap<String, String>) -> String {
    let mut tokens = command.split_whitespace();
    let Some(binary) = tokens.next() else {
        return command.to_string();
    };
    if Path::new(binary).is_absolute() {
        return command.to_string();
    }
    let Some(path) = resolve_command_in_agent_env(binary, environment) else {
        return command.to_string();
    };
    let binary_path = path.display().to_string();
    // The unix script runs the command through `bash -lc`; the Windows script
    // pastes it into cmd.exe, so each shell gets its own quoting.
    #[cfg(windows)]
    let mut resolved = format!("\"{binary_path}\"");
    #[cfg(not(windows))]
    let mut resolved = format!("'{}'", binary_path.replace('\'', "'\\''"));
    for token in tokens {
        resolved.push(' ');
        resolved.push_str(token);
    }
    resolved
}

#[cfg(all(test, not(target_os = "ios")))]
mod tests {
    use super::resolve_login_command;
    use std::collections::HashMap;

    fn env_with_path(path: &str) -> HashMap<String, String> {
        HashMap::from([("PATH".to_string(), path.to_string())])
    }

    #[test]
    #[cfg(unix)]
    fn rewrites_bare_binary_to_absolute_path() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("claude");
        std::fs::write(&binary, b"").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let environment = env_with_path(&dir.path().display().to_string());
        let resolved = resolve_login_command("claude auth login", &environment);
        assert_eq!(resolved, format!("'{}' auth login", binary.display()));
    }

    #[test]
    fn keeps_unresolvable_command() {
        let environment = env_with_path("/nonexistent");
        assert_eq!(
            resolve_login_command("codex login", &environment),
            "codex login"
        );
    }

    #[test]
    fn keeps_absolute_command() {
        let environment = env_with_path("/usr/bin");
        assert_eq!(
            resolve_login_command("/opt/bin/codex login", &environment),
            "/opt/bin/codex login"
        );
    }
}
