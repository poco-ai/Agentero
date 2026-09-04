//! MinerU body-parse engine: run the shared cloud extract and read the
//! `full.md` markdown from the result zip.

use super::{BodyParseCtx, BodyParseEngine, BodyParseOutcome};
use crate::core::error::AppError;
use crate::features::layout_remote::engine::ProviderCredentials;
use crate::features::layout_remote::mineru::{read_zip_entry_by_candidates, run_mineru_extract};
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
        let credentials = ProviderCredentials {
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
        let markdown = read_zip_entry_by_candidates(&zip_bytes, &["full.md"])?;
        Ok(BodyParseOutcome {
            markdown,
            body_source: "mineru".to_string(),
            body_quality: "high".to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live end-to-end MinerU extract; prints the result-zip entry names so a
    /// schema change (e.g. `full.md` renamed) is immediately visible.
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

        let credentials = ProviderCredentials {
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

        let markdown = read_zip_entry_by_candidates(&zip, &["full.md"]).expect("full.md entry");
        println!("--- markdown ({} chars) ---\n{markdown}", markdown.len());
        assert!(!markdown.trim().is_empty());
    }
}
