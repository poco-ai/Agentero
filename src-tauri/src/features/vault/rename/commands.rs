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
    WikiExternalRenamePreview, WikiIndex, WikiIndexState, WikiRenameErrorCode, WikiRenameResult,
    WikiRenameTransaction,
};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
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
                crate::features::usage::events::rename_path_best_effort(
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperMoveArgs {
    pub vault_path: String,
    /// Vault-relative item to move (paper folder, org folder, or file under `papers/`).
    pub from_rel: String,
    /// Vault-relative destination parent (`papers` or under `papers/`).
    pub dest_parent_rel: String,
    /// Dirty open Markdown/NOTES paths supplied by the renderer. The Host
    /// rejects a transaction that would move or rewrite one of these files.
    #[serde(default)]
    pub dirty_paths: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperMoveResult {
    /// New vault-relative path of the moved item.
    pub new_rel: String,
    /// Link-aware transaction details for UI refresh and diagnostics.
    pub link_update: WikiRenameResult,
}

/// Move an item into another `papers/` folder on disk and rewrite matching
/// catalog path prefixes. Never overwrites an existing target.
#[tauri::command]
pub async fn paper_move(
    args: PaperMoveArgs,
    index: State<'_, WikiIndexState>,
) -> Result<ApiResult<PaperMoveResult>, String> {
    Ok(match paper_move_service(args, index.handle()).await {
        Ok(result) => ApiResult::ok(result),
        Err(error) => map_err(error),
    })
}

/// Shared application service for callers that need the same complete
/// filesystem/catalog/wiki transaction as the Tauri command.
pub(crate) async fn paper_move_service(
    args: PaperMoveArgs,
    index: Arc<Mutex<WikiIndex>>,
) -> Result<PaperMoveResult, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = match index.lock() {
            Ok(guard) => guard,
            Err(error) => return Err(AppError::message(format!("wiki index lock: {error}"))),
        };
        move_inner(args, &mut guard)
    })
    .await
    .map_err(|error| AppError::message(format!("blocking task failed: {error}")))?
}

fn move_inner(args: PaperMoveArgs, index: &mut WikiIndex) -> Result<PaperMoveResult, AppError> {
    let vault = resolve_vault(&args.vault_path)?;
    let (from, new_rel) = crate::features::catalog::plan_paper_move_under(
        &vault,
        &args.from_rel,
        &args.dest_parent_rel,
    )?;
    if new_rel == from {
        return Err(AppError::message("already in this folder"));
    }
    let link_update =
        run_local_rename_transaction(&vault, index, &from, &new_rel, &args.dirty_paths, || {
            papers::move_under_path(&vault, &from, &new_rel)
                .map(|_| ())
                .map_err(|error| error.to_string())
        })
        .map_err(|error| AppError::message(error.to_string()))?;
    crate::features::usage::events::rename_path_best_effort(
        args.vault_path.trim(),
        &from,
        &new_rel,
    );
    Ok(PaperMoveResult {
        new_rel,
        link_update,
    })
}

#[cfg(test)]
mod move_tests {
    use super::*;
    use std::fs;
    use uuid::Uuid;

    #[test]
    fn paper_move_runs_the_filesystem_move_inside_the_wiki_transaction() {
        let vault = std::env::temp_dir().join(format!("agentero-paper-move-{}", Uuid::new_v4()));
        let source = vault.join("papers/inbox/New note.md");
        fs::create_dir_all(source.parent().expect("source parent")).expect("create source parent");
        fs::write(&source, "# New note\n").expect("write source");

        let mut index = WikiIndex::default();
        let result = move_inner(
            PaperMoveArgs {
                vault_path: vault.to_string_lossy().to_string(),
                from_rel: "papers/inbox/New note.md".to_string(),
                dest_parent_rel: "papers/archive".to_string(),
                dirty_paths: Vec::new(),
            },
            &mut index,
        )
        .expect("move succeeds");

        assert_eq!(result.new_rel, "papers/archive/New note.md");
        assert!(result.link_update.updated_sources.is_empty());
        assert!(!source.exists());
        assert!(vault.join(&result.new_rel).exists());
        let _ = fs::remove_dir_all(vault);
    }

    #[tokio::test]
    async fn shared_paper_move_service_uses_the_same_transaction() {
        let vault =
            std::env::temp_dir().join(format!("agentero-shared-paper-move-{}", Uuid::new_v4()));
        let source = vault.join("papers/inbox/paper-1/NOTES.md");
        fs::create_dir_all(source.parent().expect("source parent")).expect("create source parent");
        fs::write(&source, "# Paper\n").expect("write source");

        let result = paper_move_service(
            PaperMoveArgs {
                vault_path: vault.to_string_lossy().to_string(),
                from_rel: "papers/inbox/paper-1".into(),
                dest_parent_rel: "papers/final".into(),
                dirty_paths: Vec::new(),
            },
            Arc::new(Mutex::new(WikiIndex::default())),
        )
        .await
        .expect("shared move succeeds");

        assert_eq!(result.new_rel, "papers/final/paper-1");
        assert!(!vault.join("papers/inbox/paper-1").exists());
        assert!(vault.join("papers/final/paper-1/NOTES.md").is_file());
        let _ = fs::remove_dir_all(vault);
    }
}
