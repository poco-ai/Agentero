//! Vault paper catalog: `.agentero/catalog.sqlite`.
//!
//! Authoritative store for paper set + structured metadata.
//! See `docs/backend/catalog.md`.

pub mod add_paper;
pub mod copy_paper;
pub mod move_paper;
pub mod papers;
pub mod properties;
mod schema;
pub mod sidecar;

pub use crate::features::paper::capabilities::{
    find_local_pdf, has_local_pdf, has_local_tex, has_paper_md, probe_paper_caps, CapsCache,
    PaperCaps,
};
pub use schema::{
    catalog_db_path, ensure_catalog, evict_catalog_conn, schema_version, with_catalog,
    SCHEMA_VERSION,
};

use crate::error::AppError;
use crate::fs::{normalize_rel, sanitize_vault_rel};
use std::path::Path;

/// Validate a move under `papers/` without mutating the filesystem or catalog.
pub fn plan_paper_move_under(
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

/// Validate a copy under `papers/` without mutating the filesystem or catalog.
///
/// Same destination rules as a move, but the source must be a real paper/org
/// folder below `papers/` and an existing target is always an error (a copy
/// never overwrites).
pub fn plan_paper_copy_under(
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
    if from.is_empty() || from == "papers" {
        return Err(AppError::message("cannot copy this path"));
    }
    if !from.starts_with("papers/") {
        return Err(AppError::message("source must be under papers/"));
    }
    if dest_parent != "papers" && !dest_parent.starts_with("papers/") {
        return Err(AppError::message("destination must be under papers/"));
    }
    // Reject copying a folder into itself or its own descendant.
    if dest_parent == from || dest_parent.starts_with(&format!("{from}/")) {
        return Err(AppError::message("cannot copy a folder into itself"));
    }
    let base = from.rsplit('/').next().unwrap_or(from.as_str()).to_string();
    let new_rel = format!("{dest_parent}/{base}");
    let from_abs = vault.join(&from);
    if !from_abs.is_dir() {
        return Err(AppError::message("source path does not exist"));
    }
    if new_rel == from || vault.join(&new_rel).exists() {
        return Err(AppError::message("target already exists"));
    }
    Ok((from, new_rel))
}

/// Related on-disk paths for one paper, in reading order: paper folder,/// NOTES.md, PAPER.md, marks/, the local PDF, and source/ when TeX exists.
///
/// Shared by CLI `paper paths` and MCP `paper_paths`; never reads file bodies.
pub fn paper_related_paths(vault: &Path, paper_rel: &str) -> Result<Vec<String>, AppError> {
    let paper = sanitize_vault_rel(paper_rel).map_err(AppError::message)?;
    if paper.is_empty() {
        return Err(AppError::message("paper path is required"));
    }
    let dir = vault.join(&paper);
    if !dir.is_dir() {
        return Err(AppError::message(format!(
            "paper folder not found: {paper}"
        )));
    }
    let mut paths = vec![paper.clone()];
    for name in ["NOTES.md", "PAPER.md"] {
        let rel = format!("{paper}/{name}");
        if vault.join(&rel).is_file() {
            paths.push(rel);
        }
    }
    if dir.join("marks").is_dir() {
        paths.push(format!("{paper}/marks"));
    }
    if let Some(pdf) = find_local_pdf(&dir) {
        if let Ok(rel) = pdf.strip_prefix(vault) {
            paths.push(
                rel.to_string_lossy()
                    .replace('\\', "/")
                    .trim_start_matches('/')
                    .to_string(),
            );
        }
    }
    if has_local_tex(&dir) && dir.join("source").is_dir() {
        paths.push(format!("{paper}/source"));
    }
    Ok(paths)
}

/// Move an item under a new `papers/` parent on disk and rewrite matching
/// catalog path prefixes and incoming links. Uses a fresh Wiki index with no
/// in-process dirty editors. Never overwrites; rejects escapes and moving a
/// folder into itself or its own descendant. Idempotent: returns the
/// unchanged path when the item is already in the destination folder.
pub fn move_paper_under(
    vault: &Path,
    from_rel: &str,
    dest_parent_rel: &str,
) -> Result<String, AppError> {
    let mut index = crate::features::vault::rename::WikiIndex::default();
    move_paper::move_with_index(vault, from_rel, dest_parent_rel, &[], &mut index)
        .map(|result| result.new_rel)
}

/// Move a paper folder from one vault to another.
///
/// The source paper is removed from `from_vault` catalog and inserted into
/// `to_vault` catalog with its new path. The paper directory (PDF, source,
/// marks, attachments, assets) is moved on disk. Returns the new vault-relative
/// path inside `to_vault`.
///
/// Errors if either vault is not initialized, the paper is missing, the
/// destination already exists, or the destination vault already has a paper
/// with the same id.
pub fn migrate_paper_between_vaults(
    from_vault: &Path,
    from_rel: &str,
    to_vault: &Path,
    to_parent_rel: &str,
) -> Result<String, AppError> {
    if !catalog_db_path(from_vault).is_file() {
        return Err(AppError::message(format!(
            "source is not a vault: {}",
            from_vault.display()
        )));
    }
    if !catalog_db_path(to_vault).is_file() {
        return Err(AppError::message(format!(
            "destination is not a vault: {}",
            to_vault.display()
        )));
    }
    if from_vault == to_vault {
        return Err(AppError::message(
            "source and destination vault are the same; use move_paper_under instead",
        ));
    }

    let from = sanitize_vault_rel(from_rel).map_err(AppError::message)?;
    if from == "papers" {
        return Err(AppError::message("cannot move papers/ root"));
    }

    let to_parent = {
        let dest_norm = normalize_rel(to_parent_rel);
        let dest_parent = if dest_norm.is_empty() {
            "papers".to_string()
        } else {
            sanitize_vault_rel(&dest_norm).map_err(AppError::message)?
        };
        if dest_parent != "papers" && !dest_parent.starts_with("papers/") {
            return Err(AppError::message("destination must be under papers/"));
        }
        dest_parent
    };

    let Some(record) = papers::get_by_path(from_vault, &from)? else {
        return Err(AppError::message(format!("paper not found: {from}")));
    };

    let base = from.rsplit('/').next().unwrap_or(&from).to_string();
    let to = format!("{to_parent}/{base}");

    let from_abs = from_vault.join(&from);
    let to_abs = to_vault.join(&to);
    if to_abs.exists() {
        return Err(AppError::message(format!("target already exists: {to}")));
    }

    let dst_papers = papers::list_all(to_vault)?;
    if dst_papers.iter().any(|p| p.id == record.id) {
        return Err(AppError::message(format!(
            "destination vault already has paper id '{}'",
            record.id
        )));
    }

    move_dir_all(&from_abs, &to_abs)?;
    papers::delete_under_path(from_vault, &from)?;

    let mut new_record = record;
    new_record.path = to.clone();
    new_record.updated_at = crate::time::now_rfc3339_millis();
    papers::upsert_paper(to_vault, &new_record)?;

    Ok(to)
}

/// Move a directory tree, trying a fast rename first and falling back to
/// copy-and-delete when the source and destination are on different devices.
fn move_dir_all(src: &Path, dst: &Path) -> Result<(), AppError> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if std::fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    let created_target = !dst.exists();
    if let Err(error) = copy_dir_all(src, dst) {
        // Never leave a half-copied target behind: it would block the retry
        // with "target already exists" while the source is still intact.
        if created_target {
            let _ = std::fs::remove_dir_all(dst);
        }
        return Err(error);
    }
    std::fs::remove_dir_all(src)?;
    Ok(())
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), AppError> {
    if !src.is_dir() {
        return Err(AppError::message(format!(
            "source is not a directory: {}",
            src.display()
        )));
    }
    std::fs::create_dir_all(dst)?;
    for entry in walkdir::WalkDir::new(src)
        .into_iter()
        .filter_map(Result::ok)
    {
        let rel = entry
            .path()
            .strip_prefix(src)
            .map_err(|_| AppError::message("walkdir entry outside source"))?;
        let target = dst.join(rel);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(&target)?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(entry.path(), &target)?;
        } else if entry.file_type().is_symlink() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::symlink;
                let link_target = std::fs::read_link(entry.path())?;
                symlink(link_target, &target)?;
            }
            #[cfg(not(unix))]
            {
                let link_target = std::fs::read_link(entry.path())?;
                if link_target.is_dir() {
                    std::fs::create_dir(target)?;
                } else {
                    std::fs::copy(entry.path(), &target)?;
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn related_paths_follow_assets_on_disk() {
        let root = tempfile::tempdir().unwrap();
        let paper = root.path().join("papers/demo");
        fs::create_dir_all(paper.join("marks")).unwrap();
        fs::create_dir_all(paper.join("source")).unwrap();
        fs::write(paper.join("NOTES.md"), "# n\n").unwrap();
        fs::write(paper.join("PAPER.md"), "# p\n").unwrap();
        fs::write(paper.join("paper.pdf"), "%PDF").unwrap();
        fs::write(
            paper.join("source/main.tex"),
            "\\documentclass{article}\\begin{document}\\section{A}\\end{document}",
        )
        .unwrap();

        assert_eq!(
            paper_related_paths(root.path(), "papers/demo").unwrap(),
            vec![
                "papers/demo",
                "papers/demo/NOTES.md",
                "papers/demo/PAPER.md",
                "papers/demo/marks",
                "papers/demo/paper.pdf",
                "papers/demo/source",
            ]
        );
        assert!(paper_related_paths(root.path(), "papers/missing").is_err());
    }
}
