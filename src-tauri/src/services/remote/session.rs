//! Active remote vault sessions (SSH/SFTP or local-sim for tests).

use super::catalog_mirror::CatalogMirror;
use crate::error::AppError;
use crate::services::fs::{FsCaps, LocalFs, VaultFs};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Magic host for local-sim backend (dev / unit-style integration without SSH).
pub const LOCAL_SIM_HOST: &str = "__local_sim__";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSessionInfo {
    pub session_id: String,
    pub kind: String,
    pub display_name: String,
    pub host: String,
    pub remote_path: String,
    pub caps: FsCaps,
    /// Pseudo vault path for frontend: `remote:<sessionId>`
    pub vault_handle: String,
}

pub struct RemoteSession {
    pub id: String,
    pub host: String,
    pub remote_path: String,
    pub display_name: String,
    pub kind: String,
    pub fs: Arc<dyn VaultFs>,
    pub work_root: PathBuf,
    pub blob_root: PathBuf,
    pub catalog: Mutex<CatalogMirror>,
}

impl RemoteSession {
    pub fn info(&self) -> RemoteSessionInfo {
        RemoteSessionInfo {
            session_id: self.id.clone(),
            kind: self.kind.clone(),
            display_name: self.display_name.clone(),
            host: self.host.clone(),
            remote_path: self.remote_path.clone(),
            caps: self.fs.caps(),
            vault_handle: format!("remote:{}", self.id),
        }
    }
}

pub struct RemoteRegistry {
    inner: Mutex<HashMap<String, Arc<RemoteSession>>>,
}

impl Default for RemoteRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl RemoteRegistry {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    pub async fn get(&self, session_id: &str) -> Result<Arc<RemoteSession>, AppError> {
        self.inner
            .lock()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| AppError::message(format!("remote session not found: {session_id}")))
    }

    pub async fn disconnect(&self, session_id: &str) -> Result<(), AppError> {
        let session = {
            let mut map = self.inner.lock().await;
            map.remove(session_id).ok_or_else(|| {
                AppError::message(format!("remote session not found: {session_id}"))
            })?
        };
        // Best-effort catalog push before drop
        {
            let mut cat = session.catalog.lock().await;
            let _ = cat.push(session.fs.clone()).await;
        }
        let _ = std::fs::remove_dir_all(&session.work_root);
        // Keep blob cache for LRU reuse; optional cleanup of empty parent
        Ok(())
    }

    pub async fn connect(
        &self,
        host: &str,
        user: Option<&str>,
        remote_path: &str,
    ) -> Result<RemoteSessionInfo, AppError> {
        let host = host.trim();
        let remote_path = remote_path.trim();
        if host.is_empty() || remote_path.is_empty() {
            return Err(AppError::message("host and remotePath are required"));
        }

        let (kind, fs, display_name): (String, Arc<dyn VaultFs>, String) = if host == LOCAL_SIM_HOST
        {
            let root = PathBuf::from(remote_path);
            if !root.is_dir() {
                return Err(AppError::message(format!(
                    "local-sim path is not a directory: {}",
                    root.display()
                )));
            }
            let display = format!("local-sim:{}", root.display());
            ("local-sim".into(), Arc::new(LocalFs::new(root)), display)
        } else {
            #[cfg(unix)]
            {
                use super::sftp_fs::SftpFs;
                let destination = match user.map(str::trim).filter(|s| !s.is_empty()) {
                    Some(u) => format!("{u}@{host}"),
                    None => host.to_string(),
                };
                let sftp = SftpFs::connect(&destination, remote_path).await?;
                let display = format!("{destination}:{remote_path}");
                ("ssh".into(), Arc::new(sftp) as Arc<dyn VaultFs>, display)
            }
            #[cfg(not(unix))]
            {
                let _ = user;
                return Err(AppError::message(
                    "Remote vault over SSH is not supported on Windows yet \
                     (openssh/SFTP client is Unix-only). Open a local vault, \
                     or use Agentero on macOS/Linux for remote vaults.",
                ));
            }
        };

        let session_id = uuid::Uuid::new_v4().to_string();
        let cache_key = hex::encode(Sha256::digest(format!("{host}\0{remote_path}").as_bytes()));
        let base_cache = dirs::cache_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("agentero")
            .join("remote")
            .join(&cache_key);
        let work_root = base_cache.join("work").join(&session_id);
        let blob_root = base_cache.join("blobs");
        std::fs::create_dir_all(&work_root)?;
        std::fs::create_dir_all(&blob_root)?;

        let catalog = CatalogMirror::checkout(fs.clone(), &work_root).await?;

        let session = Arc::new(RemoteSession {
            id: session_id.clone(),
            host: host.to_string(),
            remote_path: remote_path.to_string(),
            display_name,
            kind,
            fs,
            work_root,
            blob_root,
            catalog: Mutex::new(catalog),
        });

        let info = session.info();
        self.inner.lock().await.insert(session_id, session);
        Ok(info)
    }
}

/// Resolve vault handle `remote:<id>` → session id.
pub fn parse_remote_handle(vault_handle: &str) -> Option<&str> {
    let h = vault_handle.trim();
    h.strip_prefix("remote:").filter(|id| !id.is_empty())
}

#[cfg(test)]
#[path = "session/tests.rs"]
mod tests;
