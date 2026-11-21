//! Background auto sync: one task per configured vault that syncs
//!
//! - once when the scheduler starts (鈮?vault open / app start),
//! - after the vault has been quiet for 30s following a change,
//! - every `interval_minutes` as a fallback.
//!
//! The task re-reads credentials on every pass, so config edits apply
//! without a restart; toggling auto sync off stops scheduling new passes.

use crate::integration::sync::config;
use notify_debouncer_full::notify::{RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebouncedEvent};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Manager};

use super::SyncService;

/// Quiet period after the last vault change before an auto sync runs.
const CHANGE_QUIET_SECS: u64 = 30;
/// Hard cap for the best-effort exit flush, per vault.
const EXIT_FLUSH_TIMEOUT_SECS: u64 = 5;

impl SyncService {
    /// (Re)start the auto-sync task for a vault according to current config.
    pub fn restart_scheduler(&self, app: &AppHandle, vault_key: &str) {
        self.stop_scheduler(vault_key);
        let Some(cfg) = config::get(vault_key) else {
            return;
        };
        if !cfg.auto_sync() {
            return;
        }
        let dir = PathBuf::from(vault_key);
        if !dir.is_dir() {
            return;
        }
        let (stop, stopped) = tokio::sync::oneshot::channel();
        tauri::async_runtime::spawn(run_loop(
            app.clone(),
            vault_key.to_string(),
            dir,
            cfg.interval_minutes(),
            stopped,
        ));
        if let Ok(mut map) = self.schedulers.lock() {
            map.insert(vault_key.to_string(), stop);
        }
    }

    pub fn stop_scheduler(&self, vault_key: &str) {
        if let Ok(mut map) = self.schedulers.lock() {
            map.remove(vault_key);
        }
    }

    /// Start schedulers for every configured vault (app startup).
    pub fn start_all(&self, app: &AppHandle) {
        for key in config::list_all().keys() {
            self.restart_scheduler(app, key);
        }
    }

    /// Best-effort push of every auto-sync vault on app exit, bounded per
    /// vault so a slow network can hold up quit for at most a few seconds.
    /// Shares the same lease as manual/automatic passes. Skip a busy vault
    /// rather than race its local base/state files during shutdown.
    pub fn flush_on_exit(&self, app: &AppHandle) {
        let token = tauri::async_runtime::block_on(super::commands::session_bearer(app));
        for key in config::list_all().into_keys() {
            let dir = PathBuf::from(&key);
            if !dir.is_dir() {
                continue;
            }
            let Ok(lock) = agentero_core::features::sync::lock::SyncLock::acquire(&dir) else {
                continue;
            };
            let Some(mut cfg) = config::get(&key) else {
                continue;
            };
            if !cfg.auto_sync() {
                continue;
            }
            // Git commits/pushes can exceed the 5s exit budget; interrupting
            // one may leave index.lock behind. The next launch or interval
            // picks the work up instead.
            if cfg.primary.backend == config::SyncBackendKind::Git {
                log::info!(
                    target: "agentero::sync",
                    "exit flush {key}: git backend skipped (next pass will push)"
                );
                continue;
            }
            if cfg.primary.backend == config::SyncBackendKind::Agentero {
                if cfg.primary.agentero_api.trim().is_empty() {
                    cfg.primary.agentero_api = super::commands::account_api_origin();
                }
                if let Some(token) = token.clone() {
                    cfg.primary.agentero_token = token;
                }
            }
            let Some(_lease) = self.try_begin(&key) else {
                log::info!(target: "agentero::sync", "exit flush {key}: sync already running; skipped");
                continue;
            };
            let result = tauri::async_runtime::block_on(async {
                tokio::time::timeout(
                    Duration::from_secs(EXIT_FLUSH_TIMEOUT_SECS),
                    super::engine::sync_vault_locked(&lock, &cfg.primary, &|_, _, _| {}),
                )
                .await
            });
            match result {
                Ok(Ok(outcome)) => log::info!(
                    target: "agentero::sync",
                    "exit flush {key}: version={} up={} down={}",
                    outcome.version,
                    outcome.uploaded,
                    outcome.downloaded
                ),
                Ok(Err(e)) => log::warn!(target: "agentero::sync", "exit flush {key}: {e}"),
                Err(_) => log::warn!(target: "agentero::sync", "exit flush {key}: timed out"),
            }
        }
    }
}

async fn run_loop(
    app: AppHandle,
    vault_key: String,
    dir: PathBuf,
    interval_minutes: u32,
    mut stopped: tokio::sync::oneshot::Receiver<()>,
) {
    // Change trigger: the debouncer fires once the vault has been quiet for
    // CHANGE_QUIET_SECS, so bursts of edits collapse into a single sync.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<()>(1);
    let mut debouncer = match new_debouncer(
        Duration::from_secs(CHANGE_QUIET_SECS),
        None,
        move |events: Result<Vec<DebouncedEvent>, Vec<notify_debouncer_full::notify::Error>>| {
            let relevant = events
                .map(|batch| {
                    batch
                        .iter()
                        .any(|e| e.event.paths.iter().any(|p| !is_ignored_path(p)))
                })
                .unwrap_or(false);
            if relevant {
                let _ = tx.try_send(());
            }
        },
    ) {
        Ok(d) => Some(d),
        Err(e) => {
            log::warn!(target: "agentero::sync", "auto-sync watcher init failed: {e}");
            None
        }
    };
    if let Some(d) = &mut debouncer {
        if let Err(e) = d.watcher().watch(&dir, RecursiveMode::Recursive) {
            log::warn!(target: "agentero::sync", "auto-sync watch failed: {e}");
        }
    }

    // First tick completes immediately → the "sync on vault open" pass.
    let mut ticker =
        tokio::time::interval(Duration::from_secs((interval_minutes.max(1) * 60) as u64));
    loop {
        tokio::select! {
            biased;
            _ = &mut stopped => break,
            _ = ticker.tick() => {}
            Some(()) = rx.recv() => {}
        }
        if let Err(e) = {
            let service = app.state::<SyncService>();
            super::commands::perform_sync(&app, &service, &vault_key).await
        } {
            // "already running" and transient errors are fine — the next
            // trigger retries.
            log::warn!(target: "agentero::sync", "auto sync {vault_key}: {e}");
        }
    }
}

/// Same ignore rules as the snapshot scanner: sync state and VCS noise must
/// never re-trigger a sync.
fn is_ignored_path(path: &std::path::Path) -> bool {
    path.components().any(|c| {
        let name = c.as_os_str().to_string_lossy();
        super::snapshot::is_ignored_name(&name)
    })
}

/// Per-vault scheduler handles (part of [`SyncService`]).
pub type SchedulerMap = HashMap<String, tokio::sync::oneshot::Sender<()>>;
