//! Paper move orchestration.
//!
//! Moving a paper path is paper-owned behavior, but it still executes through
//! the shared vault rename transaction so Markdown links and catalog path
//! prefixes update atomically.

use crate::core::error::{map_err, ApiResult, AppError};
use crate::core::fs::resolve_vault;
use crate::features::catalog::papers;
use crate::features::rename::{run_local_rename_transaction, WikiIndex, WikiIndexState};
use crate::features::wiki::models::WikiRenameResult;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::State;

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
    crate::core::usage::rename_path_best_effort(args.vault_path.trim(), &from, &new_rel);
    Ok(PaperMoveResult {
        new_rel,
        link_update,
    })
}

#[cfg(test)]
mod tests {
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
