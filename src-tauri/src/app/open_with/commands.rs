use crate::app::open_with::{self, OpenWithApp};
use crate::core::blocking::run_blocking;
use crate::core::error::{map_err, ApiResult, AppError};
use crate::features::system::settings::AppSettingsStore;
use std::path::PathBuf;
use tauri::State;

/// Settings `terminalApp` id (empty = system default). A poisoned lock must
/// not block the menu: the terminal row simply falls back to the default.
fn terminal_preference(store: &AppSettingsStore) -> String {
    store
        .get()
        .map(|result| result.settings.terminal_app)
        .unwrap_or_default()
}

/// List the menu rows for the path bar "Open with" control: the system file
/// manager, the editors installed on this machine, and the terminal. Icons are
/// real application icons (PNG data URLs) when the host can extract them.
#[tauri::command]
#[specta::specta]
pub async fn path_open_with_apps(
    store: State<'_, AppSettingsStore>,
) -> Result<ApiResult<Vec<OpenWithApp>>, String> {
    let preferred = terminal_preference(&store);
    Ok(run_blocking(move || ApiResult::ok(open_with::probe(&preferred))).await)
}

/// Open `path` with a probed row id: `"finder"` (file manager), `"terminal"`
/// (Settings-preferred terminal), or an installed editor. Directories open as
/// themselves; files open their parent directory.
#[tauri::command]
#[specta::specta]
pub async fn path_open_with(
    app_id: String,
    path: String,
    store: State<'_, AppSettingsStore>,
) -> Result<ApiResult<()>, String> {
    let preferred = terminal_preference(&store);
    Ok(run_blocking(move || {
        let target = PathBuf::from(path.trim());
        if target.as_os_str().is_empty() {
            return map_err(AppError::message("path is required"));
        }
        match open_with::open(&app_id, &target, &preferred) {
            Ok(()) => ApiResult::ok(()),
            Err(error) => map_err(error),
        }
    })
    .await)
}
