//! Commands to start/stop the per-window Vault filesystem watcher.

use tauri::{Manager, State};

use crate::features::watcher::FsWatchController;

/// Start (or restart) watching `vault_path` for this window. Emits
/// `vault:file-changed` to this window when files change on disk.
#[tauri::command]
pub fn fs_watch_start(
    window: tauri::WebviewWindow,
    controller: State<'_, FsWatchController>,
    vault_path: String,
) -> Result<(), String> {
    use crate::core::log_util::{trunc, OpTimer};

    let vault = vault_path.trim().to_string();
    let op = OpTimer::start_with("fs_watch_start", format!("path={}", trunc(&vault, 160)));
    if vault.is_empty() {
        op.finish_err_msg("message", "vault path is required");
        return Err("vault path is required".to_string());
    }
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    match controller.start(app, label, vault) {
        Ok(()) => {
            op.finish_ok();
            Ok(())
        }
        Err(e) => {
            op.finish_err_msg("watcher", &e);
            Err(e)
        }
    }
}

/// Stop watching for this window (no-op if not watching).
#[tauri::command]
pub fn fs_watch_stop(
    window: tauri::WebviewWindow,
    controller: State<'_, FsWatchController>,
) -> Result<(), String> {
    use crate::core::log_util::OpTimer;

    let op = OpTimer::start("fs_watch_stop");
    controller.stop(window.label());
    op.finish_ok();
    Ok(())
}
