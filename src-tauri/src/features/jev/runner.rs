//! JobCenter runner for jEV smart highlights.

use crate::core::decision::SystemOneProvider;
use crate::core::error::AppError;
use crate::core::fs::{resolve_paper_dir, resolve_vault};
use crate::features::jev::service::{
    jev_suggest_highlights_with_progress, read_title_from_sidecar, SmartHighlightLimits,
};
use crate::features::jobs::{JobCenter, RunOutcome, StartedJob};
use crate::features::paper::catalog::probe_paper_caps;
use crate::features::system::settings::AppSettingsStore;
use std::sync::Arc;
use tauri::Manager;

pub fn jev_smart_highlights_runner(
    center: JobCenter,
    app: tauri::AppHandle,
    started: StartedJob,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    Box::pin(async move {
        center
            .run_job(app.clone(), started, |center, app, started| async move {
                let job_id = started.snapshot.id.clone();
                let vault_path = started.vault_path;
                let paper_path = started.paper_path;

                let run = async {
                    let vault = resolve_vault(vault_path.to_string_lossy().as_ref())?;
                    let (paper_dir, _rel) = resolve_paper_dir(&vault, &paper_path)?;

                    let caps = probe_paper_caps(&paper_dir);
                    let pdf_path = caps
                        .pdf_path
                        .ok_or_else(|| AppError::message("No local PDF for smart highlight"))?;

                    let title = read_title_from_sidecar(&paper_dir)
                        .or_else(|| {
                            paper_dir
                                .file_name()
                                .map(|n| n.to_string_lossy().to_string())
                        })
                        .unwrap_or_else(|| "Untitled paper".to_string());

                    let provider = app.state::<Arc<SystemOneProvider>>().inner().clone();
                    let limits = app.state::<AppSettingsStore>().smart_highlight_limits();

                    let progress_center = center.clone();
                    let progress_job_id = job_id.clone();
                    let on_progress = move |current, total| {
                        let progress = if total == 0 {
                            0.0
                        } else {
                            (current as f32 / total as f32) * 100.0
                        };
                        let phase = if current < total {
                            "scoring"
                        } else {
                            "locating"
                        };
                        let center = progress_center.clone();
                        let job_id = progress_job_id.clone();
                        let phase = phase.to_string();
                        tauri::async_runtime::spawn(async move {
                            let _snapshot = center
                                .job_report(&job_id, Some(progress), Some(phase), None, None)
                                .await;
                        });
                    };

                    let (concurrency, timeout_secs) = limits;
                    let highlights = jev_suggest_highlights_with_progress(
                        &provider,
                        &pdf_path,
                        &title,
                        SmartHighlightLimits {
                            concurrency: usize::try_from(concurrency).unwrap_or(1),
                            request_timeout: std::time::Duration::from_secs(u64::from(
                                timeout_secs,
                            )),
                        },
                        &started.cancel_token,
                        on_progress,
                    )
                    .await?;

                    let result = serde_json::json!({
                        "result": {
                            "highlights": highlights,
                        }
                    });
                    center.merge_running_job_params(&job_id, result).await;

                    Ok::<(), AppError>(())
                };

                match run.await {
                    Ok(()) => RunOutcome::Succeeded,
                    Err(err) => {
                        let message = err.to_string();
                        if started.cancel_token.is_cancelled() || message.contains("cancelled") {
                            RunOutcome::Cancelled
                        } else {
                            RunOutcome::Failed(Some(message))
                        }
                    }
                }
            })
            .await;
    })
}

/// Register the jEV smart-highlights runner with the JobCenter.
pub fn register_job_runners(center: &JobCenter) {
    use crate::features::jobs::JobKind;
    center.register_runner(
        JobKind::JevSmartHighlights,
        Arc::new(jev_smart_highlights_runner),
    );
}
