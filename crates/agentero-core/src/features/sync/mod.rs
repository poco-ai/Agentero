//! Vault sync over official Agentero cloud, S3-compatible object storage,
//! WebDAV, or a Git remote.
//!
//! Design doc: `docs/development/cloud-sync-s3.md`. S3/WebDAV use a
//! state-based engine: content-addressed blobs + immutable manifests + a CAS
//! `HEAD` pointer. Git uses a separate full-vault work-tree sync (`git.rs`).
//! Credentials live in XDG `sync.json` (never inside the vault).
//!
//! This module is shared as-is by the desktop Host (`integration::sync` adds
//! the IPC commands, the auto-sync scheduler and the in-process run lease)
//! and the headless CLI (`agentero sync …`), so both sides get the same
//! merge, conflict and failure-recovery semantics.

mod agentero;
pub mod config;
pub mod engine;
pub mod git;
pub mod local;
pub mod lock;
mod s3;
pub mod snapshot;
mod store;
mod webdav;

pub fn writing_cloud_database(vault: &std::path::Path) -> std::path::PathBuf {
    vault.join(".agentero").join("writing-cloud.sqlite")
}

pub fn ensure_vault_sync_available(vault: &std::path::Path) -> Result<(), crate::error::AppError> {
    if writing_cloud_database(vault).symlink_metadata().is_ok() {
        return Err(crate::error::AppError::domain(
            "writing_vault_sync_conflict",
            "This vault has a shared writing checkout. Vault Sync cannot overwrite the checkout.",
        ));
    }
    Ok(())
}
