//! Permission / elicitation / ask-user response Tauri commands.

use crate::core::error::ApiResult;
use crate::features::agent::runtime::gates::{
    AskUserAnswer, AskUserGate, ElicitationAnswer, ElicitationGate, PermissionGate,
};
use serde::Serialize;
use tauri::State;

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
