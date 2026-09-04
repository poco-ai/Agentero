//! Vault cloud sync over S3-compatible object storage.
//!
//! Design doc: `docs/development/cloud-sync-s3.md`. The engine is
//! state-based: content-addressed blobs + immutable manifests + a CAS `HEAD`
//! pointer. Credentials live in XDG `sync.json` (never inside the vault).

pub mod commands;
pub mod config;
pub mod engine;
pub mod local;
mod s3;
mod scheduler;
pub mod snapshot;

use std::collections::HashSet;
use std::sync::Mutex;

/// Serializes sync passes per vault and owns the auto-sync scheduler tasks
/// (managed tauri state).
#[derive(Default)]
pub struct SyncService {
    running: Mutex<HashSet<String>>,
    schedulers: Mutex<scheduler::SchedulerMap>,
}

impl SyncService {
    /// Claim the vault for a sync pass; false when one is already running.
    pub fn try_begin(&self, vault: &str) -> bool {
        self.running
            .lock()
            .map(|mut set| set.insert(vault.to_string()))
            .unwrap_or(false)
    }

    pub fn end(&self, vault: &str) {
        if let Ok(mut set) = self.running.lock() {
            set.remove(vault);
        }
    }

    pub fn is_running(&self, vault: &str) -> bool {
        self.running
            .lock()
            .map(|set| set.contains(vault))
            .unwrap_or(false)
    }
}
