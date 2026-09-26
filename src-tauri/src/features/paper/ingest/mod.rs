//! Desktop auto-ingest wiring: the FS-watcher trigger and startup reconcile
//! around the tauri-free adoption kernel
//! (`agentero_core::features::paper::import::auto_ingest`).
//!
//! Flow per candidate folder (a `papers/` direct child touched by a create /
//! rename batch): settle-probe the PDFs (two equal size snapshots), classify,
//! and — when the folder is a bare PDF folder — adopt it in place. The
//! classifier is the durable loop guard: once adoption writes NOTES.md and
//! the sidecar, the folder stops being adoptable; [`IngestQueue`] only
//! dedupes the settle window of one watcher burst.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use crate::features::paper::import::auto_ingest::{
    adopt_paper_folder, classify_papers_subfolder, wait_until_pdf_settled, AdoptOptions,
    FolderClass,
};

/// Gap between the two size snapshots that prove a copy finished.
const SETTLE_GAP: Duration = Duration::from_millis(700);
/// Upper bound for the settle probe; a still-growing folder is retried by the
/// next watcher batch instead of being adopted half-copied.
const SETTLE_MAX_WAIT: Duration = Duration::from_secs(8);

/// Folders with a scheduled or in-flight adoption. Managed per app (one queue
/// covers every window's watcher; folders are keyed by absolute path).
#[derive(Default)]
pub struct IngestQueue {
    inner: Mutex<HashSet<PathBuf>>,
}

/// `autoIngest` setting (default on; unreadable store degrades to on).
fn auto_ingest_enabled(app: &tauri::AppHandle) -> bool {
    use tauri::Manager;
    app.state::<crate::features::system::settings::AppSettingsStore>()
        .get()
        .map(|r| r.settings.auto_ingest)
        .unwrap_or(true)
}

/// The `papers/` direct-child folder a changed path belongs to, if any:
/// `papers/x` itself, or the parent of `papers/x/…`.
fn papers_child_candidate(vault: &Path, path: &Path) -> Option<PathBuf> {
    let canonical = agentero_core::fs::canonicalize_best_effort(vault);
    let rel = path
        .strip_prefix(&canonical)
        .or_else(|_| path.strip_prefix(vault))
        .ok()?;
    let rel = rel.to_string_lossy().replace('\\', "/");
    let segments: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
    match segments.as_slice() {
        ["papers", _] => Some(path.to_path_buf()),
        ["papers", _, ..] => path.parent().map(Path::to_path_buf),
        _ => None,
    }
}

/// Watcher-thread hook for one debounced FS batch. Only schedules work —
/// must never block the watcher loop.
pub fn on_fs_batch(app: &tauri::AppHandle, vault_root: &str, kind: &str, paths: &[String]) {
    // Adoption reacts to things appearing; removes/modifies are covered by
    // the create event of the same burst (and modifies would churn on every
    // NOTES.md save in every existing paper folder).
    if kind != "create" && kind != "rename" {
        return;
    }
    if !auto_ingest_enabled(app) {
        return;
    }
    let vault = PathBuf::from(vault_root);
    for path in paths {
        let Some(folder) = papers_child_candidate(&vault, Path::new(path)) else {
            continue;
        };
        {
            use tauri::Manager;
            let queue = app.state::<IngestQueue>();
            let mut guard = queue.inner.lock().unwrap_or_else(|p| p.into_inner());
            if !guard.insert(folder.clone()) {
                continue; // already scheduled / in flight
            }
        }
        let app = app.clone();
        let task_vault = vault.clone();
        tauri::async_runtime::spawn(async move {
            run_adoption(&app, &task_vault, folder, true).await;
        });
    }
}

/// Settle (optional) → classify → adopt → release the queue slot. Shared by
/// the watcher trigger and the startup reconcile.
pub(crate) async fn run_adoption(
    app: &tauri::AppHandle,
    vault: &Path,
    folder: PathBuf,
    wait_settled: bool,
) -> bool {
    if !auto_ingest_enabled(app) {
        return false;
    }
    // Settle probe + classification are blocking (disk + sqlite); keep them
    // off the async runtime, mirroring the job lanes.
    let probe_vault = vault.to_path_buf();
    let probe_folder = folder.clone();
    let class = tauri::async_runtime::spawn_blocking(move || {
        if wait_settled && !wait_until_pdf_settled(&probe_folder, SETTLE_GAP, SETTLE_MAX_WAIT) {
            // Still copying (or nothing adoptable): the next watcher batch
            // re-triggers once the copy finishes.
            return FolderClass::NoPdf;
        }
        classify_papers_subfolder(&probe_vault, &probe_folder)
    })
    .await;
    let adopted = match class {
        Ok(FolderClass::Adopt { .. }) => {
            use tauri::Manager;
            let cache = app.state::<crate::features::paper::catalog::CapsCache>();
            let host_app = crate::features::host_hooks::wrap(app);
            let note_mode = crate::features::paper::import::note_mode_from_app(app);
            let result = adopt_paper_folder(
                vault,
                &folder,
                AdoptOptions {
                    note_mode,
                    cache: Some(&cache),
                    app: Some(&host_app),
                },
            )
            .await;
            if let Err(e) = &result {
                log::warn!(
                    target: "agentero::ingest",
                    "auto-ingest failed for {}: {e}",
                    folder.display()
                );
            }
            result.is_ok()
        }
        Ok(_) => false,
        Err(e) => {
            log::warn!(
                target: "agentero::ingest",
                "auto-ingest probe task failed for {}: {e}",
                folder.display()
            );
            false
        }
    };
    {
        use tauri::Manager;
        let queue = app.state::<IngestQueue>();
        let mut guard = queue.inner.lock().unwrap_or_else(|p| p.into_inner());
        guard.remove(&folder);
    }
    adopted
}

/// Scan `papers/` direct children once and adopt every candidate. Startup
/// reconcile: catches folders created while the app (and its watcher) was
/// closed. Disk state at launch is assumed settled except for an in-flight
/// copy, which the settle probe still guards.
pub async fn reconcile_folders(app: &tauri::AppHandle, vault: &Path) -> usize {
    let papers = vault.join("papers");
    let Ok(entries) = std::fs::read_dir(&papers) else {
        return 0;
    };
    let mut adopted = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if run_adoption(app, vault, path, true).await {
            adopted += 1;
        }
    }
    adopted
}

pub mod commands;
