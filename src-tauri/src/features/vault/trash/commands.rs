//! Recycle-bin commands: undoable delete + restore (local + remote).

use crate::core::error::{map_err, ApiResult};
use crate::core::log_util::{trunc, OpTimer};
use crate::features::jobs::{emit_job_changed, JobCenter};
use crate::features::remote::{parse_remote_handle, trash_bridge, RemoteRegistry};
use crate::features::trash;
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
    app: tauri::AppHandle,
    registry: State<'_, Arc<RemoteRegistry>>,
    center: State<'_, JobCenter>,
    args: PathTrashArgs,
) -> Result<ApiResult<trash::TrashResult>, String> {
    let n = args.rels.len();
    let op = OpTimer::start_with("path_trash", format!("count={n}"));
    if let Some(sid) = parse_remote_handle(args.vault_path.trim()) {
        let session = match registry.get(sid).await {
            Ok(s) => s,
            Err(e) => {
                op.finish_err(&e);
                return Ok(map_err(e));
            }
        };
        match trash_bridge::trash_paths(&session, &args.rels).await {
            Ok(res) => {
                op.finish_ok_extra(format!(
                    "batch_id={} count={}",
                    trunc(&res.batch_id, 40),
                    res.count
                ));
                Ok(ApiResult::ok(res))
            }
            Err(e) => {
                op.finish_err(&e);
                Ok(map_err(e))
            }
        }
    } else {
        let vault = PathBuf::from(args.vault_path.trim());
        match trash::trash_paths(&vault, &args.rels) {
            Ok(res) => {
                // A deleted paper must not keep running/scheduling background
                // work (parse, download, layout, …): cancel its jobs now.
                let mut cancelled = 0usize;
                for rel in &res.rels {
                    for snapshot in center.cancel_for_paper(&vault, rel).await {
                        emit_job_changed(&app, snapshot);
                        cancelled += 1;
                    }
                }
                if cancelled > 0 {
                    center.drain_and_spawn(&app).await;
                }
                op.finish_ok_extra(format!(
                    "batch_id={} count={} jobs_cancelled={cancelled}",
                    trunc(&res.batch_id, 40),
                    res.count
                ));
                Ok(ApiResult::ok(res))
            }
            Err(e) => {
                op.finish_err(&e);
                Ok(map_err(e))
            }
        }
    }
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
) -> Result<ApiResult<Vec<trash::TrashEntry>>, String> {
    if let Some(sid) = parse_remote_handle(args.vault_path.trim()) {
        let session = match registry.get(sid).await {
            Ok(s) => s,
            Err(e) => return Ok(map_err(e)),
        };
        match trash_bridge::list_trash(&session).await {
            Ok(items) => Ok(ApiResult::ok(items)),
            Err(e) => Ok(map_err(e)),
        }
    } else {
        let vault = PathBuf::from(args.vault_path.trim());
        match trash::list_trash(&vault) {
            Ok(items) => Ok(ApiResult::ok(items)),
            Err(e) => Ok(map_err(e)),
        }
    }
}

/// Empty the entire recycle bin (permanent).
#[tauri::command]
pub async fn path_purge_trash(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: TrashVaultArgs,
) -> Result<ApiResult<()>, String> {
    let op = OpTimer::start("path_purge_trash");
    if let Some(sid) = parse_remote_handle(args.vault_path.trim()) {
        let session = match registry.get(sid).await {
            Ok(s) => s,
            Err(e) => {
                op.finish_err(&e);
                return Ok(map_err(e));
            }
        };
        match trash_bridge::purge_all(&session).await {
            Ok(()) => {
                op.finish_ok();
                Ok(ApiResult::ok(()))
            }
            Err(e) => {
                op.finish_err(&e);
                Ok(map_err(e))
            }
        }
    } else {
        let vault = PathBuf::from(args.vault_path.trim());
        match trash::purge_all(&vault) {
            Ok(()) => {
                op.finish_ok();
                Ok(ApiResult::ok(()))
            }
            Err(e) => {
                op.finish_err(&e);
                Ok(map_err(e))
            }
        }
    }
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
) -> Result<ApiResult<PathRestoreItemResult>, String> {
    let op = OpTimer::start_with(
        "path_restore_item",
        format!(
            "batch_id={} stored={}",
            trunc(&args.batch_id, 40),
            trunc(&args.stored, 80)
        ),
    );
    if let Some(sid) = parse_remote_handle(args.vault_path.trim()) {
        let session = match registry.get(sid).await {
            Ok(s) => s,
            Err(e) => {
                op.finish_err(&e);
                return Ok(map_err(e));
            }
        };
        match trash_bridge::restore_item(&session, &args.batch_id, &args.stored).await {
            Ok(rel) => {
                op.finish_ok_extra(format!("rel={}", trunc(&rel, 120)));
                Ok(ApiResult::ok(PathRestoreItemResult { rel }))
            }
            Err(e) => {
                op.finish_err(&e);
                Ok(map_err(e))
            }
        }
    } else {
        let vault = PathBuf::from(args.vault_path.trim());
        match trash::restore_item(&vault, &args.batch_id, &args.stored) {
            Ok(rel) => {
                op.finish_ok_extra(format!("rel={}", trunc(&rel, 120)));
                Ok(ApiResult::ok(PathRestoreItemResult { rel }))
            }
            Err(e) => {
                op.finish_err(&e);
                Ok(map_err(e))
            }
        }
    }
}

/// Permanently delete a single recycle-bin item.
#[tauri::command]
pub async fn path_purge_item(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: TrashItemArgs,
) -> Result<ApiResult<()>, String> {
    let op = OpTimer::start_with(
        "path_purge_item",
        format!(
            "batch_id={} stored={}",
            trunc(&args.batch_id, 40),
            trunc(&args.stored, 80)
        ),
    );
    if let Some(sid) = parse_remote_handle(args.vault_path.trim()) {
        let session = match registry.get(sid).await {
            Ok(s) => s,
            Err(e) => {
                op.finish_err(&e);
                return Ok(map_err(e));
            }
        };
        match trash_bridge::purge_item(&session, &args.batch_id, &args.stored).await {
            Ok(()) => {
                op.finish_ok();
                Ok(ApiResult::ok(()))
            }
            Err(e) => {
                op.finish_err(&e);
                Ok(map_err(e))
            }
        }
    } else {
        let vault = PathBuf::from(args.vault_path.trim());
        match trash::purge_item(&vault, &args.batch_id, &args.stored) {
            Ok(()) => {
                op.finish_ok();
                Ok(ApiResult::ok(()))
            }
            Err(e) => {
                op.finish_err(&e);
                Ok(map_err(e))
            }
        }
    }
}
