//! Vault filesystem abstraction (`docs/development/remote-vault.md`).
//!
//! Local vaults use [`LocalFs`]; remote vaults use SFTP (or a local-sim backend for tests).

mod dir_link;
mod local;
mod path;
mod store;

pub use dir_link::{
    create_directory_link, is_linked_dir, linked_dir_vault_rel, relative_link_target,
    remove_directory_link, resolved_dir,
};

pub use local::LocalFs;
pub use path::{
    canonicalize_best_effort, ensure_vault_dir, join_remote, normalize_rel, normalize_rel_lexical,
    normalize_rel_separators, path_escapes_root, resolve_paper_dir, resolve_vault,
    safe_relative_path, sanitize_vault_rel, vault_relative, FsCaps, FsDirEntry, FsFileMeta,
};
pub use store::{atomic_write, atomic_write_with, json_store, json_store_with, AtomicOpts};

use crate::error::AppError;
use async_trait::async_trait;

#[derive(Debug, Clone, Copy, Default)]
pub struct WriteOpts {
    /// Create parent directories when missing (best-effort).
    pub create_parents: bool,
}

/// Async filesystem operations relative to a vault root.
#[async_trait]
pub trait VaultFs: Send + Sync {
    fn caps(&self) -> FsCaps;

    async fn list(&self, rel: &str) -> Result<Vec<FsDirEntry>, AppError>;

    async fn stat(&self, rel: &str) -> Result<FsFileMeta, AppError>;

    async fn read(&self, rel: &str) -> Result<Vec<u8>, AppError>;

    async fn write(&self, rel: &str, data: &[u8], opts: WriteOpts) -> Result<(), AppError>;

    async fn mkdir(&self, rel: &str) -> Result<(), AppError>;

    async fn rename(&self, from: &str, to: &str) -> Result<(), AppError>;

    async fn remove(&self, rel: &str, recursive: bool) -> Result<(), AppError>;

    /// Only a missing path is false; permission, transport and validation errors propagate.
    async fn exists(&self, rel: &str) -> Result<bool, AppError> {
        match self.stat(rel).await {
            Ok(_) => Ok(true),
            Err(AppError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e),
        }
    }
}
