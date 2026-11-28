//! Request / receipt channel in the local user's configuration directory.
use crate::{error::AppError, paths::agentero_config_dir};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub const REQUEST: &str = "cli:workspace";
pub const MAX_REQUEST_BYTES: u64 = 2_000_000;

#[cfg(target_os = "macos")]
pub const SOCKET_NAME: &str = "cli.sock";

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct WorkspaceRequest {
    pub id: String,
    pub route: String,
    pub vault: Option<String>,
    #[specta(type = crate::json::Json)]
    pub args: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct WorkspaceReply {
    pub id: String,
    #[specta(type = crate::json::Json)]
    pub value: Value,
    pub error: Option<String>,
}

pub fn endpoint_marker() -> PathBuf {
    agentero_config_dir().join("desktop-cli.endpoint")
}

pub fn active_endpoint() -> Option<PathBuf> {
    let marker = endpoint_marker();
    let name = std::fs::read_to_string(&marker).ok()?;
    if !name.starts_with("workspace-") || Path::new(&name).components().count() != 1 {
        return None;
    }
    let path = marker.parent()?.join(name);
    // Liveness only: the host holds its lock on this file, so a shared read
    // handle is enough. Asking for write access would fail for any caller
    // whose sandbox allows the workspace but not the config directory.
    let probe = std::fs::OpenOptions::new()
        .read(true)
        .open(path.join("lease"))
        .ok()?;
    let error = fs2::FileExt::try_lock_exclusive(&probe).err()?;
    (error.raw_os_error() == fs2::lock_contended_error().raw_os_error()).then_some(path)
}

/// Keep this file open throughout the host lifetime. The OS releases the lock
/// on crash, so a stale marker can never send a caller to a dead process.
pub fn acquire_endpoint_lease(dir: &Path) -> Result<std::fs::File, AppError> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(dir.join("lease"))?;
    fs2::FileExt::lock_exclusive(&file)?;
    Ok(file)
}

/// Handle for a private request directory. Every platform variant removes the
/// directory when dropped, so callers only need to keep it alive.
#[cfg(not(windows))]
pub type PrivateDir = tempfile::TempDir;

#[cfg(not(windows))]
pub fn private_dir(parent: Option<&Path>, prefix: &str) -> Result<PrivateDir, AppError> {
    let mut builder = tempfile::Builder::new();
    builder.prefix(prefix);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o700));
    }
    Ok(match parent {
        Some(dir) => builder.tempdir_in(dir)?,
        None => builder.tempdir()?,
    })
}

#[cfg(windows)]
mod windows_mailbox;
#[cfg(windows)]
pub use windows_mailbox::{private_dir, MailboxDirectory as PrivateDir};

pub fn write_packet<T: Serialize>(dir: &Path, name: &str, value: &T) -> Result<(), AppError> {
    let mut file = tempfile::NamedTempFile::new_in(dir)?;
    serde_json::to_writer(file.as_file_mut(), value)?;
    file.persist(dir.join(name)).map_err(|e| e.error)?;
    Ok(())
}
