use crate::error::AppError;
use crate::models::agent::{
    AgentDescriptor, AgentListResponse, AgentSkill, AgentTemplateInfo, CatalogScanResponse,
    ProbeResult, RunOnceAccepted, RunOnceRequest, UpsertAgentRequest, WarmRequest, WarmResult,
};
use crate::services::agent::templates::template_info;
use crate::services::agent::{
    builtin_templates, list_agent_skills, new_ids, probe_agent, run_once, warm_agent,
    AgentEventEmitter, AgentRegistry, AgentRunController, PermissionGate, PermissionPolicy,
};
use crate::services::remote::{
    materialize_skills_to_work, notes_rel_from_target, read_remote_note, resolve_remote_target,
    RemoteRegistry,
};
use crate::services::terminal;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Manager, State};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOnly {
    pub agent: AgentDescriptor,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplatesResponse {
    pub templates: Vec<AgentTemplateInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnabledResponse {
    pub enabled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProxyResponse {
    pub proxy_enabled: bool,
    pub proxy_url: String,
}

fn list_from_state(state: crate::models::agent::AgentRegistryState) -> AgentListResponse {
    AgentListResponse {
        agents: state.agents,
        default_id: state.default_id,
        enabled: state.enabled,
    }
}

#[tauri::command]
pub fn agent_list_agents(
    registry: State<'_, AgentRegistry>,
) -> Result<AgentListResponse, AppError> {
    registry.snapshot().map(list_from_state)
}

#[tauri::command]
pub fn agent_list_templates() -> Result<TemplatesResponse, AppError> {
    Ok(TemplatesResponse {
        templates: builtin_templates(),
    })
}

#[tauri::command]
pub async fn agent_list_skills(
    remote_registry: State<'_, Arc<RemoteRegistry>>,
    vault_path: Option<String>,
) -> Result<Vec<AgentSkill>, AppError> {
    let remote_target =
        resolve_remote_target(remote_registry.inner(), vault_path.as_deref()).await?;
    if let Some(remote) = remote_target {
        crate::services::remote::ensure_remote_vault_skills(&remote.session).await?;
        materialize_skills_to_work(&remote.session).await?;
        let work_root = remote.work_root.to_string_lossy().to_string();
        return Ok(list_agent_skills(Some(&work_root)));
    }
    Ok(list_agent_skills(vault_path.as_deref()))
}

#[tauri::command]
pub fn agent_scan_catalog(
    registry: State<'_, AgentRegistry>,
) -> Result<CatalogScanResponse, AppError> {
    registry.scan_catalog()
}

#[tauri::command]
pub fn agent_upsert_agent(
    registry: State<'_, AgentRegistry>,
    request: UpsertAgentRequest,
) -> Result<AgentOnly, AppError> {
    registry.upsert(request).map(|agent| AgentOnly { agent })
}

#[tauri::command]
pub fn agent_ensure_catalog(
    registry: State<'_, AgentRegistry>,
    template_id: String,
    set_default: bool,
) -> Result<AgentOnly, AppError> {
    registry
        .ensure_catalog_agent(&template_id, set_default)
        .map(|agent| AgentOnly { agent })
}

#[tauri::command]
pub fn agent_remove_agent(registry: State<'_, AgentRegistry>, id: String) -> Result<(), AppError> {
    registry.remove(&id)
}

#[tauri::command]
pub fn agent_set_default(
    registry: State<'_, AgentRegistry>,
    id: Option<String>,
) -> Result<AgentListResponse, AppError> {
    registry.set_default(id).map(list_from_state)
}

#[tauri::command]
pub fn agent_set_enabled(
    registry: State<'_, AgentRegistry>,
    enabled: bool,
) -> Result<EnabledResponse, AppError> {
    registry
        .set_enabled(enabled)
        .map(|s| EnabledResponse { enabled: s.enabled })
}

#[tauri::command]
pub fn agent_set_proxy(
    registry: State<'_, AgentRegistry>,
    proxy_enabled: bool,
    proxy_url: String,
) -> Result<AgentProxyResponse, AppError> {
    registry
        .set_proxy(proxy_enabled, proxy_url)
        .map(|s| AgentProxyResponse {
            proxy_enabled: s.proxy_enabled,
            proxy_url: s.proxy_url,
        })
}

#[tauri::command]
pub fn agent_discover(
    registry: State<'_, AgentRegistry>,
    id: Option<String>,
) -> Result<AgentListResponse, AppError> {
    registry.discover(id.as_deref())?;
    registry.snapshot().map(list_from_state)
}

#[tauri::command]
pub async fn agent_probe(
    registry: State<'_, AgentRegistry>,
    id: String,
) -> Result<ProbeResult, AppError> {
    let desc = registry.get(&id)?;
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
        return Ok(result);
    }
    let result = probe_agent(&desc, None).await;
    let _ = registry.apply_probe_result(&id, &result);
    Ok(result)
}

/// Open a system terminal that shows the template's install command and waits for
/// the user to press Enter before running it. Only templates with a registered
/// `install_command` are allowed (no free-form shell from the UI).
#[tauri::command]
pub fn agent_open_install_terminal(template_id: String) -> Result<(), AppError> {
    let info = template_info(&template_id)
        .ok_or_else(|| AppError::invalid(format!("unknown catalog template: {template_id}")))?;
    let command = match info.install_command {
        Some(c) if !c.trim().is_empty() => c,
        _ => {
            return Err(AppError::invalid(format!(
                "no install command for template: {template_id}"
            )));
        }
    };
    terminal::open_terminal_confirm_command(&command)
}

/// Ensure catalog agent is registered, then run ACP initialize probe.
#[tauri::command]
pub async fn agent_probe_catalog(
    registry: State<'_, AgentRegistry>,
    template_id: String,
) -> Result<ProbeResult, AppError> {
    let desc = registry.ensure_catalog_agent(&template_id, false)?;
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
        return Ok(result);
    }
    let result = probe_agent(&desc, None).await;
    let _ = registry.apply_probe_result(&desc.id, &result);
    Ok(result)
}

#[tauri::command]
pub async fn agent_run_once(
    window: tauri::WebviewWindow,
    registry: State<'_, AgentRegistry>,
    runs: State<'_, AgentRunController>,
    gate: State<'_, PermissionGate>,
    remote_registry: State<'_, Arc<RemoteRegistry>>,
    request: RunOnceRequest,
) -> Result<RunOnceAccepted, AppError> {
    use crate::log_util::{trunc, OpTimer};

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
        let err = AppError::invalid("prompt or images are required");
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

    let remote_target_early =
        match resolve_remote_target(remote_registry.inner(), request.vault_path.as_deref()).await {
            Ok(t) => t,
            Err(e) => {
                op.finish_err(&e);
                return Err(e);
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
    let permission_gate = gate.inner().clone();
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
    // Trust loop: snapshot the target note before the run so we can offer a
    // keep / revert review if the agent rewrites it.
    let remote_target = remote_target_early;
    let remote_for_spawn = remote_target.clone();
    let snapshot_path = if remote_target.is_some() {
        None
    } else {
        request
            .vault_path
            .as_deref()
            .zip(request.target.as_deref())
            .and_then(|(v, t)| snapshot_notes_path(v, t))
    };
    let notes_before = snapshot_path.as_ref().and_then(|p| read_note_snapshot(p));
    let remote_notes_rel = request
        .target
        .as_deref()
        .filter(|_| remote_target.is_some())
        .map(notes_rel_from_target);
    let notes_before_remote =
        if let (Some(rt), Some(rel)) = (remote_target.as_ref(), remote_notes_rel.as_ref()) {
            read_remote_note(&rt.session, rel).await.ok().flatten()
        } else {
            None
        };
    tauri::async_runtime::spawn(async move {
        let _ = run_once(
            events.clone(),
            desc,
            session_id.clone(),
            message_id,
            request.prompt,
            request.images,
            request.workflow,
            request.target.clone(),
            request.vault_path,
            request.model_id,
            request.reasoning_effort,
            request.fast_mode,
            request.skill_ids,
            permission_policy,
            permission_gate.clone(),
            request.response_language,
            request.personal_prompt,
            cancellation,
            remote_for_spawn,
            request.session_id.clone(),
        )
        .await;
        let _ = app_handle.state::<AgentRunController>().finish(&session_id);
        // Trust loop: if the run rewrote the target note, offer keep / revert.
        if let (Some(path), Some(before)) = (&snapshot_path, &notes_before) {
            if let Some(after) = read_note_snapshot(path) {
                if &after != before {
                    let _ = events.emit(
                        "agent:notes-review",
                        NotesReviewEvent {
                            path: path.to_string_lossy().to_string(),
                            before: before.clone(),
                            after,
                        },
                    );
                }
            }
        } else if let (Some(rt), Some(rel), Some(before)) = (
            remote_target.as_ref(),
            remote_notes_rel.as_ref(),
            notes_before_remote.as_ref(),
        ) {
            if let Ok(Some(after)) = read_remote_note(&rt.session, rel).await {
                if &after != before {
                    let _ = events.emit(
                        "agent:notes-review",
                        NotesReviewEvent {
                            path: rel.clone(),
                            before: before.clone(),
                            after,
                        },
                    );
                }
            }
        }
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

/// List ACP sessions for an agent via `session/list`.
#[tauri::command]
pub async fn agent_list_sessions(
    registry: State<'_, AgentRegistry>,
    remote_registry: State<'_, Arc<RemoteRegistry>>,
    agent_id: Option<String>,
    vault_path: Option<String>,
    cursor: Option<String>,
) -> Result<crate::models::agent::AcpListSessionsResult, AppError> {
    let desc = registry.resolve_default(agent_id.as_deref())?;
    let remote_target =
        resolve_remote_target(remote_registry.inner(), vault_path.as_deref()).await?;
    let cwd = if let Some(ref rt) = remote_target {
        rt.agent_cwd()
    } else {
        vault_path
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    };
    crate::services::agent::list_acp_sessions(&desc, cwd, cursor, remote_target.as_ref()).await
}

/// Load an ACP session's history via `session/load`.
#[tauri::command]
pub async fn agent_load_session(
    registry: State<'_, AgentRegistry>,
    remote_registry: State<'_, Arc<RemoteRegistry>>,
    agent_id: Option<String>,
    session_id: String,
    vault_path: Option<String>,
) -> Result<crate::models::agent::AcpLoadSessionResult, AppError> {
    let desc = registry.resolve_default(agent_id.as_deref())?;
    let remote_target =
        resolve_remote_target(remote_registry.inner(), vault_path.as_deref()).await?;
    let cwd = if let Some(ref rt) = remote_target {
        rt.agent_cwd()
    } else {
        vault_path
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    };
    crate::services::agent::load_acp_session(&desc, session_id, cwd, remote_target.as_ref()).await
}

/// Request cooperative cancellation for a currently streaming ACP session.
#[tauri::command]
pub fn agent_cancel_run(
    runs: State<'_, AgentRunController>,
    session_id: String,
) -> Result<bool, AppError> {
    runs.cancel(&session_id)?;
    Ok(true)
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
) -> Result<PermissionResponded, AppError> {
    let resolved = gate.resolve(&request.request_id, request.option_id);
    Ok(PermissionResponded { resolved })
}

/// Payload for the `agent:notes-review` event: a note the agent modified this
/// run, offered to the user for keep / revert (trust loop).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotesReviewEvent {
    path: String,
    before: String,
    after: String,
}

/// Resolve the note file a run may edit: the target itself when it is a `.md`
/// file, or the paper folder's `NOTES.md` when the target is a folder.
fn snapshot_notes_path(vault: &str, target: &str) -> Option<PathBuf> {
    let t = target.trim().trim_matches('/');
    if t.is_empty() || t.contains("..") {
        return None;
    }
    let abs = PathBuf::from(vault).join(t);
    if abs.extension().and_then(|e| e.to_str()) == Some("md") {
        Some(abs)
    } else {
        Some(abs.join("NOTES.md"))
    }
}

/// Read a note's current content (None when missing / unreadable).
fn read_note_snapshot(path: &std::path::Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// Background ACP start when Chat opens — loads models/context without a user prompt.
#[tauri::command]
pub async fn agent_warm(
    window: tauri::WebviewWindow,
    registry: State<'_, AgentRegistry>,
    remote_registry: State<'_, Arc<RemoteRegistry>>,
    request: WarmRequest,
) -> Result<WarmResult, AppError> {
    let desc = match registry.resolve_default(request.agent_id.as_deref()) {
        Ok(d) => d,
        Err(e) => {
            return Ok(WarmResult {
                agent_id: request.agent_id.unwrap_or_default(),
                ok: false,
                models: None,
                usage_used: None,
                usage_size: None,
                error: Some(e.to_string()),
            });
        }
    };

    let remote =
        match resolve_remote_target(remote_registry.inner(), request.vault_path.as_deref()).await {
            Ok(t) => t,
            Err(e) => {
                return Ok(WarmResult {
                    agent_id: desc.id,
                    ok: false,
                    models: None,
                    usage_used: None,
                    usage_size: None,
                    error: Some(e.to_string()),
                });
            }
        };

    let events = AgentEventEmitter::new(window.app_handle().clone(), window.label());
    let result = warm_agent(events, desc, request.vault_path, request.model_id, remote).await;
    Ok(result)
}
