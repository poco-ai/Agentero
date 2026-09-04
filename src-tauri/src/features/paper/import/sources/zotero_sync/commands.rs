//! Zotero sync command (thin shell over `sync_zotero`).

use super::{sync_zotero, SyncProgress, ZoteroSyncArgs, ZoteroSyncResult};
use crate::core::blocking::run_blocking;
use crate::core::error::ApiResult;
use tauri::ipc::Channel;

/// One bidirectional sync pass: pull (metadata/notes/annotations) then push
/// (NOTES.md → marked Zotero child notes). Streams `{current,total,phase}`.
///
/// Async + `run_blocking`: the pass reads the Zotero SQLite DB and rewrites
/// Vault notes, which must not run on the main thread. The progress `Channel`
/// is `Send` and keeps streaming from the blocking pool.
#[tauri::command]
pub async fn zotero_sync(
    args: ZoteroSyncArgs,
    on_progress: Channel<SyncProgress>,
) -> ApiResult<ZoteroSyncResult> {
    run_blocking(move || {
        use crate::core::log_util::{trunc, OpTimer};

        let op = OpTimer::start_with(
            "zotero_sync",
            format!("path={}", trunc(&args.zotero_dir, 160)),
        );
        let report = move |current, total, phase: &str| {
            let _ = on_progress.send(SyncProgress {
                current,
                total,
                phase: phase.to_string(),
            });
        };
        op.finish_result_ok_extra(sync_zotero(args, report), |r| {
            format!(
                "linked={} pulled_notes={} pushed_notes={} conflicts={}",
                r.linked,
                r.notes_pulled,
                r.notes_pushed,
                r.conflicts.len()
            )
        })
    })
    .await
}
