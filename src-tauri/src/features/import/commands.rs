//! Magic-wand / identifier import commands.

use crate::core::blocking::run_blocking;
use crate::core::error::{map_err, ApiResult, AppError};
use crate::core::fs::{resolve_vault, WriteOpts};
use crate::core::log_util::{trunc, OpTimer};
use crate::features::catalog::CapsCache;
use crate::features::import::pdf_parse::{PaperParseBodyArgs, PaperParseResult};
use crate::features::import::resolver::{fetch_arxiv_metadata, fetch_crossref_metadata};
use crate::features::import::title_search::{
    better_publication, fetch_s2_venue_by_doi, is_usable_publication, search_papers,
};
use crate::features::import::{
    AssetDownloadResult, ImportLocalPdfArgs, ImportLocalPdfResult, LookupImportBatchArgs,
    LookupImportBatchResult, PaperDownloadAssetsArgs, SkillImportResult, StageImportFileArgs,
    StageImportFileResult,
};
use crate::features::remote::{import_bridge, parse_remote_handle, RemoteRegistry};
use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::State;

/// Batch resolve identifiers and write papers into vault.
/// Deduplicates within the batch and against existing catalog entries.
#[tauri::command]
pub async fn lookup_import_batch(
    app: tauri::AppHandle,
    registry: State<'_, Arc<RemoteRegistry>>,
    cache: State<'_, CapsCache>,
    args: LookupImportBatchArgs,
) -> Result<ApiResult<LookupImportBatchResult>, String> {
    let n = args.texts.len();
    let op = OpTimer::start_with("lookup_import_batch", format!("count={n}"));
    let note_mode = crate::features::import::note_mode_from_app(&app);
    if let Some(session_id) = parse_remote_handle(&args.vault_path) {
        let session = match registry.get(session_id).await {
            Ok(s) => s,
            Err(e) => {
                op.finish_err(&e);
                return Ok(crate::core::error::map_err(e));
            }
        };
        let vault_id = std::path::PathBuf::from(&args.vault_path);
        let result =
            import_bridge::import_by_identifier_batch_remote(session, args, note_mode).await;
        if let Ok(r) = &result {
            for paper in &r.imported {
                crate::features::lifecycle::emit_paper_imported(Some(&app), &vault_id, &paper.id);
            }
        }
        return Ok(op.finish_result(result));
    }
    let task_id = args.task_id.clone();
    let result = super::import_by_identifier_batch(args, Some(&app), Some(&cache), note_mode).await;
    if let Some(task_id) = task_id.as_deref() {
        crate::core::background_tasks::finish(task_id);
    }
    Ok(op.finish_result(result))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallArgs {
    pub vault_path: String,
    pub discovery_id: String,
    #[serde(default)]
    pub selected_names: Vec<String>,
    #[serde(default)]
    pub task_id: Option<String>,
}

#[tauri::command]
pub fn skill_install(args: SkillInstallArgs) -> ApiResult<Vec<SkillImportResult>> {
    let op = OpTimer::start_with(
        "skill_install",
        format!("discovery_id={}", trunc(&args.discovery_id, 40)),
    );
    let result = super::install_discovered_skills(
        std::path::Path::new(&args.vault_path),
        &args.discovery_id,
        &args.selected_names,
    );
    op.finish_result(result)
}

#[tauri::command]
pub fn skill_discard(discovery_id: String) -> ApiResult<()> {
    let op = OpTimer::start_with(
        "skill_discard",
        format!("discovery_id={}", trunc(&discovery_id, 40)),
    );
    op.finish_result(super::discard_skill_discovery(&discovery_id))
}

/// Download PDF (+ arXiv LaTeX) for an existing paper folder that is missing local assets.
/// When no TeX remains after download, also tries liteparse → PAPER.md.
#[tauri::command]
pub async fn paper_download_assets(
    app: tauri::AppHandle,
    registry: State<'_, Arc<RemoteRegistry>>,
    cache: State<'_, CapsCache>,
    args: PaperDownloadAssetsArgs,
) -> Result<ApiResult<AssetDownloadResult>, String> {
    let path = trunc(&args.path, 120);
    let op = OpTimer::start_with("paper_download_assets", format!("path={path}"));
    if let Some(session_id) = parse_remote_handle(&args.vault_path) {
        let session = match registry.get(session_id).await {
            Ok(s) => s,
            Err(e) => {
                op.finish_err(&e);
                return Ok(crate::core::error::map_err(e));
            }
        };
        return Ok(
            op.finish_result(import_bridge::download_paper_assets_remote(session, args).await)
        );
    }
    let task_id = args.task_id.clone();
    let result = super::download_paper_assets_with_progress(args, Some(&app), Some(&cache)).await;
    if let Some(task_id) = task_id.as_deref() {
        crate::core::background_tasks::finish(task_id);
    }
    Ok(op.finish_result(result))
}

/// Import local PDF file(s) into the vault as paper folders (copy + catalog + liteparse).
#[tauri::command]
pub async fn paper_import_local_pdf(
    app: tauri::AppHandle,
    registry: State<'_, Arc<RemoteRegistry>>,
    cache: State<'_, CapsCache>,
    args: ImportLocalPdfArgs,
) -> Result<ApiResult<ImportLocalPdfResult>, String> {
    let n = args.file_paths.len();
    let op = OpTimer::start_with("paper_import_local_pdf", format!("count={n}"));
    let note_mode = crate::features::import::note_mode_from_app(&app);
    let task_id = args.task_id.clone();
    let result = if let Some(session_id) = parse_remote_handle(&args.vault_path) {
        let session = match registry.get(session_id).await {
            Ok(s) => s,
            Err(e) => {
                if let Some(task_id) = task_id.as_deref() {
                    crate::core::background_tasks::finish(task_id);
                }
                op.finish_err(&e);
                return Ok(crate::core::error::map_err(e));
            }
        };
        let vault_id = std::path::PathBuf::from(&args.vault_path);
        let result = import_bridge::import_local_pdfs_remote(session, args, note_mode).await;
        if let Ok(r) = &result {
            for paper in &r.papers {
                crate::features::lifecycle::emit_paper_imported(Some(&app), &vault_id, &paper.id);
            }
        }
        result
    } else {
        super::import_local_pdfs(args, Some(&app), Some(&cache), note_mode).await
    };
    if let Some(task_id) = task_id.as_deref() {
        crate::core::background_tasks::finish(task_id);
    }
    Ok(op.finish_result_ok_extra(result, |r| {
        format!("imported={} errors={}", r.papers.len(), r.errors.len())
    }))
}

/// Parse a paper's local PDF into `PAPER.md` using liteparse.
/// Runs as a standalone background task; `task_id` is used for cancellation.
#[tauri::command]
pub async fn paper_parse_body(
    registry: State<'_, Arc<RemoteRegistry>>,
    cache: State<'_, CapsCache>,
    args: PaperParseBodyArgs,
) -> Result<ApiResult<PaperParseResult>, String> {
    let path = trunc(&args.path, 120);
    let op = OpTimer::start_with("paper_parse_body", format!("path={path}"));

    if let Some(session_id) = parse_remote_handle(&args.vault_path) {
        let session = match registry.get(session_id).await {
            Ok(s) => s,
            Err(e) => {
                if let Some(task_id) = args.task_id.as_deref() {
                    crate::core::background_tasks::finish(task_id);
                }
                op.finish_err(&e);
                return Ok(crate::core::error::map_err(e));
            }
        };
        let task_id = args.task_id.clone();
        let result = parse_remote_body(session, args).await;
        if let Some(task_id) = task_id.as_deref() {
            crate::core::background_tasks::finish(task_id);
        }
        return Ok(op.finish_result(result));
    }

    let task_id = args.task_id.clone();
    let result = crate::features::import::pdf_parse::parse_paper_body(args, Some(&cache)).await;
    if let Some(task_id) = task_id.as_deref() {
        crate::core::background_tasks::finish(task_id);
    }
    Ok(op.finish_result(result))
}

async fn parse_remote_body(
    session: Arc<crate::features::remote::session::RemoteSession>,
    args: PaperParseBodyArgs,
) -> Result<PaperParseResult, crate::core::error::AppError> {
    let path_rel = crate::core::fs::sanitize_vault_rel(&args.path)
        .map_err(|_| crate::core::error::AppError::message("invalid paper path"))?;
    let staging = session.work_root.join(&path_rel);

    let local_args = PaperParseBodyArgs {
        vault_path: session.work_root.to_string_lossy().to_string(),
        path: path_rel.clone(),
        force: args.force,
        task_id: args.task_id.clone(),
    };

    let result = crate::features::import::pdf_parse::parse_paper_body(local_args, None).await?;

    if result.paper_md {
        let paper_md_local = staging.join("PAPER.md");
        if paper_md_local.is_file() {
            let bytes = std::fs::read(&paper_md_local).map_err(|e| {
                crate::core::error::AppError::message(format!("read staged PAPER.md: {e}"))
            })?;
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
        let mut cat = session.catalog.lock().await;
        cat.push(session.fs.clone()).await?;
    }

    Ok(result)
}

/// Stage a path-less OS drop (File bytes as base64) into `~/.agentero/import-tmp/`.
#[tauri::command]
pub async fn paper_stage_import_file(
    args: StageImportFileArgs,
) -> ApiResult<StageImportFileResult> {
    crate::core::blocking::run_blocking(move || {
        let name = trunc(&args.file_name, 80);
        let op = OpTimer::start_with("paper_stage_import_file", format!("name={name}"));
        op.finish_result(super::stage_import_file(args))
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperResolveIdentifierArgs {
    /// DOI / arXiv id / URL / title text.
    pub text: String,
    #[serde(default)]
    pub translator_base_url: Option<String>,
}

/// Resolve an identifier (DOI/arXiv) to metadata without importing — backs
/// Edit Metadata's identifier refresh. Identifier lookup first (so a DOI /
/// arXiv id is not sent to title search); S2 `publicationVenue` enriches
/// truncated Crossref / empty Translator venues. Title search is fallback.
#[tauri::command]
pub async fn paper_resolve_identifier(
    args: PaperResolveIdentifierArgs,
) -> ApiResult<super::PaperMeta> {
    let text = trunc(args.text.trim(), 60);
    let op = OpTimer::start_with("paper_resolve_identifier", format!("text={text}"));

    // Skill 分流不在 resolver 表内：由 extract_skill_source 判定。
    let try_identifier = super::parse::extract_skill_source(&args.text).is_none()
        && super::parse::extract_primary_identifier(&args.text).is_some();

    if try_identifier {
        let base = args
            .translator_base_url
            .clone()
            .unwrap_or_else(|| super::DEFAULT_TRANSLATOR_BASE_URL.to_string());
        match super::resolve_metadata(&args.text, &base, None).await {
            Ok((mut meta, _used_translator)) => {
                enrich_publication_from_s2(&mut meta).await;
                super::enrich_remote_urls(&mut meta);
                op.finish_ok();
                return ApiResult::ok(meta);
            }
            Err(e) => {
                log::warn!("identifier resolve failed for {text}: {e}");
            }
        }
    }

    match super::title_search::search_papers(&args.text, 1).await {
        Ok(candidates) if !candidates.is_empty() => {
            let mut meta = super::map::meta_from_search_candidate(&candidates[0]);
            super::enrich_remote_urls(&mut meta);
            op.finish_ok();
            return ApiResult::ok(meta);
        }
        Ok(_) => {
            log::warn!("title search returned no candidates for {text}");
        }
        Err(e) => {
            log::warn!("title search failed for {text}: {e}");
        }
    }

    let err = AppError::message(format!("could not resolve a usable venue for {text}"));
    op.finish_err(&err);
    crate::core::error::map_err(err)
}

/// Fill / replace `publication` from S2 when the current value is empty,
/// generic (`arXiv`), or a likely-truncated Crossref proceedings title.
async fn enrich_publication_from_s2(meta: &mut super::PaperMeta) {
    use super::title_search::{better_publication, fetch_s2_venue, needs_s2_venue_enrichment};
    if !needs_s2_venue_enrichment(meta.publication.as_deref()) {
        return;
    }
    let s2 = fetch_s2_venue(meta.arxiv_id.as_deref(), meta.doi.as_deref()).await;
    if let Some(best) = better_publication(meta.publication.as_deref(), s2.as_deref()) {
        meta.publication = Some(best);
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesTemplateSeedResult {
    pub created: bool,
}

/// Seed `{vault}/.agentero/templates/NOTES.md` with a starting template for
/// the `custom` paper-note mode. Never overwrites an existing template.
#[tauri::command]
pub fn notes_template_seed(vault_path: String) -> ApiResult<NotesTemplateSeedResult> {
    let op = OpTimer::start_with(
        "notes_template_seed",
        format!("vault={}", trunc(&vault_path, 120)),
    );
    let result = resolve_vault(&vault_path)
        .and_then(|vault| super::seed_notes_template(&vault))
        .map(|created| NotesTemplateSeedResult { created });
    op.finish_result(result)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperBackfillPublicationArgs {
    pub vault_path: String,
    /// Optional Translator base URL; left empty for direct Crossref/arXiv/S2.
    #[serde(default)]
    pub translator_base_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperBackfillPublicationResult {
    pub total: usize,
    pub updated: usize,
    pub failed: usize,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub errors: Vec<String>,
}

/// Resolve and fill missing `publication` values for papers in the catalog.
/// Uses arXiv journal_ref / S2 `publicationVenue`, then DOI → S2 then Crossref,
/// then title → Semantic Scholar. Crossref is last among identifier sources
/// because its `container-title` truncates many conference proceedings.
#[tauri::command]
pub async fn paper_backfill_publication(
    args: PaperBackfillPublicationArgs,
) -> Result<ApiResult<PaperBackfillPublicationResult>, String> {
    let vault = match resolve_vault(&args.vault_path) {
        Ok(vault) => vault,
        Err(e) => return Ok(map_err(e)),
    };

    let vault_for_list = vault.clone();
    let rows =
        match run_blocking(
            move || match crate::features::catalog::papers::list_missing_publication(
                &vault_for_list,
            ) {
                Ok(rows) => ApiResult::ok(rows),
                Err(e) => map_err(e),
            },
        )
        .await
        {
            ApiResult {
                ok: true,
                data: Some(rows),
                ..
            } => rows,
            ApiResult {
                error: Some(err), ..
            } => return Ok(map_err(AppError::message(err.message))),
            _ => {
                return Ok(map_err(AppError::message(
                    "failed to list papers missing publication",
                )))
            }
        };

    const CONCURRENCY: usize = 10;

    let updated = Arc::new(Mutex::new(0usize));
    let failed = Arc::new(Mutex::new(0usize));
    let errors = Arc::new(Mutex::new(Vec::new()));

    stream::iter(rows.into_iter().map(|row| {
        let vault = vault.clone();
        let updated = updated.clone();
        let failed = failed.clone();
        let errors = errors.clone();
        async move {
            let publication = resolve_publication_for_backfill(
                row.doi.as_deref(),
                row.arxiv_id.as_deref(),
                &row.title,
            )
            .await;

            match publication {
                Some(pub_value) => {
                    let patch = crate::features::catalog::papers::PaperMetaPatch {
                        publication: Some(pub_value),
                        ..Default::default()
                    };
                    let path = row.path.clone();
                    match run_blocking(move || match crate::features::catalog::papers::update_meta(
                        &vault, &path, &patch,
                    ) {
                        Ok(_) => ApiResult::ok(()),
                        Err(e) => map_err(e),
                    })
                    .await
                    {
                        ApiResult { ok: true, .. } => {
                            *updated.lock().unwrap() += 1;
                        }
                        ApiResult {
                            error: Some(err), ..
                        } => {
                            *failed.lock().unwrap() += 1;
                            errors
                                .lock()
                                .unwrap()
                                .push(format!("{}: {}", row.path, err.message));
                        }
                        _ => {
                            *failed.lock().unwrap() += 1;
                            errors
                                .lock()
                                .unwrap()
                                .push(format!("{}: update failed", row.path));
                        }
                    }
                }
                None => {
                    *failed.lock().unwrap() += 1;
                }
            }
        }
    }))
    .buffer_unordered(CONCURRENCY)
    .collect::<()>()
    .await;

    let updated = Arc::try_unwrap(updated).unwrap().into_inner().unwrap();
    let failed = Arc::try_unwrap(failed).unwrap().into_inner().unwrap();
    let errors = Arc::try_unwrap(errors).unwrap().into_inner().unwrap();

    Ok(ApiResult::ok(PaperBackfillPublicationResult {
        total: updated + failed,
        updated,
        failed,
        errors,
    }))
}

async fn resolve_publication_for_backfill(
    doi: Option<&str>,
    arxiv_id: Option<&str>,
    title: &str,
) -> Option<String> {
    // 1. arXiv Atom journal_ref (most complete when present), then S2
    //    publicationVenue via map_arxiv_atom. Skip generic "arXiv".
    if let Some(arxiv) = arxiv_id.map(str::trim).filter(|s| !s.is_empty()) {
        if let Ok(meta) = fetch_arxiv_metadata(arxiv, None).await {
            if let Some(pub_value) = meta.publication.filter(|p| is_usable_publication(p)) {
                return Some(pub_value);
            }
        }
    }

    // 2. DOI → pick the longer usable of S2 publicationVenue and Crossref
    //    container-title. S2 wins on truncated ACL/NAACL titles; Crossref
    //    wins when it has the full proceedings string (ACL 2026 Long Papers).
    if let Some(doi) = doi.map(str::trim).filter(|s| !s.is_empty()) {
        let s2 = fetch_s2_venue_by_doi(doi).await;
        let crossref = match fetch_crossref_metadata(doi).await {
            Ok(meta) => meta.publication.filter(|p| is_usable_publication(p)),
            Err(_) => None,
        };
        if let Some(best) = better_publication(s2.as_deref(), crossref.as_deref()) {
            return Some(best);
        }
    }

    // 3. Title → Semantic Scholar (last resort; also uses publicationVenue).
    if let Ok(candidates) = search_papers(title, 1).await {
        if let Some(venue) = candidates
            .into_iter()
            .next()
            .and_then(|c| c.venue)
            .filter(|p| is_usable_publication(p))
        {
            return Some(venue);
        }
    }

    None
}
