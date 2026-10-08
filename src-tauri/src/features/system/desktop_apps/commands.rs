use crate::core::blocking::run_blocking;
use crate::core::error::{map_err, ApiResult};
use crate::features::system::desktop_apps::{
    open_desktop_app, probe_desktop_apps, DesktopAppId, DesktopAppStatus,
};

/// List which known desktop apps are installed on this machine.
#[tauri::command]
#[specta::specta]
pub async fn desktop_apps_probe() -> Result<ApiResult<Vec<DesktopAppStatus>>, String> {
    Ok(run_blocking(|| ApiResult::ok(probe_desktop_apps())).await)
}

/// Launch one installed desktop app (macOS or Windows).
#[tauri::command]
#[specta::specta]
pub async fn desktop_app_open(id: DesktopAppId) -> Result<ApiResult<()>, String> {
    Ok(run_blocking(move || match open_desktop_app(id) {
        Ok(()) => ApiResult::ok(()),
        Err(error) => map_err(error),
    })
    .await)
}
