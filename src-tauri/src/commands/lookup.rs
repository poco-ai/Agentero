//! Magic-wand / identifier import commands + catalog export/import via Translator.
//! Also `paper_parse_body` (liteparse → PAPER.md).

use crate::error::AppError;
use crate::log_util::{trunc, OpTimer};
use crate::services::lookup::{
    self, AssetDownloadResult, ImportLocalPdfArgs, ImportLocalPdfResult, LookupImportArgs,
    LookupImportResult, PaperDownloadAssetsArgs, PaperExportArgs, PaperExportResult,
    PaperImportArgs, PaperImportResult, StageImportFileArgs, StageImportFileResult,
    DEFAULT_TRANSLATOR_BASE_URL,
};
use crate::services::pdf_parse::{self, PaperParseBodyArgs, PaperParseResult};
use crate::services::remote::{import_bridge, parse_remote_handle, RemoteRegistry};
use serde::Serialize;
use std::sync::Arc;
use tauri::State;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslatorConfig {
    /// Placeholder base URL for Zotero translation-server.
    pub default_base_url: String,
}

/// Return default Translator Runtime base URL (Settings default).
#[tauri::command]
pub fn lookup_translator_config() -> Result<TranslatorConfig, AppError> {
    Ok(TranslatorConfig {
        default_base_url: DEFAULT_TRANSLATOR_BASE_URL.to_string(),
    })
}

/// Resolve identifier via Translator (placeholder URL) and write paper into vault.
/// Always downloads PDF; arXiv also downloads and unpacks LaTeX into `source/`.
/// Remote vaults (`remote:<sessionId>`) stage locally then SFTP-upload + catalog push.
#[tauri::command]
pub async fn lookup_import(
    app: tauri::AppHandle,
    registry: State<'_, Arc<RemoteRegistry>>,
    args: LookupImportArgs,
) -> Result<LookupImportResult, AppError> {
    let id = trunc(&args.text, 80);
    let op = OpTimer::start_with("lookup_import", format!("query={id}"));
    let result = if let Some(session_id) = parse_remote_handle(&args.vault_path) {
        match registry.get(session_id).await {
            Ok(session) => import_bridge::import_by_identifier_remote(session, args).await,
            Err(e) => Err(e),
        }
    } else {
        lookup::import_by_identifier_with_progress(args, Some(&app)).await
    };
    op.finish(result)
}

/// Download PDF (+ arXiv LaTeX) for an existing paper folder that is missing local assets.
/// When no TeX remains after download, also tries liteparse → PAPER.md.
#[tauri::command]
pub async fn paper_download_assets(
    app: tauri::AppHandle,
    registry: State<'_, Arc<RemoteRegistry>>,
    args: PaperDownloadAssetsArgs,
) -> Result<AssetDownloadResult, AppError> {
    let path = trunc(&args.path, 120);
    let op = OpTimer::start_with("paper_download_assets", format!("path={path}"));
    let result = if let Some(session_id) = parse_remote_handle(&args.vault_path) {
        match registry.get(session_id).await {
            Ok(session) => import_bridge::download_paper_assets_remote(session, args).await,
            Err(e) => Err(e),
        }
    } else {
        lookup::download_paper_assets_with_progress(args, Some(&app)).await
    };
    op.finish(result)
}

/// Import local PDF file(s) into the vault as paper folders (copy + catalog + liteparse).
#[tauri::command]
pub async fn paper_import_local_pdf(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: ImportLocalPdfArgs,
) -> Result<ImportLocalPdfResult, AppError> {
    let n = args.file_paths.len();
    let op = OpTimer::start_with("paper_import_local_pdf", format!("count={n}"));
    let result = if let Some(session_id) = parse_remote_handle(&args.vault_path) {
        match registry.get(session_id).await {
            Ok(session) => import_bridge::import_local_pdfs_remote(session, args).await,
            Err(e) => Err(e),
        }
    } else {
        lookup::import_local_pdfs(args).await
    };
    op.finish_extra(result, |r| {
        format!("imported={} errors={}", r.papers.len(), r.errors.len())
    })
}

/// Stage a path-less OS drop (File bytes as base64) into `~/.agentero/import-tmp/`.
#[tauri::command]
pub fn paper_stage_import_file(
    args: StageImportFileArgs,
) -> Result<StageImportFileResult, AppError> {
    let name = trunc(&args.file_name, 80);
    let op = OpTimer::start_with("paper_stage_import_file", format!("name={name}"));
    op.finish(lookup::stage_import_file(args))
}

/// Generate PAPER.md from PDF via liteparse when the paper has no TeX.
/// Remote vaults: pull PDF to work mirror → parse → SFTP put `PAPER.md`.
#[tauri::command]
pub async fn paper_parse_body(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: PaperParseBodyArgs,
) -> Result<PaperParseResult, AppError> {
    let path = trunc(&args.path, 120);
    let op = OpTimer::start_with("paper_parse_body", format!("path={path}"));
    let result = if let Some(session_id) = parse_remote_handle(&args.vault_path) {
        match registry.get(session_id).await {
            Ok(session) => {
                import_bridge::parse_paper_body_remote(session, &args.path, args.force).await
            }
            Err(e) => Err(e),
        }
    } else {
        pdf_parse::parse_paper_body(args).await
    };
    op.finish(result)
}

/// Export catalog papers via Translator `POST /export` (Zotero JSON array → BibTeX/RIS/…).
#[tauri::command]
pub async fn paper_export(args: PaperExportArgs) -> Result<PaperExportResult, AppError> {
    let format = args.format.as_deref().unwrap_or("bibtex");
    let op = OpTimer::start_with("paper_export", format!("format={format}"));
    op.finish(lookup::export_catalog(args).await)
}

/// Import BibTeX/RIS/… via Translator `POST /import`, write papers into vault + catalog.
#[tauri::command]
pub async fn paper_import(
    registry: State<'_, Arc<RemoteRegistry>>,
    args: PaperImportArgs,
) -> Result<PaperImportResult, AppError> {
    let op = OpTimer::start("paper_import");
    let result = if let Some(session_id) = parse_remote_handle(&args.vault_path) {
        match registry.get(session_id).await {
            Ok(session) => import_bridge::import_catalog_remote(session, args).await,
            Err(e) => Err(e),
        }
    } else {
        lookup::import_catalog(args).await
    };
    op.finish_extra(result, |r| {
        format!("imported={} skipped={}", r.imported, r.skipped)
    })
}
