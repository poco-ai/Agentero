//! Paper metadata commands — catalog.sqlite is authoritative.
//!
//! All heavy-IO commands here are async and run their SQLite/filesystem work
//! inside `run_blocking`, keeping the main thread (Windows UI message pump)
//! free.

use crate::core::blocking::run_blocking;
use crate::core::error::{map_err, ApiResult, AppError};
use crate::core::fs::{ensure_vault_dir, resolve_paper_dir, resolve_vault};
use crate::features::catalog::papers::{self, PaperRecord};
use crate::features::catalog::reading_activity;
use crate::features::catalog::{probe_paper_caps, CapsCache};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

#[derive(Debug, Deserialize)]
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
pub async fn paper_get(args: PaperGetArgs) -> ApiResult<PaperRecord> {
    run_blocking(move || {
        let vault = match resolve_vault(&args.vault_path) {
            Ok(vault) => vault,
            Err(e) => return map_err(e),
        };

        let result = if let Some(path) = args
            .path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let path = path.trim_matches('/').replace('\\', "/");
            papers::get_by_path(&vault, &path)
        } else if let Some(id) = args.id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            papers::get_by_id(&vault, id)
        } else {
            return map_err(AppError::message("path or id is required"));
        };

        match result {
            Ok(Some(row)) => ApiResult::ok(row),
            Ok(None) => map_err(AppError::message("paper not found in catalog")),
            Err(e) => map_err(e),
        }
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperOpenBundleArgs {
    pub vault_path: String,
    /// Vault-relative paper folder path, e.g. `papers/1706.03762`.
    pub path: String,
}

#[derive(Debug, Serialize)]
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperListArgs {
    pub vault_path: String,
}

/// One library row: the catalog record plus a local-PDF probe.
#[derive(Debug, Serialize)]
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
pub async fn paper_list(
    args: PaperListArgs,
    cache: State<'_, CapsCache>,
) -> Result<ApiResult<Vec<PaperListRow>>, String> {
    let cache = cache.inner().clone();
    Ok(run_blocking(move || {
        let vault = match resolve_vault(&args.vault_path) {
            Ok(vault) => vault,
            Err(e) => return map_err(e),
        };
        match papers::list_all_unique_by_id(&vault) {
            Ok(rows) => ApiResult::ok(
                rows.into_iter()
                    .map(|paper| {
                        let has_pdf =
                            !paper.path.is_empty() && cache.caps_for(&vault, &paper.path).has_pdf();
                        PaperListRow { paper, has_pdf }
                    })
                    .collect(),
            ),
            Err(e) => map_err(e),
        }
    })
    .await)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperSetIsReadArgs {
    pub vault_path: String,
    /// Vault-relative paper folder path.
    pub path: String,
    pub is_read: bool,
}

/// Update catalog `is_read` after paper-reader workflow completes (or reset).
#[tauri::command]
pub async fn paper_set_is_read(args: PaperSetIsReadArgs) -> ApiResult<PaperRecord> {
    run_blocking(move || {
        let vault = match resolve_vault(&args.vault_path) {
            Ok(vault) => vault,
            Err(e) => return map_err(e),
        };
        let path = args.path.trim().trim_matches('/').replace('\\', "/");
        if path.is_empty() {
            return map_err(AppError::message("path is required"));
        }
        match papers::set_is_read(&vault, &path, args.is_read) {
            Ok(row) => ApiResult::ok(row),
            Err(e) => map_err(e),
        }
    })
    .await
}

#[derive(Debug, Deserialize)]
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
pub async fn paper_update_meta(args: PaperUpdateMetaArgs) -> ApiResult<PaperRecord> {
    run_blocking(move || {
        let vault = match resolve_vault(&args.vault_path) {
            Ok(vault) => vault,
            Err(e) => return map_err(e),
        };
        let path = args.path.trim().trim_matches('/').replace('\\', "/");
        if path.is_empty() {
            return map_err(AppError::message("path is required"));
        }
        match papers::update_meta(&vault, &path, &args.patch) {
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
            paper_type: "article".into(),
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

#[derive(Debug, Deserialize)]
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
pub async fn paper_set_tags(args: PaperSetTagsArgs) -> ApiResult<PaperRecord> {
    run_blocking(move || {
        let vault = match resolve_vault(&args.vault_path) {
            Ok(vault) => vault,
            Err(e) => return map_err(e),
        };
        let path = args.path.trim().trim_matches('/').replace('\\', "/");
        if path.is_empty() {
            return map_err(AppError::message("path is required"));
        }
        match papers::set_tags(&vault, &path, &args.tags) {
            Ok(row) => ApiResult::ok(row),
            Err(e) => map_err(e),
        }
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperRescanArgs {
    pub vault_path: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperRescanResult {
    /// Number of paper folders re-imported into the catalog.
    pub count: usize,
}

/// Rebuild catalog rows from `papers/` metadata.json — recovers papers that are
/// on disk but missing from the catalog (added externally, or a lost row).
#[tauri::command]
pub async fn paper_rescan(args: PaperRescanArgs) -> ApiResult<PaperRescanResult> {
    run_blocking(move || {
        use crate::core::log_util::OpTimer;

        let op = OpTimer::start("paper_rescan");
        let vault = match resolve_vault(&args.vault_path) {
            Ok(vault) => vault,
            Err(err) => {
                op.finish_err(&err);
                return map_err(err);
            }
        };
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperPageCountsArgs {
    pub vault_path: String,
}

/// Cached PDF page counts keyed by vault-relative paper path.
#[tauri::command]
pub async fn paper_page_counts(
    args: PaperPageCountsArgs,
) -> ApiResult<std::collections::HashMap<String, i64>> {
    run_blocking(move || {
        let vault = match resolve_vault(&args.vault_path) {
            Ok(vault) => vault,
            Err(e) => return map_err(e),
        };
        match papers::list_page_counts(&vault) {
            Ok(counts) => ApiResult::ok(counts),
            Err(e) => map_err(e),
        }
    })
    .await
}

#[derive(Debug, Deserialize)]
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
pub async fn paper_reading_activity_batch(
    args: PaperReadingActivityBatchArgs,
) -> ApiResult<std::collections::HashMap<String, Vec<reading_activity::ReadingActivityPoint>>> {
    run_blocking(move || {
        use crate::core::log_util::OpTimer;

        let op = OpTimer::start_with(
            "paper_reading_activity_batch",
            format!("papers={}", args.paths.len()),
        );
        let vault = match resolve_vault(&args.vault_path) {
            Ok(vault) => vault,
            Err(err) => {
                op.finish_err(&err);
                return map_err(err);
            }
        };
        let out = reading_activity::collect_reading_activity(&vault, &args.paths);
        let points: usize = out.values().map(Vec::len).sum();
        op.finish_ok_extra(format!("points={points}"));
        ApiResult::ok(out)
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperSetPageCountsArgs {
    pub vault_path: String,
    /// vault-relative paper path → page count.
    pub counts: std::collections::HashMap<String, i64>,
}

/// Persist newly discovered PDF page counts (heatmap page-count cache).
#[tauri::command]
pub async fn paper_set_page_counts(args: PaperSetPageCountsArgs) -> ApiResult<()> {
    run_blocking(move || {
        let vault = match resolve_vault(&args.vault_path) {
            Ok(vault) => vault,
            Err(e) => return map_err(e),
        };
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
