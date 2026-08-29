//! Paper import: identifier lookup, Translator, Zotero migrate, local PDF, PAPER.md parse.
//!
//! @see docs/backend/identifier-lookup.md
//! @see docs/backend/paper-import-pipeline.md

#[cfg(feature = "desktop")]
pub mod commands;
#[cfg(feature = "desktop")]
pub mod job_runners;
pub mod paper_import;
pub mod pdf_parse;

mod assets;
pub(crate) mod batch;
pub(crate) mod map;
pub(crate) mod parse;
pub(crate) mod pdf_recognize;
pub(crate) mod recognize_apply;
pub(crate) mod resolver;
mod skill_import;
pub(crate) mod title_search;

pub use crate::features::catalog::{has_local_pdf, has_local_tex};
pub use assets::{
    ensure_paper_assets, ensure_paper_assets_with_cookies, ensure_paper_assets_with_progress,
    AssetDownloadResult, AssetProgressContext,
};
pub use map::{enrich_remote_urls, map_zotero_item, PaperMeta};
pub use skill_import::{
    discard_skill_discovery, discover_skill_source, install_discovered_skills, SkillCandidate,
    SkillDiscovery, SkillImportResult,
};
pub use title_search::{PaperSearchCandidate, PaperSearchGroup};

// Stable top-level API for the remote import bridge (`remote/import_bridge.rs`)
// and the Zotero feature (`features/zotero/io.rs`). Other features must depend
// on these re-exports, not reach into the `batch` / `parse` / `map` internals.
#[cfg(feature = "desktop")]
pub(crate) use batch::{preflight_identifier_batch, SkillBatchMode};
#[cfg(feature = "desktop")]
pub(crate) use map::doi_slug;
pub(crate) use parse::extract_arxiv_id;
#[cfg(feature = "desktop")]
pub(crate) use parse::strip_arxiv_version;
// pdf_parse surface consumed by other features (layout_remote compares the
// cancellation message; settings/app refresh the engine config snapshot).
#[cfg(all(
    feature = "desktop",
    not(any(target_os = "ios", target_os = "android"))
))]
pub use pdf_parse::engines::refresh_parser_config;
#[cfg(feature = "desktop")]
pub(crate) use pdf_parse::CANCELLED_MESSAGE;

#[cfg(not(feature = "desktop"))]
use crate::core::app_handle::AppHandle;
use crate::core::error::AppError;
use crate::features::catalog::{
    papers::{self, PaperRecord},
    CapsCache,
};
#[cfg(feature = "desktop")]
use crate::features::import::assets::AssetDownloadProgress;
use futures_util::StreamExt;
use map::local_pdf_meta;
use parse::extract_primary_identifier;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

/// Public helper for remote PDF import staging.
#[cfg_attr(not(feature = "desktop"), allow(dead_code))]
pub(crate) fn local_pdf_meta_for_import(id: String, title: String) -> PaperMeta {
    local_pdf_meta(id, title)
}

/// Default Translator Runtime base URL (hosted service).
/// Override via Settings → `translatorBaseUrl` / `LookupImportArgs.translator_base_url`.
pub const DEFAULT_TRANSLATOR_BASE_URL: &str = "https://translator.philfan.cn";

/// Upper bound for the network asset phase of one paper import.
///
/// Individual requests have shorter reqwest timeouts, but an import may try
/// several PDF fallbacks before fetching the arXiv source. Keep the whole
/// phase bounded so one paper cannot hold an import task indefinitely.
pub const PAPER_ASSET_TIMEOUT: Duration = Duration::from_secs(3 * 60);

pub(crate) fn check_task_not_cancelled(task_id: Option<&str>) -> Result<(), AppError> {
    if task_id.is_some_and(is_background_task_cancelled) {
        return Err(AppError::message("background task cancelled"));
    }
    Ok(())
}

pub(crate) fn is_background_task_cancelled(task_id: &str) -> bool {
    crate::core::background_tasks::is_cancelled(task_id)
}

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

/// Bibliography file (BibTeX / RIS / …) import via Translator `/import`.
/// Consumed by `features/zotero` (`import_catalog`) and the remote bridge.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperImportArgs {
    pub vault_path: String,
    /// Vault-relative parent, e.g. `papers`.
    #[serde(default)]
    pub parent_dir: Option<String>,
    /// Raw file contents (BibTeX, RIS, …).
    pub content: String,
    #[serde(default)]
    pub translator_base_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperImportResult {
    pub imported: usize,
    pub skipped: usize,
    pub paths: Vec<String>,
    pub titles: Vec<String>,
    pub errors: Vec<String>,
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
    #[serde(default)]
    pub doi: Option<String>,
    #[serde(default)]
    pub arxiv_id: Option<String>,
    /// Structured fields fetched via identifier resolution in the dialog
    /// (publication/volume/issue/pages/abstract/…). Applied only when present.
    #[serde(default)]
    pub extra: Option<LocalPdfExtraMeta>,
}

/// Non-editable structured metadata carried from the confirm dialog's
/// identifier fetch into the catalog row.
#[derive(Debug, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct LocalPdfExtraMeta {
    #[serde(default)]
    pub publication: Option<String>,
    #[serde(default)]
    pub volume: Option<String>,
    #[serde(default)]
    pub issue: Option<String>,
    #[serde(default)]
    pub pages: Option<String>,
    #[serde(default)]
    pub publisher: Option<String>,
    #[serde(default)]
    pub issn: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(rename = "abstract", default)]
    pub abstract_text: Option<String>,
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
    /// Preferred: path + optional title/authors/year/identifiers from the confirm dialog.
    #[serde(default)]
    pub entries: Vec<LocalPdfImportEntry>,
    /// Frontend background-task id for parse-phase progress.
    #[serde(default)]
    pub task_id: Option<String>,
    /// Translator base URL override. Deferred recognition runs in the
    /// RecognizeMetadata job, which reads Settings directly; kept for API
    /// compatibility. Empty → default.
    #[serde(default)]
    pub translator_base_url: Option<String>,
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
    /// `Deduped` when the paper already existed and (for local PDFs) the PDF
    /// was merged into the existing entry instead of creating a duplicate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<paper_import::CommitStatus>,
    /// Local PDF imported with placeholder metadata; a RecognizeMetadata job
    /// is resolving real metadata in the background (and will rename the
    /// folder to the canonical id). The frontend must not enqueue its own
    /// layout analysis — the runner owns the follow-ups.
    #[serde(default)]
    pub recognize_pending: bool,
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
    pub skills: Vec<SkillImportResult>,
    #[serde(default)]
    pub skill_candidates: Vec<SkillDiscovery>,
    /// Free-text inputs resolved to importable candidates awaiting user choice.
    #[serde(default)]
    pub search_candidates: Vec<PaperSearchGroup>,
    #[serde(default)]
    pub skipped: Vec<SkippedImport>,
    #[serde(default)]
    pub errors: Vec<String>,
}

pub async fn import_by_identifier(args: LookupImportArgs) -> Result<LookupImportResult, AppError> {
    // Headless entry (CLI): no settings store wiring, keep the default shell.
    import_by_identifier_with_progress(args, None, None, NoteShellMode::Standard).await
}

pub async fn import_by_identifier_with_progress(
    args: LookupImportArgs,
    app: Option<&AppHandle>,
    cache: Option<&CapsCache>,
    note_mode: NoteShellMode,
) -> Result<LookupImportResult, AppError> {
    use crate::features::import::paper_import::{
        paper_commit, AssetsPolicy, DedupePolicy, PaperCommitOptions,
    };

    let vault = crate::core::fs::resolve_vault(&args.vault_path)?;

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

    check_task_not_cancelled(args.task_id.as_deref())?;
    let (mut meta, used_translator) =
        resolve_metadata(text, &base, args.task_id.as_deref()).await?;
    check_task_not_cancelled(args.task_id.as_deref())?;
    enrich_remote_urls(&mut meta);

    let commit = paper_commit(
        meta,
        PaperCommitOptions {
            vault: &vault,
            parent_dir: &args.parent_dir,
            dedupe: DedupePolicy::ByIdentifiers,
            assets: AssetsPolicy::SyncDownload {
                cookies: None,
                progress: AssetProgressContext {
                    app,
                    task_id: args.task_id.as_deref(),
                },
            },
            translate_abstract: true,
            note_mode,
            fresh_timestamps: false,
            cache,
            app,
            defer_parse_jobs: false,
        },
    )
    .await?;
    check_task_not_cancelled(args.task_id.as_deref())?;

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
        status: Some(commit.status),
        recognize_pending: false,
    })
}

/// Batch import multiple identifiers with deduplication.
/// Progress events are emitted under the same `task_id` so the frontend sees
/// a single background task for the whole batch.
pub async fn import_by_identifier_batch(
    args: LookupImportBatchArgs,
    app: Option<&AppHandle>,
    cache: Option<&CapsCache>,
    note_mode: NoteShellMode,
) -> Result<LookupImportBatchResult, AppError> {
    let vault = crate::core::fs::resolve_vault(&args.vault_path)?;

    let skills: Vec<SkillImportResult> = Vec::new();
    let mut skill_candidates: Vec<SkillDiscovery> = Vec::new();
    let mut preflight = batch::preflight_identifier_batch(
        &args.texts,
        &vault,
        batch::SkillBatchMode::Collect,
        false,
    );

    for pending in &preflight.skills {
        match discover_skill_source(&vault, &pending.source, app, args.task_id.as_deref()).await {
            Ok(discovery) => skill_candidates.push(discovery),
            Err(e) => preflight.errors.push(format!("{}: {e}", pending.raw)),
        }
    }

    let search_candidates = resolve_search_queries(&preflight.queries, &mut preflight.errors).await;

    let to_import: Vec<(String, LookupImportArgs)> = preflight
        .papers
        .into_iter()
        .map(|pending| {
            let raw = pending.raw;
            (
                raw.clone(),
                LookupImportArgs {
                    vault_path: args.vault_path.clone(),
                    parent_dir: args.parent_dir.clone(),
                    text: raw,
                    translator_base_url: args.translator_base_url.clone(),
                    task_id: args.task_id.clone(),
                },
            )
        })
        .collect();
    let skipped = preflight.skipped;
    let mut errors = preflight.errors;

    let total = to_import.len();
    if total == 0 {
        return Ok(LookupImportBatchResult {
            imported: Vec::new(),
            skills,
            skill_candidates,
            search_candidates,
            skipped,
            errors,
        });
    }

    // Phase 2: run imports with a concurrency limit and emit count progress.
    let concurrency = args.concurrency.unwrap_or(5).max(1);
    let imported = Arc::new(Mutex::new(Vec::new()));
    let counter = Arc::new(AtomicUsize::new(0));

    let stream = futures_util::stream::iter(to_import.into_iter().map(|(raw, single)| {
        let imported = imported.clone();
        let counter = counter.clone();
        let task_id = args.task_id.clone();
        async move {
            let result = import_by_identifier_with_progress(single, app, cache, note_mode).await;
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
        skills,
        skill_candidates,
        search_candidates,
        skipped,
        errors,
    })
}

/// Top-N candidates shown in the magic-wand picker.
const SEARCH_CANDIDATE_LIMIT: usize = 3;

/// Resolve free-text queries to importable candidates. Empty results and search
/// failures become errors so a title that matches nothing is never a silent no-op.
pub(crate) async fn resolve_search_queries(
    queries: &[String],
    errors: &mut Vec<String>,
) -> Vec<PaperSearchGroup> {
    let mut groups = Vec::new();
    for query in queries {
        match title_search::search_papers(query, SEARCH_CANDIDATE_LIMIT).await {
            Ok(candidates) if candidates.is_empty() => {
                errors.push(format!("{query}: no search results"));
            }
            Ok(candidates) => groups.push(PaperSearchGroup {
                query: query.clone(),
                candidates,
            }),
            Err(e) => errors.push(format!("{query}: {e}")),
        }
    }
    groups
}

fn emit_batch_progress(
    app: Option<&AppHandle>,
    task_id: Option<&str>,
    current: usize,
    total: usize,
) {
    #[cfg(not(feature = "desktop"))]
    let _ = (app, task_id, current, total);
    #[cfg(feature = "desktop")]
    {
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
}

/// On-demand download of PDF (+ arXiv LaTeX) for an existing paper folder.
pub async fn download_paper_assets(
    args: PaperDownloadAssetsArgs,
) -> Result<AssetDownloadResult, AppError> {
    download_paper_assets_with_progress(args, None, None).await
}

pub async fn download_paper_assets_with_progress(
    args: PaperDownloadAssetsArgs,
    app: Option<&AppHandle>,
    cache: Option<&CapsCache>,
) -> Result<AssetDownloadResult, AppError> {
    let vault = crate::core::fs::resolve_vault(&args.vault_path)?;
    let (paper_dir, path_rel) = crate::core::fs::resolve_paper_dir(&vault, &args.path)?;

    let (id, arxiv_id, pdf_url, doi) = if let Ok(Some(row)) = papers::get_by_path(&vault, &path_rel)
    {
        (row.id, row.arxiv_id, row.pdf_url, row.doi)
    } else if let Ok(Some(row)) = papers::ensure_row_for_path(&vault, &path_rel) {
        // Orphaned folder (import failed after shell + folder were written but
        // before the catalog row landed): rebuild the row so the Library sees it.
        crate::features::lifecycle::emit_paper_imported(app, &vault, &row.id);
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

    let result = ensure_paper_assets_with_progress(
        &paper_dir,
        &vault,
        &path_rel,
        &id,
        arxiv_id.as_deref(),
        pdf_url.as_deref(),
        doi.as_deref(),
        None,
        cache,
        AssetProgressContext {
            app,
            task_id: args.task_id.as_deref(),
        },
    )
    .await?;
    check_task_not_cancelled(args.task_id.as_deref())?;

    // When TeX was downloaded into source/, record body_source = "latex" in catalog
    // so the frontend doesn't show "download TeX" even though source/ is lazy‑loaded.
    if result.tex {
        if let Ok(Some(mut row)) = papers::get_by_path(&vault, &path_rel) {
            let changed = row.body_source.as_deref() != Some("latex");
            if changed {
                row.body_source = Some("latex".to_string());
                row.body_quality = Some("high".to_string());
                row.updated_at = crate::core::time::now_rfc3339_millis();
                let _ = papers::upsert_paper(&vault, &row);
            }
        }
    }

    if result.pdf && !result.tex && !result.paper_md {
        #[cfg(feature = "desktop")]
        crate::features::jobs::spawn_parse_body_after_assets(app, &vault, &path_rel, false);
    }

    crate::features::refs::spawn_parse_after_import(app, &vault, &path_rel);
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
pub async fn import_local_pdfs(
    args: ImportLocalPdfArgs,
    app: Option<&AppHandle>,
    cache: Option<&CapsCache>,
    note_mode: NoteShellMode,
) -> Result<ImportLocalPdfResult, AppError> {
    let vault = crate::core::fs::resolve_vault(&args.vault_path)?;
    let parent_rel = normalize_parent_dir(&args.parent_dir)?;

    let task_id = args.task_id.clone();
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
    let entries = dedupe_local_pdf_entries(entries);

    let mut papers_out = Vec::new();
    let mut errors = Vec::new();
    for entry in &entries {
        match import_one_local_pdf(
            &vault,
            &parent_rel,
            entry,
            &ImportLocalPdfContext {
                task_id: task_id.as_deref(),
                app,
                cache,
                note_mode,
            },
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
    // All failed → surface as an error; partial success returns per-file errors.
    if papers_out.is_empty() && !errors.is_empty() {
        return Err(AppError::message(errors.join("; ")));
    }
    Ok(ImportLocalPdfResult {
        papers: papers_out,
        errors,
    })
}

/// Drop repeated source files (same path spelled with `\` vs `/`, or Windows
/// case variants) so one drop/pick never commits the same PDF twice.
fn dedupe_local_pdf_entries(entries: Vec<LocalPdfImportEntry>) -> Vec<LocalPdfImportEntry> {
    let mut seen = std::collections::HashSet::new();
    entries
        .into_iter()
        .filter(|e| {
            let mut key = e.file_path.trim().replace('\\', "/");
            if cfg!(windows) {
                key = key.to_lowercase();
            }
            seen.insert(key)
        })
        .collect()
}

/// Shared per-import context threaded into `import_one_local_pdf`.
struct ImportLocalPdfContext<'a> {
    task_id: Option<&'a str>,
    app: Option<&'a AppHandle>,
    cache: Option<&'a CapsCache>,
    note_mode: NoteShellMode,
}

async fn import_one_local_pdf(
    vault: &Path,
    parent_rel: &str,
    entry: &LocalPdfImportEntry,
    ctx: &ImportLocalPdfContext<'_>,
) -> Result<LookupImportResult, AppError> {
    use crate::features::import::paper_import::{
        paper_commit, AssetsPolicy, CommitStatus, DedupePolicy, PaperCommitOptions,
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
                .map(map::doi_slug)
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| slug_from_stem(stem));

    let dialog_meta = entry.title.is_some()
        || entry.doi.is_some()
        || entry.arxiv_id.is_some()
        || entry.extra.is_some();

    // Entries straight from the picker/drop (no dialog metadata) commit
    // instantly with filename-derived metadata; a RecognizeMetadata job then
    // resolves DOI/arXiv/title in the background and renames the folder to
    // the canonical id (see `recognize_apply`). Best-effort: any recognition
    // failure keeps the filename-derived metadata.
    let recognize_deferred = !dialog_meta;
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
    // Dialog-provided identifiers and fetched fields win over recognition
    // and filename defaults; the user confirmed them, so mark the row manual.
    let mut has_dialog_meta = false;
    if let Some(doi) = entry
        .doi
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        meta.doi = Some(doi.to_string());
        has_dialog_meta = true;
    }
    if let Some(arxiv) = entry
        .arxiv_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        meta.arxiv_id = Some(arxiv.to_string());
        has_dialog_meta = true;
    }
    if let Some(extra) = &entry.extra {
        if extra.publication.is_some()
            || extra.volume.is_some()
            || extra.issue.is_some()
            || extra.pages.is_some()
            || extra.abstract_text.is_some()
        {
            has_dialog_meta = true;
        }
        meta.publication = extra.publication.clone().filter(|s| !s.trim().is_empty());
        meta.volume = extra.volume.clone().filter(|s| !s.trim().is_empty());
        meta.issue = extra.issue.clone().filter(|s| !s.trim().is_empty());
        meta.pages = extra.pages.clone().filter(|s| !s.trim().is_empty());
        meta.publisher = extra.publisher.clone().filter(|s| !s.trim().is_empty());
        meta.issn = extra.issn.clone().filter(|s| !s.trim().is_empty());
        meta.language = extra.language.clone().filter(|s| !s.trim().is_empty());
        if let Some(date) = extra
            .date
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            meta.date = Some(date.to_string());
            if meta.year.is_none() {
                meta.year = date.chars().take(4).collect::<String>().parse().ok();
            }
        }
        meta.abstract_text = extra.abstract_text.clone().filter(|s| !s.trim().is_empty());
    }
    if has_dialog_meta {
        meta.meta_source = Some("manual".into());
    }

    let progress = AssetProgressContext {
        app: ctx.app,
        task_id: ctx.task_id,
    };
    let commit = paper_commit(
        meta,
        PaperCommitOptions {
            vault,
            parent_dir: parent_rel,
            dedupe: DedupePolicy::ByIdentifiers,
            assets: AssetsPolicy::CopyPdf {
                src: &src,
                progress,
            },
            translate_abstract: true,
            note_mode: ctx.note_mode,
            fresh_timestamps: false,
            cache: ctx.cache,
            app: ctx.app,
            // Parse/refs/layout follow-ups are orchestrated by the
            // RecognizeMetadata runner once the final path is known.
            defer_parse_jobs: recognize_deferred,
        },
    )
    .await?;

    let recognize_pending = recognize_deferred && commit.status == CommitStatus::Created;
    if recognize_pending {
        #[cfg(feature = "desktop")]
        crate::features::jobs::spawn_recognize_metadata(ctx.app, vault, &commit.path);
    }

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
        status: Some(commit.status),
        recognize_pending,
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
    task_id: Option<&str>,
) -> Result<(PaperMeta, bool), AppError> {
    // Prefer Translator Runtime (placeholder URL)
    match translator_fetch(text, translator_base, task_id).await {
        Ok(meta) => {
            check_task_not_cancelled(task_id)?;
            Ok((meta, true))
        }
        Err(e) => {
            // Direct-connect fallbacks from the resolver table (arXiv Atom,
            // DOI → Crossref) so local dev works without the Runtime sidecar.
            match resolver::fetch_direct_fallback(text, task_id).await {
                Some(Ok(meta)) => {
                    check_task_not_cancelled(task_id)?;
                    Ok((meta, false))
                }
                Some(Err(err)) => Err(err),
                None => Err(AppError::message(format!(
                    "translator unreachable at {translator_base} ({e}); only arXiv/Crossref fallbacks are available without Runtime"
                ))),
            }
        }
    }
}

async fn translator_fetch(
    text: &str,
    base: &str,
    task_id: Option<&str>,
) -> Result<PaperMeta, AppError> {
    let client = crate::core::http::client_builder()
        .timeout(Duration::from_secs(30))
        .user_agent("agentero-lookup/0.1 (+https://github.com/poco-ai/agentero)")
        .build()
        .map_err(|e| AppError::message(format!("http client: {e}")))?;

    let (endpoint, body) = translator_request(text, base);

    let res = client
        .post(&endpoint)
        .header("Content-Type", "text/plain")
        .body(body)
        .send()
        .await
        .map_err(|e| AppError::message(format!("translator request failed: {e}")))?;
    check_task_not_cancelled(task_id)?;

    let status = res.status();
    let bytes = res
        .bytes()
        .await
        .map_err(|e| AppError::message(format!("translator read body: {e}")))?;
    check_task_not_cancelled(task_id)?;

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

/// Build a Translator Runtime request from an identifier.
///
/// arXiv's PDF endpoints are binary resources, which the Translator Runtime
/// cannot parse as web pages. Canonicalizing every recognized arXiv form to
/// its abstract page (the arXiv resolver's target) also gives direct IDs and
/// URLs the same metadata path — so it runs ahead of the generic table probe,
/// where arXiv URLs would classify as `url`.
fn translator_request(text: &str, base: &str) -> (String, String) {
    if let Some(arxiv_id) = parse::extract_arxiv_id(text) {
        return resolver::find(resolver::ARXIV_KIND)
            .expect("arxiv resolver is registered")
            .translator_target(&arxiv_id, base);
    }

    let ident = extract_primary_identifier(text);
    match ident {
        Some(ident) => resolver::find(ident.kind)
            .map(|r| r.translator_target(&ident.value, base))
            .unwrap_or_else(|| (format!("{base}/search"), ident.value.clone())),
        None => {
            // Treat as search raw text / possible URL.
            if text.starts_with("http://") || text.starts_with("https://") {
                (format!("{base}/web"), text.to_string())
            } else {
                (format!("{base}/search"), text.to_string())
            }
        }
    }
}

/// Resolve the Translator Runtime base URL: non-empty override wins, else the
/// hosted default; trailing slash stripped.
fn translator_base(override_url: Option<&str>) -> String {
    override_url
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_TRANSLATOR_BASE_URL)
        .trim_end_matches('/')
        .to_string()
}

/// Fetch Zotero-shaped items from Translator `/import` (used by local + remote
/// vault bibliography import; the Zotero feature and the remote bridge both
/// go through this stable entry point).
pub(crate) async fn translator_import_items(
    content: &str,
    translator_base_url: Option<&str>,
) -> Result<Vec<serde_json::Value>, AppError> {
    let base = translator_base(translator_base_url);
    translator_import(content, &base).await
}

async fn translator_import(content: &str, base: &str) -> Result<Vec<serde_json::Value>, AppError> {
    let client =
        crate::core::http::client_with(Duration::from_secs(60), 10, crate::core::http::USER_AGENT)?;
    let url = format!("{base}/import");
    let res = client
        .post(&url)
        .header("Content-Type", "text/plain")
        .body(content.to_string())
        .send()
        .await
        .map_err(|e| AppError::message(format!("translator import: {e}")))?;

    let status = res.status();
    let bytes = res
        .bytes()
        .await
        .map_err(|e| AppError::message(format!("import body: {e}")))?;
    if !status.is_success() {
        let snippet = String::from_utf8_lossy(&bytes);
        let short: String = snippet.chars().take(200).collect();
        return Err(AppError::message(format!(
            "translator import HTTP {status}: {short}"
        )));
    }

    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| AppError::message(format!("import JSON: {e}")))?;

    let arr = if value.is_array() {
        value
            .as_array()
            .cloned()
            .ok_or_else(|| AppError::message("import returned empty array"))?
    } else if value.is_object() {
        // Some servers may return a single item
        vec![value]
    } else {
        return Err(AppError::message("unexpected import response shape"));
    };

    if arr.is_empty() {
        return Err(AppError::message("import returned no items"));
    }
    Ok(arr)
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
        zotero_item_id: None,
        zotero_last_synced: None,
        added_at: meta.added_at.clone(),
        updated_at: meta.updated_at.clone(),
    }
}

/// How the `NOTES.md` shell is generated on paper import (settings
/// `paperNoteMode`). Unknown values fall back to [`NoteShellMode::Standard`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoteShellMode {
    /// aliases frontmatter + `# title` + abstract blockquote (optional zh-CN MT).
    Standard,
    /// aliases frontmatter + `# title`, no abstract.
    TitleOnly,
    /// aliases frontmatter only; empty body.
    Blank,
    /// Render the vault template `.agentero/templates/NOTES.md`.
    Custom,
}

impl NoteShellMode {
    /// Parse the persisted settings value; unknown values → [`Self::Standard`].
    pub fn parse(raw: &str) -> Self {
        match raw.trim() {
            "title-only" => Self::TitleOnly,
            "blank" => Self::Blank,
            "custom" => Self::Custom,
            _ => Self::Standard,
        }
    }
}

/// Resolve the configured NOTES shell mode from the managed settings store.
#[cfg(feature = "desktop")]
pub fn note_mode_from_app(app: &tauri::AppHandle) -> NoteShellMode {
    use tauri::Manager;
    app.state::<crate::features::settings::AppSettingsStore>()
        .get()
        .map(|r| NoteShellMode::parse(&r.settings.paper_note_mode))
        .unwrap_or(NoteShellMode::Standard)
}

/// Starting template written by `notes_template_seed` (never overwrites).
pub const NOTES_TEMPLATE_SEED: &str = "---\n\
aliases:\n\
  - \"{{title}}\"\n\
---\n\
# {{title}}\n\
\n\
> {{abstract}}\n\
\n\
## Problem\n\
\n\
\n\
## Method\n\
\n\
\n\
## Results\n\
\n";

/// Seed `{vault}/.agentero/templates/NOTES.md` with [`NOTES_TEMPLATE_SEED`].
/// Returns `true` only when the file was created; an existing template is
/// never touched.
pub fn seed_notes_template(vault_root: &Path) -> Result<bool, AppError> {
    let path = vault_root
        .join(".agentero")
        .join("templates")
        .join("NOTES.md");
    if path.is_file() {
        return Ok(false);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, NOTES_TEMPLATE_SEED)?;
    Ok(true)
}

/// Title + deterministic short alias for the NOTES frontmatter.
fn paper_shell_aliases(meta: &PaperMeta) -> Vec<String> {
    let mut aliases = vec![meta.title.clone()];
    if let Some(short) =
        crate::features::doctor::suggest_short_alias(&meta.title, &meta.authors, meta.year)
    {
        aliases.push(short);
    }
    aliases
}

/// Write `{paper}/NOTES.md` shell (title + optional abstract blockquote).
/// Abstract is shown in **Chinese** when free-MT race succeeds; when every engine
/// fails the blockquote is omitted (no English stand-in as "translation").
/// Catalog still stores the original `abstract_text`.
///
/// Annotations live in `{paper}/marks/*.json` at runtime (not part of the shell).
#[cfg_attr(not(feature = "desktop"), allow(dead_code))]
pub(crate) async fn write_paper_shell(
    paper_dir: &Path,
    vault_root: &Path,
    meta: &PaperMeta,
    mode: NoteShellMode,
) -> Result<(), AppError> {
    write_paper_shell_opts(paper_dir, vault_root, meta, mode, true).await
}

/// Same as [`write_paper_shell`], with optional abstract MT.
/// Connector saves must stay under the browser extension's ~15s timeout, so they
/// pass `translate_abstract = false` and fetch assets asynchronously.
pub(crate) async fn write_paper_shell_opts(
    paper_dir: &Path,
    vault_root: &Path,
    meta: &PaperMeta,
    mode: NoteShellMode,
    translate_abstract: bool,
) -> Result<(), AppError> {
    let aliases = paper_shell_aliases(meta);
    let notes = match mode {
        NoteShellMode::Blank => {
            crate::features::wiki::frontmatter::prepend_new_aliases("", &aliases)
                .map_err(AppError::message)?
        }
        NoteShellMode::TitleOnly => {
            let body = format!("# {}\n", meta.title);
            crate::features::wiki::frontmatter::prepend_new_aliases(&body, &aliases)
                .map_err(AppError::message)?
        }
        NoteShellMode::Custom => match custom_note_shell(vault_root, meta, &aliases).await {
            Some(notes) => notes,
            // Template missing/blank → fall through to the Standard shell.
            None => {
                let body = standard_note_body(meta, translate_abstract).await;
                crate::features::wiki::frontmatter::prepend_new_aliases(&body, &aliases)
                    .map_err(AppError::message)?
            }
        },
        NoteShellMode::Standard => {
            let body = standard_note_body(meta, translate_abstract).await;
            crate::features::wiki::frontmatter::prepend_new_aliases(&body, &aliases)
                .map_err(AppError::message)?
        }
    };
    fs::write(paper_dir.join("NOTES.md"), notes)?;
    Ok(())
}

/// Standard shell body: `# title` + optional abstract blockquote.
async fn standard_note_body(meta: &PaperMeta, translate_abstract: bool) -> String {
    let abstract_block = match meta
        .abstract_text
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(a) => {
            if translate_abstract {
                // Race free-MT engines; omit the blockquote when none succeed
                // (do not fall back to English as a "translation").
                match abstract_for_notes(a).await {
                    Some(display) => format!("> {display}\n\n"),
                    None => String::new(),
                }
            } else {
                format!("> {a}\n\n")
            }
        }
        None => String::new(),
    };
    format!("# {}\n\n{abstract_block}", meta.title)
}

/// Render the vault template `.agentero/templates/NOTES.md` for one paper.
/// `None` when the template file is missing or blank (caller falls back to
/// the Standard shell). The rendered document then gets the aliases
/// guarantee (a template without aliases gets title + short alias merged in).
async fn custom_note_shell(
    vault_root: &Path,
    meta: &PaperMeta,
    aliases: &[String],
) -> Option<String> {
    let path = vault_root
        .join(".agentero")
        .join("templates")
        .join("NOTES.md");
    let template = match fs::read_to_string(&path) {
        Ok(raw) if !raw.trim().is_empty() => raw,
        _ => {
            log::warn!(
                target: "agentero::import",
                "NOTES template missing or empty ({}); falling back to standard shell",
                path.display()
            );
            return None;
        }
    };
    Some(ensure_note_aliases(
        &render_note_template(&template, meta),
        aliases,
    ))
}

/// Substitute the known `{{var}}` placeholders; unknown ones stay verbatim.
/// Missing optional metadata renders as an empty string. `{{url}}` prefers
/// html_url, then source_url, then pdf_url. `{{abstract}}` is the original
/// text (no machine translation).
fn render_note_template(template: &str, meta: &PaperMeta) -> String {
    let authors = meta.authors.join(", ");
    let year = meta.year.map(|y| y.to_string()).unwrap_or_default();
    let url = meta
        .html_url
        .as_deref()
        .or(meta.source_url.as_deref())
        .or(meta.pdf_url.as_deref())
        .unwrap_or_default();
    template
        .replace("{{title}}", &meta.title)
        .replace("{{authors}}", &authors)
        .replace("{{year}}", &year)
        .replace("{{date}}", meta.date.as_deref().unwrap_or_default())
        .replace(
            "{{abstract}}",
            meta.abstract_text.as_deref().unwrap_or_default(),
        )
        .replace("{{arxiv_id}}", meta.arxiv_id.as_deref().unwrap_or_default())
        .replace("{{doi}}", meta.doi.as_deref().unwrap_or_default())
        .replace("{{url}}", url)
        .replace("{{id}}", &meta.id)
}

/// Aliases guarantee for a rendered (Custom) shell: when the frontmatter has
/// no aliases, merge in the title + short alias following the same logic as
/// `wiki::append_title_alias_best_effort`.
fn ensure_note_aliases(notes: &str, aliases: &[String]) -> String {
    use crate::features::wiki::frontmatter::{self as fm, AliasEdit};
    let inspection = fm::inspect_aliases(notes);
    if !inspection.aliases.is_empty() {
        return notes.to_string();
    }
    if matches!(inspection.edit, AliasEdit::Unsupported { .. }) {
        // Intentional exception: the frontmatter cannot be edited safely
        // (e.g. a missing closing fence), so the rendered note is kept
        // verbatim. Doctor diagnoses and repairs such notes; rewriting the
        // YAML here could corrupt user-authored templates.
        return notes.to_string();
    }
    let merged: Vec<String> = aliases
        .iter()
        .filter(|a| !a.trim().is_empty())
        .cloned()
        .collect();
    if merged.is_empty() {
        return notes.to_string();
    }
    let next = if merged.len() >= 2 {
        fm::patch_aliases(notes, &merged)
    } else if inspection.frontmatter_end == 0 {
        fm::prepend_new_aliases(notes, &merged)
    } else if let AliasEdit::Insert { offset } = inspection.edit {
        // Frontmatter exists but only the title alias is available and
        // `patch_aliases` requires two — insert the single alias directly
        // before the closing fence, mirroring the leniency of
        // `prepend_new_aliases` for freshly generated notes.
        insert_single_alias(notes, offset, &merged[0])
    } else {
        // An existing (empty) aliases property could not be replaced with a
        // single entry — leave the note for Doctor to surface.
        return notes.to_string();
    };
    next.unwrap_or_else(|_| notes.to_string())
}

/// Insert one `aliases` entry before the frontmatter closing fence, mirroring
/// the `AliasEdit::Insert` rendering of [`crate::features::wiki::frontmatter::patch_aliases`]
/// but without its two-alias minimum.
fn insert_single_alias(markdown: &str, offset: usize, alias: &str) -> Result<String, String> {
    let newline = if markdown.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let quoted = serde_json::to_string(alias.trim()).map_err(|error| error.to_string())?;
    let mut insert = format!("aliases:{newline}  - {quoted}{newline}");
    if offset > 0 && !markdown[..offset].ends_with(['\n', '\r']) {
        insert.insert_str(0, newline);
    }
    let mut out = markdown.to_string();
    out.insert_str(offset, &insert);
    Ok(out)
}

/// Prefer zh-CN translation of the abstract for NOTES.md display.
///
/// - Already mostly CJK → return original.
/// - Else race free-MT engines; `None` when every engine fails (caller omits
///   the abstract block — no untranslated fallback).
async fn abstract_for_notes(text: &str) -> Option<String> {
    use crate::features::translate::{free_mt_to_zh, looks_mostly_cjk};
    if looks_mostly_cjk(text) {
        return Some(text.to_string());
    }
    free_mt_to_zh(text).await
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
    fn dedupe_local_pdf_entries_mixed_separators() {
        let entry = |p: &str| LocalPdfImportEntry {
            file_path: p.to_string(),
            title: None,
            authors: None,
            year: None,
            doi: None,
            arxiv_id: None,
            extra: None,
        };
        let out = dedupe_local_pdf_entries(vec![
            entry(r"C:\Users\me\x.pdf"),
            entry("C:/Users/me/x.pdf"),
            entry("C:/Users/me/y.pdf"),
        ]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].file_path, r"C:\Users\me\x.pdf");
        assert_eq!(out[1].file_path, "C:/Users/me/y.pdf");
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

    #[test]
    fn translator_request_canonicalizes_arxiv_to_abs() {
        let base = "https://translator.example";

        for input in [
            "2508.05004",
            "arXiv:2508.05004v2",
            "https://arxiv.org/pdf/2508.05004",
            "https://arxiv.org/pdf/2508.05004.pdf?download=1",
            "https://arxiv.org/html/2508.05004",
        ] {
            assert_eq!(
                translator_request(input, base),
                (
                    "https://translator.example/web".to_string(),
                    "https://arxiv.org/abs/2508.05004".to_string(),
                ),
                "input: {input}"
            );
        }
    }

    fn note_shell_test_meta() -> PaperMeta {
        let mut meta = local_pdf_meta("1706.03762".into(), "Attention Is All You Need".into());
        meta.authors = vec!["Ashish Vaswani".into(), "Noam Shazeer".into()];
        meta.year = Some(2017);
        meta.date = Some("2017-06-12".into());
        meta.abstract_text = Some("The dominant sequence transduction models.".into());
        meta.arxiv_id = Some("1706.03762".into());
        meta.doi = Some("10.48550/arXiv.1706.03762".into());
        meta.html_url = Some("https://arxiv.org/abs/1706.03762".into());
        meta
    }

    fn note_shell_tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agentero-notes-{tag}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn note_shell_mode_parse() {
        assert_eq!(NoteShellMode::parse("standard"), NoteShellMode::Standard);
        assert_eq!(NoteShellMode::parse("title-only"), NoteShellMode::TitleOnly);
        assert_eq!(NoteShellMode::parse("blank"), NoteShellMode::Blank);
        assert_eq!(NoteShellMode::parse("custom"), NoteShellMode::Custom);
        assert_eq!(NoteShellMode::parse("bogus"), NoteShellMode::Standard);
        assert_eq!(NoteShellMode::parse(""), NoteShellMode::Standard);
    }

    #[tokio::test]
    async fn note_shell_standard_and_title_only() {
        let vault = note_shell_tmp_dir("std");
        let meta = note_shell_test_meta();

        let paper = vault.join("papers").join("standard");
        fs::create_dir_all(&paper).unwrap();
        write_paper_shell_opts(&paper, &vault, &meta, NoteShellMode::Standard, false)
            .await
            .unwrap();
        let content = fs::read_to_string(paper.join("NOTES.md")).unwrap();
        assert!(content.starts_with("---\naliases:\n"));
        assert!(content.contains("- \"Attention Is All You Need\""));
        assert!(content.contains("# Attention Is All You Need"));
        assert!(content.contains("> The dominant sequence transduction models."));

        let paper = vault.join("papers").join("title-only");
        fs::create_dir_all(&paper).unwrap();
        write_paper_shell_opts(&paper, &vault, &meta, NoteShellMode::TitleOnly, false)
            .await
            .unwrap();
        let content = fs::read_to_string(paper.join("NOTES.md")).unwrap();
        assert!(content.starts_with("---\naliases:\n"));
        assert!(content.contains("# Attention Is All You Need"));
        // Title-only must not carry the abstract blockquote.
        assert!(!content.contains("dominant sequence"));

        let _ = fs::remove_dir_all(&vault);
    }

    #[tokio::test]
    async fn note_shell_blank_is_frontmatter_only() {
        let vault = note_shell_tmp_dir("blank");
        let meta = note_shell_test_meta();
        let paper = vault.join("papers").join("blank");
        fs::create_dir_all(&paper).unwrap();

        write_paper_shell_opts(&paper, &vault, &meta, NoteShellMode::Blank, false)
            .await
            .unwrap();
        let content = fs::read_to_string(paper.join("NOTES.md")).unwrap();
        assert!(content.starts_with("---\naliases:\n"));
        assert!(content.ends_with("---\n"));
        // No body at all: no heading, no abstract.
        assert!(!content.contains("# "));
        assert!(!content.contains("dominant sequence"));
        let (_, aliases) = crate::features::wiki::frontmatter::parse_frontmatter_aliases(&content);
        assert!(aliases.contains(&"Attention Is All You Need".to_string()));

        let _ = fs::remove_dir_all(&vault);
    }

    #[tokio::test]
    async fn note_shell_custom_renders_variables() {
        let vault = note_shell_tmp_dir("custom-vars");
        let meta = note_shell_test_meta();
        let templates = vault.join(".agentero").join("templates");
        fs::create_dir_all(&templates).unwrap();
        fs::write(
            templates.join("NOTES.md"),
            "---\naliases:\n  - \"{{title}}\"\n---\n\
             # {{title}}\n\n\
             {{authors}} ({{year}}-{{date}}) {{id}}\n\
             arXiv {{arxiv_id}} doi {{doi}} url {{url}}\n\
             > {{abstract}}\n\n{{nope}} stays\n",
        )
        .unwrap();

        let paper = vault.join("papers").join("custom");
        fs::create_dir_all(&paper).unwrap();
        write_paper_shell_opts(&paper, &vault, &meta, NoteShellMode::Custom, false)
            .await
            .unwrap();
        let content = fs::read_to_string(paper.join("NOTES.md")).unwrap();
        assert!(content.contains("# Attention Is All You Need"));
        assert!(content.contains("Ashish Vaswani, Noam Shazeer (2017-2017-06-12) 1706.03762"));
        assert!(content.contains(
            "arXiv 1706.03762 doi 10.48550/arXiv.1706.03762 url https://arxiv.org/abs/1706.03762"
        ));
        // {{abstract}} renders the original text (no MT).
        assert!(content.contains("> The dominant sequence transduction models."));
        // Unknown placeholders stay verbatim.
        assert!(content.contains("{{nope}} stays"));
        // Template aliases are preserved (no duplicate frontmatter).
        let (_, aliases) = crate::features::wiki::frontmatter::parse_frontmatter_aliases(&content);
        assert_eq!(aliases, vec!["Attention Is All You Need".to_string()]);

        let _ = fs::remove_dir_all(&vault);
    }

    #[tokio::test]
    async fn note_shell_custom_adds_missing_aliases() {
        let vault = note_shell_tmp_dir("custom-aliases");
        let meta = note_shell_test_meta();
        let templates = vault.join(".agentero").join("templates");
        fs::create_dir_all(&templates).unwrap();
        fs::write(templates.join("NOTES.md"), "# {{title}}\n\nBody\n").unwrap();

        let paper = vault.join("papers").join("custom");
        fs::create_dir_all(&paper).unwrap();
        write_paper_shell_opts(&paper, &vault, &meta, NoteShellMode::Custom, false)
            .await
            .unwrap();
        let content = fs::read_to_string(paper.join("NOTES.md")).unwrap();
        // Frontmatter with title + short alias prepended ahead of the body.
        assert!(content.starts_with("---\naliases:\n"));
        let (_, aliases) = crate::features::wiki::frontmatter::parse_frontmatter_aliases(&content);
        assert!(aliases.contains(&"Attention Is All You Need".to_string()));
        assert!(aliases.len() >= 2, "short alias expected: {aliases:?}");
        assert!(content.contains("# Attention Is All You Need"));

        let _ = fs::remove_dir_all(&vault);
    }

    #[tokio::test]
    async fn note_shell_custom_missing_template_falls_back_standard() {
        let vault = note_shell_tmp_dir("custom-missing");
        let meta = note_shell_test_meta();
        let paper = vault.join("papers").join("custom");
        fs::create_dir_all(&paper).unwrap();

        write_paper_shell_opts(&paper, &vault, &meta, NoteShellMode::Custom, false)
            .await
            .unwrap();
        let content = fs::read_to_string(paper.join("NOTES.md")).unwrap();
        // Standard shell shape: aliases + title + abstract blockquote.
        assert!(content.starts_with("---\naliases:\n"));
        assert!(content.contains("# Attention Is All You Need"));
        assert!(content.contains("> The dominant sequence transduction models."));

        let _ = fs::remove_dir_all(&vault);
    }

    #[tokio::test]
    async fn note_shell_custom_inserts_single_alias_into_existing_frontmatter() {
        let vault = note_shell_tmp_dir("custom-insert");
        // No authors/year → suggest_short_alias returns None → title alias only.
        let meta = local_pdf_meta("2501.00001".into(), "Deep".into());
        let templates = vault.join(".agentero").join("templates");
        fs::create_dir_all(&templates).unwrap();
        // Frontmatter without aliases: the single title alias must be inserted
        // before the closing fence even though patch_aliases needs two.
        fs::write(
            templates.join("NOTES.md"),
            "---\ntags: [paper]\n---\n# {{title}}\n\nBody\n",
        )
        .unwrap();

        let paper = vault.join("papers").join("custom");
        fs::create_dir_all(&paper).unwrap();
        write_paper_shell_opts(&paper, &vault, &meta, NoteShellMode::Custom, false)
            .await
            .unwrap();
        let content = fs::read_to_string(paper.join("NOTES.md")).unwrap();
        assert_eq!(
            content,
            "---\ntags: [paper]\naliases:\n  - \"Deep\"\n---\n# Deep\n\nBody\n"
        );
        let (_, aliases) = crate::features::wiki::frontmatter::parse_frontmatter_aliases(&content);
        assert_eq!(aliases, vec!["Deep".to_string()]);

        let _ = fs::remove_dir_all(&vault);
    }

    #[tokio::test]
    async fn note_shell_custom_keeps_unsupported_frontmatter_verbatim() {
        let vault = note_shell_tmp_dir("custom-unsupported");
        let meta = note_shell_test_meta();
        let templates = vault.join(".agentero").join("templates");
        fs::create_dir_all(&templates).unwrap();
        // Unterminated frontmatter fence → AliasEdit::Unsupported: the
        // rendered note must be kept verbatim (Doctor surfaces it later).
        fs::write(
            templates.join("NOTES.md"),
            "---\naliases:\n  - Old\n# {{title}}\n",
        )
        .unwrap();

        let paper = vault.join("papers").join("custom");
        fs::create_dir_all(&paper).unwrap();
        write_paper_shell_opts(&paper, &vault, &meta, NoteShellMode::Custom, false)
            .await
            .unwrap();
        let content = fs::read_to_string(paper.join("NOTES.md")).unwrap();
        assert_eq!(
            content,
            "---\naliases:\n  - Old\n# Attention Is All You Need\n"
        );

        let _ = fs::remove_dir_all(&vault);
    }

    #[tokio::test]
    async fn note_shell_blank_single_title_alias_without_short() {
        let vault = note_shell_tmp_dir("blank-single");
        // No authors/year → suggest_short_alias returns None.
        let meta = local_pdf_meta("2501.00001".into(), "Deep".into());
        let paper = vault.join("papers").join("blank");
        fs::create_dir_all(&paper).unwrap();

        write_paper_shell_opts(&paper, &vault, &meta, NoteShellMode::Blank, false)
            .await
            .unwrap();
        let content = fs::read_to_string(paper.join("NOTES.md")).unwrap();
        assert_eq!(content, "---\naliases:\n  - \"Deep\"\n---\n");

        let _ = fs::remove_dir_all(&vault);
    }

    #[test]
    fn seed_notes_template_creates_once() {
        let vault = note_shell_tmp_dir("seed");
        let created = seed_notes_template(&vault).unwrap();
        assert!(created);
        let path = vault.join(".agentero").join("templates").join("NOTES.md");
        assert!(path.is_file());
        assert!(fs::read_to_string(&path).unwrap().contains("{{title}}"));

        // Existing template is never overwritten.
        fs::write(&path, "user template").unwrap();
        assert!(!seed_notes_template(&vault).unwrap());
        assert_eq!(fs::read_to_string(&path).unwrap(), "user template");

        let _ = fs::remove_dir_all(&vault);
    }
}
