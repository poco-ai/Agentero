//! Cross-feature lifecycle coordination for the active Vault session.

use crate::app::vault_session::vault_path_arg;
use crate::core::error::{map_err, ApiResult};
use crate::core::jobs::{emit_job_changed, JobCenter};
use crate::core::log_util::{trunc, OpTimer};
use crate::features::catalog::CapsCache;
use tauri::Manager;

/// Release Host-side resources held for a vault the app switched away from.
///
/// Feature-specific cleanup remains owned by each feature; the app shell only
/// orchestrates the cross-feature release sequence.
#[tauri::command]
pub async fn vault_release(app: tauri::AppHandle, path: String) -> ApiResult<()> {
    let op = OpTimer::start_with("vault_release", format!("path={}", trunc(&path, 200)));
    let vault = match vault_path_arg(&path) {
        Ok(p) => p,
        Err(err) => {
            op.finish_err(&err);
            return map_err(err);
        }
    };

    let jobs = app.state::<JobCenter>().handle();
    let cancelled = jobs.cancel_for_vault(&vault).await;
    for snapshot in cancelled {
        emit_job_changed(&app, snapshot);
    }
    jobs.drain_and_spawn(&app).await;

    app.state::<CapsCache>().clear();
    crate::features::catalog::evict_catalog_conn(&vault);
    op.finish_result(Ok(()))
}
