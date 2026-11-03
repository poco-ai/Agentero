use crate::app::terminal;
use crate::app::terminal::presets::TerminalAppStatus;
use crate::core::blocking::run_blocking;
use crate::core::error::{map_err, ApiResult, AppError};
use crate::features::system::settings::AppSettingsStore;
use serde::Serialize;
use std::path::PathBuf;
use tauri::State;

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenInTerminalResult {
    /// Absolute directory opened as the terminal cwd.
    pub cwd: String,
}

/// List known external terminals for the "Open in Terminal" preference.
#[tauri::command]
#[specta::specta]
pub async fn terminal_apps_probe() -> Result<ApiResult<Vec<TerminalAppStatus>>, String> {
    Ok(run_blocking(|| ApiResult::ok(terminal::presets::probe())).await)
}

/// Open the preferred terminal (or the system default when unset/unavailable)
/// at `path`. Directories open as themselves; files open their parent directory.
#[tauri::command]
#[specta::specta]
pub fn path_open_in_terminal(
    path: String,
    store: State<'_, AppSettingsStore>,
) -> ApiResult<OpenInTerminalResult> {
    let p = PathBuf::from(path.trim());
    if p.as_os_str().is_empty() {
        return map_err(AppError::message("path is required"));
    }
    // A poisoned lock or redacted-settings failure must not block the action:
    // an empty preference simply means the system default.
    let preferred = store
        .get()
        .map(|result| result.settings.terminal_app)
        .unwrap_or_default();
    match terminal::open_in_terminal(&p, &preferred) {
        Ok(cwd) => ApiResult::ok(OpenInTerminalResult {
            cwd: cwd.to_string_lossy().into_owned(),
        }),
        Err(e) => map_err(e),
    }
}
