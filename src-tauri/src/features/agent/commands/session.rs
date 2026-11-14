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
    warm_agent, AgentEventEmitter, AgentQueryPool, AgentRegistry, AgentRunController,
    AgentWarmGate, AgentWarmPool, ElicitationGate, PermissionGate,
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
#[allow(clippy::too_many_arguments)]
pub async fn agent_list_sessions(
    registry: State<'_, AgentRegistry>,
    remote_registry: State<'_, Arc<dyn RemoteAgentHosts>>,
    warm_gate: State<'_, AgentWarmGate>,
    pool: State<'_, Arc<AgentWarmPool>>,
    queries: State<'_, Arc<AgentQueryPool>>,
    agent_id: Option<String>,
    vault_path: Option<String>,
    cursor: Option<String>,
) -> Result<ApiResult<crate::features::agent::models::AcpListSessionsResult>, String> {
    match service::list_sessions(
        registry.inner(),
        remote_registry.inner().as_ref(),
        warm_gate.inner(),
        pool.inner(),
        queries.inner(),
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

/// Remove one session from history.
///
/// Always hides the id from later `session/list` results. Sends ACP
/// `session/delete` only when the agent advertises that capability.
#[tauri::command]
#[specta::specta]
pub async fn agent_delete_session(
    registry: State<'_, AgentRegistry>,
    remote_registry: State<'_, Arc<dyn RemoteAgentHosts>>,
    pool: State<'_, Arc<AgentWarmPool>>,
    queries: State<'_, Arc<AgentQueryPool>>,
    agent_id: Option<String>,
    session_id: String,
    vault_path: Option<String>,
) -> Result<ApiResult<crate::features::agent::models::AcpDeleteSessionResult>, String> {
    match service::delete_session(
        registry.inner(),
        remote_registry.inner().as_ref(),
        pool.inner(),
        queries.inner(),
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

/// Load an ACP session's history via `session/load`.
#[tauri::command]
#[specta::specta]
pub async fn agent_load_session(
    registry: State<'_, AgentRegistry>,
    remote_registry: State<'_, Arc<dyn RemoteAgentHosts>>,
    queries: State<'_, Arc<AgentQueryPool>>,
    agent_id: Option<String>,
    session_id: String,
    vault_path: Option<String>,
) -> Result<ApiResult<crate::features::agent::models::AcpLoadSessionResult>, String> {
    match service::load_session(
        registry.inner(),
        remote_registry.inner().as_ref(),
        queries.inner(),
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

    // Built-in agents have nothing to spawn; publish their model catalog and
    // slash commands so the config bar / composer render without a run.
    if crate::features::agent::models::is_builtin_template(&desc.template) {
        let events = AgentEventEmitter::new(window.app_handle().clone(), window.label());
        crate::features::zhihu::emit_warm_events(&events, &desc.id, request.model_id.as_deref());
        let current = request
            .model_id
            .as_deref()
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .unwrap_or(crate::features::zhihu::ZHIHU_MODEL_ID);
        return Ok(ApiResult::ok(WarmResult {
            agent_id: desc.id.clone(),
            ok: true,
            models: Some(crate::features::zhihu::models_event(
                &desc.id, "warm", current,
            )),
            usage_used: None,
            usage_size: None,
            error: None,
        }));
    }

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
        crate::features::agent::session::config::RunPreferences {
            model_id: request.model_id,
            force_model: request.force_model,
            collaboration_mode_id: request.collaboration_mode_id,
            ..Default::default()
        },
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
