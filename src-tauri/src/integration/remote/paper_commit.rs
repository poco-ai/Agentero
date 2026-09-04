use std::fs;
use std::path::Path;
use std::sync::Arc;

use super::import_bridge::{unique_remote_paper_path, upload_tree};
use super::session::RemoteSession;
use crate::core::error::AppError;
use crate::features::catalog::papers;
use crate::features::import::{
    ensure_paper_assets, paper_record_from_meta, write_paper_shell, AssetDownloadResult,
    NoteShellMode, PaperMeta,
};

pub(crate) enum RemoteAssetsPolicy<'a> {
    SyncDownload,
    CopyPdf { src: &'a Path },
}

pub(crate) struct RemotePaperCommitOptions<'a> {
    pub parent_rel: &'a str,
    pub task_id: Option<&'a str>,
    pub assets: RemoteAssetsPolicy<'a>,
    pub push_catalog: bool,
    /// NOTES.md shell generation mode (settings `paperNoteMode`), resolved by
    /// the constructing bridge from the local settings store.
    pub note_mode: NoteShellMode,
}

pub(crate) struct RemotePaperCommitResult {
    pub path: String,
    pub id: String,
    pub title: String,
    pub pdf: bool,
    pub tex: bool,
    pub paper_md: bool,
    pub asset_messages: Vec<String>,
}

pub(crate) async fn remote_paper_commit(
    session: Arc<RemoteSession>,
    mut meta: PaperMeta,
    opts: RemotePaperCommitOptions<'_>,
) -> Result<RemotePaperCommitResult, AppError> {
    if meta.id.is_empty() {
        return Err(AppError::message("resolved metadata has empty id"));
    }

    let (id, path_rel) =
        unique_remote_paper_path(session.fs.as_ref(), opts.parent_rel, &meta.id).await?;
    meta.id = id.clone();
    let staging = session.work_root.join(&path_rel);
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    fs::create_dir_all(&staging)?;

    if let RemoteAssetsPolicy::CopyPdf { src } = &opts.assets {
        fs::copy(src, staging.join(format!("{id}.pdf")))
            .map_err(|e| AppError::message(format!("copy PDF failed: {e}")))?;
    }

    write_paper_shell(&staging, &session.work_root, &meta, opts.note_mode).await?;

    let assets = match opts.assets {
        RemoteAssetsPolicy::SyncDownload => ensure_paper_assets(
            &staging,
            &id,
            meta.arxiv_id.as_deref(),
            meta.pdf_url.as_deref(),
            meta.doi.as_deref(),
        )
        .await
        .unwrap_or_else(|e| {
            let mut r = AssetDownloadResult::default();
            r.messages.push(format!("asset download error: {e}"));
            r
        }),
        RemoteAssetsPolicy::CopyPdf { .. } => AssetDownloadResult {
            pdf: true,
            ..Default::default()
        },
    };
    crate::features::import::check_task_not_cancelled(opts.task_id)?;

    upload_tree(session.fs.as_ref(), &staging, &path_rel).await?;

    let record = paper_record_from_meta(&path_rel, &meta);
    papers::upsert_paper(&session.work_root, &record)?;
    if opts.push_catalog {
        let mut cat = session.catalog.lock().await;
        cat.push(session.fs.clone()).await?;
    }

    Ok(RemotePaperCommitResult {
        path: path_rel,
        id: meta.id,
        title: meta.title,
        pdf: assets.pdf,
        tex: assets.tex,
        paper_md: assets.paper_md,
        asset_messages: assets.messages,
    })
}
