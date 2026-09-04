//! `paper_refs_parse` / `paper_refs_list` / `library_citing_scan` — reference
//! commands.

use crate::core::error::{map_err, ApiResult, AppError};
use crate::core::log_util::{trunc, OpTimer};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperRefsParseArgs {
    pub vault_path: String,
    pub path: String,
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperRefsListArgs {
    pub vault_path: String,
    pub path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryCitingScanArgs {
    pub vault_path: String,
    /// Background-task id: routes progress events and carries cancellation.
    #[serde(default)]
    pub task_id: Option<String>,
    /// How far back a citing paper still counts as "new" (default 183).
    #[serde(default)]
    pub since_days: Option<i64>,
    /// Maximum candidates returned (default 20).
    #[serde(default)]
    pub budget: Option<usize>,
    /// Ignore cached citation pages and refetch every seed.
    #[serde(default)]
    pub force: bool,
}

/// Parse (or refresh with `force`) the reference sidecar for one paper. Online
/// reference lookup is always on; local bib/bbl parsing still runs.
#[tauri::command]
pub async fn paper_refs_parse(
    args: PaperRefsParseArgs,
) -> Result<ApiResult<super::CiteSidecar>, String> {
    let op = OpTimer::start_with(
        "paper_refs_parse",
        format!("path={} force={}", trunc(&args.path, 120), args.force),
    );
    let vault = match crate::core::fs::resolve_vault(&args.vault_path) {
        Ok(vault) => vault,
        Err(err) => {
            op.finish_err(&err);
            return Ok(map_err(err));
        }
    };
    Ok(op.finish_result(super::parse_paper_refs(&vault, &args.path, true, args.force).await))
}

/// Read the existing reference sidecar; `None` when it has not been parsed yet.
#[tauri::command]
pub async fn paper_refs_list(args: PaperRefsListArgs) -> ApiResult<Option<super::CiteSidecar>> {
    crate::core::blocking::run_blocking(move || {
        let op = OpTimer::start_with(
            "paper_refs_list",
            format!("path={}", trunc(&args.path, 120)),
        );
        let vault = match crate::core::fs::resolve_vault(&args.vault_path) {
            Ok(vault) => vault,
            Err(err) => {
                op.finish_err(&err);
                return map_err(err);
            }
        };
        let rel = match crate::core::fs::sanitize_vault_rel(&args.path) {
            Ok(rel) => rel,
            Err(_) => {
                let err = AppError::message("invalid paper path");
                op.finish_err(&err);
                return map_err(err);
            }
        };
        let sidecar_path = vault.join(rel).join("source").join(super::SIDECAR_FILE);
        op.finish_result(Ok(super::read_sidecar(&sidecar_path)))
    })
    .await
}

/// Progress payload for the background-task panel. Field names must stay in
/// sync with `BackgroundTaskProgressEvent` in `src/lib/core/background-tasks.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CitingScanProgress {
    task_id: String,
    phase: String,
    downloaded_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_bytes: Option<u64>,
    progress: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_count: Option<usize>,
}

/// Scan the whole library for new papers that cite it but are not imported yet.
#[tauri::command]
pub async fn library_citing_scan(
    app: tauri::AppHandle,
    args: LibraryCitingScanArgs,
) -> Result<ApiResult<super::citing::CitingScanResult>, String> {
    let op = OpTimer::start_with(
        "library_citing_scan",
        format!(
            "sinceDays={:?} budget={:?} force={}",
            args.since_days, args.budget, args.force
        ),
    );
    let vault = match crate::core::fs::resolve_vault(&args.vault_path) {
        Ok(vault) => vault,
        Err(err) => {
            op.finish_err(&err);
            return Ok(map_err(err));
        }
    };

    let mut opts = super::citing::ScanOptions::default();
    if let Some(days) = args.since_days {
        opts.since_days = days;
    }
    if let Some(budget) = args.budget {
        opts.budget = budget;
    }
    opts.force = args.force;

    let task_id = args.task_id.unwrap_or_default();

    let cancel_id = task_id.clone();
    let cancelled =
        move || !cancel_id.is_empty() && crate::core::background_tasks::is_cancelled(&cancel_id);

    let progress_app = app.clone();
    let progress_id = task_id.clone();
    let progress =
        move |phase: &str, done: Option<usize>, total: Option<usize>, pct: Option<u8>| {
            // Phases without counts would fall into the panel's byte-formatting
            // branch and render a meaningless "0 B"; the caller labels those.
            let (Some(current), Some(total)) = (done, total) else {
                return;
            };
            if progress_id.is_empty() {
                return;
            }
            use tauri::Emitter;
            let _ = progress_app.emit(
                "background-task:progress",
                CitingScanProgress {
                    task_id: progress_id.clone(),
                    phase: phase.to_string(),
                    downloaded_bytes: 0,
                    total_bytes: None,
                    progress: pct,
                    current_count: Some(current),
                    total_count: Some(total),
                },
            );
        };

    let result = super::citing::scan(
        &vault,
        &opts,
        super::citing::ScanHooks {
            cancelled: Some(&cancelled),
            progress: Some(&progress),
        },
    )
    .await;

    // Always clear the flag: a leftover cancellation would immediately kill the
    // next task that reuses this id.
    if !task_id.is_empty() {
        crate::core::background_tasks::finish(&task_id);
    }
    Ok(op.finish_result(result))
}
