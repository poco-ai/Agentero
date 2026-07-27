//! Paper import: identifier lookup, Translator, Zotero migrate, local PDF, PAPER.md parse.
//!
//! @see docs/backend/identifier-lookup.md
//! @see docs/backend/paper-import-pipeline.md

pub mod commands;
pub mod paper_import;
pub mod pdf_parse;
pub mod zotero_commands;

mod assets;
mod map;
pub(crate) mod parse;
mod zotero_db;
pub(crate) mod zotero_io;

pub use assets::{
    ensure_paper_assets, ensure_paper_assets_with_cookies, ensure_paper_assets_with_progress,
    has_local_pdf, has_local_tex, AssetDownloadResult, AssetProgressContext,
};
pub use map::{enrich_remote_urls, map_zotero_item, PaperMeta};
pub use zotero_db::{
    migrate_zotero, scan_zotero, MigrateProgress, ZoteroMigrateArgs, ZoteroMigrateResult,
    ZoteroScan, ZoteroScanArgs,
};
pub use zotero_io::{
    export_catalog, import_catalog, PaperExportArgs, PaperExportResult, PaperImportArgs,
    PaperImportResult,
};

use crate::core::error::AppError;
use crate::features::catalog::papers::{self, PaperRecord};
use crate::features::import::assets::AssetDownloadProgress;
use futures_util::StreamExt;
use map::local_pdf_meta;
use parse::{extract_primary_identifier, IdentifierKind};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tokio::sync::Mutex;

/// Public helper for remote PDF import staging.
pub(crate) fn local_pdf_meta_for_import(id: String, title: String) -> PaperMeta {
    local_pdf_meta(id, title)
}

/// Default Translator Runtime base URL (hosted service).
/// Override via Settings → `translatorBaseUrl` / `LookupImportArgs.translator_base_url`.
pub const DEFAULT_TRANSLATOR_BASE_URL: &str = "https://translator.philfan.cn";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupImportArgs {
    pub vault_path: String,
    /// Vault-relative parent, e.g. `papers` or `papers/nlp`.
    pub parent_dir: String,
    pub text: String,
    /// Optional override; empty → [`DEFAULT_TRANSLATOR_BASE_URL`].
    #[serde(default)]
    pub translator_base_url: Option<String>,
    /// Frontend background-task id for byte-level download progress events.
    #[serde(default)]
    pub task_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperDownloadAssetsArgs {
    pub vault_path: String,
    /// Vault-relative paper folder, e.g. `papers/1706.03762`.
    pub path: String,
    /// Frontend background-task id for byte-level download progress events.
    #[serde(default)]
    pub task_id: Option<String>,
}

/// Per-file overrides when importing a local PDF (metadata confirm dialog).
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalPdfImportEntry {
    pub file_path: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub authors: Option<Vec<String>>,
    #[serde(default)]
    pub year: Option<i32>,
    /// Preferred folder id (slug); host still de-duplicates with `-2`/`-3`.
    #[serde(default)]
    pub id: Option<String>,
}

/// Stage a dropped PDF (path-less WKWebView drop) into `~/.agentero/import-tmp/`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageImportFileArgs {
    /// Original filename (used for stem + safe on-disk name).
    pub file_name: String,
    /// Standard base64 of PDF bytes (no `data:` prefix).
    pub content_base64: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageImportFileResult {
    /// Absolute path written on disk.
    pub path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportLocalPdfArgs {
    pub vault_path: String,
    /// Vault-relative parent, e.g. `papers` or `papers/nlp`.
    pub parent_dir: String,
    /// Absolute paths to local PDF files (picker). Ignored when `entries` is non-empty.
    #[serde(default)]
    pub file_paths: Vec<String>,
    /// Preferred: path + optional title/authors/year/id from the confirm dialog.
    #[serde(default)]
    pub entries: Vec<LocalPdfImportEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportLocalPdfResult {
    /// One entry per successfully imported PDF.
    pub papers: Vec<LookupImportResult>,
    /// `"<file>: <reason>"` for each file that failed to import.
    #[serde(default)]
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupImportResult {
    pub paper_dir: String,
    pub path: String,
    pub id: String,
    pub title: String,
    pub used_translator: bool,
    pub translator_base_url: String,
    /// Whether local PDF was present after import download attempt.
    #[serde(default)]
    pub pdf: bool,
    /// Whether local TeX was present after import download attempt.
    #[serde(default)]
    pub tex: bool,
    /// Whether PAPER.md was written (no-TeX liteparse path).
    #[serde(default)]
    pub paper_md: bool,
    /// Download / parse messages (for UI warnings).
    #[serde(default)]
    pub asset_messages: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupImportBatchArgs {
    pub vault_path: String,
    pub parent_dir: String,
    pub texts: Vec<String>,
    #[serde(default)]
    pub translator_base_url: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    /// Max concurrent imports; 0 or 1 means sequential.
    #[serde(default)]
    pub concurrency: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedImport {
    pub raw: String,
    pub kind: String,
    pub value: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupImportBatchResult {
    pub imported: Vec<LookupImportResult>,
    #[serde(default)]
    pub skipped: Vec<SkippedImport>,
    #[serde(default)]
    pub errors: Vec<String>,
}

pub async fn import_by_identifier(args: LookupImportArgs) -> Result<LookupImportResult, AppError> {
    import_by_identifier_with_progress(args, None).await
}

pub async fn import_by_identifier_with_progress(
    args: LookupImportArgs,
    app: Option<&tauri::AppHandle>,
) -> Result<LookupImportResult, AppError> {
    use crate::features::import::paper_import::{
        paper_commit, AssetsPolicy, DedupePolicy, PaperCommitOptions,
    };

    let vault = PathBuf::from(args.vault_path.trim());
    if !vault.is_dir() {
        return Err(AppError::message("vault path is not a directory"));
    }

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

    let commit = paper_commit(
        meta,
        PaperCommitOptions {
            vault: &vault,
            parent_dir: &args.parent_dir,
            dedupe: DedupePolicy::ByCatalogId,
            assets: AssetsPolicy::SyncDownload {
                cookies: None,
                progress: AssetProgressContext {
                    app,
                    task_id: args.task_id.as_deref(),
                },
            },
            translate_abstract: true,
            fresh_timestamps: false,
        },
    )
    .await?;

    Ok(LookupImportResult {
        paper_dir: commit.paper_dir,
        path: commit.path,
        id: commit.id,
        title: commit.title,
        used_translator,
        translator_base_url: base,
        pdf: commit.pdf,
        tex: commit.tex,
        paper_md: commit.paper_md,
        asset_messages: commit.asset_messages,
    })
}

/// Batch import multiple identifiers with deduplication.
/// Progress events are emitted under the same `task_id` so the frontend sees
/// a single background task for the whole batch.
pub async fn import_by_identifier_batch(
    args: LookupImportBatchArgs,
    app: Option<&tauri::AppHandle>,
) -> Result<LookupImportBatchResult, AppError> {
    let vault = PathBuf::from(args.vault_path.trim());
    if !vault.is_dir() {
        return Err(AppError::message("vault path is not a directory"));
    }

    let mut skipped: Vec<SkippedImport> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    let mut seen: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    // Phase 1: parse, deduplicate, and filter against existing catalog.
    let mut to_import: Vec<(String, LookupImportArgs)> = Vec::new();
    for raw in &args.texts {
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }
        let Some((kind, value)) = extract_primary_identifier(raw) else {
            errors.push(format!("{raw}: unrecognized identifier"));
            continue;
        };

        let kind_str = identifier_kind_str(kind);
        let dedup_key = format!("{kind_str}:{value}");
        if seen.contains_key(&dedup_key) {
            skipped.push(SkippedImport {
                raw: raw.to_string(),
                kind: kind_str,
                value: value.clone(),
                reason: "duplicate_in_batch".to_string(),
            });
            continue;
        }
        seen.insert(dedup_key.clone(), raw.to_string());

        // Check catalog for existing paper by canonical identifier.
        if let Some(column) = identifier_kind_column(kind) {
            match papers::find_by_identifier(&vault, column, &value) {
                Ok(Some(_record)) => {
                    skipped.push(SkippedImport {
                        raw: raw.to_string(),
                        kind: kind_str,
                        value: value.clone(),
                        reason: "already_in_library".to_string(),
                    });
                    continue;
                }
                Ok(None) => {}
                Err(e) => {
                    // Log but do not block import on catalog read failure.
                    log::warn!("catalog lookup failed for {value}: {e}");
                }
            }
        }

        to_import.push((
            raw.to_string(),
            LookupImportArgs {
                vault_path: args.vault_path.clone(),
                parent_dir: args.parent_dir.clone(),
                text: raw.to_string(),
                translator_base_url: args.translator_base_url.clone(),
                task_id: args.task_id.clone(),
            },
        ));
    }

    let total = to_import.len();
    if total == 0 {
        return Ok(LookupImportBatchResult {
            imported: Vec::new(),
            skipped,
            errors,
        });
    }

    // Phase 2: run imports with a concurrency limit and emit count progress.
    let concurrency = args.concurrency.unwrap_or(3).max(1);
    let imported = Arc::new(Mutex::new(Vec::new()));
    let counter = Arc::new(AtomicUsize::new(0));

    let stream = futures_util::stream::iter(to_import.into_iter().map(|(raw, single)| {
        let imported = imported.clone();
        let counter = counter.clone();
        let task_id = args.task_id.clone();
        async move {
            let result = import_by_identifier_with_progress(single, app).await;
            let done = counter.fetch_add(1, Ordering::SeqCst) + 1;
            emit_batch_progress(app, task_id.as_deref(), done, total);
            match result {
                Ok(r) => {
                    imported.lock().await.push(r);
                    Ok(())
                }
                Err(e) => Err(format!("{raw}: {e}")),
            }
        }
    }));

    let import_errors: Vec<String> = stream
        .buffer_unordered(concurrency)
        .filter_map(|r| async { r.err() })
        .collect()
        .await;

    errors.extend(import_errors);

    let imported = Arc::try_unwrap(imported)
        .expect("all import futures finished")
        .into_inner();

    Ok(LookupImportBatchResult {
        imported,
        skipped,
        errors,
    })
}

fn emit_batch_progress(
    app: Option<&tauri::AppHandle>,
    task_id: Option<&str>,
    current: usize,
    total: usize,
) {
    let (Some(app), Some(task_id)) = (app, task_id) else {
        return;
    };
    let progress = ((current as f64 / total.max(1) as f64) * 100.0).round() as u8;
    let _ = app.emit(
        "background-task:progress",
        AssetDownloadProgress {
            task_id: task_id.to_string(),
            phase: "import".to_string(),
            downloaded_bytes: 0,
            total_bytes: None,
            progress: Some(progress),
            current_count: Some(current),
            total_count: Some(total),
        },
    );
}

pub(crate) fn identifier_kind_str(kind: IdentifierKind) -> String {
    match kind {
        IdentifierKind::Doi => "doi",
        IdentifierKind::Isbn => "isbn",
        IdentifierKind::Arxiv => "arxiv",
        IdentifierKind::Pmid => "pmid",
        IdentifierKind::AdsBibcode => "ads",
        IdentifierKind::Url => "url",
    }
    .to_string()
}

pub(crate) fn identifier_kind_column(kind: IdentifierKind) -> Option<&'static str> {
    match kind {
        IdentifierKind::Arxiv => Some("arxiv_id"),
        IdentifierKind::Doi => Some("doi"),
        IdentifierKind::Isbn => Some("isbn"),
        IdentifierKind::Pmid => Some("pmid"),
        IdentifierKind::AdsBibcode => Some("id"),
        IdentifierKind::Url => None,
    }
}

/// On-demand download of PDF (+ arXiv LaTeX) for an existing paper folder.
pub async fn download_paper_assets(
    args: PaperDownloadAssetsArgs,
) -> Result<AssetDownloadResult, AppError> {
    download_paper_assets_with_progress(args, None).await
}

pub async fn download_paper_assets_with_progress(
    args: PaperDownloadAssetsArgs,
    app: Option<&tauri::AppHandle>,
) -> Result<AssetDownloadResult, AppError> {
    let vault = PathBuf::from(args.vault_path.trim());
    if !vault.is_dir() {
        return Err(AppError::message("vault path is not a directory"));
    }
    let path_rel = crate::core::fs::sanitize_vault_rel(&args.path)
        .map_err(|_| AppError::message("invalid paper path"))?;
    let paper_dir = vault.join(&path_rel);
    if !paper_dir.is_dir() {
        return Err(AppError::message("paper folder not found"));
    }

    let (id, arxiv_id, pdf_url, doi) = if let Ok(Some(row)) = papers::get_by_path(&vault, &path_rel)
    {
        (row.id, row.arxiv_id, row.pdf_url, row.doi)
    } else {
        // Fallback: folder name as id; treat as arXiv if it looks like one
        let name = paper_dir
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("paper")
            .to_string();
        let arxiv = parse::extract_arxiv_id(&name);
        let pdf = arxiv
            .as_ref()
            .map(|a| format!("https://arxiv.org/pdf/{}", a));
        (name, arxiv, pdf, None)
    };

    let mut result = ensure_paper_assets_with_progress(
        &paper_dir,
        &id,
        arxiv_id.as_deref(),
        pdf_url.as_deref(),
        doi.as_deref(),
        None,
        AssetProgressContext {
            app,
            task_id: args.task_id.as_deref(),
        },
    )
    .await?;

    // When TeX was downloaded into source/, record body_source = "latex" in catalog
    // so the frontend doesn't show "download TeX" even though source/ is lazy‑loaded.
    if result.tex {
        if let Ok(Some(mut row)) = papers::get_by_path(&vault, &path_rel) {
            let changed = row.body_source.as_deref() != Some("latex");
            if changed {
                row.body_source = Some("latex".to_string());
                row.body_quality = Some("high".to_string());
                row.updated_at =
                    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                let _ = papers::upsert_paper(&vault, &row);
            }
        }
    }

    // After download: no TeX + has PDF → liteparse PAPER.md
    let parse = crate::features::import::pdf_parse::maybe_generate_paper_md_after_download(
        &vault, &path_rel, &paper_dir,
    )
    .await;
    result.paper_md = parse.paper_md;
    for m in parse.messages {
        result.messages.push(m);
    }
    Ok(result)
}

/// Write drop payload bytes to `~/.agentero/import-tmp/<stamp>-<name>` and return the path.
/// Used when the webview cannot expose `File.path` (typical on macOS WKWebView).
pub fn stage_import_file(args: StageImportFileArgs) -> Result<StageImportFileResult, AppError> {
    use base64::Engine;

    let raw_name = args.file_name.trim();
    let name = if raw_name.is_empty() {
        "drop.pdf".to_string()
    } else {
        raw_name
            .chars()
            .map(|c| if c == '/' || c == '\\' { '_' } else { c })
            .collect::<String>()
    };
    if !name.to_ascii_lowercase().ends_with(".pdf") {
        return Err(AppError::message("not a PDF file"));
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(args.content_base64.trim())
        .map_err(|e| AppError::message(format!("invalid base64: {e}")))?;
    if bytes.is_empty() {
        return Err(AppError::message("empty file"));
    }
    // Soft cap ~80MB — UI import is for papers, not bulk archives.
    if bytes.len() > 80 * 1024 * 1024 {
        return Err(AppError::message("file too large to stage (max 80MB)"));
    }

    let home =
        dirs::home_dir().ok_or_else(|| AppError::message("cannot resolve home directory"))?;
    let dir = home.join(".agentero").join("import-tmp");
    fs::create_dir_all(&dir)?;
    let stamp = format!(
        "{}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    );
    let dest = dir.join(format!("{stamp}-{name}"));
    fs::write(&dest, bytes)?;
    Ok(StageImportFileResult {
        path: dest.to_string_lossy().to_string(),
    })
}

/// Import one or more local PDF files as paper folders (copy + catalog + liteparse).
/// Filename-derived title/id by default; optional per-file metadata overrides.
/// Each PDF becomes `{parent}/{slug}/{slug}.pdf`.
pub async fn import_local_pdfs(args: ImportLocalPdfArgs) -> Result<ImportLocalPdfResult, AppError> {
    let vault = PathBuf::from(args.vault_path.trim());
    if !vault.is_dir() {
        return Err(AppError::message("vault path is not a directory"));
    }
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
        match import_one_local_pdf(&vault, &parent_rel, entry).await {
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
    // All failed → surface as an error; partial success returns per-file errors.
    if papers_out.is_empty() && !errors.is_empty() {
        return Err(AppError::message(errors.join("; ")));
    }
    Ok(ImportLocalPdfResult {
        papers: papers_out,
        errors,
    })
}

async fn import_one_local_pdf(
    vault: &Path,
    parent_rel: &str,
    entry: &LocalPdfImportEntry,
) -> Result<LookupImportResult, AppError> {
    use crate::features::import::paper_import::{
        paper_commit, AssetsPolicy, DedupePolicy, PaperCommitOptions,
    };

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

    let mut meta = local_pdf_meta(base_id, title);
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

    let commit = paper_commit(
        meta,
        PaperCommitOptions {
            vault,
            parent_dir: parent_rel,
            dedupe: DedupePolicy::None,
            assets: AssetsPolicy::CopyPdf { src: &src },
            translate_abstract: true,
            fresh_timestamps: false,
        },
    )
    .await?;

    Ok(LookupImportResult {
        paper_dir: commit.paper_dir,
        path: commit.path,
        id: commit.id,
        title: commit.title,
        used_translator: false,
        translator_base_url: String::new(),
        pdf: commit.pdf,
        tex: commit.tex,
        paper_md: commit.paper_md,
        asset_messages: commit.asset_messages,
    })
}

/// Folder-safe slug from a filename stem (alphanumerics + dots; other runs → `-`).
pub(crate) fn slug_from_stem(stem: &str) -> String {
    let mut s = String::new();
    let mut prev_sep = true; // suppress leading separators
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

/// Human title from a filename stem (underscores → spaces, whitespace collapsed).
pub(crate) fn title_from_stem(stem: &str) -> String {
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

/// Allocate a free `{parent}/{id}` paper folder, suffixing `-2`, `-3`, … on
/// collision. A path counts as taken when the folder exists on disk **or** the
/// catalog has a row for it (folder may have been deleted externally).
/// Returns `(id, path_rel, absolute_dir)` — callers must adopt the returned id
/// into `meta.id` so folder name and catalog id never diverge.
pub(crate) fn allocate_paper_path(
    vault: &Path,
    parent_rel: &str,
    base_id: &str,
) -> (String, String, PathBuf) {
    let taken = |path_rel: &str| -> bool {
        vault.join(path_rel).exists() || matches!(papers::get_by_path(vault, path_rel), Ok(Some(_)))
    };
    let mut id = base_id.to_string();
    let mut n = 2;
    loop {
        let path_rel = format!("{parent_rel}/{id}").replace('\\', "/");
        if !taken(&path_rel) || n > 999 {
            let dir = vault.join(&path_rel);
            return (id, path_rel, dir);
        }
        id = format!("{base_id}-{n}");
        n += 1;
    }
}

pub(crate) async fn resolve_metadata(
    text: &str,
    translator_base: &str,
) -> Result<(PaperMeta, bool), AppError> {
    // Prefer Translator Runtime (placeholder URL)
    match translator_fetch(text, translator_base).await {
        Ok(meta) => Ok((meta, true)),
        Err(e) => {
            // Fall back for arXiv so local dev works without sidecar
            if let Some(aid) = parse::extract_arxiv_id(text) {
                let meta = fetch_arxiv_metadata(&aid).await?;
                Ok((meta, false))
            } else {
                Err(AppError::message(format!(
                    "translator unreachable at {translator_base} ({e}); only arXiv fallback is available without Runtime"
                )))
            }
        }
    }
}

async fn translator_fetch(text: &str, base: &str) -> Result<PaperMeta, AppError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("agentero-lookup/0.1 (+https://github.com/poco-ai/agentero)")
        .build()
        .map_err(|e| AppError::message(format!("http client: {e}")))?;

    let ident = extract_primary_identifier(text);
    let (endpoint, body) = match &ident {
        Some((IdentifierKind::Url, url)) => (format!("{base}/web"), url.clone()),
        Some((_, value)) => (format!("{base}/search"), value.clone()),
        None => {
            // Treat as search raw text / possible URL
            if text.starts_with("http://") || text.starts_with("https://") {
                (format!("{base}/web"), text.to_string())
            } else {
                (format!("{base}/search"), text.to_string())
            }
        }
    };

    let res = client
        .post(&endpoint)
        .header("Content-Type", "text/plain")
        .body(body)
        .send()
        .await
        .map_err(|e| AppError::message(format!("translator request failed: {e}")))?;

    let status = res.status();
    let bytes = res
        .bytes()
        .await
        .map_err(|e| AppError::message(format!("translator read body: {e}")))?;

    if status.as_u16() == 300 {
        return Err(AppError::message(
            "translator returned multiple choices; pick a single paper URL/id",
        ));
    }
    if !status.is_success() {
        let snippet = String::from_utf8_lossy(&bytes);
        let short: String = snippet.chars().take(200).collect();
        return Err(AppError::message(format!(
            "translator HTTP {status}: {short}"
        )));
    }

    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| AppError::message(format!("translator JSON: {e}")))?;

    let item = if value.is_array() {
        value
            .as_array()
            .and_then(|a| a.first())
            .cloned()
            .ok_or_else(|| AppError::message("translator returned empty items array"))?
    } else if value.is_object() {
        // Some servers return a single object
        value
    } else {
        return Err(AppError::message("unexpected translator response shape"));
    };

    map_zotero_item(&item)
}

async fn fetch_arxiv_metadata(arxiv_id: &str) -> Result<PaperMeta, AppError> {
    let bare = regex_lite_strip_version(arxiv_id);
    let api = format!(
        "https://export.arxiv.org/api/query?id_list={}",
        urlencoding_encode(&bare)
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("agentero-lookup/0.1")
        .build()
        .map_err(|e| AppError::message(format!("http client: {e}")))?;
    let xml = client
        .get(&api)
        .send()
        .await
        .map_err(|e| AppError::message(format!("arXiv API: {e}")))?
        .text()
        .await
        .map_err(|e| AppError::message(format!("arXiv body: {e}")))?;

    map::map_arxiv_atom(&xml, &bare)
}

fn regex_lite_strip_version(id: &str) -> String {
    let s = id
        .trim()
        .trim_start_matches("arXiv:")
        .trim_start_matches("arxiv:");
    // strip trailing vN
    if let Some(i) = s.rfind('v') {
        if s[i + 1..].chars().all(|c| c.is_ascii_digit()) && i > 0 {
            return s[..i].to_string();
        }
    }
    s.to_string()
}

fn urlencoding_encode(s: &str) -> String {
    // minimal encode for arxiv ids
    s.replace('/', "%2F")
}

pub(crate) fn paper_record_from_meta(path: &str, meta: &PaperMeta) -> PaperRecord {
    PaperRecord {
        path: path.replace('\\', "/"),
        id: meta.id.clone(),
        paper_type: meta.paper_type.clone(),
        title: meta.title.clone(),
        authors: meta.authors.clone(),
        creators: meta.creators.clone(),
        year: meta.year,
        date: meta.date.clone(),
        abstract_text: meta.abstract_text.clone(),
        tags: meta
            .tags
            .iter()
            .map(crate::features::catalog::papers::PaperTag::new)
            .collect(),
        arxiv_id: meta.arxiv_id.clone(),
        doi: meta.doi.clone(),
        isbn: meta.isbn.clone(),
        issn: meta.issn.clone(),
        pmid: meta.pmid.clone(),
        publication: meta.publication.clone(),
        volume: meta.volume.clone(),
        issue: meta.issue.clone(),
        pages: meta.pages.clone(),
        publisher: meta.publisher.clone(),
        place: meta.place.clone(),
        series: meta.series.clone(),
        language: meta.language.clone(),
        pdf_url: meta.pdf_url.clone(),
        html_url: meta.html_url.clone(),
        source_url: meta.source_url.clone(),
        body_source: None,
        body_quality: None,
        bibtex_key: meta.bibtex_key.clone(),
        citation_count: None,
        zotero_item_type: meta.zotero_item_type.clone(),
        meta_source: meta.meta_source.clone(),
        extra: meta.extra.clone(),
        summary: meta.summary.clone(),
        status: meta.status.clone(),
        is_read: false,
        added_at: meta.added_at.clone(),
        updated_at: meta.updated_at.clone(),
    }
}

/// Write `{paper}/NOTES.md` shell (title + optional abstract blockquote).
/// Abstract is shown in **Chinese** when free-MT succeeds (fallback: original text).
/// Catalog still stores the original `abstract_text`.
///
/// Annotations live in `{paper}/marks/*.json` at runtime (not part of the shell).
pub(crate) async fn write_paper_shell(paper_dir: &Path, meta: &PaperMeta) -> Result<(), AppError> {
    write_paper_shell_opts(paper_dir, meta, true).await
}

/// Same as [`write_paper_shell`], with optional abstract MT.
/// Connector saves must stay under the browser extension's ~15s timeout, so they
/// pass `translate_abstract = false` and fetch assets asynchronously.
pub(crate) async fn write_paper_shell_opts(
    paper_dir: &Path,
    meta: &PaperMeta,
    translate_abstract: bool,
) -> Result<(), AppError> {
    let abstract_block = match meta
        .abstract_text
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(a) => {
            let display = if translate_abstract {
                abstract_for_notes(a).await
            } else {
                a.to_string()
            };
            format!("> {display}\n\n")
        }
        None => String::new(),
    };
    let notes = format!("# {}\n\n{abstract_block}", meta.title);
    fs::write(paper_dir.join("NOTES.md"), notes)?;
    Ok(())
}

/// Prefer zh-CN translation of the abstract for NOTES.md display.
/// Falls back to the original text when every free engine fails.
async fn abstract_for_notes(text: &str) -> String {
    use crate::features::translate::{free_mt_to_zh, looks_mostly_cjk};
    if looks_mostly_cjk(text) {
        return text.to_string();
    }
    free_mt_to_zh(text)
        .await
        .unwrap_or_else(|| text.to_string())
}

pub(crate) fn normalize_parent_dir(raw: &str) -> Result<String, AppError> {
    let s = raw.trim().replace('\\', "/").trim_matches('/').to_string();
    if s.is_empty() {
        return Ok("papers".into());
    }
    if s == "papers" || s.starts_with("papers/") {
        // reject path traversal
        if s.split('/').any(|p| p == ".." || p.is_empty()) {
            return Err(AppError::message("invalid parent_dir"));
        }
        return Ok(s);
    }
    Err(AppError::message(
        "parent_dir must be papers or under papers/",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_from_stem_basic() {
        assert_eq!(
            slug_from_stem("Attention Is All You Need"),
            "Attention-Is-All-You-Need"
        );
        assert_eq!(
            slug_from_stem("vaswani_2017_attention"),
            "vaswani-2017-attention"
        );
        assert_eq!(slug_from_stem("1706.03762"), "1706.03762");
        assert_eq!(slug_from_stem("  spaced  "), "spaced");
        assert_eq!(slug_from_stem("!!!"), "paper");
    }

    #[test]
    fn title_from_stem_basic() {
        assert_eq!(
            title_from_stem("vaswani_2017_attention"),
            "vaswani 2017 attention"
        );
        assert_eq!(title_from_stem("  Hello   World  "), "Hello World");
        assert_eq!(title_from_stem("   "), "Untitled");
    }

    #[test]
    fn allocate_paper_path_free_and_collision() {
        let vault = std::env::temp_dir().join(format!(
            "agentero-alloc-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(vault.join("papers")).unwrap();

        // Free path → base id unchanged.
        let (id, rel, dir) = allocate_paper_path(&vault, "papers", "1706.03762");
        assert_eq!(id, "1706.03762");
        assert_eq!(rel, "papers/1706.03762");
        assert_eq!(dir, vault.join("papers/1706.03762"));

        // Folder on disk → suffix -2, and returned id matches the folder name.
        fs::create_dir_all(vault.join("papers/1706.03762")).unwrap();
        let (id, rel, _) = allocate_paper_path(&vault, "papers", "1706.03762");
        assert_eq!(id, "1706.03762-2");
        assert_eq!(rel, "papers/1706.03762-2");

        let _ = fs::remove_dir_all(&vault);
    }
}
