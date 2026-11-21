//! Generic decision layer: one place to ask "what should happen?" and get a
//! typed answer from rules, a System One decision model (jEV / Clef / ...), or
//! (later) an LLM.
//!
//! The layer is intentionally Tauri-free. The core API remains available, but
//! no Host module currently registers [`DecisionSchema`]s or exposes
//! [`DecisionEngine`] to the frontend; routing/fallback lives here, provider
//! transport lives in [`providers`].

pub mod engine;
pub mod providers;
pub mod registry;
pub mod types;

pub use engine::{DecisionEngine, DecisionEngineBuilder};
pub use providers::{RuleProvider, SystemOneCredentials, SystemOneProvider};
pub use registry::DecisionRegistry;
pub use types::{
    DecisionOutcome, DecisionProvider, DecisionRequest, DecisionRouting, DecisionRule,
    DecisionSchema, DecisionStatus, FallbackThreshold, FnProviderConfig, ProviderCall,
    ProviderConfig, ProviderRequest, DEFAULT_SYSTEM_ONE_MODEL, RULE_PROVIDER, SYSTEM_ONE_PROVIDER,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppError;
    use async_trait::async_trait;
    use serde_json::{json, Value};
    use std::sync::Arc;

    /// Stub provider returning a fixed outcome (or error) for routing tests.
    struct StubProvider {
        name: &'static str,
        outcome: Result<Option<DecisionOutcome>, AppError>,
    }

    #[async_trait]
    impl DecisionProvider for StubProvider {
        fn name(&self) -> &'static str {
            self.name
        }

        async fn decide(
            &self,
            _call: ProviderCall<'_>,
        ) -> Result<Option<DecisionOutcome>, AppError> {
            match &self.outcome {
                Ok(Some(outcome)) => Ok(Some(outcome.clone())),
                Ok(None) => Ok(None),
                Err(err) => Err(AppError::message(err.to_string())),
            }
        }
    }

    fn stub(
        name: &'static str,
        action: Value,
        confidence: Option<f64>,
    ) -> Arc<dyn DecisionProvider> {
        let outcome = match confidence {
            Some(confidence) => DecisionOutcome::decided(action, name).with_confidence(confidence),
            None => DecisionOutcome::decided(action, name),
        };
        Arc::new(StubProvider {
            name,
            outcome: Ok(Some(outcome)),
        })
    }

    fn empty_stub(name: &'static str) -> Arc<dyn DecisionProvider> {
        Arc::new(StubProvider {
            name,
            outcome: Ok(None),
        })
    }

    fn versioned_stub(
        name: &'static str,
        action: Value,
        confidence: Option<f64>,
        model_version: &'static str,
    ) -> Arc<dyn DecisionProvider> {
        let outcome = match confidence {
            Some(confidence) => DecisionOutcome::decided(action, name).with_confidence(confidence),
            None => DecisionOutcome::decided(action, name),
        }
        .with_model_version(model_version);
        Arc::new(StubProvider {
            name,
            outcome: Ok(Some(outcome)),
        })
    }

    fn error_stub(name: &'static str) -> Arc<dyn DecisionProvider> {
        Arc::new(StubProvider {
            name,
            outcome: Err(AppError::message("boom")),
        })
    }

    fn request(id: &str) -> DecisionRequest {
        DecisionRequest::new(id, json!({ "selectedText": "hello" }))
    }

    #[tokio::test]
    async fn rule_primary_matches_first_rule() {
        let schema = DecisionSchema::new("t.rule", "test").rule(|state: &Value| {
            state
                .get("selectedText")
                .and_then(Value::as_str)
                .map(|_| json!("matched"))
        });
        let engine = DecisionEngine::builder()
            .provider(Arc::new(RuleProvider::new()))
            .register(schema)
            .build();

        let outcome = engine.decide(&request("t.rule")).await.expect("decide");
        assert_eq!(outcome.action.0, json!("matched"));
        assert_eq!(outcome.provider, RULE_PROVIDER);
        assert_eq!(outcome.status, DecisionStatus::Decided);
        assert_eq!(outcome.confidence(), None);
    }

    #[tokio::test]
    async fn rule_miss_falls_through_to_default() {
        let schema = DecisionSchema::new("t.default", "test")
            .rule(|_: &Value| None)
            .default_action(json!("fallback"));
        let engine = DecisionEngine::builder()
            .provider(Arc::new(RuleProvider::new()))
            .register(schema)
            .build();

        let outcome = engine.decide(&request("t.default")).await.expect("decide");
        assert_eq!(outcome.action.0, json!("fallback"));
        assert_eq!(outcome.provider, "default");
    }

    #[tokio::test]
    async fn low_confidence_primary_falls_back() {
        let schema = DecisionSchema::new("t.low", "test")
            .routing(DecisionRouting::provider("primary").with_fallback(
                RULE_PROVIDER,
                Some(FallbackThreshold::for_provider("primary", 0.75)),
            ))
            .rule(|_: &Value| Some(json!("rule")));
        let engine = DecisionEngine::builder()
            .provider(stub("primary", json!("weak"), Some(0.2)))
            .provider(Arc::new(RuleProvider::new()))
            .register(schema)
            .build();

        let outcome = engine.decide(&request("t.low")).await.expect("decide");
        assert_eq!(outcome.action.0, json!("rule"));
        assert_eq!(outcome.provider, RULE_PROVIDER);
    }

    #[tokio::test]
    async fn confident_primary_skips_fallback() {
        let schema = DecisionSchema::new("t.high", "test")
            .routing(DecisionRouting::provider("primary").with_fallback(
                RULE_PROVIDER,
                Some(FallbackThreshold::for_provider("primary", 0.75)),
            ))
            .rule(|_: &Value| Some(json!("rule")));
        let engine = DecisionEngine::builder()
            .provider(stub("primary", json!("strong"), Some(0.95)))
            .provider(Arc::new(RuleProvider::new()))
            .register(schema)
            .build();

        let outcome = engine.decide(&request("t.high")).await.expect("decide");
        assert_eq!(outcome.action.0, json!("strong"));
        assert_eq!(outcome.provider, "primary");
    }

    #[tokio::test]
    async fn rule_miss_falls_through_to_provider_fallback() {
        let schema = DecisionSchema::new("t.chain", "test")
            .routing(DecisionRouting::rule_only().with_fallback("primary", None))
            .rule(|_: &Value| None);
        let engine = DecisionEngine::builder()
            .provider(Arc::new(RuleProvider::new()))
            .provider(stub("primary", json!("provider"), Some(0.9)))
            .register(schema)
            .build();

        let outcome = engine.decide(&request("t.chain")).await.expect("decide");
        assert_eq!(outcome.action.0, json!("provider"));
    }

    #[tokio::test]
    async fn primary_error_uses_fallback_when_configured() {
        let schema = DecisionSchema::new("t.err", "test")
            .routing(DecisionRouting::provider("broken").with_fallback(RULE_PROVIDER, None))
            .rule(|_: &Value| Some(json!("rule")));
        let engine = DecisionEngine::builder()
            .provider(error_stub("broken"))
            .provider(Arc::new(RuleProvider::new()))
            .register(schema)
            .build();

        let outcome = engine.decide(&request("t.err")).await.expect("decide");
        assert_eq!(outcome.action.0, json!("rule"));
    }

    #[tokio::test]
    async fn primary_error_without_fallback_propagates() {
        let schema =
            DecisionSchema::new("t.err2", "test").routing(DecisionRouting::provider("broken"));
        let engine = DecisionEngine::builder()
            .provider(error_stub("broken"))
            .register(schema)
            .build();

        assert!(engine.decide(&request("t.err2")).await.is_err());
    }

    #[tokio::test]
    async fn fallback_miss_keeps_weak_primary() {
        let schema = DecisionSchema::new("t.keep", "test").routing(
            DecisionRouting::provider("primary").with_fallback(
                "empty",
                Some(FallbackThreshold::for_provider("primary", 0.75)),
            ),
        );
        let engine = DecisionEngine::builder()
            .provider(stub("primary", json!("weak"), Some(0.2)))
            .provider(empty_stub("empty"))
            .register(schema)
            .build();

        let outcome = engine.decide(&request("t.keep")).await.expect("decide");
        assert_eq!(outcome.action.0, json!("weak"));
    }

    #[tokio::test]
    async fn threshold_scoped_to_other_provider_does_not_fall_back() {
        // A low confidence from a provider the threshold was not calibrated for
        // must not trigger a confidence-based fallback.
        let schema = DecisionSchema::new("t.scope", "test")
            .routing(DecisionRouting::provider("primary").with_fallback(
                RULE_PROVIDER,
                Some(FallbackThreshold::for_provider("someone-else", 0.75)),
            ))
            .rule(|_: &Value| Some(json!("rule")));
        let engine = DecisionEngine::builder()
            .provider(stub("primary", json!("weak"), Some(0.1)))
            .provider(Arc::new(RuleProvider::new()))
            .register(schema)
            .build();

        let outcome = engine.decide(&request("t.scope")).await.expect("decide");
        assert_eq!(outcome.action.0, json!("weak"));
        assert_eq!(outcome.provider, "primary");
    }

    #[tokio::test]
    async fn threshold_version_scope_must_match() {
        let schema = DecisionSchema::new("t.version", "test")
            .routing(DecisionRouting::provider("primary").with_fallback(
                RULE_PROVIDER,
                Some(FallbackThreshold::for_provider("primary", 0.75).model_version("v2")),
            ))
            .rule(|_: &Value| Some(json!("rule")));
        let engine = DecisionEngine::builder()
            .provider(versioned_stub("primary", json!("weak"), Some(0.1), "v1"))
            .provider(Arc::new(RuleProvider::new()))
            .register(schema)
            .build();

        // Advertised v1, threshold pinned to v2: calibration does not apply.
        let outcome = engine.decide(&request("t.version")).await.expect("decide");
        assert_eq!(outcome.action.0, json!("weak"));
    }

    #[tokio::test]
    async fn missing_confidence_with_scoped_threshold_falls_back() {
        let schema = DecisionSchema::new("t.noconf", "test")
            .routing(DecisionRouting::provider("primary").with_fallback(
                RULE_PROVIDER,
                Some(FallbackThreshold::for_provider("primary", 0.75)),
            ))
            .rule(|_: &Value| Some(json!("rule")));
        let engine = DecisionEngine::builder()
            .provider(stub("primary", json!("uncalibrated"), None))
            .provider(Arc::new(RuleProvider::new()))
            .register(schema)
            .build();

        let outcome = engine.decide(&request("t.noconf")).await.expect("decide");
        assert_eq!(outcome.action.0, json!("rule"));
    }

    #[tokio::test]
    async fn non_finite_confidence_is_treated_as_missing() {
        let mut provider_outcome = DecisionOutcome::decided(json!("nan"), "primary");
        // serde_json cannot represent NaN, so a non-finite value degrades to
        // null; `confidence()` must still report "no calibrated confidence".
        provider_outcome.metadata.0 = json!({ "confidence": Value::from(f64::NAN) });
        let provider = Arc::new(StubProvider {
            name: "primary",
            outcome: Ok(Some(provider_outcome)),
        });

        let schema = DecisionSchema::new("t.nan", "test")
            .routing(DecisionRouting::provider("primary").with_fallback(
                RULE_PROVIDER,
                Some(FallbackThreshold::for_provider("primary", 0.75)),
            ))
            .rule(|_: &Value| Some(json!("rule")));
        let engine = DecisionEngine::builder()
            .provider(provider)
            .provider(Arc::new(RuleProvider::new()))
            .register(schema)
            .build();

        let outcome = engine.decide(&request("t.nan")).await.expect("decide");
        assert_eq!(outcome.action.0, json!("rule"));
    }

    #[tokio::test]
    async fn provider_timeout_uses_fallback_and_reports_status() {
        // A transport failure (e.g. timeout) is an Err; with a fallback
        // configured the deterministic provider still answers.
        let schema = DecisionSchema::new("t.timeout", "test")
            .routing(DecisionRouting::provider("slow").with_fallback(RULE_PROVIDER, None))
            .rule(|_: &Value| Some(json!("rule")));
        let engine = DecisionEngine::builder()
            .provider(error_stub("slow"))
            .provider(Arc::new(RuleProvider::new()))
            .register(schema)
            .build();

        let outcome = engine.decide(&request("t.timeout")).await.expect("decide");
        assert_eq!(outcome.action.0, json!("rule"));
        assert_eq!(outcome.status, DecisionStatus::Decided);
    }

    #[tokio::test]
    async fn no_opinion_without_default_reports_no_opinion() {
        let schema = DecisionSchema::new("t.noop", "test").rule(|_: &Value| None);
        let engine = DecisionEngine::builder()
            .provider(Arc::new(RuleProvider::new()))
            .register(schema)
            .build();

        let outcome = engine.decide(&request("t.noop")).await.expect("decide");
        assert_eq!(outcome.status, DecisionStatus::NoOpinion);
        assert_eq!(outcome.provider, "none");
    }

    #[tokio::test]
    async fn unknown_decision_is_an_error() {
        let engine = DecisionEngine::builder().build();
        assert!(engine.decide(&request("missing")).await.is_err());
    }
}
