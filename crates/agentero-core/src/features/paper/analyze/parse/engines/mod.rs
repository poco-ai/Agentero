//! Pluggable PAPER.md body-parse engines: the local liteparse worker plus
//! cloud providers sharing the layout provider credential pool.
//!
//! Cloud engines fall back to the local engine on failure or empty output;
//! cancellation aborts without fallback. The engine selection and plaintext
//! credentials live in a process-wide snapshot (same pattern as
//! `http::configure_proxy`), refreshed at startup and on `settings_set`.

use super::BodyParseAsset;
use crate::error::AppError;
use async_trait::async_trait;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, OnceLock, RwLock};

mod local;

/// Successful body parse: markdown, optional derived assets, and the catalog
/// quality labels. Assets are regenerated with `PAPER.md` and are never the
/// source of truth for a paper.
#[derive(Debug, Clone)]
pub struct BodyParseOutcome {
    pub markdown: String,
    pub assets: Vec<BodyParseAsset>,
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
    pub fn is_cancelled(&self) -> bool {
        super::pdf_parse_task_is_cancelled(self.task_id)
    }
}

#[async_trait]
pub trait BodyParseEngine: Send + Sync {
    fn id(&self) -> &'static str;
    async fn parse(&self, ctx: &BodyParseCtx<'_>) -> Result<BodyParseOutcome, AppError>;
}

/// Factory for a host-registered engine (desktop: MinerU / Paddle /
/// OpenAI-compatible; registered via [`register_engine`]).
pub type EngineFactory = fn() -> Arc<dyn BodyParseEngine>;

fn engine_registry_slot() -> &'static RwLock<Vec<(String, EngineFactory)>> {
    static ENGINE_REGISTRY: OnceLock<RwLock<Vec<(String, EngineFactory)>>> = OnceLock::new();
    ENGINE_REGISTRY.get_or_init(|| RwLock::new(Vec::new()))
}

/// Register (or replace) a host-provided engine for a backend id
/// (case-insensitive). Idempotent; called by the desktop Host when it
/// refreshes the parser config.
pub fn register_engine(backend: &str, factory: EngineFactory) {
    let key = backend.trim().to_ascii_lowercase();
    if let Ok(mut registry) = engine_registry_slot().write() {
        match registry.iter_mut().find(|(id, _)| *id == key) {
            Some(slot) => slot.1 = factory,
            None => registry.push((key, factory)),
        }
    }
}

/// Backend id (any case) → engine. Unknown ids fall back to local.
pub fn engine_for(backend: &str) -> Arc<dyn BodyParseEngine> {
    let key = backend.trim().to_ascii_lowercase();
    if let Ok(registry) = engine_registry_slot().read() {
        if let Some((_, factory)) = registry.iter().find(|(id, _)| *id == key) {
            return factory();
        }
    }
    Arc::new(local::LocalBodyEngine)
}

/// Host resolver mapping a backend id to its credential-provider id.
pub type ProviderResolver = fn(&str) -> Option<&'static str>;

fn provider_resolver_slot() -> &'static RwLock<Option<ProviderResolver>> {
    static PROVIDER_RESOLVER: OnceLock<RwLock<Option<ProviderResolver>>> = OnceLock::new();
    PROVIDER_RESOLVER.get_or_init(|| RwLock::new(None))
}

/// Install the host resolver mapping a backend id to its credential-provider
/// id (desktop: settings-store keys). Without a resolver every backend maps to
/// `None` (local engine, no credentials).
pub fn set_provider_resolver(resolver: ProviderResolver) {
    if let Ok(mut slot) = provider_resolver_slot().write() {
        *slot = Some(resolver);
    }
}

/// Provider id used to look up credentials for a backend (None → local).
pub fn provider_for_backend(backend: &str) -> Option<&'static str> {
    provider_resolver_slot()
        .read()
        .ok()
        .and_then(|slot| *slot)
        .and_then(|resolver| resolver(backend))
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

fn current_parser_config() -> ParserEngineConfig {
    parser_config_slot()
        .read()
        .map(|guard| guard.clone())
        .unwrap_or_default()
}

/// Run the configured engine; cloud failures fall back to local liteparse and
/// leave the reason in `messages`. Cancellation propagates without fallback.
pub async fn parse_body_with_engine(
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
