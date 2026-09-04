use crate::core::error::{map_err, ApiResult, AppError};
use crate::features::agent::ask_user::AskUserAnswer;
use crate::features::agent::models::{
    AgentDescriptor, AgentListResponse, AgentSkill, CatalogScanResponse, ProbeResult,
    RunOnceAccepted, RunOnceRequest, UpsertAgentRequest, WarmRequest, WarmResult,
};
use crate::features::agent::runtime::gates::ElicitationAnswer;
use crate::features::agent::{
    list_agent_skills, new_ids, probe_agent, run_once, warm_agent, AgentEventEmitter,
    AgentRegistry, AgentRunController, AgentWarmGate, AskUserGate, ElicitationGate, PermissionGate,
    PermissionPolicy, RunOnceParams,
};
use crate::integration::remote::{
    materialize_skills_to_work, resolve_remote_target, RemoteRegistry,
};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOnly {
    pub agent: AgentDescriptor,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnabledResponse {
    pub enabled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUserAgentResponse {
    pub user_agent: String,
    pub user_agent_provider_ids: String,
}

fn list_from_state(state: crate::features::agent::models::AgentRegistryState) -> AgentListResponse {
    AgentListResponse {
        agents: state.agents,
        default_id: state.default_id,
        enabled: state.enabled,
    }
}

/// Mounted Agent panels cache their agent list; notify every window after a
/// registry mutation (probe / install / upsert / remove / default) so they
/// refresh without a remount.
fn emit_registry_changed(app: &AppHandle) {
    let _ = app.emit("agent:registry-changed", serde_json::json!({}));
}

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

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionResponseRequest {
    pub request_id: String,
    /// Chosen option id; `None` cancels the request.
    #[serde(default)]
    pub option_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionResponded {
    pub resolved: bool,
}

/// Answer a pending ACP permission request (ask mode). `option_id = None` cancels.
#[tauri::command]
pub fn agent_respond_permission(
    gate: State<'_, PermissionGate>,
    request: PermissionResponseRequest,
) -> ApiResult<PermissionResponded> {
    let resolved = gate.resolve(&request.request_id, request.option_id);
    ApiResult::ok(PermissionResponded { resolved })
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElicitationResponseRequest {
    pub request_id: String,
    /// accept | decline | cancel
    pub action: String,
    /// Field id → string value (accept only).
    #[serde(default)]
    pub content: Option<std::collections::BTreeMap<String, String>>,
}

/// Answer a pending ACP form elicitation (`elicitation/create`).
#[tauri::command]
pub fn agent_respond_elicitation(
    gate: State<'_, ElicitationGate>,
    request: ElicitationResponseRequest,
) -> ApiResult<PermissionResponded> {
    let answer = match request.action.as_str() {
        "accept" => ElicitationAnswer::Accept(request.content.unwrap_or_default()),
        "decline" => ElicitationAnswer::Decline,
        _ => ElicitationAnswer::Cancel,
    };
    let resolved = gate.resolve(&request.request_id, answer);
    ApiResult::ok(PermissionResponded { resolved })
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskUserResponseRequest {
    pub request_id: String,
    /// accept | cancel
    pub action: String,
    /// Parallel answer strings (multi-select joined with ", ").
    #[serde(default)]
    pub answers: Option<Vec<String>>,
}

/// Answer a pending Grok `_x.ai/ask_user_question` extension request.
#[tauri::command]
pub fn agent_respond_ask_user(
    gate: State<'_, AskUserGate>,
    request: AskUserResponseRequest,
) -> ApiResult<PermissionResponded> {
    let answer = match request.action.as_str() {
        "accept" => AskUserAnswer::Accepted {
            answers: request.answers.unwrap_or_default(),
        },
        _ => AskUserAnswer::Cancelled,
    };
    let resolved = gate.resolve(&request.request_id, answer);
    ApiResult::ok(PermissionResponded { resolved })
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
