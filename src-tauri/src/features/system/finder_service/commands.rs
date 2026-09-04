use crate::core::error::{map_err, ApiResult};

use super::{collect_status, install, uninstall, FinderServiceStatus};
use tauri::{AppHandle, Runtime};

#[tauri::command]
pub fn finder_service_status<R: Runtime>(_app: AppHandle<R>) -> ApiResult<FinderServiceStatus> {
    ApiResult::ok(collect_status())
}

#[tauri::command]
pub async fn finder_service_install<R: Runtime>(
    _app: AppHandle<R>,
) -> ApiResult<FinderServiceStatus> {
    match install() {
        Ok(status) => ApiResult::ok(status),
        Err(e) => map_err(e),
    }
}

#[tauri::command]
pub fn finder_service_uninstall<R: Runtime>(_app: AppHandle<R>) -> ApiResult<FinderServiceStatus> {
    match uninstall() {
        Ok(status) => ApiResult::ok(status),
        Err(e) => map_err(e),
    }
}
