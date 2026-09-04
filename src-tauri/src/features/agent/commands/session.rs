//! Session run / list / load / warm / cancel Tauri commands.

use crate::core::error::{map_err, ApiResult, AppError};
use crate::features::agent::models::{
    RunOnceAccepted, RunOnceRequest, WarmRequest, WarmResult,
};
use crate::features::agent::runtime::gates::AskUserGate;
use crate::features::agent::{
    new_ids, run_once, warm_agent, AgentEventEmitter, AgentRegistry, AgentRunController,
    AgentWarmGate, ElicitationGate, PermissionGate, PermissionPolicy, RunOnceParams,
};
use crate::integration::remote::{resolve_remote_target, RemoteRegistry};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Manager, State};

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_run_once(
    window: tauri::WebviewWindow,
    registry: State<'_, AgentRegistry>,
    runs: State<'_, AgentRunController>,
    gate: State<'_, PermissionGate>,
    elicitation_gate: State<'_, ElicitationGate>,
    ask_user_gate: State<'_, AskUserGate>,
    remote_registry: State<'_, Arc<RemoteRegistry>>,
    request: RunOnceRequest,
) -> Result<ApiResult<RunOnceAccepted>, String> {
    use crate::core::log_util::{trunc, OpTimer};

    let op = OpTimer::start_with(
        "agent_run_once",
        format!(
            "agent_id={} prompt_len={} images={}",
            request.agent_id.as_deref().unwrap_or("default"),
            request.prompt.chars().count(),
            request.images.len()
        ),
    );
    if request.prompt.trim().is_empty() && request.images.is_empty() {
        let err = AppError::message("prompt or images are required");
        op.finish_err(&err);
        return Ok(map_err(err));
    }

    let desc = match registry.resolve_default(request.agent_id.as_deref()) {
        Ok(d) => d,
        Err(e) => {
            op.finish_err(&e);
            return Ok(map_err(e));
        }
    };

    let remote_target_early =
        match resolve_remote_target(remote_registry.inner(), request.vault_path.as_deref()).await {
            Ok(t) => t,
            Err(e) => {
                op.finish_err(&e);
                return Ok(map_err(e));
            }
        };
    let (session_id, message_id) = new_ids();
    let accepted = RunOnceAccepted {
        session_id: session_id.clone(),
        message_id: message_id.clone(),
        agent_id: desc.id.clone(),
    };

    let cancellation = match runs.register(&session_id) {
        Ok(cancellation) => cancellation,
        Err(error) => {
            op.finish_err(&error);
            return Ok(map_err(error));
        }
    };

    let app_handle = window.app_handle().clone();
    let events = AgentEventEmitter::new(app_handle.clone(), window.label());
    let permission_gate = gate.inner().clone();
    let elicitation_gate = elicitation_gate.inner().clone();
    let ask_user_gate = ask_user_gate.inner().clone();
    let permission_policy = match request.permission_mode.as_deref() {
        Some("auto") => PermissionPolicy::Auto,
        Some("ask") => PermissionPolicy::Ask,
        // Back-compat: older clients only send `auto_approve`.
        _ if request.auto_approve => PermissionPolicy::Auto,
        _ => PermissionPolicy::Restricted,
    };
    let log_session_id = session_id.clone();
    let log_agent_id = desc.id.clone();
    let session_agent_id = log_agent_id.clone();
    let remote_for_spawn = remote_target_early;
    tauri::async_runtime::spawn(async move {
        let run_result = run_once(RunOnceParams {
            app: events.clone(),
            desc,
            session_id: session_id.clone(),
            message_id,
            prompt: request.prompt,
            is_acp_command: request.is_acp_command,
            images: request.images,
            workflow: request.workflow,
            target: request.target.clone(),
            vault_path: request.vault_path,
            preferred_model_id: request.model_id,
            preferred_collaboration_mode_id: request.collaboration_mode_id,
            preferred_reasoning_effort: request.reasoning_effort,
            fast_mode: request.fast_mode,
            skill_ids: request.skill_ids,
            permission_policy,
            permission_gate: permission_gate.clone(),
            elicitation_gate: elicitation_gate.clone(),
            ask_user_gate: ask_user_gate.clone(),
            response_language: request.response_language,
            personal_prompt: request.personal_prompt,
            cancellation,
            remote: remote_for_spawn,
            resume_session_id: request.session_id.clone(),
        })
        .await;
        if run_result.is_ok() {
            app_handle.state::<AgentWarmGate>().clear(&session_agent_id);
        }
        let _ = app_handle.state::<AgentRunController>().finish(&session_id);
        log::info!(
            target: "agentero::op",
            "op end agent_run_session session_id={} agent_id={}",
            trunc(&session_id, 48),
            trunc(&session_agent_id, 48)
        );
    });

    op.finish_ok_extra(format!(
        "session_id={} agent_id={} accepted=true",
        trunc(&log_session_id, 48),
        trunc(&log_agent_id, 48)
    ));
    Ok(ApiResult::ok(accepted))
}

/// List ACP sessions for an agent via `session/list`.
#[tauri::command]
pub async fn agent_list_sessions(
    registry: State<'_, AgentRegistry>,
    remote_registry: State<'_, Arc<RemoteRegistry>>,
    warm_gate: State<'_, AgentWarmGate>,
    agent_id: Option<String>,
    vault_path: Option<String>,
    cursor: Option<String>,
) -> Result<ApiResult<crate::features::agent::models::AcpListSessionsResult>, String> {
    use crate::core::log_util::{trunc, OpTimer};

    let op = OpTimer::start_with(
        "agent_list_sessions",
        format!("agent_id={}", agent_id.as_deref().unwrap_or("default")),
    );
    let desc = match registry.resolve_default(agent_id.as_deref()) {
        Ok(desc) => desc,
        Err(error) => {
            op.finish_err(&error);
            return Ok(map_err(error));
        }
    };
    if let Some(error) = warm_gate.blocked(&desc.id) {
        let error = AppError::message(error);
        op.finish_err(&error);
        return Ok(map_err(error));
    }
    let remote_target =
        match resolve_remote_target(remote_registry.inner(), vault_path.as_deref()).await {
            Ok(t) => t,
            Err(e) => {
                op.finish_err(&e);
                return Ok(map_err(e));
            }
        };
    let cwd = if let Some(ref rt) = remote_target {
        rt.agent_cwd()
    } else {
        vault_path
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    };
    match crate::features::agent::list_acp_sessions(&desc, cwd, cursor, remote_target.as_ref())
        .await
    {
        Ok(result) => {
            warm_gate.clear(&desc.id);
            op.finish_ok_extra(format!(
                "agent_id={} supported={} sessions={} truncated={}",
                trunc(&desc.id, 48),
                result.supported,
                result.sessions.len(),
                result.next_cursor.is_some()
            ));
            Ok(ApiResult::ok(result))
        }
        Err(error) => {
            warm_gate.record_failure(&desc.id, &error.to_string());
            op.finish_err(&error);
            Ok(map_err(error))
        }
    }
}

/// Load an ACP session's history via `session/load`.
#[tauri::command]
pub async fn agent_load_session(
    registry: State<'_, AgentRegistry>,
    remote_registry: State<'_, Arc<RemoteRegistry>>,
    agent_id: Option<String>,
    session_id: String,
    vault_path: Option<String>,
) -> Result<ApiResult<crate::features::agent::models::AcpLoadSessionResult>, String> {
    let desc = match registry.resolve_default(agent_id.as_deref()) {
        Ok(desc) => desc,
        Err(error) => return Ok(map_err(error)),
    };
    let remote_target =
        match resolve_remote_target(remote_registry.inner(), vault_path.as_deref()).await {
            Ok(t) => t,
            Err(e) => return Ok(map_err(e)),
        };
    let cwd = if let Some(ref rt) = remote_target {
        rt.agent_cwd()
    } else {
        vault_path
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    };
    match crate::features::agent::load_acp_session(&desc, session_id, cwd, remote_target.as_ref())
        .await
    {
        Ok(result) => Ok(ApiResult::ok(result)),
        Err(error) => Ok(map_err(error)),
    }
}

/// Request cooperative cancellation for a currently streaming ACP session.
#[tauri::command]
pub fn agent_cancel_run(
    runs: State<'_, AgentRunController>,
    session_id: String,
) -> ApiResult<bool> {
    match runs.cancel(&session_id) {
        Ok(()) => ApiResult::ok(true),
        Err(e) => map_err(e),
    }
}


/// Background ACP start when Chat opens — loads models/context without a user prompt.
#[tauri::command]
pub async fn agent_warm(
    window: tauri::WebviewWindow,
    registry: State<'_, AgentRegistry>,
    remote_registry: State<'_, Arc<RemoteRegistry>>,
    warm_gate: State<'_, AgentWarmGate>,
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

    let remote =
        match resolve_remote_target(remote_registry.inner(), request.vault_path.as_deref()).await {
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
    )
    .await;
    if result.ok {
        warm_gate.clear(&agent_id);
    } else {
        warm_gate.record_failure(
            &agent_id,
            result.error.as_deref().unwrap_or("agent warm failed"),
        );
    }
    Ok(ApiResult::ok(result))
}
