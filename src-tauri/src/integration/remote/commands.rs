//! Tauri commands for remote vaults over SSH/SFTP.
//!
//! Async commands return `Result<ApiResult<T>, String>` so `State` borrows are valid
//! (same pattern as `agent_probe`).

use crate::app::command_util::try_session;
use crate::core::error::{map_err, ApiResult, AppError};
use crate::core::fs::{FsDirEntry, WriteOpts};
use crate::core::log_util::{trunc, OpTimer};
use crate::features::paper::catalog::papers::{self, PaperRecord};
use crate::features::paper::catalog::service;
use crate::features::paper::identity::is_paper_marker_file;
use crate::features::vault::CreateVaultResult;
use crate::integration::remote::{
    ensure_remote_vault_skills, RemoteRegistry, RemoteSession, RemoteSessionInfo,
};
use serde::Deserialize;
use serde::Serialize;
use std::sync::Arc;
use tauri::State;

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConnectArgs {
    /// SSH host or config alias. Use `__local_sim__` with an absolute local path for tests.
    pub host: String,
    #[serde(default)]
    pub user: Option<String>,
    pub remote_path: String,
}

#[tauri::command]
#[specta::specta]
pub async fn remote_connect(
    registry: State<'_, Arc<RemoteRegistry>>,
    connector: State<'_, Arc<crate::integration::connector::ConnectorController>>,
    args: RemoteConnectArgs,
) -> Result<ApiResult<RemoteSessionInfo>, String> {
    let op = OpTimer::start_with(
        "remote_connect",
        format!(
            "host={} path={}",
            trunc(&args.host, 80),
            trunc(&args.remote_path, 120)
        ),
    );
    match registry
        .connect(&args.host, args.user.as_deref(), &args.remote_path)
        .await
    {
        Ok(info) => {
            // Bind Zotero Connector save target on Host (do not rely only on frontend).
            connector.set_vault(Some(info.vault_handle.clone()));
            log::info!(
                target: "agentero::op",
                "connector vault bound to {}",
                trunc(&info.vault_handle, 80)
            );
            op.finish_ok();
            Ok(ApiResult::ok(info))
        }
        Err(e) => {
            op.finish_err(&e);
            Ok(map_err(e))
        }
    }
}

/// Host entries from `~/.ssh/config` for the connect dialog's suggestions (#339).
#[tauri::command]
#[specta::specta]
pub async fn remote_ssh_config_hosts(
) -> Result<ApiResult<Vec<crate::integration::remote::ssh_config::SshConfigHost>>, String> {
    Ok(ApiResult::ok(
        crate::integration::remote::ssh_config::ssh_config_hosts(),
    ))
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSessionArgs {
    pub session_id: String,
    #[serde(default)]
    pub locale: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn remote_disconnect(
    registry: State<'_, Arc<RemoteRegistry>>,
    connector: State<'_, Arc<crate::integration::connector::ConnectorController>>,
    args: RemoteSessionArgs,
) -> Result<ApiResult<()>, String> {
    let op = OpTimer::start_with(
        "remote_disconnect",
        format!("session={}", trunc(&args.session_id, 40)),
    );
    let handle = format!("remote:{}", args.session_id.trim());
    let bound_here = connector
        .status()
        .vault_path
        .as_deref()
        .is_some_and(|p| p == handle);
    match registry.disconnect(&args.session_id).await {
        Ok(()) => {
            if bound_here {
                connector.set_vault(None);
            }
            op.finish_ok();
            Ok(ApiResult::ok(()))
        }
        Err(e) => {
            op.finish_err(&e);
            Ok(map_err(e))
        }
    }
}

/// Seed bundled content and safely update untouched first-party skills in a
/// remote vault without overwriting user files.
#[tauri::command]
#[specta::specta]
pub async fn remote_vault_ensure(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemoteSessionArgs,
) -> Result<ApiResult<CreateVaultResult>, String> {
    let session = try_session!(registry, &args.session_id);
    match ensure_remote_vault_skills(&session, args.locale.as_deref()).await {
        Ok(result) => Ok(ApiResult::ok(result)),
        Err(e) => Ok(map_err(e)),
    }
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemotePathArgs {
    pub session_id: String,
    #[serde(default)]
    pub path: String,
}

#[tauri::command]
#[specta::specta]
pub async fn remote_list(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemotePathArgs,
) -> Result<ApiResult<Vec<FsDirEntry>>, String> {
    let session = try_session!(registry, &args.session_id);
    match session.fs.list(&args.path).await {
        Ok(v) => Ok(ApiResult::ok(v)),
        Err(e) => Ok(map_err(e)),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn remote_read_text(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemotePathArgs,
) -> Result<ApiResult<String>, String> {
    let session = try_session!(registry, &args.session_id);
    match session.fs.read(&args.path).await {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(s) => Ok(ApiResult::ok(s)),
            Err(e) => Ok(map_err(AppError::message(format!("not utf-8: {e}")))),
        },
        Err(e) => Ok(map_err(e)),
    }
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWriteTextArgs {
    pub session_id: String,
    pub path: String,
    pub content: String,
}

#[tauri::command]
#[specta::specta]
pub async fn remote_write_text(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemoteWriteTextArgs,
) -> Result<ApiResult<()>, String> {
    let session = try_session!(registry, &args.session_id);
    match session
        .fs
        .write(
            &args.path,
            args.content.as_bytes(),
            WriteOpts {
                create_parents: true,
            },
        )
        .await
    {
        Ok(()) => Ok(ApiResult::ok(())),
        Err(e) => Ok(map_err(e)),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn remote_mkdir(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemotePathArgs,
) -> Result<ApiResult<()>, String> {
    let session = try_session!(registry, &args.session_id);
    match session.fs.mkdir(&args.path).await {
        Ok(()) => Ok(ApiResult::ok(())),
        Err(e) => Ok(map_err(e)),
    }
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRemoveArgs {
    pub session_id: String,
    pub path: String,
    #[serde(default)]
    pub recursive: bool,
}

#[tauri::command]
#[specta::specta]
pub async fn remote_remove(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemoteRemoveArgs,
) -> Result<ApiResult<()>, String> {
    let session = try_session!(registry, &args.session_id);
    match session.fs.remove(&args.path, args.recursive).await {
        Ok(()) => Ok(ApiResult::ok(())),
        Err(e) => Ok(map_err(e)),
    }
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWriteBytesArgs {
    pub session_id: String,
    pub path: String,
    pub data: Vec<u8>,
}

#[tauri::command]
#[specta::specta]
pub async fn remote_write_bytes(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemoteWriteBytesArgs,
) -> Result<ApiResult<()>, String> {
    let session = try_session!(registry, &args.session_id);
    match session
        .fs
        .write(
            &args.path,
            &args.data,
            WriteOpts {
                create_parents: true,
            },
        )
        .await
    {
        Ok(()) => Ok(ApiResult::ok(())),
        Err(e) => Ok(map_err(e)),
    }
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemotePaperGetArgs {
    pub session_id: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn remote_paper_get(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemotePaperGetArgs,
) -> Result<ApiResult<PaperRecord>, String> {
    let session = try_session!(registry, &args.session_id);
    // Same unified entry as local `paper_get` (validated in
    // `features::paper::catalog::service`), run against the session work root.
    Ok(service::get_paper(
        &session.work_root,
        args.path.as_deref(),
        args.id.as_deref(),
    ))
}

#[tauri::command]
#[specta::specta]
pub async fn remote_paper_list(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemoteSessionArgs,
) -> Result<ApiResult<Vec<PaperRecord>>, String> {
    let session = try_session!(registry, &args.session_id);
    // Refresh from the remote authority first, holding the mirror lock
    // through the read (unchanged lock scope). The projection intentionally
    // differs from local `paper_list` (raw rows, no has_pdf probe, no id
    // dedupe) — known drift kept for wire stability.
    let mut catalog = session.catalog.lock().await;
    if let Err(e) = catalog.refresh(session.fs.clone()).await {
        return Ok(map_err(e));
    }
    let work = session.work_root.clone();
    match papers::list_all(&work) {
        Ok(rows) => Ok(ApiResult::ok(rows)),
        Err(e) => Ok(map_err(e)),
    }
}

/// Commit a shared paper write use case: the result ran against the session
/// work mirror, so publish the catalog to the remote authority on success
/// (failed use cases are returned as-is, never pushed). The remote half of
/// the unified entry — session lookup in the command via `try_session!`,
/// push here, both out of the use case bodies.
async fn commit_paper_write<T: Serialize>(
    session: &RemoteSession,
    result: ApiResult<T>,
) -> Result<ApiResult<T>, String> {
    if !result.ok {
        return Ok(result);
    }
    match session.push_catalog().await {
        Ok(()) => Ok(result),
        Err(e) => Ok(map_err(e)),
    }
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemotePaperSetTagsArgs {
    pub session_id: String,
    pub path: String,
    pub tags: Vec<papers::PaperTag>,
}

#[tauri::command]
#[specta::specta]
pub async fn remote_paper_set_tags(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemotePaperSetTagsArgs,
) -> Result<ApiResult<PaperRecord>, String> {
    let session = try_session!(registry, &args.session_id);
    commit_paper_write(
        &session,
        service::set_tags(&session.work_root, &args.path, &args.tags),
    )
    .await
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemotePaperSetIsReadArgs {
    pub session_id: String,
    pub path: String,
    pub is_read: bool,
}

#[tauri::command]
#[specta::specta]
pub async fn remote_paper_set_is_read(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemotePaperSetIsReadArgs,
) -> Result<ApiResult<PaperRecord>, String> {
    let session = try_session!(registry, &args.session_id);
    commit_paper_write(
        &session,
        service::set_is_read(&session.work_root, &args.path, args.is_read),
    )
    .await
}

/// Ensure a remote PDF (or other file) is cached under the session blob dir; return local path.
#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCacheFileArgs {
    pub session_id: String,
    pub path: String,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCacheFileResult {
    /// Absolute local path to cached bytes (ephemeral).
    pub local_path: String,
}

#[tauri::command]
#[specta::specta]
pub async fn remote_cache_file(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemoteCacheFileArgs,
) -> Result<ApiResult<RemoteCacheFileResult>, String> {
    let session = try_session!(registry, &args.session_id);
    let rel = match crate::core::fs::sanitize_vault_rel(&args.path) {
        Ok(r) => r,
        Err(_) => return Ok(map_err(AppError::message("invalid path"))),
    };
    let meta = match session.fs.stat(&rel).await {
        Ok(m) => m,
        Err(e) => return Ok(map_err(e)),
    };
    let dest = crate::integration::remote::blob_cache::ensure_cached(
        &session.blob_root,
        &rel,
        meta.size,
        meta.mtime,
        || async { session.fs.read(&rel).await },
    )
    .await;
    match dest {
        Ok(dest) => Ok(ApiResult::ok(RemoteCacheFileResult {
            local_path: dest.to_string_lossy().into_owned(),
        })),
        Err(e) => Ok(map_err(e)),
    }
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCacheClearArgs {
    /// When set, clear that session's blobs; otherwise all remote blob caches.
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCacheClearResult {
    pub freed_bytes: u64,
}

#[tauri::command]
#[specta::specta]
pub async fn remote_cache_clear(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemoteCacheClearArgs,
) -> Result<ApiResult<RemoteCacheClearResult>, String> {
    use crate::integration::remote::blob_cache;
    let op = OpTimer::start("remote_cache_clear");
    let result = if let Some(sid) = args
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let session = try_session!(registry, sid, op);
        blob_cache::clear_root(&session.blob_root)
    } else {
        blob_cache::clear_all()
    };
    match result {
        Ok(freed) => {
            op.finish_ok_extra(format!("freed_bytes={freed}"));
            Ok(ApiResult::ok(RemoteCacheClearResult { freed_bytes: freed }))
        }
        Err(e) => {
            op.finish_err(&e);
            Ok(map_err(e))
        }
    }
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemotePaperRescanResult {
    pub count: usize,
}

#[tauri::command]
#[specta::specta]
pub async fn remote_paper_rescan(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemoteSessionArgs,
) -> Result<ApiResult<RemotePaperRescanResult>, String> {
    let session = try_session!(registry, &args.session_id);
    let result = match remote_rescan_impl(&session).await {
        Ok(r) => ApiResult::ok(r),
        Err(e) => map_err(e),
    };
    commit_paper_write(&session, result).await
}

/// Remote-only rescan: walk `papers/` over the session FS (local rescan uses
/// `papers::rebuild_from_disk` on `std::fs`). A folder is a paper when a file
/// is named `NOTES.md` or `metadata.json` ([`is_paper_marker_file`]); those
/// folders are backfilled with a NOTES.md title and a `remote_rescan` fallback
/// row. Confirmed paper folders are not descended. The catalog push stays in
/// [`commit_paper_write`] for both rescan and the other remote writes.
async fn remote_rescan_impl(session: &RemoteSession) -> Result<RemotePaperRescanResult, AppError> {
    use papers::PaperRecord;

    let mut count = 0usize;
    let now = crate::core::time::now_rfc3339_millis();

    let mut stack = vec!["papers".to_string()];
    while let Some(dir) = stack.pop() {
        let entries = match session.fs.list(&dir).await {
            Ok(e) => e,
            Err(_) => continue,
        };
        let has_marker = entries
            .iter()
            .any(|e| e.is_file && is_paper_marker_file(&e.name));
        if has_marker && dir != "papers" {
            let path = dir.clone();
            let id = path.rsplit('/').next().unwrap_or("paper").to_string();
            let existing = papers::get_by_path(&session.work_root, &path)?;
            let mut rec = existing.unwrap_or_else(|| {
                let mut rec = PaperRecord::local_pdf(id.clone(), id.clone()).at_path(&path);
                rec.meta_source = Some("remote_rescan".into());
                rec
            });
            if let Ok(bytes) = session.fs.read(&format!("{path}/NOTES.md")).await {
                if let Ok(text) = String::from_utf8(bytes) {
                    if let Some(line) = text.lines().find(|l| l.starts_with("# ")) {
                        rec.title = line.trim_start_matches('#').trim().to_string();
                    }
                }
            }
            rec.path = path;
            rec.updated_at = now.clone();
            papers::upsert_paper(&session.work_root, &rec)?;
            count += 1;
            continue;
        }
        for e in entries {
            if e.is_dir {
                stack.push(e.path);
            }
        }
    }

    Ok(RemotePaperRescanResult { count })
}
