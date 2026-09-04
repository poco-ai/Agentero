//! Vault-local recycle bin.
//!
//! Deleting an item moves it into `.agentero/.trash/<batchId>/` together with a
//! `manifest.json` that records each item's original vault-relative path and a
//! snapshot of the catalog rows removed for it. This makes a delete fully
//! undoable — files move back and catalog rows are re-inserted — without
//! depending on platform-specific OS trash restore.

use crate::core::error::AppError;
use crate::features::catalog::papers::{self, PaperRecord};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

/// Vault-relative location of the recycle bin (hidden from the file tree,
/// which skips dot-entries).
const TRASH_REL: &str = ".agentero/.trash";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrashItem {
    /// Original vault-relative path the item lived at.
    rel: String,
    /// Basename of the stored copy inside the batch directory.
    stored: String,
    /// Catalog rows removed for this item (empty when not under `papers/`).
    #[serde(default)]
    catalog_rows: Vec<PaperRecord>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrashManifest {
    batch_id: String,
    created_at: String,
    items: Vec<TrashItem>,
}

/// Result of a trash operation returned to the UI.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashResult {
    /// Batch id used to undo (restore) the whole delete.
    pub batch_id: String,
    /// Number of items actually moved into the recycle bin.
    pub count: usize,
    /// Vault-relative paths actually moved (subset of the requested rels).
    pub rels: Vec<String>,
}

/// One item in the recycle bin (flattened across batches) for the UI list.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    /// Stable id: "{batchId}::{stored}".
    pub id: String,
    pub batch_id: String,
    pub stored: String,
    /// Original vault-relative path.
    pub rel: String,
    /// Basename for display.
    pub name: String,
    pub deleted_at: String,
    pub is_dir: bool,
}

fn norm_rel(rel: &str) -> String {
    rel.replace('\\', "/").trim_matches('/').to_string()
}

fn is_under_papers(rel: &str) -> bool {
    rel == "papers" || rel.starts_with("papers/")
}

fn validate_batch_id(batch_id: &str) -> Result<(), AppError> {
    if batch_id.is_empty()
        || batch_id.contains('/')
        || batch_id.contains('\\')
        || batch_id.contains("..")
    {
        return Err(AppError::message("invalid batch id"));
    }
    Ok(())
}

fn read_manifest(batch_dir: &Path) -> Result<TrashManifest, AppError> {
    let raw = fs::read_to_string(batch_dir.join("manifest.json"))
        .map_err(|_| AppError::message("trash batch not found"))?;
    serde_json::from_str(&raw).map_err(|e| AppError::message(e.to_string()))
}

fn write_manifest(batch_dir: &Path, manifest: &TrashManifest) -> Result<(), AppError> {
    let json =
        serde_json::to_string_pretty(manifest).map_err(|e| AppError::message(e.to_string()))?;
    fs::write(batch_dir.join("manifest.json"), json)?;
    Ok(())
}

/// Move the given vault-relative paths into a new recycle-bin batch.
///
/// For anything under `papers/`, catalog rows are snapshotted then removed so
/// the Library stays consistent; both are restored on [`restore_batch`].
/// Skips empty / traversing / `.agentero` / `papers` root / missing paths.
pub fn trash_paths(vault_root: &Path, rels: &[String]) -> Result<TrashResult, AppError> {
    crate::core::fs::ensure_vault_dir(vault_root)?;
    let now = chrono::Utc::now();
    let batch_id = format!(
        "{}-{}",
        now.format("%Y%m%dT%H%M%S"),
        now.timestamp_subsec_nanos()
    );
    let batch_dir = vault_root.join(TRASH_REL).join(&batch_id);

    let mut items: Vec<TrashItem> = Vec::new();
    for (i, raw) in rels.iter().enumerate() {
        let rel = norm_rel(raw);
        if rel.is_empty() || rel == "papers" || rel.contains("..") {
            continue;
        }
        if rel.starts_with(".agentero") {
            continue; // never trash the app's private dir
        }
        let abs = vault_root.join(&rel);
        if !abs.exists() {
            continue;
        }
        // Index prefix avoids basename collisions within one batch.
        let base = Path::new(&rel)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("item")
            .to_string();
        let stored = format!("{i}__{base}");
        // Snapshot catalog rows first (read-only), but keep them until the move
        // succeeds — otherwise a failed rename (e.g. a file open on Windows)
        // would orphan the catalog and hide the paper from the Library.
        let catalog_rows = if is_under_papers(&rel) {
            papers::list_under_path(vault_root, &rel).unwrap_or_default()
        } else {
            Vec::new()
        };
        if fs::create_dir_all(&batch_dir).is_err() {
            continue;
        }
        if fs::rename(&abs, batch_dir.join(&stored)).is_err() {
            // Leave the item in place and the catalog untouched.
            continue;
        }
        if is_under_papers(&rel) {
            let _ = papers::delete_under_path(vault_root, &rel);
        }
        items.push(TrashItem {
            rel,
            stored,
            catalog_rows,
        });
    }

    if items.is_empty() {
        // Nothing moved — drop the (possibly created) empty batch dir.
        let _ = fs::remove_dir(&batch_dir);
        return Ok(TrashResult {
            batch_id,
            count: 0,
            rels: Vec::new(),
        });
    }

    let rels: Vec<String> = items.iter().map(|item| item.rel.clone()).collect();
    let manifest = TrashManifest {
        batch_id: batch_id.clone(),
        created_at: crate::core::time::now_rfc3339_millis(),
        items,
    };
    let json =
        serde_json::to_string_pretty(&manifest).map_err(|e| AppError::message(e.to_string()))?;
    fs::write(batch_dir.join("manifest.json"), json)?;

    Ok(TrashResult {
        batch_id: manifest.batch_id,
        count: manifest.items.len(),
        rels,
    })
}

/// Restore a recycle-bin batch: move files back and re-insert catalog rows.
///
/// Aborts without changes if any original path has since been re-created, so a
/// restore never clobbers newer content.
pub fn restore_batch(vault_root: &Path, batch_id: &str) -> Result<usize, AppError> {
    crate::core::fs::ensure_vault_dir(vault_root)?;
    validate_batch_id(batch_id)?;
    let batch_dir = vault_root.join(TRASH_REL).join(batch_id);
    let manifest = read_manifest(&batch_dir)?;

    // Pre-check: never overwrite a path that has reappeared since deletion.
    for item in &manifest.items {
        if vault_root.join(&item.rel).exists() {
            return Err(AppError::message(format!(
                "cannot undo: '{}' already exists",
                item.rel
            )));
        }
    }

    for item in &manifest.items {
        let target = vault_root.join(&item.rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(batch_dir.join(&item.stored), &target)?;
        for row in &item.catalog_rows {
            papers::upsert_paper(vault_root, row)?;
        }
    }

    let _ = fs::remove_dir_all(&batch_dir);
    Ok(manifest.items.len())
}

/// List every item currently in the recycle bin, newest batch first.
pub fn list_trash(vault_root: &Path) -> Result<Vec<TrashEntry>, AppError> {
    let root = vault_root.join(TRASH_REL);
    let mut out: Vec<TrashEntry> = Vec::new();
    let Ok(read) = fs::read_dir(&root) else {
        return Ok(out);
    };
    for ent in read.flatten() {
        let batch_dir = ent.path();
        if !batch_dir.is_dir() {
            continue;
        }
        let Ok(manifest) = read_manifest(&batch_dir) else {
            continue;
        };
        for item in &manifest.items {
            let is_dir = batch_dir.join(&item.stored).is_dir();
            let name = Path::new(&item.rel)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(item.rel.as_str())
                .to_string();
            out.push(TrashEntry {
                id: format!("{}::{}", manifest.batch_id, item.stored),
                batch_id: manifest.batch_id.clone(),
                stored: item.stored.clone(),
                rel: item.rel.clone(),
                name,
                deleted_at: manifest.created_at.clone(),
                is_dir,
            });
        }
    }
    out.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(out)
}

/// Restore a single recycle-bin item to its original path (files + catalog rows).
/// Aborts if the original path has reappeared. Returns the restored rel path.
pub fn restore_item(vault_root: &Path, batch_id: &str, stored: &str) -> Result<String, AppError> {
    crate::core::fs::ensure_vault_dir(vault_root)?;
    validate_batch_id(batch_id)?;
    let batch_dir = vault_root.join(TRASH_REL).join(batch_id);
    let mut manifest = read_manifest(&batch_dir)?;
    let idx = manifest
        .items
        .iter()
        .position(|i| i.stored == stored)
        .ok_or_else(|| AppError::message("trash item not found"))?;

    let target = vault_root.join(&manifest.items[idx].rel);
    if target.exists() {
        return Err(AppError::message(format!(
            "cannot restore: '{}' already exists",
            manifest.items[idx].rel
        )));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let item = manifest.items.remove(idx);
    fs::rename(batch_dir.join(&item.stored), &target)?;
    for row in &item.catalog_rows {
        papers::upsert_paper(vault_root, row)?;
    }
    if manifest.items.is_empty() {
        let _ = fs::remove_dir_all(&batch_dir);
    } else {
        write_manifest(&batch_dir, &manifest)?;
    }
    Ok(item.rel)
}

/// Permanently delete a single recycle-bin item.
pub fn purge_item(vault_root: &Path, batch_id: &str, stored: &str) -> Result<(), AppError> {
    crate::core::fs::ensure_vault_dir(vault_root)?;
    validate_batch_id(batch_id)?;
    let batch_dir = vault_root.join(TRASH_REL).join(batch_id);
    let mut manifest = read_manifest(&batch_dir)?;
    let idx = manifest
        .items
        .iter()
        .position(|i| i.stored == stored)
        .ok_or_else(|| AppError::message("trash item not found"))?;
    let item = manifest.items.remove(idx);
    let stored_path = batch_dir.join(&item.stored);
    if stored_path.is_dir() {
        let _ = fs::remove_dir_all(&stored_path);
    } else {
        let _ = fs::remove_file(&stored_path);
    }
    if manifest.items.is_empty() {
        let _ = fs::remove_dir_all(&batch_dir);
    } else {
        write_manifest(&batch_dir, &manifest)?;
    }
    Ok(())
}

/// Empty the entire recycle bin (permanent).
pub fn purge_all(vault_root: &Path) -> Result<(), AppError> {
    let root = vault_root.join(TRASH_REL);
    if root.exists() {
        fs::remove_dir_all(&root)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn sample_record(path: &str, id: &str) -> PaperRecord {
        PaperRecord {
            path: path.into(),
            id: id.into(),
            paper_type: "article".into(),
            title: "T".into(),
            authors: vec![],
            creators: None,
            year: None,
            date: None,
            abstract_text: None,
            tags: vec![crate::features::catalog::papers::PaperTag::new("NLP")],
            arxiv_id: None,
            doi: None,
            isbn: None,
            issn: None,
            pmid: None,
            publication: None,
            volume: None,
            issue: None,
            pages: None,
            publisher: None,
            place: None,
            series: None,
            language: None,
            pdf_url: None,
            html_url: None,
            source_url: None,
            body_source: None,
            body_quality: None,
            bibtex_key: None,
            citation_count: None,
            zotero_item_type: None,
            meta_source: None,
            extra: None,
            summary: None,
            status: "completed".into(),
            is_read: false,
            zotero_item_id: None,
            zotero_last_synced: None,
            added_at: "t".into(),
            updated_at: "t".into(),
        }
    }

    #[test]
    fn trash_and_restore_roundtrip() {
        let dir = env::temp_dir().join(format!("agentero-trash-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let paper_dir = dir.join("papers").join("x");
        fs::create_dir_all(&paper_dir).unwrap();
        fs::write(paper_dir.join("NOTES.md"), "# hi\n").unwrap();
        papers::upsert_paper(&dir, &sample_record("papers/x", "x")).unwrap();

        // Trash: files move out, catalog row gone.
        let res = trash_paths(&dir, &["papers/x".to_string()]).unwrap();
        assert_eq!(res.count, 1);
        assert!(!paper_dir.exists());
        assert!(papers::get_by_path(&dir, "papers/x").unwrap().is_none());

        // Restore: files back, catalog row re-inserted.
        let restored = restore_batch(&dir, &res.batch_id).unwrap();
        assert_eq!(restored, 1);
        assert!(paper_dir.join("NOTES.md").exists());
        assert!(papers::get_by_path(&dir, "papers/x").unwrap().is_some());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_aborts_when_path_reappears() {
        let dir = env::temp_dir().join(format!("agentero-trash-conflict-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let note = dir.join("notes");
        fs::create_dir_all(&note).unwrap();
        fs::write(note.join("a.md"), "one\n").unwrap();

        let res = trash_paths(&dir, &["notes/a.md".to_string()]).unwrap();
        assert_eq!(res.count, 1);
        // A new file reoccupies the path.
        fs::write(note.join("a.md"), "two\n").unwrap();

        assert!(restore_batch(&dir, &res.batch_id).is_err());
        // The reoccupying file is untouched.
        assert_eq!(fs::read_to_string(note.join("a.md")).unwrap(), "two\n");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_restore_and_purge_items() {
        let dir = env::temp_dir().join(format!("agentero-trash-list-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let notes = dir.join("notes");
        fs::create_dir_all(&notes).unwrap();
        fs::write(notes.join("a.md"), "a\n").unwrap();
        fs::write(notes.join("b.md"), "b\n").unwrap();

        // One batch with two items.
        let res = trash_paths(&dir, &["notes/a.md".to_string(), "notes/b.md".to_string()]).unwrap();
        assert_eq!(res.count, 2);
        assert_eq!(list_trash(&dir).unwrap().len(), 2);

        // Restore one item; the other stays in the bin.
        let a = list_trash(&dir)
            .unwrap()
            .into_iter()
            .find(|e| e.rel == "notes/a.md")
            .unwrap();
        restore_item(&dir, &a.batch_id, &a.stored).unwrap();
        assert!(notes.join("a.md").exists());
        assert_eq!(list_trash(&dir).unwrap().len(), 1);

        // Purge the remaining item; the bin becomes empty.
        let b = list_trash(&dir).unwrap().into_iter().next().unwrap();
        purge_item(&dir, &b.batch_id, &b.stored).unwrap();
        assert!(list_trash(&dir).unwrap().is_empty());
        assert!(!notes.join("b.md").exists());

        let _ = fs::remove_dir_all(&dir);
    }
}

/// Tauri command shells for this feature.
#[cfg(feature = "desktop")]
pub mod commands;
