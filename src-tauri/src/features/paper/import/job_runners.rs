//! JobCenter runners for the import domain (`ParseBody` / `DownloadAssets` /
//! `RecognizeMetadata`).
//!
//! Registered at app startup (see `app::run`) so the JobCenter stays a pure
//! scheduler with no edges into import. The `DownloadAssets` runner owns the
//! post-download follow-up orchestration (PAPER.md backfill + layout pass);
//! the `RecognizeMetadata` runner owns the deferred-recognition pipeline
//! (probe → metadata/rename/merge → PAPER.md + refs + layout).

use crate::features::jobs::{
    emit_job_changed, JobCenter, JobKind, JobLane, RunOutcome, StartOutcome, StartedJob,
};
use crate::features::paper::catalog::CapsCache;
use std::sync::Arc;
use tauri::Manager;

/// Register the import job runners with the JobCenter.
pub fn register_job_runners(center: &JobCenter) {
    center.register_runner(JobKind::ParseBody, Arc::new(parse_body_runner));
    center.register_runner(JobKind::DownloadAssets, Arc::new(download_assets_runner));
    center.register_runner(
        JobKind::RecognizeMetadata,
        Arc::new(recognize_metadata_runner),
    );
}

/// Runner for [`JobKind::ParseBody`]: generate `PAPER.md` from PDF/TeX.
fn parse_body_runner(
    center: JobCenter,
    app: tauri::AppHandle,
    started: StartedJob,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    center.run_job(app, started, |_center, app, started| async move {
        let StartedJob {
            snapshot,
            vault_path: vault,
            paper_path: path,
            force,
            task_id,
            ..
        } = started;
        let task_id = task_id.unwrap_or_else(|| snapshot.id.clone());
        let cache = app.state::<CapsCache>();
        let result = crate::features::paper::import::pdf_parse::parse_paper_body(
            crate::features::paper::import::pdf_parse::PaperParseBodyArgs {
                vault_path: vault.to_string_lossy().to_string(),
                path,
                force,
                task_id: Some(task_id),
            },
            Some(&cache),
        )
        .await;
        // A skipped or successful parse returns Ok with no error; a real
        // liteparse failure also returns Ok, carrying the reason.
        match result {
            Ok(parsed) => match parsed.error {
                Some(message) => RunOutcome::Failed(Some(message)),
                None => RunOutcome::Succeeded,
            },
            Err(e) => RunOutcome::Failed(Some(e.to_string())),
        }
    })
}

/// Runner for [`JobKind::DownloadAssets`]: download PDF/TeX for a paper, then
/// backfill `PAPER.md` + layout for the freshly-downloaded assets. Byte-level
/// progress flows via `job:progress` (task_id defaults to the job
/// id) to the projected "download" row.
fn download_assets_runner(
    center: JobCenter,
    app: tauri::AppHandle,
    started: StartedJob,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    center.run_job(app, started, |center, app, started| async move {
        let StartedJob {
            snapshot,
            vault_path: vault,
            paper_path: path,
            task_id,
            ..
        } = started;
        let task_id = task_id.unwrap_or_else(|| snapshot.id.clone());
        let cache = app.state::<CapsCache>();
        let args = crate::features::paper::import::PaperDownloadAssetsArgs {
            vault_path: vault.to_string_lossy().to_string(),
            path: path.clone(),
            task_id: Some(task_id),
        };
        let host_app = crate::features::host_hooks::wrap(&app);
        let result = crate::features::paper::import::download_paper_assets_with_progress(
            args,
            Some(&host_app),
            Some(&cache),
        )
        .await;
        // Assets changed on disk: drop the stale capability bits.
        cache.invalidate(&vault, &path);

        match result {
            Ok(_) => {
                // arXiv e-print template / published venue → `#submitted:` /
                // `#venue:` catalog tags. Best-effort: never fail the download.
                if let Err(e) = crate::features::paper::venue::refresh_venue_tag(&vault, &path) {
                    log::warn!(target: "agentero::import",
                        "venue tag refresh failed for {path}: {e}");
                }
                // Follow-ups only when a local PDF actually exists. TeX-only
                // downloads (or a failed PDF attempt) must not enqueue layout /
                // ParseBody — those jobs fail with "No local PDF".
                let caps = cache.caps_for(&vault, &path);
                if caps.needs_paper_md() {
                    let snap = center
                        .enqueue_parse_body(&vault, &path, JobLane::Normal, false, None)
                        .await;
                    emit_job_changed(&app, snap.clone());
                    if let StartOutcome::Started(started) = center.try_start(&snap.id).await {
                        center.spawn_runner(&app, started);
                    }
                }
                if caps.has_pdf() {
                    let backend = app
                        .state::<crate::features::system::settings::AppSettingsStore>()
                        .layout_backend();
                    center.apply_layout_backend(&backend).await;
                    let lsnap = center
                        .enqueue_layout_analyze(&vault, &path, JobLane::Normal, false)
                        .await;
                    emit_job_changed(&app, lsnap.clone());
                    if let StartOutcome::Started(started) = center.try_start(&lsnap.id).await {
                        center.spawn_runner(&app, started);
                    }
                }
                RunOutcome::Succeeded
            }
            Err(e) => RunOutcome::Failed(Some(e.to_string())),
        }
    })
}

/// Runner for [`JobKind::RecognizeMetadata`]: recognize a just-committed
/// local PDF import in the background (liteparse probe → Zotero recognizer →
/// identifier resolution), land the result via `recognize::apply` (metadata
/// upsert / canonical-id rename / merge into an existing entry), then
/// orchestrate the PAPER.md + refs + layout follow-ups against the paper's
/// final path.
fn recognize_metadata_runner(
    center: JobCenter,
    app: tauri::AppHandle,
    started: StartedJob,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    center.run_job(app, started, |center, app, started| async move {
        let StartedJob {
            snapshot,
            vault_path: vault,
            paper_path: path,
            task_id,
            ..
        } = started;
        let task_id = task_id.unwrap_or_else(|| snapshot.id.clone());
        let cache = app.state::<CapsCache>();
        let index = app
            .state::<crate::features::vault::rename::WikiIndexState>()
            .handle();

        // Locate the main PDF (paper_commit convention: `{folder-id}.pdf`).
        let folder_id = path.rsplit(['/', '\\']).next().unwrap_or_default();
        let pdf = vault.join(&path).join(format!("{folder_id}.pdf"));
        if !pdf.is_file() {
            return RunOutcome::Succeeded; // nothing to recognize without a PDF
        }

        let translator_base = app
            .state::<crate::features::system::settings::AppSettingsStore>()
            .get()
            .ok()
            .map(|r| {
                r.settings
                    .translator_base_url
                    .trim()
                    .trim_end_matches('/')
                    .to_string()
            })
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                crate::features::paper::import::DEFAULT_TRANSLATOR_BASE_URL.to_string()
            });

        let probe =
            crate::features::paper::import::recognize::pdf_recognize::recognize_and_resolve(
                &pdf,
                &translator_base,
                Some(&task_id),
            )
            .await;

        // Cancelled mid-probe: land nothing; the paper keeps its placeholder.
        if probe.status == "error"
            && probe.error.as_deref().is_some_and(|e| {
                e.contains(crate::features::paper::import::pdf_parse::CANCELLED_MESSAGE)
            })
        {
            return RunOutcome::Cancelled;
        }

        let host_app = crate::features::host_hooks::wrap(&app);
        let outcome = crate::features::paper::import::recognize::apply::apply_probe_result(
            Some(&host_app),
            &vault,
            Some(&cache),
            index,
            &path,
            &probe,
        )
        .await;

        // Follow-ups run against the paper's final path (post rename/merge).
        let final_path = match &outcome {
            Ok(crate::features::paper::import::recognize::apply::RecognizeApply::Renamed {
                from,
                to,
            }) => {
                log::info!(target: "agentero::import",
                    "recognized paper renamed: {from} -> {to}");
                to.clone()
            }
            Ok(crate::features::paper::import::recognize::apply::RecognizeApply::Merged {
                into,
            }) => {
                log::info!(target: "agentero::import",
                    "recognized paper merged into existing entry: {into}");
                into.clone()
            }
            Ok(crate::features::paper::import::recognize::apply::RecognizeApply::Skipped(
                reason,
            )) => {
                log::info!(target: "agentero::import",
                    "recognition not applied ({reason}): {path}");
                path.clone()
            }
            _ => path.clone(),
        };
        cache.invalidate(&vault, &path);
        cache.invalidate(&vault, &final_path);

        // Soft warning for the frontend: arXiv id found, Atom lookup hit 429,
        // recognizer had no title — keep filename placeholder; Toast via
        // `job:changed` params (no new lifecycle event).
        if probe.warning.as_deref() == Some("arxiv_rate_limited")
            && probe
                .title
                .as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .is_none()
        {
            center
                .merge_running_job_params(
                    &snapshot.id,
                    serde_json::json!({
                        "warning": "arxiv_rate_limited",
                        "arxivId": probe.arxiv_id,
                    }),
                )
                .await;
        }

        let final_caps = cache.caps_for(&vault, &final_path);
        if final_caps.needs_paper_md() {
            let snap = center
                .enqueue_parse_body(&vault, &final_path, JobLane::Normal, false, None)
                .await;
            emit_job_changed(&app, snap.clone());
            if let StartOutcome::Started(started) = center.try_start(&snap.id).await {
                center.spawn_runner(&app, started);
            }
        }
        crate::features::paper::analyze::refs::spawn_parse_after_import(
            Some(&app),
            &vault,
            &final_path,
        );
        if final_caps.has_pdf() {
            let backend = app
                .state::<crate::features::system::settings::AppSettingsStore>()
                .layout_backend();
            center.apply_layout_backend(&backend).await;
            let lsnap = center
                .enqueue_layout_analyze(&vault, &final_path, JobLane::Normal, false)
                .await;
            emit_job_changed(&app, lsnap.clone());
            if let StartOutcome::Started(started) = center.try_start(&lsnap.id).await {
                center.spawn_runner(&app, started);
            }
        }

        match outcome {
            Ok(_) => RunOutcome::Succeeded,
            Err(e) => RunOutcome::Failed(Some(e.to_string())),
        }
    })
}
