//! Recycle-bin commands: undoable delete + restore (local + remote).

use crate::error::AppError;
use crate::log_util::{trunc, OpTimer};
use crate::services::remote::{parse_remote_handle, trash_bridge, RemoteRegistry};
use crate::services::trash;
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathTrashArgs {
    pub vault_path: String,
    /// Vault-relative paths to move into the recycle bin.
    pub rels: Vec<String>,
}

/// Move files/folders into the vault recycle bin (undoable delete).
#[tauri::command]
pub async fn path_trash(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: PathTrashArgs,
) -> Result<trash::TrashResult, AppError> {
    let n = args.rels.len();
    let op = OpTimer::start_with("path_trash", format!("count={n}"));
    let result = if let Some(sid) = parse_remote_handle(args.vault_path.trim()) {
        match registry.get(sid).await {
            Ok(session) => trash_bridge::trash_paths(&session, &args.rels).await,
            Err(e) => Err(e),
        }
    } else {
        trash::trash_paths(&PathBuf::from(args.vault_path.trim()), &args.rels)
    };
    op.finish_extra(result, |res| {
        format!("batch_id={} count={}", trunc(&res.batch_id, 40), res.count)
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathUntrashArgs {
    pub vault_path: String,
    /// Batch id returned by `path_trash`.
    pub batch_id: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathUntrashResult {
    /// Number of items restored to their original location.
    pub restored: usize,
}

/// Restore a recycle-bin batch (undo a delete).
#[tauri::command]
pub async fn path_untrash(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: PathUntrashArgs,
) -> Result<PathUntrashResult, AppError> {
    let op = OpTimer::start_with(
        "path_untrash",
        format!("batch_id={}", trunc(&args.batch_id, 40)),
    );
    let result = if let Some(sid) = parse_remote_handle(args.vault_path.trim()) {
        match registry.get(sid).await {
            Ok(session) => trash_bridge::restore_batch(&session, &args.batch_id).await,
            Err(e) => Err(e),
        }
    } else {
        trash::restore_batch(&PathBuf::from(args.vault_path.trim()), &args.batch_id)
    };
    op.finish_extra(result.map(|restored| PathUntrashResult { restored }), |r| {
        format!("restored={}", r.restored)
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashVaultArgs {
    pub vault_path: String,
}

/// List every item currently in the recycle bin (Recycle Bin view).
#[tauri::command]
pub async fn path_list_trash(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: TrashVaultArgs,
) -> Result<Vec<trash::TrashEntry>, AppError> {
    if let Some(sid) = parse_remote_handle(args.vault_path.trim()) {
        let session = registry.get(sid).await?;
        trash_bridge::list_trash(&session).await
    } else {
        trash::list_trash(&PathBuf::from(args.vault_path.trim()))
    }
}

/// Empty the entire recycle bin (permanent).
#[tauri::command]
pub async fn path_purge_trash(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: TrashVaultArgs,
) -> Result<(), AppError> {
    let op = OpTimer::start("path_purge_trash");
    let result = if let Some(sid) = parse_remote_handle(args.vault_path.trim()) {
        match registry.get(sid).await {
            Ok(session) => trash_bridge::purge_all(&session).await,
            Err(e) => Err(e),
        }
    } else {
        trash::purge_all(&PathBuf::from(args.vault_path.trim()))
    };
    op.finish(result)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItemArgs {
    pub vault_path: String,
    pub batch_id: String,
    /// Basename of the stored copy inside the batch (from `path_list_trash`).
    pub stored: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathRestoreItemResult {
    /// Vault-relative path the item was restored to.
    pub rel: String,
}

/// Restore a single recycle-bin item to its original path.
#[tauri::command]
pub async fn path_restore_item(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: TrashItemArgs,
) -> Result<PathRestoreItemResult, AppError> {
    let op = OpTimer::start_with(
        "path_restore_item",
        format!(
            "batch_id={} stored={}",
            trunc(&args.batch_id, 40),
            trunc(&args.stored, 80)
        ),
    );
    let result = if let Some(sid) = parse_remote_handle(args.vault_path.trim()) {
        match registry.get(sid).await {
            Ok(session) => trash_bridge::restore_item(&session, &args.batch_id, &args.stored).await,
            Err(e) => Err(e),
        }
    } else {
        trash::restore_item(
            &PathBuf::from(args.vault_path.trim()),
            &args.batch_id,
            &args.stored,
        )
    };
    op.finish_extra(result.map(|rel| PathRestoreItemResult { rel }), |r| {
        format!("rel={}", trunc(&r.rel, 120))
    })
}

/// Permanently delete a single recycle-bin item.
#[tauri::command]
pub async fn path_purge_item(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: TrashItemArgs,
) -> Result<(), AppError> {
    let op = OpTimer::start_with(
        "path_purge_item",
        format!(
            "batch_id={} stored={}",
            trunc(&args.batch_id, 40),
            trunc(&args.stored, 80)
        ),
    );
    let result = if let Some(sid) = parse_remote_handle(args.vault_path.trim()) {
        match registry.get(sid).await {
            Ok(session) => trash_bridge::purge_item(&session, &args.batch_id, &args.stored).await,
            Err(e) => Err(e),
        }
    } else {
        trash::purge_item(
            &PathBuf::from(args.vault_path.trim()),
            &args.batch_id,
            &args.stored,
        )
    };
    op.finish(result)
}
