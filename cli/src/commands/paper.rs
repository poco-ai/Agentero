//! Terminal-only paper preparation and cross-vault organization.
use crate::error::CliError;
use crate::resolve::{paper_dir, resolve_paper, resolve_vault, GlobalOpts};
use agentero_core::features::import::{
    self,
    pdf_parse::{self, PaperParseBodyArgs},
};
use agentero_core::features::paper::discovery::coolpapers::{self, FetchNotesRequest};
use serde_json::{json, Value};
use std::path::Path;
pub async fn fetch_notes(globals: &GlobalOpts, ref_: &str) -> Result<Value, CliError> {
    let vault = resolve_vault(globals)?;
    let paper = resolve_paper(&vault, ref_, globals)?;
    coolpapers::fetch_notes(FetchNotesRequest {
        vault: &vault,
        paper_rel: &paper.path,
        catalog_id: Some(paper.id.as_str()),
        source_url: paper.source_url.as_deref(),
        arxiv_id: paper.arxiv_id.as_deref(),
        title: Some(paper.title.as_str()),
    })
    .await?;
    let rel = format!("{}/NOTES.md", paper.path);
    let bytes = std::fs::read(vault.join(&rel))?;
    Ok(
        json!({"path":rel,"revision":agentero_core::features::evidence::content_revision(&bytes),"bytes":bytes.len()}),
    )
}
pub fn organize(
    g: &GlobalOpts,
    source: &str,
    to_vault: &Path,
    parent: &str,
) -> Result<Value, CliError> {
    let vault = resolve_vault(g)?;
    let paper = resolve_paper(&vault, source, g)?;
    let added = agentero_core::features::catalog::add_paper::add_paper(
        &vault,
        &paper.path,
        to_vault,
        parent,
    )?;
    Ok(
        json!({"changed":true,"preview":false,"items":[{"id":paper.id,"path":added.new_rel,"outcome":added.mode}]}),
    )
}
pub async fn parse(globals: &GlobalOpts, ref_: &str, force: bool) -> Result<Value, CliError> {
    let vault = resolve_vault(globals)?;
    let paper = resolve_paper(&vault, ref_, globals)?;
    let dir = paper_dir(&vault, &paper.path);
    if import::has_local_tex(&dir) {
        return Err(CliError::message(
            "paper has TeX source; PAPER.md is optional — not forcing liteparse",
        ));
    }
    if !import::has_local_pdf(&dir) {
        return Err(CliError::new(
            "asset_missing",
            "no local PDF to parse; run paper download first",
            crate::error::ExitCode::Vault,
        ));
    }
    if force && dir.join("PAPER.md").is_file() {
        let generated = std::fs::read_to_string(dir.join("source/.paper-md-revision")).ok();
        let current = agentero_core::features::evidence::content_revision(&std::fs::read(
            dir.join("PAPER.md"),
        )?);
        if generated.as_deref() != Some(current.as_str()) {
            return Err(CliError::new(
                "revision_conflict",
                "PAPER.md contains untracked edits; preserve it before extracting a new body",
                crate::error::ExitCode::Conflict,
            ));
        }
    }
    let result = pdf_parse::parse_paper_body(
        PaperParseBodyArgs {
            vault_path: vault.to_string_lossy().to_string(),
            path: paper.path.clone(),
            force,
            task_id: Some(crate::CLI_TASK_ID.into()),
        },
        None,
    )
    .await?;
    if let Some(message) = result.error {
        return Err(CliError::message(message));
    }
    if !dir.join("PAPER.md").is_file() {
        return Err(CliError::message(result.messages.join("\n")));
    }
    Ok(
        json!({"paper":paper.path,"assets":[{"id":"body","path":format!("{}/PAPER.md",paper.path),"outcome":"available"}]}),
    )
}
pub async fn download_selected(a: &Value, g: &GlobalOpts) -> Result<Value, CliError> {
    let vault = resolve_vault(g)?;
    let p = resolve_paper(&vault, crate::dispatch::required(a, "paper")?, g)?;
    let selection = crate::dispatch::strings(a, "asset");
    let wants = |name: &str| selection.is_empty() || selection.iter().any(|v| v == name);
    let out = import::download::fetch_selected_assets(
        &vault,
        &p,
        wants("pdf"),
        wants("tex"),
        a["refresh"] == true,
    )
    .await?;
    let assets = [("pdf", out.pdf), ("tex", out.tex)]
        .into_iter()
        .filter(|(k, _)| wants(k))
        .map(|(k, ok)| json!({"id":k,"outcome":if ok{"available"}else{"unavailable"}}))
        .collect::<Vec<_>>();
    Ok(json!({"paper":p.path,"assets":assets}))
}
