//! List `*.table.json` files and the notes that embed one of them.

use crate::core::blocking::run_blocking;
use crate::core::error::{map_err, ApiResult};
use crate::core::log_util::OpTimer;
use crate::features::markdown::tables::{
    self, ResearchTableBacklinkArgs, ResearchTableBacklinkResult, ResearchTableListArgs,
    ResearchTableListResult,
};

/// Walk the vault for research tables. See `research_table::lookup`.
///
/// Async + `run_blocking`: the walk reads table files and must not run on the
/// main thread (Windows UI message pump).
#[tauri::command]
#[specta::specta]
pub async fn research_table_list(
    args: ResearchTableListArgs,
) -> ApiResult<ResearchTableListResult> {
    run_blocking(move || {
        let op = OpTimer::start("research_table_list");
        match tables::list_research_tables(args) {
            Ok(result) => {
                op.finish_ok();
                ApiResult::ok(result)
            }
            Err(error) => {
                op.finish_err(&error);
                map_err(error)
            }
        }
    })
    .await
}

/// Notes that embed a research table by path or id.
#[tauri::command]
#[specta::specta]
pub async fn research_table_backlinks(
    args: ResearchTableBacklinkArgs,
) -> ApiResult<ResearchTableBacklinkResult> {
    run_blocking(move || {
        let op = OpTimer::start("research_table_backlinks");
        match tables::research_table_backlinks(args) {
            Ok(result) => {
                op.finish_ok();
                ApiResult::ok(result)
            }
            Err(error) => {
                op.finish_err(&error);
                map_err(error)
            }
        }
    })
    .await
}
