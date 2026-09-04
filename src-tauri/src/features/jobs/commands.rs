use crate::core::error::ApiResult;

/// Request cooperative cancellation for a frontend background task.
#[tauri::command]
pub fn background_task_cancel(task_id: String) -> ApiResult<bool> {
    crate::core::background_tasks::cancel(&task_id);
    ApiResult::ok(true)
}
