//! MinerU body-parse engine: run the shared cloud extract and read the
//! `full.md` markdown and its `images/` assets from the result zip.

use crate::core::error::AppError;
use crate::features::paper::analyze::layout::hosted::engine::HostedProviderCredentials;
use crate::features::paper::analyze::layout::hosted::mineru::{
    read_mineru_markdown_bundle, run_mineru_extract,
};
use crate::features::paper::analyze::parse::engines::{
    BodyParseCtx, BodyParseEngine, BodyParseOutcome,
};
use crate::features::paper::analyze::parse::BodyParseAsset;
use async_trait::async_trait;

pub(crate) struct MineruBodyEngine;

#[async_trait]
impl BodyParseEngine for MineruBodyEngine {
    fn id(&self) -> &'static str {
        "mineru"
    }

    async fn parse(&self, ctx: &BodyParseCtx<'_>) -> Result<BodyParseOutcome, AppError> {
        let pdf_bytes =
            std::fs::read(ctx.pdf_path).map_err(|e| AppError::message(format!("read pdf: {e}")))?;
        let file_name = ctx
            .pdf_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("paper.pdf")
            .to_string();
        let credentials = HostedProviderCredentials {
            api_key: ctx.credentials.api_key.clone(),
            base_url: ctx.credentials.base_url.clone(),
            language: ctx.credentials.language.clone(),
            is_ocr: ctx.credentials.is_ocr,
        };
        let zip_bytes =
            run_mineru_extract(&credentials, pdf_bytes, &file_name, &|_, _, _| {}, &|| {
                ctx.is_cancelled()
            })
            .await?;
        let bundle = read_mineru_markdown_bundle(&zip_bytes)?;
        Ok(BodyParseOutcome {
            markdown: bundle.markdown,
            assets: bundle
                .assets
                .into_iter()
                .map(|asset| BodyParseAsset {
                    relative_path: asset.relative_path,
                    bytes: asset.bytes,
                })
                .collect(),
            body_source: "mineru".to_string(),
            body_quality: "high".to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live end-to-end MinerU extract; prints the result-zip entry names and
    /// extracted asset count so a schema change remains visible.
    ///
    /// ```sh
    /// AGENTERO_MINERU_LIVE_PDF=/tmp/x.pdf AGENTERO_MINERU_API_KEY=sk-… \
    ///   cargo test -p agentero --lib -- live_mineru --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore = "live network + billed API key"]
    async fn live_mineru_body_parse() {
        let pdf = std::env::var("AGENTERO_MINERU_LIVE_PDF").expect("set AGENTERO_MINERU_LIVE_PDF");
        let api_key =
            std::env::var("AGENTERO_MINERU_API_KEY").expect("set AGENTERO_MINERU_API_KEY");
        let base_url = std::env::var("AGENTERO_MINERU_BASE_URL").unwrap_or_default();

        let credentials = HostedProviderCredentials {
            api_key: Some(api_key),
            base_url: (!base_url.is_empty()).then_some(base_url),
            ..Default::default()
        };
        let pdf_bytes = std::fs::read(&pdf).expect("read pdf");
        let zip = run_mineru_extract(
            &credentials,
            pdf_bytes,
            "live-test.pdf",
            &|phase, extracted, total| println!("progress: {phase} {extracted:?}/{total:?}"),
            &|| false,
        )
        .await
        .expect("mineru extract");
        println!("result zip: {} bytes", zip.len());

        let cursor = std::io::Cursor::new(zip.as_slice());
        let mut archive = zip::ZipArchive::new(cursor).expect("open zip");
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        println!("zip entries: {names:?}");

        let bundle = read_mineru_markdown_bundle(&zip).expect("MinerU markdown bundle");
        println!(
            "--- markdown ({} chars), assets={} ---\n{}",
            bundle.markdown.len(),
            bundle.assets.len(),
            bundle.markdown
        );
        assert!(!bundle.markdown.trim().is_empty());
    }
}
