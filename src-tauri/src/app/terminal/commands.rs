use crate::app::terminal;
use crate::core::error::{map_err, ApiResult, AppError};
use serde::Serialize;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenInTerminalResult {
    /// Absolute directory opened as the terminal cwd.
    pub cwd: String,
}

/// Open the system default terminal at `path`.
/// Directories open as themselves; files open their parent directory.
#[tauri::command]
pub fn path_open_in_terminal(path: String) -> ApiResult<OpenInTerminalResult> {
    let p = PathBuf::from(path.trim());
    if p.as_os_str().is_empty() {
        return map_err(AppError::message("path is required"));
    }
    match terminal::open_in_terminal(&p) {
        Ok(cwd) => ApiResult::ok(OpenInTerminalResult {
            cwd: cwd.to_string_lossy().into_owned(),
        }),
        Err(e) => map_err(e),
    }
}
