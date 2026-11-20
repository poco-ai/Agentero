//! Core decision-layer types, traits and schema/routing definitions.
//!
//! A *decision* is a named judgement (`pdf.selection.intent`) over some
//! decision-specific `state`. The layer routes it to a *provider* (deterministic
//! rules, a System One decision model, future LLMs) and returns a typed
//! [`DecisionOutcome`] that records which provider answered and its confidence
//! (when it has one).

use crate::error::AppError;
use crate::json::JsonValue;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

/// A single decision request crossing the IPC boundary.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DecisionRequest {
    /// Registered decision id, e.g. `pdf.selection.intent`.
    pub decision_id: String,
    /// Decision-specific context. Shape is owned by the decision schema.
    pub state: JsonValue,
}

impl DecisionRequest {
    pub fn new(decision_id: impl Into<String>, state: Value) -> Self {
        Self {
            decision_id: decision_id.into(),
            state: JsonValue(state),
        }
    }

    /// Borrow the state as a raw JSON value.
    pub fn state_value(&self) -> &Value {
        &self.state.0
    }
}

/// Provider-neutral disposition of a decision, independent of any
/// provider-specific calibration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum DecisionStatus {
    /// A provider produced the action.
    Decided,
    /// No provider had an opinion; the schema's `default_action` was used.
    Defaulted,
    /// Neither a provider nor a schema default produced anything.
    NoOpinion,
}

/// A decision result: the neutral envelope `{action, status, provider,
/// modelVersion}` plus provider-specific [`Self::metadata`].
///
/// `action` is whatever the provider produced. Rule/jEV string choices arrive
/// as JSON strings (`"ignore"`), richer payloads as objects; consumers switch
/// on the shape they registered for.
///
/// Calibration-sensitive values (confidence, probabilities) are deliberately
/// **not** top-level fields: confidences are not comparable across providers,
/// so they live in `metadata` scoped to the `provider` / `modelVersion` that
/// produced them. Routing thresholds are scoped the same way
/// ([`FallbackThreshold`]).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DecisionOutcome {
    pub action: JsonValue,
    /// How the outcome was reached (provider answer vs. schema default).
    pub status: DecisionStatus,
    /// Name of the provider that produced the action (`rule` / `systemone` /
    /// `default` / `none`). Vendor/model detail lives in `model_version`.
    pub provider: String,
    /// Provider model or config version that produced the action, when known.
    /// Part of the calibration scope: a threshold only applies to outcomes with
    /// the same `provider` and (if pinned) `model_version`.
    pub model_version: Option<String>,
    /// Provider-specific payload (e.g. `confidence`, `probabilities`). Never
    /// assume a field exists or shares calibration with another provider.
    pub metadata: JsonValue,
}

impl DecisionOutcome {
    /// A provider-produced decision. Attach calibration via
    /// [`Self::with_confidence`] / [`Self::with_metadata`].
    pub fn decided(action: Value, provider: impl Into<String>) -> Self {
        Self {
            action: JsonValue(action),
            status: DecisionStatus::Decided,
            provider: provider.into(),
            model_version: None,
            metadata: JsonValue(Value::Object(serde_json::Map::new())),
        }
    }

    /// The schema's `default_action`, used when no provider had an opinion.
    pub fn defaulted(action: Value) -> Self {
        Self {
            action: JsonValue(action),
            status: DecisionStatus::Defaulted,
            provider: "default".to_string(),
            model_version: None,
            metadata: JsonValue(Value::Object(serde_json::Map::new())),
        }
    }

    /// Nothing decided: no provider opinion and no schema default.
    pub fn no_opinion() -> Self {
        Self {
            action: JsonValue(Value::Null),
            status: DecisionStatus::NoOpinion,
            provider: "none".to_string(),
            model_version: None,
            metadata: JsonValue(Value::Object(serde_json::Map::new())),
        }
    }

    /// Record the provider model/config version that produced this outcome.
    pub fn with_model_version(mut self, version: impl Into<String>) -> Self {
        self.model_version = Some(version.into());
        self
    }

    /// Attach one provider-specific metadata entry.
    pub fn with_metadata(mut self, key: impl Into<String>, value: Value) -> Self {
        if !self.metadata.0.is_object() {
            self.metadata.0 = Value::Object(serde_json::Map::new());
        }
        if let Value::Object(map) = &mut self.metadata.0 {
            map.insert(key.into(), value);
        }
        self
    }

    /// Convenience for the common provider-specific `confidence` entry.
    pub fn with_confidence(self, confidence: f64) -> Self {
        self.with_metadata("confidence", Value::from(confidence))
    }

    /// Provider-supplied `confidence` from [`Self::metadata`], when finite.
    ///
    /// Missing, non-numeric, or non-finite values return `None`; callers that
    /// gate on a threshold treat that as "no calibrated confidence".
    pub fn confidence(&self) -> Option<f64> {
        self.metadata
            .0
            .get("confidence")
            .and_then(Value::as_f64)
            .filter(|confidence| confidence.is_finite())
    }
}

/// Everything a provider needs to answer one routed decision.
///
/// Rules live on the schema (they are provider-agnostic), so the RuleProvider
/// reads them from here; probabilistic providers read their [`ProviderConfig`].
pub struct ProviderCall<'a> {
    pub decision_id: &'a str,
    pub state: &'a Value,
    /// Provider-specific config declared by the schema, if any.
    pub config: Option<&'a dyn ProviderConfig>,
    /// Rule chain, kept at the schema level for [`DecisionRule`] consumers.
    pub rules: &'a [Box<dyn DecisionRule>],
}

/// A module that can answer a routed decision.
#[async_trait]
pub trait DecisionProvider: Send + Sync {
    /// Stable provider name (`"rule"`, `"systemone"`, ...).
    fn name(&self) -> &'static str;

    /// Answer the decision. `Ok(None)` means "no opinion" (e.g. no rule
    /// matched) and lets the engine fall through to the fallback provider.
    async fn decide(&self, call: ProviderCall<'_>) -> Result<Option<DecisionOutcome>, AppError>;
}

/// A deterministic branch: `state -> Some(action)` stops the rule chain.
pub trait DecisionRule: Send + Sync {
    fn apply(&self, state: &Value) -> Option<Value>;
}

impl<F> DecisionRule for F
where
    F: Fn(&Value) -> Option<Value> + Send + Sync,
{
    fn apply(&self, state: &Value) -> Option<Value> {
        (self)(state)
    }
}

/// Provider-specific request shape. Implementors turn the decision `state` into
/// the wire body their provider understands (jEV questions, an LLM prompt, ...).
pub trait ProviderConfig: Send + Sync {
    fn provider_name(&self) -> &'static str;

    /// Build the complete provider request body for `state`.
    fn build_request(&self, state: &Value) -> ProviderRequest;
}

/// The generic provider request envelope. `body` is provider-specific.
#[derive(Debug, Clone)]
pub struct ProviderRequest {
    pub provider: String,
    pub body: Value,
    /// Model/config version this request targets. Providers copy it into the
    /// [`DecisionOutcome`] so thresholds and debugging can scope by version.
    pub model_version: Option<String>,
}

impl ProviderRequest {
    pub fn new(provider: impl Into<String>, body: Value) -> Self {
        Self {
            provider: provider.into(),
            body,
            model_version: None,
        }
    }

    /// Declare the model/config version this request targets.
    pub fn model_version(mut self, version: impl Into<String>) -> Self {
        self.model_version = Some(version.into());
        self
    }
}

/// Closure-backed [`ProviderConfig`], so schemas can build requests inline.
pub struct FnProviderConfig<F> {
    name: &'static str,
    build: F,
}

impl<F> FnProviderConfig<F>
where
    F: Fn(&Value) -> ProviderRequest + Send + Sync,
{
    pub fn new(name: &'static str, build: F) -> Self {
        Self { name, build }
    }
}

impl<F> ProviderConfig for FnProviderConfig<F>
where
    F: Fn(&Value) -> ProviderRequest + Send + Sync,
{
    fn provider_name(&self) -> &'static str {
        self.name
    }

    fn build_request(&self, state: &Value) -> ProviderRequest {
        (self.build)(state)
    }
}

/// Names of the built-in providers.
pub const RULE_PROVIDER: &str = "rule";
/// The shared System One provider, covering TypeSafe jEV, Cloudflare Clef, and
/// any compatible `state + questions -> answers` endpoint.
pub const SYSTEM_ONE_PROVIDER: &str = "systemone";
/// Default System One model id (TypeSafe jEV). Other vendors override it via
/// settings; it also scopes the default fallback threshold.
pub const DEFAULT_SYSTEM_ONE_MODEL: &str = "jev-latest";

/// A fallback trigger threshold, scoped to the provider — and optionally the
/// model/config version — whose confidence it was calibrated against.
///
/// Confidence is not comparable across providers, so a threshold only applies
/// to an outcome from the same `provider`, and, when `model_version` is set,
/// the same `model_version`. Outcomes outside the scope never trigger a
/// confidence-based fallback.
#[derive(Debug, Clone)]
pub struct FallbackThreshold {
    /// Confidence below which the primary result is considered weak.
    pub value: f64,
    /// Provider whose confidence this threshold is calibrated for.
    pub provider: String,
    /// Pinned model/config version, when the calibration is version-specific.
    pub model_version: Option<String>,
}

impl FallbackThreshold {
    /// A threshold calibrated for `provider` (any of its versions).
    pub fn for_provider(provider: impl Into<String>, value: f64) -> Self {
        Self {
            value,
            provider: provider.into(),
            model_version: None,
        }
    }

    /// Pin the threshold to a specific model/config version.
    pub fn model_version(mut self, version: impl Into<String>) -> Self {
        self.model_version = Some(version.into());
        self
    }

    /// Whether `outcome` is inside this threshold's calibration scope.
    pub fn applies_to(&self, outcome: &DecisionOutcome) -> bool {
        if outcome.provider != self.provider {
            return false;
        }
        match &self.model_version {
            Some(version) => outcome.model_version.as_deref() == Some(version.as_str()),
            None => true,
        }
    }
}

/// How a decision picks its provider and when it falls back.
#[derive(Debug, Clone)]
pub struct DecisionRouting {
    /// Primary provider name, e.g. `"rule"` / `"systemone"`.
    pub primary: String,
    /// Optional fallback provider, tried when the primary has no opinion or
    /// drops below [`Self::fallback_threshold`].
    pub fallback: Option<String>,
    /// Provider/config-version-scoped threshold. Only consulted when the
    /// primary outcome is inside the threshold's calibration scope.
    pub fallback_threshold: Option<FallbackThreshold>,
}

impl DecisionRouting {
    /// Pure rules.
    pub fn rule_only() -> Self {
        Self {
            primary: RULE_PROVIDER.to_string(),
            fallback: None,
            fallback_threshold: None,
        }
    }

    /// Pure provider (e.g. pure jEV).
    pub fn provider(primary: impl Into<String>) -> Self {
        Self {
            primary: primary.into(),
            fallback: None,
            fallback_threshold: None,
        }
    }

    /// Attach a fallback provider and an optional scoped confidence threshold.
    pub fn with_fallback(
        mut self,
        fallback: impl Into<String>,
        threshold: Option<FallbackThreshold>,
    ) -> Self {
        self.fallback = Some(fallback.into());
        self.fallback_threshold = threshold;
        self
    }
}

/// A registered decision: routing + rules + per-provider config.
pub struct DecisionSchema {
    pub id: String,
    pub description: String,
    pub routing: DecisionRouting,
    /// Rule chain, evaluated in order by [`RULE_PROVIDER`].
    pub rules: Vec<Box<dyn DecisionRule>>,
    /// Provider-specific config, keyed by provider name.
    pub provider_configs: HashMap<String, Box<dyn ProviderConfig>>,
    /// Action returned when no provider produced one.
    pub default_action: Option<Value>,
}

impl DecisionSchema {
    pub fn new(id: impl Into<String>, description: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            description: description.into(),
            routing: DecisionRouting::rule_only(),
            rules: Vec::new(),
            provider_configs: HashMap::new(),
            default_action: None,
        }
    }

    pub fn routing(mut self, routing: DecisionRouting) -> Self {
        self.routing = routing;
        self
    }

    /// Append one rule (a closure or any [`DecisionRule`]).
    pub fn rule(mut self, rule: impl DecisionRule + 'static) -> Self {
        self.rules.push(Box::new(rule));
        self
    }

    /// Register a provider-specific config; the key is its `provider_name()`.
    pub fn provider_config(mut self, config: impl ProviderConfig + 'static) -> Self {
        self.provider_configs
            .insert(config.provider_name().to_string(), Box::new(config));
        self
    }

    pub fn default_action(mut self, action: Value) -> Self {
        self.default_action = Some(action);
        self
    }
}
