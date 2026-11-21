//! Export selected catalog records using the shared Zotero translator.
use crate::dispatch::{required, string, strings};
use crate::error::{CliError, ExitCode};
use crate::resolve::{resolve_paper, resolve_vault, GlobalOpts};
use agentero_core::features::{catalog::papers, zotero};
use serde_json::{json, Value};
use std::io::Write;
use std::path::Path;

pub async fn selected(a: &Value, g: &GlobalOpts) -> Result<Value, CliError> {
    let vault = resolve_vault(g)?;
    let sources = strings(a, "paper");
    let tags = strings(a, "tag");
    let mut rows = if sources.is_empty() {
        papers::list_all(&vault)?
    } else {
        let mut selected = Vec::new();
        for source in sources {
            let paper = resolve_paper(&vault, &source, g)?;
            if !selected
                .iter()
                .any(|r: &papers::PaperRecord| r.path == paper.path)
            {
                selected.push(paper)
            }
        }
        selected
    };
    rows.retain(|row| {
        tags.iter()
            .all(|tag| row.tags.iter().any(|t| t.name.eq_ignore_ascii_case(tag)))
    });
    let format = required(a, "format")?;
    let content = if rows.is_empty() {
        String::new()
    } else {
        zotero::io::export_records(&rows, format, g.translator_base_url().as_deref())
            .await?
            .content
    };
    let output = string(a, "output").unwrap_or("-");
    if output == "-" {
        return Ok(json!({"format":format,"count":rows.len(),"content":content}));
    }
    let path = Path::new(output);
    let mut temporary = tempfile::NamedTempFile::new_in(
        path.parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new(".")),
    )?;
    temporary.write_all(content.as_bytes())?;
    temporary.persist_noclobber(path).map_err(|e| {
        if e.error.kind() == std::io::ErrorKind::AlreadyExists {
            CliError::new(
                "already_exists",
                "output file already exists",
                ExitCode::Conflict,
            )
        } else {
            CliError::from(e.error)
        }
    })?;
    Ok(json!({"format":format,"count":rows.len(),"path":output}))
}
