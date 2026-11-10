//! Paper metadata commands — catalog.sqlite is authoritative.
//!
//! All heavy-IO commands here are async and run their SQLite/filesystem work
//! inside `run_blocking`, keeping the main thread (Windows UI message pump)
//! free.

use crate::app::command_util::try_vault;
use crate::core::blocking::run_blocking;
use crate::core::error::{map_err, ApiResult, AppError};
use crate::core::fs::{ensure_vault_dir, resolve_paper_dir};
use crate::core::log_util::OpTimer;
use crate::features::paper::catalog::papers::{self, PaperRecord};
use crate::features::paper::catalog::{probe_paper_caps, CapsCache};
use crate::features::pdf::marks::activity as reading_activity;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

use super::service;

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PaperGetArgs {
    pub vault_path: String,
    /// Vault-relative paper folder path, e.g. `papers/1706.03762`.
    #[serde(default)]
    pub path: Option<String>,
    /// Logical id (arxiv id / citekey) if path unknown.
    #[serde(default)]
    pub id: Option<String>,
}

/// Get one paper's metadata from catalog.sqlite.
#[tauri::command]
#[specta::specta]
pub async fn paper_get(args: PaperGetArgs) -> ApiResult<PaperRecord> {
    run_blocking(move || {
        let vault = try_vault!(&args.vault_path);
        service::get_paper(&vault, args.path.as_deref(), args.id.as_deref())
    })
    .await
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PaperOpenBundleArgs {
    pub vault_path: String,
    /// Vault-relative paper folder path, e.g. `papers/1706.03762`.
    pub path: String,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PaperOpenBundle {
    pub paper: PaperRecord,
    pub path_rel: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes_seed: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pdf_path: Option<String>,
    pub has_tex: bool,
    pub has_paper_md: bool,
}

/// Bundle local paper-open data for the renderer's focus path.
#[tauri::command]
#[specta::specta]
pub async fn paper_open_bundle(
    args: PaperOpenBundleArgs,
    cache: State<'_, CapsCache>,
) -> Result<ApiResult<PaperOpenBundle>, String> {
    let cache = cache.inner().clone();
    Ok(run_blocking(move || {
        let vault = PathBuf::from(args.vault_path.trim());
        match paper_open_bundle_inner(&vault, &args.path, Some(&cache)) {
            Ok(bundle) => ApiResult::ok(bundle),
            Err(e) => map_err(e),
        }
    })
    .await)
}

fn paper_open_bundle_inner(
    vault: &Path,
    path_raw: &str,
    cache: Option<&CapsCache>,
) -> Result<PaperOpenBundle, AppError> {
    ensure_vault_dir(vault)?;
    let (paper_dir, path_rel) = resolve_paper_dir(vault, path_raw)?;
    // Existing papers are not scanned at import time. Fill once on open so
    // Paper Info can show the repository from this bundle.
    agentero_core::features::paper::import::code_repo::fill_code_repo_on_open(vault, &path_rel);
    let paper = papers::get_by_path(vault, &path_rel)?
        .ok_or_else(|| AppError::message("paper not found in catalog"))?;
    let caps = cache
        .map(|c| c.caps_for(vault, &path_rel))
        .unwrap_or_else(|| probe_paper_caps(&paper_dir));
    let notes_path = paper_dir.join("NOTES.md");
    let notes_seed = match fs::read_to_string(&notes_path) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(AppError::message(format!("read NOTES.md: {e}"))),
    };

    Ok(PaperOpenBundle {
        paper,
        path_rel,
        notes_seed,
        pdf_path: caps.pdf_path.map(|path| path.to_string_lossy().to_string()),
        has_tex: caps.has_tex,
        has_paper_md: caps.has_paper_md,
    })
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PaperListArgs {
    pub vault_path: String,
}

/// One library row: the catalog record plus a local-PDF probe.
#[derive(Debug, Serialize, specta::Type)]
pub struct PaperListRow {
    #[serde(flatten)]
    pub paper: PaperRecord,
    /// List projection only: whether `papers/<id>/` currently holds a PDF.
    pub has_pdf: bool,
}

/// List all papers for the library table (catalog.sqlite).
///
/// Returns one row per logical paper `id` so the Library never shows duplicate
/// entries when the same paper was imported under multiple paths (#248).
#[tauri::command]
#[specta::specta]
pub async fn paper_list(
    args: PaperListArgs,
    cache: State<'_, CapsCache>,
) -> Result<ApiResult<Vec<PaperListRow>>, String> {
    let cache = cache.inner().clone();
    Ok(run_blocking(move || {
        let op = OpTimer::start("paper_list");
        let vault = try_vault!(&args.vault_path, op);
        // Projection intentionally differs from `remote_paper_list` (raw
        // `PaperRecord`, no has_pdf probe, no id dedupe) — known drift kept
        // for wire stability; see `docs/backend/remote.md`.
        match papers::list_all_unique_by_id(&vault) {
            Ok(rows) => {
                let out: Vec<_> = rows
                    .into_iter()
                    .map(|paper| {
                        let has_pdf =
                            !paper.path.is_empty() && cache.caps_for(&vault, &paper.path).has_pdf();
                        PaperListRow { paper, has_pdf }
                    })
                    .collect();
                let count = out.len();
                op.finish_ok_extra(format!("count={count}"));
                ApiResult::ok(out)
            }
            Err(e) => {
                op.finish_err(&e);
                map_err(e)
            }
        }
    })
    .await)
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PaperSetIsReadArgs {
    pub vault_path: String,
    /// Vault-relative paper folder path.
    pub path: String,
    pub is_read: bool,
}

/// Update catalog `is_read` after paper-reader workflow completes (or reset).
#[tauri::command]
#[specta::specta]
pub async fn paper_set_is_read(args: PaperSetIsReadArgs) -> ApiResult<PaperRecord> {
    run_blocking(move || {
        let vault = try_vault!(&args.vault_path);
        service::set_is_read(&vault, &args.path, args.is_read)
    })
    .await
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PaperUpdateMetaArgs {
    pub vault_path: String,
    /// Vault-relative paper folder path.
    pub path: String,
    pub patch: papers::PaperMetaPatch,
}

/// Manually edit paper metadata (patch semantics: only provided fields change,
/// empty strings clear). Marks the row `meta_source = "manual"`.
#[tauri::command]
#[specta::specta]
pub async fn paper_update_meta(args: PaperUpdateMetaArgs) -> ApiResult<PaperRecord> {
    run_blocking(move || {
        let vault = try_vault!(&args.vault_path);
        match service::normalize_paper_path(&args.path)
            .and_then(|path| papers::update_meta(&vault, &path, &args.patch))
        {
            Ok(row) => ApiResult::ok(row),
            Err(e) => map_err(e),
        }
    })
    .await
}

#[cfg(test)]
mod open_bundle_tests {
    use super::*;
    use uuid::Uuid;

    fn temp_vault(name: &str) -> PathBuf {
        let vault =
            std::env::temp_dir().join(format!("agentero-open-bundle-{name}-{}", Uuid::new_v4()));
        fs::create_dir_all(&vault).expect("create temp vault");
        vault
    }

    fn sample_record(path: &str, id: &str) -> PaperRecord {
        PaperRecord {
            path: path.into(),
            id: id.into(),
            paper_type: papers::PaperKind::Doi,
            title: "Bundled Paper".into(),
            authors: vec!["A".into()],
            creators: None,
            year: Some(2024),
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
            code_repo: None,
            openreview_url: None,
            body_source: None,
            body_quality: None,
            bibtex_key: None,
            citation_count: None,
            zotero_item_type: None,
            meta_source: None,
            extra: None,
            summary: None,
            status: "completed".into(),
            is_read: false,
            zotero_item_id: None,
            zotero_last_synced: None,
            custom_props: Default::default(),
            added_at: "t".into(),
            updated_at: "t".into(),
        }
    }

    #[test]
    fn paper_open_bundle_returns_catalog_caps_and_notes() {
        let vault = temp_vault("full");
        let path = "papers/x";
        let paper_dir = vault.join(path);
        fs::create_dir_all(paper_dir.join("source")).expect("create paper dirs");
        fs::write(paper_dir.join("NOTES.md"), "# Notes\n").expect("write notes");
        fs::write(paper_dir.join("PAPER.md"), "# Body\n").expect("write paper body");
        let pdf_path = paper_dir.join("x.pdf");
        fs::write(&pdf_path, b"%PDF").expect("write pdf");
        fs::write(
            paper_dir.join("source/main.tex"),
            "\\documentclass{article}",
        )
        .expect("write tex");
        papers::upsert_paper(&vault, &sample_record(path, "x")).expect("upsert paper");

        let bundle = paper_open_bundle_inner(&vault, path, None).expect("open bundle");

        assert_eq!(bundle.path_rel, path);
        assert_eq!(bundle.paper.id, "x");
        assert_eq!(bundle.notes_seed.as_deref(), Some("# Notes\n"));
        assert_eq!(bundle.pdf_path.as_deref(), Some(pdf_path.to_str().unwrap()));
        assert!(bundle.has_tex);
        assert!(bundle.has_paper_md);
        fs::remove_dir_all(vault).ok();
    }

    #[test]
    fn paper_open_bundle_allows_missing_notes() {
        let vault = temp_vault("missing-notes");
        let path = "papers/y";
        fs::create_dir_all(vault.join(path)).expect("create paper dir");
        papers::upsert_paper(&vault, &sample_record(path, "y")).expect("upsert paper");

        let bundle = paper_open_bundle_inner(&vault, path, None).expect("open bundle");

        assert_eq!(bundle.paper.id, "y");
        assert!(bundle.notes_seed.is_none());
        assert!(bundle.pdf_path.is_none());
        assert!(!bundle.has_tex);
        assert!(!bundle.has_paper_md);
        fs::remove_dir_all(vault).ok();
    }
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PaperSetTagsArgs {
    pub vault_path: String,
    /// Vault-relative paper folder path.
    pub path: String,
    /// Full replacement list (not a patch merge).
    /// Each item may be a bare string or `{ name, color? }` (Apple-style color id).
    pub tags: Vec<papers::PaperTag>,
}

/// Replace catalog tags for a paper (syncs metadata.json projection).
#[tauri::command]
#[specta::specta]
pub async fn paper_set_tags(args: PaperSetTagsArgs) -> ApiResult<PaperRecord> {
    run_blocking(move || {
        let vault = try_vault!(&args.vault_path);
        service::set_tags(&vault, &args.path, &args.tags)
    })
    .await
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PaperSyncPublicationArgs {
    pub vault_path: String,
    /// Vault-relative paper folder paths to process.
    pub paths: Vec<String>,
}

/// Single Host-side publication sync: refresh the `#submitted:` projection,
/// remove retired `#venue:` tags, and refresh EasyScholar metrics when a key is
/// configured. The renderer never writes these system tags itself.
#[tauri::command]
#[specta::specta]
pub async fn paper_sync_publication(
    app: tauri::AppHandle,
    args: PaperSyncPublicationArgs,
) -> ApiResult<crate::features::paper::venue::VenueSyncReport> {
    use tauri::Manager;
    let vault = try_vault!(&args.vault_path);
    let key = app
        .state::<crate::features::system::settings::AppSettingsStore>()
        .easy_scholar_key();
    match crate::features::paper::venue::sync_publication(&vault, &args.paths, key.as_deref()).await
    {
        Ok(report) => ApiResult::ok(report),
        Err(e) => map_err(e),
    }
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PaperRescanArgs {
    pub vault_path: String,
}

#[derive(Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PaperRescanResult {
    /// Number of paper folders re-imported into the catalog.
    pub count: usize,
}

/// Rebuild catalog rows from `papers/` metadata.json — recovers papers that are
/// on disk but missing from the catalog (added externally, or a lost row).
#[tauri::command]
#[specta::specta]
pub async fn paper_rescan(args: PaperRescanArgs) -> ApiResult<PaperRescanResult> {
    run_blocking(move || {
        use crate::core::log_util::OpTimer;

        let op = OpTimer::start("paper_rescan");
        let vault = try_vault!(&args.vault_path, op);
        match papers::rebuild_from_disk(&vault) {
            Ok(count) => {
                op.finish_ok_extra(format!("count={count}"));
                ApiResult::ok(PaperRescanResult { count })
            }
            Err(e) => {
                op.finish_err(&e);
                map_err(e)
            }
        }
    })
    .await
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PaperEnsureRowsArgs {
    pub vault_path: String,
    /// Absolute or vault-relative paths under `papers/`.
    pub paths: Vec<String>,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PaperEnsureRowsResult {
    /// Rows inserted. Existing rows are left as they are.
    pub count: usize,
    /// True when a path could not be pinned to one paper folder and the
    /// command rebuilt the catalog from `papers/`.
    pub rescanned: bool,
}

/// Ensure catalog rows for watcher paths. Falls back to a full rescan only
/// when a path under `papers/` is not one paper folder.
#[tauri::command]
#[specta::specta]
pub async fn paper_ensure_rows(args: PaperEnsureRowsArgs) -> ApiResult<PaperEnsureRowsResult> {
    use crate::features::paper::catalog::papers::PaperRowsTouch;

    run_blocking(move || {
        use crate::core::log_util::OpTimer;

        let started = std::time::Instant::now();
        let op = OpTimer::start("paper_ensure");
        let vault = try_vault!(&args.vault_path, op);
        match papers::ensure_rows_for_paths(&vault, &args.paths) {
            Ok(PaperRowsTouch::Ensured { count }) => {
                op.finish_ok_extra(format!("count={count}"));
                ApiResult::ok(PaperEnsureRowsResult {
                    count,
                    rescanned: false,
                })
            }
            Ok(PaperRowsTouch::Rescanned { count }) => {
                let ms = started.elapsed().as_millis();
                op.finish_ok_extra(format!("fallback=rescan count={count}"));
                log::info!(
                    target: "agentero::op",
                    "op end paper_rescan ok=true duration_ms={ms} fallback=ensure count={count}"
                );
                ApiResult::ok(PaperEnsureRowsResult {
                    count,
                    rescanned: true,
                })
            }
            Err(error) => {
                op.finish_err(&error);
                map_err(error)
            }
        }
    })
    .await
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PaperPageCountsArgs {
    pub vault_path: String,
}

/// Cached PDF page counts keyed by vault-relative paper path.
#[tauri::command]
#[specta::specta]
pub async fn paper_page_counts(
    args: PaperPageCountsArgs,
) -> ApiResult<std::collections::HashMap<String, i64>> {
    run_blocking(move || {
        let vault = try_vault!(&args.vault_path);
        match papers::list_page_counts(&vault) {
            Ok(counts) => ApiResult::ok(counts),
            Err(e) => map_err(e),
        }
    })
    .await
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PaperReadingActivityBatchArgs {
    pub vault_path: String,
    /// Vault-relative paper folder paths, e.g. `papers/1706.03762`.
    pub paths: Vec<String>,
}

/// Batch-read reading activity (`marks/*.json` sidecars) for many papers in
/// one IPC round-trip — replaces the Library heatmap's per-paper
/// highlights/asks/translates fan-out (an IPC storm at 500+ papers).
#[tauri::command]
#[specta::specta]
pub async fn paper_reading_activity_batch(
    args: PaperReadingActivityBatchArgs,
) -> ApiResult<std::collections::HashMap<String, Vec<reading_activity::ReadingActivityPoint>>> {
    run_blocking(move || {
        use crate::core::log_util::OpTimer;

        let op = OpTimer::start_with(
            "paper_reading_activity_batch",
            format!("papers={}", args.paths.len()),
        );
        let vault = try_vault!(&args.vault_path, op);
        let out = reading_activity::collect_reading_activity(&vault, &args.paths);
        let points: usize = out.values().map(Vec::len).sum();
        op.finish_ok_extra(format!("points={points}"));
        ApiResult::ok(out)
    })
    .await
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PaperSetPageCountsArgs {
    pub vault_path: String,
    /// vault-relative paper path → page count.
    pub counts: std::collections::HashMap<String, i64>,
}

/// Persist newly discovered PDF page counts (heatmap page-count cache).
#[tauri::command]
#[specta::specta]
pub async fn paper_set_page_counts(args: PaperSetPageCountsArgs) -> ApiResult<()> {
    run_blocking(move || {
        let vault = try_vault!(&args.vault_path);
        let counts: Vec<(String, i64)> = args
            .counts
            .into_iter()
            .map(|(path, count)| (path.trim().trim_matches('/').replace('\\', "/"), count))
            .filter(|(path, count)| !path.is_empty() && *count > 0)
            .collect();
        match papers::set_page_counts(&vault, &counts) {
            Ok(()) => ApiResult::ok(()),
            Err(e) => map_err(e),
        }
    })
    .await
}

pub use super::service::{PaperMoveArgs, PaperMoveResult};
pub use agentero_core::features::paper::catalog::copy_paper::PaperCopyResult;

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PaperCopyArgs {
    pub vault_path: String,
    /// Vault-relative item to duplicate (paper or org folder under `papers/`).
    pub from_rel: String,
    /// Vault-relative destination parent (`papers` or under `papers/`).
    pub dest_parent_rel: String,
}

/// Duplicate a folder into another `papers/` folder (the library's batch
/// "copy to folder"). Never overwrites; the source keeps its links and row.
#[tauri::command]
#[specta::specta]
pub async fn paper_copy(args: PaperCopyArgs) -> ApiResult<PaperCopyResult> {
    run_blocking(move || {
        let vault = try_vault!(&args.vault_path);
        match agentero_core::features::paper::catalog::copy_paper::copy_paper_under(
            &vault,
            &args.from_rel,
            &args.dest_parent_rel,
        ) {
            Ok(result) => ApiResult::ok(result),
            Err(error) => map_err(error),
        }
    })
    .await
}

/// Move an item into another `papers/` folder on disk and rewrite matching
/// catalog path prefixes. Never overwrites an existing target.
#[tauri::command]
#[specta::specta]
pub async fn paper_move(
    args: PaperMoveArgs,
    index: State<'_, crate::features::vault::rename::WikiIndexState>,
) -> Result<ApiResult<PaperMoveResult>, String> {
    Ok(
        match super::service::paper_move_service(args, index.handle()).await {
            Ok(result) => ApiResult::ok(result),
            Err(error) => map_err(error),
        },
    )
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PaperRepathArgs {
    pub vault_path: String,
    /// Vault-relative original path (paper folder, org folder, or file under `papers/`).
    pub from_rel: String,
    /// Vault-relative new path after the move already happened on disk.
    pub to_rel: String,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PaperRepathResult {
    /// Number of catalog rows whose `path` prefix was rewritten.
    pub count: usize,
}

/// Rewrite catalog `path` prefixes after an item was moved outside the app.
///
/// This does **not** touch the filesystem; it only keeps `papers` rows and
/// `pdf_page_counts` in sync with the new disk layout so titles/metadata are
/// not lost after a Finder/CLI move.
#[tauri::command]
#[specta::specta]
pub async fn paper_repath(args: PaperRepathArgs) -> ApiResult<PaperRepathResult> {
    run_blocking(move || {
        let vault = try_vault!(&args.vault_path);
        match crate::features::paper::catalog::papers::move_under_path(
            &vault,
            &args.from_rel,
            &args.to_rel,
        ) {
            Ok(count) => ApiResult::ok(PaperRepathResult { count }),
            Err(e) => map_err(e),
        }
    })
    .await
}

// Custom Properties Commands

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CatalogListPropertiesArgs {
    pub vault_path: String,
}

#[tauri::command]
#[specta::specta]
pub async fn catalog_list_properties(
    args: CatalogListPropertiesArgs,
) -> ApiResult<Vec<crate::features::paper::catalog::properties::CustomProperty>> {
    run_blocking(move || {
        let vault = try_vault!(&args.vault_path);
        match crate::features::paper::catalog::properties::list_properties(&vault) {
            Ok(v) => ApiResult::ok(v),
            Err(e) => map_err(e),
        }
    })
    .await
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CatalogCreatePropertyArgs {
    pub vault_path: String,
    pub name: String,
    /// `select` (default) or `text`.
    #[serde(default)]
    pub property_type: Option<String>,
    #[serde(default)]
    pub options: Vec<crate::features::paper::catalog::properties::PropertyOption>,
}

#[tauri::command]
#[specta::specta]
pub async fn catalog_create_property(
    args: CatalogCreatePropertyArgs,
) -> ApiResult<crate::features::paper::catalog::properties::CustomProperty> {
    run_blocking(move || {
        let vault = try_vault!(&args.vault_path);
        match crate::features::paper::catalog::properties::create_property(
            &vault,
            &args.name,
            args.property_type.as_deref().unwrap_or("select"),
            args.options,
        ) {
            Ok(v) => ApiResult::ok(v),
            Err(e) => map_err(e),
        }
    })
    .await
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CatalogUpdatePropertyArgs {
    pub vault_path: String,
    pub property: crate::features::paper::catalog::properties::CustomProperty,
}

#[tauri::command]
#[specta::specta]
pub async fn catalog_update_property(
    args: CatalogUpdatePropertyArgs,
) -> ApiResult<crate::features::paper::catalog::properties::CustomProperty> {
    run_blocking(move || {
        let vault = try_vault!(&args.vault_path);
        match crate::features::paper::catalog::properties::update_property(&vault, &args.property) {
            Ok(v) => ApiResult::ok(v),
            Err(e) => map_err(e),
        }
    })
    .await
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CatalogDeletePropertyArgs {
    pub vault_path: String,
    pub property_id: String,
}

#[tauri::command]
#[specta::specta]
pub async fn catalog_delete_property(args: CatalogDeletePropertyArgs) -> ApiResult<()> {
    run_blocking(move || {
        let vault = try_vault!(&args.vault_path);
        match crate::features::paper::catalog::properties::delete_property(
            &vault,
            &args.property_id,
        ) {
            Ok(()) => ApiResult::ok(()),
            Err(e) => map_err(e),
        }
    })
    .await
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSetPaperPropertyArgs {
    pub vault_path: String,
    pub paper_path: String,
    pub property_id: String,
    /// `select`: option id. `text`: raw text. `None` clears the value.
    pub option_id: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn catalog_set_paper_property(
    args: CatalogSetPaperPropertyArgs,
) -> ApiResult<PaperRecord> {
    run_blocking(move || {
        let vault = try_vault!(&args.vault_path);
        match crate::features::paper::catalog::properties::set_paper_property(
            &vault,
            &args.paper_path,
            &args.property_id,
            args.option_id.as_deref(),
        ) {
            Ok(v) => ApiResult::ok(v),
            Err(e) => map_err(e),
        }
    })
    .await
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CatalogCreateOptionAndSetArgs {
    pub vault_path: String,
    pub paper_path: String,
    pub property_id: String,
    pub option_name: String,
    pub option_color: Option<String>,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CatalogCreateOptionAndSetResult {
    pub property: crate::features::paper::catalog::properties::CustomProperty,
    pub paper: PaperRecord,
}

#[tauri::command]
#[specta::specta]
pub async fn catalog_create_option_and_set(
    args: CatalogCreateOptionAndSetArgs,
) -> ApiResult<CatalogCreateOptionAndSetResult> {
    run_blocking(move || {
        let vault = try_vault!(&args.vault_path);
        match crate::features::paper::catalog::properties::create_option_and_set(
            &vault,
            &args.paper_path,
            &args.property_id,
            &args.option_name,
            args.option_color.as_deref(),
        ) {
            Ok((prop, paper)) => ApiResult::ok(CatalogCreateOptionAndSetResult {
                property: prop,
                paper,
            }),
            Err(e) => map_err(e),
        }
    })
    .await
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CatalogDeletePropertyOptionArgs {
    pub vault_path: String,
    pub property_id: String,
    pub option_id: String,
}

#[tauri::command]
#[specta::specta]
pub async fn catalog_delete_property_option(
    args: CatalogDeletePropertyOptionArgs,
) -> ApiResult<crate::features::paper::catalog::properties::CustomProperty> {
    run_blocking(move || {
        let vault = try_vault!(&args.vault_path);
        match crate::features::paper::catalog::properties::delete_property_option(
            &vault,
            &args.property_id,
            &args.option_id,
        ) {
            Ok(v) => ApiResult::ok(v),
            Err(e) => map_err(e),
        }
    })
    .await
}
