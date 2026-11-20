//! Per-turn publication receipts for files an agent has already written.
use crate::error::AppError;
use crate::features::open_request::normalize_vault_rel;
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const TURN_ENV: &str = "AGENTERO_TURN";

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PresentedFile {
    pub vault: String,
    pub path: String,
    pub title: Option<String>,
}

impl PresentedFile {
    pub fn preview_kind(&self) -> Option<&'static str> {
        let ext = Path::new(&self.path)
            .extension()?
            .to_str()?
            .to_ascii_lowercase();
        match ext.as_str() {
            "md" | "mdx" | "markdown" => Some("markdown"),
            "pdf" => Some("pdf"),
            "htm" | "html" => Some("html"),
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "avif" | "ico" => {
                Some("image")
            }
            "txt" | "json" | "bib" | "tex" | "css" | "ts" | "tsx" | "js" | "jsx" | "rs"
            | "toml" | "yaml" | "yml" | "excalidraw" => Some("text"),
            _ => None,
        }
    }
}

pub fn present_files(
    vault: &Path,
    paths: &[String],
    title: Option<&str>,
) -> Result<Vec<PresentedFile>, AppError> {
    if paths.is_empty() || (paths.len() != 1 && title.is_some()) {
        return Err(AppError::domain(
            "usage",
            "present requires files; a title applies to one file",
        ));
    }
    let owner = vault.to_string_lossy().into_owned();
    let vault = std::fs::canonicalize(vault)?;
    let mut files = Vec::new();
    for input in paths {
        let path = normalize_vault_rel(input)?;
        let resolved = std::fs::canonicalize(vault.join(&path))?;
        let actual = resolved
            .strip_prefix(&vault)
            .map_err(|_| AppError::domain("outside_vault", "file resolves outside this vault"))?;
        if !resolved.is_file()
            || actual
                .components()
                .any(|c| c.as_os_str().eq_ignore_ascii_case(".agentero"))
        {
            return Err(AppError::domain(
                "invalid_artifact",
                "expected a user file inside the vault",
            ));
        }
        files.push(PresentedFile {
            vault: owner.clone(),
            path,
            title: title.map(str::to_owned),
        });
    }
    Ok(files)
}
