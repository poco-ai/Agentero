//! Vault paper catalog: `.agentero/catalog.sqlite`.
//!
//! Authoritative store for paper set + structured metadata.
//! See `docs/backend/catalog.md`.

pub mod caps;
pub mod papers;
pub mod reading_activity;
mod schema;
pub mod sidecar;

pub use caps::{
    find_local_pdf, has_local_pdf, has_local_tex, has_paper_md, probe_paper_caps, CapsCache,
    PaperCaps,
};
pub use schema::{
    catalog_db_path, ensure_catalog, evict_catalog_conn, schema_version, with_catalog,
    SCHEMA_VERSION,
};

#[cfg(feature = "desktop")]
pub mod commands;

use crate::core::error::AppError;
use crate::core::fs::{normalize_rel, sanitize_vault_rel};
use std::path::Path;

/// Validate a move under `papers/` without mutating the filesystem or catalog.
pub(crate) fn plan_paper_move_under(
    vault: &Path,
    from_rel: &str,
    dest_parent_rel: &str,
) -> Result<(String, String), AppError> {
    let from = sanitize_vault_rel(from_rel).map_err(AppError::message)?;
    let dest_norm = normalize_rel(dest_parent_rel);
    let dest_parent = if dest_norm.is_empty() {
        "papers".to_string()
    } else {
        sanitize_vault_rel(&dest_norm).map_err(AppError::message)?
    };
    if from == "papers" {
        return Err(AppError::message("cannot move this path"));
    }
    if dest_parent != "papers" && !dest_parent.starts_with("papers/") {
        return Err(AppError::message("destination must be under papers/"));
    }
    // Reject moving a folder into itself or its own descendant.
    if dest_parent == from || dest_parent.starts_with(&format!("{from}/")) {
        return Err(AppError::message("cannot move a folder into itself"));
    }
    let base = from.rsplit('/').next().unwrap_or(from.as_str()).to_string();
    let new_rel = format!("{dest_parent}/{base}");
    if new_rel == from {
        return Ok((from.clone(), from));
    }
    let from_abs = vault.join(&from);
    if !from_abs.exists() {
        return Err(AppError::message("source path does not exist"));
    }
    let new_abs = vault.join(&new_rel);
    if new_abs.exists() {
        return Err(AppError::message("target already exists"));
    }
    Ok((from, new_rel))
}

/// Move an item under a new `papers/` parent on disk and rewrite matching
/// catalog path prefixes. Never overwrites; rejects escapes and moving a
/// folder into itself or its own descendant. Idempotent: returns the
/// unchanged path when the item is already in the destination folder.
pub fn move_paper_under(
    vault: &Path,
    from_rel: &str,
    dest_parent_rel: &str,
) -> Result<String, AppError> {
    let (from, new_rel) = plan_paper_move_under(vault, from_rel, dest_parent_rel)?;
    if new_rel == from {
        return Ok(from);
    }
    let from_abs = vault.join(&from);
    let new_abs = vault.join(&new_rel);
    if let Some(parent) = new_abs.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(&from_abs, &new_abs)?;
    papers::move_under_path(vault, &from, &new_rel)?;
    Ok(new_rel)
}
