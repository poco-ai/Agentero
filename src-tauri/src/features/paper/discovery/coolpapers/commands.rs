//! `paper_coolpapers_notes` / `paper_coolpapers_import` — papers.cool commands.

use crate::app::command_util::try_vault_ok;
use crate::core::error::ApiResult;
use crate::core::log_util::{trunc, OpTimer};
use crate::features::paper::import::AssetProgressContext;
use serde::Deserialize;

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CoolPapersNotesArgs {
    pub vault_path: String,
    /// Vault-relative paper folder.
    pub path: String,
    /// Catalog id. Venue imports store the Cool Papers row id (`38818@AAAI`).
    #[serde(default)]
    pub catalog_id: Option<String>,
    /// Catalog `source_url`; papers.cool links resolve without a search.
    #[serde(default)]
    pub source_url: Option<String>,
    /// Preferred resolver for arXiv rows; used after catalog id / source url.
    #[serde(default)]
    pub arxiv_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CoolPapersImportArgs {
    pub vault_path: String,
    /// Vault-relative destination, e.g. `papers` or `papers/nlp`.
    pub parent_dir: String,
    /// papers.cool branch (`arxiv` / `venue`).
    pub branch: String,
    /// Row id, e.g. `36962@AAAI`.
    pub id: String,
    /// Background task to report asset-download progress into.
    #[serde(default)]
    pub task_id: Option<String>,
}

/// Import one papers.cool row straight from its page metadata.
///
/// Bypasses the Translator: the page's `citation_*` fields cover every branch
/// papers.cool aggregates and also carry the PDF URL.
#[tauri::command]
#[specta::specta]
pub async fn paper_coolpapers_import(
    app: tauri::AppHandle,
    args: CoolPapersImportArgs,
) -> Result<ApiResult<crate::features::paper::import::paper_import::PaperCommitResult>, String> {
    let op = OpTimer::start_with(
        "paper_coolpapers_import",
        format!("branch={} id={}", args.branch, trunc(&args.id, 80)),
    );
    let vault = try_vault_ok!(&args.vault_path, op);
    let host_app = crate::features::host_hooks::wrap(&app);
    let result = super::page::import_page(super::page::ImportPageArgs {
        vault: &vault,
        parent_dir: &args.parent_dir,
        branch: &args.branch,
        id: &args.id,
        progress: AssetProgressContext {
            app: Some(&host_app),
            task_id: args.task_id.as_deref(),
        },
        note_mode: crate::features::paper::import::note_mode_from_app(&app),
    })
    .await;
    if let Ok(commit) = &result {
        crate::features::host_hooks::enqueue_preparation_plan(&app, &vault, &commit.preparation);
        if crate::features::paper::import::commit_needs_layout_follow_up(commit) {
            crate::features::jobs::spawn_layout_after_import(Some(&app), &vault, &commit.path);
        }
    }
    Ok(op.finish_result(result))
}

/// Append the papers.cool Kimi analysis for one paper to its NOTES.md.
///
/// Resolves by Cool Papers URL / venue catalog id, then arXiv id, then title.
/// A paper that cannot be resolved returns `found: false` and writes nothing.
#[tauri::command]
#[specta::specta]
pub async fn paper_coolpapers_notes(
    args: CoolPapersNotesArgs,
) -> Result<ApiResult<super::CoolPapersNotes>, String> {
    let op = OpTimer::start_with(
        "paper_coolpapers_notes",
        format!(
            "path={} id={} arxiv={}",
            trunc(&args.path, 120),
            args.catalog_id.as_deref().unwrap_or("-"),
            args.arxiv_id.as_deref().unwrap_or("-")
        ),
    );
    let vault = try_vault_ok!(&args.vault_path, op);
    let result = super::fetch_notes(super::FetchNotesRequest {
        vault: &vault,
        paper_rel: &args.path,
        catalog_id: args.catalog_id.as_deref(),
        source_url: args.source_url.as_deref(),
        arxiv_id: args.arxiv_id.as_deref(),
        title: args.title.as_deref(),
    })
    .await;
    Ok(op.finish_result(result))
}
