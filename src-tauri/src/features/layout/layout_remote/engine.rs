//! Provider-agnostic remote layout engine abstraction. Adding a provider:
//! an engine file implementing [`RemoteLayoutEngine`], an entry in
//! [`engine_for`], the settings whitelists (`layout_provider_settings_key`
//! and normalize lists in `features/settings`), and the TS registry
//! (`src/lib/pdf/layout/{settings,providers}.ts`). Providers that also (or
//! only) parse PAPER.md bodies register a second engine in
//! `import::pdf_parse::engines` (`PARSER_PROVIDERS` on the TS side).

use std::sync::Arc;

use async_trait::async_trait;
use tauri::AppHandle;

use crate::core::error::AppError;
use crate::features::layout_remote::{
    LayoutRemoteAnalyzePdfArgs, LayoutRemoteAnalyzePdfResult, LayoutRemoteProbeArgs,
    LayoutRemoteProbeResult,
};

/// Provider credentials resolved by the command layer (Host-held key; the
/// WebView only ever sends a `*` mask).
#[derive(Debug, Clone, Default)]
pub struct ProviderCredentials {
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    /// MinerU document language (OCR language pack); `None` → engine default.
    pub language: Option<String>,
    /// MinerU force-OCR: OCR every page regardless of the PDF text layer.
    pub is_ocr: bool,
}

/// Everything one whole-document analyze run needs: the base64 PDF (in
/// `args`), resolved credentials, and the app handle for emitting
/// `layout-remote:progress` (correlated by `args.request_id`).
pub struct AnalyzeCtx {
    pub app: AppHandle,
    pub credentials: ProviderCredentials,
    pub args: LayoutRemoteAnalyzePdfArgs,
}

#[async_trait]
pub trait RemoteLayoutEngine: Send + Sync {
    fn id(&self) -> &'static str;

    async fn analyze_pdf(&self, ctx: AnalyzeCtx) -> Result<LayoutRemoteAnalyzePdfResult, AppError>;

    async fn probe(
        &self,
        credentials: &ProviderCredentials,
        args: LayoutRemoteProbeArgs,
    ) -> Result<LayoutRemoteProbeResult, AppError>;
}

/// Registry: provider id (any case) → engine.
pub fn engine_for(provider: &str) -> Option<Arc<dyn RemoteLayoutEngine>> {
    match provider.trim().to_ascii_lowercase().as_str() {
        "paddle" => Some(Arc::new(super::paddle::PaddleEngine)),
        "mineru" => Some(Arc::new(super::mineru::MineruEngine)),
        "openaicompatible" => Some(Arc::new(super::openai_compatible::OpenAiCompatibleEngine)),
        _ => None,
    }
}
