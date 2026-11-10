use crate::core::decision::{
    DecisionEngine, DecisionRequest, DecisionRouting, DecisionSchema, FnProviderConfig,
    ProviderRequest, RuleProvider, SystemOneProvider, SYSTEM_ONE_PROVIDER,
};
use crate::core::error::{map_err, ApiResult, AppError};
use crate::core::json::JsonValue;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::sync::Semaphore;

pub const PDF_SELECTION_ACTIONS: [&str; 4] = ["translate", "explain", "highlight", "add-to-agent"];

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DecisionGatewayRequest {
    pub request_id: String,
    pub decision_id: String,
    pub state_version: String,
    pub state: JsonValue,
    pub target_identity: String,
    pub context_identity: String,
    pub allowed_action_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DecisionGatewayResponse {
    pub request_id: String,
    pub trace_id: String,
    pub state_version: String,
    pub recommendation: Option<String>,
    pub allowed_action_ids: Vec<String>,
    pub provider: String,
}

fn gate() -> &'static Arc<Semaphore> {
    static GATE: OnceLock<Arc<Semaphore>> = OnceLock::new();
    GATE.get_or_init(|| Arc::new(Semaphore::new(2)))
}

fn schema() -> DecisionSchema {
    DecisionSchema::new("pdf.selection.intent", "Choose an allowed PDF selection action")
        .routing(DecisionRouting::rule_only().with_fallback(SYSTEM_ONE_PROVIDER, None))
        .rule(|state: &Value| {
            let desired = state.get("requestedAction")?.as_str()?;
            if !PDF_SELECTION_ACTIONS.contains(&desired) {
                return None;
            }
            let allowed = state.get("allowedActionIds")?.as_array()?;
            allowed.iter().any(|id| id.as_str() == Some(desired)).then(|| Value::String(desired.to_string()))
        })
        .provider_config(FnProviderConfig::new(SYSTEM_ONE_PROVIDER, |state| {
            ProviderRequest::new(SYSTEM_ONE_PROVIDER, json!({
                "state": state,
                "questions": [{ "id": "action", "type": "choice", "options": PDF_SELECTION_ACTIONS }]
            }))
        }))
}

#[tauri::command]
#[specta::specta]
pub async fn decision_gateway_decide(
    app: AppHandle,
    request: DecisionGatewayRequest,
) -> ApiResult<DecisionGatewayResponse> {
    let request_id = request.request_id.trim().to_string();
    if request_id.is_empty() || request.decision_id != "pdf.selection.intent" {
        return map_err(AppError::message("unsupported decision request"));
    }
    if request.state_version.trim().is_empty()
        || request.target_identity.trim().is_empty()
        || request.context_identity.trim().is_empty()
    {
        return map_err(AppError::message("decision context is incomplete"));
    }
    let allowed: Vec<String> = request
        .allowed_action_ids
        .into_iter()
        .filter(|id| PDF_SELECTION_ACTIONS.contains(&id.as_str()))
        .collect();
    if allowed.is_empty() {
        return map_err(AppError::message("no registered actions are allowed"));
    }
    let permit = match gate().clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => return map_err(AppError::message("decision gateway is busy")),
    };
    let provider = app.state::<Arc<SystemOneProvider>>().inner().clone();
    let mut state = request.state.0;
    let Some(object) = state.as_object_mut() else {
        return map_err(AppError::message("decision state must be an object"));
    };
    object.insert("allowedActionIds".into(), json!(allowed));
    object.insert("targetIdentity".into(), json!(request.target_identity));
    object.insert("contextIdentity".into(), json!(request.context_identity));
    let engine = DecisionEngine::builder()
        .provider(Arc::new(RuleProvider::new()))
        .provider(provider)
        .register(schema())
        .build();
    let decision = tokio::time::timeout(
        Duration::from_secs(8),
        engine.decide(&DecisionRequest::new("pdf.selection.intent", state)),
    )
    .await;
    drop(permit);
    let trace_id = format!("navigator:{request_id}");
    let outcome = match decision {
        Ok(Ok(value)) => value,
        _ => {
            return ApiResult::ok(DecisionGatewayResponse {
                request_id,
                trace_id,
                state_version: request.state_version,
                recommendation: None,
                allowed_action_ids: allowed,
                provider: "fallback".into(),
            })
        }
    };
    let recommendation = outcome
        .action
        .0
        .as_str()
        .filter(|action| allowed.iter().any(|candidate| candidate == action))
        .map(str::to_string);
    ApiResult::ok(DecisionGatewayResponse {
        request_id,
        trace_id,
        state_version: request.state_version,
        recommendation,
        allowed_action_ids: allowed,
        provider: outcome.provider,
    })
}
