//! Duplicate a paper folder under `papers/` (the library's "copy to folder").
//!
//! Unlike a move, a copy never rewrites links or the source catalog path: the
//! original stays put and the duplicate becomes a second catalog row with the
//! same logical `id` (multi-path papers are already a supported state).

use super::{papers, plan_paper_copy_under};
use crate::error::AppError;
use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PaperCopyResult {
    /// Vault-relative path of the new duplicate.
    pub new_rel: String,
    /// Whether a catalog row was written for the duplicate.
    pub cataloged: bool,
}

/// Copy `from_rel` into `dest_parent_rel`, keeping the folder name.
///
/// Never overwrites: an existing target is an error. The filesystem copy is
/// rolled back when anything fails midway, so no half paper is left behind.
pub fn copy_paper_under(
    vault: &Path,
    from_rel: &str,
    dest_parent_rel: &str,
) -> Result<PaperCopyResult, AppError> {
    let (from, new_rel) = plan_paper_copy_under(vault, from_rel, dest_parent_rel)?;
    let from_abs = vault.join(&from);
    let to_abs = vault.join(&new_rel);
    if let Err(error) = copy_dir_all(&from_abs, &to_abs) {
        let _ = fs::remove_dir_all(&to_abs);
        return Err(error);
    }
    let cataloged = match papers::get_by_path(vault, &from)? {
        Some(record) => {
            papers::upsert_paper(vault, &record.at_path(&new_rel))?;
            if let Some(count) = papers::get_page_count(vault, &from)? {
                papers::set_page_counts(vault, &[(new_rel.clone(), count)])?;
            }
            true
        }
        None => false,
    };
    Ok(PaperCopyResult { new_rel, cataloged })
}

fn copy_dir_all(from: &Path, to: &Path) -> Result<(), AppError> {
    fs::create_dir_all(to)
        .map_err(|error| AppError::message(format!("create {}: {error}", to.display())))?;
    let entries = fs::read_dir(from)
        .map_err(|error| AppError::message(format!("read {}: {error}", from.display())))?;
    for entry in entries {
        let entry = entry.map_err(|error| AppError::message(error.to_string()))?;
        let file_type = entry
            .file_type()
            .map_err(|error| AppError::message(error.to_string()))?;
        let source = entry.path();
        let target = to.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_all(&source, &target)?;
        } else if file_type.is_file() {
            fs::copy(&source, &target).map_err(|error| {
                AppError::message(format!("copy {}: {error}", source.display()))
            })?;
        }
        // Symlinks are not part of a paper folder, and skipping them keeps a
        // copy from writing outside the vault.
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::paper::catalog::{ensure_catalog, evict_catalog_conn};
    use std::fs;

    fn fixture() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("papers/inbox/demo")).unwrap();
        fs::write(root.path().join("papers/inbox/demo/NOTES.md"), "# Demo\n").unwrap();
        fs::write(root.path().join("papers/inbox/demo/paper.pdf"), b"%PDF-1.4").unwrap();
        papers::upsert_paper(
            root.path(),
            &papers::PaperRecord::local_pdf("demo".into(), "Demo".into())
                .at_path("papers/inbox/demo"),
        )
        .unwrap();
        papers::set_page_counts(root.path(), &[("papers/inbox/demo".into(), 5)]).unwrap();
        root
    }

    #[test]
    fn duplicates_files_catalog_row_and_page_counts() {
        let root = fixture();
        let copied = copy_paper_under(root.path(), "papers/inbox/demo", "papers/archive").unwrap();
        assert_eq!(copied.new_rel, "papers/archive/demo");
        assert!(copied.cataloged);

        for name in ["NOTES.md", "paper.pdf"] {
            assert!(root.path().join("papers/archive/demo").join(name).is_file());
            assert!(root.path().join("papers/inbox/demo").join(name).is_file());
        }
        // Both folders stay cataloged under the same logical id.
        for rel in ["papers/inbox/demo", "papers/archive/demo"] {
            let row = papers::get_by_path(root.path(), rel).unwrap().unwrap();
            assert_eq!(row.id, "demo");
            assert_eq!(row.title, "Demo");
        }
        assert_eq!(
            papers::get_page_count(root.path(), "papers/archive/demo").unwrap(),
            Some(5)
        );
        evict_catalog_conn(root.path());
        let conn = ensure_catalog(root.path()).unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM papers", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            2
        );
    }

    #[test]
    fn refuses_to_overwrite_an_existing_target() {
        let root = fixture();
        fs::create_dir_all(root.path().join("papers/archive/demo")).unwrap();
        assert!(copy_paper_under(root.path(), "papers/inbox/demo", "papers/archive").is_err());
        assert!(!root.path().join("papers/archive/demo/NOTES.md").exists());
    }

    #[test]
    fn refuses_to_copy_a_folder_into_itself() {
        let root = fixture();
        assert!(copy_paper_under(root.path(), "papers/inbox/demo", "papers/inbox").is_err());
        assert!(copy_paper_under(root.path(), "papers/inbox/demo", "papers/inbox/demo").is_err());
    }

    #[test]
    fn requires_papers_paths_on_both_sides() {
        let root = fixture();
        assert!(copy_paper_under(root.path(), "notes/todo.md", "papers").is_err());
        assert!(copy_paper_under(root.path(), "papers/inbox/demo", "notes").is_err());
    }

    #[test]
    fn copies_a_plain_folder_without_catalog_row() {
        let root = fixture();
        fs::create_dir_all(root.path().join("papers/misc/raw")).unwrap();
        fs::write(root.path().join("papers/misc/raw/a.txt"), "a").unwrap();
        let copied = copy_paper_under(root.path(), "papers/misc/raw", "papers/archive").unwrap();
        assert!(!copied.cataloged);
        assert!(root.path().join("papers/archive/raw/a.txt").is_file());
    }
}
