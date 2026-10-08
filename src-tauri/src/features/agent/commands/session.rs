//! Session run / list / load / warm / cancel Tauri commands.
//!
//! Thin shells over `features::agent::service` (shared with the desktop
//! bridge RPC). Async commands return `Result<ApiResult<T>, String>` so
//! `State` borrows are valid (same pattern as `agent_probe`).

use crate::core::error::{map_err, ApiResult};
use crate::features::agent::models::{RunOnceAccepted, RunOnceRequest, WarmRequest, WarmResult};
use crate::features::agent::remote_host::RemoteAgentHosts;
use crate::features::agent::runtime::gates::AskUserGate;
use crate::features::agent::service;
use crate::features::agent::{
    warm_agent, AgentEventEmitter, AgentRegistry, AgentRunController, AgentWarmGate, AgentWarmPool,
    ElicitationGate, PermissionGate,
};
use std::sync::Arc;
use tauri::{Manager, State};

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn agent_run_once(
    window: tauri::WebviewWindow,
    registry: State<'_, AgentRegistry>,
    runs: State<'_, AgentRunController>,
    gate: State<'_, PermissionGate>,
    elicitation_gate: State<'_, ElicitationGate>,
    ask_user_gate: State<'_, AskUserGate>,
    remote_registry: State<'_, Arc<dyn RemoteAgentHosts>>,
    request: RunOnceRequest,
) -> Result<ApiResult<RunOnceAccepted>, String> {
    match service::accept_run_once(
        &window,
        registry.inner(),
        runs.inner(),
        gate.inner(),
        elicitation_gate.inner(),
        ask_user_gate.inner(),
        remote_registry.inner().as_ref(),
        request,
    )
    .await
    {
        Ok(accepted) => Ok(ApiResult::ok(accepted)),
        Err(e) => Ok(map_err(e)),
    }
}

/// List ACP sessions for an agent via `session/list`.
#[tauri::command]
#[specta::specta]
pub async fn agent_list_sessions(
    registry: State<'_, AgentRegistry>,
    remote_registry: State<'_, Arc<dyn RemoteAgentHosts>>,
    warm_gate: State<'_, AgentWarmGate>,
    agent_id: Option<String>,
    vault_path: Option<String>,
    cursor: Option<String>,
) -> Result<ApiResult<crate::features::agent::models::AcpListSessionsResult>, String> {
    match service::list_sessions(
        registry.inner(),
        remote_registry.inner().as_ref(),
        warm_gate.inner(),
        agent_id,
        vault_path,
        cursor,
    )
    .await
    {
        Ok(result) => Ok(ApiResult::ok(result)),
        Err(e) => Ok(map_err(e)),
    }
}

/// Load an ACP session's history via `session/load`.
#[tauri::command]
#[specta::specta]
pub async fn agent_load_session(
    registry: State<'_, AgentRegistry>,
    remote_registry: State<'_, Arc<dyn RemoteAgentHosts>>,
    agent_id: Option<String>,
    session_id: String,
    vault_path: Option<String>,
) -> Result<ApiResult<crate::features::agent::models::AcpLoadSessionResult>, String> {
    match service::load_session(
        registry.inner(),
        remote_registry.inner().as_ref(),
        agent_id,
        session_id,
        vault_path,
    )
    .await
    {
        Ok(result) => Ok(ApiResult::ok(result)),
        Err(e) => Ok(map_err(e)),
    }
}

/// Request cooperative cancellation for a currently streaming ACP session.
#[tauri::command]
#[specta::specta]
pub fn agent_cancel_run(
    runs: State<'_, AgentRunController>,
    session_id: String,
) -> ApiResult<bool> {
    match service::cancel_run(runs.inner(), &session_id) {
        Ok(cancelled) => ApiResult::ok(cancelled),
        Err(e) => map_err(e),
    }
}

/// Background ACP start when Chat opens — loads models/context without a user prompt.
#[tauri::command]
#[specta::specta]
pub async fn agent_warm(
    window: tauri::WebviewWindow,
    registry: State<'_, AgentRegistry>,
    remote_registry: State<'_, Arc<dyn RemoteAgentHosts>>,
    warm_gate: State<'_, AgentWarmGate>,
    pool: State<'_, Arc<AgentWarmPool>>,
    request: WarmRequest,
) -> Result<ApiResult<WarmResult>, String> {
    let desc = match registry.resolve_default(request.agent_id.as_deref()) {
        Ok(d) => d,
        Err(e) => {
            return Ok(ApiResult::ok(WarmResult {
                agent_id: request.agent_id.unwrap_or_default(),
                ok: false,
                models: None,
                usage_used: None,
                usage_size: None,
                error: Some(e.to_string()),
            }));
        }
    };

    if let Some(error) = warm_gate.blocked(&desc.id) {
        return Ok(ApiResult::ok(WarmResult {
            agent_id: desc.id,
            ok: false,
            models: None,
            usage_used: None,
            usage_size: None,
            error: Some(error),
        }));
    }

    let remote = match remote_registry
        .resolve_target(request.vault_path.as_deref())
        .await
    {
        Ok(t) => t,
        Err(e) => {
            return Ok(ApiResult::ok(WarmResult {
                agent_id: desc.id,
                ok: false,
                models: None,
                usage_used: None,
                usage_size: None,
                error: Some(e.to_string()),
            }));
        }
    };

    let events = AgentEventEmitter::new(window.app_handle().clone(), window.label());
    let agent_id = desc.id.clone();
    let result = warm_agent(
        events,
        desc,
        request.vault_path,
        request.model_id,
        request.collaboration_mode_id,
        remote,
        pool.inner().clone(),
    )
    .await;
    if result.ok {
        warm_gate.clear(&agent_id);
    } else if result.error.as_deref()
        != Some(crate::features::agent::session::warm::WARM_CANCELLED_ERROR)
    {
        warm_gate.record_failure(
            &agent_id,
            result.error.as_deref().unwrap_or("agent warm failed"),
        );
    }
    Ok(ApiResult::ok(result))
}
