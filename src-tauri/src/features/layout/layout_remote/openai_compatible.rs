//! OpenAI-compatible provider registered for the settings connectivity
//! probe only — PDF body OCR runs in `import::pdf_parse::engines`, and this
//! provider has no layout-analysis capability.

use crate::core::error::AppError;
use crate::core::http;
use crate::features::layout_remote::engine::{AnalyzeCtx, ProviderCredentials, RemoteLayoutEngine};
use crate::features::layout_remote::{
    LayoutRemoteAnalyzePdfResult, LayoutRemoteProbeArgs, LayoutRemoteProbeResult,
};
use async_trait::async_trait;
use std::time::Duration;

const DEFAULT_BASE_URL: &str = "https://api.siliconflow.cn/v1";

pub struct OpenAiCompatibleEngine;

#[async_trait]
impl RemoteLayoutEngine for OpenAiCompatibleEngine {
    fn id(&self) -> &'static str {
        "openaiCompatible"
    }

    async fn analyze_pdf(
        &self,
        _ctx: AnalyzeCtx,
    ) -> Result<LayoutRemoteAnalyzePdfResult, AppError> {
        Err(AppError::message(
            "openaiCompatible is not a layout-analysis provider",
        ))
    }

    /// Validate key + endpoint with the standard `GET {base}/models` listing.
    async fn probe(
        &self,
        credentials: &ProviderCredentials,
        _args: LayoutRemoteProbeArgs,
    ) -> Result<LayoutRemoteProbeResult, AppError> {
        let api_key = credentials
            .api_key
            .as_deref()
            .map(str::trim)
            .filter(|k| !k.is_empty())
            .ok_or_else(|| AppError::message("OpenAI-compatible OCR requires apiKey"))?;
        let base = credentials
            .base_url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_BASE_URL)
            .trim_end_matches('/');
        let client = http::client_with(Duration::from_secs(30), 10, http::USER_AGENT)?;
        let response = client
            .get(format!("{base}/models"))
            .bearer_auth(api_key)
            .send()
            .await
            .map_err(|e| AppError::message(format!("OpenAI-compatible probe failed: {e}")))?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            let snippet = http::http_err_snippet(&text);
            return Err(AppError::message(format!(
                "OpenAI-compatible probe failed (HTTP {status}): {snippet}"
            )));
        }
        Ok(LayoutRemoteProbeResult {
            job_id: "openai-compatible-probe-ok".to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live settings-probe check against a real OpenAI-compatible endpoint.
    ///
    /// ```sh
    /// AGENTERO_VLM_API_KEY=sk-… \
    ///   cargo test -p agentero --lib -- live_openai_compatible_probe --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore = "live network + API key"]
    async fn live_openai_compatible_probe() {
        let api_key = std::env::var("AGENTERO_VLM_API_KEY").expect("set AGENTERO_VLM_API_KEY");
        let base_url = std::env::var("AGENTERO_VLM_BASE_URL").unwrap_or_default();
        let credentials = ProviderCredentials {
            api_key: Some(api_key),
            base_url: (!base_url.is_empty()).then_some(base_url),
            ..Default::default()
        };
        let args = LayoutRemoteProbeArgs {
            provider: Some("openaiCompatible".to_string()),
            image_base64: String::new(),
            api_key: None,
        };
        let result = OpenAiCompatibleEngine
            .probe(&credentials, args)
            .await
            .expect("probe should succeed");
        println!("probe ok: {}", result.job_id);

        let bad = ProviderCredentials {
            api_key: Some("sk-definitely-invalid".to_string()),
            base_url: credentials.base_url.clone(),
            ..Default::default()
        };
        let err = OpenAiCompatibleEngine
            .probe(
                &bad,
                LayoutRemoteProbeArgs {
                    provider: Some("openaiCompatible".to_string()),
                    image_base64: String::new(),
                    api_key: None,
                },
            )
            .await
            .expect_err("an invalid key must not probe green");
        println!("invalid key rejected: {err}");
    }
}
