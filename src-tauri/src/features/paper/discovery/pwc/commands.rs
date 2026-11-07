//! `paper_pwc_import` — import one Papers with Code row into the vault.
//!
//! Mirrors `paper_coolpapers_import`: the renderer supplies the row's catalog
//! id, the Host resolves it against the public API and commits through the same
//! dedupe → shell → catalog → assets pipeline as the 魔棒.

use crate::core::error::{map_err, ApiResult};
use crate::core::fs::resolve_vault;
use crate::features::paper::catalog::CapsCache;
use crate::features::paper::import::paper_import::PaperCommitResult;
use serde::Deserialize;

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PwcImportArgs {
    pub vault_path: String,
    /// Parent dir resolved by the renderer (`papers` or a paper group).
    pub parent_dir: String,
    /// Numeric catalog id or arXiv id from the `/paper/<id>` URL.
    pub paper_id: String,
    #[serde(default)]
    pub task_id: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn paper_pwc_import(
    app: tauri::AppHandle,
    cache: tauri::State<'_, CapsCache>,
    args: PwcImportArgs,
) -> Result<ApiResult<PaperCommitResult>, String> {
    let vault = match resolve_vault(&args.vault_path) {
        Ok(vault) => vault,
        Err(error) => return Ok(map_err(error)),
    };
    let host_app = crate::features::host_hooks::wrap(&app);
    let note_mode = crate::features::paper::import::note_mode_from_app(&app);
    let result = super::import_paper(super::PwcImportRequest {
        vault: &vault,
        parent_dir: &args.parent_dir,
        paper_id: &args.paper_id,
        app: Some(&host_app),
        task_id: args.task_id.as_deref(),
        note_mode,
        cache: Some(&cache),
    })
    .await;

    match result {
        Ok(commit) => {
            crate::features::host_hooks::enqueue_preparation_plan(
                &app,
                &vault,
                &commit.preparation,
            );
            Ok(ApiResult::ok(commit))
        }
        Err(error) => Ok(map_err(error)),
    }
}
