//! Tauri command shells for link-aware vault renames (moved up from
//! `vault::commands` / `catalog::commands`, P2-18).
//!
//! Every command here is a thin shell over the orchestration in
//! `super` plus one domain commit closure (catalog path-prefix update),
//! so neither vault nor catalog needs to know about the wiki index.

use crate::core::blocking::run_blocking;
use crate::core::error::{map_err, ApiResult, AppError};
use crate::core::fs::resolve_vault;
use crate::features::catalog::papers;
use crate::features::rename::{
    run_local_rename_transaction, run_prepared_external_rename_repair, ExternalRenameRepairStore,
    WikiExternalRenamePreview, WikiIndexState, WikiRenameErrorCode, WikiRenameResult,
    WikiRenameTransaction,
};
use tauri::State;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiMoveArgs {
    pub vault_path: String,
    /// Vault-relative file or directory path to rename/move.
    pub from_rel: String,
    /// Vault-relative final path, including the new basename.
    pub to_rel: String,
    /// Dirty open Markdown/NOTES paths supplied by the renderer.
    #[serde(default)]
    pub dirty_paths: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiExternalRenamePreviewArgs {
    pub vault_path: String,
    /// Verified watcher pair: the former Vault-relative path and its final path.
    pub from_rel: String,
    pub to_rel: String,
    /// Dirty open Markdown/NOTES paths supplied by the renderer.
    #[serde(default)]
    pub dirty_paths: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiApplyExternalRenameArgs {
    pub vault_path: String,
    pub candidate_id: String,
    /// Rechecked immediately before any Vault write.
    #[serde(default)]
    pub dirty_paths: Vec<String>,
}

/// Move or rename one local Vault path while updating resolved internal links.
#[tauri::command]
pub async fn wiki_move(
    args: WikiMoveArgs,
    index: State<'_, WikiIndexState>,
) -> Result<ApiResult<WikiRenameResult>, String> {
    let index = index.handle();
    Ok(run_blocking(move || {
        let vault = match resolve_vault(&args.vault_path) {
            Ok(vault) => vault,
            Err(err) => return map_err(err),
        };
        let mut guard = match index.lock() {
            Ok(guard) => guard,
            Err(error) => return map_err(AppError::message(format!("wiki index lock: {error}"))),
        };
        match run_local_rename_transaction(
            &vault,
            &mut guard,
            &args.from_rel,
            &args.to_rel,
            &args.dirty_paths,
            || {
                papers::move_under_path(&vault, &args.from_rel, &args.to_rel)
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            },
        ) {
            Ok(result) => {
                crate::core::usage::rename_path_best_effort(
                    args.vault_path.trim(),
                    &args.from_rel,
                    &args.to_rel,
                );
                ApiResult::ok(result)
            }
            Err(error) => map_err(AppError::message(error.to_string())),
        }
    })
    .await)
}

/// Preserve a pre-rename semantic plan for an externally observed local rename.
/// This is intentionally a read-only preflight: the caller must explicitly apply
/// it, or opt into the `always` policy in the renderer.
#[tauri::command]
pub async fn wiki_external_rename_preview(
    args: WikiExternalRenamePreviewArgs,
    index: State<'_, WikiIndexState>,
    repairs: State<'_, ExternalRenameRepairStore>,
) -> Result<ApiResult<WikiExternalRenamePreview>, String> {
    let index = index.handle();
    let repairs = repairs.inner().clone();
    Ok(run_blocking(move || {
        let vault = match resolve_vault(&args.vault_path) {
            Ok(vault) => vault,
            Err(err) => return map_err(err),
        };
        let guard = match index.lock() {
            Ok(guard) => guard,
            Err(error) => return map_err(AppError::message(format!("wiki index lock: {error}"))),
        };
        let transaction = match WikiRenameTransaction::plan_external_repair(
            &vault,
            &guard,
            &args.from_rel,
            &args.to_rel,
        ) {
            Ok(transaction) => transaction,
            Err(error) => return map_err(AppError::message(error.to_string())),
        };
        if let Err(error) = transaction.reject_dirty_paths(&args.dirty_paths) {
            return map_err(AppError::message(error.to_string()));
        }
        let affected_sources = transaction.updated_sources();
        let skipped = transaction.skipped().to_vec();
        let from = transaction.from().to_string();
        let to = transaction.moved_path().to_string();
        drop(guard);
        match repairs.insert(transaction) {
            Ok(candidate_id) => ApiResult::ok(WikiExternalRenamePreview {
                candidate_id,
                from,
                to,
                affected_sources,
                skipped,
            }),
            Err(error) => map_err(AppError::message(error.to_string())),
        }
    })
    .await)
}

/// Apply one previously previewed external rename repair. The Host rechecks the
/// candidate's source hashes and current dirty paths before touching Markdown.
#[tauri::command]
pub async fn wiki_apply_external_rename_repair(
    args: WikiApplyExternalRenameArgs,
    index: State<'_, WikiIndexState>,
    repairs: State<'_, ExternalRenameRepairStore>,
) -> Result<ApiResult<WikiRenameResult>, String> {
    let index = index.handle();
    let repairs = repairs.inner().clone();
    Ok(run_blocking(move || {
        let vault = match resolve_vault(&args.vault_path) {
            Ok(vault) => vault,
            Err(err) => return map_err(err),
        };
        let transaction = match repairs.get(&args.candidate_id) {
            Ok(transaction) => transaction,
            Err(error) => return map_err(AppError::message(error.to_string())),
        };
        let mut guard = match index.lock() {
            Ok(guard) => guard,
            Err(error) => return map_err(AppError::message(format!("wiki index lock: {error}"))),
        };
        match run_prepared_external_rename_repair(
            &vault,
            &mut guard,
            &transaction,
            &args.dirty_paths,
        ) {
            Ok(result) => {
                repairs.remove(&args.candidate_id);
                ApiResult::ok(result)
            }
            Err(error) => {
                if error.code != WikiRenameErrorCode::UnsavedEdits {
                    repairs.remove(&args.candidate_id);
                }
                ApiResult::err_with_details(
                    AppError::message(error.to_string()),
                    serde_json::json!({
                        "code": error.code,
                        "rollback": error.rollback,
                        "paths": error.paths,
                    }),
                )
            }
        }
    })
    .await)
}
