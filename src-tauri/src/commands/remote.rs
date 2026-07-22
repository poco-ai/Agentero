//! Tauri commands for remote vault (SSH/SFTP) — `docs/development/remote-vault.md`.

use crate::error::AppError;
use crate::log_util::{trunc, OpTimer};
use crate::services::catalog::papers::{self, PaperRecord};
use crate::services::fs::{normalize_rel, path_escapes_root, FsDirEntry, FsFileMeta, WriteOpts};
use crate::services::remote::agent_exec;
use crate::services::remote::{ensure_remote_vault_skills, RemoteRegistry, RemoteSessionInfo};
use crate::services::vault::CreateVaultResult;
use serde::Deserialize;
use serde::Serialize;
use std::sync::Arc;
use tauri::State;

/// Normalize a work-mirror relative path argument; rejects empty and `..`.
fn rel_path_arg(raw: &str) -> Result<String, AppError> {
    if path_escapes_root(raw) {
        return Err(AppError::invalid("invalid path"));
    }
    let path = normalize_rel(raw);
    if path.is_empty() {
        return Err(AppError::invalid("path is required"));
    }
    Ok(path)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConnectArgs {
    /// SSH host or config alias. Use `__local_sim__` with an absolute local path for tests.
    pub host: String,
    #[serde(default)]
    pub user: Option<String>,
    pub remote_path: String,
}

#[tauri::command]
pub async fn remote_connect(
    registry: State<'_, Arc<RemoteRegistry>>,
    connector: State<'_, Arc<crate::services::connector::ConnectorController>>,
    args: RemoteConnectArgs,
) -> Result<RemoteSessionInfo, AppError> {
    let op = OpTimer::start_with(
        "remote_connect",
        format!(
            "host={} path={}",
            trunc(&args.host, 80),
            trunc(&args.remote_path, 120)
        ),
    );
    let result = registry
        .connect(&args.host, args.user.as_deref(), &args.remote_path)
        .await
        .inspect(|info| {
            // Bind Zotero Connector save target on Host (do not rely only on frontend).
            connector.set_vault(Some(info.vault_handle.clone()));
            log::info!(
                target: "agentero::op",
                "connector vault bound to {}",
                trunc(&info.vault_handle, 80)
            );
        });
    op.finish(result)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSessionArgs {
    pub session_id: String,
}

#[tauri::command]
pub async fn remote_disconnect(
    registry: State<'_, Arc<RemoteRegistry>>,
    connector: State<'_, Arc<crate::services::connector::ConnectorController>>,
    args: RemoteSessionArgs,
) -> Result<(), AppError> {
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
    let result = registry.disconnect(&args.session_id).await.inspect(|()| {
        if bound_here {
            connector.set_vault(None);
        }
    });
    op.finish(result)
}

#[tauri::command]
pub async fn remote_status(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemoteSessionArgs,
) -> Result<RemoteSessionInfo, AppError> {
    Ok(registry.get(&args.session_id).await?.info())
}

/// Ensure missing bundled skills in a remote vault without overwriting user files.
#[tauri::command]
pub async fn remote_vault_ensure(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemoteSessionArgs,
) -> Result<CreateVaultResult, AppError> {
    let session = registry.get(&args.session_id).await?;
    ensure_remote_vault_skills(&session).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePathArgs {
    pub session_id: String,
    #[serde(default)]
    pub path: String,
}

#[tauri::command]
pub async fn remote_list(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemotePathArgs,
) -> Result<Vec<FsDirEntry>, AppError> {
    let session = registry.get(&args.session_id).await?;
    session.fs.list(&args.path).await
}

#[tauri::command]
pub async fn remote_stat(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemotePathArgs,
) -> Result<FsFileMeta, AppError> {
    let session = registry.get(&args.session_id).await?;
    session.fs.stat(&args.path).await
}

#[tauri::command]
pub async fn remote_read_text(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemotePathArgs,
) -> Result<String, AppError> {
    let session = registry.get(&args.session_id).await?;
    let bytes = session.fs.read(&args.path).await?;
    String::from_utf8(bytes).map_err(|e| AppError::invalid(format!("not utf-8: {e}")))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWriteTextArgs {
    pub session_id: String,
    pub path: String,
    pub content: String,
}

#[tauri::command]
pub async fn remote_write_text(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemoteWriteTextArgs,
) -> Result<(), AppError> {
    let session = registry.get(&args.session_id).await?;
    session
        .fs
        .write(
            &args.path,
            args.content.as_bytes(),
            WriteOpts {
                create_parents: true,
            },
        )
        .await
}

#[tauri::command]
pub async fn remote_read_bytes(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemotePathArgs,
) -> Result<Vec<u8>, AppError> {
    let session = registry.get(&args.session_id).await?;
    session.fs.read(&args.path).await
}

#[tauri::command]
pub async fn remote_mkdir(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemotePathArgs,
) -> Result<(), AppError> {
    let session = registry.get(&args.session_id).await?;
    session.fs.mkdir(&args.path).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRemoveArgs {
    pub session_id: String,
    pub path: String,
    #[serde(default)]
    pub recursive: bool,
}

#[tauri::command]
pub async fn remote_remove(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemoteRemoveArgs,
) -> Result<(), AppError> {
    let session = registry.get(&args.session_id).await?;
    session.fs.remove(&args.path, args.recursive).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWriteBytesArgs {
    pub session_id: String,
    pub path: String,
    pub data: Vec<u8>,
}

#[tauri::command]
pub async fn remote_write_bytes(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemoteWriteBytesArgs,
) -> Result<(), AppError> {
    let session = registry.get(&args.session_id).await?;
    session
        .fs
        .write(
            &args.path,
            &args.data,
            WriteOpts {
                create_parents: true,
            },
        )
        .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePaperGetArgs {
    pub session_id: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePaperDeleteArgs {
    pub session_id: String,
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePaperDeleteResult {
    pub removed: usize,
}

#[tauri::command]
pub async fn remote_paper_delete(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemotePaperDeleteArgs,
) -> Result<RemotePaperDeleteResult, AppError> {
    let session = registry.get(&args.session_id).await?;
    let path = rel_path_arg(&args.path)?;
    let removed = papers::delete_under_path(&session.work_root, &path)?;
    {
        let mut cat = session.catalog.lock().await;
        cat.push(session.fs.clone()).await?;
    }
    Ok(RemotePaperDeleteResult { removed })
}

#[tauri::command]
pub async fn remote_paper_get(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemotePaperGetArgs,
) -> Result<PaperRecord, AppError> {
    let session = registry.get(&args.session_id).await?;
    let work = session.work_root.clone();
    let row = if let Some(path) = args
        .path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        papers::get_by_path(&work, &rel_path_arg(path)?)?
    } else if let Some(id) = args.id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        papers::get_by_id(&work, id)?
    } else {
        return Err(AppError::invalid("path or id is required"));
    };
    row.ok_or_else(|| AppError::PaperNotFound("paper not found in catalog".into()))
}

#[tauri::command]
pub async fn remote_paper_list(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemoteSessionArgs,
) -> Result<Vec<PaperRecord>, AppError> {
    let session = registry.get(&args.session_id).await?;
    papers::list_all(&session.work_root)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePaperSetTagsArgs {
    pub session_id: String,
    pub path: String,
    pub tags: Vec<papers::PaperTag>,
}

#[tauri::command]
pub async fn remote_paper_set_tags(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemotePaperSetTagsArgs,
) -> Result<PaperRecord, AppError> {
    let session = registry.get(&args.session_id).await?;
    let path = rel_path_arg(&args.path)?;
    let row = papers::set_tags(&session.work_root, &path, &args.tags)?;
    {
        let mut cat = session.catalog.lock().await;
        cat.push(session.fs.clone()).await?;
    }
    Ok(row)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePaperSetIsReadArgs {
    pub session_id: String,
    pub path: String,
    pub is_read: bool,
}

#[tauri::command]
pub async fn remote_paper_set_is_read(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemotePaperSetIsReadArgs,
) -> Result<PaperRecord, AppError> {
    let session = registry.get(&args.session_id).await?;
    let path = rel_path_arg(&args.path)?;
    let row = papers::set_is_read(&session.work_root, &path, args.is_read)?;
    {
        let mut cat = session.catalog.lock().await;
        cat.push(session.fs.clone()).await?;
    }
    Ok(row)
}

/// Ensure a remote PDF (or other file) is cached under the session blob dir; return local path.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCacheFileArgs {
    pub session_id: String,
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCacheFileResult {
    /// Absolute local path to cached bytes (ephemeral).
    pub local_path: String,
}

#[tauri::command]
pub async fn remote_cache_file(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemoteCacheFileArgs,
) -> Result<RemoteCacheFileResult, AppError> {
    let session = registry.get(&args.session_id).await?;
    let rel = rel_path_arg(&args.path)?;
    let meta = session.fs.stat(&rel).await?;
    // Cache key: path + size + mtime
    let key = format!("{rel}\0{}\0{}", meta.size, meta.mtime);
    let hash = {
        use sha2::{Digest, Sha256};
        hex::encode(Sha256::digest(key.as_bytes()))
    };
    let ext = std::path::Path::new(&rel)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin");
    let dest = session.blob_root.join(format!("{hash}.{ext}"));
    use crate::services::remote::blob_cache::{self, DEFAULT_MAX_BYTES};
    if dest.is_file() {
        blob_cache::touch_mtime(&dest);
    } else {
        let bytes = session.fs.read(&rel).await?;
        blob_cache::put_or_touch(&dest, Some(&bytes))?;
        if let Err(e) = blob_cache::enforce_lru(&session.blob_root, DEFAULT_MAX_BYTES) {
            log::warn!("blob LRU enforce: {e}");
        }
    }
    Ok(RemoteCacheFileResult {
        local_path: dest.to_string_lossy().into_owned(),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCacheStatsArgs {
    /// When set, stats for that session's blob dir; otherwise all remote caches.
    #[serde(default)]
    pub session_id: Option<String>,
}

#[tauri::command]
pub async fn remote_cache_stats(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemoteCacheStatsArgs,
) -> Result<crate::services::remote::blob_cache::BlobCacheStats, AppError> {
    use crate::services::remote::blob_cache;
    if let Some(sid) = args
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let session = registry.get(sid).await?;
        Ok(blob_cache::stats_for_root(&session.blob_root))
    } else {
        Ok(blob_cache::stats_all())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCacheClearArgs {
    /// When set, clear that session's blobs; otherwise all remote blob caches.
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCacheClearResult {
    pub freed_bytes: u64,
}

#[tauri::command]
pub async fn remote_cache_clear(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemoteCacheClearArgs,
) -> Result<RemoteCacheClearResult, AppError> {
    use crate::services::remote::blob_cache;
    let op = OpTimer::start("remote_cache_clear");
    let result = async {
        let freed = if let Some(sid) = args
            .session_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let session = registry.get(sid).await?;
            blob_cache::clear_root(&session.blob_root)?
        } else {
            blob_cache::clear_all()?
        };
        Ok(RemoteCacheClearResult { freed_bytes: freed })
    }
    .await;
    op.finish_extra(result, |r: &RemoteCacheClearResult| {
        format!("freed_bytes={}", r.freed_bytes)
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePaperRescanResult {
    pub count: usize,
}

#[tauri::command]
pub async fn remote_paper_rescan(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemoteSessionArgs,
) -> Result<RemotePaperRescanResult, AppError> {
    let session = registry.get(&args.session_id).await?;
    remote_rescan_impl(&session).await
}

async fn remote_rescan_impl(
    session: &crate::services::remote::RemoteSession,
) -> Result<RemotePaperRescanResult, AppError> {
    use papers::PaperRecord;

    let mut count = 0usize;
    let now = chrono::Utc::now().to_rfc3339();

    let mut stack = vec!["papers".to_string()];
    while let Some(dir) = stack.pop() {
        let entries = match session.fs.list(&dir).await {
            Ok(e) => e,
            Err(_) => continue,
        };
        let mut has_marker = false;
        for e in &entries {
            if e.is_file
                && matches!(
                    e.name.as_str(),
                    "NOTES.md" | "highlights.md" | "PAPER.md" | "metadata.json"
                )
            {
                has_marker = true;
            }
            if e.is_dir && matches!(e.name.as_str(), "source" | "assets" | "marks") {
                has_marker = true;
            }
        }
        if has_marker && dir != "papers" {
            let path = dir.clone();
            let id = path.rsplit('/').next().unwrap_or("paper").to_string();
            let existing = papers::get_by_path(&session.work_root, &path)?;
            let mut rec = existing.unwrap_or_else(|| PaperRecord {
                path: path.clone(),
                id: id.clone(),
                paper_type: "article".into(),
                title: id.clone(),
                authors: vec![],
                creators: None,
                year: None,
                date: None,
                abstract_text: None,
                tags: vec![],
                arxiv_id: None,
                doi: None,
                isbn: None,
                issn: None,
                pmid: None,
                publication: None,
                volume: None,
                issue: None,
                pages: None,
                publisher: None,
                place: None,
                series: None,
                language: None,
                pdf_url: None,
                html_url: None,
                source_url: None,
                body_source: None,
                body_quality: None,
                bibtex_key: None,
                citation_count: None,
                zotero_item_type: None,
                meta_source: Some("remote_rescan".into()),
                extra: None,
                summary: None,
                status: "unread".into(),
                is_read: false,
                added_at: now.clone(),
                updated_at: now.clone(),
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
            if e.is_dir && e.name != "source" && e.name != "assets" && e.name != "marks" {
                stack.push(e.path);
            }
        }
    }

    {
        let mut cat = session.catalog.lock().await;
        cat.push(session.fs.clone()).await?;
    }

    Ok(RemotePaperRescanResult { count })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAgentDiscoverArgs {
    pub session_id: String,
    #[serde(default)]
    pub bins: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAgentDiscoverResult {
    pub destination: String,
    pub found: Vec<RemoteAgentBin>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAgentBin {
    pub bin: String,
    pub path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAgentScanArgs {
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHostIdentityArgs {
    pub session_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHostIdentity {
    pub session_id: String,
    pub destination: String,
    /// `macos` | `windows` | `linux` | `other`
    pub os: String,
    /// Raw `uname -s` (or local-sim compile target).
    pub uname: String,
}

/// Best-effort remote OS family for Settings host badge icons.
#[tauri::command]
pub async fn remote_host_identity(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemoteHostIdentityArgs,
) -> Result<RemoteHostIdentity, AppError> {
    let session = registry.get(&args.session_id).await?;
    if session.kind == "local-sim" {
        let os = if cfg!(target_os = "macos") {
            "macos"
        } else if cfg!(target_os = "windows") {
            "windows"
        } else if cfg!(target_os = "linux") {
            "linux"
        } else {
            "other"
        };
        return Ok(RemoteHostIdentity {
            session_id: args.session_id,
            destination: "local-sim".into(),
            os: os.into(),
            uname: std::env::consts::OS.into(),
        });
    }
    let destination = session.host.clone();
    let (uname, os) = agent_exec::remote_uname(&destination).await?;
    Ok(RemoteHostIdentity {
        session_id: args.session_id,
        destination,
        os,
        uname,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAgentProbeArgs {
    pub session_id: String,
    pub template_id: String,
}

/// Catalog-style scan of common agents on the remote host (`command -v`).
#[tauri::command]
pub async fn remote_agent_scan(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemoteAgentScanArgs,
) -> Result<crate::services::remote::agent_catalog::RemoteAgentScanResponse, AppError> {
    let op = OpTimer::start_with(
        "remote_agent_scan",
        format!("session={}", trunc(&args.session_id, 40)),
    );
    op.finish_extra(
        crate::services::remote::agent_catalog::scan_remote_agents(
            registry.inner(),
            &args.session_id,
        )
        .await,
        |r| format!("entries={}", r.entries.len()),
    )
}

/// ACP initialize probe for one catalog template on the remote vault host.
#[tauri::command]
pub async fn remote_agent_probe(
    registry: State<'_, Arc<RemoteRegistry>>,
    agent_registry: State<'_, crate::services::agent::AgentRegistry>,
    args: RemoteAgentProbeArgs,
) -> Result<crate::models::agent::ProbeResult, AppError> {
    let op = OpTimer::start_with(
        "remote_agent_probe",
        format!(
            "session={} template={}",
            trunc(&args.session_id, 40),
            trunc(&args.template_id, 40)
        ),
    );
    let (proxy_enabled, proxy_url) = match agent_registry.snapshot() {
        Ok(s) => (s.proxy_enabled, s.proxy_url),
        Err(_) => (false, String::new()),
    };
    op.finish_extra(
        crate::services::remote::agent_catalog::probe_remote_template(
            registry.inner(),
            &args.session_id,
            &args.template_id,
            proxy_enabled,
            &proxy_url,
        )
        .await,
        |r| {
            if r.available {
                String::new()
            } else {
                format!("fail={}", trunc(r.error.as_deref().unwrap_or("?"), 80))
            }
        },
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAgentInstallArgs {
    pub session_id: String,
    pub template_id: String,
}

/// Open a local terminal that SSHes into the remote host and runs the template's
/// install command after the user presses Enter (same confirm UX as local install).
#[tauri::command]
pub async fn remote_agent_open_install_terminal(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemoteAgentInstallArgs,
) -> Result<(), AppError> {
    use crate::services::agent::templates::template_info;
    use crate::services::terminal;

    let info = template_info(&args.template_id).ok_or_else(|| {
        AppError::invalid(format!("unknown catalog template: {}", args.template_id))
    })?;
    let install = match info.install_command {
        Some(c) if !c.trim().is_empty() => c.trim().to_string(),
        _ => {
            return Err(AppError::invalid(format!(
                "no install command for template: {}",
                args.template_id
            )));
        }
    };
    let session = registry.get(&args.session_id).await?;
    if session.kind == "local-sim" {
        return terminal::open_terminal_confirm_command(&install);
    }
    terminal::open_terminal_confirm_remote_install(&session.host, &install)
}

#[tauri::command]
pub async fn remote_agent_discover(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: RemoteAgentDiscoverArgs,
) -> Result<RemoteAgentDiscoverResult, AppError> {
    let session = registry.get(&args.session_id).await?;
    let bins = if args.bins.is_empty() {
        vec![
            "opencode".into(),
            "claude-agent-acp".into(),
            "codex".into(),
            "qodercli".into(),
        ]
    } else {
        args.bins
    };
    if session.kind == "local-sim" {
        let mut found = Vec::new();
        for bin in bins {
            if let Ok(path) = which::which(&bin) {
                found.push(RemoteAgentBin {
                    bin: bin.clone(),
                    path: path.display().to_string(),
                });
            }
        }
        return Ok(RemoteAgentDiscoverResult {
            destination: "local-sim".into(),
            found,
        });
    }

    let destination = session.host.clone();
    let mut found = Vec::new();
    for bin in bins {
        if let Some(path) = agent_exec::remote_which(&destination, &bin).await? {
            found.push(RemoteAgentBin { bin, path });
        }
    }
    Ok(RemoteAgentDiscoverResult { destination, found })
}
