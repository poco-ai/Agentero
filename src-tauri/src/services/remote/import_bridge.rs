//! Magic-wand / asset import into a remote vault (stage locally → SFTP → catalog push).

use super::session::RemoteSession;
use crate::error::AppError;
use crate::services::catalog::papers;
use crate::services::fs::{VaultFs, WriteOpts};
use crate::services::lookup::parse::extract_arxiv_id;
use crate::services::lookup::{
    enrich_remote_urls, ensure_paper_assets, map_zotero_item, normalize_parent_dir,
    paper_record_from_meta, resolve_metadata, write_paper_shell, AssetDownloadResult,
    ImportLocalPdfArgs, ImportLocalPdfResult, LocalPdfImportEntry, LookupImportArgs,
    LookupImportResult, PaperDownloadAssetsArgs, PaperImportArgs, PaperImportResult,
    DEFAULT_TRANSLATOR_BASE_URL,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use walkdir::WalkDir;

/// Import by identifier into a remote vault session.
pub async fn import_by_identifier_remote(
    session: Arc<RemoteSession>,
    args: LookupImportArgs,
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

    let (mut meta, used_translator) = resolve_metadata(text, &base).await?;
    enrich_remote_urls(&mut meta);

    let id = meta.id.clone();
    if id.is_empty() {
        return Err(AppError::message("resolved metadata has empty id"));
    }

    let (id, path_rel) = unique_remote_paper_path(session.fs.as_ref(), &parent_rel, &id).await?;
    meta.id = id.clone();
    let staging = session.work_root.join(&path_rel);
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    fs::create_dir_all(&staging)?;

    write_paper_shell(&staging, &meta).await?;

    let mut assets = ensure_paper_assets(
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
    });

    let parse = crate::services::pdf_parse::maybe_generate_paper_md_after_download(
        &session.work_root,
        &path_rel,
        &staging,
    )
    .await;
    assets.paper_md = parse.paper_md;
    for m in parse.messages {
        assets.messages.push(m);
    }

    // Upload staged tree to remote (source of truth)
    upload_tree(session.fs.as_ref(), &staging, &path_rel).await?;

    let record = paper_record_from_meta(&path_rel, &meta);
    papers::upsert_paper(&session.work_root, &record)?;
    {
        let mut cat = session.catalog.lock().await;
        cat.push(session.fs.clone()).await?;
    }

    let paper_dir = format!("remote:{}/{}", session.id, path_rel);
    Ok(LookupImportResult {
        paper_dir,
        path: path_rel,
        id: meta.id,
        title: meta.title,
        used_translator,
        translator_base_url: base,
        pdf: assets.pdf,
        tex: assets.tex,
        paper_md: assets.paper_md,
        asset_messages: assets.messages,
    })
}

/// Download missing PDF/TeX for an existing remote paper folder.
pub async fn download_paper_assets_remote(
    session: Arc<RemoteSession>,
    args: PaperDownloadAssetsArgs,
) -> Result<AssetDownloadResult, AppError> {
    let path_rel = args
        .path
        .trim()
        .replace('\\', "/")
        .trim_matches('/')
        .to_string();
    if path_rel.is_empty() || path_rel.split('/').any(|p| p == ".." || p.is_empty()) {
        return Err(AppError::message("invalid paper path"));
    }
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

    let mut result = ensure_paper_assets(
        &staging,
        &id,
        arxiv_id.as_deref(),
        pdf_url.as_deref(),
        doi.as_deref(),
    )
    .await?;

    let parse = crate::services::pdf_parse::maybe_generate_paper_md_after_download(
        &session.work_root,
        &path_rel,
        &staging,
    )
    .await;
    result.paper_md = parse.paper_md;
    for m in parse.messages {
        result.messages.push(m);
    }

    // Upload new assets (and PAPER.md) — don't re-upload whole tree if huge; upload all staged
    upload_tree(session.fs.as_ref(), &staging, &path_rel).await?;

    // Touch catalog updated_at if row exists
    if let Ok(Some(mut row)) = papers::get_by_path(&session.work_root, &path_rel) {
        row.updated_at = chrono::Utc::now().to_rfc3339();
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
                id: None,
            })
            .collect()
    };

    let mut papers_out = Vec::new();
    let mut errors = Vec::new();
    for entry in &entries {
        match import_one_local_pdf_remote(session.clone(), &parent_rel, entry).await {
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
        .id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(slug_from_stem)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| slug_from_stem(stem));
    let (id, path_rel) =
        unique_remote_paper_path(session.fs.as_ref(), parent_rel, &base_id).await?;

    let staging = session.work_root.join(&path_rel);
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    fs::create_dir_all(&staging)?;
    fs::copy(&src, staging.join(format!("{id}.pdf")))
        .map_err(|e| AppError::message(format!("copy PDF failed: {e}")))?;

    let mut meta = crate::services::lookup::local_pdf_meta_for_import(id.clone(), title);
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
    write_paper_shell(&staging, &meta).await?;
    let record = paper_record_from_meta(&path_rel, &meta);
    papers::upsert_paper(&session.work_root, &record)?;

    let parse = crate::services::pdf_parse::maybe_generate_paper_md_after_download(
        &session.work_root,
        &path_rel,
        &staging,
    )
    .await;

    upload_tree(session.fs.as_ref(), &staging, &path_rel).await?;

    Ok(LookupImportResult {
        paper_dir: format!("remote:{}/{}", session.id, path_rel),
        path: path_rel,
        id: meta.id,
        title: meta.title,
        used_translator: false,
        translator_base_url: String::new(),
        pdf: true,
        tex: false,
        paper_md: parse.paper_md,
        asset_messages: parse.messages,
    })
}

/// BibTeX / RIS / … import via Translator into remote vault.
pub async fn import_catalog_remote(
    session: Arc<RemoteSession>,
    args: PaperImportArgs,
) -> Result<PaperImportResult, AppError> {
    let content = args.content.trim();
    if content.is_empty() {
        return Err(AppError::message("import content is empty"));
    }
    let parent_rel = normalize_parent_dir(args.parent_dir.as_deref().unwrap_or("papers"))?;
    let items = crate::services::lookup::zotero_io::translator_import_items(
        content,
        args.translator_base_url.as_deref(),
    )
    .await?;

    let mut imported = 0usize;
    let mut skipped = 0usize;
    let mut paths = Vec::new();
    let mut titles = Vec::new();
    let mut errors = Vec::new();

    for item in items {
        match import_one_zotero_item_remote(session.clone(), &parent_rel, &item).await {
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

    let (id, path_rel) =
        unique_remote_paper_path(session.fs.as_ref(), parent_rel, &base_id).await?;
    meta.id = id.clone();

    let staging = session.work_root.join(&path_rel);
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    fs::create_dir_all(&staging)?;
    write_paper_shell(&staging, &meta).await?;
    let record = paper_record_from_meta(&path_rel, &meta);
    papers::upsert_paper(&session.work_root, &record)?;

    let _ = ensure_paper_assets(
        &staging,
        &id,
        meta.arxiv_id.as_deref(),
        meta.pdf_url.as_deref(),
        meta.doi.as_deref(),
    )
    .await;
    let _ = crate::services::pdf_parse::maybe_generate_paper_md_after_download(
        &session.work_root,
        &path_rel,
        &staging,
    )
    .await;

    upload_tree(session.fs.as_ref(), &staging, &path_rel).await?;
    Ok(Some((path_rel, meta.title)))
}

fn slug_from_stem(stem: &str) -> String {
    let mut s = String::new();
    let mut prev_sep = true;
    for c in stem.trim().chars() {
        if c.is_ascii_alphanumeric() || c == '.' {
            s.push(c);
            prev_sep = false;
        } else if !prev_sep {
            s.push('-');
            prev_sep = true;
        }
    }
    let s: String = s.chars().take(60).collect();
    let s = s.trim_matches(|c| c == '-' || c == '.').to_string();
    if s.is_empty() {
        "paper".into()
    } else {
        s
    }
}

fn title_from_stem(stem: &str) -> String {
    let spaced: String = stem
        .trim()
        .chars()
        .map(|c| if c == '_' { ' ' } else { c })
        .collect();
    let collapsed = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        "Untitled".into()
    } else {
        collapsed
    }
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

/// Generate PAPER.md on a remote paper folder (pull PDF → liteparse → put).
pub async fn parse_paper_body_remote(
    session: Arc<RemoteSession>,
    path_rel: &str,
    force: bool,
) -> Result<crate::services::pdf_parse::PaperParseResult, AppError> {
    use crate::services::pdf_parse::{self, PaperParseBodyArgs};

    let path_rel = path_rel
        .trim()
        .replace('\\', "/")
        .trim_matches('/')
        .to_string();
    if path_rel.is_empty() || path_rel.split('/').any(|p| p == ".." || p.is_empty()) {
        return Err(AppError::message("invalid paper path"));
    }
    if !session.fs.exists(&path_rel).await? {
        return Err(AppError::message("paper folder not found"));
    }

    // Materialize remote paper into work_root for liteparse.
    let staging = session.work_root.join(&path_rel);
    let _ = fs::create_dir_all(&staging);
    // Pull NOTES / common PDFs / existing PAPER.md
    pull_if_exists(session.fs.as_ref(), &path_rel, &staging, "NOTES.md").await?;
    pull_if_exists(session.fs.as_ref(), &path_rel, &staging, "PAPER.md").await?;
    // List remote paper dir for PDFs
    if let Ok(entries) = session.fs.list(&path_rel).await {
        for e in entries {
            if e.is_file && e.name.to_ascii_lowercase().ends_with(".pdf") {
                pull_if_exists(session.fs.as_ref(), &path_rel, &staging, &e.name).await?;
            }
        }
    }

    let args = PaperParseBodyArgs {
        vault_path: session.work_root.to_string_lossy().into_owned(),
        path: path_rel.clone(),
        force,
    };
    let result = pdf_parse::parse_paper_body(args).await?;
    if result.paper_md {
        let paper_md = staging.join("PAPER.md");
        if paper_md.is_file() {
            let bytes = fs::read(&paper_md)?;
            session
                .fs
                .write(
                    &format!("{path_rel}/PAPER.md"),
                    &bytes,
                    WriteOpts {
                        create_parents: true,
                    },
                )
                .await?;
        }
        // body_source/body_quality may be on catalog — push if work catalog changed
        if let Ok(Some(mut row)) = papers::get_by_path(&session.work_root, &path_rel) {
            if let Some(ref s) = result.body_source {
                row.body_source = Some(s.clone());
            }
            if let Some(ref q) = result.body_quality {
                row.body_quality = Some(q.clone());
            }
            let _ = papers::upsert_paper(&session.work_root, &row);
            let mut cat = session.catalog.lock().await;
            let _ = cat.push(session.fs.clone()).await;
        }
    }
    Ok(result)
}
