//! Commands to start/stop the per-window Vault filesystem watcher.

use tauri::{Manager, State};

use crate::error::AppError;
use crate::services::watcher::FsWatchController;

/// Start (or restart) watching `vault_path` for this window. Emits
/// `vault:file-changed` to this window when files change on disk.
#[tauri::command]
pub fn fs_watch_start(
    window: tauri::WebviewWindow,
    controller: State<'_, FsWatchController>,
    vault_path: String,
) -> Result<(), AppError> {
    use crate::log_util::{trunc, OpTimer};

    let vault = vault_path.trim().to_string();
    let op = OpTimer::start_with("fs_watch_start", format!("path={}", trunc(&vault, 160)));
    if vault.is_empty() {
        let err = AppError::invalid("vault path is required");
        op.finish_err(&err);
        return Err(err);
    }
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    op.finish(
        controller
            .start(app, label, vault)
            .map_err(AppError::internal),
    )
}

/// Stop watching for this window (no-op if not watching).
#[tauri::command]
pub fn fs_watch_stop(
    window: tauri::WebviewWindow,
    controller: State<'_, FsWatchController>,
) -> Result<(), AppError> {
    use crate::log_util::OpTimer;

    let op = OpTimer::start("fs_watch_stop");
    controller.stop(window.label());
    op.finish_ok();
    Ok(())
}
