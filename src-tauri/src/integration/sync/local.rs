//! Local sync state under `.agentero/` (ignored by the vault watcher, so
//! writes here never loop back as file-change events).
//!
//! - `.agentero/vault.json` — durable vault identity (UUID)
//! - `.agentero/sync/base.json` — manifest of the last successful sync
//! - `.agentero/sync/state.json` — last sync time / version for status UI

use crate::core::error::AppError;
use crate::integration::sync::snapshot::Manifest;
use serde::{Deserialize, Serialize};
use std::fs;
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
