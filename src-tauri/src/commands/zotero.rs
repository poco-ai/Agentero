//! Zotero migration commands: scan a Zotero data directory and migrate its
//! library into the catalog. Fully local (no Translator).

use crate::error::AppError;
use crate::services::lookup::{
    migrate_zotero, scan_zotero, MigrateProgress, ZoteroMigrateArgs, ZoteroMigrateResult,
    ZoteroScan, ZoteroScanArgs,
};
use tauri::ipc::Channel;

/// Read-only preview of a Zotero data directory (item + local-PDF counts).
#[tauri::command]
pub fn zotero_scan(args: ZoteroScanArgs) -> Result<ZoteroScan, AppError> {
    use crate::log_util::{trunc, OpTimer};

    let op = OpTimer::start_with(
        "zotero_scan",
        format!("path={}", trunc(&args.zotero_dir, 160)),
    );
    op.finish(scan_zotero(args))
}

/// Migrate a Zotero library into `papers/…` + catalog; optionally copy PDFs.
/// Streams `{current,total}` progress to the UI via `on_progress`.
#[tauri::command]
pub async fn zotero_migrate(
    args: ZoteroMigrateArgs,
    on_progress: Channel<MigrateProgress>,
) -> Result<ZoteroMigrateResult, AppError> {
    use crate::log_util::{trunc, OpTimer};

    let op = OpTimer::start_with(
        "zotero_migrate",
        format!("path={}", trunc(&args.zotero_dir, 160)),
    );
    let report = move |current, total| {
        let _ = on_progress.send(MigrateProgress { current, total });
    };
    op.finish_extra(migrate_zotero(args, report).await, |r| {
        format!("imported={} skipped={}", r.imported, r.skipped)
    })
}
