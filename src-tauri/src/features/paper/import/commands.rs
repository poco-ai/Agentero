//! Magic-wand / identifier import commands.

use crate::core::error::{ApiResult, AppError};
use crate::core::fs::resolve_vault;
use crate::core::log_util::{trunc, OpTimer};
use crate::core::remote::parse_remote_handle;
use crate::features::paper::catalog::papers::PaperRecord;
use crate::features::paper::catalog::CapsCache;
use crate::features::paper::import::search_router::needs_s2_venue_enrichment;
use crate::features::paper::import::RemoteImportOps;
use crate::features::paper::import::{
    ImportLocalPdfArgs, ImportLocalPdfResult, LookupImportBatchArgs, LookupImportBatchResult,
    SkillImportResult, StageImportFileArgs, StageImportFileResult,
};
use crate::features::paper::scholar_api::sources::semantic_scholar::{
    better_publication, SemanticScholarApi,
};
use serde::Deserialize;
use std::sync::Arc;
use tauri::State;

/// Batch resolve identifiers and write papers into vault.
/// Deduplicates within the batch and against existing catalog entries.
#[tauri::command]
#[specta::specta]
pub async fn lookup_import_batch(
    app: tauri::AppHandle,
    remote: State<'_, Arc<dyn RemoteImportOps>>,
    cache: State<'_, CapsCache>,
    args: LookupImportBatchArgs,
) -> Result<ApiResult<LookupImportBatchResult>, String> {
    let n = args.texts.len();
    let op = OpTimer::start_with("lookup_import_batch", format!("count={n}"));
    let note_mode = crate::features::paper::import::note_mode_from_app(&app);
    let host_app = crate::features::host_hooks::wrap(&app);
    if let Some(session_id) = parse_remote_handle(&args.vault_path).map(str::to_owned) {
        let vault_id = std::path::PathBuf::from(&args.vault_path);
        let result = remote
            .import_by_identifier_batch_remote(&session_id, args, note_mode)
            .await;
        if let Ok(r) = &result {
            for paper in &r.imported {
                crate::features::lifecycle::emit_paper_imported(
                    Some(&host_app),
                    &vault_id,
                    &paper.id,
                );
            }
        }
        return Ok(op.finish_result(result));
    }
    let vault_path = args.vault_path.clone();
    let result =
        super::import_by_identifier_batch(args, Some(&host_app), Some(&cache), note_mode).await;
    if let Ok(batch) = &result {
        if let Ok(vault) = resolve_vault(&vault_path) {
            for paper in &batch.imported {
                crate::features::host_hooks::enqueue_preparation_plan(
                    &app,
                    &vault,
                    &paper.preparation,
                );
            }
        }
    }
    Ok(op.finish_result(result))
}

#[derive(Debug, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatImportExtractArgs {
    /// Pasted chat text, or a bare AI-chat share URL (chatgpt.com/share/...).
    pub text: String,
}

#[derive(Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatImportExtractResult {
    pub arxiv: Vec<String>,
    pub dois: Vec<String>,
    pub pmids: Vec<String>,
    /// Set when the input was a share link whose page we fetched.
    pub fetched_from: Option<String>,
}

/// Extract paper identifiers from pasted chat text or an AI-chat share URL
/// (#652). Deterministic scanner — no LLM; pasted text never leaves the
/// machine, share pages are fetched once and the page text is dropped after
/// extraction.
#[tauri::command]
#[specta::specta]
pub async fn chat_import_extract(
    args: ChatImportExtractArgs,
) -> Result<ApiResult<ChatImportExtractResult>, String> {
    let share_url = super::chat_extract::is_share_url(&args.text);
    let op = OpTimer::start_with(
        "chat_import_extract",
        if share_url { "share-url" } else { "text" },
    );
    let result: Result<(super::chat_extract::ExtractedIdentifiers, Option<String>), AppError> =
        if share_url {
            let url = args.text.trim().to_string();
            super::chat_extract::extract_from_share_url(&url)
                .await
                .map(|ids| (ids, Some(url)))
        } else {
            Ok((super::chat_extract::extract_identifiers(&args.text), None))
        };
    Ok(
        op.finish_result(result.map(|(ids, fetched_from)| ChatImportExtractResult {
            arxiv: ids.arxiv,
            dois: ids.dois,
            pmids: ids.pmids,
            fetched_from,
        })),
    )
}

#[derive(Debug, serde::Deserialize, specta::Type)]
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
#[specta::specta]
pub async fn skill_install(args: SkillInstallArgs) -> ApiResult<Vec<SkillImportResult>> {
    let op = OpTimer::start_with(
        "skill_install",
        format!("discovery_id={}", trunc(&args.discovery_id, 40)),
    );
    let result = super::install_discovered_skills(
        std::path::Path::new(&args.vault_path),
        &args.discovery_id,
        &args.selected_names,
    )
    .await;
    op.finish_result(result)
}

#[tauri::command]
#[specta::specta]
pub fn skill_discard(discovery_id: String) -> ApiResult<()> {
    let op = OpTimer::start_with(
        "skill_discard",
        format!("discovery_id={}", trunc(&discovery_id, 40)),
    );
    op.finish_result(super::discard_skill_discovery(&discovery_id))
}

/// Import local PDF file(s) into the vault as paper folders (copy + catalog + liteparse).
#[tauri::command]
#[specta::specta]
pub async fn paper_import_local_pdf(
    app: tauri::AppHandle,
    remote: State<'_, Arc<dyn RemoteImportOps>>,
    cache: State<'_, CapsCache>,
    args: ImportLocalPdfArgs,
) -> Result<ApiResult<ImportLocalPdfResult>, String> {
    let n = args.file_paths.len();
    let op = OpTimer::start_with("paper_import_local_pdf", format!("count={n}"));
    let note_mode = crate::features::paper::import::note_mode_from_app(&app);
    let host_app = crate::features::host_hooks::wrap(&app);
    let result = if let Some(session_id) = parse_remote_handle(&args.vault_path).map(str::to_owned)
    {
        let vault_id = std::path::PathBuf::from(&args.vault_path);
        let result = remote
            .import_local_pdfs_remote(&session_id, args, note_mode)
            .await;
        if let Ok(r) = &result {
            for paper in &r.papers {
                crate::features::lifecycle::emit_paper_imported(
                    Some(&host_app),
                    &vault_id,
                    &paper.id,
                );
            }
        }
        result
    } else {
        let vault_path = args.vault_path.clone();
        let result = super::import_local_pdfs(args, Some(&host_app), Some(&cache), note_mode).await;
        if let Ok(imported) = &result {
            if let Ok(vault) = resolve_vault(&vault_path) {
                for paper in &imported.papers {
                    crate::features::host_hooks::enqueue_preparation_plan(
                        &app,
                        &vault,
                        &paper.preparation,
                    );
                }
            }
        }
        result
    };
    Ok(op.finish_result_ok_extra(result, |r| {
        format!("imported={} errors={}", r.papers.len(), r.errors.len())
    }))
}

/// Stage a path-less OS drop (File bytes as base64) into `~/.agentero/import-tmp/`.
#[tauri::command]
#[specta::specta]
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

#[derive(Debug, Deserialize, specta::Type)]
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
#[specta::specta]
pub async fn paper_resolve_identifier(args: PaperResolveIdentifierArgs) -> ApiResult<PaperRecord> {
    let text = trunc(args.text.trim(), 60);
    let op = OpTimer::start_with("paper_resolve_identifier", format!("text={text}"));

    // Skill 分流不在 resolver 表内：由 extract_skill_source 判定。
    let try_identifier =
        agentero_core::features::paper::scholar_api::identifiers::extract_skill_source(&args.text)
            .is_none()
            && super::search_router::extract_primary_identifier(&args.text).is_some();

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

    match super::recognize::chain_resolve::resolve_metadata_chain(&args.text).await {
        Ok(mut meta) => {
            super::enrich_remote_urls(&mut meta);
            op.finish_ok();
            return ApiResult::ok(meta);
        }
        Err(e) => {
            log::warn!("chain resolve failed for {text}: {e}");
        }
    }

    let err = AppError::message(format!("could not resolve metadata for {text}"));
    op.finish_err(&err);
    crate::core::error::map_err(err)
}

/// Fill / replace `publication` from S2 when the current value is empty,
/// generic (`arXiv`), or a likely-truncated Crossref proceedings title.
async fn enrich_publication_from_s2(meta: &mut PaperRecord) {
    if !needs_s2_venue_enrichment(meta.publication.as_deref()) {
        return;
    }
    let s2 = SemanticScholarApi
        .fetch_venue_by_ids(meta.arxiv_id.as_deref(), meta.doi.as_deref())
        .await;
    if let Some(best) = better_publication(meta.publication.as_deref(), s2.as_deref()) {
        meta.publication = Some(best);
    }
}

#[derive(Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NotesTemplateSeedResult {
    pub created: bool,
}

/// Seed `{vault}/.agentero/templates/NOTES.md` with a starting template for
/// the `custom` paper-note mode. Never overwrites an existing template.
#[tauri::command]
#[specta::specta]
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
