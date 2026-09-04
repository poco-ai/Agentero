//! Magic-wand / asset import into a remote vault (stage locally → SFTP → catalog push).

use super::paper_commit::{remote_paper_commit, RemoteAssetsPolicy, RemotePaperCommitOptions};
use super::session::RemoteSession;
use crate::core::error::AppError;
use crate::core::fs::{VaultFs, WriteOpts};
use crate::features::catalog::papers;
use crate::features::import::{
    doi_slug, enrich_remote_urls, ensure_paper_assets, extract_arxiv_id, map_zotero_item,
    normalize_parent_dir, preflight_identifier_batch, resolve_metadata, slug_from_stem,
    title_from_stem, translator_import_items, AssetDownloadResult, ImportLocalPdfArgs,
    ImportLocalPdfResult, LocalPdfImportEntry, LookupImportArgs, LookupImportBatchArgs,
    LookupImportBatchResult, LookupImportResult, NoteShellMode, PaperDownloadAssetsArgs,
    PaperImportArgs, PaperImportResult, SkillBatchMode, DEFAULT_TRANSLATOR_BASE_URL,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use walkdir::WalkDir;

/// Import by identifier into a remote vault session.
pub async fn import_by_identifier_remote(
    session: Arc<RemoteSession>,
    args: LookupImportArgs,
    note_mode: NoteShellMode,
) -> Result<LookupImportResult, AppError> {
    let parent_rel = normalize_parent_dir(&args.parent_dir)?;
    let base = args
        .translator_base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_TRANSLATOR_BASE_URL)
        .trim_end_matches('/')
        .to_string();

    let text = args.text.trim();
    if text.is_empty() {
        return Err(AppError::message("identifier text is empty"));
    }

    crate::features::import::check_task_not_cancelled(args.task_id.as_deref())?;
    let (mut meta, used_translator) =
        resolve_metadata(text, &base, args.task_id.as_deref()).await?;
    crate::features::import::check_task_not_cancelled(args.task_id.as_deref())?;
    enrich_remote_urls(&mut meta);

    let commit = remote_paper_commit(
        session.clone(),
        meta,
        RemotePaperCommitOptions {
            parent_rel: &parent_rel,
            task_id: args.task_id.as_deref(),
            assets: RemoteAssetsPolicy::SyncDownload,
            push_catalog: true,
            note_mode,
        },
    )
    .await?;

    let paper_dir = format!("remote:{}/{}", session.id, commit.path);
    Ok(LookupImportResult {
        paper_dir,
        path: commit.path,
        id: commit.id,
        title: commit.title,
        used_translator,
        translator_base_url: base,
        pdf: commit.pdf,
        tex: commit.tex,
        paper_md: commit.paper_md,
        asset_messages: commit.asset_messages,
        status: None,
        recognize_pending: false,
    })
}

/// Batch import by identifier into a remote vault session.
pub async fn import_by_identifier_batch_remote(
    session: Arc<RemoteSession>,
    args: LookupImportBatchArgs,
    note_mode: NoteShellMode,
) -> Result<LookupImportBatchResult, AppError> {
    let mut imported: Vec<LookupImportResult> = Vec::new();
    let preflight = preflight_identifier_batch(
        &args.texts,
        &session.work_root,
        SkillBatchMode::RejectRemote,
        true,
    );
    let skipped = preflight.skipped;
    let mut errors = preflight.errors;
    let search_candidates = crate::features::import::resolve_search_queries(
        &preflight.queries,
        &mut errors,
        args.task_id.as_deref(),
    )
    .await;

    for pending in preflight.papers {
        let single = LookupImportArgs {
            vault_path: args.vault_path.clone(),
            parent_dir: args.parent_dir.clone(),
            text: pending.raw.clone(),
            translator_base_url: args.translator_base_url.clone(),
            task_id: args.task_id.clone(),
        };
        match import_by_identifier_remote(session.clone(), single, note_mode).await {
            Ok(r) => imported.push(r),
            Err(e) => errors.push(format!("{}: {e}", pending.raw)),
        }
    }

    Ok(LookupImportBatchResult {
        imported,
        skills: Vec::new(),
        skill_candidates: Vec::new(),
        search_candidates,
        skipped,
        errors,
    })
}

/// Download missing PDF/TeX for an existing remote paper folder.
pub async fn download_paper_assets_remote(
    session: Arc<RemoteSession>,
    args: PaperDownloadAssetsArgs,
) -> Result<AssetDownloadResult, AppError> {
    let path_rel = crate::core::fs::sanitize_vault_rel(&args.path)
        .map_err(|_| AppError::message("invalid paper path"))?;
    if !session.fs.exists(&path_rel).await? {
        return Err(AppError::message("paper folder not found"));
    }

    // Materialize existing remote paper into work_root (for asset helpers)
    let staging = session.work_root.join(&path_rel);
    fs::create_dir_all(&staging)?;
    // Pull NOTES etc. best-effort so we don't clobber — only need dir for downloads
    let _ = pull_if_exists(session.fs.as_ref(), &path_rel, &staging, "NOTES.md").await;
    let _ = pull_if_exists(session.fs.as_ref(), &path_rel, &staging, "highlights.md").await;

    let (id, arxiv_id, pdf_url, doi) =
        if let Ok(Some(row)) = papers::get_by_path(&session.work_root, &path_rel) {
            (row.id, row.arxiv_id, row.pdf_url, row.doi)
        } else {
            let name = path_rel.rsplit('/').next().unwrap_or("paper").to_string();
            let arxiv = extract_arxiv_id(&name);
            let pdf = arxiv.as_ref().map(|a| format!("https://arxiv.org/pdf/{a}"));
            (name, arxiv, pdf, None)
        };

    let result = ensure_paper_assets(
        &staging,
        &id,
        arxiv_id.as_deref(),
        pdf_url.as_deref(),
        doi.as_deref(),
    )
    .await?;

    // Upload new assets — don't re-upload whole tree if huge; upload all staged
    upload_tree(session.fs.as_ref(), &staging, &path_rel).await?;

    // Touch catalog updated_at if row exists
    if let Ok(Some(mut row)) = papers::get_by_path(&session.work_root, &path_rel) {
        row.updated_at = crate::core::time::now_rfc3339_millis();
        let _ = papers::upsert_paper(&session.work_root, &row);
        let mut cat = session.catalog.lock().await;
        let _ = cat.push(session.fs.clone()).await;
    }

    Ok(result)
}

/// Import local PDF files into a remote vault (copy from user machine → stage → SFTP).
/// Filename-derived title/id by default; optional per-file metadata overrides via `entries`.
pub async fn import_local_pdfs_remote(
    session: Arc<RemoteSession>,
    args: ImportLocalPdfArgs,
    note_mode: NoteShellMode,
) -> Result<ImportLocalPdfResult, AppError> {
    let parent_rel = normalize_parent_dir(&args.parent_dir)?;
    let entries: Vec<LocalPdfImportEntry> = if !args.entries.is_empty() {
        args.entries
    } else {
        args.file_paths
            .into_iter()
            .map(|file_path| LocalPdfImportEntry {
                file_path,
                title: None,
                authors: None,
                year: None,
                doi: None,
                arxiv_id: None,
                extra: None,
            })
            .collect()
    };

    let mut papers_out = Vec::new();
    let mut errors = Vec::new();
    for entry in &entries {
        match import_one_local_pdf_remote(
            session.clone(),
            &parent_rel,
            entry,
            args.task_id.as_deref(),
            note_mode,
        )
        .await
        {
            Ok(r) => papers_out.push(r),
            Err(e) => {
                let name = Path::new(entry.file_path.trim())
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or(entry.file_path.as_str());
                errors.push(format!("{name}: {e}"));
            }
        }
    }
    if papers_out.is_empty() && !errors.is_empty() {
        return Err(AppError::message(errors.join("; ")));
    }
    {
        let mut cat = session.catalog.lock().await;
        cat.push(session.fs.clone()).await?;
    }
    Ok(ImportLocalPdfResult {
        papers: papers_out,
        errors,
    })
}

async fn import_one_local_pdf_remote(
    session: Arc<RemoteSession>,
    parent_rel: &str,
    entry: &LocalPdfImportEntry,
    task_id: Option<&str>,
    note_mode: NoteShellMode,
) -> Result<LookupImportResult, AppError> {
    let src = PathBuf::from(entry.file_path.trim());
    if !src.is_file() {
        return Err(AppError::message("file not found"));
    }
    let is_pdf = src
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("pdf"));
    if !is_pdf {
        return Err(AppError::message("not a PDF file"));
    }

    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("paper");
    let title = entry
        .title
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| title_from_stem(stem));
    let base_id = entry
        .arxiv_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(slug_from_stem)
        .or_else(|| {
            entry
                .doi
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(doi_slug)
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| slug_from_stem(stem));
    let mut meta = crate::features::import::local_pdf_meta_for_import(base_id, title);
    if let Some(authors) = &entry.authors {
        meta.authors = authors
            .iter()
            .map(|a| a.trim())
            .filter(|a| !a.is_empty())
            .map(|a| a.to_string())
            .collect();
    }
    if let Some(year) = entry.year {
        meta.year = Some(year);
    }

    let commit = remote_paper_commit(
        session.clone(),
        meta,
        RemotePaperCommitOptions {
            parent_rel,
            task_id,
            assets: RemoteAssetsPolicy::CopyPdf { src: &src },
            push_catalog: false,
            note_mode,
        },
    )
    .await?;

    Ok(LookupImportResult {
        paper_dir: format!("remote:{}/{}", session.id, commit.path),
        path: commit.path,
        id: commit.id,
        title: commit.title,
        used_translator: false,
        translator_base_url: String::new(),
        pdf: commit.pdf,
        tex: commit.tex,
        paper_md: commit.paper_md,
        asset_messages: commit.asset_messages,
        status: None,
        recognize_pending: false,
    })
}

/// BibTeX / RIS / … import via Translator into remote vault.
pub async fn import_catalog_remote(
    session: Arc<RemoteSession>,
    args: PaperImportArgs,
    note_mode: NoteShellMode,
) -> Result<PaperImportResult, AppError> {
    let content = args.content.trim();
    if content.is_empty() {
        return Err(AppError::message("import content is empty"));
    }
    let parent_rel = normalize_parent_dir(args.parent_dir.as_deref().unwrap_or("papers"))?;
    let items = translator_import_items(content, args.translator_base_url.as_deref()).await?;

    let mut imported = 0usize;
    let mut skipped = 0usize;
    let mut paths = Vec::new();
    let mut titles = Vec::new();
    let mut errors = Vec::new();

    for item in items {
        match import_one_zotero_item_remote(session.clone(), &parent_rel, &item, note_mode).await {
            Ok(Some((path, title))) => {
                imported += 1;
                paths.push(path);
                titles.push(title);
            }
            Ok(None) => skipped += 1,
            Err(e) => errors.push(e.to_string()),
        }
    }

    {
        let mut cat = session.catalog.lock().await;
        cat.push(session.fs.clone()).await?;
    }

    Ok(PaperImportResult {
        imported,
        skipped,
        paths,
        titles,
        errors,
    })
}

async fn import_one_zotero_item_remote(
    session: Arc<RemoteSession>,
    parent_rel: &str,
    item: &serde_json::Value,
    note_mode: NoteShellMode,
) -> Result<Option<(String, String)>, AppError> {
    let mut meta = map_zotero_item(item)?;
    enrich_remote_urls(&mut meta);
    let base_id = meta.id.clone();
    if base_id.is_empty() {
        return Err(AppError::message("imported item has empty id"));
    }

    // Skip if catalog already has this path or NOTES exists remotely
    let candidate = format!("{parent_rel}/{base_id}");
    if papers::get_by_path(&session.work_root, &candidate)?.is_some()
        || session
            .fs
            .exists(&format!("{candidate}/NOTES.md"))
            .await
            .unwrap_or(false)
    {
        return Ok(None);
    }

    let commit = remote_paper_commit(
        session,
        meta,
        RemotePaperCommitOptions {
            parent_rel,
            task_id: None,
            assets: RemoteAssetsPolicy::SyncDownload,
            push_catalog: false,
            note_mode,
        },
    )
    .await?;
    Ok(Some((commit.path, commit.title)))
}

pub async fn unique_remote_paper_path(
    fs: &dyn VaultFs,
    parent_rel: &str,
    base_id: &str,
) -> Result<(String, String), AppError> {
    let mut id = base_id.to_string();
    let mut n = 2;
    loop {
        let path_rel = format!("{parent_rel}/{id}");
        if !fs.exists(&path_rel).await? || n > 999 {
            return Ok((id, path_rel));
        }
        id = format!("{base_id}-{n}");
        n += 1;
    }
}

/// Upload a local directory tree to a vault-relative remote path (SFTP / local-sim).
pub async fn upload_tree(
    fs: &dyn VaultFs,
    local_root: &Path,
    remote_rel: &str,
) -> Result<(), AppError> {
    if !local_root.is_dir() {
        return Ok(());
    }
    // Ensure remote paper dir exists
    fs.mkdir(remote_rel).await?;

    for entry in WalkDir::new(local_root).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        let rel = match path.strip_prefix(local_root) {
            Ok(r) => r,
            Err(_) => continue,
        };
        if rel.as_os_str().is_empty() {
            continue;
        }
        let rel_s = rel.to_string_lossy().replace('\\', "/");
        let remote = format!("{remote_rel}/{rel_s}");
        if path.is_dir() {
            let _ = fs.mkdir(&remote).await;
            continue;
        }
        if !path.is_file() {
            continue;
        }
        let bytes = fs::read(path)
            .map_err(|e| AppError::message(format!("read staged {}: {e}", path.display())))?;
        fs.write(
            &remote,
            &bytes,
            WriteOpts {
                create_parents: true,
            },
        )
        .await?;
    }
    Ok(())
}

async fn pull_if_exists(
    fs: &dyn VaultFs,
    remote_paper: &str,
    local_paper: &Path,
    name: &str,
) -> Result<(), AppError> {
    let remote = format!("{remote_paper}/{name}");
    if !fs.exists(&remote).await? {
        return Ok(());
    }
    let bytes = fs.read(&remote).await?;
    fs::write(local_paper.join(name), bytes)?;
    Ok(())
}
