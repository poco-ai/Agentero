//! `agentero import *`

use crate::commands::layout::import_layout_line;
use crate::error::CliError;

use crate::resolve::{resolve_vault, GlobalOpts};
use agentero_core::features::import as paper_import;
use agentero_core::features::import::{
    ImportLocalPdfArgs, LookupImportResult, NoteShellMode, PaperImportArgs,
};
use agentero_core::features::pdf::layout_analyze::{self, AnalyzeLayoutArgs};
use agentero_core::features::zotero;

use serde_json::{json, Value};

use std::path::{Path, PathBuf};

pub async fn import_bib(
    globals: &GlobalOpts,
    file: &str,
    parent: &str,
    format: &str,
) -> Result<Value, CliError> {
    let vault = resolve_vault(globals)?;
    let content = crate::dispatch::input_text(file)?;
    if matches!(format, "bibtex" | "biblatex")
        && !content
            .lines()
            .any(|line| line.trim_start().starts_with('@'))
        || format == "ris"
            && !content
                .lines()
                .any(|line| line.trim_start().starts_with("TY  -"))
    {
        return Err(CliError::usage(format!("input is not {format}")));
    }
    let result = zotero::io::import_catalog_cancellable(
        PaperImportArgs {
            vault_path: vault.to_string_lossy().to_string(),
            parent_dir: Some(parent.to_string()),
            content,
            translator_base_url: globals.translator_base_url(),
        },
        None,
        NoteShellMode::Standard,
        Some(crate::CLI_TASK_ID),
    )
    .await
    .map_err(|e| CliError::import_failed(e.to_string()))?;

    let mut items: Vec<_> = result
        .paths
        .into_iter()
        .map(|path| json!({"path":path,"outcome":"created"}))
        .collect();
    for _ in 0..result.skipped {
        items.push(json!({"outcome":"existing"}));
    }
    for error in result.errors {
        items.push(json!({"outcome":"failed","message":error}));
    }
    Ok(json!({"items":items}))
}

pub async fn import_pdf(
    globals: &GlobalOpts,
    files: &[PathBuf],
    parent: &str,
    no_recognize: bool,
    layout: bool,
) -> Result<Value, CliError> {
    let vault = resolve_vault(globals)?;
    let mut file_paths = Vec::with_capacity(files.len());
    for f in files {
        let abs = if f.is_absolute() {
            f.clone()
        } else {
            std::env::current_dir()?.join(f)
        };
        let canonical = agentero_core::fs::canonicalize_best_effort(&abs);
        file_paths.push(canonical.to_string_lossy().to_string());
    }

    let result = paper_import::import_local_pdfs(
        ImportLocalPdfArgs {
            vault_path: vault.to_string_lossy().to_string(),
            parent_dir: parent.to_string(),
            file_paths,
            entries: vec![],
            task_id: Some(crate::CLI_TASK_ID.into()),
            recognize_sync: !no_recognize,
            translator_base_url: globals.translator_base_url(),
        },
        None,
        None,
        NoteShellMode::Standard,
    )
    .await
    .map_err(|e| CliError::import_failed(e.to_string()))?;

    let mut items: Vec<_> = result
        .papers
        .iter()
        .map(|paper| json!({"path":paper.path,"id":paper.id,"outcome":"created"}))
        .collect();
    for error in result.errors {
        items.push(json!({"outcome":"failed","message":error}));
    }
    if layout && !result.papers.is_empty() {
        match analyze_imported_papers(&vault, &result.papers).await {
            Ok((out, _)) => {
                for row in out {
                    if row["ok"] == false {
                        items.push(
                            json!({"path":row["path"],"outcome":"failed","message":row["error"]}),
                        );
                    }
                }
            }
            Err(error) => items.push(json!({"outcome":"failed","message":error})),
        }
    }
    Ok(json!({"items":items}))
}

/// Run `layout analyze` for every freshly imported paper that has a local PDF.
///
/// Returns `(per-paper JSON results, human lines)`. When no remote provider is
/// configured this is a single `Err(message)` so the caller prints one warning
/// line instead of one error per paper; individual paper failures only warn.
async fn analyze_imported_papers(
    vault: &Path,
    papers: &[LookupImportResult],
) -> Result<(Vec<Value>, Vec<String>), String> {
    // Preflight the shared desktop settings once. `layout.backend = local`
    // (ONNX in the WebView) and a missing provider card both land here.
    if let Err(err) = layout_analyze::settings::resolve_provider_settings(None, None, None, None) {
        return Err(format!(
            "layout analysis skipped — {err}; configure a remote provider in \
             Settings → Layout, or run `agentero paper analyze <ref> --provider paddle|mineru`"
        ));
    }

    let mut results = Vec::new();
    let mut lines = Vec::new();
    for paper in papers {
        if agentero_core::cancel::is_cancelled(crate::CLI_TASK_ID) {
            break;
        }
        if !paper.pdf {
            continue;
        }
        let args = AnalyzeLayoutArgs::new(vault.to_path_buf(), paper.path.clone());
        match layout_analyze::analyze_paper_layout(args).await {
            Ok(outcome) => {
                results.push(json!({
                    "path": paper.path,
                    "ok": true,
                    "provider": outcome.provider,
                    "fromCache": outcome.from_cache,
                    "regionCount": outcome.region_count,
                    "indexCount": outcome.index_count,
                    "pageCount": outcome.page_count,
                    "elapsedMs": outcome.elapsed_ms,
                }));
                lines.push(import_layout_line(&paper.path, &outcome));
            }
            Err(err) => {
                let message = err.to_string();
                results.push(json!({
                    "path": paper.path,
                    "ok": false,
                    "error": message,
                }));
                lines.push(format!(
                    "warning: layout analysis failed for {}: {message}",
                    paper.path
                ));
            }
        }
    }
    Ok((results, lines))
}
