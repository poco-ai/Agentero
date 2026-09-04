//! Tauri commands for layout ONNX model status / ensure.

use super::{ensure, status, LayoutModelStatus};
use crate::core::error::{map_err, ApiResult};
use tauri::AppHandle;

#[tauri::command]
pub fn layout_model_status() -> ApiResult<LayoutModelStatus> {
    ApiResult::ok(status())
}

/// Download (if needed) into XDG cache. Pass `progressTaskId` from
/// `enqueueBackgroundTask` so the Host can emit `background-task:progress`
/// and honor cancel.
#[tauri::command]
pub async fn layout_model_ensure(
    app: AppHandle,
    progress_task_id: Option<String>,
) -> ApiResult<LayoutModelStatus> {
    let task_id = progress_task_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let result = ensure(Some(&app), task_id).await;
    if let Some(id) = task_id {
        crate::core::background_tasks::finish(id);
    }
    match result {
        Ok(s) => ApiResult::ok(s),
        Err(e) => map_err(e),
    }
}
