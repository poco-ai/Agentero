//! Add an existing paper to another folder or another vault.
//!
//! Same vault: a directory link, so the file tree has a second entry and the
//! catalog still has one row. Another vault: a real copy of the file bytes,
//! plus one catalog row in the destination. The source is left in place.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::error::AppError;
use crate::features::paper::identity::is_paper_marker_file;
use crate::fs::{self as vault_fs, normalize_rel, sanitize_vault_rel};

use super::papers::{self, PaperRecord};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaperAddResult {
    /// `link` when the destination is the same vault, `copy` otherwise.
    pub mode: &'static str,
    /// Vault-relative source path, after separator normalization.
    pub from: String,
    /// Vault-relative path of the new entry in the destination vault.
    pub new_rel: String,
}

/// Add `from_rel` under `to_parent_rel`.
///
/// Paths must stay under `papers/`. The destination parent is created when
/// missing. An existing target, a source that is not one paper folder, or a
/// destination that already has the same paper id fails without changing the
/// catalog. A half-written copy is removed.
pub fn add_paper(
    from_vault: &Path,
    from_rel: &str,
    to_vault: &Path,
    to_parent_rel: &str,
) -> Result<PaperAddResult, AppError> {
    let from_hint = normalize_rel(from_rel);
    let dest_hint = normalize_rel(to_parent_rel);
    require_vault(from_vault, "source", &from_hint, &dest_hint)?;
    require_vault(to_vault, "destination", &from_hint, &dest_hint)?;

    let from =
        sanitize_vault_rel(from_rel).map_err(|error| fail_add(&from_hint, &dest_hint, error))?;
    let dest_parent =
        destination_parent(to_parent_rel).map_err(|error| fail_add(&from, &dest_hint, error))?;
    if from == "papers" {
        return Err(fail_add(&from, &dest_parent, "cannot add papers/"));
    }
    let base = from.rsplit('/').next().unwrap_or(from.as_str()).to_string();
    let new_rel = format!("{dest_parent}/{base}");
    let fail = |detail: String| fail_add(&from, &new_rel, detail);

    let from_abs = from_vault.join(&from);
    if from_abs.symlink_metadata().is_err() {
        return Err(fail("source path does not exist".into()));
    }
    if !is_paper_folder(&from_abs) {
        return Err(fail("source is not a paper folder".into()));
    }
    let inside = vault_fs::linked_dir_vault_rel(from_vault, &from);
    let canonical = inside.clone().unwrap_or_else(|| from.clone());
    if dest_parent == canonical
        || dest_parent.starts_with(&format!("{canonical}/"))
        || dest_parent == from
        || dest_parent.starts_with(&format!("{from}/"))
    {
        return Err(fail("cannot add a paper into itself".into()));
    }
    if new_rel == canonical || new_rel == from {
        return Err(fail("paper is already in the destination folder".into()));
    }

    let to_abs = to_vault.join(&new_rel);
    if to_abs.symlink_metadata().is_ok() {
        return Err(fail("target already exists".into()));
    }
    if let Some(parent) = to_abs.parent() {
        fs::create_dir_all(parent).map_err(|error| fail(error.to_string()))?;
    }

    let same_vault = vault_fs::canonicalize_best_effort(from_vault)
        == vault_fs::canonicalize_best_effort(to_vault);
    if same_vault {
        if vault_fs::is_linked_dir(&from_abs) && inside.is_none() {
            return Err(fail("source link does not stay inside this vault".into()));
        }
        link_directory(from_vault, &canonical, &new_rel, &to_abs).map_err(fail)?;
        Ok(PaperAddResult {
            mode: "link",
            from,
            new_rel,
        })
    } else {
        copy_into_vault(from_vault, &from, &canonical, to_vault, &new_rel, &to_abs)
            .map_err(fail)?;
        Ok(PaperAddResult {
            mode: "copy",
            from,
            new_rel,
        })
    }
}

fn require_vault(vault: &Path, role: &str, from: &str, dest: &str) -> Result<(), AppError> {
    if super::catalog_db_path(vault).is_file() {
        Ok(())
    } else {
        Err(fail_add(
            from,
            dest,
            format!("{role} is not a vault ({})", vault.display()),
        ))
    }
}

fn destination_parent(to_parent_rel: &str) -> Result<String, String> {
    let dest_norm = normalize_rel(to_parent_rel);
    let dest_parent = if dest_norm.is_empty() {
        "papers".to_string()
    } else {
        sanitize_vault_rel(&dest_norm)?
    };
    if dest_parent != "papers" && !dest_parent.starts_with("papers/") {
        return Err("destination must be under papers/".into());
    }
    Ok(dest_parent)
}

fn fail_add(from: &str, dest: &str, detail: impl std::fmt::Display) -> AppError {
    AppError::message(format!("failed to add {from} → {dest}: {detail}"))
}

fn is_paper_folder(dir: &Path) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        entry.path().is_file() && entry.file_name().to_str().is_some_and(is_paper_marker_file)
    })
}

fn link_directory(vault: &Path, canonical: &str, new_rel: &str, link: &Path) -> Result<(), String> {
    let rel_target = vault_fs::relative_link_target(new_rel, canonical);
    let abs_target = vault.join(canonical);
    vault_fs::create_directory_link(Path::new(&rel_target), &abs_target, link).map_err(
        |error| {
            let _ = vault_fs::remove_directory_link(link);
            error.to_string()
        },
    )?;
    if !vault_fs::is_linked_dir(link) {
        let _ = vault_fs::remove_directory_link(link);
        return Err("directory link was created but does not resolve".into());
    }
    Ok(())
}

fn copy_into_vault(
    from_vault: &Path,
    from: &str,
    canonical: &str,
    to_vault: &Path,
    new_rel: &str,
    to_abs: &Path,
) -> Result<(), String> {
    let mut record = source_record(from_vault, from, canonical)?;
    if papers::list_all(to_vault)
        .map_err(|error| error.to_string())?
        .iter()
        .any(|paper| paper.id == record.id)
    {
        return Err(format!(
            "destination vault already has paper id '{}'",
            record.id
        ));
    }
    let source_dir = vault_fs::resolved_dir(&from_vault.join(from)).map_err(|error| {
        format!(
            "cannot read source {}: {error}",
            from_vault.join(from).display()
        )
    })?;
    if let Err(error) = copy_dereferenced(&source_dir, to_abs) {
        let _ = fs::remove_dir_all(to_abs);
        return Err(error.to_string());
    }
    record.path = new_rel.to_string();
    record.updated_at = crate::time::now_rfc3339_millis();
    if let Err(error) = papers::upsert_paper(to_vault, &record) {
        let _ = fs::remove_dir_all(to_abs);
        return Err(error.to_string());
    }
    Ok(())
}

fn source_record(vault: &Path, from: &str, canonical: &str) -> Result<PaperRecord, String> {
    if let Some(row) = papers::get_by_path(vault, canonical).map_err(|error| error.to_string())? {
        return Ok(row);
    }
    if let Some(sidecar) = super::sidecar::read_sidecar(vault, from) {
        return Ok(sidecar);
    }
    let name = Path::new(canonical)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(canonical)
        .to_string();
    Ok(PaperRecord::local_pdf(name.clone(), name).at_path(canonical))
}

fn copy_dereferenced(src: &Path, dst: &Path) -> Result<(), AppError> {
    let mut seen = HashSet::new();
    copy_tree(src, dst, &mut seen)
}

fn copy_tree(src: &Path, dst: &Path, seen: &mut HashSet<PathBuf>) -> Result<(), AppError> {
    let meta = fs::symlink_metadata(src)?;
    if meta.file_type().is_symlink() || vault_fs::is_linked_dir(src) {
        let followed = fs::metadata(src)?;
        if followed.is_dir() {
            let canon = fs::canonicalize(src)?;
            if !seen.insert(canon.clone()) {
                return Err(AppError::message(format!(
                    "directory link cycle at {}",
                    src.display()
                )));
            }
            return copy_children(&canon, dst, seen);
        }
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(src, dst)?;
        return Ok(());
    }
    if meta.is_dir() {
        let canon = fs::canonicalize(src).unwrap_or_else(|_| src.to_path_buf());
        if !seen.insert(canon) {
            return Err(AppError::message(format!(
                "directory link cycle at {}",
                src.display()
            )));
        }
        return copy_children(src, dst, seen);
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(src, dst)?;
    Ok(())
}

fn copy_children(src: &Path, dst: &Path, seen: &mut HashSet<PathBuf>) -> Result<(), AppError> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        copy_tree(&entry.path(), &dst.join(entry.file_name()), seen)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::vault::trash;

    fn paper(vault: &Path, rel: &str, id: &str, title: &str) {
        let dir = vault.join(rel);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("NOTES.md"), format!("# {title}\n")).unwrap();
        fs::write(dir.join("paper.pdf"), format!("pdf:{id}")).unwrap();
        papers::upsert_paper(
            vault,
            &PaperRecord::local_pdf(id.into(), title.into()).at_path(rel),
        )
        .unwrap();
    }

    #[test]
    fn same_vault_links_the_directory_and_keeps_one_catalog_row() {
        let root = tempfile::tempdir().unwrap();
        let vault = root.path();
        paper(vault, "papers/inbox/demo", "demo", "Demo");

        let added = add_paper(vault, "papers/inbox/demo", vault, "papers/archive").unwrap();
        assert_eq!(added.mode, "link");
        assert_eq!(added.new_rel, "papers/archive/demo");

        let link = vault.join("papers/archive/demo");
        assert!(vault_fs::is_linked_dir(&link));
        assert!(vault.join("papers/inbox/demo/NOTES.md").is_file());
        assert_eq!(
            fs::read_to_string(link.join("NOTES.md")).unwrap(),
            "# Demo\n"
        );
        fs::write(link.join("paper.pdf"), "pdf:changed").unwrap();
        assert_eq!(
            fs::read_to_string(vault.join("papers/inbox/demo/paper.pdf")).unwrap(),
            "pdf:changed"
        );

        let rows = papers::list_all(vault).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].path, "papers/inbox/demo");
        assert_eq!(
            papers::get_by_path(vault, "papers/archive/demo")
                .unwrap()
                .unwrap()
                .path,
            "papers/inbox/demo"
        );
        papers::rebuild_from_disk(vault).unwrap();
        let rows = papers::list_all(vault).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].path, "papers/inbox/demo");
    }

    #[test]
    fn same_vault_rejects_an_existing_target_without_touching_the_catalog() {
        let root = tempfile::tempdir().unwrap();
        let vault = root.path();
        paper(vault, "papers/inbox/demo", "demo", "Demo");
        fs::create_dir_all(vault.join("papers/archive/demo")).unwrap();

        let error = add_paper(vault, "papers/inbox/demo", vault, "papers/archive").unwrap_err();
        let message = error.to_string();
        assert!(message.contains("papers/archive/demo"), "{message}");
        assert!(message.contains("target already exists"), "{message}");
        assert_eq!(papers::list_all(vault).unwrap().len(), 1);
        assert!(!vault_fs::is_linked_dir(&vault.join("papers/archive/demo")));
    }

    #[test]
    fn deleting_or_moving_the_link_leaves_the_original_paper() {
        let root = tempfile::tempdir().unwrap();
        let vault = root.path();
        paper(vault, "papers/inbox/demo", "demo", "Demo");
        add_paper(vault, "papers/inbox/demo", vault, "papers/archive").unwrap();

        let moved =
            super::super::move_paper_under(vault, "papers/archive/demo", "papers/shelf").unwrap();
        assert_eq!(moved, "papers/shelf/demo");
        assert!(vault_fs::is_linked_dir(&vault.join("papers/shelf/demo")));
        assert!(vault.join("papers/inbox/demo/NOTES.md").is_file());
        assert_eq!(
            papers::get_by_path(vault, "papers/inbox/demo")
                .unwrap()
                .unwrap()
                .path,
            "papers/inbox/demo"
        );

        trash::delete_paths(vault, &["papers/shelf/demo".to_string()], true).unwrap();
        assert!(vault.join("papers/shelf/demo").symlink_metadata().is_err());
        assert!(vault.join("papers/inbox/demo/NOTES.md").is_file());
        assert_eq!(
            papers::get_by_path(vault, "papers/inbox/demo")
                .unwrap()
                .unwrap()
                .id,
            "demo"
        );
    }

    #[test]
    fn other_vault_copies_bytes_and_inserts_its_own_row() {
        let root = tempfile::tempdir().unwrap();
        let src = root.path().join("src");
        let dst = root.path().join("dst");
        paper(&src, "papers/inbox/demo", "demo", "Demo");
        super::super::ensure_catalog(&dst).unwrap();

        let added = add_paper(&src, "papers/inbox/demo", &dst, "papers/archive").unwrap();
        assert_eq!(added.mode, "copy");
        assert_eq!(added.new_rel, "papers/archive/demo");
        assert!(!vault_fs::is_linked_dir(&dst.join("papers/archive/demo")));
        assert_eq!(
            fs::read_to_string(dst.join("papers/archive/demo/paper.pdf")).unwrap(),
            "pdf:demo"
        );
        fs::write(dst.join("papers/archive/demo/paper.pdf"), "pdf:dest").unwrap();
        assert_eq!(
            fs::read_to_string(src.join("papers/inbox/demo/paper.pdf")).unwrap(),
            "pdf:demo"
        );
        assert_eq!(
            papers::get_by_path(&src, "papers/inbox/demo")
                .unwrap()
                .unwrap()
                .id,
            "demo"
        );
        let copied = papers::get_by_path(&dst, "papers/archive/demo")
            .unwrap()
            .unwrap();
        assert_eq!(copied.id, "demo");
        assert_eq!(copied.path, "papers/archive/demo");
    }

    #[test]
    fn other_vault_copies_the_target_of_a_same_vault_link() {
        let root = tempfile::tempdir().unwrap();
        let src = root.path().join("src");
        let dst = root.path().join("dst");
        paper(&src, "papers/inbox/demo", "demo", "Demo");
        add_paper(&src, "papers/inbox/demo", &src, "papers/archive").unwrap();
        super::super::ensure_catalog(&dst).unwrap();

        let added = add_paper(&src, "papers/archive/demo", &dst, "papers/shelf").unwrap();
        assert_eq!(added.mode, "copy");
        assert_eq!(added.new_rel, "papers/shelf/demo");
        assert!(!vault_fs::is_linked_dir(&dst.join("papers/shelf/demo")));
        assert_eq!(
            fs::read_to_string(dst.join("papers/shelf/demo/paper.pdf")).unwrap(),
            "pdf:demo"
        );
        assert!(vault_fs::is_linked_dir(&src.join("papers/archive/demo")));
        assert!(src.join("papers/inbox/demo/NOTES.md").is_file());
        assert_eq!(
            papers::get_by_path(&src, "papers/inbox/demo")
                .unwrap()
                .unwrap()
                .id,
            "demo"
        );
    }

    #[test]
    fn other_vault_refuses_a_duplicate_id_and_leaves_no_directory() {
        let root = tempfile::tempdir().unwrap();
        let src = root.path().join("src");
        let dst = root.path().join("dst");
        paper(&src, "papers/inbox/demo", "demo", "Demo");
        paper(&dst, "papers/kept/demo", "demo", "Already");

        let error = add_paper(&src, "papers/inbox/demo", &dst, "papers/archive").unwrap_err();
        let message = error.to_string();
        assert!(message.contains("papers/archive/demo"), "{message}");
        assert!(message.contains("already has paper id"), "{message}");
        assert!(!dst.join("papers/archive/demo").exists());
        assert!(src.join("papers/inbox/demo/NOTES.md").is_file());
    }
}
