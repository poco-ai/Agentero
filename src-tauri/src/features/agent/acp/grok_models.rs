//! Grok Build ACP extension: `_x.ai/models/update` / `x.ai/models/update`.
//!
//! `session/new` can answer with a model snapshot that predates the catalog
//! refresh Grok performs while creating the session (e.g. 4.6/4.5 when the
//! account has already been rolled out to 4.7). The refreshed list is only
//! pushed through this vendor notification, which the standard ACP schema
//! drops on deserialize, so the picker kept the stale snapshot while
//! `grok models` listed the full catalog.

use agent_client_protocol::{util, Error, JsonRpcMessage, JsonRpcNotification, UntypedMessage};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Wire methods Grok Build may use for the model catalog push.
pub const GROK_MODELS_UPDATE_METHODS: &[&str] = &["_x.ai/models/update", "x.ai/models/update"];

/// Params of `_x.ai/models/update` (camelCase and snake_case both accepted).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokModelsUpdateParams {
    #[serde(default, alias = "current_model_id")]
    pub current_model_id: Option<String>,
    #[serde(default, alias = "available_models")]
    pub available_models: Vec<Value>,
}

/// Typed JSON-RPC notification for Grok's model catalog push (ACP ext method).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub struct GrokModelsUpdate(pub GrokModelsUpdateParams);

impl JsonRpcMessage for GrokModelsUpdate {
    fn matches_method(method: &str) -> bool {
        GROK_MODELS_UPDATE_METHODS.contains(&method)
    }

    fn method(&self) -> &str {
        // Prefer underscore form when re-serializing (ACP extension convention).
        GROK_MODELS_UPDATE_METHODS[0]
    }

    fn to_untyped_message(&self) -> Result<UntypedMessage, Error> {
        UntypedMessage::new(self.method(), self)
    }

    fn parse_message(method: &str, params: &impl Serialize) -> Result<Self, Error> {
        if !Self::matches_method(method) {
            return Err(Error::method_not_found());
        }
        util::json_cast_params(params)
    }
}

impl JsonRpcNotification for GrokModelsUpdate {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_both_vendor_methods_and_camel_case_params() {
        let payload = serde_json::json!({
            "currentModelId": "grok-4.7-build-fast",
            "availableModels": [
                { "modelId": "grok-4.7", "name": "Grok 4.7" },
                { "modelId": "grok-4.7-build-fast", "name": "Grok 4.7 Fast" }
            ]
        });
        for method in GROK_MODELS_UPDATE_METHODS {
            assert!(GrokModelsUpdate::matches_method(method));
            let parsed = GrokModelsUpdate::parse_message(method, &payload).unwrap();
            assert_eq!(
                parsed.0.current_model_id.as_deref(),
                Some("grok-4.7-build-fast")
            );
            assert_eq!(parsed.0.available_models.len(), 2);
        }
        assert!(GrokModelsUpdate::parse_message("session/update", &payload).is_err());
    }

    #[test]
    fn accepts_snake_case_params() {
        let payload = serde_json::json!({
            "current_model_id": "grok-4.6",
            "available_models": [{ "model_id": "grok-4.6", "name": "Grok 4.6" }]
        });
        let parsed = GrokModelsUpdate::parse_message("x.ai/models/update", &payload).unwrap();
        assert_eq!(parsed.0.current_model_id.as_deref(), Some("grok-4.6"));
        assert_eq!(parsed.0.available_models.len(), 1);
    }
}
