use crate::core::error::AppError;
use crate::features::agent::ask_user::{
    cancelled_response, grok_response_from_answers, questions_to_dto, AskUserAnswer, AskUserGate,
    AskUserRequestEvent, GrokAskUserRequest,
};
use crate::features::agent::discover::{path_entries, resolve_command};
use crate::features::agent::elicitation::{ElicitationAnswer, ElicitationGate};
use crate::features::agent::events::AgentEventEmitter;
use crate::features::agent::models::{
    AcpHistoryLine, AcpHistoryPart, AcpHistoryTool, AcpListSessionsResult, AcpLoadSessionResult,
    AcpSessionCapabilities, AcpSessionInfo, AgentCollaborationEvent, AgentCommand,
    AgentCommandInput, AgentCommandsEvent, AgentDescriptor, AgentEffortChoice, AgentEffortEvent,
    AgentFailedEvent, AgentFastModeEvent, AgentModeChoice, AgentModelChoice, AgentModelsEvent,
    AgentPlanEntry, AgentPlanEvent, AgentResultPayload, AgentSessionInfoEvent, AgentStreamEvent,
    AgentStreamKind, AgentTemplate, AgentToolEvent, AgentUsageEvent, ProbeResult, PromptImage,
    WarmResult,
};
use crate::features::agent::permission::PermissionGate;
use crate::features::agent::prompts::{build_prompt, extract_sources};
use crate::features::agent::skills::{
    load_skill_instructions, skill_activation_prefix, skill_mention_style,
};
use crate::features::agent::stream_coalesce::{StreamCoalescer, STREAM_COALESCE_WINDOW};
use crate::features::agent::terminal_acp::{AcpTerminalHandler, AcpTerminalManager};
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
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::watch;
use uuid::Uuid;

/// Advertise form elicitation so codex-acp bridges `request_user_input` to the client,
/// and terminal execution so agents like Kimi Code can run shell commands.
fn client_initialize_request() -> InitializeRequest {
    InitializeRequest::new(ProtocolVersion::V1).client_capabilities(
        ClientCapabilities::new()
            .elicitation(ElicitationCapabilities::new().form(ElicitationFormCapabilities::new()))
            .terminal(true),
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
    // cached credentials; our 15s ACP timeout kills the child before login can
    // finish, so the browser would pop up on every spawn. Sign-in must happen in
    // a terminal instead (BYOA).
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

/// `pi-acp` forwards pi's CLI startup banner (`pi v0.84.1` followed by a
/// Context / Skills / Extensions inventory) as a plain agent message right after
/// `session/new`, so it would otherwise render ahead of the actual answer.
fn is_pi_startup_banner(text: &str) -> bool {
    let mut lines = text.trim_start().lines();
    let Some(version) = lines.next().and_then(|l| l.trim().strip_prefix("pi v")) else {
        return false;
    };
    if !version.starts_with(|c: char| c.is_ascii_digit()) {
        return false;
    }
    lines
        .map(str::trim)
        .find(|line| !line.is_empty())
        .is_some_and(|line| line == "---" || line.starts_with("## "))
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

/// Value to write for the fast-mode option, or `None` when the session already
/// holds the requested value. Mirrors the `pref != current_id` guards used for
/// model/collaboration/effort so unchanged config skips the set_config RPC.
fn fast_mode_value_to_set(
    opt: &SessionConfigOption,
    enabled: bool,
) -> Option<SessionConfigOptionValue> {
    let target_id = if enabled { "on" } else { "off" };
    match &opt.kind {
        SessionConfigKind::Boolean(current) if current.current_value != enabled => {
            Some(SessionConfigOptionValue::boolean(enabled))
        }
        SessionConfigKind::Select(current) if current.current_value.0.as_ref() != target_id => {
            Some(SessionConfigOptionValue::value_id(target_id))
        }
        _ => None,
    }
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

/// Cap tool payloads relayed to the webview. `raw_input`/`raw_output` of
/// read/fetch-style tools can carry whole files (MBs) per ToolCallUpdate; the
/// transcript only renders a preview, so ship a bounded head + marker instead.
pub(crate) const TOOL_PAYLOAD_MAX_BYTES: usize = 32 * 1024;

pub(crate) fn cap_tool_payload(value: Option<serde_json::Value>) -> Option<serde_json::Value> {
    let value = value?;
    let serialized = serde_json::to_string(&value).unwrap_or_default();
    if serialized.len() <= TOOL_PAYLOAD_MAX_BYTES {
        return Some(value);
    }
    // Keep raw text for string payloads; other shapes fall back to their JSON.
    let source = match value {
        serde_json::Value::String(s) => s,
        _ => serialized,
    };
    let total = source.len();
    let mut cut = TOOL_PAYLOAD_MAX_BYTES.min(total);
    while cut > 0 && !source.is_char_boundary(cut) {
        cut -= 1;
    }
    Some(serde_json::Value::String(format!(
        "{}\n… [truncated {} of {} bytes]",
        &source[..cut],
        total - cut,
        total
    )))
}

fn emit_rich_session_update(
    app: &AgentEventEmitter,
    session_id: &str,
    agent_id: &str,
    notification: &SessionNotification,
) {
    match &notification.update {
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
                    input: cap_tool_payload(tc.raw_input.clone()),
                    output: cap_tool_payload(tc.raw_output.clone()),
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
                    input: cap_tool_payload(f.raw_input.clone()),
                    output: cap_tool_payload(f.raw_output.clone()),
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
        SessionUpdate::SessionInfoUpdate(info) => {
            use agent_client_protocol::schema::MaybeUndefined;
            let pick = |v: &MaybeUndefined<String>| match v {
                MaybeUndefined::Value(s) if !s.trim().is_empty() => Some(s.clone()),
                _ => None,
            };
            let title = pick(&info.title);
            let updated_at = pick(&info.updated_at);
            if title.is_none() && updated_at.is_none() {
                return;
            }
            let _ = app.emit(
                "agent:session-info",
                AgentSessionInfoEvent {
                    session_id: session_id.to_string(),
                    agent_id: agent_id.to_string(),
                    provider_session_id: Some(notification.session_id.to_string()),
                    title,
                    updated_at,
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

impl ElicitationFieldView {
    /// Build a field for the non-string schema arms (boolean / number / integer /
    /// array / unknown), which share one shape: title falls back to the field id,
    /// and there is no codex "other answer" metadata or parent linkage.
    fn plain(
        id: &str,
        title: Option<&str>,
        description: Option<&str>,
        required: bool,
        kind: &str,
        options: Vec<ElicitationOptionView>,
    ) -> Self {
        Self {
            id: id.to_string(),
            title: title.map(str::to_string).unwrap_or_else(|| id.to_string()),
            description: description.map(str::to_string),
            required,
            kind: kind.to_string(),
            options,
            is_other_answer: false,
            parent_field_id: None,
        }
    }
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
                ElicitationPropertySchema::Boolean(b) => ElicitationFieldView::plain(
                    id,
                    b.title.as_deref(),
                    b.description.as_deref(),
                    is_required,
                    "boolean",
                    vec![
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
                ),
                ElicitationPropertySchema::Number(n) => ElicitationFieldView::plain(
                    id,
                    n.title.as_deref(),
                    n.description.as_deref(),
                    is_required,
                    "number",
                    Vec::new(),
                ),
                ElicitationPropertySchema::Integer(n) => ElicitationFieldView::plain(
                    id,
                    n.title.as_deref(),
                    n.description.as_deref(),
                    is_required,
                    "number",
                    Vec::new(),
                ),
                ElicitationPropertySchema::Array(a) => ElicitationFieldView::plain(
                    id,
                    a.title.as_deref(),
                    a.description.as_deref(),
                    is_required,
                    "text",
                    Vec::new(),
                ),
                ElicitationPropertySchema::Other(_) | _ => {
                    ElicitationFieldView::plain(id, None, None, is_required, "other", Vec::new())
                }
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
    let terminals = Arc::new(tokio::sync::Mutex::new(AcpTerminalManager::new()));

    let connect = agent_client_protocol::Client
        .builder()
        .name("agentero")
        .with_handler(AcpTerminalHandler::new(terminals))
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

/// Input for one `run_once` turn. Collapses the previous 24 positional params.
pub struct RunOnceParams {
    pub app: AgentEventEmitter,
    pub desc: AgentDescriptor,
    pub session_id: String,
    pub message_id: String,
    pub prompt: String,
    pub is_acp_command: bool,
    pub images: Vec<PromptImage>,
    pub workflow: Option<String>,
    pub target: Option<String>,
    pub vault_path: Option<String>,
    pub preferred_model_id: Option<String>,
    pub preferred_collaboration_mode_id: Option<String>,
    pub preferred_reasoning_effort: Option<String>,
    pub fast_mode: Option<bool>,
    pub skill_ids: Vec<String>,
    pub permission_policy: PermissionPolicy,
    pub permission_gate: PermissionGate,
    pub elicitation_gate: ElicitationGate,
    pub ask_user_gate: AskUserGate,
    pub response_language: Option<String>,
    pub personal_prompt: Option<String>,
    pub cancellation: watch::Receiver<bool>,
    pub remote: Option<crate::features::remote::RemoteAgentTarget>,
    pub resume_session_id: Option<String>,
}

/// Prompt/cwd prepared before any ACP I/O.
struct RunTurnPrep {
    full_prompt: String,
    prompt_images: Vec<PromptImage>,
    cwd: PathBuf,
}

/// User-selected session preferences applied after the session opens.
struct RunPreferences {
    model_id: Option<String>,
    collaboration_mode_id: Option<String>,
    reasoning_effort: Option<String>,
    fast_mode: Option<bool>,
}

/// Everything the connection turn needs beyond the shared state.
struct RunTurnInput {
    full_prompt: String,
    prompt_images: Vec<PromptImage>,
    cwd: PathBuf,
    /// Provider session id to continue (resume/load) instead of `session/new`.
    resume_session_id: Option<String>,
    preferences: RunPreferences,
}

/// Session established by the connect phase of a turn.
struct ConnectedSession {
    acp_session_id: SessionId,
    config_options: Vec<SessionConfigOption>,
    /// Resolved provider resume id when continuing an earlier session
    /// (drives the history-replay buffer clear before the prompt).
    resume_id: Option<String>,
}

/// Outcome of a cancellable phase of the run turn.
enum TurnPhase<T> {
    /// The phase completed; the turn continues with this value.
    Ready(T),
    /// The run was cancelled; `agent:completed` was already emitted.
    Cancelled(AgentResultPayload),
}

/// Emit `agent:failed` for a run that could not start or complete.
fn emit_run_failed(app: &AgentEventEmitter, session_id: &str, error: &impl std::fmt::Display) {
    let _ = app.emit(
        "agent:failed",
        AgentFailedEvent {
            session_id: session_id.to_string(),
            error: error.to_string(),
        },
    );
}

/// Prompt-assembly phase: resolve skill instructions, template the prompt, and
/// pick the working directory. Emits `agent:failed` and errors when a selected
/// local skill cannot be loaded.
async fn prepare_run_turn(params: &RunOnceParams) -> Result<RunTurnPrep, AppError> {
    let skill_style = skill_mention_style(&params.desc.template);
    let skill_instructions = if params.is_acp_command {
        String::new()
    } else {
        // Skills: local vault path, or remote work_root after materializing SKILL.md from SFTP.
        let skill_vault = if let Some(ref r) = params.remote {
            if let Err(e) = crate::features::remote::materialize_skills_to_work(&r.session).await {
                log::warn!(target: "agentero::agent", "materialize remote skills: {e}");
            }
            Some(r.work_root.to_string_lossy().into_owned())
        } else {
            params.vault_path.clone()
        };
        match load_skill_instructions(&params.skill_ids, skill_vault.as_deref(), skill_style) {
            Ok(instructions) => instructions,
            Err(error) => {
                emit_run_failed(&params.app, &params.session_id, &error);
                return Err(error);
            }
        }
    };
    let full_prompt = if params.is_acp_command {
        params.prompt.clone()
    } else {
        let user_prompt = if params.prompt.trim().is_empty() && !params.images.is_empty() {
            // Shared fallback for visual crops and general composer attachments.
            "Please analyze the attached image(s).".to_string()
        } else {
            params.prompt.clone()
        };
        // Prefix native skill triggers (e.g. Codex `$id`) so the CLI can activate them.
        let activation = skill_activation_prefix(&params.skill_ids, skill_style);
        let user_prompt = format!("{activation}{user_prompt}");
        format!(
            "{}{}",
            build_prompt(
                params.workflow.as_deref(),
                &user_prompt,
                params.target.as_deref(),
                skill_style,
                &params.skill_ids,
                params.response_language.as_deref(),
                params.personal_prompt.as_deref(),
            ),
            skill_instructions
        )
    };
    let prompt_images = params.images.clone();
    let cwd = if let Some(ref r) = params.remote {
        r.agent_cwd()
    } else {
        params
            .vault_path
            .as_ref()
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    };
    Ok(RunTurnPrep {
        full_prompt,
        prompt_images,
        cwd,
    })
}

/// Shared state for one `run_once` turn, cloned into the ACP notification /
/// permission / elicitation handlers and the connection turn future.
#[derive(Clone)]
struct RunOnceContext {
    app: AgentEventEmitter,
    session_id: String,
    message_id: String,
    agent_id: String,
    /// pi-acp forwards a CLI startup banner that must be dropped from the stream.
    is_pi: bool,
    /// dsh keeps sessions in-process and never advertises resume/load, so a
    /// requested continue degrades to a fresh session — always stream live.
    dsh_fresh_sessions: bool,
    content_buf: Arc<Mutex<String>>,
    thought_buf: Arc<Mutex<String>>,
    coalescer: StreamCoalescer,
    /// session/load (and some resume paths) replay history as SessionNotification.
    /// Until we open the gate, drop stream/tool/plan so turn N does not re-paint
    /// turn N-1 into the new streaming bubble (Grok multi-turn).
    live_stream: Arc<AtomicBool>,
    stop_reason: Arc<Mutex<Option<String>>>,
    /// Terminal capability: headless command execution on behalf of the agent.
    terminals: Arc<tokio::sync::Mutex<AcpTerminalManager>>,
}

impl RunOnceContext {
    fn new(params: &RunOnceParams) -> Self {
        let dsh_fresh_sessions = matches!(params.desc.template, AgentTemplate::Dsh);
        // Merge token-storm chunks into ~25 emits/s (Windows webview jank source).
        // Payload shape is unchanged: same event, longer `chunk`, lower rate.
        let coalescer = StreamCoalescer::new(STREAM_COALESCE_WINDOW, {
            let app = params.app.clone();
            let session_id = params.session_id.clone();
            move |chunk, kind| {
                let _ = app.emit(
                    "agent:stream",
                    AgentStreamEvent {
                        session_id: session_id.clone(),
                        chunk,
                        kind,
                    },
                );
            }
        });
        Self {
            app: params.app.clone(),
            session_id: params.session_id.clone(),
            message_id: params.message_id.clone(),
            agent_id: params.desc.id.clone(),
            is_pi: matches!(params.desc.template, AgentTemplate::Pi),
            dsh_fresh_sessions,
            content_buf: Arc::new(Mutex::new(String::new())),
            thought_buf: Arc::new(Mutex::new(String::new())),
            coalescer,
            live_stream: Arc::new(AtomicBool::new(
                params.resume_session_id.is_none() || dsh_fresh_sessions,
            )),
            stop_reason: Arc::new(Mutex::new(None)),
            terminals: Arc::new(tokio::sync::Mutex::new(AcpTerminalManager::new())),
        }
    }

    /// Relay one `SessionNotification`: buffer + coalesce stream chunks, and
    /// forward rich updates (tool/plan/usage/config/commands) to the webview.
    fn relay_session_notification(&self, notification: &SessionNotification) {
        if !self.live_stream.load(Ordering::SeqCst) {
            // Still allow usage / command / config during load settle.
            match &notification.update {
                SessionUpdate::AvailableCommandsUpdate(_)
                | SessionUpdate::ConfigOptionUpdate(_)
                | SessionUpdate::UsageUpdate(_)
                | SessionUpdate::SessionInfoUpdate(_) => {
                    emit_rich_session_update(
                        &self.app,
                        &self.session_id,
                        &self.agent_id,
                        notification,
                    );
                }
                _ => {}
            }
            return;
        }
        if let Some((chunk, kind)) = stream_from_update(&notification.update) {
            let drop_banner = self.is_pi
                && matches!(kind, AgentStreamKind::Message)
                && is_pi_startup_banner(&chunk)
                && self
                    .content_buf
                    .lock()
                    .is_ok_and(|buffer| buffer.is_empty());
            if !drop_banner {
                match kind {
                    AgentStreamKind::Message => {
                        if let Ok(mut buf) = self.content_buf.lock() {
                            buf.push_str(&chunk);
                        }
                    }
                    AgentStreamKind::Thought => {
                        if let Ok(mut buf) = self.thought_buf.lock() {
                            buf.push_str(&chunk);
                        }
                    }
                }
                self.coalescer.push(&chunk, kind);
            }
        } else {
            // Non-chunk update (tool/plan/…): flush buffered text first
            // so the transcript order stays text → tool/plan.
            self.coalescer.flush();
        }
        emit_rich_session_update(&self.app, &self.session_id, &self.agent_id, notification);
    }

    /// Flush buffered stream text, then emit `agent:completed` (ordered after text).
    fn emit_completed(&self, payload: AgentResultPayload) -> AgentResultPayload {
        self.coalescer.flush();
        let _ = self.app.emit("agent:completed", payload.clone());
        payload
    }

    /// Build the cancelled payload, flush, and emit `agent:completed`.
    fn cancel_completed(&self, provider_session_id: Option<String>) -> AgentResultPayload {
        let payload = cancelled_payload(
            self.session_id.clone(),
            self.message_id.clone(),
            provider_session_id,
            &self.content_buf,
            &self.thought_buf,
        );
        self.emit_completed(payload)
    }

    /// Build the ACP client (stream + permission/elicitation/ask-user handlers),
    /// connect to the agent process, and run one prompt turn on the connection.
    async fn run(
        &self,
        acp: AcpAgent,
        params: RunOnceParams,
        prep: RunTurnPrep,
    ) -> Result<AgentResultPayload, agent_client_protocol::Error> {
        let RunOnceParams {
            permission_policy,
            permission_gate,
            elicitation_gate,
            ask_user_gate,
            cancellation,
            resume_session_id,
            preferred_model_id,
            preferred_collaboration_mode_id,
            preferred_reasoning_effort,
            fast_mode,
            ..
        } = params;
        let turn = RunTurnInput {
            full_prompt: prep.full_prompt,
            prompt_images: prep.prompt_images,
            cwd: prep.cwd,
            resume_session_id,
            preferences: RunPreferences {
                model_id: preferred_model_id,
                collaboration_mode_id: preferred_collaboration_mode_id,
                reasoning_effort: preferred_reasoning_effort,
                fast_mode,
            },
        };

        agent_client_protocol::Client
            .builder()
            .name("agentero")
            .with_handler(AcpTerminalHandler::new(self.terminals.clone()))
            .on_receive_notification(
                {
                    let state = self.clone();
                    async move |notification: SessionNotification, _cx| {
                        state.relay_session_notification(&notification);
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_request(
                {
                    let state = self.clone();
                    async move |request: RequestPermissionRequest, responder, _cx| {
                        let response = match permission_policy {
                            PermissionPolicy::Restricted => permission_response(&request, false),
                            PermissionPolicy::Auto => permission_response(&request, true),
                            PermissionPolicy::Ask => {
                                await_user_permission(
                                    &state.app,
                                    &permission_gate,
                                    &state.session_id,
                                    &request,
                                )
                                .await
                            }
                        };
                        let _ = responder.respond(response);
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let state = self.clone();
                    async move |request: CreateElicitationRequest, responder, _cx| {
                        let response = await_user_elicitation(
                            &state.app,
                            &elicitation_gate,
                            &state.session_id,
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
                    let state = self.clone();
                    async move |request: GrokAskUserRequest, responder, _cx| {
                        let response = await_grok_ask_user(
                            &state.app,
                            &ask_user_gate,
                            &state.session_id,
                            &request,
                        )
                        .await;
                        let _ = responder.respond(response);
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .connect_with(acp, {
                let state = self.clone();
                move |connection: ConnectionTo<Agent>| async move {
                    state.run_turn(connection, cancellation, turn).await
                }
            })
            .await
    }

    /// Run one prompt turn on an established connection:
    /// initialize → open/resume session → apply preferences → prompt → finalize.
    async fn run_turn(
        &self,
        connection: ConnectionTo<Agent>,
        mut cancellation: watch::Receiver<bool>,
        turn: RunTurnInput,
    ) -> Result<AgentResultPayload, agent_client_protocol::Error> {
        let RunTurnInput {
            full_prompt,
            prompt_images,
            cwd,
            resume_session_id,
            preferences,
        } = turn;

        let session = match self
            .connect_session(&connection, &mut cancellation, resume_session_id, &cwd)
            .await?
        {
            TurnPhase::Ready(session) => session,
            TurnPhase::Cancelled(payload) => return Ok(payload),
        };
        let config_options = match self
            .apply_session_preferences(
                &connection,
                &mut cancellation,
                &session.acp_session_id,
                session.config_options,
                &preferences,
            )
            .await?
        {
            TurnPhase::Ready(options) => options,
            TurnPhase::Cancelled(payload) => return Ok(payload),
        };
        emit_session_config_options(&self.app, &self.session_id, &self.agent_id, &config_options);

        if *cancellation.borrow() {
            let _ = connection
                .send_notification(CancelNotification::new(session.acp_session_id.clone()));
            return Ok(self.cancel_completed(Some(session.acp_session_id.to_string())));
        }

        // After session/load|resume, drop any history-replay chunks that
        // arrived before this turn's prompt so completed.content and the
        // UI stream only reflect the new answer.
        if session.resume_id.is_some() {
            if let Ok(mut buf) = self.content_buf.lock() {
                buf.clear();
            }
            if let Ok(mut buf) = self.thought_buf.lock() {
                buf.clear();
            }
        }
        self.live_stream.store(true, Ordering::SeqCst);

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
                    session.acp_session_id.clone(),
                    content_blocks,
                ))
                .block_task() => response.map_err(|e| acp_err(format!("prompt: {e}")))?,
            () = wait_for_cancellation(&mut cancellation) => {
                let _ = connection
                    .send_notification(CancelNotification::new(session.acp_session_id.clone()));
                return Ok(self.cancel_completed(Some(session.acp_session_id.to_string())));
            }
        };

        if let Ok(mut s) = self.stop_reason.lock() {
            *s = Some(format!("{:?}", prompt_response.stop_reason));
        }

        Ok(self.finalize(&session.acp_session_id))
    }

    /// Connect phase: `initialize`, then open a session via `session/resume`,
    /// `session/load`, or `session/new` (capability-aware).
    async fn connect_session(
        &self,
        connection: &ConnectionTo<Agent>,
        cancellation: &mut watch::Receiver<bool>,
        resume_session_id: Option<String>,
        cwd: &Path,
    ) -> Result<TurnPhase<ConnectedSession>, agent_client_protocol::Error> {
        let init = tokio::select! {
            result = timed_acp_request(
                "initialize",
                connection
                    .send_request(client_initialize_request())
                    .block_task(),
            ) => result?,
            () = wait_for_cancellation(&mut *cancellation) => {
                return Ok(TurnPhase::Cancelled(self.cancel_completed(None)));
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

        // dsh never advertises session/resume or session/load (sessions
        // die with the process), so continue degrades to a fresh session
        // instead of erroring out.
        let resume_id = if let Some(rid) = &resume_session_id {
            if can_resume || can_load {
                resume_session_id
            } else if self.dsh_fresh_sessions {
                log::debug!(
                    target: "agentero::agent",
                    "dsh cannot resume {rid}: starting a fresh session"
                );
                None
            } else {
                return Err(acp_err(format!(
                    "Agent does not support continuing session {rid} \
                     (no session/resume or session/load capability)"
                )));
            }
        } else {
            None
        };

        let (acp_session_id, config_options) = if let Some(ref rid) = resume_id {
            if can_resume {
                let resp = tokio::select! {
                    result = timed_acp_request(
                        "session/resume",
                        connection
                            .send_request(ResumeSessionRequest::new(
                                SessionId::new(rid.as_str()),
                                cwd.to_path_buf(),
                            ))
                            .block_task(),
                    ) => result?,
                    () = wait_for_cancellation(&mut *cancellation) => {
                        return Ok(TurnPhase::Cancelled(self.cancel_completed(Some(rid.clone()))));
                    }
                };
                (
                    SessionId::new(rid.as_str()),
                    resp.config_options.unwrap_or_default(),
                )
            } else {
                // resume_id is Some only when can_resume || can_load.
                // Grok and similar: continue across process restarts via
                // session/load (requires mcpServers; schema defaults to []).
                let resp = tokio::select! {
                    result = timed_acp_request(
                        "session/load",
                        connection
                            .send_request(
                                LoadSessionRequest::new(
                                    SessionId::new(rid.as_str()),
                                    cwd.to_path_buf(),
                                )
                                .mcp_servers(vec![]),
                            )
                            .block_task(),
                    ) => result?,
                    () = wait_for_cancellation(&mut *cancellation) => {
                        return Ok(TurnPhase::Cancelled(self.cancel_completed(Some(rid.clone()))));
                    }
                };
                (
                    SessionId::new(rid.as_str()),
                    resp.config_options.unwrap_or_default(),
                )
            }
        } else {
            let new_session = tokio::select! {
                result = timed_acp_request(
                    "new_session",
                    connection
                        .send_request(NewSessionRequest::new(cwd.to_path_buf()))
                        .block_task(),
                ) => result?,
                () = wait_for_cancellation(&mut *cancellation) => {
                    return Ok(TurnPhase::Cancelled(self.cancel_completed(None)));
                }
            };
            (
                new_session.session_id,
                new_session.config_options.unwrap_or_default(),
            )
        };

        Ok(TurnPhase::Ready(ConnectedSession {
            acp_session_id,
            config_options,
            resume_id,
        }))
    }

    /// Apply the user's model / collaboration / effort / fast-mode preferences
    /// via `set_config_option`, refreshing `config_options` after each write.
    async fn apply_session_preferences(
        &self,
        connection: &ConnectionTo<Agent>,
        cancellation: &mut watch::Receiver<bool>,
        acp_session_id: &SessionId,
        mut config_options: Vec<SessionConfigOption>,
        prefs: &RunPreferences,
    ) -> Result<TurnPhase<Vec<SessionConfigOption>>, agent_client_protocol::Error> {
        macro_rules! return_cancelled {
            () => {
                return Ok(TurnPhase::Cancelled(
                    self.cancel_completed(Some(acp_session_id.to_string())),
                ))
            };
        }
        if let Some(ev) =
            models_from_config_options(&self.session_id, &self.agent_id, &config_options)
        {
            // Model changes can affect supported effort and service tiers, so retain the
            // complete response before resolving the remaining preferences.
            // Also attempt custom / third-party model ids not in the advertised catalog
            // (gateway models, cc-switch, free-form provider ids).
            if let Some(pref) = prefs.model_id.clone() {
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
                        () = wait_for_cancellation(&mut *cancellation) => return_cancelled!(),
                    };
                    match response {
                        Ok(response) => {
                            config_options = response.config_options;
                        }
                        Err(e) => {
                            log::debug!(
                                target: "agentero::agent",
                                "agent={} set model failed (listed={}): pref={} err={}",
                                self.agent_id,
                                listed,
                                pref,
                                e
                            );
                        }
                    }
                }
            }
        }
        if let Some(pref) = prefs.collaboration_mode_id.clone() {
            if let Some(ev) =
                collaboration_from_config_options(&self.session_id, &self.agent_id, &config_options)
            {
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
                        () = wait_for_cancellation(&mut *cancellation) => return_cancelled!(),
                    };
                    if let Some(response) = response {
                        config_options = response.config_options;
                    }
                }
            }
        }
        if let Some(pref) = prefs.reasoning_effort.clone() {
            if let Some(ev) =
                effort_from_config_options(&self.session_id, &self.agent_id, &config_options)
            {
                if pref != ev.current_id && ev.efforts.iter().any(|effort| effort.id == pref) {
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
                        () = wait_for_cancellation(&mut *cancellation) => return_cancelled!(),
                    };
                    if let Some(response) = response {
                        config_options = response.config_options;
                    }
                }
            }
        }
        if let Some(enabled) = prefs.fast_mode {
            if let Some(opt) = config_options.iter().find(|opt| is_fast_option(opt)) {
                if let Some(value) = fast_mode_value_to_set(opt, enabled) {
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
                        () = wait_for_cancellation(&mut *cancellation) => return_cancelled!(),
                    };
                    if let Some(response) = response {
                        config_options = response.config_options;
                    }
                }
            }
        }
        Ok(TurnPhase::Ready(config_options))
    }

    /// Finalize phase: snapshot the streamed buffers into the result payload and
    /// emit `agent:completed`.
    fn finalize(&self, acp_session_id: &SessionId) -> AgentResultPayload {
        let content = self
            .content_buf
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default();
        let reasoning = self
            .thought_buf
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default();
        let sources = extract_sources(&content);
        let payload = AgentResultPayload {
            session_id: self.session_id.clone(),
            message_id: self.message_id.clone(),
            content,
            reasoning: if reasoning.is_empty() {
                None
            } else {
                Some(reasoning)
            },
            sources,
            stop_reason: self.stop_reason.lock().ok().and_then(|g| g.clone()),
            provider_session_id: Some(acp_session_id.to_string()),
        };
        self.emit_completed(payload)
    }
}

/// One-shot prompt: spawn → initialize → session → prompt → stream events → completed/failed.
pub async fn run_once(params: RunOnceParams) -> Result<AgentResultPayload, AppError> {
    // Phase 1 — prompt: skill instructions + template envelope + cwd.
    let prep = prepare_run_turn(&params).await?;

    // Phase 2 — spawn the ACP agent process (local, or SSH wrapper for remote).
    let acp = match to_acp_agent(&params.desc, params.remote.as_ref()) {
        Ok(agent) => agent,
        Err(error) => {
            emit_run_failed(&params.app, &params.session_id, &error);
            return Err(error);
        }
    };

    // Phase 3 — connect, stream one turn, and finalize.
    let state = RunOnceContext::new(&params);
    let run_result = state.run(acp, params, prep).await;

    match run_result {
        Ok(payload) => Ok(payload),
        Err(e) => {
            let msg = e.to_string();
            state.coalescer.flush();
            emit_run_failed(&state.app, &state.session_id, &msg);
            Err(AppError::domain("acp", format!("acp: {msg}")))
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
    let terminals = Arc::new(tokio::sync::Mutex::new(AcpTerminalManager::new()));

    let result = agent_client_protocol::Client
        .builder()
        .name("agentero")
        .with_handler(AcpTerminalHandler::new(terminals))
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
                        &notification,
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

/// Caps for `session/list` cursor walking.
pub(crate) const LIST_SESSIONS_BUDGET: std::time::Duration = std::time::Duration::from_secs(5);
pub(crate) const LIST_SESSIONS_MAX_PAGES: usize = 200;
pub(crate) const LIST_SESSIONS_MAX: usize = 500;

/// Stop paging `session/list`. An empty page is *not* a stop condition: codex-acp
/// pages over a global time window and filters by cwd inside each page, so pages
/// for one vault are often empty while more sessions remain behind the cursor.
pub(crate) fn list_sessions_page_done(
    next: Option<&str>,
    prev: Option<&str>,
    collected: usize,
    pages: usize,
    elapsed: std::time::Duration,
) -> bool {
    match next {
        None => true,
        // Agent stopped advancing; keep walking and we would loop forever.
        Some(next) => {
            next == prev.unwrap_or_default()
                || collected >= LIST_SESSIONS_MAX
                || pages >= LIST_SESSIONS_MAX_PAGES
                || elapsed >= LIST_SESSIONS_BUDGET
        }
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
    let terminals = Arc::new(tokio::sync::Mutex::new(AcpTerminalManager::new()));

    let result = agent_client_protocol::Client
        .builder()
        .name("agentero")
        .with_handler(AcpTerminalHandler::new(terminals))
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

                let started = std::time::Instant::now();
                let mut sessions: Vec<AcpSessionInfo> = Vec::new();
                let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
                let mut cursor = cursor;
                let mut pages = 0usize;

                loop {
                    let mut req = ListSessionsRequest::new().cwd(cwd.clone());
                    if let Some(ref c) = cursor {
                        req = req.cursor(c.clone());
                    }

                    let resp = timed_acp_request(
                        "session/list",
                        connection.send_request(req).block_task(),
                    )
                    .await?;
                    pages += 1;

                    for s in resp.sessions {
                        let session_id = s.session_id.to_string();
                        if !seen.insert(session_id.clone()) {
                            continue;
                        }
                        sessions.push(AcpSessionInfo {
                            session_id,
                            cwd: s.cwd.to_string_lossy().to_string(),
                            title: s.title,
                            updated_at: s.updated_at,
                        });
                    }

                    let next = resp.next_cursor;
                    let stalled = next.is_some() && next.as_deref() == cursor.as_deref();
                    if list_sessions_page_done(
                        next.as_deref(),
                        cursor.as_deref(),
                        sessions.len(),
                        pages,
                        started.elapsed(),
                    ) {
                        // Never hand back a cursor that did not advance.
                        cursor = if stalled { None } else { next };
                        break;
                    }
                    cursor = next;
                }

                Ok(AcpListSessionsResult {
                    sessions,
                    next_cursor: cursor,
                    supported: true,
                })
            }
        })
        .await;

    match result {
        Ok(r) => Ok(r),
        Err(e) => Err(AppError::domain("acp", format!("acp: list sessions: {e}"))),
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

/// Claude Code splices synthetic assistant messages into transcripts when a
/// turn ends without a reply (e.g. an interrupted turn), and adapters like
/// `claude-agent-acp` replay them verbatim on `session/load`. They are not
/// real answers, so drop them instead of showing them as the agent's reply
/// (#411).
fn is_synthetic_replay_placeholder(text: &str) -> bool {
    matches!(
        text.trim(),
        "No response requested."
            | "[Request interrupted by user]"
            | "[Request interrupted by user for tool use]"
    )
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
        for mut line in self.lines {
            if !line.is_user {
                line.parts.retain(|part| {
                    !matches!(part, AcpHistoryPart::Text { text } if is_synthetic_replay_placeholder(text))
                });
            }
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

/// Settle limits for `session/load` history replay. Agents push replayed turns
/// as `session/update` notifications without a completion marker, so wait until
/// they quiet down (`REPLAY_SETTLE_QUIET`) instead of always sleeping a fixed
/// 800 ms; `REPLAY_SETTLE_CAP` keeps the previous worst-case capture window.
const REPLAY_SETTLE_CAP: std::time::Duration = std::time::Duration::from_millis(800);
const REPLAY_SETTLE_QUIET: std::time::Duration = std::time::Duration::from_millis(200);
const REPLAY_SETTLE_POLL: std::time::Duration = std::time::Duration::from_millis(50);

pub async fn load_acp_session(
    desc: &AgentDescriptor,
    session_id: String,
    cwd: PathBuf,
    remote: Option<&crate::features::remote::RemoteAgentTarget>,
) -> Result<AcpLoadSessionResult, AppError> {
    let acp = to_acp_agent(desc, remote)?;

    let builder: Arc<Mutex<ReplayBuilder>> = Arc::new(Mutex::new(ReplayBuilder::default()));
    let builder_for_notif = builder.clone();
    // Last time a replay notification arrived; lets the settle loop below wait
    // on actual replay activity instead of a fixed sleep.
    let last_replay: Arc<Mutex<std::time::Instant>> =
        Arc::new(Mutex::new(std::time::Instant::now()));
    let last_replay_for_notif = last_replay.clone();
    let terminals = Arc::new(tokio::sync::Mutex::new(AcpTerminalManager::new()));

    let result = agent_client_protocol::Client
        .builder()
        .name("agentero")
        .with_handler(AcpTerminalHandler::new(terminals))
        .on_receive_notification(
            async move |notification: SessionNotification, _cx| {
                if let Ok(mut at) = last_replay_for_notif.lock() {
                    *at = std::time::Instant::now();
                }
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
            let last_replay = last_replay.clone();
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

                // Settle until replayed notifications quiet down instead of always
                // sleeping 800 ms; the capture window stays capped at 800 ms.
                let settle_start = std::time::Instant::now();
                loop {
                    tokio::time::sleep(REPLAY_SETTLE_POLL).await;
                    let last = last_replay
                        .lock()
                        .map(|at| *at)
                        .unwrap_or_else(|_| std::time::Instant::now());
                    if last.elapsed() >= REPLAY_SETTLE_QUIET
                        || settle_start.elapsed() >= REPLAY_SETTLE_CAP
                    {
                        break;
                    }
                }
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
        Err(e) => Err(AppError::domain("acp", format!("acp: load session: {e}"))),
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
mod pi_startup_banner_tests {
    use super::is_pi_startup_banner;

    #[test]
    fn matches_pi_acp_startup_banner() {
        let banner = "pi v0.84.1\n---\n\n## Context\n- /vault/AGENTS.md\n\n\
                      ## Skills\n- /home/me/.agents/skills/paper-reader/SKILL.md\n";
        assert!(is_pi_startup_banner(banner));
    }

    #[test]
    fn matches_banner_without_version_separator() {
        assert!(is_pi_startup_banner(
            "pi v1.0.0\n\n## Extensions\n- npm:pi-ext\n"
        ));
    }

    #[test]
    fn rejects_normal_answers() {
        assert!(!is_pi_startup_banner(""));
        assert!(!is_pi_startup_banner("Hello, here is the summary."));
        assert!(!is_pi_startup_banner(
            "pi v0.84.1 is the installed version."
        ));
        assert!(!is_pi_startup_banner("pi version\n---\n"));
    }
}

#[cfg(test)]
mod config_option_tests {
    use super::{
        collaboration_from_config_options, effort_from_config_options,
        fast_mode_from_config_options, fast_mode_value_to_set, models_from_config_options,
    };
    use agent_client_protocol::schema::v1::{
        SessionConfigOption, SessionConfigOptionCategory, SessionConfigOptionValue,
        SessionConfigSelectOption,
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
    fn skips_fast_mode_set_when_select_already_matches() {
        let option = SessionConfigOption::select(
            "fast-mode",
            "Fast mode",
            "on",
            vec![
                SessionConfigSelectOption::new("off", "Off"),
                SessionConfigSelectOption::new("on", "On"),
            ],
        )
        .category(SessionConfigOptionCategory::ModelConfig);

        assert_eq!(fast_mode_value_to_set(&option, true), None);
        assert_eq!(
            fast_mode_value_to_set(&option, false),
            Some(SessionConfigOptionValue::value_id("off"))
        );
    }

    #[test]
    fn skips_fast_mode_set_when_boolean_already_matches() {
        let option = SessionConfigOption::boolean("fast-mode", "Fast mode", true)
            .category(SessionConfigOptionCategory::ModelConfig);

        assert_eq!(fast_mode_value_to_set(&option, true), None);
        assert_eq!(
            fast_mode_value_to_set(&option, false),
            Some(SessionConfigOptionValue::boolean(false))
        );
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

    #[test]
    fn drops_synthetic_placeholder_agent_turns() {
        let mut b = ReplayBuilder::default();
        b.push_user_chunk("question".into(), id("u1"));
        b.push_agent_chunk(false, "No response requested.".into(), id("m1"));

        let (lines, _) = b.finish();
        let shape: Vec<(&str, &str)> = lines
            .iter()
            .map(|l| (l.kind.as_str(), l.text.as_str()))
            .collect();
        assert_eq!(shape, vec![("user", "question")]);
    }

    #[test]
    fn keeps_real_parts_in_turns_mixed_with_a_placeholder() {
        let mut b = ReplayBuilder::default();
        b.push_agent_chunk(true, "thinking".into(), id("r1"));
        b.apply_tool(
            "t1".into(),
            Some("Read file".into()),
            None,
            None,
            None,
            None,
        );
        b.push_agent_chunk(false, "No response requested.".into(), id("m1"));

        let (lines, _) = b.finish();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].parts.len(), 2);
        assert!(matches!(
            lines[0].parts[0],
            AcpHistoryPart::Reasoning { .. }
        ));
        assert!(matches!(lines[0].parts[1], AcpHistoryPart::Tool { .. }));
        assert!(lines[0].text.is_empty());
    }
}
