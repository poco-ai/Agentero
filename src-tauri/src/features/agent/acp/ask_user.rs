//! Grok Build ACP extension: `_x.ai/ask_user_question` / `x.ai/ask_user_question`.
//!
//! Not an ACP-standard tool or elicitation — a vendor ext method that blocks the
//! agent turn until the client returns `{ outcome, answers }`.

use agent_client_protocol::{util, Error, JsonRpcMessage, JsonRpcRequest};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Wire methods Grok (and compatible clients) may use.
pub const GROK_ASK_USER_METHODS: &[&str] = &["_x.ai/ask_user_question", "x.ai/ask_user_question"];

/// One option on a Grok question.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokQuestionOption {
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub preview: Option<String>,
}

/// One question in a Grok ask-user request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokQuestion {
    pub question: String,
    #[serde(default)]
    pub options: Vec<GrokQuestionOption>,
    #[serde(default, alias = "multiple", alias = "multi_select")]
    pub multi_select: bool,
}

/// Params of `_x.ai/ask_user_question` (camelCase and snake_case both accepted).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokAskUserParams {
    #[serde(alias = "session_id")]
    pub session_id: String,
    #[serde(alias = "tool_call_id")]
    pub tool_call_id: String,
    pub questions: Vec<GrokQuestion>,
    #[serde(default)]
    pub mode: Option<String>,
}

/// Typed JSON-RPC request for Grok ask-user (ACP ext method).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub struct GrokAskUserRequest(pub GrokAskUserParams);

impl JsonRpcMessage for GrokAskUserRequest {
    fn matches_method(method: &str) -> bool {
        GROK_ASK_USER_METHODS.contains(&method)
    }

    fn method(&self) -> &str {
        // Prefer underscore form when re-serializing (ACP extension convention).
        GROK_ASK_USER_METHODS[0]
    }

    fn to_untyped_message(&self) -> Result<agent_client_protocol::UntypedMessage, Error> {
        agent_client_protocol::UntypedMessage::new(self.method(), self)
    }

    fn parse_message(method: &str, params: &impl Serialize) -> Result<Self, Error> {
        if !Self::matches_method(method) {
            return Err(Error::method_not_found());
        }
        util::json_cast_params(params)
    }
}

impl JsonRpcRequest for GrokAskUserRequest {
    type Response = Value;
}

/// Event payload for `agent:ask-user-request`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskUserRequestEvent {
    pub request_id: String,
    pub session_id: String,
    pub tool_call_id: Option<String>,
    /// default | plan
    pub mode: String,
    pub questions: Vec<AskUserQuestionDto>,
}

/// Frontend-friendly question (mirrors `AskUserQuestion` in chat-state).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskUserQuestionDto {
    pub question: String,
    pub options: Vec<AskUserOptionDto>,
    pub multi_select: bool,
    /// Grok always allows free-text Other.
    pub allow_other: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskUserOptionDto {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

pub fn questions_to_dto(questions: &[GrokQuestion]) -> Vec<AskUserQuestionDto> {
    questions
        .iter()
        .filter_map(|q| {
            let question = q.question.trim();
            if question.is_empty() {
                return None;
            }
            let options: Vec<AskUserOptionDto> = q
                .options
                .iter()
                .filter_map(|o| {
                    let label = o.label.trim();
                    if label.is_empty() || label.eq_ignore_ascii_case("other") {
                        return None;
                    }
                    let description = o
                        .description
                        .as_ref()
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .or_else(|| {
                            o.preview
                                .as_ref()
                                .map(|s| s.trim().to_string())
                                .filter(|s| !s.is_empty())
                        });
                    Some(AskUserOptionDto {
                        label: label.to_string(),
                        description,
                    })
                })
                .collect();
            // Need options or free-text path.
            if options.is_empty() {
                // Still allow pure free-text via Other.
            }
            Some(AskUserQuestionDto {
                question: question.to_string(),
                options,
                multi_select: q.multi_select,
                allow_other: true,
            })
        })
        .collect()
}

/// Build Grok ext-method response JSON from parallel answer strings.
pub fn grok_response_from_answers(questions: &[GrokQuestion], answers: &[String]) -> Value {
    let mut answers_map = serde_json::Map::new();
    let mut annotations = serde_json::Map::new();

    for (i, q) in questions.iter().enumerate() {
        let raw = answers.get(i).map(|s| s.trim()).unwrap_or("");
        if raw.is_empty() {
            continue;
        }
        let q_text = q.question.trim();
        if q_text.is_empty() {
            continue;
        }
        let option_labels: Vec<&str> = q
            .options
            .iter()
            .map(|o| o.label.trim())
            .filter(|s| !s.is_empty())
            .collect();

        if q.multi_select {
            let selected: Vec<String> = option_labels
                .iter()
                .filter(|label| {
                    raw.split(", ").any(|part| part.trim() == **label)
                        || raw.split(',').any(|part| part.trim() == **label)
                })
                .map(|s| (*s).to_string())
                .collect();
            // Free-text remainder?
            let mut rest = raw.to_string();
            for label in &selected {
                rest = rest
                    .split(", ")
                    .filter(|p| p.trim() != label.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
            }
            rest = rest.trim().to_string();
            let mut labels = selected;
            if !rest.is_empty() && !option_labels.contains(&rest.as_str()) {
                labels.push("Other".to_string());
                annotations.insert(q_text.to_string(), json!({ "notes": rest }));
            }
            if !labels.is_empty() {
                answers_map.insert(q_text.to_string(), json!(labels));
            }
        } else {
            // Single select: exact option match or Other free-text.
            if option_labels.contains(&raw) {
                answers_map.insert(q_text.to_string(), json!([raw]));
                if let Some(opt) = q.options.iter().find(|o| o.label.trim() == raw) {
                    if let Some(preview) = opt
                        .preview
                        .as_ref()
                        .map(|s| s.trim())
                        .filter(|s| !s.is_empty())
                    {
                        annotations.insert(q_text.to_string(), json!({ "preview": preview }));
                    }
                }
            } else {
                answers_map.insert(q_text.to_string(), json!(["Other"]));
                annotations.insert(q_text.to_string(), json!({ "notes": raw }));
            }
        }
    }

    if answers_map.is_empty() {
        return json!({ "outcome": "cancelled" });
    }

    let mut body = json!({
        "outcome": "accepted",
        "answers": answers_map,
    });
    if !annotations.is_empty() {
        if let Some(obj) = body.as_object_mut() {
            obj.insert("annotations".into(), Value::Object(annotations));
        }
    }
    body
}

pub fn cancelled_response() -> Value {
    json!({ "outcome": "cancelled" })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_both_method_names() {
        assert!(GrokAskUserRequest::matches_method(
            "_x.ai/ask_user_question"
        ));
        assert!(GrokAskUserRequest::matches_method("x.ai/ask_user_question"));
        assert!(!GrokAskUserRequest::matches_method("session/prompt"));
    }

    #[test]
    fn builds_accepted_single_select() {
        let questions = vec![GrokQuestion {
            question: "Preferred language?".into(),
            options: vec![
                GrokQuestionOption {
                    label: "Chinese".into(),
                    description: None,
                    preview: None,
                },
                GrokQuestionOption {
                    label: "English".into(),
                    description: None,
                    preview: None,
                },
            ],
            multi_select: false,
        }];
        let v = grok_response_from_answers(&questions, &["Chinese".into()]);
        assert_eq!(v["outcome"], "accepted");
        assert_eq!(v["answers"]["Preferred language?"], json!(["Chinese"]));
    }

    #[test]
    fn builds_other_with_notes() {
        let questions = vec![GrokQuestion {
            question: "Q?".into(),
            options: vec![GrokQuestionOption {
                label: "A".into(),
                description: None,
                preview: None,
            }],
            multi_select: false,
        }];
        let v = grok_response_from_answers(&questions, &["custom text".into()]);
        assert_eq!(v["answers"]["Q?"], json!(["Other"]));
        assert_eq!(v["annotations"]["Q?"]["notes"], "custom text");
    }

    #[test]
    fn parses_camel_case_params() {
        let raw = json!({
            "sessionId": "s1",
            "toolCallId": "t1",
            "questions": [{
                "question": "Hi?",
                "multiSelect": true,
                "options": [{ "label": "Yes", "description": "y" }]
            }],
            "mode": "plan"
        });
        let p: GrokAskUserParams = serde_json::from_value(raw).unwrap();
        assert_eq!(p.session_id, "s1");
        assert_eq!(p.tool_call_id, "t1");
        assert!(p.questions[0].multi_select);
        assert_eq!(p.mode.as_deref(), Some("plan"));
    }
}
