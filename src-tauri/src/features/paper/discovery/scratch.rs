//! Tauri commands for the plaza paper scratch workspace (Agent `@` full text).

use crate::core::error::{map_err, ApiResult};
use agentero_core::features::paper::discovery::scratch;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PlazaScratchPrepareArgs {
    pub arxiv_ids: Vec<String>,
}

/// Per-id outcome: one failed paper never blocks the rest of the turn.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PlazaScratchEntry {
    pub arxiv_id: String,
    pub ok: bool,
    pub markdown_path: Option<String>,
    pub pdf_path: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn plaza_scratch_prepare(
    args: PlazaScratchPrepareArgs,
) -> ApiResult<Vec<PlazaScratchEntry>> {
    // Sequential on purpose: a turn references a handful of papers and the
    // arXiv endpoint should not see a burst from one prompt.
    let mut out = Vec::with_capacity(args.arxiv_ids.len());
    for id in args.arxiv_ids {
        let entry = match scratch::ensure_paper(&id).await {
            Ok(paper) => PlazaScratchEntry {
                arxiv_id: paper.arxiv_id,
                ok: true,
                markdown_path: Some(paper.markdown_path),
                pdf_path: Some(paper.pdf_path),
                error: None,
            },
            Err(e) => PlazaScratchEntry {
                arxiv_id: id,
                ok: false,
                markdown_path: None,
                pdf_path: None,
                error: Some(e.to_string()),
            },
        };
        out.push(entry);
    }
    ApiResult::ok(out)
}

#[tauri::command]
#[specta::specta]
pub async fn plaza_scratch_stats() -> ApiResult<scratch::ScratchStats> {
    ApiResult::ok(scratch::stats())
}

#[tauri::command]
#[specta::specta]
pub async fn plaza_scratch_clear() -> ApiResult<scratch::ScratchClearResult> {
    match scratch::clear().await {
        Ok(data) => ApiResult::ok(data),
        Err(e) => map_err(e),
    }
}
