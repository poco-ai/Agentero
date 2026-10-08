//! Local sync state under `.agentero/` (ignored by the vault watcher, so
//! writes here never loop back as file-change events).
//!
//! - `.agentero/vault.json` — durable vault identity (UUID)
//! - `.agentero/sync/base.json` — manifest of the last successful sync
//! - `.agentero/sync/state.json` — last sync time / version for status UI
//! - `.agentero/sync/pushed.jsonl` — blobs uploaded but not yet published

use crate::core::error::AppError;
use crate::integration::sync::snapshot::Manifest;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultIdentity {
    id: String,
    created_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncMeta {
    #[serde(default)]
    pub last_sync_at: Option<String>,
    #[serde(default)]
    pub last_version: u64,
}

fn identity_path(vault: &Path) -> PathBuf {
    vault.join(".agentero").join("vault.json")
}

fn sync_dir(vault: &Path) -> PathBuf {
    vault.join(".agentero").join("sync")
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    crate::core::fs::json_store(path, value)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Durable vault UUID, created on first use.
pub fn ensure_vault_id(vault: &Path) -> Result<String, AppError> {
    if let Some(identity) = read_json::<VaultIdentity>(&identity_path(vault)) {
        if !identity.id.trim().is_empty() {
            return Ok(identity.id);
        }
    }
    let identity = VaultIdentity {
        id: uuid::Uuid::new_v4().to_string(),
        created_at: crate::core::time::now_rfc3339_millis(),
    };
    write_json(&identity_path(vault), &identity)?;
    Ok(identity.id)
}

/// Adopt a remote store's vault id (first join of an existing remote).
pub fn set_vault_id(vault: &Path, id: &str) -> Result<(), AppError> {
    write_json(
        &identity_path(vault),
        &VaultIdentity {
            id: id.to_string(),
            created_at: crate::core::time::now_rfc3339_millis(),
        },
    )
}

pub fn read_base(vault: &Path) -> Manifest {
    read_json(&sync_dir(vault).join("base.json")).unwrap_or_default()
}

pub fn write_base(vault: &Path, manifest: &Manifest) -> Result<(), AppError> {
    write_json(&sync_dir(vault).join("base.json"), manifest)
}

pub fn read_meta(vault: &Path) -> SyncMeta {
    read_json(&sync_dir(vault).join("state.json")).unwrap_or_default()
}

pub fn write_meta(vault: &Path, meta: &SyncMeta) -> Result<(), AppError> {
    write_json(&sync_dir(vault).join("state.json"), meta)
}

/// Forget local sync state (disconnect). Keeps the vault identity.
pub fn clear(vault: &Path) {
    let _ = fs::remove_dir_all(sync_dir(vault));
}

// ---- Pushed-blob log -------------------------------------------------------
//
// Blobs a pass uploaded but never got to publish, so the next pass can skip
// them instead of re-sending every byte to a server that ignores
// `If-None-Match` (Nutstore). Appended per blob rather than written once at the
// end: a rate-limit error, a quit or an aborted task must not lose the record.
// The first line pins the remote store, because skipping an upload a different
// store never received would publish a manifest referencing missing blobs.

fn pushed_path(vault: &Path) -> PathBuf {
    sync_dir(vault).join("pushed.jsonl")
}

fn pushed_header(store_id: &str) -> String {
    format!("#{store_id}")
}

/// Hashes already uploaded to `store_id`. A log left by a different store is
/// removed rather than kept: appending under a header that no longer matches
/// would strand it, and the records are worthless for the new store anyway.
pub fn read_pushed(vault: &Path, store_id: &str) -> HashSet<String> {
    let path = pushed_path(vault);
    let Ok(raw) = fs::read_to_string(&path) else {
        return HashSet::new();
    };
    let mut lines = raw.lines();
    if lines.next() == Some(pushed_header(store_id).as_str()) {
        return lines
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect();
    }
    let _ = fs::remove_file(&path);
    HashSet::new()
}

/// Record one uploaded blob. Best-effort: a lost record only costs a redundant
/// upload, so a write failure must not fail the pass it is bookkeeping for.
pub fn record_pushed(vault: &Path, store_id: &str, hash: &str) {
    let path = pushed_path(vault);
    let result = (|| -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
        if file.metadata()?.len() == 0 {
            writeln!(file, "{}", pushed_header(store_id))?;
        }
        writeln!(file, "{hash}")
    })();
    if let Err(e) = result {
        log::warn!(target: "agentero::sync", "record pushed blob {hash}: {e}");
    }
}

/// Forget the log: a published manifest now covers those blobs, and it is the
/// authority every device consults.
pub fn clear_pushed(vault: &Path) {
    let _ = fs::remove_file(pushed_path(vault));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pushed_log_appends_dedupes_and_is_scoped_to_one_store() {
        let vault =
            std::env::temp_dir().join(format!("agentero-sync-local-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&vault).unwrap();

        assert!(read_pushed(&vault, "store-a").is_empty());
        record_pushed(&vault, "store-a", "h1");
        record_pushed(&vault, "store-a", "h2");
        // The same hash again after a second aborted pass.
        record_pushed(&vault, "store-a", "h1");
        assert_eq!(
            read_pushed(&vault, "store-a"),
            HashSet::from(["h1".to_string(), "h2".to_string()])
        );

        // Another store inherits nothing, and recording for it retires the
        // old log so the two cannot end up interleaved under one header.
        assert!(read_pushed(&vault, "store-b").is_empty());
        record_pushed(&vault, "store-b", "h3");
        assert_eq!(
            read_pushed(&vault, "store-b"),
            HashSet::from(["h3".to_string()])
        );
        assert!(read_pushed(&vault, "store-a").is_empty());

        clear_pushed(&vault);
        assert!(read_pushed(&vault, "store-b").is_empty());

        let _ = fs::remove_dir_all(&vault);
    }

    #[test]
    fn disconnect_also_forgets_the_pushed_log() {
        let vault =
            std::env::temp_dir().join(format!("agentero-sync-local-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&vault).unwrap();
        record_pushed(&vault, "store-a", "h1");
        clear(&vault);
        assert!(read_pushed(&vault, "store-a").is_empty());
        let _ = fs::remove_dir_all(&vault);
    }
}
