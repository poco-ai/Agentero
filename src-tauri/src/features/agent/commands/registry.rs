//! Registry / catalog / lifecycle Tauri commands.

use super::{
    emit_registry_changed, list_from_state, AgentOnly, AgentUserAgentResponse, EnabledResponse,
};
use crate::core::error::{map_err, ApiResult, AppError};
use crate::features::agent::models::{
    AgentListResponse, AgentSkill, CatalogScanResponse, ProbeResult, UpsertAgentRequest,
};
use crate::features::agent::{list_agent_skills, probe_agent, AgentRegistry};
use crate::integration::remote::{
    materialize_skills_to_work, resolve_remote_target, RemoteRegistry,
};
use std::sync::Arc;
use tauri::{AppHandle, State};

#[tauri::command]
pub fn agent_list_agents(registry: State<'_, AgentRegistry>) -> ApiResult<AgentListResponse> {
    match registry.snapshot() {
        Ok(s) => ApiResult::ok(list_from_state(s)),
        Err(e) => map_err(e),
    }
}

#[tauri::command]
pub async fn agent_list_skills(
    remote_registry: State<'_, Arc<RemoteRegistry>>,
    vault_path: Option<String>,
) -> Result<ApiResult<Vec<AgentSkill>>, String> {
    let remote_target =
        match resolve_remote_target(remote_registry.inner(), vault_path.as_deref()).await {
            Ok(target) => target,
            Err(e) => return Ok(map_err(e)),
        };
    if let Some(remote) = remote_target {
        if let Err(e) =
            crate::integration::remote::ensure_remote_vault_skills(&remote.session, None).await
        {
            return Ok(map_err(e));
        }
        if let Err(e) = materialize_skills_to_work(&remote.session).await {
            return Ok(map_err(e));
        }
        let work_root = remote.work_root.to_string_lossy().to_string();
        return Ok(ApiResult::ok(list_agent_skills(Some(&work_root))));
    }
    Ok(ApiResult::ok(list_agent_skills(vault_path.as_deref())))
}

#[tauri::command]
pub fn agent_scan_catalog(registry: State<'_, AgentRegistry>) -> ApiResult<CatalogScanResponse> {
    match registry.scan_catalog() {
        Ok(s) => ApiResult::ok(s),
        Err(e) => map_err(e),
    }
}

#[tauri::command]
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
pub fn agent_ensure_catalog(
    app: AppHandle,
    registry: State<'_, AgentRegistry>,
    template_id: String,
    set_default: bool,
) -> ApiResult<AgentOnly> {
    match registry.ensure_catalog_agent(&template_id, set_default) {
        Ok(agent) => {
            emit_registry_changed(&app);
            ApiResult::ok(AgentOnly { agent })
        }
        Err(e) => map_err(e),
    }
}

#[tauri::command]
pub fn agent_remove_agent(
    app: AppHandle,
    registry: State<'_, AgentRegistry>,
    id: String,
) -> ApiResult<serde_json::Value> {
    match registry.remove(&id) {
        Ok(()) => {
            emit_registry_changed(&app);
            ApiResult::ok(serde_json::Value::Null)
        }
        Err(e) => map_err(e),
    }
}

#[tauri::command]
pub fn agent_set_default(
    app: AppHandle,
    registry: State<'_, AgentRegistry>,
    id: Option<String>,
) -> ApiResult<AgentListResponse> {
    match registry.set_default(id) {
        Ok(s) => {
            emit_registry_changed(&app);
            ApiResult::ok(list_from_state(s))
        }
        Err(e) => map_err(e),
    }
}

#[tauri::command]
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
pub async fn agent_run_tool_lifecycle(
    app: AppHandle,
    registry: State<'_, AgentRegistry>,
    template_id: String,
    action: String,
    task_id: Option<String>,
) -> Result<ApiResult<serde_json::Value>, String> {
    use crate::features::agent::registry::lifecycle::{
        run_template_lifecycle, ToolLifecycleAction,
    };

    let action_label = action.clone();
    let action = match ToolLifecycleAction::parse(&action) {
        Ok(a) => a,
        Err(e) => return Ok(map_err(AppError::message(e))),
    };
    let template_id_for_log = template_id.clone();
    let task_id_for_worker = task_id.clone();
    let app_for_emit = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        run_template_lifecycle(
            &template_id,
            action,
            Some(&app),
            task_id_for_worker.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("tool lifecycle task join error: {e}"))?;
    if let Some(task_id) = task_id.as_deref() {
        crate::core::background_tasks::finish(task_id);
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
            Ok(ApiResult::ok(serde_json::Value::Null))
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
pub fn agent_tool_uninstall_info(
    template_id: String,
) -> ApiResult<Option<crate::features::agent::registry::lifecycle::UninstallInfo>> {
    ApiResult::ok(crate::features::agent::registry::lifecycle::uninstall_info(
        &template_id,
    ))
}

/// Ensure catalog agent is registered, then run ACP initialize probe.
#[tauri::command]
pub async fn agent_probe_catalog(
    app: AppHandle,
    registry: State<'_, AgentRegistry>,
    template_id: String,
) -> Result<ApiResult<ProbeResult>, String> {
    let desc = match registry.ensure_catalog_agent(&template_id, false) {
        Ok(d) => d,
        Err(e) => return Ok(map_err(e)),
    };
    if !desc.available {
        let result = ProbeResult {
            agent_id: desc.id.clone(),
            available: false,
            agent_name: None,
            protocol_version: None,
            error: desc
                .last_error
                .or_else(|| Some(format!("command `{}` not found on PATH", desc.command))),
            session_capabilities: None,
        };
        let _ = registry.apply_probe_result(&desc.id, &result);
        emit_registry_changed(&app);
        return Ok(ApiResult::ok(result));
    }
    let result = probe_agent(&desc, None).await;
    let _ = registry.apply_probe_result(&desc.id, &result);
    emit_registry_changed(&app);
    Ok(ApiResult::ok(result))
}
