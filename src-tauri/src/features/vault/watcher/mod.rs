//! Filesystem watcher: notifies the renderer when Vault files change on disk
//! (external editors, Agent subprocess writes) so open editors and the file
//! tree can reload. One recursive watcher per window; events are scoped to the
//! originating window via its label.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify_debouncer_full::notify::event::{ModifyKind, RenameMode};
use notify_debouncer_full::notify::{
    Config as NotifyConfig, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Manager};

/// Trailing quiet window before a batch of FS events is emitted to the UI.
const DEBOUNCE: Duration = Duration::from_millis(300);

/// Payload for the `vault:file-changed` event (consumed by the renderer).
#[derive(specta::Type, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangedPayload {
    /// Absolute paths touched by this (debounced) batch.
    pub paths: Vec<String>,
    /// Coarse change kind: "create" | "modify" | "remove" | "other".
    pub kind: String,
    /// Present only when the OS delivered one trustworthy old/new rename pair.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rename: Option<FileRename>,
}

/// A rename pair emitted by the native watcher. `None` means the watcher did
/// not preserve enough information for automatic internal-link repair.
#[derive(specta::Type, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRename {
    pub from: String,
    pub to: String,
}

struct WatchHandle {
    /// Dropping the watcher disconnects its event channel and wakes a blocked `recv`.
    watcher: Arc<Mutex<Option<RecommendedWatcher>>>,
}

/// Per-window filesystem watchers. Mirrors the `Mutex<HashMap<..>>` pattern used
/// by `AgentRunController`.
pub struct FsWatchController {
    inner: Mutex<HashMap<String, WatchHandle>>,
}

impl Default for FsWatchController {
    fn default() -> Self {
        Self::new()
    }
}

impl FsWatchController {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Start (or restart) a recursive watcher on `vault_path` for `window_label`.
    /// Any previous watcher for the same window is stopped first.
    pub fn start(
        &self,
        app: AppHandle,
        window_label: String,
        vault_path: String,
    ) -> Result<(), String> {
        self.stop(&window_label);

        let watch_root = vault_path.clone();
        let label = window_label.clone();
        let watcher_slot: Arc<Mutex<Option<RecommendedWatcher>>> = Arc::new(Mutex::new(None));
        let watcher_slot_thread = watcher_slot.clone();

        std::thread::Builder::new()
            .name(format!("vault-watch:{window_label}"))
            .spawn(move || {
                let (tx, rx) = std::sync::mpsc::channel();
                let mut watcher = match RecommendedWatcher::new(
                    move |res| {
                        let _ = tx.send(res);
                    },
                    NotifyConfig::default(),
                ) {
                    Ok(w) => w,
                    Err(e) => {
                        log::error!(target: "agentero::watcher", "vault watcher init failed: {e}");
                        return;
                    }
                };
                if let Err(e) =
                    watcher.watch(std::path::Path::new(&watch_root), RecursiveMode::Recursive)
                {
                    log::error!(target: "agentero::watcher", "vault watcher watch failed: {e}");
                    return;
                }
                if let Ok(mut slot) = watcher_slot_thread.lock() {
                    *slot = Some(watcher);
                } else {
                    return;
                }

                // Idle: block on `recv` (no periodic wakeups).
                // Active burst: trailing debounce via `recv_timeout` only while
                // events are pending — timeouts never run when the queue is empty.
                let mut pending: Vec<Event> = Vec::new();
                let mut deadline: Option<Instant> = None;
                loop {
                    let recv = match deadline {
                        None => match rx.recv() {
                            Ok(msg) => Ok(Some(msg)),
                            Err(_) => Err(()),
                        },
                        Some(until) => {
                            let wait = until.saturating_duration_since(Instant::now());
                            if wait.is_zero() {
                                Ok(None)
                            } else {
                                match rx.recv_timeout(wait) {
                                    Ok(msg) => Ok(Some(msg)),
                                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Ok(None),
                                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err(()),
                                }
                            }
                        }
                    };

                    match recv {
                        Err(()) => break,
                        Ok(None) => {
                            if !pending.is_empty() {
                                let batch = std::mem::take(&mut pending);
                                for payload in payloads_from_events(batch) {
                                    invalidate_caps_for_paths(&app, &watch_root, &payload.paths);
                                    // Watch-folder auto-ingest (papers/
                                    // adoption); schedules work, never blocks
                                    // this loop.
                                    crate::features::paper::ingest::on_fs_batch(
                                        &app,
                                        &watch_root,
                                        &payload.kind,
                                        &payload.paths,
                                    );
                                    let _ = app.emit_to(
                                        EventTarget::webview_window(label.clone()),
                                        "vault:file-changed",
                                        payload,
                                    );
                                }
                            }
                            deadline = None;
                        }
                        Ok(Some(Ok(event))) => {
                            pending.push(event);
                            deadline = Some(Instant::now() + DEBOUNCE);
                        }
                        Ok(Some(Err(_err))) => {}
                    }
                }

                if let Ok(mut slot) = watcher_slot_thread.lock() {
                    *slot = None;
                }
            })
            .map_err(|e| e.to_string())?;

        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "fs watch controller lock poisoned".to_string())?;
        guard.insert(
            window_label,
            WatchHandle {
                watcher: watcher_slot,
            },
        );
        Ok(())
    }

    /// Stop and drop the watcher for `window_label` (no-op if none).
    pub fn stop(&self, window_label: &str) {
        if let Ok(mut guard) = self.inner.lock() {
            if let Some(handle) = guard.remove(window_label) {
                if let Ok(mut slot) = handle.watcher.lock() {
                    // Dropping RecommendedWatcher closes its channel and wakes `recv`.
                    *slot = None;
                }
            }
        }
    }
}

/// Ignore churn from internal state, VCS metadata, and dependencies.
/// Sync-store artifacts (`blobs/`, `manifests/`, `HEAD`, `vault.json`)
/// mirrored into the vault by a desktop WebDAV client are engine churn too,
/// never user content — matched as any path segment, mirroring
/// `snapshot::is_ignored_name` so the two never disagree.
fn is_ignored(path: &str) -> bool {
    let p = path.replace('\\', "/");
    p.contains("/.agentero/")
        || p.contains("/.git/")
        || p.contains("/node_modules/")
        || p.split('/')
            .any(crate::features::vault::tree::is_sync_store_artifact)
}

/// Files whose presence decides `PaperCaps`: a PDF to parse, LaTeX source that
/// supersedes liteparse, or an existing `PAPER.md`.
fn is_caps_relevant(path: &str) -> bool {
    let lower = path.replace('\\', "/").to_ascii_lowercase();
    lower.ends_with("/paper.md")
        || lower.ends_with(".pdf")
        || lower.ends_with(".tex")
        || lower.ends_with(".ltx")
}

/// Paper folders a changed file can belong to: every ancestor directory of the
/// changed path (up to the vault root). Caps entries are keyed by the paper
/// folder, so a deep write like `source/figs/a.tex` must invalidate
/// `papers/p1` too; non-paper ancestors are never cache keys, so removing them
/// is a harmless no-op.
fn caps_paper_dirs(vault_root: &str, path: &str) -> Vec<String> {
    let root = std::path::Path::new(vault_root);
    let canonical = crate::core::fs::canonicalize_best_effort(root);
    let file = std::path::Path::new(path);
    let Ok(rel) = file
        .strip_prefix(&canonical)
        .or_else(|_| file.strip_prefix(root))
    else {
        return Vec::new();
    };
    let rel = rel.to_string_lossy().replace('\\', "/");
    let mut dirs = Vec::new();
    let mut current = rel.as_str();
    while let Some((parent, _)) = current.rsplit_once('/') {
        if parent.is_empty() {
            break;
        }
        dirs.push(parent.to_string());
        current = parent;
    }
    dirs
}

/// Drop cached `PaperCaps` for folders an external write touched, so the next
/// reconcile probes real disk state instead of a snapshot from earlier in the
/// session.
fn invalidate_caps_for_paths(app: &AppHandle, vault_root: &str, paths: &[String]) {
    let relevant: Vec<&String> = paths.iter().filter(|p| is_caps_relevant(p)).collect();
    if relevant.is_empty() {
        return;
    }
    let caps = app.state::<crate::features::paper::catalog::CapsCache>();
    let vault = std::path::Path::new(vault_root);
    for path in relevant {
        for dir in caps_paper_dirs(vault_root, path) {
            caps.invalidate(vault, &dir);
        }
    }
}

/// Temp path used by Host `atomic_write` (wiki rename / heading rename).
///
/// Those temps are never user-facing wiki targets. Emitting them as `rename`
/// without a trusted pair triggers a false "unverified external rename" toast
/// for content-only overwrites.
fn is_agentero_atomic_temp(path: &str) -> bool {
    path.replace('\\', "/").contains(".agentero-rename-")
}

fn kind_label(kind: &EventKind) -> &'static str {
    match kind {
        EventKind::Create(_) => "create",
        EventKind::Remove(_) => "remove",
        EventKind::Modify(ModifyKind::Name(_)) => "rename",
        EventKind::Modify(_) => "modify",
        _ => "other",
    }
}

/// `notify` marks `Both` only when one event contains the old and new path in
/// order. Other rename modes (or any filtered/incomplete pair) are deliberately
/// treated as an ordinary structural event: they may refresh the tree/index but
/// can never authorize a Vault rewrite.
fn verified_rename_pair(kind: &EventKind, paths: &[String]) -> Option<FileRename> {
    if !matches!(kind, EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
        || paths.len() != 2
        || paths[0] == paths[1]
    {
        return None;
    }
    Some(FileRename {
        from: paths[0].clone(),
        to: paths[1].clone(),
    })
}

/// Convert a raw notify batch into one payload per event kind, dropping ignored paths.
fn payloads_from_events(events: Vec<Event>) -> Vec<FileChangedPayload> {
    let mut out: Vec<FileChangedPayload> = Vec::new();
    for event in events {
        let raw_paths: Vec<String> = event
            .paths
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .filter(|p| !is_ignored(p))
            .collect();
        if raw_paths.is_empty() {
            continue;
        }
        // Content replace via tmp+rename is not a user/wiki path rename.
        let from_atomic_write = raw_paths.iter().any(|p| is_agentero_atomic_temp(p));
        let paths: Vec<String> = raw_paths
            .into_iter()
            .filter(|p| !is_agentero_atomic_temp(p))
            .collect();
        if paths.is_empty() {
            continue;
        }
        let kind = if from_atomic_write {
            "modify"
        } else {
            kind_label(&event.kind)
        };
        let rename = if from_atomic_write {
            None
        } else {
            verified_rename_pair(&event.kind, &paths)
        };
        out.push(FileChangedPayload {
            paths,
            kind: kind.to_string(),
            rename,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_complete_notify_rename_pairs_are_trusted() {
        let kind = EventKind::Modify(ModifyKind::Name(RenameMode::Both));
        let paths = vec!["/vault/old.md".to_string(), "/vault/new.md".to_string()];
        let pair = verified_rename_pair(&kind, &paths).expect("trusted pair");
        assert_eq!(pair.from, "/vault/old.md");
        assert_eq!(pair.to, "/vault/new.md");

        assert!(verified_rename_pair(
            &EventKind::Modify(ModifyKind::Name(RenameMode::Any)),
            &paths,
        )
        .is_none());
        assert!(verified_rename_pair(&kind, &paths[..1]).is_none());
    }

    #[test]
    fn agentero_atomic_write_temps_are_content_modifies() {
        assert!(is_agentero_atomic_temp(
            "/vault/papers/demo/.NOTES.md.agentero-rename-deadbeef.tmp"
        ));
        assert!(!is_agentero_atomic_temp("/vault/papers/demo/NOTES.md"));
    }

    #[test]
    fn catalog_sqlite_changes_are_ignored() {
        assert!(is_ignored("/vault/.agentero/catalog.sqlite"));
        assert!(is_ignored("/vault/.agentero/catalog.sqlite-wal"));
        assert!(is_ignored("/vault/.agentero/catalog.sqlite-shm"));
        assert!(is_ignored("/vault/.agentero/catalog.sqlite-journal"));
        assert!(is_ignored(r"C:\vault\.agentero\catalog.sqlite"));
        assert!(is_ignored("/vault/.agentero/wiki-cache.json"));
        assert!(is_ignored("/vault/.git/index"));
    }

    #[test]
    fn mirrored_sync_store_changes_are_ignored() {
        // Store mirrored at the vault root by a desktop WebDAV client.
        assert!(is_ignored("/vault/blobs/ab/hash"));
        assert!(is_ignored("/vault/manifests/0000000001-abcd.json.gz"));
        assert!(is_ignored("/vault/HEAD"));
        assert!(is_ignored("/vault/vault.json"));
        // Same names inside a user-named subfolder of a mirrored target.
        assert!(is_ignored("/vault/store/blobs/ab/hash"));
        assert!(is_ignored("/vault/store/HEAD"));
        // Windows separators, and user files that merely look similar.
        assert!(is_ignored(r"C:\vault\blobs\ab\hash"));
        assert!(!is_ignored("/vault/papers/p1/NOTES.md"));
        assert!(!is_ignored("/vault/notes/HEAD.md"));
    }

    #[test]
    fn caps_invalidation_targets_paper_folders_of_capability_files() {
        assert!(is_caps_relevant("/vault/papers/a/PAPER.md"));
        assert!(is_caps_relevant("/vault/papers/a/source/main.TeX"));
        assert!(is_caps_relevant("/vault/papers/a/a.pdf"));
        assert!(!is_caps_relevant("/vault/papers/a/NOTES.md"));
        assert!(!is_caps_relevant("/vault/papers/a/source/layout.json"));

        assert_eq!(
            caps_paper_dirs("/vault", "/vault/papers/a/source/main.tex"),
            vec![
                "papers/a/source".to_string(),
                "papers/a".to_string(),
                "papers".to_string()
            ]
        );
        // Deep source writes must still invalidate the paper folder itself:
        // the tree build caches caps keyed by `papers/a`.
        assert_eq!(
            caps_paper_dirs("/vault", "/vault/papers/a/source/figs/deep.tex"),
            vec![
                "papers/a/source/figs".to_string(),
                "papers/a/source".to_string(),
                "papers/a".to_string(),
                "papers".to_string()
            ]
        );
        assert_eq!(
            caps_paper_dirs("/vault", "/vault/papers/a/PAPER.md"),
            vec!["papers/a".to_string(), "papers".to_string()]
        );
        assert!(caps_paper_dirs("/vault", "/elsewhere/a/PAPER.md").is_empty());
    }
}

/// Tauri command shells for this feature.
pub mod commands;
