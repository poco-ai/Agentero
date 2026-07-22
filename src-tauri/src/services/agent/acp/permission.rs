//! ACP permission handling: policy, event payloads, and request resolution.

use super::*;

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
pub(super) async fn await_user_permission(
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
