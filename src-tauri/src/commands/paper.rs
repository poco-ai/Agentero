//! Paper metadata commands — catalog.sqlite is authoritative.

use crate::error::AppError;
use crate::services::catalog::papers::{self, PaperRecord};
use crate::services::fs::{normalize_rel, path_escapes_root};
use serde::Deserialize;
use std::path::PathBuf;

/// Validate + normalize the vault path argument.
fn vault_arg(raw: &str) -> Result<PathBuf, AppError> {
    let vault = PathBuf::from(raw.trim());
    if !vault.is_dir() {
        return Err(AppError::VaultNotFound(format!(
            "vault path is not a directory: {}",
            vault.display()
        )));
    }
    Ok(vault)
}

/// Normalize a vault-relative path argument and reject `..` traversal.
fn rel_path_arg(raw: &str) -> Result<String, AppError> {
    if path_escapes_root(raw) {
        return Err(AppError::invalid("invalid path"));
    }
    let path = normalize_rel(raw);
    if path.is_empty() {
        return Err(AppError::invalid("path is required"));
    }
    Ok(path)
}

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
pub fn paper_get(args: PaperGetArgs) -> Result<PaperRecord, AppError> {
    let vault = vault_arg(&args.vault_path)?;

    let row = if let Some(path) = args
        .path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        papers::get_by_path(&vault, &rel_path_arg(path)?)?
    } else if let Some(id) = args.id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        papers::get_by_id(&vault, id)?
    } else {
        return Err(AppError::invalid("path or id is required"));
    };

    row.ok_or_else(|| AppError::PaperNotFound("paper not found in catalog".into()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperListArgs {
    pub vault_path: String,
}

/// List all papers for the library table (catalog.sqlite).
#[tauri::command]
pub fn paper_list(args: PaperListArgs) -> Result<Vec<PaperRecord>, AppError> {
    let vault = vault_arg(&args.vault_path)?;
    papers::list_all(&vault)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperDeleteArgs {
    pub vault_path: String,
    /// Vault-relative path of a paper folder, or an org folder under `papers/`.
    /// Deletes that row and any papers nested under `path/`.
    pub path: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperDeleteResult {
    /// Number of catalog rows removed.
    pub removed: usize,
}

/// Remove paper row(s) from catalog.sqlite (does not delete files).
#[tauri::command]
pub fn paper_delete(args: PaperDeleteArgs) -> Result<PaperDeleteResult, AppError> {
    let vault = vault_arg(&args.vault_path)?;
    let path = rel_path_arg(&args.path)?;
    let removed = papers::delete_under_path(&vault, &path)?;
    Ok(PaperDeleteResult { removed })
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
pub fn paper_set_is_read(args: PaperSetIsReadArgs) -> Result<PaperRecord, AppError> {
    let vault = vault_arg(&args.vault_path)?;
    let path = rel_path_arg(&args.path)?;
    papers::set_is_read(&vault, &path, args.is_read)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperMoveArgs {
    pub vault_path: String,
    /// Vault-relative item to move (paper folder, org folder, or file under `papers/`).
    pub from_rel: String,
    /// Vault-relative destination parent (`papers` or under `papers/`).
    pub dest_parent_rel: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperMoveResult {
    /// New vault-relative path of the moved item.
    pub new_rel: String,
}

/// Move an item into another `papers/` folder on disk and rewrite matching
/// catalog path prefixes. Never overwrites an existing target.
#[tauri::command]
pub fn paper_move(args: PaperMoveArgs) -> Result<PaperMoveResult, AppError> {
    let vault = vault_arg(&args.vault_path)?;
    let from = rel_path_arg(&args.from_rel)?;
    let dest_raw = if path_escapes_root(&args.dest_parent_rel) {
        return Err(AppError::invalid("invalid path"));
    } else {
        normalize_rel(&args.dest_parent_rel)
    };
    let dest_parent = if dest_raw.is_empty() {
        "papers".to_string()
    } else {
        dest_raw
    };
    if from == "papers" {
        return Err(AppError::invalid("cannot move this path"));
    }
    if dest_parent != "papers" && !dest_parent.starts_with("papers/") {
        return Err(AppError::invalid("destination must be under papers/"));
    }
    // Reject moving a folder into itself or its own descendant.
    if dest_parent == from || dest_parent.starts_with(&format!("{from}/")) {
        return Err(AppError::invalid("cannot move a folder into itself"));
    }
    let base = from.rsplit('/').next().unwrap_or(from.as_str()).to_string();
    let new_rel = format!("{dest_parent}/{base}");
    if new_rel == from {
        return Err(AppError::invalid("already in this folder"));
    }
    let from_abs = vault.join(&from);
    if !from_abs.exists() {
        return Err(AppError::PaperNotFound("source path does not exist".into()));
    }
    let new_abs = vault.join(&new_rel);
    if new_abs.exists() {
        return Err(AppError::invalid("target already exists"));
    }
    if let Some(parent) = new_abs.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(&from_abs, &new_abs)?;
    papers::move_under_path(&vault, &from, &new_rel)?;
    Ok(PaperMoveResult { new_rel })
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
pub fn paper_set_tags(args: PaperSetTagsArgs) -> Result<PaperRecord, AppError> {
    let vault = vault_arg(&args.vault_path)?;
    let path = rel_path_arg(&args.path)?;
    papers::set_tags(&vault, &path, &args.tags)
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
pub fn paper_rescan(args: PaperRescanArgs) -> Result<PaperRescanResult, AppError> {
    use crate::log_util::OpTimer;

    let op = OpTimer::start("paper_rescan");
    op.finish_extra(
        vault_arg(&args.vault_path)
            .and_then(|vault| papers::rebuild_from_disk(&vault))
            .map(|count| PaperRescanResult { count }),
        |r| format!("count={}", r.count),
    )
}
