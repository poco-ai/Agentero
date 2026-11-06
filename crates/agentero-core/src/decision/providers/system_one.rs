//! System One provider: transport + answer interpretation.
//!
//! TypeSafe jEV, Cloudflare Clef, and compatible APIs all speak the same
//! `state + questions -> answers` contract (System One). The HTTP transport and
//! the answer-decoding rules therefore live together here, so every provider
//! built on the contract shares one credential source and one decoder. The
//! highlight stream keeps its domain-specific batching/geometry in
//! `features::jev`, but sends every request through
//! [`SystemOneProvider::complete`] so credentials and error handling live in
//! exactly one place.
//!
//! When the configured endpoint is OpenAI Decisions (`…/v1/decisions` or the
//! OpenAI API root), the transport transparently adapts System One request /
//! response shapes via [`super::openai_decisions`] so the OpenAI preset works
//! without changing callers.

use super::super::types::{DecisionOutcome, DecisionProvider, ProviderCall, SYSTEM_ONE_PROVIDER};
use crate::error::AppError;
use crate::http;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

/// Resolved System One credentials + model, read from settings at request time.
#[derive(Debug, Clone, PartialEq)]
pub struct SystemOneCredentials {
    pub api_key: String,
    pub base_url: String,
    /// Model id injected into every request body (e.g. `jev-latest`, `clef`).
    /// Empty keeps whatever model the request body already carries.
    pub model: String,
}

/// Supplies credentials at request time (read from settings).
pub type SystemOneAuth = dyn Fn() -> Result<SystemOneCredentials, AppError> + Send + Sync;

/// HTTP client + credential source for a System One-compatible endpoint.
pub struct SystemOneProvider {
    client: reqwest::Client,
    auth: Arc<SystemOneAuth>,
}

impl SystemOneProvider {
    pub fn new(
        client: reqwest::Client,
        auth: impl Fn() -> Result<SystemOneCredentials, AppError> + Send + Sync + 'static,
    ) -> Self {
        Self {
            client,
            auth: Arc::new(auth),
        }
    }

    /// Build a provider backed by the shared pool with a request timeout.
    pub fn with_shared_client(
        auth: impl Fn() -> Result<SystemOneCredentials, AppError> + Send + Sync + 'static,
    ) -> Self {
        let client =
            http::client(Duration::from_secs(120)).unwrap_or_else(|_| reqwest::Client::new());
        Self::new(client, auth)
    }

    fn credentials(&self) -> Result<SystemOneCredentials, AppError> {
        (self.auth)()
    }

    /// POST a raw System One body and return the decoded JSON response.
    ///
    /// The configured model is injected into `body["model"]`. This is the single
    /// transport entry point: the generic [`DecisionProvider`] path and the
    /// smart-highlight stream both call it.
    pub async fn complete(&self, body: Value) -> Result<Value, AppError> {
        let creds = self.credentials()?;
        self.post(&creds, body).await
    }

    async fn post(&self, creds: &SystemOneCredentials, mut body: Value) -> Result<Value, AppError> {
        if creds.api_key.trim().is_empty() {
            return Err(AppError::message(
                "decision provider API key is not configured",
            ));
        }

        let openai = super::openai_decisions::is_openai_decisions_endpoint(&creds.base_url);
        let endpoint = if openai {
            super::openai_decisions::normalize_openai_decisions_url(&creds.base_url)
        } else {
            creds.base_url.trim().to_string()
        };

        if openai {
            if let Some(converted) = super::openai_decisions::system_one_to_openai_request(&body) {
                body = converted;
            }
        }

        let model = creds.model.trim();
        if !model.is_empty() {
            if let Some(object) = body.as_object_mut() {
                object.insert("model".to_string(), Value::String(model.to_string()));
            }
        }

        let resp = self
            .client
            .post(&endpoint)
            .header("Authorization", format!("Bearer {}", creds.api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::message(format!("decision request failed: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp
                .text()
                .await
                .unwrap_or_else(|_| "<could not read body>".to_string());
            return Err(AppError::message(format!(
                "decision API error {status}: {body}"
            )));
        }

        let response = resp
            .json::<Value>()
            .await
            .map_err(|e| AppError::message(format!("decision response decode failed: {e}")))?;

        if openai {
            Ok(super::openai_decisions::openai_to_system_one_response(
                &response,
            ))
        } else {
            Ok(response)
        }
    }
}

#[async_trait]
impl DecisionProvider for SystemOneProvider {
    fn name(&self) -> &'static str {
        SYSTEM_ONE_PROVIDER
    }

    async fn decide(&self, call: ProviderCall<'_>) -> Result<Option<DecisionOutcome>, AppError> {
        let Some(config) = call.config else {
            return Ok(None);
        };
        let request = config.build_request(call.state);
        let creds = self.credentials()?;
        let response = self.post(&creds, request.body).await?;

        let Some(answer) = interpret_answers(&response) else {
            return Ok(None);
        };

        // Calibration-sensitive values stay in `metadata`, scoped to the
        // provider/model version, so routing thresholds never compare them
        // across vendors.
        let mut outcome = DecisionOutcome::decided(answer.action, SYSTEM_ONE_PROVIDER);
        let model = if creds.model.trim().is_empty() {
            request.model_version
        } else {
            Some(creds.model.trim().to_string())
        };
        if let Some(model) = model {
            outcome = outcome.with_model_version(model);
        }
        if let Some(confidence) = answer.confidence {
            outcome = outcome.with_confidence(confidence);
        }
        if let Some(probabilities) = answer.probabilities {
            outcome = outcome.with_metadata("probabilities", probabilities);
        }
        Ok(Some(outcome))
    }
}

/// One decoded System One answer.
#[derive(Debug, Clone, PartialEq)]
pub struct SystemOneAnswer {
    /// The provider-supplied decision value (choice key, score, yes/no, ...).
    pub action: Value,
    /// Calibrated confidence in `[0, 1]`, when the provider supplied or implied
    /// one. Only meaningful together with the provider/model that produced it.
    pub confidence: Option<f64>,
    /// Per-option probabilities, when supplied.
    pub probabilities: Option<Value>,
    /// The raw answer object, kept for metadata/debugging.
    pub raw: Value,
}

/// Decode the first answer in a System One response.
///
/// `None` means the response carried no usable answer (no `answers` map, an
/// empty map, or a shape we don't recognize). This is not a transport error:
/// it is "no opinion", which lets the engine fall back.
pub fn interpret_answers(response: &Value) -> Option<SystemOneAnswer> {
    let answers = response.get("answers")?.as_object()?;
    let (_, answer) = answers.iter().next()?;
    interpret_answer(answer)
}

/// Decode a single System One answer object.
///
/// Recognized shapes, in priority order:
/// - `choice`: an option key (`String`), returns the key + optional confidence.
/// - `noul`: probability that the yes/no answer is true; returns a bool.
/// - `score`: an ordered rubric value; returns `{ "score": n }`.
/// - `value` / `label` / `answer`: generic System One-compatible value.
///
/// A choice outside the requested `criteria` is surfaced verbatim (the schema
/// owns the allowed set and may reject it); it is never silently rewritten.
pub fn interpret_answer(answer: &Value) -> Option<SystemOneAnswer> {
    let object = answer.as_object()?;
    let probabilities = object
        .get("probabilities")
        .filter(|value| value.is_object())
        .cloned();

    if let Some(choice) = object.get("choice") {
        return Some(build(
            choice.clone(),
            explicit_confidence(object).or_else(|| max_probability(probabilities.as_ref())),
            probabilities,
            answer,
        ));
    }

    if let Some(noul) = object.get("noul").and_then(Value::as_f64) {
        let probability = noul.clamp(0.0, 1.0);
        return Some(build(
            Value::Bool(probability >= 0.5),
            explicit_confidence(object).or(Some(probability)),
            probabilities,
            answer,
        ));
    }

    if let Some(score) = object.get("score") {
        return Some(build(
            json!({ "score": score }),
            explicit_confidence(object).or_else(|| {
                // Criteria are 0..3 in the highlight vocabulary; normalize.
                score.as_f64().map(|score| (score / 3.0).clamp(0.0, 1.0))
            }),
            probabilities,
            answer,
        ));
    }

    let value = object
        .get("value")
        .or_else(|| object.get("label"))
        .or_else(|| object.get("answer"))?;
    Some(build(
        value.clone(),
        explicit_confidence(object),
        probabilities,
        answer,
    ))
}

fn build(
    action: Value,
    confidence: Option<f64>,
    probabilities: Option<Value>,
    answer: &Value,
) -> SystemOneAnswer {
    SystemOneAnswer {
        action,
        confidence: confidence.filter(|confidence| confidence.is_finite()),
        probabilities,
        raw: answer.clone(),
    }
}

fn explicit_confidence(object: &serde_json::Map<String, Value>) -> Option<f64> {
    object
        .get("confidence")
        .and_then(Value::as_f64)
        .or_else(|| object.get("probability").and_then(Value::as_f64))
}

fn max_probability(probabilities: Option<&Value>) -> Option<f64> {
    probabilities?
        .as_object()?
        .values()
        .filter_map(Value::as_f64)
        .fold(None, |acc, value| {
            Some(acc.map_or(value, |max: f64| max.max(value)))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(response: &Value) -> Option<SystemOneAnswer> {
        interpret_answers(response)
    }

    #[test]
    fn decodes_choice_with_confidence() {
        let decoded = answer(&json!({
            "answers": { "intent": { "choice": "translate", "confidence": 0.9 } }
        }))
        .expect("answer");
        assert_eq!(decoded.action, json!("translate"));
        assert_eq!(decoded.confidence, Some(0.9));
    }

    #[test]
    fn decodes_choice_without_confidence_using_probabilities() {
        let decoded = answer(&json!({
            "answers": { "intent": {
                "choice": "ask",
                "probabilities": { "ask": 0.6, "translate": 0.3, "ignore": 0.1 }
            }}
        }))
        .expect("answer");
        assert_eq!(decoded.action, json!("ask"));
        assert_eq!(decoded.confidence, Some(0.6));
        assert!(decoded.probabilities.is_some());
    }

    #[test]
    fn normalizes_score_confidence() {
        let decoded = answer(&json!({ "answers": { "q": { "score": 3.0 } } })).expect("answer");
        assert_eq!(decoded.action, json!({ "score": 3.0 }));
        assert_eq!(decoded.confidence, Some(1.0));
    }

    #[test]
    fn turns_noul_probability_into_boolean() {
        let yes = answer(&json!({ "answers": { "q": { "noul": 0.8 } } })).expect("answer");
        assert_eq!(yes.action, json!(true));
        assert_eq!(yes.confidence, Some(0.8));

        let no = answer(&json!({ "answers": { "q": { "noul": 0.2 } } })).expect("answer");
        assert_eq!(no.action, json!(false));
    }

    #[test]
    fn missing_answers_is_no_opinion() {
        assert!(answer(&json!({ "answers": {} })).is_none());
        assert!(answer(&json!({})).is_none());
    }

    #[test]
    fn unrecognized_answer_shape_is_no_opinion() {
        // A lone confidence with no action must not be echoed as an action.
        assert!(answer(&json!({ "answers": { "q": { "confidence": 0.9 } } })).is_none());
    }

    #[test]
    fn extra_answers_and_fields_are_ignored() {
        let decoded = answer(&json!({
            "answers": {
                "first": { "choice": "a", "confidence": 0.7, "extra": { "ignored": true } },
                "second": { "choice": "b" }
            },
            "usage": { "tokens": 12 }
        }))
        .expect("answer");
        assert_eq!(decoded.action, json!("a"));
        assert_eq!(decoded.confidence, Some(0.7));
    }

    #[test]
    fn out_of_set_choice_is_surfaced_verbatim() {
        // The schema owns the allowed criteria; decoding must not rewrite or
        // drop an option it does not recognize.
        let decoded = answer(&json!({
            "answers": { "intent": { "choice": "not-a-criteria", "confidence": 0.4 } }
        }))
        .expect("answer");
        assert_eq!(decoded.action, json!("not-a-criteria"));
        assert_eq!(decoded.confidence, Some(0.4));
    }

    #[test]
    fn missing_or_non_finite_confidence_is_none() {
        let missing = answer(&json!({ "answers": { "q": { "choice": "a" } } })).expect("answer");
        assert_eq!(missing.confidence, None);

        // serde_json maps non-finite floats (and JSON should never carry them)
        // to null, so a malformed confidence decodes as "no confidence".
        let malformed =
            answer(&json!({ "answers": { "q": { "choice": "a", "confidence": null } } }))
                .expect("answer");
        assert_eq!(malformed.confidence, None);

        let stringy =
            answer(&json!({ "answers": { "q": { "choice": "a", "confidence": "0.9" } } }))
                .expect("answer");
        assert_eq!(stringy.confidence, None);
    }
}
