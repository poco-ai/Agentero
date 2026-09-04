//! SFTP-backed [`VaultFs`] using system OpenSSH (`openssh` + `openssh-sftp-client`).

use crate::core::error::AppError;
use crate::core::fs::{
    join_remote, normalize_rel, FsCaps, FsDirEntry, FsFileMeta, VaultFs, WriteOpts,
};
use async_trait::async_trait;
use futures_util::StreamExt;
use openssh::{KnownHosts, SessionBuilder};
use openssh_sftp_client::metadata::MetaData;
use openssh_sftp_client::Sftp;
use std::path::Path;
use std::pin::pin;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

pub const SSH_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
pub const SSH_SERVER_ALIVE_INTERVAL: Duration = Duration::from_secs(30);
pub const SFTP_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);

pub struct SftpFs {
    remote_root: String,
    sftp: Arc<Mutex<Sftp>>,
}

impl SftpFs {
    /// Connect with system SSH (uses `~/.ssh/config`, agent, default keys).
    ///
    /// `destination` examples: `host`, `user@host`. Prefer ssh config Host
    /// entries for non-default ports / jump hosts.
    pub async fn connect(destination: &str, remote_root: &str) -> Result<Self, AppError> {
        let destination = destination.trim();
        if destination.is_empty() {
            return Err(AppError::message("SSH destination is required"));
        }
        let remote_root = remote_root.trim().trim_end_matches('/').to_string();
        if remote_root.is_empty() {
            return Err(AppError::message("remote vault path is required"));
        }

        let session = timeout(
            SSH_CONNECT_TIMEOUT,
            SessionBuilder::default()
                .known_hosts_check(KnownHosts::Accept)
                .connect_timeout(SSH_CONNECT_TIMEOUT)
                .server_alive_interval(SSH_SERVER_ALIVE_INTERVAL)
                .connect_mux(destination),
        )
        .await
        .map_err(|_| {
            AppError::message(format!(
                "ssh connect timeout after {}s: {destination}",
                SSH_CONNECT_TIMEOUT.as_secs()
            ))
        })?
        .map_err(|e| AppError::message(format!("ssh connect {destination}: {e}")))?;

        let sftp = timeout(
            SSH_CONNECT_TIMEOUT,
            Sftp::from_session(session, Default::default()),
        )
        .await
        .map_err(|_| {
            AppError::message(format!(
                "sftp start timeout after {}s",
                SSH_CONNECT_TIMEOUT.as_secs()
            ))
        })?
        .map_err(|e| AppError::message(format!("sftp start: {e}")))?;

        timeout(SSH_CONNECT_TIMEOUT, async {
            let mut fs = sftp.fs();
            let meta = fs
                .metadata(Path::new(&remote_root))
                .await
                .map_err(|e| AppError::message(format!("remote path {remote_root}: {e}")))?;
            if !meta.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                return Err(AppError::message(format!(
                    "remote path is not a directory: {remote_root}"
                )));
            }
            Ok::<(), AppError>(())
        })
        .await
        .map_err(|_| {
            AppError::message(format!(
                "remote path check timeout after {}s: {remote_root}",
                SSH_CONNECT_TIMEOUT.as_secs()
            ))
        })??;

        Ok(Self {
            remote_root,
            sftp: Arc::new(Mutex::new(sftp)),
        })
    }

    pub fn remote_root(&self) -> &str {
        &self.remote_root
    }

    fn abs(&self, rel: &str) -> Result<String, AppError> {
        join_remote(&self.remote_root, rel).map_err(AppError::message)
    }
}

fn meta_to_fs(m: &MetaData) -> FsFileMeta {
    let is_dir = m.file_type().map(|t| t.is_dir()).unwrap_or(false);
    let is_file = m.file_type().map(|t| t.is_file()).unwrap_or(!is_dir);
    FsFileMeta {
        size: m.len().unwrap_or(0),
        mtime: m.modified().map(|t| t.as_duration().as_secs()).unwrap_or(0),
        is_dir,
        is_file,
    }
}

#[async_trait]
impl VaultFs for SftpFs {
    fn caps(&self) -> FsCaps {
        FsCaps::REMOTE
    }

    async fn list(&self, rel: &str) -> Result<Vec<FsDirEntry>, AppError> {
        timeout(SFTP_OPERATION_TIMEOUT, async {
            let abs = self.abs(rel)?;
            let sftp = self.sftp.lock().await;
            let mut fs = sftp.fs();
            let dir = fs
                .open_dir(Path::new(&abs))
                .await
                .map_err(|e| AppError::message(format!("sftp list {abs}: {e}")))?;
            let mut rd = pin!(dir.read_dir());
            let base = normalize_rel(rel);
            let mut out = Vec::new();
            while let Some(item) = rd.as_mut().next().await {
                let entry = item.map_err(|e| AppError::message(format!("sftp readdir: {e}")))?;
                let name = entry
                    .filename()
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| entry.filename().to_string_lossy().into_owned());
                if name == "." || name == ".." {
                    continue;
                }
                let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                let is_file = entry.file_type().map(|t| t.is_file()).unwrap_or(!is_dir);
                let child_rel = if base.is_empty() {
                    name.clone()
                } else {
                    format!("{base}/{name}")
                };
                out.push(FsDirEntry {
                    name,
                    is_dir,
                    is_file,
                    path: child_rel,
                });
            }
            out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            });
            Ok(out)
        })
        .await
        .map_err(|_| sftp_timeout("list"))?
    }

    async fn stat(&self, rel: &str) -> Result<FsFileMeta, AppError> {
        timeout(SFTP_OPERATION_TIMEOUT, async {
            let abs = self.abs(rel)?;
            let sftp = self.sftp.lock().await;
            let mut fs = sftp.fs();
            let meta = fs
                .metadata(Path::new(&abs))
                .await
                .map_err(|e| AppError::message(format!("sftp stat {abs}: {e}")))?;
            Ok(meta_to_fs(&meta))
        })
        .await
        .map_err(|_| sftp_timeout("stat"))?
    }

    async fn read(&self, rel: &str) -> Result<Vec<u8>, AppError> {
        timeout(SFTP_OPERATION_TIMEOUT, async {
            let abs = self.abs(rel)?;
            let sftp = self.sftp.lock().await;
            let mut fs = sftp.fs();
            let bytes = fs
                .read(Path::new(&abs))
                .await
                .map_err(|e| AppError::message(format!("sftp read {abs}: {e}")))?;
            Ok(bytes.to_vec())
        })
        .await
        .map_err(|_| sftp_timeout("read"))?
    }

    async fn write(&self, rel: &str, data: &[u8], opts: WriteOpts) -> Result<(), AppError> {
        timeout(SFTP_OPERATION_TIMEOUT, async {
            let abs = self.abs(rel)?;
            let sftp = self.sftp.lock().await;
            let mut fs = sftp.fs();
            if opts.create_parents {
                if let Some(parent) = Path::new(&abs).parent() {
                    let p = parent.to_string_lossy();
                    if !p.is_empty() && p != self.remote_root {
                        let _ = sftp_mkdir_p(&mut fs, &p).await;
                    }
                }
            }
            fs.write(Path::new(&abs), data)
                .await
                .map_err(|e| AppError::message(format!("sftp write {abs}: {e}")))
        })
        .await
        .map_err(|_| sftp_timeout("write"))?
    }

    async fn mkdir(&self, rel: &str) -> Result<(), AppError> {
        timeout(SFTP_OPERATION_TIMEOUT, async {
            let abs = self.abs(rel)?;
            let sftp = self.sftp.lock().await;
            let mut fs = sftp.fs();
            sftp_mkdir_p(&mut fs, &abs).await
        })
        .await
        .map_err(|_| sftp_timeout("mkdir"))?
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), AppError> {
        timeout(SFTP_OPERATION_TIMEOUT, async {
            let src = self.abs(from)?;
            let dst = self.abs(to)?;
            let sftp = self.sftp.lock().await;
            let mut fs = sftp.fs();
            if let Some(parent) = Path::new(&dst).parent() {
                let p = parent.to_string_lossy();
                if !p.is_empty() {
                    let _ = sftp_mkdir_p(&mut fs, &p).await;
                }
            }
            fs.rename(Path::new(&src), Path::new(&dst))
                .await
                .map_err(|e| AppError::message(format!("sftp rename: {e}")))
        })
        .await
        .map_err(|_| sftp_timeout("rename"))?
    }

    async fn remove(&self, rel: &str, recursive: bool) -> Result<(), AppError> {
        timeout(SFTP_OPERATION_TIMEOUT, async {
            let abs = self.abs(rel)?;
            let sftp = self.sftp.lock().await;
            let mut fs = sftp.fs();
            let meta = fs
                .metadata(Path::new(&abs))
                .await
                .map_err(|e| AppError::message(format!("sftp remove stat {abs}: {e}")))?;
            if meta.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                if recursive {
                    remove_dir_all(&mut fs, &abs).await?;
                } else {
                    fs.remove_dir(Path::new(&abs))
                        .await
                        .map_err(|e| AppError::message(format!("sftp rmdir: {e}")))?;
                }
            } else {
                fs.remove_file(Path::new(&abs))
                    .await
                    .map_err(|e| AppError::message(format!("sftp rm: {e}")))?;
            }
            Ok(())
        })
        .await
        .map_err(|_| sftp_timeout("remove"))?
    }
}

fn sftp_timeout(operation: &str) -> AppError {
    AppError::message(format!(
        "sftp {operation} timeout after {}s",
        SFTP_OPERATION_TIMEOUT.as_secs()
    ))
}

async fn sftp_mkdir_p(fs: &mut openssh_sftp_client::fs::Fs, path: &str) -> Result<(), AppError> {
    let path = path.trim_end_matches('/');
    if path.is_empty() {
        return Ok(());
    }
    let mut acc = String::new();
    for part in path.split('/') {
        if part.is_empty() {
            if acc.is_empty() {
                acc.push('/');
            }
            continue;
        }
        if acc == "/" {
            acc = format!("/{part}");
        } else if acc.is_empty() {
            acc = part.to_string();
        } else {
            acc = format!("{acc}/{part}");
        }
        match fs.metadata(Path::new(&acc)).await {
            Ok(m) if m.file_type().map(|t| t.is_dir()).unwrap_or(false) => continue,
            Ok(_) => {
                return Err(AppError::message(format!(
                    "sftp mkdir: {acc} exists and is not a directory"
                )));
            }
            Err(_) => {
                fs.create_dir(Path::new(&acc))
                    .await
                    .map_err(|e| AppError::message(format!("sftp mkdir {acc}: {e}")))?;
            }
        }
    }
    Ok(())
}

async fn remove_dir_all(fs: &mut openssh_sftp_client::fs::Fs, path: &str) -> Result<(), AppError> {
    let dir = fs
        .open_dir(Path::new(path))
        .await
        .map_err(|e| AppError::message(format!("sftp readdir {path}: {e}")))?;
    let mut rd = pin!(dir.read_dir());
    let mut children: Vec<(String, bool)> = Vec::new();
    while let Some(item) = rd.as_mut().next().await {
        let entry = item.map_err(|e| AppError::message(format!("sftp readdir: {e}")))?;
        let name = entry
            .filename()
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| entry.filename().to_string_lossy().into_owned());
        if name == "." || name == ".." {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        children.push((format!("{}/{}", path.trim_end_matches('/'), name), is_dir));
    }
    for (child, is_dir) in children {
        if is_dir {
            Box::pin(remove_dir_all(fs, &child)).await?;
        } else {
            fs.remove_file(Path::new(&child))
                .await
                .map_err(|e| AppError::message(format!("sftp rm {child}: {e}")))?;
        }
    }
    fs.remove_dir(Path::new(path))
        .await
        .map_err(|e| AppError::message(format!("sftp rmdir {path}: {e}")))
}
