//! Zotero commands: library scan/migrate (fully local) and catalog
//! export/import through the Translator Runtime.

use super::{
    export_catalog, import_catalog_with_mode, migrate_zotero, scan_zotero, MigrateProgress,
    PaperExportArgs, PaperExportResult, ZoteroMigrateArgs, ZoteroMigrateResult, ZoteroScan,
    ZoteroScanArgs,
};
use crate::core::blocking::run_blocking;
use crate::core::error::ApiResult;
use crate::features::import::{PaperImportArgs, PaperImportResult};
use crate::features::remote::{import_bridge, parse_remote_handle, RemoteRegistry};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;

/// Read-only preview of a Zotero data directory (item + local-PDF counts).
#[tauri::command]
pub async fn zotero_scan(args: ZoteroScanArgs) -> ApiResult<ZoteroScan> {
    run_blocking(move || {
        use crate::core::log_util::{trunc, OpTimer};

        let op = OpTimer::start_with(
            "zotero_scan",
            format!("path={}", trunc(&args.zotero_dir, 160)),
        );
        op.finish_result(scan_zotero(args))
    })
    .await
}

/// Migrate a Zotero library into `papers/…` + catalog; optionally copy PDFs.
/// Streams `{current,total,phase}` progress to the UI via `on_progress`.
#[tauri::command]
pub async fn zotero_migrate(
    app: tauri::AppHandle,
    args: ZoteroMigrateArgs,
    on_progress: Channel<MigrateProgress>,
) -> ApiResult<ZoteroMigrateResult> {
    use crate::core::log_util::{trunc, OpTimer};

    let op = OpTimer::start_with(
        "zotero_migrate",
        format!("path={}", trunc(&args.zotero_dir, 160)),
    );
    let report = move |current, total, phase: &str| {
        let _ = on_progress.send(MigrateProgress {
            current,
            total,
            phase: phase.to_string(),
        });
    };
    let note_mode = crate::features::import::note_mode_from_app(&app);
    op.finish_result_ok_extra(
        migrate_zotero(args, report, Some(&app), note_mode).await,
        |r| format!("imported={} skipped={}", r.imported, r.skipped),
    )
}

/// Export catalog papers via Translator `POST /export` (Zotero JSON array → BibTeX/RIS/…).
#[tauri::command]
pub async fn paper_export(args: PaperExportArgs) -> ApiResult<PaperExportResult> {
    use crate::core::log_util::OpTimer;

    let format = args.format.as_deref().unwrap_or("bibtex");
    let op = OpTimer::start_with("paper_export", format!("format={format}"));
    op.finish_result(export_catalog(args).await)
}

/// Import BibTeX/RIS/… via Translator `POST /import`, write papers into vault + catalog.
#[tauri::command]
pub async fn paper_import(
    app: tauri::AppHandle,
    registry: State<'_, Arc<RemoteRegistry>>,
    args: PaperImportArgs,
) -> Result<ApiResult<PaperImportResult>, String> {
    use crate::core::log_util::OpTimer;

    let op = OpTimer::start("paper_import");
    let note_mode = crate::features::import::note_mode_from_app(&app);
    if let Some(session_id) = parse_remote_handle(&args.vault_path) {
        let session = match registry.get(session_id).await {
            Ok(s) => s,
            Err(e) => {
                op.finish_err(&e);
                return Ok(crate::core::error::map_err(e));
            }
        };
        return Ok(op.finish_result_ok_extra(
            import_bridge::import_catalog_remote(session, args, note_mode).await,
            |r| format!("imported={} skipped={}", r.imported, r.skipped),
        ));
    }
    Ok(op.finish_result_ok_extra(
        import_catalog_with_mode(args, Some(&app), note_mode).await,
        |r| format!("imported={} skipped={}", r.imported, r.skipped),
    ))
}
