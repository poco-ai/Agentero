//! Registry / catalog / lifecycle Tauri commands.

use super::{AgentUserAgentResponse, EnabledResponse};
use crate::core::error::{map_err, ApiResult, AppError};
use crate::features::agent::models::{
    AgentListResponse, AgentOnly, AgentSkill, CatalogScanResponse, ProbeResult, UpsertAgentRequest,
};
use crate::features::agent::remote_host::RemoteAgentHosts;
use crate::features::agent::service::{self, emit_registry_changed};
use crate::features::agent::{list_agent_skills, probe_agent, AgentRegistry};
use std::sync::Arc;
use tauri::{AppHandle, State};

#[tauri::command]
#[specta::specta]
pub fn agent_list_agents(registry: State<'_, AgentRegistry>) -> ApiResult<AgentListResponse> {
    match service::list_agents(registry.inner()) {
        Ok(s) => ApiResult::ok(s),
        Err(e) => map_err(e),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn agent_list_skills(
    remote_registry: State<'_, Arc<dyn RemoteAgentHosts>>,
    vault_path: Option<String>,
) -> Result<ApiResult<Vec<AgentSkill>>, String> {
    let remote_target = match remote_registry.resolve_target(vault_path.as_deref()).await {
        Ok(target) => target,
        Err(e) => return Ok(map_err(e)),
    };
    if let Some(remote) = remote_target {
        if let Err(e) = remote.ensure_vault_skills(None).await {
            return Ok(map_err(e));
        }
        if let Err(e) = remote.materialize_skills().await {
            return Ok(map_err(e));
        }
        let work_root = remote.work_root().to_string_lossy().to_string();
        return Ok(ApiResult::ok(list_agent_skills(Some(&work_root))));
    }
    Ok(ApiResult::ok(list_agent_skills(vault_path.as_deref())))
}

#[tauri::command]
#[specta::specta]
pub fn agent_scan_catalog(registry: State<'_, AgentRegistry>) -> ApiResult<CatalogScanResponse> {
    match service::scan_catalog(registry.inner()) {
        Ok(s) => ApiResult::ok(s),
        Err(e) => map_err(e),
    }
}

#[tauri::command]
#[specta::specta]
pub fn agent_upsert_agent(
    app: AppHandle,
    registry: State<'_, AgentRegistry>,
    request: UpsertAgentRequest,
) -> ApiResult<AgentOnly> {
    match registry.upsert(request) {
        Ok(agent) => {
            emit_registry_changed(&app);
            ApiResult::ok(AgentOnly { agent })
        }
        Err(e) => map_err(e),
    }
}

#[tauri::command]
#[specta::specta]
pub fn agent_ensure_catalog(
    app: AppHandle,
    registry: State<'_, AgentRegistry>,
    template_id: String,
    set_default: bool,
) -> ApiResult<AgentOnly> {
    match service::ensure_catalog(&app, registry.inner(), &template_id, set_default) {
        Ok(agent) => ApiResult::ok(agent),
        Err(e) => map_err(e),
    }
}

#[tauri::command]
#[specta::specta]
pub fn agent_remove_agent(
    app: AppHandle,
    registry: State<'_, AgentRegistry>,
    id: String,
) -> ApiResult<crate::core::json::JsonValue> {
    match registry.remove(&id) {
        Ok(()) => {
            emit_registry_changed(&app);
            ApiResult::ok(crate::core::json::JsonValue::null())
        }
        Err(e) => map_err(e),
    }
}

#[tauri::command]
#[specta::specta]
pub fn agent_set_default(
    app: AppHandle,
    registry: State<'_, AgentRegistry>,
    id: Option<String>,
) -> ApiResult<AgentListResponse> {
    match registry.set_default(id) {
        Ok(s) => {
            emit_registry_changed(&app);
            ApiResult::ok(service::list_from_state(s))
        }
        Err(e) => map_err(e),
    }
}

#[tauri::command]
#[specta::specta]
pub fn agent_set_enabled(
    app: AppHandle,
    registry: State<'_, AgentRegistry>,
    enabled: bool,
) -> ApiResult<EnabledResponse> {
    match registry.set_enabled(enabled) {
        Ok(s) => {
            emit_registry_changed(&app);
            ApiResult::ok(EnabledResponse { enabled: s.enabled })
        }
        Err(e) => map_err(e),
    }
}

#[tauri::command]
#[specta::specta]
pub fn agent_set_user_agent(
    registry: State<'_, AgentRegistry>,
    user_agent: String,
    user_agent_provider_ids: String,
) -> ApiResult<AgentUserAgentResponse> {
    match registry.set_user_agent(user_agent, user_agent_provider_ids) {
        Ok(s) => ApiResult::ok(AgentUserAgentResponse {
            user_agent: s.user_agent,
            user_agent_provider_ids: s.user_agent_provider_ids,
        }),
        Err(e) => map_err(e),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn agent_probe(
    app: AppHandle,
    registry: State<'_, AgentRegistry>,
    id: String,
) -> Result<ApiResult<ProbeResult>, String> {
    let desc = match registry.get(&id) {
        Ok(d) => d,
        Err(e) => return Ok(map_err(e)),
    };
    if !desc.available {
        let result = ProbeResult {
            agent_id: id.clone(),
            available: false,
            agent_name: None,
            protocol_version: None,
            error: desc
                .last_error
                .or_else(|| Some(format!("command `{}` not found on PATH", desc.command))),
            session_capabilities: None,
        };
        let _ = registry.apply_probe_result(&id, &result);
        emit_registry_changed(&app);
        return Ok(ApiResult::ok(result));
    }
    let result = probe_agent(&desc, None).await;
    let _ = registry.apply_probe_result(&id, &result);
    emit_registry_changed(&app);
    Ok(ApiResult::ok(result))
}

/// Request cooperative cancellation of an in-flight tool lifecycle run; the
/// Host supervision loop kills the installer child process.
#[tauri::command]
#[specta::specta]
pub fn agent_lifecycle_cancel(task_id: String) -> ApiResult<bool> {
    crate::features::agent::registry::lifecycle::request_lifecycle_cancel(&task_id);
    ApiResult::ok(true)
}

/// Silently install, update or uninstall a catalog Agent CLI (and ACP adapter
/// when needed). Uninstall also removes the registry entry on success.
///
/// Replaces the old terminal confirm-then-run helper. Platform scripts mirror
/// CC Switch: official installer first, npm fallback; GUI apps inject the
/// login-shell PATH on macOS/Linux. UI must not pass free-form shell — only known
/// template ids and `install` | `update` | `uninstall`.
///
/// Blocking work runs on a worker thread so the async runtime is not stalled.
#[tauri::command]
#[specta::specta]
pub async fn agent_run_tool_lifecycle(
    app: AppHandle,
    registry: State<'_, AgentRegistry>,
    template_id: String,
    action: String,
    task_id: Option<String>,
) -> Result<ApiResult<crate::core::json::JsonValue>, String> {
    use crate::features::agent::registry::lifecycle::{
        run_template_lifecycle, ToolLifecycleAction,
    };

    let action_label = action.clone();
    let action = match ToolLifecycleAction::parse(&action) {
        Ok(a) => a,
        Err(e) => return Ok(map_err(AppError::message(e))),
    };
    let (proxy_enabled, proxy_url) = registry.proxy_settings().unwrap_or_default();
    let template_id_for_log = template_id.clone();
    let task_id_for_worker = task_id.clone();
    let app_for_emit = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        run_template_lifecycle(
            &template_id,
            action,
            Some(&app),
            task_id_for_worker.as_deref(),
            proxy_enabled,
            &proxy_url,
        )
    })
    .await
    .map_err(|e| format!("tool lifecycle task join error: {e}"))?;
    if let Some(task_id) = task_id.as_deref() {
        crate::features::agent::registry::lifecycle::clear_lifecycle_cancel(task_id);
    }

    match result {
        Ok(()) => {
            // Uninstall removed binaries; drop the registry entry too so the
            // row goes back to "not installed" (never leave a stale entry).
            if matches!(action, ToolLifecycleAction::Uninstall) {
                if let Err(e) = registry.remove_catalog_template(&template_id_for_log) {
                    return Ok(map_err(e));
                }
            }
            log::info!(
                target: "agentero::agent",
                "tool_lifecycle ok template={template_id_for_log} action={action_label}"
            );
            emit_registry_changed(&app_for_emit);
            Ok(ApiResult::ok(crate::core::json::JsonValue::null()))
        }
        Err(e) => {
            log::warn!(
                target: "agentero::agent",
                "tool_lifecycle failed template={template_id_for_log} action={action_label}: {e}"
            );
            Ok(map_err(AppError::message(e)))
        }
    }
}

/// What a silent uninstall of this template would remove (npm commands and
/// managed dirs); null when the template has no managed uninstall.
#[tauri::command]
#[specta::specta]
pub fn agent_tool_uninstall_info(
    template_id: String,
) -> ApiResult<Option<crate::features::agent::registry::lifecycle::UninstallInfo>> {
    ApiResult::ok(crate::features::agent::registry::lifecycle::uninstall_info(
        &template_id,
    ))
}

/// Ensure catalog agent is registered, then run ACP initialize probe.
#[tauri::command]
#[specta::specta]
pub async fn agent_probe_catalog(
    app: AppHandle,
    registry: State<'_, AgentRegistry>,
    template_id: String,
) -> Result<ApiResult<ProbeResult>, String> {
    match service::probe_catalog(&app, registry.inner(), &template_id).await {
        Ok(result) => Ok(ApiResult::ok(result)),
        Err(e) => Ok(map_err(e)),
    }
}
