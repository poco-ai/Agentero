//! Pluggable PAPER.md body-parse engines: the local liteparse worker plus
//! cloud providers sharing the layout provider credential pool.
//!
//! Cloud engines fall back to the local engine on failure or empty output;
//! cancellation aborts without fallback. The engine selection and plaintext
//! credentials live in a process-wide snapshot (same pattern as
//! `http::configure_proxy`), refreshed at startup and on `settings_set`.

use crate::core::error::AppError;
#[cfg(feature = "desktop")]
use crate::features::settings::AppSettingsStore;
use async_trait::async_trait;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, OnceLock, RwLock};

mod local;
#[cfg(feature = "desktop")]
mod mineru;
#[cfg(feature = "desktop")]
mod openai_vlm;
#[cfg(feature = "desktop")]
mod paddle;

/// Successful body parse: markdown plus the catalog quality labels.
#[derive(Debug, Clone)]
pub struct BodyParseOutcome {
    pub markdown: String,
    pub body_source: String,
    pub body_quality: String,
}

/// Credentials resolved from `layout.providerConfigs` (plaintext, Host-only).
#[derive(Debug, Clone, Default)]
pub struct EngineCredentials {
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
    /// OCR prompt override; `None` → the engine derives one from the model id.
    pub prompt: Option<String>,
    /// MinerU document language; `None` → the engine's default (`ch`).
    pub language: Option<String>,
    /// MinerU force-OCR: OCR every page regardless of the PDF text layer.
    pub is_ocr: bool,
}

pub struct BodyParseCtx<'a> {
    pub pdf_path: &'a Path,
    pub task_id: Option<&'a str>,
    pub credentials: EngineCredentials,
}

impl BodyParseCtx<'_> {
    #[cfg(feature = "desktop")]
    fn is_cancelled(&self) -> bool {
        super::pdf_parse_task_is_cancelled(self.task_id)
    }
}

#[async_trait]
pub trait BodyParseEngine: Send + Sync {
    fn id(&self) -> &'static str;
    async fn parse(&self, ctx: &BodyParseCtx<'_>) -> Result<BodyParseOutcome, AppError>;
}

/// Backend id (any case) → engine. Unknown ids fall back to local.
fn engine_for(backend: &str) -> Arc<dyn BodyParseEngine> {
    match backend.trim().to_ascii_lowercase().as_str() {
        #[cfg(feature = "desktop")]
        "mineru" => Arc::new(mineru::MineruBodyEngine),
        #[cfg(feature = "desktop")]
        "paddle" => Arc::new(paddle::PaddleBodyEngine),
        #[cfg(feature = "desktop")]
        "openaicompatible" => Arc::new(openai_vlm::OpenAiVlmBodyEngine),
        _ => Arc::new(local::LocalBodyEngine),
    }
}

/// Provider id used to look up credentials for a backend (None → local).
#[cfg(feature = "desktop")]
fn provider_for_backend(backend: &str) -> Option<&'static str> {
    crate::features::settings::layout_provider_settings_key(backend)
}

#[cfg(not(feature = "desktop"))]
fn provider_for_backend(_backend: &str) -> Option<&'static str> {
    None
}

/// Process-wide parser engine snapshot.
#[derive(Debug, Clone, Default)]
pub struct ParserEngineConfig {
    pub backend: String,
    pub credentials: HashMap<String, EngineCredentials>,
}

static PARSER_CONFIG: OnceLock<RwLock<ParserEngineConfig>> = OnceLock::new();

fn parser_config_slot() -> &'static RwLock<ParserEngineConfig> {
    PARSER_CONFIG.get_or_init(|| RwLock::new(ParserEngineConfig::default()))
}

pub fn configure_parser(config: ParserEngineConfig) {
    if let Ok(mut guard) = parser_config_slot().write() {
        *guard = config;
    }
}

/// Rebuild the snapshot from the settings store; plaintext keys never leave
/// the Host process.
#[cfg(feature = "desktop")]
pub fn refresh_parser_config(store: &AppSettingsStore) {
    let mut credentials = HashMap::new();
    for provider in ["paddle", "mineru", "openaiCompatible"] {
        credentials.insert(
            provider.to_string(),
            EngineCredentials {
                api_key: store.layout_api_key(provider),
                base_url: store.layout_base_url(provider),
                model: store.layout_model(provider),
                prompt: store.layout_prompt(provider),
                language: store.layout_language(provider),
                is_ocr: store.layout_is_ocr(provider),
            },
        );
    }
    configure_parser(ParserEngineConfig {
        backend: store.parser_backend(),
        credentials,
    });
}

fn current_parser_config() -> ParserEngineConfig {
    parser_config_slot()
        .read()
        .map(|guard| guard.clone())
        .unwrap_or_default()
}

/// Run the configured engine; cloud failures fall back to local liteparse and
/// leave the reason in `messages`. Cancellation propagates without fallback.
pub(crate) async fn parse_body_with_engine(
    pdf_path: &Path,
    task_id: Option<&str>,
    messages: &mut Vec<String>,
) -> Result<BodyParseOutcome, AppError> {
    let config = current_parser_config();
    let engine = engine_for(&config.backend);
    let credentials = provider_for_backend(&config.backend)
        .and_then(|provider| config.credentials.get(provider).cloned())
        .unwrap_or_default();
    let ctx = BodyParseCtx {
        pdf_path,
        task_id,
        credentials,
    };
    if engine.id() != "local" {
        match engine.parse(&ctx).await {
            Ok(outcome) if !outcome.markdown.trim().is_empty() => return Ok(outcome),
            Ok(_) => messages.push(format!(
                "{}: empty markdown; falling back to local parser",
                engine.id()
            )),
            Err(e) => {
                let msg = e.to_string();
                if msg.contains(super::CANCELLED_MESSAGE) {
                    return Err(e);
                }
                messages.push(format!(
                    "{} failed: {msg}; falling back to local parser",
                    engine.id()
                ));
            }
        }
    }
    local::LocalBodyEngine.parse(&ctx).await
}

#[cfg(all(test, feature = "desktop"))]
mod tests {
    use super::*;

    #[test]
    fn engine_registry_resolves_backends() {
        assert_eq!(engine_for("local").id(), "local");
        assert_eq!(engine_for("mineru").id(), "mineru");
        assert_eq!(engine_for("paddle").id(), "paddle");
        assert_eq!(engine_for("openaiCompatible").id(), "openaiCompatible");
        assert_eq!(engine_for("bogus").id(), "local");
        assert_eq!(engine_for("").id(), "local");
    }

    #[test]
    fn provider_lookup_matches_settings_keys() {
        assert_eq!(provider_for_backend("mineru"), Some("mineru"));
        assert_eq!(
            provider_for_backend("openaiCompatible"),
            Some("openaiCompatible")
        );
        assert_eq!(provider_for_backend("local"), None);
    }

    /// A cloud engine that cannot even start (no API key) must hand over to
    /// the local parser and leave the reason in `messages`.
    ///
    /// Mutates the process-wide snapshot, so it restores the default; no other
    /// test reads `PARSER_CONFIG`.
    #[tokio::test]
    async fn cloud_failure_falls_back_to_local_with_reason() {
        configure_parser(ParserEngineConfig {
            backend: "mineru".to_string(),
            credentials: HashMap::from([("mineru".to_string(), EngineCredentials::default())]),
        });

        let mut messages = Vec::new();
        // The local hop then fails too (no such PDF), which is fine: the
        // assertion is about the handover, not the local parse.
        let _ =
            parse_body_with_engine(Path::new("missing-test-input.pdf"), None, &mut messages).await;

        configure_parser(ParserEngineConfig::default());

        assert!(
            messages
                .iter()
                .any(|m| m.contains("mineru failed") && m.contains("falling back to local")),
            "expected a mineru fallback note, got {messages:?}"
        );
    }
}
