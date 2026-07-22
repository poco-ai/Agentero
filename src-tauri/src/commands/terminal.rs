use crate::error::AppError;
use crate::services::terminal;
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
pub fn path_open_in_terminal(path: String) -> Result<OpenInTerminalResult, AppError> {
    let p = PathBuf::from(path.trim());
    if p.as_os_str().is_empty() {
        return Err(AppError::invalid("path is required"));
    }
    let cwd = terminal::open_in_terminal(&p)?;
    Ok(OpenInTerminalResult {
        cwd: cwd.to_string_lossy().into_owned(),
    })
}
