//! Local sync state under `.agentero/` (ignored by the vault watcher, so
//! writes here never loop back as file-change events).
//!
//! - `.agentero/vault.json` — durable vault identity (UUID)
//! - `.agentero/sync/base.json` — manifest of the last successful sync
//! - `.agentero/sync/state.json` — last sync time / version for status UI
//! - `.agentero/sync/pushed.jsonl` — blobs uploaded but not yet published

use crate::error::AppError;
use crate::features::sync::snapshot::Manifest;
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
    pub needs_merge: bool,
    #[serde(default)]
    pub last_sync_at: Option<String>,
    #[serde(default)]
    pub last_version: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub store_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest_key: Option<String>,
    /// Last failed pass's error message; cleared by the next success.
    /// Surfaced by the CLI `sync status` (the desktop reports it live via
    /// `sync:state` events instead).
    #[serde(default)]
    pub last_error: Option<String>,
}

/// Record a failed pass on top of the existing meta (keeps last_sync_at /
/// last_version from the last success). Best-effort: a broken state.json
/// must not mask the sync error itself.
pub fn record_error(vault: &Path, error: &str) {
    let Ok(mut meta) = read_meta(vault) else {
        return;
    };
    meta.last_error = Some(error.to_string());
    let _ = write_meta(vault, &meta);
}

fn identity_path(vault: &Path) -> PathBuf {
    vault.join(".agentero").join("vault.json")
}

pub(super) fn sync_dir(vault: &Path) -> PathBuf {
    vault.join(".agentero").join("sync")
}

pub(super) fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    crate::fs::json_store(path, value)
}

pub(super) fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>, AppError> {
    match fs::read(path) {
        Ok(raw) => serde_json::from_slice(&raw)
            .map(Some)
            .map_err(|e| AppError::message(format!("invalid {}: {e}", path.display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Durable vault UUID, created on first use.
pub fn ensure_vault_id(vault: &Path) -> Result<String, AppError> {
    if let Some(identity) = read_json::<VaultIdentity>(&identity_path(vault))? {
        if !identity.id.trim().is_empty() {
            return Ok(identity.id);
        }
    }
    let identity = VaultIdentity {
        id: uuid::Uuid::new_v4().to_string(),
        created_at: crate::time::now_rfc3339_millis(),
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
            created_at: crate::time::now_rfc3339_millis(),
        },
    )
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceIdentity {
    id: String,
    created_at: String,
}

/// Durable per-device UUID for the degraded-mode publish lock, created on
/// first use. Per vault (not per installation): lock arbitration only needs
/// identities to be unique among the devices sharing one store.
pub fn ensure_device_id(vault: &Path) -> Result<String, AppError> {
    let path = sync_dir(vault).join("device.json");
    if let Some(identity) = read_json::<DeviceIdentity>(&path)? {
        if !identity.id.trim().is_empty() {
            return Ok(identity.id);
        }
    }
    let identity = DeviceIdentity {
        id: uuid::Uuid::new_v4().simple().to_string(),
        created_at: crate::time::now_rfc3339_millis(),
    };
    write_json(&path, &identity)?;
    Ok(identity.id)
}

pub fn read_base(vault: &Path) -> Result<Manifest, AppError> {
    read_base_at(&sync_dir(vault))
}

pub fn write_base(vault: &Path, manifest: &Manifest) -> Result<(), AppError> {
    write_base_at(&sync_dir(vault), manifest)
}

pub fn read_meta(vault: &Path) -> Result<SyncMeta, AppError> {
    read_meta_at(&sync_dir(vault))
}

pub fn write_meta(vault: &Path, meta: &SyncMeta) -> Result<(), AppError> {
    write_meta_at(&sync_dir(vault), meta)
}

/// State directory of one mirror. The primary keeps its files directly in
/// [`sync_dir`] (existing vaults need no migration); mirrors are namespaced by
/// backend id so their base/state can never be read as the primary's.
pub(super) fn mirror_dir(vault: &Path, backend_id: &str) -> PathBuf {
    sync_dir(vault).join("mirrors").join(backend_id)
}

pub(super) fn read_base_at(dir: &Path) -> Result<Manifest, AppError> {
    Ok(read_json(&dir.join("base.json"))?.unwrap_or_default())
}

pub(super) fn write_base_at(dir: &Path, manifest: &Manifest) -> Result<(), AppError> {
    write_json(&dir.join("base.json"), manifest)
}

pub(super) fn read_meta_at(dir: &Path) -> Result<SyncMeta, AppError> {
    Ok(read_json(&dir.join("state.json"))?.unwrap_or_default())
}

pub(super) fn write_meta_at(dir: &Path, meta: &SyncMeta) -> Result<(), AppError> {
    write_json(&dir.join("state.json"), meta)
}

/// Record a failed mirror pass in that mirror's own state file, so one failing
/// mirror cannot overwrite the primary's `lastError` (or another mirror's).
pub(super) fn record_error_at(dir: &Path, error: &str) {
    let Ok(mut meta) = read_meta_at(dir) else {
        return;
    };
    meta.last_error = Some(error.to_string());
    let _ = write_meta_at(dir, &meta);
}

/// Forget local sync state (disconnect). Keeps the vault identity.
pub(super) fn clear(lock: &super::lock::SyncLock) -> Result<(), AppError> {
    let vault = lock.vault();
    clear_staged(vault)?;
    for name in [
        "base.json",
        "state.json",
        "pushed.jsonl",
        "pending.json",
        "accepted.json",
        "webdav-journal.json",
    ] {
        match fs::remove_file(sync_dir(vault).join(name)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => (),
        }
    }
    // Mirror state lives in nested directories; the primary's files are flat.
    match fs::remove_dir_all(sync_dir(vault).join("mirrors")) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
        _ => (),
    }
    Ok(())
}

const STAGE_PREFIX: &str = "download-";

pub(super) fn stage_file(vault: &Path) -> Result<tempfile::NamedTempFile, AppError> {
    Ok(tempfile::Builder::new()
        .prefix(STAGE_PREFIX)
        .suffix(".tmp")
        .tempfile_in(sync_dir(vault))?)
}

pub(super) fn clear_staged(vault: &Path) -> Result<(), AppError> {
    let dir = sync_dir(vault);
    fs::create_dir_all(&dir)?;
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with(STAGE_PREFIX) && name.ends_with(".tmp"))
            && entry.file_type()?.is_file()
        {
            fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

pub(super) fn mark_catalog_dirty(vault: &Path) -> Result<(), AppError> {
    let dir = sync_dir(vault);
    fs::create_dir_all(&dir)?;
    fs::write(dir.join("catalog.dirty"), [])?;
    Ok(())
}

// ---- Pushed-blob log -------------------------------------------------------
//
// Blobs a pass uploaded but never got to publish, so the next pass can skip
// them instead of re-sending every byte on a conditional PUT. Appended per
// blob rather than written once at the
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
        let lock = super::super::lock::SyncLock::acquire(&vault).unwrap();
        clear(&lock).unwrap();
        assert!(super::super::lock::SyncLock::try_acquire(&vault)
            .unwrap()
            .is_none());
        drop(lock);
        assert!(read_pushed(&vault, "store-a").is_empty());
        let _ = fs::remove_dir_all(&vault);
    }
}
