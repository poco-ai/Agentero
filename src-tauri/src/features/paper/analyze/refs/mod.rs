//! Reference (citation) parsing for paper units.
//!
//! The tauri-free parsing pipeline lives in
//! `agentero_core::features::paper::analyze::refs`; this module bridges it and
//! keeps the desktop-only JobCenter integration (runner registration, job
//! spawn, Tauri commands).

pub use agentero_core::features::paper::analyze::refs::*;

#[cfg(feature = "desktop")]
pub mod commands;

#[cfg(feature = "desktop")]
use std::path::Path;
#[cfg(feature = "desktop")]
use std::sync::Arc;
#[cfg(feature = "desktop")]
use tauri::Manager;

/// Register the refs job runner + backfill probe with the JobCenter at app
/// startup. Dependency inversion: the scheduler dispatches, refs owns the
/// execution (no jobs→refs edge).
#[cfg(feature = "desktop")]
pub fn register_job_runners(center: &crate::features::jobs::JobCenter) {
    use crate::features::jobs::JobKind;
    center.register_runner(JobKind::ParseRefs, Arc::new(parse_refs_runner));
    // Reconcile backfill: a paper needs ParseRefs when its cite sidecar is absent.
    center.register_backfill_probe(JobKind::ParseRefs, |vault, path| {
        !vault.join(path).join("source").join(SIDECAR_FILE).is_file()
    });
}

/// Runner for [`crate::features::jobs::JobKind::ParseRefs`]: parse the cite
/// sidecar; online reference lookup is always enabled.
#[cfg(feature = "desktop")]
fn parse_refs_runner(
    center: crate::features::jobs::JobCenter,
    app: tauri::AppHandle,
    started: crate::features::jobs::StartedJob,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    use crate::features::jobs::{RunOutcome, StartedJob};
    center.run_job(app, started, |_center, _app, started| async move {
        let StartedJob {
            vault_path: vault,
            paper_path: path,
            force,
            ..
        } = started;
        match parse_paper_refs(&vault, &path, true, force).await {
            Ok(_) => RunOutcome::Succeeded,
            Err(e) => RunOutcome::Failed(Some(e.to_string())),
        }
    })
}

/// Fire-and-forget refs parse after an import/download finished (desktop
/// scheduling: JobCenter enqueue + job events when an app handle is present;
/// direct tokio spawn otherwise). Shadows the tauri-free core variant for
/// desktop callers; the core pipeline reaches this through
/// `agentero_core::app_handle::HostHooks::spawn_parse_after_import`.
#[cfg(feature = "desktop")]
pub fn spawn_parse_after_import(app: Option<&tauri::AppHandle>, vault: &Path, path_rel: &str) {
    if let Some(app) = app {
        let vault = vault.to_path_buf();
        let path_rel = path_rel.to_string();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let center = app.state::<crate::features::jobs::JobCenter>().handle();
            let snapshot = center
                .enqueue_parse_refs(
                    &vault,
                    &path_rel,
                    crate::features::jobs::JobLane::Normal,
                    false,
                )
                .await;
            crate::features::jobs::emit_job_changed(&app, snapshot.clone());
            match center.try_start(&snapshot.id).await {
                crate::features::jobs::StartOutcome::Started(started) => {
                    center.run_started(&app, started).await;
                }
                crate::features::jobs::StartOutcome::Skipped(skipped) => {
                    crate::features::jobs::emit_job_changed(&app, skipped);
                }
                crate::features::jobs::StartOutcome::Waiting => {}
            }
        });
        return;
    }

    agentero_core::features::paper::analyze::refs::spawn_parse_after_import(None, vault, path_rel);
}
