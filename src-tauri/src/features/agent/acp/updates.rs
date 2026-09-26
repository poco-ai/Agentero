use crate::features::agent::models::{
    AgentCollaborationEvent, AgentCommand, AgentCommandInput, AgentCommandsEvent,
    AgentEffortChoice, AgentEffortEvent, AgentFastModeEvent, AgentModeChoice, AgentModelChoice,
    AgentModelsEvent, AgentPlanEntry, AgentPlanEvent, AgentSessionInfoEvent, AgentStatusEvent,
    AgentStreamKind, AgentToolEvent, AgentUsageEvent,
};
use crate::features::agent::runtime::events::AgentEventEmitter;
use agent_client_protocol::schema::v1::{
    AvailableCommandInput, PlanEntryPriority, PlanEntryStatus, SessionConfigKind,
    SessionConfigOption, SessionConfigOptionCategory, SessionConfigOptionValue,
    SessionConfigSelectOptions, SessionNotification, SessionUpdate, ToolCallStatus, ToolKind,
};
use agent_client_protocol::schema::MaybeUndefined;
use std::collections::HashSet;

pub(crate) fn stream_from_update(update: &SessionUpdate) -> Option<(String, AgentStreamKind)> {
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

pub(crate) fn text_from_content_block(
    block: &agent_client_protocol::schema::v1::ContentBlock,
) -> Option<String> {
    match block {
        agent_client_protocol::schema::v1::ContentBlock::Text(t) => Some(t.text.clone()),
        _ => None,
    }
}

/// `pi-acp` forwards pi's CLI startup banner (`pi v0.84.1` followed by a
/// Context / Skills / Extensions inventory) as a plain agent message right after
/// `session/new`, so it would otherwise render ahead of the actual answer.
pub(crate) fn is_pi_startup_banner(text: &str) -> bool {
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

pub(crate) fn tool_status_str(s: ToolCallStatus) -> &'static str {
    match s {
        ToolCallStatus::Pending => "pending",
        ToolCallStatus::InProgress => "in_progress",
        ToolCallStatus::Completed => "completed",
        ToolCallStatus::Failed => "failed",
        _ => "pending",
    }
}

pub(crate) fn tool_kind_str(k: ToolKind) -> &'static str {
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

pub(crate) fn plan_status_str(s: &PlanEntryStatus) -> &'static str {
    match s {
        PlanEntryStatus::Pending => "pending",
        PlanEntryStatus::InProgress => "in_progress",
        PlanEntryStatus::Completed => "completed",
        _ => "pending",
    }
}

pub(crate) fn plan_priority_str(p: &PlanEntryPriority) -> &'static str {
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

fn model_group_from_id(id: &str) -> Option<String> {
    id.split_once(':')
        .or_else(|| id.split_once('/'))
        .map(|(prefix, _)| prefix.trim().to_string())
        .filter(|g| !g.is_empty())
}

fn first_string<'a>(value: &'a serde_json::Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(|v| v.as_str()))
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn session_models_object(value: &serde_json::Value) -> Option<&serde_json::Value> {
    value
        .get("models")
        .or_else(|| value.pointer("/_meta/models"))
        .or_else(|| value.pointer("/_meta/opencode/models"))
}

pub(crate) fn richer_models_event(
    config: Option<AgentModelsEvent>,
    raw: Option<AgentModelsEvent>,
) -> Option<AgentModelsEvent> {
    match (config, raw) {
        (Some(config), Some(raw)) => {
            if raw.models.len() > config.models.len() {
                log::debug!(
                    target: "agentero::agent",
                    "agent={} using raw session models over config options: raw={} config={}",
                    raw.agent_id,
                    raw.models.len(),
                    config.models.len()
                );
                Some(raw)
            } else {
                Some(config)
            }
        }
        (Some(config), None) => Some(config),
        (None, Some(raw)) => Some(raw),
        (None, None) => None,
    }
}

/// Fallback model selector extraction for agents that still expose the
/// pre-stabilization top-level `models` field on `session/new` (e.g. hermes-agent
/// before it migrated to `configOptions`, see NousResearch/hermes-agent#81067).
///
/// The official ACP Rust schema drops the field on deserialize, so the caller
/// passes the raw `session/new` response `serde_json::Value` (obtained via an
/// `UntypedMessage` request) and we read `result.models` here.
///
/// Shape: `{ "models": { "availableModels": [{ "modelId", "name", ... }],
///                       "currentModelId": "..." } }`.
/// OpenCode 2.x can also place this object under `_meta.models`; keep parsing
/// both so a partial ACP `configOptions` catalog does not hide custom providers.
pub(crate) fn models_from_session_models_value(
    session_id: &str,
    agent_id: &str,
    value: &serde_json::Value,
) -> Option<AgentModelsEvent> {
    let models_obj = session_models_object(value)?;

    let available = models_obj
        .get("availableModels")
        .or_else(|| models_obj.get("available_models"))?
        .as_array()?;
    let mut models = Vec::with_capacity(available.len());
    for entry in available {
        let id = first_string(entry, &["modelId", "model_id", "id", "value"])?.to_string();
        if id.is_empty() {
            continue;
        }
        let name = first_string(entry, &["name", "label", "displayName", "title"])
            .unwrap_or(&id)
            .to_string();
        let group =
            first_string(entry, &["provider", "providerId", "provider_id"]).map(str::to_string);
        let group = group.or_else(|| model_group_from_id(&id));
        models.push(AgentModelChoice { id, name, group });
    }
    let mut models = dedupe_model_choices(models);
    if models.is_empty() {
        return None;
    }

    let current_id = first_string(
        models_obj,
        &[
            "currentModelId",
            "current_model_id",
            "currentModel",
            "current",
        ],
    )
    .unwrap_or_default()
    .to_string();
    if !current_id.is_empty() && !models.iter().any(|m| m.id == current_id) {
        models.insert(
            0,
            AgentModelChoice {
                id: current_id.clone(),
                name: current_id.clone(),
                group: None,
            },
        );
    }
    let current_id = if current_id.is_empty() {
        models[0].id.clone()
    } else {
        current_id
    };

    log::debug!(
        target: "agentero::agent",
        "agent={} using legacy top-level session models field: count={} current={}",
        agent_id,
        models.len(),
        current_id
    );
    Some(AgentModelsEvent {
        session_id: session_id.to_string(),
        agent_id: agent_id.to_string(),
        // The legacy field carries no config option id; the picker only needs a
        // stable key for persistence, and "model" matches the standard option id.
        config_id: "model".to_string(),
        current_id,
        models,
    })
}

/// Extract model selector catalog from ACP session config options.
pub(crate) fn models_from_config_options(
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

pub(crate) fn is_fast_option(opt: &SessionConfigOption) -> bool {
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
pub(crate) fn collaboration_from_config_options(
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

pub(crate) fn effort_from_config_options(
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

pub(crate) fn fast_mode_from_config_options(
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
pub(crate) fn fast_mode_value_to_set(
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

pub(crate) fn emit_session_config_options(
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

pub(crate) fn emit_rich_session_update(
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
            // Upstream reconnects surface as `_meta.error` (e.g. codex-acp's
            // "Reconnecting... 2/5") with no title/updated_at — forward them as
            // `agent:status` so the UI can show a reconnecting state.
            if let Some(detail) = reconnect_detail(info) {
                let _ = app.emit(
                    "agent:status",
                    AgentStatusEvent::reconnecting(session_id, Some(detail)),
                );
            }
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

/// Extract the upstream reconnect counter from a `SessionInfoUpdate`'s
/// `_meta.error` (codex-acp emits `"Reconnecting... 2/5"` on upstream loss).
/// Returns `Some("2/5")` only for reconnect messages carrying a `n/m` token;
/// missing meta, unrelated errors, or a missing counter yield `None`.
pub(crate) fn reconnect_detail(
    info: &agent_client_protocol::schema::v1::SessionInfoUpdate,
) -> Option<String> {
    let error = info.meta.as_ref()?.get("error")?.as_str()?.trim();
    if !error.to_ascii_lowercase().starts_with("reconnect") {
        return None;
    }
    let token = error.split_whitespace().next_back()?;
    let (attempts, total) = token.split_once('/')?;
    if attempts.is_empty()
        || total.is_empty()
        || !attempts.bytes().all(|b| b.is_ascii_digit())
        || !total.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    Some(token.to_string())
}

#[cfg(test)]
mod reconnect_detail_tests {
    use super::reconnect_detail;
    use agent_client_protocol::schema::v1::SessionInfoUpdate;

    fn info_with_meta(error: Option<&str>) -> SessionInfoUpdate {
        let mut info = SessionInfoUpdate::new();
        if let Some(error) = error {
            let mut meta = serde_json::Map::new();
            meta.insert("error".to_string(), serde_json::json!(error));
            info.meta = Some(meta);
        }
        info
    }

    #[test]
    fn extracts_reconnect_counter() {
        assert_eq!(
            reconnect_detail(&info_with_meta(Some("Reconnecting... 2/5"))),
            Some("2/5".to_string())
        );
        assert_eq!(
            reconnect_detail(&info_with_meta(Some("reconnecting 10/30"))),
            Some("10/30".to_string())
        );
    }

    #[test]
    fn missing_meta_or_unrelated_error_yields_none() {
        assert_eq!(reconnect_detail(&info_with_meta(None)), None);
        assert_eq!(
            reconnect_detail(&info_with_meta(Some("request timed out"))),
            None
        );
        assert_eq!(
            reconnect_detail(&info_with_meta(Some("responseStreamDisconnected"))),
            None
        );
    }

    #[test]
    fn reconnect_without_counter_yields_none() {
        assert_eq!(
            reconnect_detail(&info_with_meta(Some("Reconnecting..."))),
            None
        );
        assert_eq!(
            reconnect_detail(&info_with_meta(Some("Reconnecting soon 2/x"))),
            None
        );
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
mod session_models_fallback_tests {
    use super::{
        models_from_config_options, models_from_session_models_value, richer_models_event,
    };
    use agent_client_protocol::schema::v1::{
        SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelectOption,
    };

    #[test]
    fn parses_legacy_top_level_models_field() {
        let value = serde_json::json!({
            "sessionId": "sess-1",
            "models": {
                "availableModels": [
                    { "modelId": "moa:default", "name": "Mixture of Agents · default", "description": "Provider: Mixture of Agents" },
                    { "modelId": "opencode-zen:claude-fable-5-1", "name": "OpenCode Zen · claude-fable-5-1" },
                    { "modelId": "opencode-zen:deepseek-v4.1-flash", "name": "OpenCode Zen · deepseek-v4.1-flash" }
                ],
                "currentModelId": "opencode-zen:claude-fable-5-1"
            }
        });

        let ev = models_from_session_models_value("sess-1", "hermes", &value)
            .expect("legacy models field should be parsed");
        assert_eq!(ev.config_id, "model");
        assert_eq!(ev.current_id, "opencode-zen:claude-fable-5-1");
        assert_eq!(ev.models.len(), 3);
        assert!(ev.models.iter().any(|m| m.id == "moa:default"));
        // provider prefix becomes the picker group
        let zen = ev
            .models
            .iter()
            .find(|m| m.id == "opencode-zen:deepseek-v4.1-flash")
            .expect("zen model");
        assert_eq!(zen.group.as_deref(), Some("opencode-zen"));
    }

    #[test]
    fn parses_opencode_meta_models_and_slash_provider_groups() {
        let value = serde_json::json!({
            "sessionId": "sess-1",
            "_meta": {
                "models": {
                    "availableModels": [
                        { "modelId": "github-copilot/claude-sonnet-4.5", "name": "Claude Sonnet 4.5" },
                        { "modelId": "custom-gateway/my-model", "name": "My Model" }
                    ],
                    "currentModelId": "custom-gateway/my-model"
                }
            }
        });

        let ev = models_from_session_models_value("sess-1", "opencode", &value)
            .expect("opencode meta models should be parsed");
        assert_eq!(ev.current_id, "custom-gateway/my-model");
        assert_eq!(ev.models.len(), 2);
        let custom = ev
            .models
            .iter()
            .find(|m| m.id == "custom-gateway/my-model")
            .expect("custom provider model");
        assert_eq!(custom.group.as_deref(), Some("custom-gateway"));
    }

    #[test]
    fn raw_session_models_win_when_catalog_is_more_complete() {
        let config_options = vec![SessionConfigOption::select(
            "model",
            "Model",
            "opencode/gpt-5",
            vec![SessionConfigSelectOption::new(
                "opencode/gpt-5",
                "OpenCode · GPT-5",
            )],
        )
        .category(SessionConfigOptionCategory::Model)];
        let config = models_from_config_options("sess-1", "opencode", &config_options);
        let raw = models_from_session_models_value(
            "sess-1",
            "opencode",
            &serde_json::json!({
                "sessionId": "sess-1",
                "models": {
                    "availableModels": [
                        { "modelId": "opencode/gpt-5", "name": "OpenCode · GPT-5" },
                        { "modelId": "custom-gateway/deepseek-chat", "name": "Custom · deepseek-chat" }
                    ],
                    "currentModelId": "custom-gateway/deepseek-chat"
                }
            }),
        );

        let ev = richer_models_event(config, raw).expect("models");
        assert_eq!(ev.current_id, "custom-gateway/deepseek-chat");
        assert_eq!(ev.models.len(), 2);
        assert!(ev
            .models
            .iter()
            .any(|m| m.id == "custom-gateway/deepseek-chat"));
    }

    #[test]
    fn returns_none_when_models_field_missing() {
        let value = serde_json::json!({ "sessionId": "sess-1" });
        assert!(models_from_session_models_value("sess-1", "hermes", &value).is_none());
    }

    #[test]
    fn returns_none_when_available_models_empty() {
        let value = serde_json::json!({
            "sessionId": "sess-1",
            "models": { "availableModels": [], "currentModelId": "x" }
        });
        assert!(models_from_session_models_value("sess-1", "hermes", &value).is_none());
    }

    #[test]
    fn injects_current_model_when_not_in_available_list() {
        let value = serde_json::json!({
            "sessionId": "sess-1",
            "models": {
                "availableModels": [
                    { "modelId": "moa:default", "name": "Mixture of Agents · default" }
                ],
                "currentModelId": "gateway:custom-model"
            }
        });

        let ev = models_from_session_models_value("sess-1", "hermes", &value).expect("models");
        assert_eq!(ev.current_id, "gateway:custom-model");
        assert_eq!(ev.models[0].id, "gateway:custom-model");
        assert!(ev.models.iter().any(|m| m.id == "moa:default"));
    }

    #[test]
    fn defaults_current_to_first_model_when_absent() {
        let value = serde_json::json!({
            "sessionId": "sess-1",
            "models": {
                "availableModels": [
                    { "modelId": "moa:default", "name": "Mixture of Agents · default" }
                ]
            }
        });

        let ev = models_from_session_models_value("sess-1", "hermes", &value).expect("models");
        assert_eq!(ev.current_id, "moa:default");
    }
}
