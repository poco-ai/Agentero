//! Tauri command shells for auto-ingest.

use crate::app::command_util::try_vault_ok;
use crate::core::error::ApiResult;
use serde::Deserialize;

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PaperIngestReconcileArgs {
    pub vault_path: String,
}

/// Startup reconcile: adopt bare `papers/` child folders (created while the
/// app was closed) into the library. Fire-and-forget from the frontend's
/// `vault:opened` handler; returns the adopted count.
#[tauri::command]
#[specta::specta]
pub async fn paper_ingest_reconcile(
    app: tauri::AppHandle,
    args: PaperIngestReconcileArgs,
) -> Result<ApiResult<u32>, String> {
    let vault = try_vault_ok!(&args.vault_path);
    let adopted = super::reconcile_folders(&app, &vault).await;
    Ok(ApiResult::ok(adopted as u32))
}
