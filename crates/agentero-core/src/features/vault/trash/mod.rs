//! Vault recycle bin, shared by the local filesystem and the remote `VaultFs`
//! executor.
//!
//! Deleting an item moves it into `.agentero/.trash/<batchId>/` together with a
//! `manifest.json` that records each item's original vault-relative path and a
//! snapshot of the catalog rows removed for it. This makes a delete fully
//! undoable — files move back and catalog rows are re-inserted — without
//! depending on platform-specific OS trash restore.
//!
//! [`plan_trash`] decides eligibility, stored names, and catalog snapshots.
//! Each executor performs its own move, manifest write, and catalog delete.

use crate::error::AppError;
use crate::features::catalog::papers::{self, PaperRecord};
use crate::fs::normalize_rel_separators;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

/// Vault-relative location of the recycle bin (hidden from the file tree,
/// which skips dot-entries). Components are `/`-separated for `VaultFs`.
pub const TRASH_REL: &str = ".agentero/.trash";

/// One manifest entry. Field names stay camelCase so existing `manifest.json`
/// files still deserialize.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    /// Original vault-relative path the item lived at.
    pub rel: String,
    /// Basename of the stored copy inside the batch directory.
    pub stored: String,
    /// Catalog rows removed for this item (empty when not under `papers/`).
    #[serde(default)]
    pub catalog_rows: Vec<PaperRecord>,
    #[serde(default)]
    pub phase: TrashPhase,
}

/// Durable move intent; old manifests already describe trashed files.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrashPhase {
    Prepared,
    #[default]
    Trashed,
    Restoring,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestoreAction {
    Move,
    Finish,
    Unmoved,
}

pub fn restore_action(
    item: &TrashItem,
    stored: bool,
    target: bool,
) -> Result<RestoreAction, AppError> {
    match (stored, target, item.phase) {
        (true, false, _) => Ok(RestoreAction::Move),
        (false, true, TrashPhase::Restoring) => Ok(RestoreAction::Finish),
        (false, true, TrashPhase::Prepared) => Ok(RestoreAction::Unmoved),
        (_, true, _) => Err(AppError::message(format!(
            "cannot restore: '{}' already exists",
            item.rel
        ))),
        _ => Err(AppError::message(format!(
            "trash content missing: {}",
            item.rel
        ))),
    }
}

/// Sidecar location relative to the stored item, including organization folders.
pub fn restore_sidecar_path(
    item: &TrashItem,
    row: &PaperRecord,
) -> Result<std::path::PathBuf, AppError> {
    let item_path = normalize_rel_separators(&item.rel);
    let row_path = normalize_rel_separators(&row.path);
    let suffix = Path::new(&row_path)
        .strip_prefix(&item_path)
        .map_err(|_| AppError::message("catalog snapshot is outside its trash item"))?;
    Ok(suffix.join(crate::features::catalog::sidecar::SIDECAR_FILE))
}

/// A retry must not overwrite metadata edited after an earlier item completed.
pub fn restore_catalog(vault: &Path, item: &TrashItem) -> Result<(), AppError> {
    for row in &item.catalog_rows {
        papers::insert_paper_if_missing(vault, row)?;
    }
    Ok(())
}

/// Recycle-bin batch manifest (`manifest.json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashManifest {
    pub batch_id: String,
    pub created_at: String,
    pub items: Vec<TrashItem>,
}

/// One eligible path in a [`TrashPlan`], including the catalog snapshot taken
/// before any file move or catalog delete.
#[derive(Debug, Clone)]
pub struct TrashPlanItem {
    pub rel: String,
    pub stored: String,
    pub catalog_rows: Vec<PaperRecord>,
}

/// Pure trash decision: which rels to move, under which stored names.
#[derive(Debug, Clone)]
pub struct TrashPlan {
    pub batch_id: String,
    pub items: Vec<TrashPlanItem>,
}

impl From<TrashPlanItem> for TrashItem {
    fn from(item: TrashPlanItem) -> Self {
        Self {
            rel: item.rel,
            stored: item.stored,
            catalog_rows: item.catalog_rows,
            phase: TrashPhase::Prepared,
        }
    }
}

/// Result of a trash operation returned to the UI.
#[derive(Debug, Serialize, specta::Type)]
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
#[derive(Debug, Serialize, specta::Type)]
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
    /// Paper title when the item snapshots exactly one catalog row (a paper
    /// directory); `None` for plain files or folders holding several papers.
    pub title: Option<String>,
    pub deleted_at: String,
    pub is_dir: bool,
}

/// Display title for a trashed item: the catalog title when the snapshot holds
/// a single paper row, otherwise `None` (caller falls back to the basename).
pub fn snapshot_title(rows: &[PaperRecord]) -> Option<String> {
    if rows.len() != 1 {
        return None;
    }
    let title = rows[0].title.trim();
    (!title.is_empty()).then(|| title.to_string())
}

fn is_under_papers(rel: &str) -> bool {
    rel == "papers" || rel.starts_with("papers/")
}

/// Reject batch ids that would escape `.agentero/.trash/` or add path segments.
/// Both `/` and `\` are rejected so a Windows join cannot split the id.
pub fn validate_batch_id(batch_id: &str) -> Result<(), AppError> {
    if batch_id.is_empty()
        || batch_id.contains('/')
        || batch_id.contains('\\')
        || batch_id.contains("..")
    {
        return Err(AppError::message("invalid batch id"));
    }
    Ok(())
}

/// Vault-relative batch directory (`.agentero/.trash/<batch_id>`), using `/`.
/// `batch_id` must already have passed [`validate_batch_id`]. Local executors
/// join [`TRASH_REL`] and the id with `Path::join` instead of concatenating an
/// absolute vault path.
pub fn trash_batch_rel(batch_id: &str) -> String {
    format!("{TRASH_REL}/{batch_id}")
}

/// Shape check on an already separator-normalized rel, before the existence
/// probe. Matches local trash: empty, the `papers` root, any rel containing
/// `..`, and anything whose path starts with `.agentero` (including the
/// directory itself).
pub fn is_trash_candidate(rel: &str) -> bool {
    !rel.is_empty() && rel != "papers" && !rel.contains("..") && !rel.starts_with(".agentero")
}

/// Decide which rels are eligible and their stored names.
///
/// `present` reports whether a normalized rel exists. `rows_for` supplies the
/// catalog snapshot for a rel under `papers/` (the caller loads it). Skips
/// empty rels, the `papers` root, any rel containing `..`, anything under
/// `.agentero`, and rels `present` says are missing. Stored names keep the
/// request index (`{i}__{basename}`) so two items that share a basename stay
/// distinct. Local and remote skip rules already matched; this does not drop
/// a path the local command trashes.
///
/// The executor saves this plan before moving files and records each move in
/// the manifest before deleting catalog rows.
pub fn plan_trash<P, R>(
    rels: &[String],
    batch_id: &str,
    mut present: P,
    mut rows_for: R,
) -> Result<TrashPlan, AppError>
where
    P: FnMut(&str) -> bool,
    R: FnMut(&str) -> Vec<PaperRecord>,
{
    validate_batch_id(batch_id)?;
    let mut items = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (i, raw) in rels.iter().enumerate() {
        let rel = normalize_rel_separators(raw);
        if !is_trash_candidate(&rel) || !seen.insert(rel.clone()) || !present(&rel) {
            continue;
        }
        let base = Path::new(&rel)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("item")
            .to_string();
        let catalog_rows = if is_under_papers(&rel) {
            rows_for(&rel)
        } else {
            Vec::new()
        };
        items.push(TrashPlanItem {
            rel,
            stored: format!("{i}__{base}"),
            catalog_rows,
        });
    }
    // Moving a selected parent includes its descendants. Keep one operation
    // and one complete snapshot rather than overlapping restore destinations.
    let selected: Vec<_> = items.iter().map(|item| item.rel.clone()).collect();
    items.retain(|item| {
        !selected
            .iter()
            .any(|other| other != &item.rel && path_covers(other, &item.rel))
    });
    Ok(TrashPlan {
        batch_id: batch_id.to_string(),
        items,
    })
}

/// `row_path` is `rel` or a descendant (`rel/...`), not a sibling with a shared prefix.
fn path_covers(rel: &str, row_path: &str) -> bool {
    row_path == rel || row_path.starts_with(&format!("{rel}/"))
}

/// Delete catalog rows for papers whose files are already in the trash batch.
/// Runs only after the manifest is on disk. On failure the batch is left in
/// place (no file rollback) and the error names `batch_id`.
pub fn delete_trashed_catalog(
    vault_root: &Path,
    batch_id: &str,
    items: &[TrashItem],
) -> Result<(), AppError> {
    let mut first_error = None;
    for item in items {
        if !is_under_papers(&item.rel) {
            continue;
        }
        if let Err(err) = papers::delete_under_path(vault_root, &item.rel) {
            if first_error.is_none() {
                first_error = Some(AppError::domain(
                    "trash_catalog",
                    format!(
                        "trash catalog update failed for batch {batch_id}; files remain in .agentero/.trash/{batch_id}: {err}"
                    ),
                ));
            }
        }
    }
    match first_error {
        Some(err) => Err(err),
        None => Ok(()),
    }
}

/// Remove catalog rows when a library delete has no folder left to recycle.
///
/// A paper the user deletes is gone. If its folder is already missing, there
/// is nothing to move into the recycle bin, but the catalog row would stay in
/// the library and look like a paper with no PDF. Rows under `papers/` in
/// `rels` whose folder is gone are deleted here. `also_ids` are papers just
/// moved to the bin: other rows of those ids with no folder are deleted too,
/// so a hidden duplicate does not reappear. Folders that still exist stay.
/// Returns the vault-relative paths whose rows were removed.
pub fn delete_absent_paper_rows(
    vault_root: &Path,
    rels: &[String],
    also_ids: &[String],
) -> Result<Vec<String>, AppError> {
    let mut removed = Vec::new();
    let mut ids = Vec::new();
    for raw in rels {
        let rel = normalize_rel_separators(raw);
        if !is_trash_candidate(&rel) || !is_under_papers(&rel) || vault_root.join(&rel).exists() {
            continue;
        }
        let rows = papers::list_under_path(vault_root, &rel)?;
        for row in &rows {
            if !row.id.is_empty() {
                ids.push(row.id.clone());
            }
        }
        if rows.is_empty() {
            continue;
        }
        if papers::delete_under_path(vault_root, &rel)? > 0 {
            removed.push(rel);
        }
    }
    ids.extend(also_ids.iter().filter(|id| !id.is_empty()).cloned());
    let mut seen = std::collections::HashSet::new();
    for id in ids {
        if !seen.insert(id.clone()) {
            continue;
        }
        for row in papers::list_by_id(vault_root, &id)? {
            if vault_root.join(&row.path).exists() {
                continue;
            }
            if papers::delete_under_path(vault_root, &row.path)? > 0 {
                removed.push(row.path);
            }
        }
    }
    removed.sort();
    removed.dedup();
    Ok(removed)
}

fn read_manifest(batch_dir: &Path) -> Result<TrashManifest, AppError> {
    let raw = fs::read_to_string(batch_dir.join("manifest.json"))
        .map_err(|_| AppError::message("trash batch not found"))?;
    serde_json::from_str(&raw).map_err(|e| AppError::message(e.to_string()))
}

fn write_manifest(batch_dir: &Path, manifest: &TrashManifest) -> Result<(), AppError> {
    let json =
        serde_json::to_string_pretty(manifest).map_err(|e| AppError::message(e.to_string()))?;
    crate::fs::atomic_write(&batch_dir.join("manifest.json"), json.as_bytes())?;
    Ok(())
}

/// Move the given vault-relative paths into a new recycle-bin batch.
///
/// Eligibility and catalog snapshots come from [`plan_trash`]. For anything
/// under `papers/`, catalog rows are removed only after the manifest is stored
/// so a failed manifest write does not hide the paper while its files sit in
/// an unrecorded batch. Both are restored on [`restore_batch`]. A `papers/`
/// path whose folder is already gone still drops its catalog row (and any
/// same-id row whose folder is also gone) so the library entry disappears;
/// there is no recycle-bin item for a folder that was not there.
pub fn trash_paths(vault_root: &Path, rels: &[String]) -> Result<TrashResult, AppError> {
    crate::fs::ensure_vault_dir(vault_root)?;
    let now = chrono::Utc::now();
    let batch_id = format!(
        "{}-{}",
        now.format("%Y%m%dT%H%M%S"),
        now.timestamp_subsec_nanos()
    );
    let mut snapshots = std::collections::HashMap::new();
    for rel in rels {
        let rel = normalize_rel_separators(rel);
        if is_trash_candidate(&rel) {
            snapshots.insert(rel.clone(), papers::list_under_path(vault_root, &rel)?);
        }
    }
    let plan = plan_trash(
        rels,
        &batch_id,
        |rel| vault_root.join(rel).exists(),
        |rel| snapshots.remove(rel).unwrap_or_default(),
    )?;
    if plan.items.is_empty() {
        let removed = delete_absent_paper_rows(vault_root, rels, &[])?;
        return Ok(TrashResult {
            batch_id,
            count: 0,
            rels: removed,
        });
    }

    // Join the trash root and the batch id as path components. The id has
    // already rejected `/` and `\`, so it cannot add another segment.
    let batch_dir = vault_root.join(TRASH_REL).join(&plan.batch_id);
    fs::create_dir_all(&batch_dir)?;
    let mut manifest = TrashManifest {
        batch_id: plan.batch_id,
        created_at: crate::time::now_rfc3339_millis(),
        items: plan.items.into_iter().map(Into::into).collect(),
    };
    write_manifest(&batch_dir, &manifest)?;
    for index in 0..manifest.items.len() {
        let item = &manifest.items[index];
        fs::rename(vault_root.join(&item.rel), batch_dir.join(&item.stored))?;
        manifest.items[index].phase = TrashPhase::Trashed;
        write_manifest(&batch_dir, &manifest)?;
    }
    let mut rels_out: Vec<String> = manifest.items.iter().map(|item| item.rel.clone()).collect();
    delete_trashed_catalog(vault_root, &manifest.batch_id, &manifest.items)?;
    let mut ids = Vec::new();
    for item in &manifest.items {
        for row in &item.catalog_rows {
            if !row.id.is_empty() {
                ids.push(row.id.clone());
            }
        }
    }
    rels_out.extend(delete_absent_paper_rows(vault_root, rels, &ids)?);

    Ok(TrashResult {
        batch_id: manifest.batch_id,
        count: manifest.items.len(),
        rels: rels_out,
    })
}

/// Result of a delete request (trash or permanent).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub permanent: bool,
    /// Present for recycle-bin deletes; `None` for permanent deletes.
    pub batch_id: Option<String>,
    pub count: usize,
    pub paths: Vec<String>,
    /// Catalog rows removed under `papers/` (permanent deletes only).
    pub removed_rows: usize,
}

/// Delete vault paths either into the recycle bin (default, undoable) or
/// permanently. Shared by CLI `paper delete` and MCP `file_delete`.
pub fn delete_paths(
    vault_root: &Path,
    rels: &[String],
    permanent: bool,
) -> Result<DeleteResult, AppError> {
    if !permanent {
        let result = trash_paths(vault_root, rels)?;
        return Ok(DeleteResult {
            permanent: false,
            batch_id: Some(result.batch_id),
            count: result.count,
            paths: result.rels,
            removed_rows: 0,
        });
    }

    crate::fs::ensure_vault_dir(vault_root)?;
    let root = vault_root.canonicalize()?;
    let mut clean: Vec<(String, std::path::PathBuf, bool)> = Vec::new();
    for raw in rels {
        let rel = crate::fs::normalize_rel_separators(raw);
        let rel = rel.trim_matches('/');
        if rel.is_empty() {
            continue;
        }
        if rel == "papers"
            || rel == ".agentero"
            || rel.starts_with(".agentero/")
            || rel.split('/').any(|s| s == "..")
        {
            return Err(AppError::message(format!(
                "cannot permanently delete protected path: {rel}"
            )));
        }
        let abs = vault_root.join(rel);
        let meta = fs::symlink_metadata(&abs)
            .map_err(|_| AppError::message(format!("path not found: {rel}")))?;
        let resolved = abs.canonicalize()?;
        if !resolved.starts_with(&root) {
            return Err(AppError::message(format!("path escapes vault root: {rel}")));
        }
        clean.push((rel.to_string(), abs, meta.is_dir()));
    }
    if clean.is_empty() {
        return Err(AppError::message("paths is required"));
    }

    let mut removed_rows = 0usize;
    let mut paths = Vec::new();
    for (rel, abs, is_dir) in clean {
        // A directory link is an alias. Removing it must not walk into the
        // original paper. Catalog rows live at the canonical path, not here.
        if crate::fs::is_linked_dir(&abs) {
            removed_rows += papers::delete_under_path(vault_root, &rel)?;
            crate::fs::remove_directory_link(&abs)?;
            paths.push(rel);
            continue;
        }
        removed_rows += papers::delete_under_path(vault_root, &rel)?;
        if is_dir {
            fs::remove_dir_all(&abs)?;
        } else {
            fs::remove_file(&abs)?;
        }
        paths.push(rel);
    }
    Ok(DeleteResult {
        permanent: true,
        batch_id: None,
        count: paths.len(),
        paths,
        removed_rows,
    })
}

/// Restore a recycle-bin batch: move files back and re-insert catalog rows.
///
/// Aborts without changes if any original path has since been re-created, so a
/// restore never clobbers newer content.
pub fn restore_batch(vault_root: &Path, batch_id: &str) -> Result<usize, AppError> {
    crate::fs::ensure_vault_dir(vault_root)?;
    validate_batch_id(batch_id)?;
    let batch_dir = vault_root.join(TRASH_REL).join(batch_id);
    let mut manifest = read_manifest(&batch_dir)?;
    let count = manifest.items.len();
    // Preflight all targets before changing any files.
    for item in &manifest.items {
        restore_action(
            item,
            batch_dir.join(&item.stored).try_exists()?,
            vault_root.join(&item.rel).try_exists()?,
        )?;
    }
    for index in 0..count {
        restore_local_entry(vault_root, &batch_dir, &mut manifest, index)?;
    }
    fs::remove_dir_all(&batch_dir)?;
    Ok(count)
}

fn restore_local_entry(
    vault: &Path,
    batch: &Path,
    manifest: &mut TrashManifest,
    index: usize,
) -> Result<(), AppError> {
    let item = &manifest.items[index];
    let target = vault.join(&item.rel);
    match restore_action(
        item,
        batch.join(&item.stored).try_exists()?,
        target.try_exists()?,
    )? {
        RestoreAction::Unmoved => return Ok(()),
        RestoreAction::Move => {
            manifest.items[index].phase = TrashPhase::Restoring;
            write_manifest(batch, manifest)?;
            let item = &manifest.items[index];
            for row in &item.catalog_rows {
                let sidecar = batch
                    .join(&item.stored)
                    .join(restore_sidecar_path(item, row)?);
                // Catalog may still contain a child removed outside the app.
                if !sidecar.parent().expect("sidecar parent").try_exists()? {
                    continue;
                }
                crate::fs::atomic_write(&sidecar, &serde_json::to_vec_pretty(row)?)?;
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::rename(batch.join(&manifest.items[index].stored), &target)?;
        }
        RestoreAction::Finish => {}
    }
    restore_catalog(vault, &manifest.items[index])
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
            if item.phase == TrashPhase::Prepared && !batch_dir.join(&item.stored).try_exists()? {
                continue;
            }
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
                title: snapshot_title(&item.catalog_rows),
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
    crate::fs::ensure_vault_dir(vault_root)?;
    validate_batch_id(batch_id)?;
    let batch_dir = vault_root.join(TRASH_REL).join(batch_id);
    let mut manifest = read_manifest(&batch_dir)?;
    let idx = manifest
        .items
        .iter()
        .position(|i| i.stored == stored)
        .ok_or_else(|| AppError::message("trash item not found"))?;

    restore_local_entry(vault_root, &batch_dir, &mut manifest, idx)?;
    let item = manifest.items.remove(idx);
    if manifest.items.is_empty() {
        fs::remove_dir_all(&batch_dir)?;
    } else {
        write_manifest(&batch_dir, &manifest)?;
    }
    Ok(item.rel)
}

/// Permanently delete a single recycle-bin item.
pub fn purge_item(vault_root: &Path, batch_id: &str, stored: &str) -> Result<(), AppError> {
    crate::fs::ensure_vault_dir(vault_root)?;
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
            paper_type: papers::PaperKind::Doi,
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
            code_repo: None,
            openreview_url: None,
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
            custom_props: Default::default(),
            added_at: "t".into(),
            updated_at: "t".into(),
        }
    }

    #[test]
    fn plan_trash_skips_and_disambiguates_stored_names() {
        let rels = vec![
            String::new(),
            "papers".into(),
            "papers/../secret".into(),
            ".agentero/catalog.sqlite".into(),
            ".agentero".into(),
            "missing.md".into(),
            "notes/a.md".into(),
            "other/a.md".into(),
            "papers/x".into(),
            // `contains("..")` matches the local command, including this name.
            "notes..md".into(),
            r"papers\y".into(),
            // Not a `.agentero` prefix, so the local command trashes it.
            "notes/.agentero".into(),
        ];
        let present = [
            "notes/a.md",
            "other/a.md",
            "papers/x",
            "papers/y",
            "notes..md",
            "notes/.agentero",
        ];
        let mut present_calls = Vec::new();
        let mut row_calls = Vec::new();
        let plan = plan_trash(
            &rels,
            "batch-1",
            |rel| {
                present_calls.push(rel.to_string());
                present.contains(&rel)
            },
            |rel| {
                row_calls.push(rel.to_string());
                vec![sample_record(rel, "id")]
            },
        )
        .unwrap();

        let got: Vec<_> = plan
            .items
            .iter()
            .map(|item| {
                (
                    item.rel.as_str(),
                    item.stored.as_str(),
                    item.catalog_rows.len(),
                )
            })
            .collect();
        assert_eq!(
            got,
            vec![
                ("notes/a.md", "6__a.md", 0),
                ("other/a.md", "7__a.md", 0),
                ("papers/x", "8__x", 1),
                ("papers/y", "10__y", 1),
                ("notes/.agentero", "11__.agentero", 0),
            ]
        );
        assert_eq!(plan.batch_id, "batch-1");
        // Skipped shapes are not probed; missing.md is probed and rejected.
        assert!(present_calls.contains(&"missing.md".to_string()));
        assert!(!present_calls.iter().any(|rel| rel.contains("..")));
        assert!(!present_calls.iter().any(|rel| rel.starts_with(".agentero")));
        assert_eq!(
            row_calls,
            vec!["papers/x".to_string(), "papers/y".to_string()]
        );
        assert_eq!(plan.items[2].catalog_rows[0].title, "T");
    }

    #[test]
    fn plan_trash_keeps_parent_with_complete_snapshot() {
        let rels = vec!["papers/group/paperA".into(), "papers/group".into()];
        let plan = plan_trash(
            &rels,
            "batch-1",
            |_| true,
            |rel| {
                if rel == "papers/group" {
                    vec![
                        sample_record("papers/group/paperA", "a"),
                        sample_record("papers/group/paperB", "b"),
                    ]
                } else {
                    vec![sample_record("papers/group/paperA", "a")]
                }
            },
        )
        .unwrap();

        assert_eq!(plan.items.len(), 1);
        assert_eq!(plan.items[0].rel, "papers/group");
        assert_eq!(plan.items[0].catalog_rows.len(), 2);
    }

    #[test]
    fn plan_trash_rejects_batch_id_before_callbacks() {
        for bad in ["", "a/b", r"a\b", "..", "batch/../x", "foo..bar"] {
            let called = std::cell::Cell::new(false);
            let err = plan_trash(
                &["notes/a.md".into()],
                bad,
                |_| {
                    called.set(true);
                    true
                },
                |_| {
                    called.set(true);
                    Vec::new()
                },
            )
            .unwrap_err();
            assert!(!called.get(), "callbacks ran for {bad}");
            assert!(err.to_string().contains("invalid batch id"), "{bad}: {err}");
        }
        let empty = plan_trash(&[], "20261022T130000-1", |_| true, |_| Vec::new()).unwrap();
        assert!(empty.items.is_empty());
        assert!(validate_batch_id("ok-id").is_ok());
    }

    #[test]
    fn manifest_roundtrips_camel_case() {
        let raw = r#"{
            "batchId": "20260101T000000-1",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "items": [{ "rel": "notes/a.md", "stored": "0__a.md" }]
        }"#;
        let manifest: TrashManifest = serde_json::from_str(raw).unwrap();
        assert_eq!(manifest.batch_id, "20260101T000000-1");
        assert_eq!(manifest.created_at, "2026-01-01T00:00:00.000Z");
        assert_eq!(manifest.items[0].rel, "notes/a.md");
        assert_eq!(manifest.items[0].stored, "0__a.md");
        assert!(manifest.items[0].catalog_rows.is_empty());

        let json = serde_json::to_value(&manifest).unwrap();
        assert!(json.get("batchId").is_some());
        assert!(json.get("batch_id").is_none());
        assert!(json["items"][0].get("catalogRows").is_some());
        assert!(json["items"][0].get("catalog_rows").is_none());
    }

    #[test]
    fn restore_parent_keeps_orphan_catalog_rows_without_creating_directories() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("papers/group")).unwrap();
        fs::write(root.path().join("papers/group/note.md"), "keep").unwrap();
        papers::upsert_paper(
            root.path(),
            &sample_record("papers/group/missing", "missing"),
        )
        .unwrap();
        let batch = trash_paths(root.path(), &["papers/group".into()]).unwrap();
        restore_batch(root.path(), &batch.batch_id).unwrap();
        assert_eq!(
            fs::read_to_string(root.path().join("papers/group/note.md")).unwrap(),
            "keep"
        );
        assert!(!root.path().join("papers/group/missing").exists());
    }

    #[test]
    fn restore_exposes_manifest_metadata_before_watcher_recovery() {
        for selected in ["papers/group/x", "papers/group"] {
            let root = tempfile::tempdir().unwrap();
            let path = "papers/group/x";
            fs::create_dir_all(root.path().join(path)).unwrap();
            let old = sample_record(path, "x");
            papers::upsert_paper(root.path(), &old).unwrap();
            // A committed update whose projection has not run before trash.
            crate::features::catalog::with_catalog(root.path(), |conn| {
                conn.execute("UPDATE papers SET title = 'Latest' WHERE path = ?1", [path])?;
                Ok(())
            })
            .unwrap();
            let batch = trash_paths(root.path(), &[selected.into()]).unwrap();
            crate::features::catalog::with_catalog(root.path(), |conn| {
                conn.execute_batch("CREATE TRIGGER fail_restore BEFORE INSERT ON papers BEGIN SELECT RAISE(FAIL, 'injected'); END;")?;
                Ok(())
            }).unwrap();
            assert!(restore_batch(root.path(), &batch.batch_id).is_err());
            crate::features::catalog::with_catalog(root.path(), |conn| {
                conn.execute_batch("DROP TRIGGER fail_restore")?;
                Ok(())
            })
            .unwrap();
            papers::ensure_rows_for_paths(
                root.path(),
                &[root.path().join(path).to_string_lossy().into_owned()],
            )
            .unwrap();
            restore_batch(root.path(), &batch.batch_id).unwrap();
            assert_eq!(
                papers::get_by_path(root.path(), path)
                    .unwrap()
                    .unwrap()
                    .title,
                "Latest"
            );
        }
    }

    #[test]
    fn restore_retries_after_catalog_failure() {
        let root = tempfile::tempdir().unwrap();
        for id in ["a", "b"] {
            fs::create_dir_all(root.path().join(format!("papers/{id}"))).unwrap();
            papers::upsert_paper(root.path(), &sample_record(&format!("papers/{id}"), id)).unwrap();
        }
        let batch = trash_paths(root.path(), &["papers/a".into(), "papers/b".into()]).unwrap();
        crate::features::catalog::with_catalog(root.path(), |conn| {
            conn.execute_batch("CREATE TRIGGER fail_restore BEFORE INSERT ON papers WHEN NEW.id = 'b' BEGIN SELECT RAISE(FAIL, 'injected'); END;")?;
            Ok(())
        }).unwrap();
        assert!(restore_batch(root.path(), &batch.batch_id).is_err());
        papers::set_is_read(root.path(), "papers/a", true).unwrap();
        crate::features::catalog::with_catalog(root.path(), |conn| {
            conn.execute_batch("DROP TRIGGER fail_restore")?;
            Ok(())
        })
        .unwrap();
        assert_eq!(restore_batch(root.path(), &batch.batch_id).unwrap(), 2);
        assert!(
            papers::get_by_path(root.path(), "papers/a")
                .unwrap()
                .unwrap()
                .is_read
        );
        assert!(papers::get_by_path(root.path(), "papers/b")
            .unwrap()
            .is_some());
    }

    #[test]
    fn single_restore_retries_and_prepared_items_preserve_existing_files() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("papers/a")).unwrap();
        papers::upsert_paper(root.path(), &sample_record("papers/a", "a")).unwrap();
        let batch = trash_paths(root.path(), &["papers/a".into()]).unwrap();
        let batch_dir = root.path().join(TRASH_REL).join(&batch.batch_id);
        let manifest = read_manifest(&batch_dir).unwrap();
        let stored = &manifest.items[0].stored;
        crate::features::catalog::with_catalog(root.path(), |conn| {
            conn.execute_batch("CREATE TRIGGER fail_restore BEFORE INSERT ON papers BEGIN SELECT RAISE(FAIL, 'injected'); END;")?;
            Ok(())
        }).unwrap();
        assert!(restore_item(root.path(), &batch.batch_id, stored).is_err());
        crate::features::catalog::with_catalog(root.path(), |conn| {
            conn.execute_batch("DROP TRIGGER fail_restore")?;
            Ok(())
        })
        .unwrap();
        restore_item(root.path(), &batch.batch_id, stored).unwrap();
        assert!(papers::get_by_path(root.path(), "papers/a")
            .unwrap()
            .is_some());

        // A crash before the first trash rename leaves only the intent.
        fs::create_dir_all(&batch_dir).unwrap();
        let mut intent = manifest;
        intent.items[0].phase = TrashPhase::Prepared;
        write_manifest(&batch_dir, &intent).unwrap();
        assert!(list_trash(root.path()).unwrap().is_empty());
        restore_batch(root.path(), &batch.batch_id).unwrap();
        assert!(root.path().join("papers/a").is_dir());
    }

    #[test]
    fn overlapping_and_duplicate_paths_restore_without_collisions() {
        for paths in [
            vec!["notes/group", "notes/group/a.md", "notes/group"],
            vec!["notes/group/a.md", "notes/group", "notes/group/a.md"],
        ] {
            let root = tempfile::tempdir().unwrap();
            fs::create_dir_all(root.path().join("notes/group")).unwrap();
            fs::write(root.path().join("notes/group/a.md"), "a").unwrap();
            let paths = paths.into_iter().map(str::to_owned).collect::<Vec<_>>();
            let batch = trash_paths(root.path(), &paths).unwrap();
            assert_eq!(batch.count, 1);
            restore_batch(root.path(), &batch.batch_id).unwrap();
            assert_eq!(
                fs::read_to_string(root.path().join("notes/group/a.md")).unwrap(),
                "a"
            );
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
    fn trash_drops_catalog_row_when_paper_folder_is_already_gone() {
        let dir = env::temp_dir().join(format!(
            "agentero-trash-ghost-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&dir);
        papers::upsert_paper(&dir, &sample_record("papers/ghost", "same")).unwrap();
        papers::upsert_paper(&dir, &sample_record("papers/other-ghost", "same")).unwrap();
        let keep = dir.join("papers/keep");
        fs::create_dir_all(&keep).unwrap();
        fs::write(keep.join("NOTES.md"), "# keep\n").unwrap();
        papers::upsert_paper(&dir, &sample_record("papers/keep", "same")).unwrap();

        let res = trash_paths(&dir, &["papers/ghost".to_string()]).unwrap();
        assert_eq!(res.count, 0);
        assert_eq!(
            res.rels,
            vec!["papers/ghost".to_string(), "papers/other-ghost".to_string()]
        );
        assert!(papers::get_by_path(&dir, "papers/ghost").unwrap().is_none());
        assert!(papers::get_by_path(&dir, "papers/other-ghost")
            .unwrap()
            .is_none());
        assert!(papers::get_by_path(&dir, "papers/keep").unwrap().is_some());
        assert!(list_trash(&dir).unwrap().is_empty());

        let real = dir.join("papers/real");
        fs::create_dir_all(&real).unwrap();
        fs::write(real.join("NOTES.md"), "# real\n").unwrap();
        papers::upsert_paper(&dir, &sample_record("papers/real", "same")).unwrap();
        papers::upsert_paper(&dir, &sample_record("papers/leftover", "same")).unwrap();
        let res = trash_paths(&dir, &["papers/real".to_string()]).unwrap();
        assert_eq!(res.count, 1);
        assert!(!real.exists());
        assert!(papers::get_by_path(&dir, "papers/real").unwrap().is_none());
        assert!(papers::get_by_path(&dir, "papers/leftover")
            .unwrap()
            .is_none());
        assert!(papers::get_by_path(&dir, "papers/keep").unwrap().is_some());
        assert_eq!(list_trash(&dir).unwrap().len(), 1);

        let untouched = trash_paths(&dir, &["notes/missing.md".to_string()]).unwrap();
        assert_eq!(untouched.count, 0);
        assert!(untouched.rels.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_reports_paper_title() {
        let dir = env::temp_dir().join(format!("agentero-trash-title-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let paper_dir = dir.join("papers").join("2501.00001");
        fs::create_dir_all(&paper_dir).unwrap();
        fs::write(paper_dir.join("NOTES.md"), "# hi\n").unwrap();
        papers::upsert_paper(&dir, &sample_record("papers/2501.00001", "2501.00001")).unwrap();
        let notes = dir.join("notes");
        fs::create_dir_all(&notes).unwrap();
        fs::write(notes.join("a.md"), "a\n").unwrap();

        let res = trash_paths(
            &dir,
            &["papers/2501.00001".to_string(), "notes/a.md".to_string()],
        )
        .unwrap();
        assert_eq!(res.count, 2);

        let items = list_trash(&dir).unwrap();
        let paper = items.iter().find(|e| e.rel == "papers/2501.00001").unwrap();
        // Paper entries surface the snapshotted catalog title for display.
        assert_eq!(paper.title.as_deref(), Some("T"));
        let note = items.iter().find(|e| e.rel == "notes/a.md").unwrap();
        assert!(note.title.is_none());

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
    fn delete_paths_supports_trash_and_permanent_modes() {
        let dir = env::temp_dir().join(format!("agentero-delete-mode-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("notes")).unwrap();
        fs::write(dir.join("notes/a.md"), "a\n").unwrap();

        let trashed = delete_paths(&dir, &["notes/a.md".into()], false).unwrap();
        assert!(!trashed.permanent);
        assert!(trashed.batch_id.is_some());
        assert_eq!(trashed.count, 1);
        assert!(restore_batch(&dir, trashed.batch_id.as_deref().unwrap()).is_ok());

        let deleted = delete_paths(&dir, &["notes/a.md".into()], true).unwrap();
        assert!(deleted.permanent);
        assert!(deleted.batch_id.is_none());
        assert!(!dir.join("notes/a.md").exists());
        assert!(delete_paths(&dir, &["papers".into()], true).is_err());
        assert!(delete_paths(&dir, &[".agentero/x".into()], true).is_err());

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
