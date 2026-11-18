//! Tauri commands for the device-local activity log.
//!
//! All commands are async and run their SQLite work in `run_blocking` so the
//! main thread (Windows UI message pump) is never blocked.

use crate::core::blocking::run_blocking;
use crate::core::error::{map_err, ApiResult};
use crate::core::usage::{
    clear_default, record_default, usage_board, usage_db_path, UsageBoard, UsageBoardQuery,
    UsageRecord,
};
use serde::Deserialize;
use tauri::AppHandle;

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRecordArgs {
    pub events: Vec<UsageRecord>,
}

#[tauri::command]
#[specta::specta]
pub async fn activity_record_events(
    app: AppHandle,
    args: ActivityRecordArgs,
) -> Result<ApiResult<usize>, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    forward_to_telemetry(&app, &args.events);
    #[cfg(any(target_os = "android", target_os = "ios"))]
    let _ = &app;

    Ok(run_blocking(move || match record_default(&args.events) {
        Ok(n) => ApiResult::ok(n),
        Err(e) => map_err(e),
    })
    .await)
}

/// Project events to their sanitized PostHog shape and forward them. No-op
/// unless product analytics is enabled; unmapped kinds are dropped.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn forward_to_telemetry(app: &AppHandle, events: &[UsageRecord]) {
    use crate::core::telemetry::Telemetry;
    use crate::core::usage::telemetry_projection;
    use std::sync::Arc;
    use tauri::Manager;

    let Some(telemetry) = app.try_state::<Arc<Telemetry>>() else {
        return;
    };
    let projections: Vec<_> = events.iter().filter_map(telemetry_projection).collect();
    telemetry.capture_activity(&projections);
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageClearArgs {
    #[serde(default)]
    pub vault: Option<String>,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageBoardArgs {
    pub vault: String,
    pub start_day: String,
    pub end_day: String,
    pub week_start: String,
}

#[tauri::command]
#[specta::specta]
pub async fn usage_board_query(args: UsageBoardArgs) -> ApiResult<UsageBoard> {
    run_blocking(move || {
        let query = UsageBoardQuery {
            vault: args.vault.clone(),
            start_day: args.start_day,
            end_day: args.end_day,
            week_start: args.week_start,
        };
        match usage_board(&usage_db_path(), &query) {
            Ok(mut board) => {
                attach_paper_titles(&args.vault, &mut board);
                ApiResult::ok(board)
            }
            Err(e) => map_err(e),
        }
    })
    .await
}

fn attach_paper_titles(vault: &str, board: &mut UsageBoard) {
    let vault = vault.trim();
    if vault.is_empty() || board.papers.is_empty() {
        return;
    }
    let root = std::path::Path::new(vault);
    for paper in &mut board.papers {
        let Ok(Some(record)) =
            crate::features::paper::catalog::papers::get_by_path(root, &paper.path)
        else {
            continue;
        };
        let title = record.title.trim();
        if !title.is_empty() {
            paper.title = Some(title.to_string());
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn usage_clear(args: UsageClearArgs) -> ApiResult<u64> {
    run_blocking(move || match clear_default(args.vault.as_deref()) {
        Ok(n) => ApiResult::ok(n),
        Err(e) => map_err(e),
    })
    .await
}
