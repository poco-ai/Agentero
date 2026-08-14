use crate::core::error::AppError;
use crate::features::agent::ask_user::{
    cancelled_response, grok_response_from_answers, questions_to_dto, AskUserAnswer, AskUserGate,
    AskUserRequestEvent, GrokAskUserRequest,
};
use crate::features::agent::discover::{path_entries, resolve_command};
use crate::features::agent::elicitation::{ElicitationAnswer, ElicitationGate};
use crate::features::agent::events::AgentEventEmitter;
use crate::features::agent::hidden_sessions::HiddenSessionScope;
use crate::features::agent::models::{
    AcpHistoryLine, AcpHistoryPart, AcpHistoryTool, AcpListSessionsResult, AcpLoadSessionResult,
    AcpSessionCapabilities, AcpSessionInfo, AgentCollaborationEvent, AgentCommand,
    AgentCommandInput, AgentCommandsEvent, AgentDescriptor, AgentEffortChoice, AgentEffortEvent,
    AgentFailedEvent, AgentFastModeEvent, AgentModeChoice, AgentModelChoice, AgentModelsEvent,
    AgentPlanEntry, AgentPlanEvent, AgentResultPayload, AgentStreamEvent, AgentStreamKind,
    AgentTemplate, AgentToolEvent, AgentUsageEvent, ProbeResult, PromptImage, WarmResult,
};
use crate::features::agent::permission::PermissionGate;
use crate::features::agent::prompts::{build_prompt, extract_sources};
use crate::features::agent::skills::{
    load_skill_instructions, skill_activation_prefix, skill_mention_style,
};
use agent_client_protocol::schema::v1::{
    AvailableCommandInput, CancelNotification, ClientCapabilities, ContentBlock,
    CreateElicitationRequest, CreateElicitationResponse, ElicitationAcceptAction,
    ElicitationAction, ElicitationCapabilities, ElicitationContentValue,
    ElicitationFormCapabilities, ElicitationMode, ElicitationPropertySchema, ElicitationScope,
    EnvVariable, ImageContent, InitializeRequest, ListSessionsRequest, LoadSessionRequest,
    McpServer, McpServerStdio, NewSessionRequest, PermissionOptionKind, PlanEntryPriority,
    PlanEntryStatus, PromptRequest, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, ResumeSessionRequest, SelectedPermissionOutcome, SessionConfigId,
    SessionConfigKind, SessionConfigOption, SessionConfigOptionCategory, SessionConfigOptionValue,
    SessionConfigSelectOptions, SessionId, SessionNotification, SessionUpdate,
    SetSessionConfigOptionRequest, TextContent, ToolCallStatus, ToolKind,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{util, AcpAgent, Agent, ConnectionTo};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::watch;
use uuid::Uuid;

/// Advertise form elicitation so codex-acp bridges `request_user_input` to the client.
fn client_initialize_request() -> InitializeRequest {
    InitializeRequest::new(ProtocolVersion::V1).client_capabilities(
        ClientCapabilities::new()
            .elicitation(ElicitationCapabilities::new().form(ElicitationFormCapabilities::new())),
    )
}

fn to_acp_agent_local(desc: &AgentDescriptor) -> Result<AcpAgent, AppError> {
    let command = resolve_command(&desc.command).unwrap_or_else(|| PathBuf::from(&desc.command));
    let mut child_env: HashMap<String, String> = desc.env.clone();
    if !child_env.contains_key("PATH") {
        if let Ok(path) = std::env::join_paths(path_entries()) {
            child_env.insert("PATH".to_string(), path.to_string_lossy().to_string());
        }
    }
    // Gemini CLI launches a browser OAuth flow from `new_session` when it has no
    // cached credentials; our ACP session timeout kills the child before login
    // can finish, so the browser would pop up on every spawn. Sign-in must
    // happen in a terminal instead (BYOA).
    if matches!(desc.template, AgentTemplate::Gemini) && !child_env.contains_key("NO_BROWSER") {
        child_env.insert("NO_BROWSER".to_string(), "true".to_string());
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

/// Shared budget for ACP initialize / control RPCs and settings probe.
const ACP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Opening a session can cold-start the provider (runtime boot, MCP servers,
/// auth checks) and gets slower when several agents spawn in parallel, e.g.
/// the two defense-preparation workers. Give session/new-resume-load a longer
/// budget than lightweight control RPCs.
const ACP_SESSION_OPEN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

async fn timed_acp_request_with<T, E>(
    label: &str,
    budget: std::time::Duration,
    request: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, agent_client_protocol::Error>
where
    E: std::fmt::Display,
{
    tokio::time::timeout(budget, request)
        .await
        .map_err(|_| acp_err(format!("{label} timed out after {}s", budget.as_secs())))?
        .map_err(|error| acp_err(format!("{label}: {error}")))
}

async fn timed_acp_request<T, E>(
    label: &str,
    request: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, agent_client_protocol::Error>
where
    E: std::fmt::Display,
{
    timed_acp_request_with(label, ACP_TIMEOUT, request).await
}

fn cancelled_payload(
    session_id: String,
    message_id: String,
    provider_session_id: Option<String>,
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
        provider_session_id,
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
        let mut models = dedupe_model_choices(raw);
        let current_id = sel.current_value.to_string();
        // Third-party / gateway defaults (e.g. DeepSeek via cc-switch) may set a
        // current model id that is not present in the advertised selector catalog.
        // Surface it so the client can select and persist it.
        let current_trim = current_id.trim();
        if !current_trim.is_empty() && !models.iter().any(|m| m.id == current_trim) {
            models.insert(
                0,
                AgentModelChoice {
                    id: current_trim.to_string(),
                    name: current_trim.to_string(),
                    group: None,
                },
            );
            log::debug!(
                target: "agentero::agent",
                "agent={} config_id={} injected current model not in catalog: {}",
                agent_id,
                opt.id,
                current_trim
            );
        }
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
            current_id,
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

fn is_collaboration_option(opt: &SessionConfigOption) -> bool {
    // Codex codex-acp: id + category "collaboration_mode" (Default / Plan).
    if matches!(
        opt.id.0.as_ref(),
        "collaboration_mode" | "collaboration-mode"
    ) {
        return true;
    }
    match opt.category.as_ref() {
        Some(SessionConfigOptionCategory::Other(cat)) => {
            cat == "collaboration_mode" || cat == "collaboration-mode"
        }
        _ => {
            opt.name.eq_ignore_ascii_case("collaboration mode")
                || opt.name.eq_ignore_ascii_case("collaboration")
        }
    }
}

fn collect_mode_choices_from_select(
    sel: &agent_client_protocol::schema::v1::SessionConfigSelect,
) -> Vec<AgentModeChoice> {
    let mut modes = Vec::new();
    match &sel.options {
        SessionConfigSelectOptions::Ungrouped(list) => {
            for o in list {
                modes.push(AgentModeChoice {
                    id: o.value.to_string(),
                    name: o.name.clone(),
                    description: o.description.clone(),
                });
            }
        }
        SessionConfigSelectOptions::Grouped(groups) => {
            for g in groups {
                for o in &g.options {
                    modes.push(AgentModeChoice {
                        id: o.value.to_string(),
                        name: o.name.clone(),
                        description: o.description.clone(),
                    });
                }
            }
        }
        _ => {}
    }
    modes
}

/// Extract collaboration mode (Codex Default / Plan) from ACP config options.
fn collaboration_from_config_options(
    session_id: &str,
    agent_id: &str,
    opts: &[SessionConfigOption],
) -> Option<AgentCollaborationEvent> {
    let opt = opts.iter().find(|opt| is_collaboration_option(opt))?;
    let SessionConfigKind::Select(sel) = &opt.kind else {
        return None;
    };
    let modes = collect_mode_choices_from_select(sel)
        .into_iter()
        .filter(|m| !m.id.trim().is_empty() && !m.name.trim().is_empty())
        .collect::<Vec<_>>();
    if modes.is_empty() {
        return None;
    }
    Some(AgentCollaborationEvent {
        session_id: session_id.to_string(),
        agent_id: agent_id.to_string(),
        config_id: opt.id.to_string(),
        current_id: sel.current_value.to_string(),
        modes,
    })
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
    if let Some(ev) = collaboration_from_config_options(session_id, agent_id, opts) {
        let _ = app.emit("agent:collaboration", ev);
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
        SessionUpdate::AvailableCommandsUpdate(upd) => {
            let commands = upd
                .available_commands
                .iter()
                .map(|command| AgentCommand {
                    name: command.name.clone(),
                    description: command.description.clone(),
                    input: match &command.input {
                        Some(AvailableCommandInput::Unstructured(input)) => {
                            Some(AgentCommandInput {
                                hint: input.hint.clone(),
                            })
                        }
                        _ => None,
                    },
                })
                .filter(|command| !command.name.trim().is_empty())
                .collect();
            let _ = app.emit(
                "agent:commands",
                AgentCommandsEvent {
                    session_id: session_id.to_string(),
                    agent_id: agent_id.to_string(),
                    commands,
                },
            );
        }
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

/// One form field derived from an elicitation schema property (for UI).
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ElicitationFieldView {
    id: String,
    title: String,
    description: Option<String>,
    required: bool,
    /// select | text | boolean | number | other
    kind: String,
    options: Vec<ElicitationOptionView>,
    /// Codex companion free-text for "Other" (same logical question).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    is_other_answer: bool,
    /// Parent question field id when `is_other_answer`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parent_field_id: Option<String>,
}

fn codex_meta_flag(meta: &Option<agent_client_protocol::schema::v1::Meta>, key: &str) -> bool {
    meta.as_ref()
        .and_then(|m| m.get("codex"))
        .and_then(|c| c.get(key))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

fn codex_meta_string(
    meta: &Option<agent_client_protocol::schema::v1::Meta>,
    key: &str,
) -> Option<String> {
    meta.as_ref()
        .and_then(|m| m.get("codex"))
        .and_then(|c| c.get(key))
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ElicitationOptionView {
    value: String,
    title: String,
    description: Option<String>,
}

/// Payload for `agent:elicitation-request`.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ElicitationRequestEvent {
    request_id: String,
    /// Agentero runtime session id (correlates with the active chat run).
    session_id: String,
    message: String,
    /// Optional ACP provider tool call id when the elicitation is scoped to a tool.
    tool_call_id: Option<String>,
    fields: Vec<ElicitationFieldView>,
}

fn elicitation_fields_from_request(
    request: &CreateElicitationRequest,
) -> Vec<ElicitationFieldView> {
    let ElicitationMode::Form(form) = &request.mode else {
        return Vec::new();
    };
    let required: HashSet<&str> = form
        .requested_schema
        .required
        .as_ref()
        .map(|r| r.iter().map(String::as_str).collect())
        .unwrap_or_default();

    form.requested_schema
        .properties
        .iter()
        .map(|(id, prop)| {
            let is_required = required.contains(id.as_str());
            match prop {
                ElicitationPropertySchema::String(s) => {
                    let options = if let Some(one_of) = &s.one_of {
                        one_of
                            .iter()
                            .map(|o| ElicitationOptionView {
                                value: o.value.clone(),
                                title: o.title.clone(),
                                description: o.description.clone(),
                            })
                            .collect()
                    } else if let Some(enums) = &s.enum_values {
                        enums
                            .iter()
                            .map(|v| ElicitationOptionView {
                                value: v.clone(),
                                title: v.clone(),
                                description: None,
                            })
                            .collect()
                    } else {
                        Vec::new()
                    };
                    let kind = if options.is_empty() {
                        "text".to_string()
                    } else {
                        "select".to_string()
                    };
                    let is_other_answer = codex_meta_flag(&s.meta, "isOtherAnswer")
                        || codex_meta_flag(&s.meta, "is_other_answer");
                    // codex-acp uses questionId; some adapters use parentFieldId / parentId.
                    let parent_field_id = codex_meta_string(&s.meta, "questionId")
                        .or_else(|| codex_meta_string(&s.meta, "parentFieldId"))
                        .or_else(|| codex_meta_string(&s.meta, "parent_field_id"))
                        .or_else(|| codex_meta_string(&s.meta, "parentId"));
                    ElicitationFieldView {
                        id: id.clone(),
                        title: s.title.clone().unwrap_or_else(|| id.clone()),
                        description: s.description.clone(),
                        required: is_required,
                        kind,
                        options,
                        is_other_answer,
                        parent_field_id,
                    }
                }
                ElicitationPropertySchema::Boolean(b) => ElicitationFieldView {
                    id: id.clone(),
                    title: b.title.clone().unwrap_or_else(|| id.clone()),
                    description: b.description.clone(),
                    required: is_required,
                    kind: "boolean".to_string(),
                    options: vec![
                        ElicitationOptionView {
                            value: "true".into(),
                            title: "Yes".into(),
                            description: None,
                        },
                        ElicitationOptionView {
                            value: "false".into(),
                            title: "No".into(),
                            description: None,
                        },
                    ],
                    is_other_answer: false,
                    parent_field_id: None,
                },
                ElicitationPropertySchema::Number(n) => ElicitationFieldView {
                    id: id.clone(),
                    title: n.title.clone().unwrap_or_else(|| id.clone()),
                    description: n.description.clone(),
                    required: is_required,
                    kind: "number".to_string(),
                    options: Vec::new(),
                    is_other_answer: false,
                    parent_field_id: None,
                },
                ElicitationPropertySchema::Integer(n) => ElicitationFieldView {
                    id: id.clone(),
                    title: n.title.clone().unwrap_or_else(|| id.clone()),
                    description: n.description.clone(),
                    required: is_required,
                    kind: "number".to_string(),
                    options: Vec::new(),
                    is_other_answer: false,
                    parent_field_id: None,
                },
                ElicitationPropertySchema::Array(a) => ElicitationFieldView {
                    id: id.clone(),
                    title: a.title.clone().unwrap_or_else(|| id.clone()),
                    description: a.description.clone(),
                    required: is_required,
                    kind: "text".to_string(),
                    options: Vec::new(),
                    is_other_answer: false,
                    parent_field_id: None,
                },
                ElicitationPropertySchema::Other(_) | _ => ElicitationFieldView {
                    id: id.clone(),
                    title: id.clone(),
                    description: None,
                    required: is_required,
                    kind: "other".to_string(),
                    options: Vec::new(),
                    is_other_answer: false,
                    parent_field_id: None,
                },
            }
        })
        .collect()
}

fn session_id_from_elicitation(request: &CreateElicitationRequest) -> Option<String> {
    match request.mode.scope() {
        ElicitationScope::Session(s) => Some(s.session_id.to_string()),
        ElicitationScope::Request(_) | _ => None,
    }
}

fn tool_call_id_from_elicitation(request: &CreateElicitationRequest) -> Option<String> {
    match request.mode.scope() {
        ElicitationScope::Session(s) => s.tool_call_id.as_ref().map(|id| id.to_string()),
        ElicitationScope::Request(_) | _ => None,
    }
}

fn elicitation_response_from_answer(answer: ElicitationAnswer) -> CreateElicitationResponse {
    match answer {
        ElicitationAnswer::Accept(fields) => {
            let content: BTreeMap<String, ElicitationContentValue> = fields
                .into_iter()
                .map(|(k, v)| (k, ElicitationContentValue::String(v)))
                .collect();
            CreateElicitationResponse::new(ElicitationAction::Accept(
                ElicitationAcceptAction::new().content(content),
            ))
        }
        ElicitationAnswer::Decline => CreateElicitationResponse::new(ElicitationAction::Decline),
        ElicitationAnswer::Cancel => CreateElicitationResponse::new(ElicitationAction::Cancel),
    }
}

/// Forward Grok `_x.ai/ask_user_question` to the frontend; timeout → cancel.
async fn await_grok_ask_user(
    app: &AgentEventEmitter,
    gate: &AskUserGate,
    runtime_session_id: &str,
    request: &GrokAskUserRequest,
) -> serde_json::Value {
    let params = &request.0;
    let questions = questions_to_dto(&params.questions);
    if questions.is_empty() {
        log::warn!(
            target: "agentero::agent",
            "grok ask_user_question with no valid questions; cancelling"
        );
        return cancelled_response();
    }

    let request_id = uuid::Uuid::new_v4().to_string();
    let mode = match params.mode.as_deref() {
        Some("plan") => "plan".to_string(),
        _ => "default".to_string(),
    };
    let rx = gate.register(&request_id);
    let _ = app.emit(
        "agent:ask-user-request",
        AskUserRequestEvent {
            request_id: request_id.clone(),
            session_id: runtime_session_id.to_string(),
            tool_call_id: Some(params.tool_call_id.clone()).filter(|s| !s.is_empty()),
            mode,
            questions,
        },
    );

    let answer = tokio::time::timeout(std::time::Duration::from_secs(300), rx).await;
    match answer {
        Ok(Ok(AskUserAnswer::Accepted { answers })) => {
            grok_response_from_answers(&params.questions, &answers)
        }
        _ => cancelled_response(),
    }
}

/// Forward form elicitation to the frontend; timeout → cancel.
async fn await_user_elicitation(
    app: &AgentEventEmitter,
    gate: &ElicitationGate,
    runtime_session_id: &str,
    request: &CreateElicitationRequest,
) -> CreateElicitationResponse {
    // URL elicitations: surface message only; user can open URL externally later.
    if matches!(request.mode, ElicitationMode::Url(_)) {
        log::debug!(
            target: "agentero::agent",
            "elicitation url mode not fully implemented; cancelling"
        );
        return CreateElicitationResponse::new(ElicitationAction::Cancel);
    }

    let request_id = uuid::Uuid::new_v4().to_string();
    let fields = elicitation_fields_from_request(request);
    let provider_session = session_id_from_elicitation(request);
    let tool_call_id = tool_call_id_from_elicitation(request);

    let rx = gate.register(&request_id);
    let _ = app.emit(
        "agent:elicitation-request",
        ElicitationRequestEvent {
            request_id: request_id.clone(),
            // Prefer Agentero runtime id so the chat panel can match the open run.
            session_id: runtime_session_id.to_string(),
            message: request.message.clone(),
            tool_call_id: tool_call_id.or(provider_session),
            fields,
        },
    );

    let answer = tokio::time::timeout(std::time::Duration::from_secs(300), rx).await;
    match answer {
        Ok(Ok(user)) => elicitation_response_from_answer(user),
        _ => CreateElicitationResponse::new(ElicitationAction::Cancel),
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
                    .send_request(client_initialize_request())
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

fn complete_run(
    app: &AgentEventEmitter,
    hidden_session_scope: Option<&HiddenSessionScope>,
    payload: AgentResultPayload,
) -> Result<AgentResultPayload, agent_client_protocol::Error> {
    // Persist the provider id before notifying the UI. A history refresh caused
    // by agent:completed must never race ahead of hidden-session registration.
    if let Some(scope) = hidden_session_scope {
        scope
            .record_completed(&payload)
            .map_err(|error| acp_err(format!("persist hidden Agent session: {error}")))?;
    }
    let _ = app.emit("agent:completed", payload.clone());
    Ok(payload)
}

/// One-shot prompt: spawn → initialize → session → prompt → stream events → completed/failed.
#[allow(clippy::too_many_arguments)]
pub async fn run_once(
    app: AgentEventEmitter,
    desc: AgentDescriptor,
    session_id: String,
    message_id: String,
    prompt: String,
    is_acp_command: bool,
    images: Vec<PromptImage>,
    workflow: Option<String>,
    target: Option<String>,
    vault_path: Option<String>,
    preferred_model_id: Option<String>,
    preferred_collaboration_mode_id: Option<String>,
    preferred_reasoning_effort: Option<String>,
    fast_mode: Option<bool>,
    skill_ids: Vec<String>,
    permission_policy: PermissionPolicy,
    permission_gate: PermissionGate,
    elicitation_gate: ElicitationGate,
    ask_user_gate: AskUserGate,
    response_language: Option<String>,
    personal_prompt: Option<String>,
    mut cancellation: watch::Receiver<bool>,
    remote: Option<crate::features::remote::RemoteAgentTarget>,
    resume_session_id: Option<String>,
    hidden_session_scope: Option<HiddenSessionScope>,
) -> Result<AgentResultPayload, AppError> {
    let skill_style = skill_mention_style(&desc.template);
    let skill_instructions = if is_acp_command {
        String::new()
    } else {
        // Skills: local vault path, or remote work_root after materializing SKILL.md from SFTP.
        let skill_vault = if let Some(ref r) = remote {
            if let Err(e) = crate::features::remote::materialize_skills_to_work(&r.session).await {
                log::warn!(target: "agentero::agent", "materialize remote skills: {e}");
            }
            Some(r.work_root.to_string_lossy().into_owned())
        } else {
            vault_path.clone()
        };
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
        }
    };
    let full_prompt = if is_acp_command {
        prompt.clone()
    } else {
        let user_prompt = if prompt.trim().is_empty() && !images.is_empty() {
            // Shared fallback for visual crops and general composer attachments.
            "Please analyze the attached image(s).".to_string()
        } else {
            prompt
        };
        // Prefix native skill triggers (e.g. Codex `$id`) so the CLI can activate them.
        let activation = skill_activation_prefix(&skill_ids, skill_style);
        let user_prompt = format!("{activation}{user_prompt}");
        format!(
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
        )
    };
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
    // session/load (and some resume paths) replay history as SessionNotification.
    // Until we open the gate, drop stream/tool/plan so turn N does not re-paint
    // turn N-1 into the new streaming bubble (Grok multi-turn).
    let live_stream = Arc::new(AtomicBool::new(resume_session_id.is_none()));
    let live_for_notif = live_stream.clone();

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
                if !live_for_notif.load(Ordering::SeqCst) {
                    // Still allow usage / command / config during load settle.
                    match &notification.update {
                        SessionUpdate::AvailableCommandsUpdate(_)
                        | SessionUpdate::ConfigOptionUpdate(_)
                        | SessionUpdate::UsageUpdate(_) => {
                            emit_rich_session_update(
                                &app_for_notif,
                                &session_for_notif,
                                &agent_id_for_notif,
                                &notification.update,
                            );
                        }
                        _ => {}
                    }
                    return Ok(());
                }
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
        .on_receive_request(
            {
                let app_for_elicit = app_for_conn.clone();
                let session_for_elicit = session_for_conn.clone();
                let elicitation_gate = elicitation_gate.clone();
                async move |request: CreateElicitationRequest, responder, _cx| {
                    let response = await_user_elicitation(
                        &app_for_elicit,
                        &elicitation_gate,
                        &session_for_elicit,
                        &request,
                    )
                    .await;
                    let _ = responder.respond(response);
                    Ok(())
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let app_for_ask = app_for_conn.clone();
                let session_for_ask = session_for_conn.clone();
                let ask_user_gate = ask_user_gate.clone();
                async move |request: GrokAskUserRequest, responder, _cx| {
                    let response =
                        await_grok_ask_user(&app_for_ask, &ask_user_gate, &session_for_ask, &request)
                            .await;
                    let _ = responder.respond(response);
                    Ok(())
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(acp, {
            let full_prompt = full_prompt.clone();
            let prompt_images = prompt_images.clone();
            let preferred_model = preferred_model_id.clone();
            let preferred_collaboration = preferred_collaboration_mode_id.clone();
            let preferred_effort = preferred_reasoning_effort.clone();
            let app_for_models = app_for_conn.clone();
            let session_for_models = session_for_conn.clone();
            let agent_id_for_models = desc.id.clone();
            let resume_id = resume_session_id.clone();
            let live_stream = live_stream.clone();
            let content_for_conn = content_for_conn.clone();
            let thought_for_conn = thought_for_conn.clone();
            let hidden_session_scope = hidden_session_scope.clone();
            move |connection: ConnectionTo<Agent>| async move {
                let init = tokio::select! {
                    result = timed_acp_request(
                        "initialize",
                        connection
                            .send_request(client_initialize_request())
                            .block_task(),
                    ) => result?,
                    () = wait_for_cancellation(&mut cancellation) => {
                        let payload = cancelled_payload(
                            session_for_conn.clone(),
                            message_for_conn.clone(),
                            None,
                            &content_for_conn,
                            &thought_for_conn,
                        );
                        return complete_run(
                            &app_for_conn,
                            hidden_session_scope.as_ref(),
                            payload,
                        );
                    }
                };

                // Capability-aware continue (Grok advertises loadSession but not
                // session/resume — calling resume yields Method not found).
                let can_resume = init
                    .agent_capabilities
                    .session_capabilities
                    .resume
                    .is_some();
                let can_load = init.agent_capabilities.load_session;

                let (acp_session_id, mut config_options) = if let Some(ref rid) = resume_id {
                    if can_resume {
                        let resp = tokio::select! {
                            result = timed_acp_request_with(
                                "session/resume",
                                ACP_SESSION_OPEN_TIMEOUT,
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
                                    Some(rid.clone()),
                                    &content_for_conn,
                                    &thought_for_conn,
                                );
                                return complete_run(
                                    &app_for_conn,
                                    hidden_session_scope.as_ref(),
                                    payload,
                                );
                            }
                        };
                        (
                            SessionId::new(rid.as_str()),
                            resp.config_options.unwrap_or_default(),
                        )
                    } else if can_load {
                        // Grok and similar: continue across process restarts via
                        // session/load (requires mcpServers; schema defaults to []).
                        let resp = tokio::select! {
                            result = timed_acp_request_with(
                                "session/load",
                                ACP_SESSION_OPEN_TIMEOUT,
                                connection
                                    .send_request(
                                        LoadSessionRequest::new(
                                            SessionId::new(rid.as_str()),
                                            cwd.clone(),
                                        )
                                        .mcp_servers(vec![]),
                                    )
                                    .block_task(),
                            ) => result?,
                            () = wait_for_cancellation(&mut cancellation) => {
                                let payload = cancelled_payload(
                                    session_for_conn.clone(),
                                    message_for_conn.clone(),
                                    Some(rid.clone()),
                                    &content_for_conn,
                                    &thought_for_conn,
                                );
                                return complete_run(
                                    &app_for_conn,
                                    hidden_session_scope.as_ref(),
                                    payload,
                                );
                            }
                        };
                        (
                            SessionId::new(rid.as_str()),
                            resp.config_options.unwrap_or_default(),
                        )
                    } else {
                        return Err(acp_err(format!(
                            "Agent does not support continuing session {rid} \
                             (no session/resume or session/load capability)"
                        )));
                    }
                } else {
                    let new_session = tokio::select! {
                        result = timed_acp_request_with(
                            "new_session",
                            ACP_SESSION_OPEN_TIMEOUT,
                            connection.send_request(NewSessionRequest::new(cwd)).block_task(),
                        ) => result?,
                        () = wait_for_cancellation(&mut cancellation) => {
                            let payload = cancelled_payload(
                                session_for_conn.clone(),
                                message_for_conn.clone(),
                                None,
                                &content_for_conn,
                                &thought_for_conn,
                            );
                            return complete_run(
                                &app_for_conn,
                                hidden_session_scope.as_ref(),
                                payload,
                            );
                        }
                    };
                    (
                        new_session.session_id,
                        new_session.config_options.unwrap_or_default(),
                    )
                };
                if let Some(scope) = hidden_session_scope.as_ref() {
					let provider_session_id = acp_session_id.to_string();
                    scope
						.record_provider_session(&provider_session_id)
                        .map_err(|error| {
                            acp_err(format!("persist hidden Agent session: {error}"))
                        })?;
                }
                macro_rules! return_cancelled {
                    () => {{
                        let payload = cancelled_payload(
                            session_for_conn.clone(),
                            message_for_conn.clone(),
                            Some(acp_session_id.to_string()),
                            &content_for_conn,
                            &thought_for_conn,
                        );
                        return complete_run(
                            &app_for_conn,
                            hidden_session_scope.as_ref(),
                            payload,
                        );
                    }};
                }
                if let Some(ev) = models_from_config_options(
                    &session_for_models,
                    &agent_id_for_models,
                    &config_options,
                ) {
                    // Model changes can affect supported effort and service tiers, so retain the
                    // complete response before resolving the remaining preferences.
                    // Also attempt custom / third-party model ids not in the advertised catalog
                    // (gateway models, cc-switch, free-form provider ids).
                    if let Some(pref) = preferred_model.clone() {
                        if pref != ev.current_id {
                            let listed = ev.models.iter().any(|m| m.id == pref);
                            let response = tokio::select! {
                                result = timed_acp_request(
                                    "set model",
                                    connection
                                        .send_request(SetSessionConfigOptionRequest::new(
                                            acp_session_id.clone(),
                                            SessionConfigId::new(ev.config_id.as_str()),
                                            SessionConfigOptionValue::value_id(pref.clone()),
                                        ))
                                        .block_task(),
                                ) => result,
                                () = wait_for_cancellation(&mut cancellation) => return_cancelled!(),
                            };
                            match response {
                                Ok(response) => {
                                    config_options = response.config_options;
                                }
                                Err(e) => {
                                    log::debug!(
                                        target: "agentero::agent",
                                        "agent={} set model failed (listed={}): pref={} err={}",
                                        agent_id_for_models,
                                        listed,
                                        pref,
                                        e
                                    );
                                }
                            }
                        }
                    }
                }
                if let Some(pref) = preferred_collaboration.clone() {
                    if let Some(ev) = collaboration_from_config_options(
                        &session_for_models,
                        &agent_id_for_models,
                        &config_options,
                    ) {
                        if pref != ev.current_id && ev.modes.iter().any(|mode| mode.id == pref) {
                            let response = tokio::select! {
                                result = timed_acp_request(
                                    "set collaboration mode",
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
                        Some(acp_session_id.to_string()),
                        &content_for_conn,
                        &thought_for_conn,
                    );
                    return complete_run(
                        &app_for_conn,
                        hidden_session_scope.as_ref(),
                        payload,
                    );
                }

                // After session/load|resume, drop any history-replay chunks that
                // arrived before this turn's prompt so completed.content and the
                // UI stream only reflect the new answer.
                if resume_id.is_some() {
                    if let Ok(mut buf) = content_for_conn.lock() {
                        buf.clear();
                    }
                    if let Ok(mut buf) = thought_for_conn.lock() {
                        buf.clear();
                    }
                }
                live_stream.store(true, Ordering::SeqCst);

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
                            .send_notification(CancelNotification::new(acp_session_id.clone()));
                        let payload = cancelled_payload(
                            session_for_conn.clone(),
                            message_for_conn.clone(),
                            Some(acp_session_id.to_string()),
                            &content_for_conn,
                            &thought_for_conn,
                        );
                        return complete_run(
                            &app_for_conn,
                            hidden_session_scope.as_ref(),
                            payload,
                        );
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
                complete_run(
                    &app_for_conn,
                    hidden_session_scope.as_ref(),
                    payload,
                )
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
    preferred_collaboration_mode_id: Option<String>,
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
    let preferred_collaboration = preferred_collaboration_mode_id.clone();
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
                if let SessionUpdate::AvailableCommandsUpdate(_) = &notification.update {
                    emit_rich_session_update(
                        &app_for_notif,
                        &session_for_notif,
                        &agent_for_notif,
                        &notification.update,
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
            let preferred_collaboration = preferred_collaboration.clone();
            let models_for_conn = models_for_conn.clone();
            move |connection: ConnectionTo<Agent>| async move {
                timed_acp_request(
                    "initialize",
                    connection
                        .send_request(client_initialize_request())
                        .block_task(),
                )
                .await?;

                let new_session = timed_acp_request_with(
                    "new_session",
                    ACP_SESSION_OPEN_TIMEOUT,
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
                    // Attempt preferred model even when not in the advertised catalog
                    // (third-party / gateway free-form ids).
                    if let Some(pref) = preferred.clone() {
                        if pref != ev.current_id {
                            let listed = ev.models.iter().any(|m| m.id == pref);
                            match timed_acp_request(
                                "set model",
                                connection
                                    .send_request(SetSessionConfigOptionRequest::new(
                                        acp_session_id.clone(),
                                        SessionConfigId::new(ev.config_id.as_str()),
                                        SessionConfigOptionValue::value_id(pref.clone()),
                                    ))
                                    .block_task(),
                            )
                            .await
                            {
                                Ok(response) => {
                                    config_options = response.config_options;
                                }
                                Err(e) => {
                                    log::debug!(
                                        target: "agentero::agent",
                                        "agent={} warm set model failed (listed={}): pref={} err={}",
                                        agent_for_conn,
                                        listed,
                                        pref,
                                        e
                                    );
                                }
                            }
                        }
                    }
                }
                if let Some(pref) = preferred_collaboration.clone() {
                    if let Some(ev) = collaboration_from_config_options(
                        &session_for_conn,
                        &agent_for_conn,
                        &config_options,
                    ) {
                        if pref != ev.current_id && ev.modes.iter().any(|mode| mode.id == pref) {
                            match timed_acp_request(
                                "set collaboration mode",
                                connection
                                    .send_request(SetSessionConfigOptionRequest::new(
                                        acp_session_id.clone(),
                                        SessionConfigId::new(ev.config_id.as_str()),
                                        SessionConfigOptionValue::value_id(pref.clone()),
                                    ))
                                    .block_task(),
                            )
                            .await
                            {
                                Ok(response) => {
                                    config_options = response.config_options;
                                }
                                Err(e) => {
                                    log::debug!(
                                        target: "agentero::agent",
                                        "agent={} warm set collaboration mode failed: pref={} err={}",
                                        agent_for_conn,
                                        pref,
                                        e
                                    );
                                }
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
                        .send_request(client_initialize_request())
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
                        .send_request(client_initialize_request())
                        .block_task(),
                )
                .await?;

                timed_acp_request(
                    "session/load",
                    connection
                        .send_request(
                            LoadSessionRequest::new(SessionId::new(sid.as_str()), cwd)
                                .mcp_servers(vec![]),
                        )
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
mod cancelled_payload_tests {
    use super::cancelled_payload;
    use std::sync::{Arc, Mutex};

    #[test]
    fn preserves_provider_session_id_after_cancel() {
        let content = Arc::new(Mutex::new("partial answer".to_string()));
        let thought = Arc::new(Mutex::new(String::new()));
        let payload = cancelled_payload(
            "runtime-session".to_string(),
            "message".to_string(),
            Some("provider-session".to_string()),
            &content,
            &thought,
        );

        assert_eq!(payload.stop_reason.as_deref(), Some("cancelled"));
        assert_eq!(
            payload.provider_session_id.as_deref(),
            Some("provider-session")
        );
        assert_eq!(payload.content, "partial answer");
    }
}

#[cfg(test)]
mod config_option_tests {
    use super::{
        collaboration_from_config_options, effort_from_config_options,
        fast_mode_from_config_options, models_from_config_options,
    };
    use agent_client_protocol::schema::v1::{
        SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelectOption,
    };

    #[test]
    fn ignores_permission_sandbox_mode_category() {
        let options = vec![SessionConfigOption::select(
            "mode",
            "Session mode",
            "read-only",
            vec![
                SessionConfigSelectOption::new("read-only", "Read-only").description("No writes"),
                SessionConfigSelectOption::new("agent", "Agent"),
            ],
        )
        .category(SessionConfigOptionCategory::Mode)];

        // Host does not surface ACP category:mode (sandbox); only collaboration_mode.
        assert!(collaboration_from_config_options("session", "codex", &options).is_none());
    }

    #[test]
    fn extracts_codex_collaboration_mode() {
        let options = vec![
            SessionConfigOption::select(
                "mode",
                "Session mode",
                "read-only",
                vec![
                    SessionConfigSelectOption::new("read-only", "Read-only"),
                    SessionConfigSelectOption::new("agent", "Agent"),
                ],
            )
            .category(SessionConfigOptionCategory::Mode),
            SessionConfigOption::select(
                "collaboration_mode",
                "Collaboration mode",
                "default",
                vec![
                    SessionConfigSelectOption::new("default", "Default"),
                    SessionConfigSelectOption::new("plan", "Plan")
                        .description("Plan before making changes"),
                ],
            )
            .category(SessionConfigOptionCategory::Other(
                "collaboration_mode".into(),
            )),
        ];

        let collab = collaboration_from_config_options("session", "codex", &options)
            .expect("collaboration mode should be exposed");
        assert_eq!(collab.config_id, "collaboration_mode");
        assert_eq!(collab.current_id, "default");
        assert_eq!(collab.modes.len(), 2);
        assert_eq!(collab.modes[1].id, "plan");
        assert_eq!(collab.modes[1].name, "Plan");
    }

    #[test]
    fn does_not_treat_fast_mode_as_session_mode() {
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

        assert!(collaboration_from_config_options("session", "codex", &options).is_none());
    }

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

    #[test]
    fn injects_current_model_when_missing_from_catalog() {
        let options = vec![SessionConfigOption::select(
            "model",
            "Model",
            "deepseek-chat",
            vec![
                SessionConfigSelectOption::new("gpt-5", "GPT-5"),
                SessionConfigSelectOption::new("gpt-4.1", "GPT-4.1"),
            ],
        )
        .category(SessionConfigOptionCategory::Model)];

        let models = models_from_config_options("session", "codex", &options)
            .expect("model selector should be exposed");
        assert_eq!(models.current_id, "deepseek-chat");
        assert_eq!(models.models[0].id, "deepseek-chat");
        assert!(models.models.iter().any(|m| m.id == "gpt-5"));
    }

    #[test]
    fn does_not_duplicate_current_when_already_listed() {
        let options = vec![SessionConfigOption::select(
            "model",
            "Model",
            "gpt-5",
            vec![
                SessionConfigSelectOption::new("gpt-5", "GPT-5"),
                SessionConfigSelectOption::new("gpt-4.1", "GPT-4.1"),
            ],
        )
        .category(SessionConfigOptionCategory::Model)];

        let models = models_from_config_options("session", "codex", &options)
            .expect("model selector should be exposed");
        assert_eq!(models.models.iter().filter(|m| m.id == "gpt-5").count(), 1);
    }
}

#[cfg(test)]
mod replay_builder_tests {
    use super::ReplayBuilder;
    use crate::features::agent::models::{AcpHistoryPart, AgentPlanEntry};

    fn plan(content: &str, status: &str) -> AgentPlanEntry {
        AgentPlanEntry {
            content: content.to_string(),
            status: status.to_string(),
            priority: "medium".to_string(),
        }
    }

    fn id(v: &str) -> Option<String> {
        Some(v.to_string())
    }

    #[test]
    fn keeps_user_turns_and_alternates_speakers() {
        let mut b = ReplayBuilder::default();
        b.push_user_chunk("first question".into(), id("u1"));
        b.push_agent_chunk(false, "first answer".into(), id("m1"));
        b.push_user_chunk("second question".into(), id("u2"));
        b.push_agent_chunk(false, "second answer".into(), id("m2"));

        let (lines, _) = b.finish();
        let shape: Vec<(&str, &str)> = lines
            .iter()
            .map(|l| (l.kind.as_str(), l.text.as_str()))
            .collect();
        assert_eq!(
            shape,
            vec![
                ("user", "first question"),
                ("agent", "first answer"),
                ("user", "second question"),
                ("agent", "second answer"),
            ]
        );
    }

    #[test]
    fn merges_chunks_sharing_a_message_id() {
        let mut b = ReplayBuilder::default();
        b.push_agent_chunk(false, "he".into(), id("m1"));
        b.push_agent_chunk(false, "llo".into(), id("m1"));

        let (lines, _) = b.finish();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].text, "hello");
        assert_eq!(lines[0].parts.len(), 1);
    }

    #[test]
    fn a_new_message_id_starts_a_new_part() {
        let mut b = ReplayBuilder::default();
        b.push_agent_chunk(false, "a".into(), id("m1"));
        b.push_agent_chunk(false, "b".into(), id("m2"));

        let (lines, _) = b.finish();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].parts.len(), 2);
        assert_eq!(lines[0].text, "ab");
    }

    #[test]
    fn preserves_interleaved_reasoning_and_answer_order() {
        let mut b = ReplayBuilder::default();
        b.push_agent_chunk(true, "think".into(), id("r1"));
        b.push_agent_chunk(false, "answer".into(), id("m1"));
        b.push_agent_chunk(true, "rethink".into(), id("r2"));

        let (lines, _) = b.finish();
        assert_eq!(lines.len(), 1);
        let kinds: Vec<&str> = lines[0]
            .parts
            .iter()
            .map(|p| match p {
                AcpHistoryPart::Reasoning { .. } => "reasoning",
                AcpHistoryPart::Text { .. } => "text",
                AcpHistoryPart::Tool { .. } => "tool",
                AcpHistoryPart::Plan { .. } => "plan",
            })
            .collect();
        assert_eq!(kinds, vec!["reasoning", "text", "reasoning"]);
        assert_eq!(lines[0].reasoning.as_deref(), Some("think\n\nrethink"));
    }

    #[test]
    fn agent_turns_recover_sources_from_replayed_text() {
        let mut b = ReplayBuilder::default();
        b.push_agent_chunk(
            false,
            "Answer.\n\n## Sources\n- papers/a/NOTES.md\n".into(),
            id("m1"),
        );

        let (lines, _) = b.finish();
        assert_eq!(lines[0].sources, vec!["papers/a/NOTES.md".to_string()]);
    }

    #[test]
    fn tool_updates_patch_the_existing_part_by_id() {
        let mut b = ReplayBuilder::default();
        b.apply_tool(
            "t1".into(),
            Some("Read file".into()),
            Some("read".into()),
            Some("pending".into()),
            None,
            None,
        );
        b.apply_tool(
            "t1".into(),
            None,
            None,
            Some("completed".into()),
            None,
            None,
        );

        let (lines, _) = b.finish();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].parts.len(), 1);
        let AcpHistoryPart::Tool { tool } = &lines[0].parts[0] else {
            panic!("expected a tool part");
        };
        assert_eq!(tool.title, "Read file");
        assert_eq!(tool.status, "completed");
    }

    #[test]
    fn plan_snapshots_replace_the_single_plan_part() {
        let mut b = ReplayBuilder::default();
        b.apply_plan(vec![plan("step one", "pending")]);
        b.apply_plan(vec![
            plan("step one", "completed"),
            plan("step two", "pending"),
        ]);

        let (lines, _) = b.finish();
        assert_eq!(lines[0].parts.len(), 1);
        let AcpHistoryPart::Plan { entries } = &lines[0].parts[0] else {
            panic!("expected a plan part");
        };
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].status, "completed");
    }

    #[test]
    fn drops_turns_without_any_content() {
        let mut b = ReplayBuilder::default();
        b.push_user_chunk("   ".into(), id("u1"));
        b.push_agent_chunk(false, "  ".into(), id("m1"));

        let (lines, _) = b.finish();
        assert!(lines.is_empty());
    }

    #[test]
    fn a_tool_only_turn_survives_the_empty_text_filter() {
        let mut b = ReplayBuilder::default();
        b.apply_tool("t1".into(), None, None, None, None, None);

        let (lines, _) = b.finish();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].text.is_empty());
        assert_eq!(lines[0].parts.len(), 1);
    }
}
