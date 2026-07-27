use crate::core::error::AppError;
use crate::features::agent::discover::{path_entries, resolve_command};
use crate::features::agent::events::AgentEventEmitter;
use crate::features::agent::models::{
    AcpHistoryLine, AcpHistoryPart, AcpHistoryTool, AcpListSessionsResult, AcpLoadSessionResult,
    AcpSessionCapabilities, AcpSessionInfo, AgentDescriptor, AgentEffortChoice, AgentEffortEvent,
    AgentFailedEvent, AgentFastModeEvent, AgentModelChoice, AgentModelsEvent, AgentPlanEntry,
    AgentPlanEvent, AgentResultPayload, AgentStreamEvent, AgentStreamKind, AgentToolEvent,
    AgentUsageEvent, ProbeResult, PromptImage, WarmResult,
};
use crate::features::agent::permission::PermissionGate;
use crate::features::agent::prompts::{build_prompt, extract_sources};
use crate::features::agent::skills::{
    load_skill_instructions, skill_activation_prefix, skill_mention_style,
};
use agent_client_protocol::schema::v1::{
    CancelNotification, ContentBlock, EnvVariable, ImageContent, InitializeRequest,
    ListSessionsRequest, LoadSessionRequest, McpServer, McpServerStdio, NewSessionRequest,
    PermissionOptionKind, PlanEntryPriority, PlanEntryStatus, PromptRequest,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    ResumeSessionRequest, SelectedPermissionOutcome, SessionConfigId, SessionConfigKind,
    SessionConfigOption, SessionConfigOptionCategory, SessionConfigOptionValue,
    SessionConfigSelectOptions, SessionId, SessionNotification, SessionUpdate,
    SetSessionConfigOptionRequest, TextContent, ToolCallStatus, ToolKind,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{util, AcpAgent, Agent, ConnectionTo};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::watch;
use uuid::Uuid;

fn to_acp_agent_local(desc: &AgentDescriptor) -> Result<AcpAgent, AppError> {
    let command = resolve_command(&desc.command).unwrap_or_else(|| PathBuf::from(&desc.command));
    let mut child_env: HashMap<String, String> = desc.env.clone();
    if !child_env.contains_key("PATH") {
        if let Ok(path) = std::env::join_paths(path_entries()) {
            child_env.insert("PATH".to_string(), path.to_string_lossy().to_string());
        }
    }
    let env: Vec<EnvVariable> = child_env
        .into_iter()
        .map(|(k, v)| EnvVariable::new(k.clone(), v.clone()))
        .collect();

    let stdio = McpServerStdio::new(desc.name.clone(), command)
        .args(desc.args.clone())
        .env(env);
    Ok(AcpAgent::new(McpServer::Stdio(stdio)))
}

/// Build ACP agent process. When `remote` is SSH, wrap launch as `ssh … 'cd vault && exec agent'`.
/// Local-sim remotes use a normal local process with cwd = remote vault path.
fn to_acp_agent(
    desc: &AgentDescriptor,
    remote: Option<&crate::features::remote::RemoteAgentTarget>,
) -> Result<AcpAgent, AppError> {
    if let Some(r) = remote {
        if r.is_ssh() {
            use crate::features::remote::agent_exec::remote_agent_shell_command;
            if r.destination.is_empty() {
                return Err(AppError::message("remote SSH destination is empty"));
            }
            use crate::features::remote::agent_exec::proxy_env_from_map;
            let proxy_pairs = proxy_env_from_map(&desc.env);
            let env_refs: Vec<(&str, &str)> = proxy_pairs
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_str()))
                .collect();
            let shell =
                remote_agent_shell_command(&r.remote_cwd, &desc.command, &desc.args, &env_refs);
            let stdio = McpServerStdio::new(desc.name.clone(), PathBuf::from("ssh")).args(vec![
                "-T".to_string(),
                "-o".to_string(),
                "BatchMode=yes".to_string(),
                "-o".to_string(),
                "ConnectTimeout=30".to_string(),
                r.destination.clone(),
                shell,
            ]);
            return Ok(AcpAgent::new(McpServer::Stdio(stdio)));
        }
        // local-sim: local binary, cwd set via NewSessionRequest to remote_cwd
    }
    to_acp_agent_local(desc)
}

fn text_from_content_block(block: &ContentBlock) -> Option<String> {
    match block {
        ContentBlock::Text(t) => Some(t.text.clone()),
        _ => None,
    }
}

async fn wait_for_cancellation(cancellation: &mut watch::Receiver<bool>) {
    if *cancellation.borrow() {
        return;
    }
    let _ = cancellation.changed().await;
}

/// Shared budget for ACP initialize / session RPCs and settings probe.
const ACP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

async fn timed_acp_request<T, E>(
    label: &str,
    request: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, agent_client_protocol::Error>
where
    E: std::fmt::Display,
{
    tokio::time::timeout(ACP_TIMEOUT, request)
        .await
        .map_err(|_| {
            acp_err(format!(
                "{label} timed out after {}s",
                ACP_TIMEOUT.as_secs()
            ))
        })?
        .map_err(|error| acp_err(format!("{label}: {error}")))
}

fn cancelled_payload(
    session_id: String,
    message_id: String,
    content: &Arc<Mutex<String>>,
    thought: &Arc<Mutex<String>>,
) -> AgentResultPayload {
    let content = content
        .lock()
        .map(|buffer| buffer.clone())
        .unwrap_or_default();
    let reasoning = thought
        .lock()
        .map(|buffer| buffer.clone())
        .unwrap_or_default();
    AgentResultPayload {
        session_id,
        message_id,
        sources: extract_sources(&content),
        content,
        reasoning: (!reasoning.is_empty()).then_some(reasoning),
        stop_reason: Some("cancelled".to_string()),
        provider_session_id: None,
    }
}

fn stream_from_update(update: &SessionUpdate) -> Option<(String, AgentStreamKind)> {
    match update {
        SessionUpdate::AgentMessageChunk(chunk) => {
            text_from_content_block(&chunk.content).map(|t| (t, AgentStreamKind::Message))
        }
        SessionUpdate::AgentThoughtChunk(chunk) => {
            text_from_content_block(&chunk.content).map(|t| (t, AgentStreamKind::Thought))
        }
        _ => None,
    }
}

fn tool_status_str(s: ToolCallStatus) -> &'static str {
    match s {
        ToolCallStatus::Pending => "pending",
        ToolCallStatus::InProgress => "in_progress",
        ToolCallStatus::Completed => "completed",
        ToolCallStatus::Failed => "failed",
        _ => "pending",
    }
}

fn tool_kind_str(k: ToolKind) -> &'static str {
    match k {
        ToolKind::Read => "read",
        ToolKind::Edit => "edit",
        ToolKind::Delete => "delete",
        ToolKind::Move => "move",
        ToolKind::Search => "search",
        ToolKind::Execute => "execute",
        ToolKind::Think => "think",
        ToolKind::Fetch => "fetch",
        ToolKind::SwitchMode => "switch_mode",
        ToolKind::Other => "other",
        _ => "other",
    }
}

fn plan_status_str(s: &PlanEntryStatus) -> &'static str {
    match s {
        PlanEntryStatus::Pending => "pending",
        PlanEntryStatus::InProgress => "in_progress",
        PlanEntryStatus::Completed => "completed",
        _ => "pending",
    }
}

fn plan_priority_str(p: &PlanEntryPriority) -> &'static str {
    match p {
        PlanEntryPriority::High => "high",
        PlanEntryPriority::Medium => "medium",
        PlanEntryPriority::Low => "low",
        _ => "medium",
    }
}

fn is_explicit_model_category(opt: &SessionConfigOption) -> bool {
    matches!(
        opt.category.as_ref(),
        Some(SessionConfigOptionCategory::Model)
    )
}

fn is_model_name_fallback(opt: &SessionConfigOption) -> bool {
    // Only used when no category=Model option exists. Avoid matching
    // "model_config" / "thought model" style options when possible.
    let n = opt.name.to_ascii_lowercase();
    n == "model" || n == "models" || n.ends_with(" model") || n.starts_with("model ")
}

/// Deduplicate model choices: agents often list the same model under multiple
/// groups (e.g. Recent + All) or with the same display name and different ids.
fn dedupe_model_choices(models: Vec<AgentModelChoice>) -> Vec<AgentModelChoice> {
    let mut seen_ids: HashSet<String> = HashSet::new();
    let mut seen_names: HashSet<String> = HashSet::new();
    let mut out = Vec::with_capacity(models.len());
    let mut dropped = 0u32;

    for m in models {
        let id_key = m.id.trim().to_string();
        let name_key = m.name.trim().to_ascii_lowercase();
        if id_key.is_empty() || name_key.is_empty() {
            dropped += 1;
            continue;
        }
        if seen_ids.contains(&id_key) || seen_names.contains(&name_key) {
            dropped += 1;
            continue;
        }
        seen_ids.insert(id_key);
        seen_names.insert(name_key);
        out.push(AgentModelChoice {
            id: m.id.trim().to_string(),
            name: m.name.trim().to_string(),
            group: m.group,
        });
    }

    if dropped > 0 {
        log::debug!(
            target: "agentero::agent",
            "model catalog deduped: kept={}, dropped_duplicates={}",
            out.len(),
            dropped
        );
    }
    out
}

fn collect_choices_from_select(
    sel: &agent_client_protocol::schema::v1::SessionConfigSelect,
) -> Vec<AgentModelChoice> {
    let mut models = Vec::new();
    match &sel.options {
        SessionConfigSelectOptions::Ungrouped(list) => {
            for o in list {
                models.push(AgentModelChoice {
                    id: o.value.to_string(),
                    name: o.name.clone(),
                    group: None,
                });
            }
        }
        SessionConfigSelectOptions::Grouped(groups) => {
            for g in groups {
                for o in &g.options {
                    models.push(AgentModelChoice {
                        id: o.value.to_string(),
                        name: o.name.clone(),
                        // Keep first group only after dedupe-by-name; still useful for UI.
                        group: Some(g.name.clone()),
                    });
                }
            }
        }
        _ => {}
    }
    models
}

/// Extract model selector catalog from ACP session config options.
fn models_from_config_options(
    session_id: &str,
    agent_id: &str,
    opts: &[SessionConfigOption],
) -> Option<AgentModelsEvent> {
    // Prefer explicit category=model so we don't accidentally pick model_config etc.
    let mut candidates: Vec<&SessionConfigOption> = opts
        .iter()
        .filter(|o| is_explicit_model_category(o))
        .collect();
    if candidates.is_empty() {
        candidates = opts.iter().filter(|o| is_model_name_fallback(o)).collect();
    }

    for opt in candidates {
        let SessionConfigKind::Select(sel) = &opt.kind else {
            continue;
        };
        let raw = collect_choices_from_select(sel);
        let raw_len = raw.len();
        let models = dedupe_model_choices(raw);
        if models.is_empty() {
            continue;
        }
        if raw_len != models.len() {
            log::debug!(
                target: "agentero::agent",
                "agent={} config_id={} model list: raw={} unique={}",
                agent_id,
                opt.id,
                raw_len,
                models.len()
            );
        }
        return Some(AgentModelsEvent {
            session_id: session_id.to_string(),
            agent_id: agent_id.to_string(),
            config_id: opt.id.to_string(),
            current_id: sel.current_value.to_string(),
            models,
        });
    }
    None
}

fn is_effort_option(opt: &SessionConfigOption) -> bool {
    matches!(
        opt.category.as_ref(),
        Some(SessionConfigOptionCategory::ThoughtLevel)
    ) || matches!(opt.id.0.as_ref(), "reasoning_effort" | "effort")
}

fn is_fast_option(opt: &SessionConfigOption) -> bool {
    matches!(
        opt.category.as_ref(),
        Some(SessionConfigOptionCategory::ModelConfig)
    ) && (opt.id.0.as_ref() == "fast-mode" || opt.name.to_ascii_lowercase().contains("fast"))
}

fn effort_from_config_options(
    session_id: &str,
    agent_id: &str,
    opts: &[SessionConfigOption],
) -> Option<AgentEffortEvent> {
    let opt = opts.iter().find(|opt| is_effort_option(opt))?;
    let SessionConfigKind::Select(sel) = &opt.kind else {
        return None;
    };
    let efforts = collect_choices_from_select(sel)
        .into_iter()
        .map(|choice| AgentEffortChoice {
            id: choice.id,
            name: choice.name,
            description: None,
        })
        .collect::<Vec<_>>();
    if efforts.is_empty() {
        return None;
    }
    Some(AgentEffortEvent {
        session_id: session_id.to_string(),
        agent_id: agent_id.to_string(),
        config_id: opt.id.to_string(),
        current_id: sel.current_value.to_string(),
        efforts,
    })
}

fn fast_mode_from_config_options(
    session_id: &str,
    agent_id: &str,
    opts: &[SessionConfigOption],
) -> Option<AgentFastModeEvent> {
    let opt = opts.iter().find(|opt| is_fast_option(opt))?;
    let enabled = match &opt.kind {
        SessionConfigKind::Boolean(value) => value.current_value,
        SessionConfigKind::Select(value) => value.current_value.0.as_ref() == "on",
        _ => return None,
    };
    Some(AgentFastModeEvent {
        session_id: session_id.to_string(),
        agent_id: agent_id.to_string(),
        config_id: opt.id.to_string(),
        enabled,
    })
}

fn emit_session_config_options(
    app: &AgentEventEmitter,
    session_id: &str,
    agent_id: &str,
    opts: &[SessionConfigOption],
) {
    if let Some(ev) = models_from_config_options(session_id, agent_id, opts) {
        let _ = app.emit("agent:models", ev);
    }
    if let Some(ev) = effort_from_config_options(session_id, agent_id, opts) {
        let _ = app.emit("agent:effort", ev);
    }
    if let Some(ev) = fast_mode_from_config_options(session_id, agent_id, opts) {
        let _ = app.emit("agent:fast-mode", ev);
    }
}

fn emit_rich_session_update(
    app: &AgentEventEmitter,
    session_id: &str,
    agent_id: &str,
    update: &SessionUpdate,
) {
    match update {
        SessionUpdate::ConfigOptionUpdate(upd) => {
            emit_session_config_options(app, session_id, agent_id, &upd.config_options);
        }
        SessionUpdate::ToolCall(tc) => {
            let _ = app.emit(
                "agent:tool",
                AgentToolEvent {
                    session_id: session_id.to_string(),
                    tool_call_id: tc.tool_call_id.to_string(),
                    title: Some(tc.title.clone()),
                    kind: Some(tool_kind_str(tc.kind).to_string()),
                    status: Some(tool_status_str(tc.status).to_string()),
                    input: tc.raw_input.clone(),
                    output: tc.raw_output.clone(),
                    full: true,
                },
            );
        }
        SessionUpdate::ToolCallUpdate(upd) => {
            let f = &upd.fields;
            let _ = app.emit(
                "agent:tool",
                AgentToolEvent {
                    session_id: session_id.to_string(),
                    tool_call_id: upd.tool_call_id.to_string(),
                    title: f.title.clone(),
                    kind: f.kind.map(tool_kind_str).map(str::to_string),
                    status: f.status.map(tool_status_str).map(str::to_string),
                    input: f.raw_input.clone(),
                    output: f.raw_output.clone(),
                    full: false,
                },
            );
        }
        SessionUpdate::Plan(plan) => {
            let entries = plan
                .entries
                .iter()
                .map(|e| AgentPlanEntry {
                    content: e.content.clone(),
                    status: plan_status_str(&e.status).to_string(),
                    priority: plan_priority_str(&e.priority).to_string(),
                })
                .collect();
            let _ = app.emit(
                "agent:plan",
                AgentPlanEvent {
                    session_id: session_id.to_string(),
                    entries,
                },
            );
        }
        SessionUpdate::UsageUpdate(u) => {
            let _ = app.emit(
                "agent:usage",
                AgentUsageEvent {
                    session_id: session_id.to_string(),
                    used: u.used,
                    size: u.size,
                },
            );
        }
        _ => {}
    }
}

fn acp_err(msg: impl ToString) -> agent_client_protocol::Error {
    util::internal_error(msg)
}

/// Default to cancelling permission requests. A provider's persisted YOLO preference
/// is applied to each prompt run and explicitly opts into the first offered option.
pub(crate) fn permission_response(
    request: &RequestPermissionRequest,
    auto_approve: bool,
) -> RequestPermissionResponse {
    let outcome = if auto_approve {
        request
            .options
            .iter()
            .find(|option| option.kind == PermissionOptionKind::AllowOnce)
            .map_or(RequestPermissionOutcome::Cancelled, |opt| {
                RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                    opt.option_id.clone(),
                ))
            })
    } else {
        RequestPermissionOutcome::Cancelled
    };
    RequestPermissionResponse::new(outcome)
}

/// How ACP permission requests are handled for a run.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum PermissionPolicy {
    /// Decline every request (safe default).
    Restricted,
    /// Approve every request (first AllowOnce option).
    Auto,
    /// Forward each request to the user and await their choice.
    Ask,
}

/// Payload for the `agent:permission-request` event (ask mode).
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PermissionRequestEvent {
    request_id: String,
    session_id: String,
    title: String,
    kind: Option<String>,
    paths: Vec<String>,
    options: Vec<PermissionOptionView>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PermissionOptionView {
    option_id: String,
    name: String,
    kind: String,
}

fn option_kind_label(kind: &PermissionOptionKind) -> &'static str {
    match kind {
        PermissionOptionKind::AllowOnce => "allow_once",
        PermissionOptionKind::AllowAlways => "allow_always",
        PermissionOptionKind::RejectOnce => "reject_once",
        PermissionOptionKind::RejectAlways => "reject_always",
        _ => "other",
    }
}

/// Ask mode: forward the request to the frontend and await the user's choice.
/// Falls back to cancelling when the user does not answer within the timeout.
async fn await_user_permission(
    app: &AgentEventEmitter,
    gate: &PermissionGate,
    session_id: &str,
    request: &RequestPermissionRequest,
) -> RequestPermissionResponse {
    let request_id = uuid::Uuid::new_v4().to_string();
    let title = request
        .tool_call
        .fields
        .title
        .clone()
        .unwrap_or_else(|| "Agent action".to_string());
    let kind = request
        .tool_call
        .fields
        .kind
        .as_ref()
        .map(|k| format!("{k:?}").to_lowercase());
    let paths = request
        .tool_call
        .fields
        .locations
        .clone()
        .unwrap_or_default()
        .iter()
        .map(|l| l.path.to_string_lossy().to_string())
        .collect();
    let options = request
        .options
        .iter()
        .map(|o| PermissionOptionView {
            option_id: o.option_id.to_string(),
            name: o.name.clone(),
            kind: option_kind_label(&o.kind).to_string(),
        })
        .collect();

    let rx = gate.register(&request_id);
    let _ = app.emit(
        "agent:permission-request",
        PermissionRequestEvent {
            request_id: request_id.clone(),
            session_id: session_id.to_string(),
            title,
            kind,
            paths,
            options,
        },
    );

    let answer = tokio::time::timeout(std::time::Duration::from_secs(300), rx).await;
    let outcome = match answer {
        Ok(Ok(Some(option_id))) => {
            RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option_id))
        }
        _ => RequestPermissionOutcome::Cancelled,
    };
    RequestPermissionResponse::new(outcome)
}

/// Spawn agent, initialize ACP, report agent info. Does not send a user prompt.
/// When `remote` is set, the agent process is launched on the remote host (SSH).
pub async fn probe_agent(
    desc: &AgentDescriptor,
    remote: Option<&crate::features::remote::RemoteAgentTarget>,
) -> ProbeResult {
    let agent_id = desc.id.clone();
    let acp = match to_acp_agent(desc, remote) {
        Ok(a) => a,
        Err(e) => {
            return ProbeResult {
                agent_id,
                available: false,
                agent_name: None,
                protocol_version: None,
                error: Some(e.to_string()),
                session_capabilities: None,
            };
        }
    };

    let captured: Arc<Mutex<Option<(String, String, AcpSessionCapabilities)>>> =
        Arc::new(Mutex::new(None));
    let captured_clone = captured.clone();

    let connect = agent_client_protocol::Client
        .builder()
        .name("agentero")
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _cx| {
                let _ = responder.respond(permission_response(&request, false));
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(acp, {
            let captured = captured_clone;
            move |connection: ConnectionTo<Agent>| async move {
                let init = connection
                    .send_request(InitializeRequest::new(ProtocolVersion::V1))
                    .block_task()
                    .await
                    .map_err(|e| acp_err(format!("initialize failed: {e}")))?;

                let name = init
                    .agent_info
                    .as_ref()
                    .map(|i| i.name.clone())
                    .unwrap_or_else(|| "unknown".into());
                let version = format!("{:?}", init.protocol_version);
                let session_caps = {
                    let sc = &init.agent_capabilities.session_capabilities;
                    AcpSessionCapabilities {
                        list: sc.list.is_some(),
                        resume: sc.resume.is_some(),
                        load: init.agent_capabilities.load_session,
                        delete: sc.delete.is_some(),
                    }
                };
                if let Ok(mut g) = captured.lock() {
                    *g = Some((name, version, session_caps));
                }
                Ok(())
            }
        });

    let result = match tokio::time::timeout(ACP_TIMEOUT, connect).await {
        Ok(r) => r,
        Err(_) => {
            return ProbeResult {
                agent_id,
                available: false,
                agent_name: None,
                protocol_version: None,
                error: Some(format!(
                    "probe timed out after {}s (check Agent proxy / network)",
                    ACP_TIMEOUT.as_secs()
                )),
                session_capabilities: None,
            };
        }
    };

    match result {
        Ok(()) => {
            let info = captured.lock().ok().and_then(|g| g.clone());
            match info {
                Some((name, version, session_caps)) => ProbeResult {
                    agent_id,
                    available: true,
                    agent_name: Some(name),
                    protocol_version: Some(version),
                    error: None,
                    session_capabilities: Some(session_caps),
                },
                None => ProbeResult {
                    agent_id,
                    available: false,
                    agent_name: None,
                    protocol_version: None,
                    error: Some("no initialize response".into()),
                    session_capabilities: None,
                },
            }
        }
        Err(e) => ProbeResult {
            agent_id,
            available: false,
            agent_name: None,
            protocol_version: None,
            error: Some(e.to_string()),
            session_capabilities: None,
        },
    }
}

/// One-shot prompt: spawn → initialize → session → prompt → stream events → completed/failed.
#[allow(clippy::too_many_arguments)]
pub async fn run_once(
    app: AgentEventEmitter,
    desc: AgentDescriptor,
    session_id: String,
    message_id: String,
    prompt: String,
    images: Vec<PromptImage>,
    workflow: Option<String>,
    target: Option<String>,
    vault_path: Option<String>,
    preferred_model_id: Option<String>,
    preferred_reasoning_effort: Option<String>,
    fast_mode: Option<bool>,
    skill_ids: Vec<String>,
    permission_policy: PermissionPolicy,
    permission_gate: PermissionGate,
    response_language: Option<String>,
    personal_prompt: Option<String>,
    mut cancellation: watch::Receiver<bool>,
    remote: Option<crate::features::remote::RemoteAgentTarget>,
    resume_session_id: Option<String>,
) -> Result<AgentResultPayload, AppError> {
    let skill_style = skill_mention_style(&desc.template);
    // Skills: local vault path, or remote work_root after materializing SKILL.md from SFTP.
    let skill_vault = if let Some(ref r) = remote {
        if let Err(e) = crate::features::remote::materialize_skills_to_work(&r.session).await {
            log::warn!(target: "agentero::agent", "materialize remote skills: {e}");
        }
        Some(r.work_root.to_string_lossy().into_owned())
    } else {
        vault_path.clone()
    };
    let skill_instructions =
        match load_skill_instructions(&skill_ids, skill_vault.as_deref(), skill_style) {
            Ok(instructions) => instructions,
            Err(error) => {
                let _ = app.emit(
                    "agent:failed",
                    AgentFailedEvent {
                        session_id,
                        error: error.to_string(),
                    },
                );
                return Err(error);
            }
        };
    let user_prompt = if prompt.trim().is_empty() && !images.is_empty() {
        "Please analyze the attached image crop from the research paper PDF.".to_string()
    } else {
        prompt
    };
    // Prefix native skill triggers (e.g. Codex `$id`) so the CLI can activate them.
    let activation = skill_activation_prefix(&skill_ids, skill_style);
    let user_prompt = format!("{activation}{user_prompt}");
    let full_prompt = format!(
        "{}{}",
        build_prompt(
            workflow.as_deref(),
            &user_prompt,
            target.as_deref(),
            skill_style,
            &skill_ids,
            response_language.as_deref(),
            personal_prompt.as_deref(),
        ),
        skill_instructions
    );
    let prompt_images = images;
    let cwd = if let Some(ref r) = remote {
        r.agent_cwd()
    } else {
        vault_path
            .as_ref()
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    };

    let acp = match to_acp_agent(&desc, remote.as_ref()) {
        Ok(agent) => agent,
        Err(error) => {
            let _ = app.emit(
                "agent:failed",
                AgentFailedEvent {
                    session_id,
                    error: error.to_string(),
                },
            );
            return Err(error);
        }
    };
    let content_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let thought_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let content_for_notif = content_buf.clone();
    let thought_for_notif = thought_buf.clone();
    let app_for_notif = app.clone();
    let session_for_notif = session_id.clone();
    let agent_id_for_notif = desc.id.clone();

    let stop_reason: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let stop_for_conn = stop_reason.clone();
    let content_for_conn = content_buf.clone();
    let thought_for_conn = thought_buf.clone();
    let session_for_conn = session_id.clone();
    let message_for_conn = message_id.clone();
    let app_for_conn = app.clone();
    let app_for_perm = app.clone();
    let session_for_perm = session_id.clone();

    let run_result = agent_client_protocol::Client
        .builder()
        .name("agentero")
        .on_receive_notification(
            async move |notification: SessionNotification, _cx| {
                if let Some((chunk, kind)) = stream_from_update(&notification.update) {
                    match kind {
                        AgentStreamKind::Message => {
                            if let Ok(mut buf) = content_for_notif.lock() {
                                buf.push_str(&chunk);
                            }
                        }
                        AgentStreamKind::Thought => {
                            if let Ok(mut buf) = thought_for_notif.lock() {
                                buf.push_str(&chunk);
                            }
                        }
                    }
                    let _ = app_for_notif.emit(
                        "agent:stream",
                        AgentStreamEvent {
                            session_id: session_for_notif.clone(),
                            chunk,
                            kind,
                        },
                    );
                }
                emit_rich_session_update(
                    &app_for_notif,
                    &session_for_notif,
                    &agent_id_for_notif,
                    &notification.update,
                );
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _cx| {
                let response = match permission_policy {
                    PermissionPolicy::Restricted => permission_response(&request, false),
                    PermissionPolicy::Auto => permission_response(&request, true),
                    PermissionPolicy::Ask => {
                        await_user_permission(
                            &app_for_perm,
                            &permission_gate,
                            &session_for_perm,
                            &request,
                        )
                        .await
                    }
                };
                let _ = responder.respond(response);
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(acp, {
            let full_prompt = full_prompt.clone();
            let prompt_images = prompt_images.clone();
            let preferred_model = preferred_model_id.clone();
            let preferred_effort = preferred_reasoning_effort.clone();
            let app_for_models = app_for_conn.clone();
            let session_for_models = session_for_conn.clone();
            let agent_id_for_models = desc.id.clone();
            let resume_id = resume_session_id.clone();
            move |connection: ConnectionTo<Agent>| async move {
                tokio::select! {
                    result = timed_acp_request(
                        "initialize",
                        connection
                            .send_request(InitializeRequest::new(ProtocolVersion::V1))
                            .block_task(),
                    ) => { result?; }
                    () = wait_for_cancellation(&mut cancellation) => {
                        let payload = cancelled_payload(
                            session_for_conn.clone(),
                            message_for_conn.clone(),
                            &content_for_conn,
                            &thought_for_conn,
                        );
                        let _ = app_for_conn.emit("agent:completed", payload.clone());
                        return Ok(payload);
                    }
                }

                let (acp_session_id, mut config_options) = if let Some(ref rid) = resume_id {
                    let resp = tokio::select! {
                        result = timed_acp_request(
                            "resume_session",
                            connection
                                .send_request(ResumeSessionRequest::new(
                                    SessionId::new(rid.as_str()),
                                    cwd.clone(),
                                ))
                                .block_task(),
                        ) => result?,
                        () = wait_for_cancellation(&mut cancellation) => {
                            let payload = cancelled_payload(
                                session_for_conn.clone(),
                                message_for_conn.clone(),
                                &content_for_conn,
                                &thought_for_conn,
                            );
                            let _ = app_for_conn.emit("agent:completed", payload.clone());
                            return Ok(payload);
                        }
                    };
                    (
                        SessionId::new(rid.as_str()),
                        resp.config_options.unwrap_or_default(),
                    )
                } else {
                    let new_session = tokio::select! {
                        result = timed_acp_request(
                            "new_session",
                            connection.send_request(NewSessionRequest::new(cwd)).block_task(),
                        ) => result?,
                        () = wait_for_cancellation(&mut cancellation) => {
                            let payload = cancelled_payload(
                                session_for_conn.clone(),
                                message_for_conn.clone(),
                                &content_for_conn,
                                &thought_for_conn,
                            );
                            let _ = app_for_conn.emit("agent:completed", payload.clone());
                            return Ok(payload);
                        }
                    };
                    (
                        new_session.session_id,
                        new_session.config_options.unwrap_or_default(),
                    )
                };
                macro_rules! return_cancelled {
                    () => {{
                        let payload = cancelled_payload(
                            session_for_conn.clone(),
                            message_for_conn.clone(),
                            &content_for_conn,
                            &thought_for_conn,
                        );
                        let _ = app_for_conn.emit("agent:completed", payload.clone());
                        return Ok(payload);
                    }};
                }
                if let Some(ev) = models_from_config_options(
                    &session_for_models,
                    &agent_id_for_models,
                    &config_options,
                ) {
                    // Model changes can affect supported effort and service tiers, so retain the
                    // complete response before resolving the remaining preferences.
                    if let Some(pref) = preferred_model.clone() {
                        if pref != ev.current_id && ev.models.iter().any(|m| m.id == pref) {
                            let response = tokio::select! {
                                result = timed_acp_request(
                                    "set model",
                                    connection
                                        .send_request(SetSessionConfigOptionRequest::new(
                                            acp_session_id.clone(),
                                            SessionConfigId::new(ev.config_id.as_str()),
                                            SessionConfigOptionValue::value_id(pref),
                                        ))
                                        .block_task(),
                                ) => result.ok(),
                                () = wait_for_cancellation(&mut cancellation) => return_cancelled!(),
                            };
                            if let Some(response) = response {
                                config_options = response.config_options;
                            }
                        }
                    }
                }
                if let Some(pref) = preferred_effort.clone() {
                    if let Some(ev) = effort_from_config_options(
                        &session_for_models,
                        &agent_id_for_models,
                        &config_options,
                    ) {
                        if pref != ev.current_id
                            && ev.efforts.iter().any(|effort| effort.id == pref)
                        {
                            let response = tokio::select! {
                                result = timed_acp_request(
                                    "set effort",
                                    connection
                                        .send_request(SetSessionConfigOptionRequest::new(
                                            acp_session_id.clone(),
                                            SessionConfigId::new(ev.config_id.as_str()),
                                            SessionConfigOptionValue::value_id(pref),
                                        ))
                                        .block_task(),
                                ) => result.ok(),
                                () = wait_for_cancellation(&mut cancellation) => return_cancelled!(),
                            };
                            if let Some(response) = response {
                                config_options = response.config_options;
                            }
                        }
                    }
                }
                if let Some(enabled) = fast_mode {
                    if let Some(opt) = config_options.iter().find(|opt| is_fast_option(opt)) {
                        let value = match &opt.kind {
                            SessionConfigKind::Boolean(_) => {
                                Some(SessionConfigOptionValue::boolean(enabled))
                            }
                            SessionConfigKind::Select(_) => {
                                Some(SessionConfigOptionValue::value_id(if enabled {
                                    "on"
                                } else {
                                    "off"
                                }))
                            }
                            _ => None,
                        };
                        if let Some(value) = value {
                            let response = tokio::select! {
                                result = timed_acp_request(
                                    "set fast mode",
                                    connection
                                        .send_request(SetSessionConfigOptionRequest::new(
                                            acp_session_id.clone(),
                                            opt.id.clone(),
                                            value,
                                        ))
                                        .block_task(),
                                ) => result.ok(),
                                () = wait_for_cancellation(&mut cancellation) => return_cancelled!(),
                            };
                            if let Some(response) = response {
                                config_options = response.config_options;
                            }
                        }
                    }
                }
                emit_session_config_options(
                    &app_for_models,
                    &session_for_models,
                    &agent_id_for_models,
                    &config_options,
                );

                if *cancellation.borrow() {
                    let _ = connection
                        .send_notification(CancelNotification::new(acp_session_id.clone()));
                    let payload = cancelled_payload(
                        session_for_conn.clone(),
                        message_for_conn.clone(),
                        &content_for_conn,
                        &thought_for_conn,
                    );
                    let _ = app_for_conn.emit("agent:completed", payload.clone());
                    return Ok(payload);
                }

                let mut content_blocks: Vec<ContentBlock> =
                    vec![ContentBlock::Text(TextContent::new(full_prompt))];
                for img in &prompt_images {
                    if img.data.trim().is_empty() || img.mime_type.trim().is_empty() {
                        continue;
                    }
                    content_blocks.push(ContentBlock::Image(ImageContent::new(
                        img.data.clone(),
                        img.mime_type.clone(),
                    )));
                }

                let prompt_response = tokio::select! {
                    response = connection
                        .send_request(PromptRequest::new(
                            acp_session_id.clone(),
                            content_blocks,
                        ))
                        .block_task() => response.map_err(|e| acp_err(format!("prompt: {e}")))?,
                    () = wait_for_cancellation(&mut cancellation) => {
                        let _ = connection
                            .send_notification(CancelNotification::new(acp_session_id));
                        let payload = cancelled_payload(
                            session_for_conn.clone(),
                            message_for_conn.clone(),
                            &content_for_conn,
                            &thought_for_conn,
                        );
                        let _ = app_for_conn.emit("agent:completed", payload.clone());
                        return Ok(payload);
                    }
                };

                if let Ok(mut s) = stop_for_conn.lock() {
                    *s = Some(format!("{:?}", prompt_response.stop_reason));
                }

                let content = content_for_conn
                    .lock()
                    .map(|g| g.clone())
                    .unwrap_or_default();
                let reasoning = thought_for_conn
                    .lock()
                    .map(|g| g.clone())
                    .unwrap_or_default();
                let sources = extract_sources(&content);
                let payload = AgentResultPayload {
                    session_id: session_for_conn.clone(),
                    message_id: message_for_conn.clone(),
                    content,
                    reasoning: if reasoning.is_empty() {
                        None
                    } else {
                        Some(reasoning)
                    },
                    sources,
                    stop_reason: stop_for_conn.lock().ok().and_then(|g| g.clone()),
                    provider_session_id: Some(acp_session_id.to_string()),
                };
                let _ = app_for_conn.emit("agent:completed", payload.clone());
                Ok(payload)
            }
        })
        .await;

    match run_result {
        Ok(payload) => Ok(payload),
        Err(e) => {
            let msg = e.to_string();
            let _ = app.emit(
                "agent:failed",
                AgentFailedEvent {
                    session_id: session_id.clone(),
                    error: msg.clone(),
                },
            );
            Err(AppError::Acp(msg))
        }
    }
}

pub fn new_ids() -> (String, String) {
    (Uuid::new_v4().to_string(), Uuid::new_v4().to_string())
}

/// Background warm-up: spawn ACP → initialize → new_session → emit models/usage (no prompt).
/// Used when Chat opens so the model selector and context meter are ready before first send.
pub async fn warm_agent(
    app: AgentEventEmitter,
    desc: AgentDescriptor,
    vault_path: Option<String>,
    preferred_model_id: Option<String>,
    remote: Option<crate::features::remote::RemoteAgentTarget>,
) -> WarmResult {
    let agent_id = desc.id.clone();
    let session_id = Uuid::new_v4().to_string();
    let cwd = if let Some(ref r) = remote {
        r.agent_cwd()
    } else {
        vault_path
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    };

    let acp = match to_acp_agent(&desc, remote.as_ref()) {
        Ok(a) => a,
        Err(e) => {
            return WarmResult {
                agent_id,
                ok: false,
                models: None,
                usage_used: None,
                usage_size: None,
                error: Some(e.to_string()),
            };
        }
    };

    let models_out: Arc<Mutex<Option<AgentModelsEvent>>> = Arc::new(Mutex::new(None));
    let usage_out: Arc<Mutex<Option<(u64, u64)>>> = Arc::new(Mutex::new(None));
    let models_for_conn = models_out.clone();
    let usage_for_notif = usage_out.clone();
    let app_for_notif = app.clone();
    let session_for_notif = session_id.clone();
    let agent_for_notif = agent_id.clone();

    let preferred = preferred_model_id.clone();
    let app_for_conn = app.clone();
    let session_for_conn = session_id.clone();
    let agent_for_conn = agent_id.clone();

    let result = agent_client_protocol::Client
        .builder()
        .name("agentero")
        .on_receive_notification(
            async move |notification: SessionNotification, _cx| {
                if let SessionUpdate::UsageUpdate(u) = &notification.update {
                    if let Ok(mut g) = usage_for_notif.lock() {
                        *g = Some((u.used, u.size));
                    }
                    let _ = app_for_notif.emit(
                        "agent:usage",
                        AgentUsageEvent {
                            session_id: session_for_notif.clone(),
                            used: u.used,
                            size: u.size,
                        },
                    );
                }
                if let SessionUpdate::ConfigOptionUpdate(upd) = &notification.update {
                    emit_session_config_options(
                        &app_for_notif,
                        &session_for_notif,
                        &agent_for_notif,
                        &upd.config_options,
                    );
                }
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _cx| {
                let _ = responder.respond(permission_response(&request, false));
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(acp, {
            let preferred = preferred.clone();
            let models_for_conn = models_for_conn.clone();
            move |connection: ConnectionTo<Agent>| async move {
                timed_acp_request(
                    "initialize",
                    connection
                        .send_request(InitializeRequest::new(ProtocolVersion::V1))
                        .block_task(),
                )
                .await?;

                let new_session = timed_acp_request(
                    "new_session",
                    connection
                        .send_request(NewSessionRequest::new(cwd))
                        .block_task(),
                )
                .await?;

                let acp_session_id = new_session.session_id;
                let mut config_options = new_session.config_options.unwrap_or_default();
                if let Some(ev) =
                    models_from_config_options(&session_for_conn, &agent_for_conn, &config_options)
                {
                    if let Some(pref) = preferred.clone() {
                        if pref != ev.current_id && ev.models.iter().any(|m| m.id == pref) {
                            if let Ok(response) = timed_acp_request(
                                "set model",
                                connection
                                    .send_request(SetSessionConfigOptionRequest::new(
                                        acp_session_id.clone(),
                                        SessionConfigId::new(ev.config_id.as_str()),
                                        SessionConfigOptionValue::value_id(pref),
                                    ))
                                    .block_task(),
                            )
                            .await
                            {
                                config_options = response.config_options;
                            }
                        }
                    }
                }
                emit_session_config_options(
                    &app_for_conn,
                    &session_for_conn,
                    &agent_for_conn,
                    &config_options,
                );
                if let Some(ev) =
                    models_from_config_options(&session_for_conn, &agent_for_conn, &config_options)
                {
                    if let Ok(mut g) = models_for_conn.lock() {
                        *g = Some(ev);
                    }
                }

                // Brief settle so agents can push usage/config updates after session create.
                tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                Ok(())
            }
        })
        .await;

    match result {
        Ok(()) => {
            let models = models_out.lock().ok().and_then(|g| g.clone());
            let usage = usage_out.lock().ok().and_then(|g| *g);
            WarmResult {
                agent_id,
                ok: true,
                models,
                usage_used: usage.map(|(u, _)| u),
                usage_size: usage.map(|(_, s)| s),
                error: None,
            }
        }
        Err(e) => WarmResult {
            agent_id,
            ok: false,
            models: None,
            usage_used: None,
            usage_size: None,
            error: Some(e.to_string()),
        },
    }
}

/// List sessions from an ACP agent via `session/list`.
/// Returns `supported: false` if the agent does not advertise session.list capability.
pub async fn list_acp_sessions(
    desc: &AgentDescriptor,
    cwd: PathBuf,
    cursor: Option<String>,
    remote: Option<&crate::features::remote::RemoteAgentTarget>,
) -> Result<AcpListSessionsResult, AppError> {
    let acp = to_acp_agent(desc, remote)?;

    let result = agent_client_protocol::Client
        .builder()
        .name("agentero")
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _cx| {
                let _ = responder.respond(permission_response(&request, false));
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(acp, {
            move |connection: ConnectionTo<Agent>| async move {
                let init = timed_acp_request(
                    "initialize",
                    connection
                        .send_request(InitializeRequest::new(ProtocolVersion::V1))
                        .block_task(),
                )
                .await?;

                let supports_list = init.agent_capabilities.session_capabilities.list.is_some();

                if !supports_list {
                    return Ok(AcpListSessionsResult {
                        sessions: vec![],
                        next_cursor: None,
                        supported: false,
                    });
                }

                let mut req = ListSessionsRequest::new().cwd(cwd);
                if let Some(c) = cursor {
                    req = req.cursor(c);
                }

                let resp =
                    timed_acp_request("session/list", connection.send_request(req).block_task())
                        .await?;

                let sessions = resp
                    .sessions
                    .into_iter()
                    .map(|s| AcpSessionInfo {
                        session_id: s.session_id.to_string(),
                        cwd: s.cwd.to_string_lossy().to_string(),
                        title: s.title,
                        updated_at: s.updated_at,
                    })
                    .collect();

                Ok(AcpListSessionsResult {
                    sessions,
                    next_cursor: resp.next_cursor,
                    supported: true,
                })
            }
        })
        .await;

    match result {
        Ok(r) => Ok(r),
        Err(e) => Err(AppError::Acp(format!("list sessions: {e}"))),
    }
}

/// Load a session's history from an ACP agent via `session/load`.
/// The agent replays history as SessionNotification events which we accumulate.
/// `messageId` boundaries split consecutive same-kind chunks into separate parts.
#[derive(Default)]
struct ReplayBuilder {
    lines: Vec<ReplayLine>,
    title: Option<String>,
}

struct ReplayLine {
    is_user: bool,
    parts: Vec<AcpHistoryPart>,
    trailing_msg_id: Option<String>,
}

impl ReplayLine {
    fn agent() -> Self {
        Self {
            is_user: false,
            parts: Vec::new(),
            trailing_msg_id: None,
        }
    }
}

fn msg_id_changed(prev: &Option<String>, next: &Option<String>) -> bool {
    matches!((prev, next), (Some(a), Some(b)) if a != b)
}

fn chunk_msg_id(chunk: &agent_client_protocol::schema::v1::ContentChunk) -> Option<String> {
    chunk.message_id.as_ref().map(|m| m.0.to_string())
}

impl ReplayBuilder {
    fn push_user_chunk(&mut self, text: String, msg_id: Option<String>) {
        let start_new = match self.lines.last() {
            Some(l) if l.is_user => msg_id_changed(&l.trailing_msg_id, &msg_id),
            _ => true,
        };
        if start_new {
            self.lines.push(ReplayLine {
                is_user: true,
                parts: vec![AcpHistoryPart::Text { text }],
                trailing_msg_id: msg_id,
            });
            return;
        }
        let line = self.lines.last_mut().expect("checked non-empty");
        if let Some(AcpHistoryPart::Text { text: t }) = line.parts.last_mut() {
            t.push_str(&text);
        } else {
            line.parts.push(AcpHistoryPart::Text { text });
        }
        if msg_id.is_some() {
            line.trailing_msg_id = msg_id;
        }
    }

    fn current_agent_line(&mut self) -> &mut ReplayLine {
        if !matches!(self.lines.last(), Some(l) if !l.is_user) {
            self.lines.push(ReplayLine::agent());
        }
        self.lines.last_mut().expect("checked non-empty")
    }

    fn push_agent_chunk(&mut self, reasoning: bool, text: String, msg_id: Option<String>) {
        let line = self.current_agent_line();
        let same_kind_tail = match line.parts.last() {
            Some(AcpHistoryPart::Reasoning { .. }) => reasoning,
            Some(AcpHistoryPart::Text { .. }) => !reasoning,
            _ => false,
        };
        if same_kind_tail && !msg_id_changed(&line.trailing_msg_id, &msg_id) {
            if let Some(AcpHistoryPart::Reasoning { text: t } | AcpHistoryPart::Text { text: t }) =
                line.parts.last_mut()
            {
                t.push_str(&text);
            }
        } else if reasoning {
            line.parts.push(AcpHistoryPart::Reasoning { text });
        } else {
            line.parts.push(AcpHistoryPart::Text { text });
        }
        if msg_id.is_some() {
            line.trailing_msg_id = msg_id;
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_tool(
        &mut self,
        id: String,
        title: Option<String>,
        kind: Option<String>,
        status: Option<String>,
        input: Option<serde_json::Value>,
        output: Option<serde_json::Value>,
    ) {
        for line in self.lines.iter_mut().rev() {
            for part in line.parts.iter_mut().rev() {
                if let AcpHistoryPart::Tool { tool } = part {
                    if tool.id == id {
                        if let Some(t) = title {
                            tool.title = t;
                        }
                        if let Some(k) = kind {
                            tool.kind = k;
                        }
                        if let Some(s) = status {
                            tool.status = s;
                        }
                        if input.is_some() {
                            tool.input = input;
                        }
                        if output.is_some() {
                            tool.output = output;
                        }
                        return;
                    }
                }
            }
        }
        self.current_agent_line().parts.push(AcpHistoryPart::Tool {
            tool: Box::new(AcpHistoryTool {
                id,
                title: title.unwrap_or_default(),
                kind: kind.unwrap_or_else(|| "other".to_string()),
                status: status.unwrap_or_else(|| "pending".to_string()),
                input,
                output,
            }),
        });
    }

    fn apply_plan(&mut self, entries: Vec<AgentPlanEntry>) {
        let line = self.current_agent_line();
        if let Some(AcpHistoryPart::Plan { entries: e }) = line
            .parts
            .iter_mut()
            .find(|p| matches!(p, AcpHistoryPart::Plan { .. }))
        {
            *e = entries;
        } else {
            line.parts.push(AcpHistoryPart::Plan { entries });
        }
    }

    fn finish(self) -> (Vec<AcpHistoryLine>, Option<String>) {
        let mut out = Vec::new();
        for line in self.lines {
            let text: String = line
                .parts
                .iter()
                .filter_map(|p| match p {
                    AcpHistoryPart::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect();
            let reasoning = line
                .parts
                .iter()
                .filter_map(|p| match p {
                    AcpHistoryPart::Reasoning { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            let has_rich_parts = line
                .parts
                .iter()
                .any(|p| matches!(p, AcpHistoryPart::Tool { .. } | AcpHistoryPart::Plan { .. }));
            if text.trim().is_empty() && reasoning.trim().is_empty() && !has_rich_parts {
                continue;
            }
            let id = format!("line-{}", out.len() + 1);
            if line.is_user {
                out.push(AcpHistoryLine {
                    id,
                    kind: "user".to_string(),
                    text,
                    reasoning: None,
                    parts: Vec::new(),
                    sources: Vec::new(),
                });
            } else {
                out.push(AcpHistoryLine {
                    id,
                    kind: "agent".to_string(),
                    sources: extract_sources(&text),
                    text,
                    reasoning: (!reasoning.is_empty()).then_some(reasoning),
                    parts: line.parts,
                });
            }
        }
        (out, self.title)
    }
}

pub async fn load_acp_session(
    desc: &AgentDescriptor,
    session_id: String,
    cwd: PathBuf,
    remote: Option<&crate::features::remote::RemoteAgentTarget>,
) -> Result<AcpLoadSessionResult, AppError> {
    let acp = to_acp_agent(desc, remote)?;

    let builder: Arc<Mutex<ReplayBuilder>> = Arc::new(Mutex::new(ReplayBuilder::default()));
    let builder_for_notif = builder.clone();

    let result = agent_client_protocol::Client
        .builder()
        .name("agentero")
        .on_receive_notification(
            async move |notification: SessionNotification, _cx| {
                let Ok(mut b) = builder_for_notif.lock() else {
                    return Ok(());
                };
                match &notification.update {
                    SessionUpdate::UserMessageChunk(chunk) => {
                        if let Some(text) = text_from_content_block(&chunk.content) {
                            b.push_user_chunk(text, chunk_msg_id(chunk));
                        }
                    }
                    SessionUpdate::AgentMessageChunk(chunk) => {
                        if let Some(text) = text_from_content_block(&chunk.content) {
                            b.push_agent_chunk(false, text, chunk_msg_id(chunk));
                        }
                    }
                    SessionUpdate::AgentThoughtChunk(chunk) => {
                        if let Some(text) = text_from_content_block(&chunk.content) {
                            b.push_agent_chunk(true, text, chunk_msg_id(chunk));
                        }
                    }
                    SessionUpdate::ToolCall(tc) => {
                        b.apply_tool(
                            tc.tool_call_id.to_string(),
                            Some(tc.title.clone()),
                            Some(tool_kind_str(tc.kind).to_string()),
                            Some(tool_status_str(tc.status).to_string()),
                            tc.raw_input.clone(),
                            tc.raw_output.clone(),
                        );
                    }
                    SessionUpdate::ToolCallUpdate(upd) => {
                        let f = &upd.fields;
                        b.apply_tool(
                            upd.tool_call_id.to_string(),
                            f.title.clone(),
                            f.kind.map(tool_kind_str).map(str::to_string),
                            f.status.map(tool_status_str).map(str::to_string),
                            f.raw_input.clone(),
                            f.raw_output.clone(),
                        );
                    }
                    SessionUpdate::Plan(plan) => {
                        b.apply_plan(
                            plan.entries
                                .iter()
                                .map(|e| AgentPlanEntry {
                                    content: e.content.clone(),
                                    status: plan_status_str(&e.status).to_string(),
                                    priority: plan_priority_str(&e.priority).to_string(),
                                })
                                .collect(),
                        );
                    }
                    SessionUpdate::SessionInfoUpdate(info) => {
                        if let agent_client_protocol::schema::MaybeUndefined::Value(t) = &info.title
                        {
                            b.title = Some(t.clone());
                        }
                    }
                    _ => {}
                }
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _cx| {
                let _ = responder.respond(permission_response(&request, false));
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(acp, {
            let sid = session_id.clone();
            move |connection: ConnectionTo<Agent>| async move {
                timed_acp_request(
                    "initialize",
                    connection
                        .send_request(InitializeRequest::new(ProtocolVersion::V1))
                        .block_task(),
                )
                .await?;

                timed_acp_request(
                    "session/load",
                    connection
                        .send_request(LoadSessionRequest::new(SessionId::new(sid.as_str()), cwd))
                        .block_task(),
                )
                .await?;

                // Brief settle so the agent can push replayed notifications.
                tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                Ok(())
            }
        })
        .await;

    match result {
        Ok(()) => {
            let taken = builder
                .lock()
                .map(|mut g| std::mem::take(&mut *g))
                .unwrap_or_default();
            let (lines, title) = taken.finish();
            Ok(AcpLoadSessionResult {
                session_id,
                title,
                lines,
            })
        }
        Err(e) => Err(AppError::Acp(format!("load session: {e}"))),
    }
}

#[cfg(test)]
mod config_option_tests {
    use super::{effort_from_config_options, fast_mode_from_config_options};
    use agent_client_protocol::schema::v1::{
        SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelectOption,
    };

    #[test]
    fn extracts_codex_reasoning_effort_from_thought_level() {
        let options = vec![SessionConfigOption::select(
            "reasoning_effort",
            "Reasoning effort",
            "xhigh",
            vec![
                SessionConfigSelectOption::new("medium", "medium"),
                SessionConfigSelectOption::new("xhigh", "xhigh"),
            ],
        )
        .category(SessionConfigOptionCategory::ThoughtLevel)];

        let effort = effort_from_config_options("session", "codex", &options)
            .expect("Codex thought level should be exposed");
        assert_eq!(effort.current_id, "xhigh");
        assert_eq!(effort.efforts.len(), 2);
    }

    #[test]
    fn extracts_codex_fast_mode_from_model_config() {
        let options = vec![SessionConfigOption::select(
            "fast-mode",
            "Fast mode",
            "on",
            vec![
                SessionConfigSelectOption::new("off", "Off"),
                SessionConfigSelectOption::new("on", "On"),
            ],
        )
        .category(SessionConfigOptionCategory::ModelConfig)];

        let fast = fast_mode_from_config_options("session", "codex", &options)
            .expect("Codex fast mode should be exposed");
        assert!(fast.enabled);
    }
}
