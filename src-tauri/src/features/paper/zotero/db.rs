//! Read a local Zotero library (`zotero.sqlite` + `storage/`) and migrate it
//! into the Motif catalog.
//!
//! Strategy: reconstruct each regular item as a **Zotero API JSON item** and
//! reuse the existing `map_zotero_item_to_record` + paper-shell/catalog pipeline, so the
//! id/citekey and field mapping match the magic-wand / file import exactly.
//! Everything is local: no Translator is contacted.

use super::ZOTERO_INTERNAL_TAG_PREFIX;
use crate::core::error::AppError;
use crate::features::paper::catalog::papers;
use crate::features::paper::import::{
    allocate_paper_path, map_zotero_item_to_record, normalize_parent_dir, write_paper_shell,
    NoteShellMode,
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroScanArgs {
    /// Absolute path to the Zotero data directory (contains zotero.sqlite + storage/).
    pub zotero_dir: String,
}

/// A Zotero collection surfaced in the scan preview (for the folder picker).
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroCollectionInfo {
    /// Zotero collectionID, or 0 for the pseudo "unfiled" bucket.
    pub id: i64,
    /// Full folder path label (empty for unfiled).
    pub path: String,
    pub item_count: usize,
}

/// One migratable item surfaced in the scan (for the per-paper picker).
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroItemInfo {
    /// Zotero itemID (stable within a library); used by `include_items`.
    pub id: i64,
    pub title: String,
    /// Zotero item type (journalArticle, webpage, …) for the picker badge.
    pub item_type: String,
    pub year: Option<i64>,
    pub has_pdf: bool,
    pub notes: usize,
    /// collectionIDs this item belongs to (for client-side collection filtering).
    pub collections: Vec<i64>,
}

#[derive(Debug, Default, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroScan {
    pub valid: bool,
    pub item_count: usize,
    pub with_pdf_count: usize,
    pub note_count: usize,
    pub collections: Vec<ZoteroCollectionInfo>,
    pub items: Vec<ZoteroItemInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

/// Progress event streamed to the UI while a migration runs.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MigrateProgress {
    pub current: usize,
    pub total: usize,
    pub phase: String,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroMigrateArgs {
    pub vault_path: String,
    pub zotero_dir: String,
    /// Vault-relative parent, e.g. `papers` (default) or `papers/zotero`.
    #[serde(default)]
    pub parent_dir: Option<String>,
    /// Copy each item's local PDF into the paper folder.
    #[serde(default)]
    pub copy_pdfs: bool,
    /// Recreate Zotero collections as nested subfolders under `parent_dir`.
    #[serde(default)]
    pub preserve_collections: bool,
    /// If set, only import items in these collection IDs (0 = unfiled). None = all.
    #[serde(default)]
    pub include_collections: Option<Vec<i64>>,
    /// If set, only import these Zotero itemIDs (per-paper selection). None = all.
    #[serde(default)]
    pub include_items: Option<Vec<i64>>,
    /// When set (a Zotero collectionID), placement prefers the item's own
    /// collection inside this collection's subtree over a deeper path in
    /// another branch — so importing a selected folder puts its papers where
    /// the user expects even when they also live in other collections.
    #[serde(default)]
    pub prefer_collection: Option<i64>,
    /// Migrate Zotero notes: child notes into each paper's NOTES.md, and
    /// standalone notes (no parent item) into `notes/` as Markdown files.
    #[serde(default)]
    pub migrate_notes: bool,
    /// Migrate each item's PDF annotations (highlights/comments) into NOTES.md.
    #[serde(default)]
    pub migrate_annotations: bool,
}

#[derive(Debug, Default, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroMigrateResult {
    pub imported: usize,
    pub skipped: usize,
    /// Zotero item types intentionally outside Agentero's paper model (currently
    /// `computerProgram`). Kept separate from duplicate skips for an auditable
    /// source-item total.
    pub ignored_unsupported: usize,
    pub copied_pdfs: usize,
    /// Zotero notes backfilled into existing papers' NOTES.md (already-present papers).
    pub notes_added: usize,
    /// Standalone Zotero notes (no parent item) written as Markdown files under `notes/`.
    pub standalone_notes: usize,
    /// Already-imported papers moved into their collection folder on re-migration.
    pub relocated: usize,
    /// Duplicate Zotero items merged into an already-imported paper (one
    /// vault copy per real paper; notes/annotations backfilled into it).
    pub merged_duplicates: usize,
    /// Orphan catalog rows removed before import (paper folder gone from disk).
    pub pruned: usize,
    pub paths: Vec<String>,
    pub errors: Vec<String>,
}

/// One regular Zotero item, reconstructed as a Zotero API JSON object plus the
/// resolved local PDF attachment paths (real files that exist on disk).
struct ReadItem {
    /// Zotero itemID (per-paper include filter + scan preview).
    item_id: i64,
    json: Value,
    pdfs: Vec<PathBuf>,
    /// Sanitized folder segments of the item's chosen Zotero collection (empty = unfiled).
    collection_path: Vec<String>,
    /// Raw Zotero collectionIDs this item belongs to (for the include filter).
    collection_ids: Vec<i64>,
    /// Raw HTML of the item's child notes (converted to Markdown at import time).
    note_html: Vec<String>,
    /// Pre-formatted Markdown blocks for the item's PDF annotations.
    annotations: Vec<String>,
}

/// Read-only preview: how many regular items, and how many have a local PDF.
pub fn scan_zotero(args: ZoteroScanArgs) -> Result<ZoteroScan, AppError> {
    let dir = PathBuf::from(args.zotero_dir.trim());
    if !dir.is_dir() {
        return Err(AppError::message("selected path is not a folder"));
    }
    let ZoteroRead {
        items: read_items,
        standalone_notes,
        collections,
    } = read_all_items(&dir)?;
    let with_pdf = read_items.iter().filter(|i| !i.pdfs.is_empty()).count();
    let child_notes: usize = read_items.iter().map(|i| i.note_html.len()).sum();
    let mut items: Vec<ZoteroItemInfo> = read_items.iter().map(item_info).collect();
    for note in &standalone_notes {
        items.push(standalone_item_info(note));
    }
    Ok(ZoteroScan {
        valid: true,
        item_count: items.len(),
        with_pdf_count: with_pdf,
        note_count: child_notes + standalone_notes.len(),
        collections,
        items,
        warning: None,
    })
}

fn item_info(it: &ReadItem) -> ZoteroItemInfo {
    ZoteroItemInfo {
        id: it.item_id,
        title: it.json["title"].as_str().unwrap_or_default().to_string(),
        item_type: it.json["itemType"].as_str().unwrap_or_default().to_string(),
        year: parse_year(it.json.get("date").and_then(|v| v.as_str())),
        has_pdf: !it.pdfs.is_empty(),
        notes: it.note_html.len(),
        collections: it.collection_ids.clone(),
    }
}

/// First 4-digit run in a Zotero date string (e.g. "2017-06-12" → 2017).
fn parse_year(date: Option<&str>) -> Option<i64> {
    let d = date?;
    for w in d.as_bytes().windows(4) {
        if w.iter().all(u8::is_ascii_digit) {
            if let Ok(y) = std::str::from_utf8(w).unwrap_or_default().parse::<i64>() {
                if (1000..=9999).contains(&y) {
                    return Some(y);
                }
            }
        }
    }
    None
}

/// Migrate every regular item into `papers/…` + catalog. Optionally copy PDFs.
pub async fn migrate_zotero(
    args: ZoteroMigrateArgs,
    progress: impl Fn(usize, usize, &str),
    app: Option<&tauri::AppHandle>,
    note_mode: NoteShellMode,
) -> Result<ZoteroMigrateResult, AppError> {
    let vault = crate::core::fs::resolve_vault(&args.vault_path)?;
    let zotero_dir = PathBuf::from(args.zotero_dir.trim());
    if !zotero_dir.is_dir() {
        return Err(AppError::message(
            "selected Zotero folder is not a directory",
        ));
    }
    let parent_rel = normalize_parent_dir(args.parent_dir.as_deref().unwrap_or("papers"))?;

    let ZoteroRead {
        items,
        standalone_notes,
        collections,
    } = read_all_items(&zotero_dir)?;

    // Deleting paper folders outside the app leaves orphan catalog rows; drop them
    // first so dedup does not block re-import and the Library shows no ghosts.
    let pruned = papers::prune_missing(&vault).unwrap_or(0);

    // Dedup against the existing catalog (and within this run) by strong ids +
    // normalized title, so re-runs and pre-existing papers are skipped without
    // losing distinct papers that happen to share a citekey.
    let mut dedup = Dedup::from_catalog(&vault);

    let mut out = ZoteroMigrateResult {
        pruned,
        ignored_unsupported: count_ignored_unsupported_items(&zotero_dir).unwrap_or(0),
        ..Default::default()
    };

    // Per-paper selection takes precedence; otherwise an optional collection
    // filter (0 = unfiled). Neither set → import everything.
    let include_items: Option<HashSet<i64>> = args
        .include_items
        .as_ref()
        .map(|v| v.iter().copied().collect());
    let include_colls: Option<HashSet<i64>> = args
        .include_collections
        .as_ref()
        .map(|v| v.iter().copied().collect());

    let flags = MigrateFlags {
        copy_pdfs: args.copy_pdfs,
        preserve_collections: args.preserve_collections,
        migrate_notes: args.migrate_notes,
        migrate_annotations: args.migrate_annotations,
        prefer_collection: args.prefer_collection,
    };

    // Materialize the collection tree up front so the vault structure matches
    // the library even when no paper lands in some folders (previously folders
    // only existed as a side effect of placement, which made sub-collections
    // "disappear"). Scoped to the selection: importing one Zotero folder must
    // not materialize the rest of the library's tree as empty folders.
    if flags.preserve_collections {
        let prefer_path = flags.prefer_collection.and_then(|pid| {
            collections
                .iter()
                .find(|c| c.id == pid)
                .map(|c| c.path.clone())
                .filter(|p| !p.is_empty())
        });
        if let Some(pref) = &prefer_path {
            // A folder was selected: keep only that folder and its descendants,
            // including empty ones, so the imported subtree is complete.
            let prefix = format!("{pref}/");
            for c in &collections {
                if c.path == *pref || c.path.starts_with(&prefix) {
                    let _ = fs::create_dir_all(vault.join(&parent_rel).join(&c.path));
                }
            }
        } else if include_items.is_none() {
            // Whole-library import: the full tree, including empty collections
            // and ones whose items were deduped against the catalog.
            for c in &collections {
                if c.path.is_empty() {
                    continue; // pseudo "unfiled" bucket
                }
                let _ = fs::create_dir_all(vault.join(&parent_rel).join(&c.path));
            }
        }
        // Item-scoped import without a folder selection: no up-front tree;
        // folders appear where papers actually land.
    }

    // Apply per-paper / collection selection up front so the progress total
    // reflects only the items that will actually be processed (previously the
    // bar counted the whole library even when only a subset was selected).
    let selected_items: Vec<ReadItem> = items
        .into_iter()
        .filter(|item| {
            item_included(
                item.item_id,
                &item.collection_ids,
                &include_items,
                &include_colls,
            )
        })
        .collect();
    let selected_notes: Vec<StandaloneNote> = if flags.migrate_notes {
        standalone_notes
            .into_iter()
            .filter(|note| {
                item_included(
                    note.item_id,
                    &note.collection_ids,
                    &include_items,
                    &include_colls,
                )
            })
            .collect()
    } else {
        Vec::new()
    };

    // Placement lookup: collectionID -> sanitized path segments. Used to
    // honor the selected-collection preference for multi-folder items.
    let id_to_path: HashMap<i64, Vec<String>> = collections
        .iter()
        .map(|c| {
            (
                c.id,
                c.path
                    .split('/')
                    .filter(|s| !s.is_empty())
                    .map(String::from)
                    .collect(),
            )
        })
        .collect();

    let paper_total = selected_items.len();
    let total = paper_total + selected_notes.len();
    for (idx, item) in selected_items.into_iter().enumerate() {
        progress(idx, total, "migrate");
        // Placement path honors the selected-collection preference.
        let coll_path = if flags.prefer_collection.is_some() {
            collection_path_prefer(&id_to_path, &item.collection_ids, flags.prefer_collection)
        } else {
            item.collection_path.clone()
        };
        match migrate_one(
            &vault,
            &parent_rel,
            &item,
            &coll_path,
            flags,
            &mut dedup,
            note_mode,
        )
        .await
        {
            Ok((MigrateOutcome::Imported { path, copied_pdf }, dup)) => {
                out.imported += 1;
                if dup {
                    out.merged_duplicates += 1;
                }
                out.paths.push(path);
                if copied_pdf {
                    out.copied_pdfs += 1;
                }
            }
            Ok((MigrateOutcome::NotesBackfilled { path }, dup)) => {
                out.notes_added += 1;
                if dup {
                    out.merged_duplicates += 1;
                }
                out.paths.push(path);
            }
            Ok((MigrateOutcome::Relocated { path, backfilled }, dup)) => {
                out.relocated += 1;
                if backfilled {
                    out.notes_added += 1;
                }
                if dup {
                    out.merged_duplicates += 1;
                }
                out.paths.push(path);
            }
            Ok((MigrateOutcome::Skipped, dup)) => {
                out.skipped += 1;
                if dup {
                    out.merged_duplicates += 1;
                }
            }
            Err(e) => out.errors.push(e.to_string()),
        }
    }

    if !selected_notes.is_empty() {
        let mut known = index_zotero_notes(&vault.join("notes"));
        for (idx, note) in selected_notes.into_iter().enumerate() {
            progress(paper_total + idx, total, "migrate");
            let coll_path = if flags.prefer_collection.is_some() {
                collection_path_prefer(&id_to_path, &note.collection_ids, flags.prefer_collection)
            } else {
                note.collection_path.clone()
            };
            match import_standalone_note(
                &vault,
                &note,
                &coll_path,
                flags.preserve_collections,
                &known,
            ) {
                Ok(StandaloneNoteWrite::Created(path)) => {
                    known.insert(note_identity(&note.key, note.item_id), path);
                    out.standalone_notes += 1;
                }
                Ok(StandaloneNoteWrite::Skipped) => {}
                Err(e) => out.errors.push(e.to_string()),
            }
        }
    }

    progress(total, total, "migrate");
    for path in &out.paths {
        crate::features::jobs::spawn_parse_body_after_assets(app, &vault, path, false);
    }
    Ok(out)
}

enum MigrateOutcome {
    Imported { path: String, copied_pdf: bool },
    NotesBackfilled { path: String },
    Relocated { path: String, backfilled: bool },
    Skipped,
}

#[derive(Clone, Copy)]
struct MigrateFlags {
    copy_pdfs: bool,
    preserve_collections: bool,
    migrate_notes: bool,
    migrate_annotations: bool,
    /// Placement preference: keep papers inside the selected collection's
    /// subtree when possible (see `chosen_collection_path_prefer`).
    prefer_collection: Option<i64>,
}

async fn migrate_one(
    vault: &Path,
    parent_rel: &str,
    item: &ReadItem,
    coll_path: &[String],
    flags: MigrateFlags,
    dedup: &mut Dedup,
    note_mode: NoteShellMode,
) -> Result<(MigrateOutcome, bool), AppError> {
    let mut meta = map_zotero_item_to_record(&item.json)?; // errors when the item has no title
    let id = meta.id.clone();
    if id.is_empty() {
        return Err(AppError::message("mapped item has empty id"));
    }

    let blocks = note_blocks(item, flags.migrate_notes, flags.migrate_annotations);

    // Recreate the Zotero collection folder under the base parent when requested.
    let base_parent = if flags.preserve_collections && !coll_path.is_empty() {
        format!("{parent_rel}/{}", coll_path.join("/"))
    } else {
        parent_rel.to_string()
    };
    // Let the sidebar locate the physical collection tree even when the user
    // chose a non-default parent directory. Combined with every full
    // `@zotero:collection:` membership, this makes a virtual reference appear
    // inside each *other* real collection folder without copying the paper.
    if flags.preserve_collections && !item.collection_ids.is_empty() {
        let root = parent_rel.trim_matches('/');
        let tag = format!("@zotero:collection-root:{root}");
        if !meta
            .tags
            .iter()
            .any(|existing| existing.name.eq_ignore_ascii_case(&tag))
        {
            meta.tags.push(papers::PaperTag::new(tag));
        }
    }

    if dedup.contains(&meta) {
        // Paper already in the vault. When it sits outside its collection
        // folder (e.g. a legacy flat import), move it into place so a
        // re-migration converges onto the Zotero tree; then backfill missing
        // notes/annotations into NOTES.md (idempotent by content). Never
        // re-import or touch other content.
        let mut path = dedup.existing_path(&meta);
        let mut relocated = false;
        if flags.preserve_collections && !coll_path.is_empty() {
            if let Some(existing) = path.clone() {
                if let Some(new_rel) = plan_relocation(&existing, &base_parent) {
                    relocate_paper(vault, &existing, &new_rel)?;
                    dedup.insert(&meta, &new_rel);
                    path = Some(new_rel);
                    relocated = true;
                }
            }
        }
        let mut backfilled = false;
        if !blocks.is_empty() {
            if let Some(p) = &path {
                let notes_md = vault.join(p).join("NOTES.md");
                if notes_md.is_file() && append_markdown_blocks(&notes_md, &blocks) {
                    backfilled = true;
                }
            }
        }
        // Backfill the Zotero linkage on legacy rows (imported before the
        // sync columns existed) so later syncs match exactly. A row already
        // linked to a DIFFERENT Zotero item means this item is a duplicate
        // that got merged into the existing paper.
        let mut duplicate = false;
        if let Some(p) = &path {
            if let Ok(Some(mut rec)) = papers::get_by_path(vault, p) {
                let mut changed = false;
                // Existing papers may have been imported before full Zotero
                // collection metadata existed. Merge this item's tags instead
                // of replacing user-created tags, so a re-migration rebuilds
                // the in-place virtual collection references.
                for tag in &meta.tags {
                    if !rec
                        .tags
                        .iter()
                        .any(|existing| existing.name.eq_ignore_ascii_case(&tag.name))
                    {
                        rec.tags.push(tag.clone());
                        changed = true;
                    }
                }
                match rec.zotero_item_id {
                    None => {
                        rec.zotero_item_id = Some(item.item_id);
                        changed = true;
                    }
                    Some(zid) if zid != item.item_id => duplicate = true,
                    _ => {}
                }
                if changed {
                    let _ = papers::upsert_paper(vault, &rec);
                }
            }
        }
        if relocated {
            return Ok((
                MigrateOutcome::Relocated {
                    path: path.unwrap_or_default(),
                    backfilled,
                },
                duplicate,
            ));
        }
        if backfilled {
            return Ok((
                MigrateOutcome::NotesBackfilled {
                    path: path.unwrap_or_default(),
                },
                duplicate,
            ));
        }
        return Ok((MigrateOutcome::Skipped, duplicate));
    }

    let unique_local_id =
        meta.paper_type == papers::PaperKind::Pdf && meta.doi.is_none() && meta.arxiv_id.is_none();
    let (folder_id, path_rel, paper_dir) =
        allocate_paper_path(vault, &base_parent, &id, unique_local_id);
    meta.id = folder_id;
    fs::create_dir_all(&paper_dir)?;
    write_paper_shell(&paper_dir, vault, &meta, note_mode).await?;
    if !blocks.is_empty() {
        append_markdown_blocks(&paper_dir.join("NOTES.md"), &blocks);
    }
    let mut record = meta.clone().at_path(&path_rel);
    // Zotero sync linkage: fresh imports carry their source itemID so later
    // bidirectional syncs match exactly (fallback stays DOI/arXiv/title).
    record.zotero_item_id = Some(item.item_id);
    record.zotero_last_synced = Some(crate::core::time::now_rfc3339_millis());
    papers::upsert_paper(vault, &record)?;
    dedup.insert(&meta, &path_rel);

    let mut copied = false;
    if flags.copy_pdfs {
        if let Some(src) = item.pdfs.first() {
            let dest = paper_dir.join(pdf_dest_name(&meta.id));
            if fs::copy(src, &dest).is_ok() {
                copied = true;
                crate::features::paper::import::code_repo::fill_code_repo_from_pdf(
                    vault, &path_rel,
                )
                .await;
            }
        }
    }

    Ok((
        MigrateOutcome::Imported {
            path: path_rel,
            copied_pdf: copied,
        },
        false,
    ))
}

/// New vault-relative path when an existing paper sits outside its collection
/// folder; `None` when it already lives where the collection tree would put it.
fn plan_relocation(existing: &str, base_parent: &str) -> Option<String> {
    let existing = existing.trim_matches('/');
    let folder_id = existing.rsplit('/').next()?.trim();
    if folder_id.is_empty() {
        return None;
    }
    let existing_parent = existing.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
    if existing_parent == base_parent.trim_matches('/') {
        return None;
    }
    Some(format!("{base_parent}/{folder_id}"))
}

/// Move a paper folder to a new vault-relative path and rewrite its catalog
/// row (keyed by path). Refuses to overwrite anything on disk or in the
/// catalog; rolls the folder back when the catalog rewrite fails.
fn relocate_paper(vault: &Path, existing: &str, new_rel: &str) -> Result<(), AppError> {
    let record = papers::get_by_path(vault, existing)?
        .ok_or_else(|| AppError::message(format!("catalog row missing for {existing}")))?;
    if papers::get_by_path(vault, new_rel)?.is_some() {
        return Err(AppError::message(format!(
            "target already cataloged: {new_rel}"
        )));
    }
    let src = vault.join(existing);
    let dst = vault.join(new_rel);
    if !src.is_dir() {
        return Err(AppError::message(format!(
            "paper folder missing: {existing}"
        )));
    }
    if dst.exists() {
        return Err(AppError::message(format!(
            "target already exists: {new_rel}"
        )));
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(&src, &dst)?;
    let rewrite = (|| -> Result<(), AppError> {
        papers::delete_under_path(vault, existing)?;
        let mut moved = record;
        moved.path = new_rel.replace('\\', "/");
        papers::upsert_paper(vault, &moved)?;
        Ok(())
    })();
    if rewrite.is_err() {
        // Best-effort rollback so disk and catalog agree again.
        let _ = fs::rename(&dst, &src);
        return rewrite;
    }
    Ok(())
}

pub(crate) use agentero_core::features::markdown::append::append_markdown_blocks;

/// Markdown blocks to migrate into NOTES.md: converted child notes + PDF annotations.
fn note_blocks(item: &ReadItem, migrate_notes: bool, migrate_annotations: bool) -> Vec<String> {
    let mut blocks = Vec::new();
    if migrate_notes {
        for html in &item.note_html {
            // Never import Agentero's own sync notes back into the vault
            // (intact, escaped or otherwise damaged marker forms alike).
            if super::codec::looks_like_sync_note(html) {
                continue;
            }
            let md = htmd::convert(html).unwrap_or_else(|_| html.clone());
            let md = md.trim().to_string();
            if !md.is_empty() {
                blocks.push(md);
            }
        }
    }
    if migrate_annotations && !item.annotations.is_empty() {
        // Group every highlight into a single block so import adds one tidy
        // section (a lone `---` divider), not a divider between each highlight.
        let hl = item
            .annotations
            .iter()
            .map(|a| a.trim())
            .filter(|a| !a.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
        if !hl.is_empty() {
            blocks.push(hl);
        }
    }
    blocks
}

/// Skip real duplicates / re-runs by arXiv id, DOI, or normalized title.
/// Maps each key to the existing paper's vault-relative path (for note backfill).
#[derive(Default)]
struct Dedup {
    arxiv: HashMap<String, String>,
    doi: HashMap<String, String>,
    title: HashMap<String, String>,
}

impl Dedup {
    fn from_catalog(vault: &Path) -> Self {
        let mut d = Dedup::default();
        for r in papers::list_all(vault).unwrap_or_default() {
            if let Some(a) = r.arxiv_id.as_deref().filter(|s| !s.is_empty()) {
                d.arxiv.insert(a.to_lowercase(), r.path.clone());
            }
            if let Some(x) = r.doi.as_deref().filter(|s| !s.is_empty()) {
                d.doi.insert(x.to_lowercase(), r.path.clone());
            }
            let t = title_match_key(&r.title);
            if !t.is_empty() {
                d.title.insert(t, r.path.clone());
            }
        }
        d
    }

    fn contains(&self, meta: &papers::PaperRecord) -> bool {
        self.existing_path(meta).is_some()
    }

    /// Vault-relative path of the already-present paper matching `meta`, if any.
    fn existing_path(&self, meta: &papers::PaperRecord) -> Option<String> {
        if let Some(a) = meta.arxiv_id.as_deref().filter(|s| !s.is_empty()) {
            if let Some(p) = self.arxiv.get(&a.to_lowercase()) {
                return Some(p.clone());
            }
        }
        if let Some(x) = meta.doi.as_deref().filter(|s| !s.is_empty()) {
            if let Some(p) = self.doi.get(&x.to_lowercase()) {
                return Some(p.clone());
            }
        }
        let t = title_match_key(&meta.title);
        if !t.is_empty() {
            if let Some(p) = self.title.get(&t) {
                return Some(p.clone());
            }
        }
        None
    }

    fn insert(&mut self, meta: &papers::PaperRecord, path: &str) {
        if let Some(a) = meta.arxiv_id.as_deref().filter(|s| !s.is_empty()) {
            self.arxiv.insert(a.to_lowercase(), path.to_string());
        }
        if let Some(x) = meta.doi.as_deref().filter(|s| !s.is_empty()) {
            self.doi.insert(x.to_lowercase(), path.to_string());
        }
        let t = title_match_key(&meta.title);
        if !t.is_empty() {
            self.title.insert(t, path.to_string());
        }
    }
}

/// Comparison key for Zotero → catalog *identity* matching: whitespace folded
/// to single spaces and lowercased, punctuation kept verbatim. Differs from
/// `scholar_api::scoring::title_similarity_key` (drops punctuation, Unicode
/// alphanumerics) and from `analyze::refs::latex::title_compact_key` (ASCII
/// only, all separators removed).
pub(crate) fn title_match_key(title: &str) -> String {
    title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// PDF destination filename inside the paper folder (matches the download path).
fn pdf_dest_name(id: &str) -> String {
    let base = id
        .replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_")
        .trim()
        .to_string();
    let base = if base.is_empty() {
        "paper".into()
    } else {
        base
    };
    format!("{base}.pdf")
}

// ---------------------------------------------------------------------------
// Zotero SQLite reading
// ---------------------------------------------------------------------------

struct ZoteroRead {
    items: Vec<ReadItem>,
    standalone_notes: Vec<StandaloneNote>,
    collections: Vec<ZoteroCollectionInfo>,
}

fn read_all_items(zotero_dir: &Path) -> Result<ZoteroRead, AppError> {
    let (conn, tmp_dir) = copy_zotero_sqlite(zotero_dir)?;
    let result = read_items_conn(&conn, zotero_dir);
    let _ = fs::remove_dir_all(&tmp_dir);
    result
}

/// Count Zotero item types that migration deliberately does not treat as
/// papers. Do this separately from `read_items_conn`: those rows are excluded
/// before mapping, but their count belongs in the migration audit trail.
fn count_ignored_unsupported_items(zotero_dir: &Path) -> Result<usize, AppError> {
    let (conn, tmp_dir) = copy_zotero_sqlite(zotero_dir)?;
    let result = conn
        .query_row(
            "SELECT COUNT(*)
             FROM items i
             JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
             WHERE it.typeName = 'computerProgram'
               AND i.itemID NOT IN (SELECT itemID FROM deletedItems)",
            [],
            |row| row.get::<_, i64>(0).map(|count| count as usize),
        )
        .map_err(AppError::from);
    let _ = fs::remove_dir_all(tmp_dir);
    result
}

/// Copy `zotero.sqlite` (+WAL/SHM) into a private temp dir and open it, so
/// reads never fight Zotero's own lock. Returns the connection and the temp
/// dir; the caller must remove the dir when done.
pub(crate) fn copy_zotero_sqlite(zotero_dir: &Path) -> Result<(Connection, PathBuf), AppError> {
    let db = zotero_dir.join("zotero.sqlite");
    if !db.is_file() {
        return Err(AppError::message(
            "zotero.sqlite not found in the selected folder",
        ));
    }
    let tmp_dir = std::env::temp_dir().join(format!(
        "motif-zotero-{}-{}",
        std::process::id(),
        now_nanos()
    ));
    fs::create_dir_all(&tmp_dir)?;
    let tmp_db = tmp_dir.join("zotero.sqlite");
    if let Err(e) = fs::copy(&db, &tmp_db) {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err(AppError::message(format!("copy zotero.sqlite: {e}")));
    }
    for ext in ["-wal", "-shm"] {
        let src = PathBuf::from(format!("{}{ext}", db.display()));
        if src.is_file() {
            let _ = fs::copy(&src, PathBuf::from(format!("{}{ext}", tmp_db.display())));
        }
    }
    match Connection::open(&tmp_db) {
        Ok(conn) => Ok((conn, tmp_dir)),
        Err(e) => {
            let _ = fs::remove_dir_all(&tmp_dir);
            Err(AppError::message(format!("open zotero.sqlite: {e}")))
        }
    }
}

/// One child note with the metadata bidirectional sync needs.
#[derive(Debug)]
pub(crate) struct SyncNote {
    pub html: String,
    /// Zotero `items.dateModified` of the note row itself.
    pub date_modified: Option<String>,
}

/// One regular Zotero item shaped for bidirectional sync (pull direction).
#[derive(Debug)]
pub(crate) struct SyncItem {
    pub item_id: i64,
    /// Assembled Zotero-API-JSON (feeds `map_zotero_item_to_record`, same as migration).
    pub json: Value,
    pub notes: Vec<SyncNote>,
    /// Pre-formatted Markdown blocks for PDF annotations (migration format).
    pub annotations: Vec<String>,
}

/// Read regular items with the subset bidirectional sync needs. Reuses the
/// migration field/creator/tag assembly so mapping stays identical.
pub(crate) fn read_sync_items(conn: &Connection) -> Result<Vec<SyncItem>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT i.itemID, it.typeName
         FROM items i
         JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
         WHERE it.typeName NOT IN ('attachment', 'note', 'annotation', 'computerProgram')
           AND i.itemID NOT IN (SELECT itemID FROM deletedItems)",
    )?;
    let rows = stmt.query_map(params![], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
    })?;

    let mut out = Vec::new();
    for row in rows {
        let (item_id, type_name) = row?;
        let fields = read_fields(conn, item_id)?;
        if !fields.contains_key("title") {
            continue;
        }
        let creators = read_creators(conn, item_id)?;
        let tags = read_tags(conn, item_id)?;
        out.push(SyncItem {
            item_id,
            json: assemble_json(&type_name, fields, creators, &tags),
            notes: read_sync_notes(conn, item_id)?,
            annotations: read_annotations(conn, item_id)?,
        });
    }
    Ok(out)
}

/// Child notes of an item with their own modification timestamps.
fn read_sync_notes(conn: &Connection, parent_item_id: i64) -> Result<Vec<SyncNote>, AppError> {
    let mut stmt = match conn.prepare(
        "SELECT n.note, i.dateModified
         FROM itemNotes n
         JOIN items i ON n.itemID = i.itemID
         WHERE n.parentItemID = ?1
           AND n.itemID NOT IN (SELECT itemID FROM deletedItems)
         ORDER BY n.itemID",
    ) {
        Ok(s) => s,
        Err(_) => return Ok(Vec::new()),
    };
    let rows = stmt.query_map(params![parent_item_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (html, date_modified) = row?;
        if html.trim().is_empty() {
            continue;
        }
        out.push(SyncNote {
            html,
            date_modified,
        });
    }
    Ok(out)
}

fn read_items_conn(conn: &Connection, zotero_dir: &Path) -> Result<ZoteroRead, AppError> {
    let collections = read_collections(conn)?;
    let mut stmt = conn.prepare(
        "SELECT i.itemID, it.typeName
         FROM items i
         JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
         WHERE it.typeName NOT IN ('attachment', 'note', 'annotation', 'computerProgram')
           AND i.itemID NOT IN (SELECT itemID FROM deletedItems)",
    )?;
    let rows = stmt.query_map(params![], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
    })?;

    let mut out = Vec::new();
    let mut coll_counts: HashMap<i64, usize> = HashMap::new();
    let mut unfiled = 0usize;
    for row in rows {
        let (item_id, type_name) = row?;
        let fields = read_fields(conn, item_id)?;
        // Items without a title (standalone attachments/notes already excluded)
        // cannot be mapped — skip them quietly.
        if !fields.contains_key("title") {
            continue;
        }
        let creators = read_creators(conn, item_id)?;
        let mut tags = read_tags(conn, item_id)?;
        let coll_ids = read_item_collection_ids(conn, item_id)?;
        // Tally memberships for the folder picker preview.
        if coll_ids.is_empty() {
            unfiled += 1;
        } else {
            for id in &coll_ids {
                *coll_counts.entry(*id).or_insert(0) += 1;
            }
        }
        // Keep collection membership as tags (an item can live in several).
        // Leaf names remain visible for tag filtering. Full paths are hidden
        // provenance tags used for in-place virtual collection references,
        // which restore multi-membership without duplicate folders.
        for name in collection_leaf_names(&collections, &coll_ids) {
            if !tags.iter().any(|t| t.eq_ignore_ascii_case(&name)) {
                tags.push(name);
            }
        }
        for path in collection_full_paths(&collections, &coll_ids) {
            let name = format!("@zotero:collection:{}", path.join("/"));
            if !tags.iter().any(|t| t.eq_ignore_ascii_case(&name)) {
                tags.push(name);
            }
        }
        let collection_path = chosen_collection_path(&collections, &coll_ids);
        let pdfs = read_pdf_attachments(conn, zotero_dir, item_id)?;
        let note_html = read_notes(conn, item_id)?;
        let annotations = read_annotations(conn, item_id)?;
        out.push(ReadItem {
            item_id,
            json: assemble_json(&type_name, fields, creators, &tags),
            pdfs,
            collection_path,
            collection_ids: coll_ids,
            note_html,
            annotations,
        });
    }

    let standalone_notes = read_standalone_notes(conn, &collections)?;
    for note in &standalone_notes {
        if note.collection_ids.is_empty() {
            unfiled += 1;
        } else {
            for id in &note.collection_ids {
                *coll_counts.entry(*id).or_insert(0) += 1;
            }
        }
    }

    // Every Zotero collection, including empty ones: folder materialization and
    // the scan picker both need the full tree, not only collections that have
    // at least one item in this pass.
    let mut infos: Vec<ZoteroCollectionInfo> = collections
        .keys()
        .map(|&id| ZoteroCollectionInfo {
            id,
            path: collection_full_path(&collections, id).join("/"),
            item_count: coll_counts.get(&id).copied().unwrap_or(0),
        })
        .filter(|c| !c.path.is_empty())
        .collect();
    infos.sort_by(|a, b| a.path.cmp(&b.path));
    if unfiled > 0 {
        infos.push(ZoteroCollectionInfo {
            id: 0,
            path: String::new(),
            item_count: unfiled,
        });
    }
    Ok(ZoteroRead {
        items: out,
        standalone_notes,
        collections: infos,
    })
}

/// A Zotero note with no parent item. These are documents, not paper annotations,
/// so migration writes one Markdown file under `notes/` instead of a paper.
struct StandaloneNote {
    item_id: i64,
    key: String,
    /// Note HTML, then any child-note HTML. Sync echoes are already removed.
    html_parts: Vec<String>,
    title: Option<String>,
    collection_path: Vec<String>,
    collection_ids: Vec<i64>,
}

enum StandaloneNoteWrite {
    Created(PathBuf),
    Skipped,
}

/// Stable identity stored in the file marker. Zotero keys are alphanumeric;
/// anything else falls back to the numeric item id.
fn note_identity(key: &str, item_id: i64) -> String {
    if !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric()) {
        key.to_string()
    } else {
        format!("id{item_id}")
    }
}

fn zotero_note_marker(identity: &str) -> String {
    format!("<!-- zotero-note:{identity} -->")
}

fn parse_zotero_note_marker(line: &str) -> Option<&str> {
    let line = line.trim();
    let rest = line.strip_prefix("<!-- zotero-note:")?;
    let rest = rest.strip_suffix("-->")?.trim();
    if rest.is_empty() || !rest.chars().all(|c| c.is_ascii_alphanumeric()) {
        None
    } else {
        Some(rest)
    }
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect::<String>().trim().to_string()
    }
}

fn first_markdown_line(markdown: &str) -> Option<String> {
    for line in markdown.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with("<!--") {
            continue;
        }
        let t = t.trim_start_matches('#').trim();
        if t.is_empty() {
            continue;
        }
        return Some(collapse_ws(t));
    }
    None
}

fn html_parts_to_markdown(parts: &[String]) -> String {
    parts
        .iter()
        .filter_map(|html| {
            if super::codec::looks_like_sync_note(html) {
                return None;
            }
            let md = htmd::convert(html).unwrap_or_else(|_| html.clone());
            let md = md.trim().to_string();
            if md.is_empty() {
                None
            } else {
                Some(md)
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n---\n\n")
}

fn standalone_note_label(note: &StandaloneNote, markdown: &str) -> String {
    if let Some(title) = note
        .title
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return collapse_ws(title);
    }
    first_markdown_line(markdown).unwrap_or_else(|| note_identity(&note.key, note.item_id))
}

fn standalone_note_stem(label: &str, identity: &str) -> String {
    let truncated = truncate_chars(&collapse_ws(label), 80);
    sanitize_segment(&truncated).unwrap_or_else(|| identity.to_string())
}

fn standalone_item_info(note: &StandaloneNote) -> ZoteroItemInfo {
    let markdown = html_parts_to_markdown(&note.html_parts);
    ZoteroItemInfo {
        id: note.item_id,
        title: standalone_note_label(note, &markdown),
        item_type: "note".into(),
        year: None,
        has_pdf: false,
        notes: 0,
        collections: note.collection_ids.clone(),
    }
}

fn item_included(
    item_id: i64,
    collection_ids: &[i64],
    include_items: &Option<HashSet<i64>>,
    include_colls: &Option<HashSet<i64>>,
) -> bool {
    if let Some(set) = include_items {
        set.contains(&item_id)
    } else if let Some(set) = include_colls {
        if collection_ids.is_empty() {
            set.contains(&0)
        } else {
            collection_ids.iter().any(|c| set.contains(c))
        }
    } else {
        true
    }
}

fn read_standalone_notes(
    conn: &Connection,
    collections: &HashMap<i64, Collection>,
) -> Result<Vec<StandaloneNote>, AppError> {
    let sql = "SELECT i.itemID, i.key, n.note, n.title
         FROM items i
         JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
         JOIN itemNotes n ON n.itemID = i.itemID
         WHERE it.typeName = 'note'
           AND (n.parentItemID IS NULL OR n.parentItemID = 0)
           AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
         ORDER BY i.itemID";
    let mut stmt = match conn.prepare(sql) {
        Ok(s) => s,
        Err(_) => return Ok(Vec::new()),
    };
    let rows = stmt.query_map(params![], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, Option<String>>(3)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (item_id, key, html, title) = row?;
        let mut parts = Vec::new();
        if let Some(html) = html {
            if !html.trim().is_empty() && !super::codec::looks_like_sync_note(&html) {
                parts.push(html);
            }
        }
        for child in read_notes(conn, item_id)? {
            if !super::codec::looks_like_sync_note(&child) {
                parts.push(child);
            }
        }
        if parts.is_empty() {
            continue;
        }
        let coll_ids = read_item_collection_ids(conn, item_id)?;
        let title = title.and_then(|t| {
            let t = t.trim().to_string();
            (!t.is_empty()).then_some(t)
        });
        out.push(StandaloneNote {
            item_id,
            key: key.unwrap_or_default(),
            html_parts: parts,
            title,
            collection_path: chosen_collection_path(collections, &coll_ids),
            collection_ids: coll_ids,
        });
    }
    Ok(out)
}

/// Map `<!-- zotero-note:KEY -->` markers under `notes/` to their files.
fn index_zotero_notes(notes_root: &Path) -> HashMap<String, PathBuf> {
    fn walk(dir: &Path, depth: usize, out: &mut HashMap<String, PathBuf>) {
        if depth > 32 {
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                walk(&path, depth + 1, out);
            } else if kind.is_file() {
                let is_md = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| e.eq_ignore_ascii_case("md"));
                if !is_md {
                    continue;
                }
                if let Some(key) = marker_key_in_file(&path) {
                    out.entry(key).or_insert(path);
                }
            }
        }
    }

    let mut out = HashMap::new();
    if notes_root.is_dir() {
        walk(notes_root, 0, &mut out);
    }
    out
}

fn marker_key_in_file(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let mut buf = [0u8; 4096];
    let n = file.read(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf[..n]);
    for line in text.lines().take(40) {
        if let Some(key) = parse_zotero_note_marker(line) {
            return Some(key.to_string());
        }
    }
    None
}

fn standalone_note_dir(vault: &Path, preserve: bool, coll_path: &[String]) -> PathBuf {
    let mut dir = vault.join("notes");
    if preserve {
        for seg in coll_path {
            if !seg.is_empty() {
                dir.push(seg);
            }
        }
    }
    dir
}

fn allocate_note_filename(dir: &Path, stem: &str) -> String {
    let stem = if stem.is_empty() { "note" } else { stem };
    let first = format!("{stem}.md");
    if !dir.join(&first).exists() {
        return first;
    }
    for n in 2..1000 {
        let name = format!("{stem}-{n}.md");
        if !dir.join(&name).exists() {
            return name;
        }
    }
    format!("{stem}-{}.md", now_nanos())
}

fn import_standalone_note(
    vault: &Path,
    note: &StandaloneNote,
    coll_path: &[String],
    preserve_collections: bool,
    known: &HashMap<String, PathBuf>,
) -> Result<StandaloneNoteWrite, AppError> {
    let identity = note_identity(&note.key, note.item_id);
    if known.get(&identity).is_some_and(|path| path.is_file()) {
        return Ok(StandaloneNoteWrite::Skipped);
    }
    let markdown = html_parts_to_markdown(&note.html_parts);
    if markdown.trim().is_empty() {
        return Ok(StandaloneNoteWrite::Skipped);
    }
    let label = standalone_note_label(note, &markdown);
    let stem = standalone_note_stem(&label, &identity);
    let dir = standalone_note_dir(vault, preserve_collections, coll_path);
    fs::create_dir_all(&dir)?;
    let name = allocate_note_filename(&dir, &stem);
    let path = dir.join(&name);
    let body = format!("{}\n\n{markdown}\n", zotero_note_marker(&identity));
    fs::write(&path, body)?;
    Ok(StandaloneNoteWrite::Created(path))
}

fn read_fields(conn: &Connection, item_id: i64) -> Result<Map<String, Value>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT f.fieldName, idv.value
         FROM itemData d
         JOIN fields f ON d.fieldID = f.fieldID
         JOIN itemDataValues idv ON d.valueID = idv.valueID
         WHERE d.itemID = ?1",
    )?;
    let rows = stmt.query_map(params![item_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, rusqlite::types::Value>(1)?,
        ))
    })?;
    let mut map = Map::new();
    for row in rows {
        let (name, value) = row?;
        let text = match value {
            rusqlite::types::Value::Text(t) => t,
            rusqlite::types::Value::Integer(i) => i.to_string(),
            rusqlite::types::Value::Real(f) => f.to_string(),
            _ => continue,
        };
        map.insert(name, Value::String(text));
    }
    Ok(map)
}

fn read_creators(conn: &Connection, item_id: i64) -> Result<Vec<Value>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT ct.creatorType, c.firstName, c.lastName, c.fieldMode
         FROM itemCreators ic
         JOIN creators c ON ic.creatorID = c.creatorID
         JOIN creatorTypes ct ON ic.creatorTypeID = ct.creatorTypeID
         WHERE ic.itemID = ?1
         ORDER BY ic.orderIndex",
    )?;
    let rows = stmt.query_map(params![item_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, Option<i64>>(3)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (creator_type, first, last, field_mode) = row?;
        if field_mode == Some(1) {
            // Single-field name lives in lastName.
            out.push(json!({ "creatorType": creator_type, "name": last.unwrap_or_default() }));
        } else {
            out.push(json!({
                "creatorType": creator_type,
                "firstName": first.unwrap_or_default(),
                "lastName": last.unwrap_or_default(),
            }));
        }
    }
    Ok(out)
}

fn read_tags(conn: &Connection, item_id: i64) -> Result<Vec<String>, AppError> {
    // Zotero marks automatic tags (added by web translators, e.g. source/status
    // tags) with a non-zero `type`; user tags are `type = 0`. Keep automatic
    // tags for provenance, but mark them with the same hidden prefix used by
    // the browser Connector. Older libraries without a `type` column fall back
    // to treating every tag as user-created.
    let sql = "SELECT t.name, it.type FROM itemTags it JOIN tags t ON it.tagID = t.tagID WHERE it.itemID = ?1";
    let mut stmt = match conn.prepare(sql) {
        Ok(s) => s,
        Err(_) => {
            let mut all = conn.prepare(
                "SELECT t.name FROM itemTags it JOIN tags t ON it.tagID = t.tagID WHERE it.itemID = ?1",
            )?;
            let rows = all.query_map(params![item_id], |r| r.get::<_, String>(0))?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            return Ok(out);
        }
    };
    let rows = stmt.query_map(params![item_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (name, tag_type) = row?;
        if tag_type == 0 {
            out.push(name);
        } else {
            out.push(format!("{ZOTERO_INTERNAL_TAG_PREFIX}{name}"));
        }
    }
    Ok(out)
}

/// A Zotero collection (folder) node.
struct Collection {
    name: String,
    parent: Option<i64>,
}

fn read_collections(conn: &Connection) -> Result<HashMap<i64, Collection>, AppError> {
    // Older/newer Zotero all have the collections table; be lenient if absent.
    let mut stmt = match conn
        .prepare("SELECT collectionID, collectionName, parentCollectionID FROM collections")
    {
        Ok(s) => s,
        Err(_) => return Ok(HashMap::new()),
    };
    let rows = stmt.query_map(params![], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<i64>>(2)?,
        ))
    })?;
    let mut map = HashMap::new();
    for row in rows {
        let (id, name, parent) = row?;
        map.insert(id, Collection { name, parent });
    }
    Ok(map)
}

fn read_item_collection_ids(conn: &Connection, item_id: i64) -> Result<Vec<i64>, AppError> {
    let mut stmt = match conn.prepare("SELECT collectionID FROM collectionItems WHERE itemID = ?1")
    {
        Ok(s) => s,
        Err(_) => return Ok(Vec::new()),
    };
    let rows = stmt.query_map(params![item_id], |r| r.get::<_, i64>(0))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Full folder path (root → leaf) of a collection, sanitized for the filesystem.
fn collection_full_path(collections: &HashMap<i64, Collection>, id: i64) -> Vec<String> {
    let mut chain = Vec::new();
    let mut seen = HashSet::new();
    let mut cur = Some(id);
    while let Some(cid) = cur {
        if !seen.insert(cid) || chain.len() >= 16 {
            break; // cycle / depth guard
        }
        let Some(c) = collections.get(&cid) else {
            break;
        };
        if let Some(seg) = sanitize_segment(&c.name) {
            chain.push(seg);
        }
        cur = c.parent;
    }
    chain.reverse();
    chain
}

/// Deterministic single collection folder for an item: the deepest (most
/// specific) full path wins, so an item that also belongs to a parent
/// collection keeps its child folder instead of being absorbed by the parent;
/// equal depths break ties lexicographically for stability.
fn chosen_collection_path(collections: &HashMap<i64, Collection>, ids: &[i64]) -> Vec<String> {
    ids.iter()
        .map(|id| collection_full_path(collections, *id))
        .filter(|p| !p.is_empty())
        .max_by(|a, b| {
            a.len()
                .cmp(&b.len())
                .then_with(|| b.join("/").cmp(&a.join("/")))
        })
        .unwrap_or_default()
}

/// All collection paths an item belongs to, deduplicated in stable order.
fn collection_full_paths(collections: &HashMap<i64, Collection>, ids: &[i64]) -> Vec<Vec<String>> {
    let mut out = Vec::new();
    for id in ids {
        let path = collection_full_path(collections, *id);
        if !path.is_empty() && !out.contains(&path) {
            out.push(path);
        }
    }
    out
}

/// Pick an item's placement path from precomputed collection paths. When
/// `prefer` is set and the item belongs to a collection inside that
/// collection's subtree, the deepest such membership wins — even if the item
/// also sits deeper in another branch. Importing a selected folder then
/// places papers where the user expects.
fn collection_path_prefer(
    id_to_path: &HashMap<i64, Vec<String>>,
    ids: &[i64],
    prefer: Option<i64>,
) -> Vec<String> {
    let paths: Vec<&Vec<String>> = ids
        .iter()
        .filter_map(|id| id_to_path.get(id))
        .filter(|p| !p.is_empty())
        .collect();
    if let Some(pid) = prefer {
        if let Some(pref) = id_to_path.get(&pid) {
            if !pref.is_empty() {
                let best = paths
                    .iter()
                    .filter(|p| p.len() >= pref.len() && p[..pref.len()] == pref[..])
                    .max_by(|a, b| {
                        a.len()
                            .cmp(&b.len())
                            .then_with(|| b.join("/").cmp(&a.join("/")))
                    });
                if let Some(p) = best {
                    return (*p).clone();
                }
            }
        }
    }
    paths
        .iter()
        .max_by(|a, b| {
            a.len()
                .cmp(&b.len())
                .then_with(|| b.join("/").cmp(&a.join("/")))
        })
        .copied()
        .cloned()
        .unwrap_or_default()
}

/// Leaf collection names (all memberships) for use as tags.
fn collection_leaf_names(collections: &HashMap<i64, Collection>, ids: &[i64]) -> Vec<String> {
    ids.iter()
        .filter_map(|id| collections.get(id))
        .map(|c| c.name.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Sanitize a collection name into a single safe folder segment (None to skip).
fn sanitize_segment(name: &str) -> Option<String> {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').trim().to_string();
    if cleaned.is_empty() || cleaned == ".." {
        None
    } else {
        Some(cleaned)
    }
}

/// Human-readable label for a Zotero `itemAnnotations.type` value.
/// 1=highlight, 2=note, 3=image, 5=underline; unknown types stay "annotation".
fn annotation_kind_label(kind: Option<i64>) -> Option<&'static str> {
    kind.map(|value| match value {
        1 => "高亮",
        5 => "下划线",
        2 => "笔记",
        3 => "图片",
        _ => "标注",
    })
}

/// Migrate a paper's PDF annotations (highlights / underlines + comments) as
/// Markdown blocks. Annotations hang off the PDF attachment, which hangs off
/// the paper. Type and color are kept so the same passage marked twice with a
/// different shape or color is not collapsed by the content-level dedupe.
fn read_annotations(conn: &Connection, parent_item_id: i64) -> Result<Vec<String>, AppError> {
    type Row = (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
    );
    let mut rows: Vec<Row> = Vec::new();

    // Zotero 5+ stores type/color on itemAnnotations. Older schemas (or
    // partially migrated databases) lack those columns; fall back to the
    // text-only query so existing libraries keep importing.
    match conn.prepare(
        "SELECT a.text, a.comment, a.pageLabel, a.type, a.color
         FROM itemAnnotations a
         JOIN itemAttachments att ON a.parentItemID = att.itemID
         WHERE att.parentItemID = ?1
           AND a.itemID NOT IN (SELECT itemID FROM deletedItems)
         ORDER BY att.itemID, a.sortIndex",
    ) {
        Ok(mut stmt) => {
            let mapped = stmt.query_map(params![parent_item_id], |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                ))
            })?;
            for row in mapped {
                rows.push(row?);
            }
        }
        Err(_) => {
            let mut stmt = match conn.prepare(
                "SELECT a.text, a.comment, a.pageLabel
                 FROM itemAnnotations a
                 JOIN itemAttachments att ON a.parentItemID = att.itemID
                 WHERE att.parentItemID = ?1
                   AND a.itemID NOT IN (SELECT itemID FROM deletedItems)
                 ORDER BY att.itemID, a.sortIndex",
            ) {
                Ok(s) => s,
                Err(_) => return Ok(Vec::new()), // older Zotero without annotations
            };
            let mapped = stmt.query_map(params![parent_item_id], |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    None::<i64>,
                    None::<String>,
                ))
            })?;
            for row in mapped {
                rows.push(row?);
            }
        }
    }

    let mut out = Vec::new();
    for (text, comment, page, kind, color) in rows {
        let text = text.unwrap_or_default();
        let comment = comment.unwrap_or_default();
        let text = text.trim();
        let comment = comment.trim();
        if text.is_empty() && comment.is_empty() {
            continue;
        }
        let page = page.as_deref().map(str::trim).filter(|s| !s.is_empty());
        let color = color.as_deref().map(str::trim).filter(|s| !s.is_empty());
        let meta = match (annotation_kind_label(kind), color) {
            (Some(label), Some(color)) => Some(format!("{label} · {color}")),
            (Some(label), None) => Some(label.to_string()),
            (None, Some(color)) => Some(color.to_string()),
            (None, None) => None,
        };
        // Collapse the marked passage into one quoted line with an inline
        // type/color tag, page ref and the comment underneath — compact, not
        // divider-heavy. Text-only rows keep the legacy format.
        let mut block = String::new();
        if !text.is_empty() {
            let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
            block.push_str("> ");
            if let Some(meta) = &meta {
                block.push_str(&format!("[{meta}] "));
            }
            block.push_str(&collapsed);
            if let Some(p) = page {
                block.push_str(&format!(" (p. {p})"));
            }
        } else if let Some(p) = page {
            if let Some(meta) = &meta {
                block.push_str(&format!("> [{meta}] (p. {p})"));
            } else {
                block.push_str(&format!("(p. {p})"));
            }
        } else if let Some(meta) = &meta {
            block.push_str(&format!("> [{meta}]"));
        }
        if !comment.is_empty() {
            if !block.is_empty() {
                block.push('\n');
            }
            block.push_str(comment);
        }
        out.push(block.trim().to_string());
    }
    Ok(out)
}

fn read_notes(conn: &Connection, parent_item_id: i64) -> Result<Vec<String>, AppError> {
    // Child notes attached to this item; skip trashed notes. Tolerate old schemas.
    let mut stmt = match conn.prepare(
        "SELECT note FROM itemNotes
         WHERE parentItemID = ?1
           AND itemID NOT IN (SELECT itemID FROM deletedItems)
         ORDER BY itemID",
    ) {
        Ok(s) => s,
        Err(_) => return Ok(Vec::new()),
    };
    let rows = stmt.query_map(params![parent_item_id], |r| r.get::<_, String>(0))?;
    let mut out = Vec::new();
    for row in rows {
        let html = row?;
        if !html.trim().is_empty() {
            out.push(html);
        }
    }
    Ok(out)
}

fn read_pdf_attachments(
    conn: &Connection,
    zotero_dir: &Path,
    parent_item_id: i64,
) -> Result<Vec<PathBuf>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT ia.linkMode, ia.path, ai.key
         FROM itemAttachments ia
         JOIN items ai ON ia.itemID = ai.itemID
         WHERE ia.parentItemID = ?1
           AND ia.contentType = 'application/pdf'
           AND ia.itemID NOT IN (SELECT itemID FROM deletedItems)",
    )?;
    let rows = stmt.query_map(params![parent_item_id], |r| {
        Ok((
            r.get::<_, Option<i64>>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (link_mode, path, att_key) = row?;
        let Some(path) = path else { continue };
        if let Some(p) = resolve_attachment(zotero_dir, &att_key, link_mode.unwrap_or(0), &path) {
            out.push(p);
        }
    }
    Ok(out)
}

/// Resolve a Zotero attachment `path` to a real PDF file on disk.
/// - `storage:foo.pdf` → `<zotero_dir>/storage/<attachmentKey>/foo.pdf`
/// - absolute linked file → used as-is when it exists
/// - `attachments:` (linked base dir) is unknown here → skipped
fn resolve_attachment(
    zotero_dir: &Path,
    att_key: &str,
    _link_mode: i64,
    path: &str,
) -> Option<PathBuf> {
    let path = path.trim();
    if let Some(name) = path.strip_prefix("storage:") {
        let p = zotero_dir.join("storage").join(att_key).join(name);
        return p.is_file().then_some(p);
    }
    if path.starts_with("attachments:") {
        return None;
    }
    let p = PathBuf::from(path);
    (p.is_absolute() && p.is_file()).then_some(p)
}

fn assemble_json(
    type_name: &str,
    fields: Map<String, Value>,
    creators: Vec<Value>,
    tags: &[String],
) -> Value {
    let mut obj = fields;
    obj.insert("itemType".into(), Value::String(type_name.to_string()));
    obj.insert("creators".into(), Value::Array(creators));
    obj.insert(
        "tags".into(),
        Value::Array(tags.iter().map(|t| json!({ "tag": t })).collect()),
    );
    Value::Object(obj)
}

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal Zotero schema + rows for read tests.
    const SEED_SQL: &str = "CREATE TABLE itemTypes (itemTypeID INTEGER PRIMARY KEY, typeName TEXT);
             CREATE TABLE items (itemID INTEGER PRIMARY KEY, itemTypeID INTEGER, key TEXT);
             CREATE TABLE fields (fieldID INTEGER PRIMARY KEY, fieldName TEXT);
             CREATE TABLE itemData (itemID INTEGER, fieldID INTEGER, valueID INTEGER);
             CREATE TABLE itemDataValues (valueID INTEGER PRIMARY KEY, value);
             CREATE TABLE creators (creatorID INTEGER PRIMARY KEY, firstName TEXT, lastName TEXT, fieldMode INTEGER);
             CREATE TABLE creatorTypes (creatorTypeID INTEGER PRIMARY KEY, creatorType TEXT);
             CREATE TABLE itemCreators (itemID INTEGER, creatorID INTEGER, creatorTypeID INTEGER, orderIndex INTEGER);
             CREATE TABLE tags (tagID INTEGER PRIMARY KEY, name TEXT);
             CREATE TABLE itemTags (itemID INTEGER, tagID INTEGER, type INTEGER);
             CREATE TABLE itemAttachments (itemID INTEGER, parentItemID INTEGER, linkMode INTEGER, contentType TEXT, path TEXT);
             CREATE TABLE deletedItems (itemID INTEGER);
             CREATE TABLE collections (collectionID INTEGER PRIMARY KEY, collectionName TEXT, parentCollectionID INTEGER);
             CREATE TABLE collectionItems (collectionID INTEGER, itemID INTEGER, orderIndex INTEGER);
             CREATE TABLE itemNotes (itemID INTEGER, parentItemID INTEGER, note TEXT, title TEXT);
             CREATE TABLE itemAnnotations (itemID INTEGER, parentItemID INTEGER, type INTEGER, text TEXT, comment TEXT, color TEXT, pageLabel TEXT, sortIndex TEXT);

             INSERT INTO itemTypes VALUES (1,'journalArticle'),(2,'attachment'),(3,'note');
             INSERT INTO creatorTypes VALUES (1,'author');
             INSERT INTO fields VALUES (1,'title'),(2,'date'),(3,'DOI');

             -- regular item 10
             INSERT INTO items VALUES (10,1,'AAAA1111');
             INSERT INTO itemDataValues VALUES (100,'Attention Is All You Need'),(101,'2017-06-12'),(102,'10.5555/abc');
             INSERT INTO itemData VALUES (10,1,100),(10,2,101),(10,3,102);
             INSERT INTO creators VALUES (1,'Ashish','Vaswani',0);
             INSERT INTO itemCreators VALUES (10,1,1,0);
             INSERT INTO tags VALUES (1,'nlp'),(2,'_to_read');
             INSERT INTO itemTags VALUES (10,1,0),(10,2,1);
             INSERT INTO collections VALUES (1,'NLP',NULL),(2,'Transformers',1);
             INSERT INTO collectionItems VALUES (2,10,0);
             INSERT INTO itemNotes VALUES (12,10,'<p>Great <strong>paper</strong>.</p>','Great');
             INSERT INTO itemAnnotations VALUES (13,11,1,'Key finding here','my comment','#ffd400','3','00001');
             -- pdf attachment (child item 11) in storage/BBBB2222
             INSERT INTO items VALUES (11,2,'BBBB2222');
             INSERT INTO itemAttachments VALUES (11,10,0,'application/pdf','storage:paper.pdf');

             -- standalone note shell without a body (not a paper; nothing to write)
             INSERT INTO items VALUES (20,3,'CCCC3333');
             -- trashed regular item (excluded)
             INSERT INTO items VALUES (30,1,'DDDD4444');
             INSERT INTO itemDataValues VALUES (300,'Trashed Paper');
             INSERT INTO itemData VALUES (30,1,300);
             INSERT INTO deletedItems VALUES (30);";

    fn seed_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SEED_SQL).unwrap();
        conn
    }

    #[test]
    fn reads_only_regular_non_trashed_items() {
        let conn = seed_db();
        let ZoteroRead { items, .. } =
            read_items_conn(&conn, Path::new("/nonexistent-zotero")).unwrap();
        assert_eq!(items.len(), 1, "note + trashed items must be excluded");
        let it = &items[0];
        assert_eq!(it.note_html.len(), 1, "child note attached to the paper");
        assert_eq!(it.json["title"], "Attention Is All You Need");
        assert_eq!(it.json["itemType"], "journalArticle");
        assert_eq!(item_info(it).item_type, "journalArticle");
        assert_eq!(it.json["DOI"], "10.5555/abc");
        assert_eq!(it.json["creators"][0]["lastName"], "Vaswani");
        assert_eq!(it.json["tags"][0]["tag"], "nlp");
        // storage dir does not exist → attachment resolves to nothing
        assert!(it.pdfs.is_empty());
    }

    #[test]
    fn assembled_item_maps_to_expected_citekey() {
        let conn = seed_db();
        let ZoteroRead { items, .. } =
            read_items_conn(&conn, Path::new("/nonexistent-zotero")).unwrap();
        let meta = map_zotero_item_to_record(&items[0].json).unwrap();
        assert_eq!(meta.title, "Attention Is All You Need");
        assert_eq!(meta.year, Some(2017));
        assert_eq!(meta.doi.as_deref(), Some("10.5555/abc"));
        // DOI present → id is the doi slug
        assert_eq!(meta.id, "10_5555_abc");
    }

    #[test]
    fn recreates_collection_path_and_tags() {
        let conn = seed_db();
        let ZoteroRead {
            items, collections, ..
        } = read_items_conn(&conn, Path::new("/nonexistent-zotero")).unwrap();
        let it = &items[0];
        assert_eq!(it.collection_path, vec!["NLP", "Transformers"]);
        assert_eq!(it.collection_ids, vec![2]);
        assert!(collections
            .iter()
            .any(|c| c.path == "NLP/Transformers" && c.item_count == 1));
        let tags = it.json["tags"].as_array().unwrap();
        assert!(tags.iter().any(|t| t["tag"] == "Transformers"));
        assert!(tags.iter().any(|t| t["tag"] == "nlp"));
        assert!(tags
            .iter()
            .any(|t| t["tag"] == "@zotero:collection:NLP/Transformers"));
        // Automatic Zotero tags (type != 0) are retained with the hidden prefix.
        assert!(tags.iter().any(|t| t["tag"] == "@zotero:_to_read"));
    }

    #[test]
    fn deepest_collection_wins_for_multi_membership() {
        let conn = seed_db();
        // Item 50 belongs to both the parent (NLP) and the child (Transformers):
        // the child folder must keep the item instead of the parent absorbing it.
        conn.execute_batch(
            "INSERT INTO items VALUES (50,1,'EEEE5555');
             INSERT INTO itemDataValues VALUES (500,'Multi Collection Paper');
             INSERT INTO itemData VALUES (50,1,500);
             INSERT INTO collectionItems VALUES (1,50,0),(2,50,1);",
        )
        .unwrap();
        let ZoteroRead { items, .. } =
            read_items_conn(&conn, Path::new("/nonexistent-zotero")).unwrap();
        let it = items.iter().find(|i| i.item_id == 50).unwrap();
        assert_eq!(it.collection_path, vec!["NLP", "Transformers"]);
        // Every membership still surfaces as a tag.
        let tags = it.json["tags"].as_array().unwrap();
        assert!(tags.iter().any(|t| t["tag"] == "NLP"));
        assert!(tags.iter().any(|t| t["tag"] == "Transformers"));
        assert!(tags.iter().any(|t| t["tag"] == "@zotero:collection:NLP"));
        assert!(tags
            .iter()
            .any(|t| t["tag"] == "@zotero:collection:NLP/Transformers"));
    }

    #[test]
    fn multi_collection_placement_is_stable_for_unrelated_branches() {
        let conn = seed_db();
        conn.execute_batch(
            "INSERT INTO collections VALUES (3,'Review',NULL),(4,'Topic',NULL);
             INSERT INTO items VALUES (51,1,'FFFF5555');
             INSERT INTO itemDataValues VALUES (510,'Two Branches');
             INSERT INTO itemData VALUES (51,1,510);
             INSERT INTO collectionItems VALUES (3,51,0),(4,51,0);",
        )
        .unwrap();
        let ZoteroRead { items, .. } =
            read_items_conn(&conn, Path::new("/nonexistent-zotero")).unwrap();
        let it = items.iter().find(|i| i.item_id == 51).unwrap();
        // Both paths are equally deep, so their lexical order is the documented tie-breaker.
        assert_eq!(it.collection_path, vec!["Review"]);
    }

    #[test]
    fn excludes_addon_computer_program_items() {
        let conn = seed_db();
        // Zotero add-ons may create `computerProgram` items (e.g. literally
        // titled "Addon Item") — junk that must never become a paper.
        conn.execute_batch(
            "INSERT INTO itemTypes VALUES (9,'computerProgram');
             INSERT INTO items VALUES (40,9,'FFFF6666');
             INSERT INTO itemDataValues VALUES (400,'Addon Item');
             INSERT INTO itemData VALUES (40,1,400);",
        )
        .unwrap();
        let ZoteroRead { items, .. } =
            read_items_conn(&conn, Path::new("/nonexistent-zotero")).unwrap();
        assert_eq!(
            items.len(),
            1,
            "computerProgram addon item must be excluded"
        );
        assert_eq!(items[0].item_id, 10);
    }

    #[test]
    fn counts_unsupported_computer_program_items() {
        let conn = seed_db();
        conn.execute_batch(
            "INSERT INTO itemTypes VALUES (9,'computerProgram');
             INSERT INTO items VALUES (40,9,'FFFF6666');
             INSERT INTO items VALUES (41,9,'GGGG7777');
             INSERT INTO deletedItems VALUES (41);",
        )
        .unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM items i JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
                 WHERE it.typeName = 'computerProgram'
                   AND i.itemID NOT IN (SELECT itemID FROM deletedItems)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn migrate_materializes_full_collection_tree() {
        let base = std::env::temp_dir().join(format!("motif-zmig-{}", now_nanos()));
        let vault = base.join("vault");
        let zdir = base.join("zotero");
        fs::create_dir_all(&vault).unwrap();
        fs::create_dir_all(&zdir).unwrap();
        {
            let conn = Connection::open(zdir.join("zotero.sqlite")).unwrap();
            conn.execute_batch(SEED_SQL).unwrap();
            // Empty sibling collection (no items) — must still appear as a folder.
            conn.execute_batch("INSERT INTO collections VALUES (3,'Empty Sibling',NULL);")
                .unwrap();
        }

        let out = migrate_zotero(
            ZoteroMigrateArgs {
                vault_path: vault.to_string_lossy().to_string(),
                zotero_dir: zdir.to_string_lossy().to_string(),
                parent_dir: Some("papers".into()),
                copy_pdfs: false,
                preserve_collections: true,
                include_collections: None,
                include_items: None,
                prefer_collection: None,
                migrate_notes: false,
                migrate_annotations: false,
            },
            |_c, _t, _p| {},
            None,
            NoteShellMode::Standard,
        )
        .await
        .unwrap();
        assert_eq!(out.imported, 1);
        // Paper lands in the full collection path (deepest folder).
        assert!(vault.join("papers/NLP/Transformers").is_dir());
        assert_eq!(out.paths[0], "papers/NLP/Transformers/10_5555_abc");
        // Empty collection still materializes so the tree matches Zotero.
        assert!(vault.join("papers/Empty Sibling").is_dir());
        let record = papers::get_by_path(&vault, &out.paths[0]).unwrap().unwrap();
        assert!(record
            .tags
            .iter()
            .any(|tag| tag.name == "@zotero:collection-root:papers"));

        let _ = fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn migrate_folder_selection_materializes_only_its_subtree() {
        let base = std::env::temp_dir().join(format!("motif-zmig-sub-{}", now_nanos()));
        let vault = base.join("vault");
        let zdir = base.join("zotero");
        fs::create_dir_all(&vault).unwrap();
        fs::create_dir_all(&zdir).unwrap();
        {
            let conn = Connection::open(zdir.join("zotero.sqlite")).unwrap();
            conn.execute_batch(SEED_SQL).unwrap();
            // Out-of-scope collections: an empty root sibling and a sibling
            // subtree with an empty nested folder.
            conn.execute_batch(
                "INSERT INTO collections VALUES (3,'Empty Sibling',NULL);
                 INSERT INTO collections VALUES (4,'Other',NULL),(5,'Other Sub',4);",
            )
            .unwrap();
        }

        // Importing the "NLP" folder (id 1): papers of its subtree land, the
        // folder's own subtree is materialized, nothing outside it is created.
        let out = migrate_zotero(
            ZoteroMigrateArgs {
                vault_path: vault.to_string_lossy().to_string(),
                zotero_dir: zdir.to_string_lossy().to_string(),
                parent_dir: Some("papers".into()),
                copy_pdfs: false,
                preserve_collections: true,
                include_collections: None,
                include_items: Some(vec![10]),
                prefer_collection: Some(1),
                migrate_notes: false,
                migrate_annotations: false,
            },
            |_c, _t, _p| {},
            None,
            NoteShellMode::Standard,
        )
        .await
        .unwrap();
        assert_eq!(out.imported, 1);
        assert_eq!(out.paths[0], "papers/NLP/Transformers/10_5555_abc");
        // Selected folder and its (empty) descendants are materialized.
        assert!(vault.join("papers/NLP").is_dir());
        assert!(vault.join("papers/NLP/Transformers").is_dir());
        // Nothing outside the selected folder appears as an empty folder.
        assert!(!vault.join("papers/Empty Sibling").exists());
        assert!(!vault.join("papers/Other").exists());
        assert!(!vault.join("papers/Other/Other Sub").exists());

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn relocation_planning() {
        // Legacy flat paper → collection folder.
        assert_eq!(
            plan_relocation("papers/10_5555_abc", "papers/NLP/Transformers").as_deref(),
            Some("papers/NLP/Transformers/10_5555_abc")
        );
        // Old leaf-flat folder → full hierarchy.
        assert_eq!(
            plan_relocation("papers/Agent/2303.11366", "papers/LLM/Agent").as_deref(),
            Some("papers/LLM/Agent/2303.11366")
        );
        // Already in place → nothing to do.
        assert_eq!(
            plan_relocation(
                "papers/NLP/Transformers/10_5555_abc",
                "papers/NLP/Transformers"
            ),
            None
        );
    }

    #[tokio::test]
    async fn remigration_relocates_legacy_flat_papers() {
        let base = std::env::temp_dir().join(format!("motif-zreloc-{}", now_nanos()));
        let vault = base.join("vault");
        let zdir = base.join("zotero");
        fs::create_dir_all(&zdir).unwrap();
        {
            let conn = Connection::open(zdir.join("zotero.sqlite")).unwrap();
            conn.execute_batch(SEED_SQL).unwrap();
        }

        // Pre-existing flat paper (legacy import) matching the seeded item by DOI.
        let flat_rel = "papers/10_5555_abc";
        fs::create_dir_all(vault.join(flat_rel)).unwrap();
        fs::write(vault.join(flat_rel).join("NOTES.md"), "# user notes\n").unwrap();
        let conn = seed_db();
        let ZoteroRead { items, .. } =
            read_items_conn(&conn, Path::new("/nonexistent-zotero")).unwrap();
        let record = map_zotero_item_to_record(&items[0].json)
            .unwrap()
            .at_path(flat_rel);
        papers::upsert_paper(&vault, &record).unwrap();

        let out = migrate_zotero(
            ZoteroMigrateArgs {
                vault_path: vault.to_string_lossy().to_string(),
                zotero_dir: zdir.to_string_lossy().to_string(),
                parent_dir: Some("papers".into()),
                copy_pdfs: false,
                preserve_collections: true,
                include_collections: None,
                include_items: None,
                prefer_collection: None,
                migrate_notes: false,
                migrate_annotations: false,
            },
            |_c, _t, _p| {},
            None,
            NoteShellMode::Standard,
        )
        .await
        .unwrap();

        assert_eq!(out.imported, 0);
        assert_eq!(out.relocated, 1);
        let new_rel = "papers/NLP/Transformers/10_5555_abc";
        assert_eq!(out.paths[0], new_rel);
        // Folder + user content moved; old location gone.
        assert!(vault.join(new_rel).join("NOTES.md").is_file());
        assert!(!vault.join(flat_rel).exists());
        // Catalog row rewritten to the new path.
        assert!(papers::get_by_path(&vault, new_rel).unwrap().is_some());
        assert!(papers::get_by_path(&vault, flat_rel).unwrap().is_none());

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn converts_note_html_to_markdown() {
        let md = htmd::convert("<p>Great <strong>paper</strong>.</p>").unwrap();
        assert!(md.contains("**paper**"), "got: {md}");
    }

    #[test]
    fn reads_pdf_annotations() {
        let conn = seed_db();
        let ZoteroRead { items, .. } =
            read_items_conn(&conn, Path::new("/nonexistent-zotero")).unwrap();
        let a = &items[0].annotations;
        assert_eq!(a.len(), 1);
        assert!(
            a[0].contains("> [高亮 · #ffd400] Key finding here"),
            "got: {}",
            a[0]
        );
        assert!(a[0].contains("my comment"), "got: {}", a[0]);
        assert!(a[0].contains("p. 3"), "got: {}", a[0]);
    }

    #[test]
    fn distinguishes_annotation_shape_and_color() {
        let conn = seed_db();
        conn.execute_batch(
            "INSERT INTO itemAnnotations VALUES (14,11,5,'Underlined passage','','#2ea8e5','7','00002');
             INSERT INTO itemAnnotations VALUES (15,11,1,'Underlined passage','','#2ea8e5','7','00003');
             INSERT INTO itemAnnotations VALUES (16,11,5,'Mystery annotation','','','8','00004');
             INSERT INTO itemAnnotations VALUES (17,11,99,'Unknown type','','#000000','9','00005');",
        )
        .unwrap();
        let ZoteroRead { items, .. } =
            read_items_conn(&conn, Path::new("/nonexistent-zotero")).unwrap();
        let a = &items[0].annotations;
        assert_eq!(a.len(), 5);
        assert!(a[1].contains("> [下划线 · #2ea8e5] Underlined passage (p. 7)"));
        assert!(a[2].contains("> [高亮 · #2ea8e5] Underlined passage (p. 7)"));
        // Same text with a different shape stays a separate block (no dedupe
        // by quote alone). The append layer compares the whole line.
        assert_ne!(a[1], a[2]);
        assert!(a[3].contains("> [下划线] Mystery annotation (p. 8)"));
        assert!(a[4].contains("> [标注 · #000000] Unknown type (p. 9)"));
    }

    #[test]
    fn reads_annotations_from_an_old_schema_without_type_and_color() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE itemAttachments (itemID INTEGER, parentItemID INTEGER);
             CREATE TABLE deletedItems (itemID INTEGER);
             CREATE TABLE itemAnnotations (itemID INTEGER, parentItemID INTEGER, text TEXT, comment TEXT, pageLabel TEXT, sortIndex TEXT);
             INSERT INTO itemAttachments VALUES (11,10);
             INSERT INTO itemAnnotations VALUES (13,11,'Old highlight','old comment','2','00001');",
        )
        .unwrap();

        let out = read_annotations(&conn, 10).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0], "> Old highlight (p. 2)\nold comment");
    }

    #[test]
    fn resolves_storage_attachment_when_file_exists() {
        let dir = std::env::temp_dir().join(format!("motif-ztest-{}", now_nanos()));
        let store = dir.join("storage").join("BBBB2222");
        fs::create_dir_all(&store).unwrap();
        fs::write(store.join("paper.pdf"), b"%PDF-1.4").unwrap();

        let hit = resolve_attachment(&dir, "BBBB2222", 0, "storage:paper.pdf");
        assert!(hit.is_some());
        assert!(hit.unwrap().is_file());

        assert!(resolve_attachment(&dir, "BBBB2222", 0, "storage:missing.pdf").is_none());
        assert!(resolve_attachment(&dir, "BBBB2222", 2, "attachments:x.pdf").is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_counts_items_and_pdfs() {
        // Point at a folder that has zotero.sqlite so read_all_items runs end-to-end.
        let dir = std::env::temp_dir().join(format!("motif-zscan-{}", now_nanos()));
        fs::create_dir_all(&dir).unwrap();
        // Seed a file-based db the scanner can copy + open (no backup feature).
        {
            let conn = Connection::open(dir.join("zotero.sqlite")).unwrap();
            conn.execute_batch(SEED_SQL).unwrap();
        }

        let scan = scan_zotero(ZoteroScanArgs {
            zotero_dir: dir.to_string_lossy().to_string(),
        })
        .unwrap();
        assert_eq!(scan.item_count, 1);
        assert_eq!(scan.with_pdf_count, 0); // no storage/ file present
        assert_eq!(scan.note_count, 1);
        assert_eq!(scan.items.len(), 1);
        assert_eq!(scan.items[0].id, 10);
        assert!(scan.valid);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn pdf_dest_name_sanitizes() {
        assert_eq!(pdf_dest_name("1706.03762"), "1706.03762.pdf");
        assert_eq!(pdf_dest_name("10.1000/xyz"), "10.1000_xyz.pdf");
    }

    const STANDALONE_NOTE_SQL: &str = "INSERT INTO itemNotes VALUES (20, NULL, '<p>A root <strong>idea</strong>.</p>', 'Root idea');
             INSERT INTO items VALUES (21,3,'DDDDNOTE');
             INSERT INTO itemNotes VALUES (21, NULL, '<p>Margin thoughts</p>', NULL);
             INSERT INTO collectionItems VALUES (2, 21, 0);
             INSERT INTO items VALUES (24,3,'GGGG2222');
             INSERT INTO itemNotes VALUES (24, 20, '<p>child of root</p>', NULL);
             INSERT INTO items VALUES (23,3,'FFFF1111');
             INSERT INTO itemNotes VALUES (23, NULL, '<p>gone</p>', 'Gone');
             INSERT INTO deletedItems VALUES (23);
             INSERT INTO items VALUES (22,3,'EEEE0000');
             INSERT INTO itemNotes VALUES (22, NULL, '   ', 'Empty');";

    fn zotero_migrate_args(
        vault: &Path,
        zdir: &Path,
        preserve_collections: bool,
        migrate_notes: bool,
    ) -> ZoteroMigrateArgs {
        ZoteroMigrateArgs {
            vault_path: vault.to_string_lossy().to_string(),
            zotero_dir: zdir.to_string_lossy().to_string(),
            parent_dir: Some("papers".into()),
            copy_pdfs: false,
            preserve_collections,
            include_collections: None,
            include_items: None,
            prefer_collection: None,
            migrate_notes,
            migrate_annotations: false,
        }
    }

    /// File-backed library: the seeded paper, plus root / collection / empty / trashed notes.
    fn standalone_library() -> (PathBuf, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("motif-znote-{}", now_nanos()));
        let vault = base.join("vault");
        let zdir = base.join("zotero");
        fs::create_dir_all(&vault).unwrap();
        fs::create_dir_all(&zdir).unwrap();
        let conn = Connection::open(zdir.join("zotero.sqlite")).unwrap();
        conn.execute_batch(SEED_SQL).unwrap();
        conn.execute_batch(STANDALONE_NOTE_SQL).unwrap();
        (base, vault, zdir)
    }

    #[test]
    fn standalone_note_names_and_markers() {
        assert_eq!(
            parse_zotero_note_marker("<!-- zotero-note:CCCC3333 -->"),
            Some("CCCC3333")
        );
        assert_eq!(
            parse_zotero_note_marker("<!-- zotero-note:nope --> extra"),
            None
        );
        assert_eq!(standalone_note_stem("Root idea", "CCCC3333"), "Root idea");
        assert_eq!(standalone_note_stem("a/b:c", "CCCC3333"), "a_b_c");
        assert_eq!(standalone_note_stem("...", "DDDDNOTE"), "DDDDNOTE");
        assert_eq!(
            first_markdown_line("# Margin thoughts\n\nbody").as_deref(),
            Some("Margin thoughts")
        );
    }

    #[test]
    fn reads_standalone_notes_apart_from_papers() {
        let conn = seed_db();
        conn.execute_batch(STANDALONE_NOTE_SQL).unwrap();
        let ZoteroRead {
            items,
            standalone_notes: notes,
            collections,
        } = read_items_conn(&conn, Path::new("/nonexistent-zotero")).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].item_id, 10);
        assert_eq!(
            notes.len(),
            2,
            "root + collection note; empty, trashed, and nested notes stay out of the list"
        );
        let root = notes.iter().find(|n| n.item_id == 20).unwrap();
        assert!(root.collection_ids.is_empty());
        assert_eq!(root.title.as_deref(), Some("Root idea"));
        assert_eq!(root.html_parts.len(), 2, "child note rides along");
        let margin = notes.iter().find(|n| n.item_id == 21).unwrap();
        assert_eq!(
            margin.collection_path,
            vec!["NLP".to_string(), "Transformers".to_string()]
        );
        assert!(collections.iter().any(|c| c.id == 0 && c.item_count == 1));
        let transformers = collections
            .iter()
            .find(|c| c.path == "NLP/Transformers")
            .unwrap();
        assert_eq!(transformers.item_count, 2);
    }

    #[tokio::test]
    async fn imports_standalone_notes_under_notes_tree() {
        let (base, vault, zdir) = standalone_library();
        let out = migrate_zotero(
            zotero_migrate_args(&vault, &zdir, true, true),
            |_c, _t, _p| {},
            None,
            NoteShellMode::Standard,
        )
        .await
        .unwrap();
        assert_eq!(out.imported, 1);
        assert_eq!(out.standalone_notes, 2);

        let root = fs::read_to_string(vault.join("notes/Root idea.md")).unwrap();
        assert!(root.starts_with("<!-- zotero-note:CCCC3333 -->"));
        assert!(root.contains("**idea**"), "got: {root}");
        assert!(root.contains("child of root"), "got: {root}");

        let margin_path = vault.join("notes/NLP/Transformers/Margin thoughts.md");
        let margin = fs::read_to_string(&margin_path).unwrap();
        assert!(margin.contains("<!-- zotero-note:DDDDNOTE -->"));
        assert!(margin.contains("Margin thoughts"));
        assert!(!vault.join("notes/Gone.md").exists());
        assert!(!vault.join("notes/Empty.md").exists());

        let paper_notes =
            fs::read_to_string(vault.join("papers/NLP/Transformers/10_5555_abc/NOTES.md")).unwrap();
        assert!(paper_notes.contains("**paper**"), "got: {paper_notes}");

        let again = migrate_zotero(
            zotero_migrate_args(&vault, &zdir, true, true),
            |_c, _t, _p| {},
            None,
            NoteShellMode::Standard,
        )
        .await
        .unwrap();
        assert_eq!(again.standalone_notes, 0);
        assert_eq!(
            fs::read_to_string(vault.join("notes/Root idea.md")).unwrap(),
            root
        );
        assert!(!vault.join("notes/Root idea-2.md").exists());

        let _ = fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn standalone_note_does_not_overwrite_user_file() {
        let (base, vault, zdir) = standalone_library();
        fs::create_dir_all(vault.join("notes")).unwrap();
        fs::write(vault.join("notes/Root idea.md"), "keep me\n").unwrap();

        let out = migrate_zotero(
            zotero_migrate_args(&vault, &zdir, true, true),
            |_c, _t, _p| {},
            None,
            NoteShellMode::Standard,
        )
        .await
        .unwrap();
        assert_eq!(out.standalone_notes, 2);
        assert_eq!(
            fs::read_to_string(vault.join("notes/Root idea.md")).unwrap(),
            "keep me\n"
        );
        let written = fs::read_to_string(vault.join("notes/Root idea-2.md")).unwrap();
        assert!(written.contains("<!-- zotero-note:CCCC3333 -->"));
        assert!(written.contains("child of root"));

        let again = migrate_zotero(
            zotero_migrate_args(&vault, &zdir, true, true),
            |_c, _t, _p| {},
            None,
            NoteShellMode::Standard,
        )
        .await
        .unwrap();
        assert_eq!(again.standalone_notes, 0);
        assert!(!vault.join("notes/Root idea-3.md").exists());
        assert_eq!(
            fs::read_to_string(vault.join("notes/Root idea-2.md")).unwrap(),
            written
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn standalone_notes_flatten_when_collections_are_off() {
        let (base, vault, zdir) = standalone_library();
        let out = migrate_zotero(
            zotero_migrate_args(&vault, &zdir, false, true),
            |_c, _t, _p| {},
            None,
            NoteShellMode::Standard,
        )
        .await
        .unwrap();
        assert_eq!(out.standalone_notes, 2);
        assert!(vault.join("notes/Root idea.md").is_file());
        assert!(vault.join("notes/Margin thoughts.md").is_file());
        assert!(!vault.join("notes/NLP").exists());

        let _ = fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn skipping_note_migration_leaves_standalone_notes_out() {
        let (base, vault, zdir) = standalone_library();
        let out = migrate_zotero(
            zotero_migrate_args(&vault, &zdir, true, false),
            |_c, _t, _p| {},
            None,
            NoteShellMode::Standard,
        )
        .await
        .unwrap();
        assert_eq!(out.imported, 1);
        assert_eq!(out.standalone_notes, 0);
        assert!(!vault.join("notes/Root idea.md").exists());
        let paper_notes =
            fs::read_to_string(vault.join("papers/NLP/Transformers/10_5555_abc/NOTES.md")).unwrap();
        assert!(!paper_notes.contains("Great"), "got: {paper_notes}");

        let _ = fs::remove_dir_all(&base);
    }
}
