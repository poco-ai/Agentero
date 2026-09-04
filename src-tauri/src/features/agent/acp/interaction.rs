use crate::features::agent::acp::ask_user::{
    cancelled_response, grok_response_from_answers, questions_to_dto, AskUserRequestEvent,
    GrokAskUserRequest,
};
use crate::features::agent::runtime::events::AgentEventEmitter;
use crate::features::agent::runtime::gates::{
    AskUserAnswer, AskUserGate, ElicitationAnswer, ElicitationGate, PermissionGate,
};
use agent_client_protocol::schema::v1::{
    CreateElicitationRequest, CreateElicitationResponse, ElicitationAcceptAction,
    ElicitationAction, ElicitationContentValue, ElicitationMode, ElicitationPropertySchema,
    ElicitationScope, PermissionOptionKind, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SelectedPermissionOutcome,
};
use std::collections::{BTreeMap, HashSet};

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
pub(crate) struct PermissionRequestEvent {
    pub(crate) request_id: String,
    pub(crate) session_id: String,
    pub(crate) title: String,
    pub(crate) kind: Option<String>,
    pub(crate) paths: Vec<String>,
    pub(crate) options: Vec<PermissionOptionView>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PermissionOptionView {
    pub(crate) option_id: String,
    pub(crate) name: String,
    pub(crate) kind: String,
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
pub(crate) struct ElicitationFieldView {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) description: Option<String>,
    pub(crate) required: bool,
    /// select | text | boolean | number | other
    pub(crate) kind: String,
    pub(crate) options: Vec<ElicitationOptionView>,
    /// Codex companion free-text for "Other" (same logical question).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(crate) is_other_answer: bool,
    /// Parent question field id when `is_other_answer`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) parent_field_id: Option<String>,
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
pub(crate) struct ElicitationOptionView {
    pub(crate) value: String,
    pub(crate) title: String,
    pub(crate) description: Option<String>,
}

/// Payload for `agent:elicitation-request`.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ElicitationRequestEvent {
    pub(crate) request_id: String,
    /// Agentero runtime session id (correlates with the active chat run).
    pub(crate) session_id: String,
    pub(crate) message: String,
    /// Optional ACP provider tool call id when the elicitation is scoped to a tool.
    pub(crate) tool_call_id: Option<String>,
    pub(crate) fields: Vec<ElicitationFieldView>,
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

pub(crate) fn elicitation_fields_from_request(
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

pub(crate) fn session_id_from_elicitation(request: &CreateElicitationRequest) -> Option<String> {
    match request.mode.scope() {
        ElicitationScope::Session(s) => Some(s.session_id.to_string()),
        ElicitationScope::Request(_) | _ => None,
    }
}

pub(crate) fn tool_call_id_from_elicitation(request: &CreateElicitationRequest) -> Option<String> {
    match request.mode.scope() {
        ElicitationScope::Session(s) => s.tool_call_id.as_ref().map(|id| id.to_string()),
        ElicitationScope::Request(_) | _ => None,
    }
}

pub(crate) fn elicitation_response_from_answer(
    answer: ElicitationAnswer,
) -> CreateElicitationResponse {
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
pub(crate) async fn await_grok_ask_user(
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
pub(crate) async fn await_user_elicitation(
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
pub(crate) async fn await_user_permission(
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
