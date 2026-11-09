//! Service facade for the Agent feature.
//!
//! Shared by the thin `commands` shells (Tauri IPC) and the desktop bridge
//! RPC (`integration::bridge::host`), so the bridge consumes service-level
//! APIs instead of command shells. Command paths stay
//! `features::agent::commands::*` for `app/handlers.rs`.

use crate::core::error::AppError;
use crate::core::log_util::{trunc, OpTimer};
use crate::features::agent::acp::client::agent_spawn_cwd;
use crate::features::agent::models::{
    AcpDeleteSessionResult, AcpListSessionsResult, AcpLoadSessionResult, AgentListResponse,
    AgentOnly, AgentRegistryState, AgentStatusEvent, AskUserResponseRequest, CatalogScanResponse,
    ElicitationResponseRequest, PermissionResponded, PermissionResponseRequest, ProbeResult,
    RunOnceAccepted, RunOnceRequest,
};
use crate::features::agent::remote_host::RemoteAgentHosts;
use crate::features::agent::runtime::gates::{
    AskUserAnswer, AskUserGate, ElicitationAnswer, ElicitationGate, PermissionGate,
};
use crate::features::agent::{
    delete_acp_session, list_acp_sessions, load_acp_session, new_ids, probe_agent, run_once,
    AgentEventEmitter, AgentRegistry, AgentRunController, AgentWarmGate, AgentWarmPool,
    PermissionPolicy, RunOnceParams,
};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

pub fn list_from_state(state: AgentRegistryState) -> AgentListResponse {
    AgentListResponse {
        agents: state.agents,
        default_id: state.default_id,
        enabled: state.enabled,
    }
}

/// Mounted Agent panels cache their agent list; notify every window after a
/// registry mutation (probe / install / upsert / remove / default) so they
/// refresh without a remount.
pub fn emit_registry_changed(app: &AppHandle) {
    let _ = app.emit("agent:registry-changed", serde_json::json!({}));
}

/// Service for `agent_list_agents`.
pub fn list_agents(registry: &AgentRegistry) -> Result<AgentListResponse, AppError> {
    registry.snapshot().map(list_from_state)
}

/// Service for `agent_scan_catalog`.
pub fn scan_catalog(registry: &AgentRegistry) -> Result<CatalogScanResponse, AppError> {
    registry.scan_catalog()
}

/// Service for `agent_ensure_catalog`.
pub fn ensure_catalog(
    app: &AppHandle,
    registry: &AgentRegistry,
    template_id: &str,
    set_default: bool,
) -> Result<AgentOnly, AppError> {
    let agent = registry.ensure_catalog_agent(template_id, set_default)?;
    emit_registry_changed(app);
    Ok(AgentOnly { agent })
}

/// Service for `agent_probe_catalog`: ensure the catalog agent is registered,
/// then run the ACP initialize probe.
pub async fn probe_catalog(
    app: &AppHandle,
    registry: &AgentRegistry,
    template_id: &str,
) -> Result<ProbeResult, AppError> {
    let desc = registry.ensure_catalog_agent(template_id, false)?;
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
        emit_registry_changed(app);
        return Ok(result);
    }
    let result = probe_agent(&desc, None).await;
    let _ = registry.apply_probe_result(&desc.id, &result);
    emit_registry_changed(app);
    Ok(result)
}

/// Service for `agent_cancel_run`.
pub fn cancel_run(runs: &AgentRunController, session_id: &str) -> Result<bool, AppError> {
    runs.cancel(session_id)?;
    Ok(true)
}

/// Service for `agent_respond_permission`.
pub fn respond_permission(
    gate: &PermissionGate,
    request: PermissionResponseRequest,
) -> PermissionResponded {
    let resolved = gate.resolve(&request.request_id, request.option_id);
    PermissionResponded { resolved }
}

/// Service for `agent_respond_elicitation`.
pub fn respond_elicitation(
    gate: &ElicitationGate,
    request: ElicitationResponseRequest,
) -> PermissionResponded {
    let answer = match request.action.as_str() {
        "accept" => ElicitationAnswer::Accept(request.content.unwrap_or_default()),
        "decline" => ElicitationAnswer::Decline,
        _ => ElicitationAnswer::Cancel,
    };
    let resolved = gate.resolve(&request.request_id, answer);
    PermissionResponded { resolved }
}

/// Service for `agent_respond_ask_user`.
pub fn respond_ask_user(
    gate: &AskUserGate,
    request: AskUserResponseRequest,
) -> PermissionResponded {
    let answer = match request.action.as_str() {
        "accept" => AskUserAnswer::Accepted {
            answers: request.answers.unwrap_or_default(),
        },
        _ => AskUserAnswer::Cancelled,
    };
    let resolved = gate.resolve(&request.request_id, answer);
    PermissionResponded { resolved }
}

/// Service for `agent_run_once`: validate, register the run, then spawn the
/// streaming turn in the background and return the accepted ids.
#[allow(clippy::too_many_arguments)]
pub async fn accept_run_once(
    window: &tauri::WebviewWindow,
    registry: &AgentRegistry,
    runs: &AgentRunController,
    gate: &PermissionGate,
    elicitation_gate: &ElicitationGate,
    ask_user_gate: &AskUserGate,
    remote_hosts: &dyn RemoteAgentHosts,
    request: RunOnceRequest,
) -> Result<RunOnceAccepted, AppError> {
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
        return Err(err);
    }

    let desc = match registry.resolve_default(request.agent_id.as_deref()) {
        Ok(d) => d,
        Err(e) => {
            op.finish_err(&e);
            return Err(e);
        }
    };

    // Built-in agents are Host-internal (no external ACP process, no remote
    // host). Skip remote resolution entirely so a local-only agent never fails
    // on a remote-vault target.
    let builtin = crate::features::agent::models::is_builtin_template(&desc.template);
    let remote_target_early = if builtin {
        None
    } else {
        match remote_hosts
            .resolve_target(request.vault_path.as_deref())
            .await
        {
            Ok(t) => t,
            Err(e) => {
                op.finish_err(&e);
                return Err(e);
            }
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
            return Err(error);
        }
    };

    let app_handle = window.app_handle().clone();
    let events = AgentEventEmitter::new(app_handle.clone(), window.label());
    // `starting` lands before the accepted ids return, so the webview can paint
    // a loading state for the placeholder line at t=0 (before any stream event).
    let _ = events.emit(
        "agent:status",
        AgentStatusEvent::starting(session_id.as_str()),
    );
    // Built-in agents bypass the ACP spawn/stream chain entirely: the Host
    // runs them itself and emits the same `agent:*` events the panel consumes.
    if builtin {
        let app_handle = window.app_handle().clone();
        let secret = window
            .app_handle()
            .state::<crate::features::system::settings::AppSettingsStore>()
            .zhihu_access_secret();
        let log_session_id = session_id.clone();
        let log_agent_id = desc.id.clone();
        let finish_id = session_id.clone();
        let session_for_log = log_session_id.clone();
        let agent_for_log = log_agent_id.clone();
        tauri::async_runtime::spawn(async move {
            crate::features::zhihu::run_once(crate::features::zhihu::ZhihuRunOnce {
                app: events,
                session_id,
                message_id,
                agent_id: desc.id,
                prompt: request.prompt,
                resume_session_id: request.session_id,
                model_id: request.model_id,
                secret,
                cancellation,
            })
            .await;
            let _ = app_handle.state::<AgentRunController>().finish(&finish_id);
            log::info!(
                target: "agentero::op",
                "op end agent_run_session session_id={} agent_id={}",
                trunc(&session_for_log, 48),
                trunc(&agent_for_log, 48)
            );
        });
        op.finish_ok_extra(format!(
            "session_id={} agent_id={} accepted=true builtin=true",
            trunc(&log_session_id, 48),
            trunc(&log_agent_id, 48)
        ));
        return Ok(accepted);
    }

    let permission_gate = gate.clone();
    let elicitation_gate = elicitation_gate.clone();
    let ask_user_gate = ask_user_gate.clone();
    // Pooled warm connections live in managed state so run_once can skip the
    // spawn → initialize → session/new cold chain when a healthy slot matches.
    let warm_pool = Arc::clone(window.app_handle().state::<Arc<AgentWarmPool>>().inner());
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
    let attach_delegate =
        remote_for_spawn.is_none() && request.workflow.as_deref() != Some("translate");
    let delegate_mcp = if attach_delegate {
        window
            .app_handle()
            .try_state::<Arc<crate::features::agent::delegate::DelegateBridge>>()
            .and_then(|bridge| bridge.mcp_server(&session_id, window.label()))
            .into_iter()
            .collect()
    } else {
        Vec::new()
    };
    let delegate_hint = if attach_delegate {
        local_delegate_hint(remote_hosts, registry).await
    } else {
        None
    };
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
            prefer_highest_reasoning_effort: request.prefer_highest_reasoning_effort,
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
            warm_pool: Some(warm_pool),
            context: request.context,
            resume_transcript: request.resume_transcript,
            delegate_mcp,
            delegate_hint,
            suppress_transcript: false,
            permission_host: None,
            progress: None,
            user_wait: None,
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
    Ok(accepted)
}

/// Service for `agent_list_sessions`: list ACP sessions via `session/list`.
pub async fn list_sessions(
    registry: &AgentRegistry,
    remote_hosts: &dyn RemoteAgentHosts,
    warm_gate: &AgentWarmGate,
    pool: &AgentWarmPool,
    agent_id: Option<String>,
    vault_path: Option<String>,
    cursor: Option<String>,
) -> Result<AcpListSessionsResult, AppError> {
    let op = OpTimer::start_with(
        "agent_list_sessions",
        format!("agent_id={}", agent_id.as_deref().unwrap_or("default")),
    );
    let desc = match registry.resolve_default(agent_id.as_deref()) {
        Ok(desc) => desc,
        Err(error) => {
            op.finish_err(&error);
            return Err(error);
        }
    };
    // Built-in agents keep no server-side session list.
    if crate::features::agent::models::is_builtin_template(&desc.template) {
        op.finish_ok_extra(format!("agent_id={} builtin=true sessions=0", desc.id));
        return Ok(AcpListSessionsResult {
            sessions: Vec::new(),
            next_cursor: None,
            supported: false,
        });
    }
    if let Some(error) = warm_gate.blocked(&desc.id) {
        let error = AppError::message(error);
        op.finish_err(&error);
        return Err(error);
    }
    let remote_target = match remote_hosts.resolve_target(vault_path.as_deref()).await {
        Ok(t) => t,
        Err(e) => {
            op.finish_err(&e);
            return Err(e);
        }
    };
    let cwd = match agent_spawn_cwd(remote_target.as_deref(), vault_path.as_deref()) {
        Ok(cwd) => cwd,
        Err(error) => {
            op.finish_err(&error);
            return Err(error);
        }
    };
    match list_acp_sessions(&desc, cwd, cursor, remote_target.as_deref()).await {
        Ok(mut result) => {
            let hidden = pool.unprompted_ids();
            let dismissed = pool.dismissed_ids();
            if !hidden.is_empty() || !dismissed.is_empty() {
                result.sessions.retain(|session| {
                    !hidden.contains(&session.session_id)
                        && !dismissed.contains(&session.session_id)
                });
            }
            warm_gate.clear(&desc.id);
            op.finish_ok_extra(format!(
                "agent_id={} supported={} sessions={} truncated={}",
                trunc(&desc.id, 48),
                result.supported,
                result.sessions.len(),
                result.next_cursor.is_some()
            ));
            Ok(result)
        }
        Err(error) => {
            warm_gate.record_failure(&desc.id, &error.to_string());
            op.finish_err(&error);
            Err(error)
        }
    }
}

/// Service for `agent_load_session`: load an ACP session's history via
/// `session/load`.
pub async fn load_session(
    registry: &AgentRegistry,
    remote_hosts: &dyn RemoteAgentHosts,
    agent_id: Option<String>,
    session_id: String,
    vault_path: Option<String>,
) -> Result<AcpLoadSessionResult, AppError> {
    let desc = registry.resolve_default(agent_id.as_deref())?;
    // Built-in agents have no ACP history to replay.
    if crate::features::agent::models::is_builtin_template(&desc.template) {
        return Ok(AcpLoadSessionResult {
            session_id,
            title: None,
            lines: Vec::new(),
        });
    }
    let remote_target = remote_hosts.resolve_target(vault_path.as_deref()).await?;
    let cwd = agent_spawn_cwd(remote_target.as_deref(), vault_path.as_deref())?;
    load_acp_session(&desc, session_id, cwd, remote_target.as_deref()).await
}

/// Service for `agent_delete_session`.
///
/// The id is recorded locally before any ACP call, so a later `session/list`
/// hides it even when the agent has no `session/delete` or the RPC fails.
/// An idle warm slot bound to this id is dropped so the next turn does not
/// continue a conversation the user just removed.
pub async fn delete_session(
    registry: &AgentRegistry,
    remote_hosts: &dyn RemoteAgentHosts,
    pool: &AgentWarmPool,
    agent_id: Option<String>,
    session_id: String,
    vault_path: Option<String>,
) -> Result<AcpDeleteSessionResult, AppError> {
    let session_id = session_id.trim().to_string();
    if session_id.is_empty() {
        return Err(AppError::message("session id is required"));
    }
    let desc = registry.resolve_default(agent_id.as_deref())?;
    pool.dismiss_session(&session_id);
    pool.drop_session(&desc.id, &session_id);

    if crate::features::agent::models::is_builtin_template(&desc.template) {
        return Ok(AcpDeleteSessionResult {
            session_id,
            deleted_on_agent: false,
            agent_error: None,
        });
    }

    let remote_target = remote_hosts.resolve_target(vault_path.as_deref()).await?;
    let cwd = agent_spawn_cwd(remote_target.as_deref(), vault_path.as_deref())?;
    match delete_acp_session(&desc, &session_id, cwd, remote_target.as_deref()).await {
        Ok(true) => Ok(AcpDeleteSessionResult {
            session_id,
            deleted_on_agent: true,
            agent_error: None,
        }),
        Ok(false) => Ok(AcpDeleteSessionResult {
            session_id,
            deleted_on_agent: false,
            agent_error: None,
        }),
        Err(error) => Ok(AcpDeleteSessionResult {
            session_id,
            deleted_on_agent: false,
            agent_error: Some(error.to_string()),
        }),
    }
}

async fn local_delegate_hint(
    hosts: &dyn RemoteAgentHosts,
    registry: &AgentRegistry,
) -> Option<String> {
    use crate::features::agent::delegate::policy::{self, AgentChoice, TargetChoice};
    use crate::features::agent::models::is_builtin_template;

    let listed = hosts.list_targets().await.ok()?;
    let targets = listed
        .into_iter()
        .map(|target| TargetChoice {
            handle: format!("remote:{}", target.session_id),
            session_id: target.session_id,
            destination: target.destination,
            remote_path: target.remote_path,
            local_sim: target.local_sim,
        })
        .collect::<Vec<_>>();
    let state = registry.snapshot().ok()?;
    let mut agents = state
        .agents
        .into_iter()
        .filter(|agent| !is_builtin_template(&agent.template) && !agent.command.trim().is_empty())
        .map(|agent| AgentChoice {
            id: agent.id,
            name: agent.name,
        })
        .collect::<Vec<_>>();
    agents.sort_by(|left, right| left.id.cmp(&right.id));
    policy::delegate_hint(&targets, &agents)
}
