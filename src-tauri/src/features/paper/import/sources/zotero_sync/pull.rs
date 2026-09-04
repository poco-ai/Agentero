//! Incremental Zotero → Vault pull (read-only; safe while Zotero is running).
//!
//! Scope: metadata fill (empty fields only, never overwrite), user-written
//! child notes → NOTES.md (idempotent append), PDF annotations → NOTES.md.
//! New Zotero items are NOT imported here (that is migration's job); Zotero
//! deletions never remove vault papers.

use super::link::{self, MatchedBy};
use super::{file_newer_than, parse_dt};
use crate::core::error::AppError;
use crate::features::catalog::papers;
use crate::features::import::{map_zotero_item, PaperMeta};
use crate::features::zotero::codec;
use crate::features::zotero::db::{append_markdown_blocks, SyncItem};
use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Copy)]
pub struct PullOptions {
    pub metadata: bool,
    pub notes: bool,
    pub annotations: bool,
}

/// One paper where both sides changed since the last sync; notes pull is
/// skipped for it and the user decides.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConflict {
    pub paper_path: String,
    pub title: String,
    pub reason: String,
}

#[derive(Debug, Default)]
pub struct PullReport {
    pub linked: usize,
    pub unlinked: usize,
    pub metadata_filled: usize,
    pub notes_added: usize,
    pub annotations_added: usize,
    pub linkage_backfilled: usize,
    pub conflicts: Vec<SyncConflict>,
}

/// Pull changes from already-read Zotero items into linked vault papers.
pub(crate) fn pull(
    vault: &Path,
    items: &[SyncItem],
    opts: &PullOptions,
    progress: impl Fn(usize, usize),
) -> Result<PullReport, AppError> {
    let index = link::build_catalog_index(vault)?;
    let mut report = PullReport::default();
    let total = items.len();

    for (idx, item) in items.iter().enumerate() {
        progress(idx, total);
        // Items without a title cannot map to a paper.
        let Ok(meta) = map_zotero_item(&item.json) else {
            report.unlinked += 1;
            continue;
        };
        let Some(linked) = index.find(
            item.item_id,
            meta.doi.as_deref(),
            meta.arxiv_id.as_deref(),
            &meta.title,
        ) else {
            report.unlinked += 1;
            continue;
        };
        report.linked += 1;

        let mut record = linked.record.clone();

        // Backfill the exact linkage when matched via a fallback key.
        if linked.matched_by != MatchedBy::ZoteroId && record.zotero_item_id.is_none() {
            record.zotero_item_id = Some(item.item_id);
            report.linkage_backfilled += 1;
        }

        if opts.metadata && fill_metadata(&mut record, &meta) {
            report.metadata_filled += 1;
        }

        let notes_path = vault.join(&record.path).join("NOTES.md");
        let watermark = record.zotero_last_synced.clone();

        // Self-heal before anything else: earlier versions leaked our own
        // pushed notes back into NOTES.md as escaped garbage blocks. Removing
        // them here makes every future sync start from a clean file.
        if opts.notes {
            let raw = fs::read_to_string(&notes_path).unwrap_or_default();
            let cleaned = codec::strip_leaked_sync_blocks(&raw);
            if cleaned != raw {
                let _ = fs::write(&notes_path, cleaned);
            }
        }
        let vault_changed = file_newer_than(&notes_path, watermark.as_deref());

        if opts.notes {
            let fresh_notes: Vec<String> = item
                .notes
                .iter()
                // Never re-import our own sync notes — in ANY damage state
                // (intact markers, Zotero-escaped, Markdown-escaped).
                .filter(|n| !codec::looks_like_sync_note(&n.html))
                .map(|n| codec::html_to_markdown(&n.html))
                .filter(|s| !s.is_empty())
                .collect();
            if !fresh_notes.is_empty() {
                let zotero_changed = item.notes.iter().any(|n| {
                    !codec::looks_like_sync_note(&n.html)
                        && newer_than(n.date_modified.as_deref(), watermark.as_deref())
                });
                if watermark.is_some() && zotero_changed && vault_changed {
                    report.conflicts.push(SyncConflict {
                        paper_path: record.path.clone(),
                        title: record.title.clone(),
                        reason: "both Zotero notes and NOTES.md changed since last sync"
                            .to_string(),
                    });
                } else if notes_path.is_file() && append_markdown_blocks(&notes_path, &fresh_notes)
                {
                    report.notes_added += 1;
                }
            }
        }

        if opts.annotations && !item.annotations.is_empty() && notes_path.is_file() {
            // Content-level idempotent append; no conflict risk (never edits).
            if append_markdown_blocks(&notes_path, &item.annotations) {
                report.annotations_added += 1;
            }
        }

        // Advance the watermark so the next pull starts from here.
        record.zotero_last_synced = Some(now_iso());
        papers::upsert_paper(vault, &record)?;
    }
    progress(total, total);
    Ok(report)
}

/// Fill empty catalog fields from Zotero metadata; never overwrite values.
fn fill_metadata(record: &mut papers::PaperRecord, meta: &PaperMeta) -> bool {
    let mut changed = false;
    macro_rules! fill {
        ($field:expr, $value:expr) => {
            if $field.is_none() || $field.as_deref().map(str::trim) == Some("") {
                if let Some(v) = $value {
                    let v = v.trim();
                    if !v.is_empty() {
                        $field = Some(v.to_string());
                        changed = true;
                    }
                }
            }
        };
    }
    if record.year.is_none() && meta.year.is_some() {
        record.year = meta.year;
        changed = true;
    }
    fill!(record.doi, meta.doi.as_deref());
    fill!(record.arxiv_id, meta.arxiv_id.as_deref());
    fill!(record.abstract_text, meta.abstract_text.as_deref());
    fill!(record.isbn, meta.isbn.as_deref());
    fill!(record.issn, meta.issn.as_deref());
    fill!(record.pmid, meta.pmid.as_deref());
    fill!(record.publication, meta.publication.as_deref());
    fill!(record.volume, meta.volume.as_deref());
    fill!(record.issue, meta.issue.as_deref());
    fill!(record.pages, meta.pages.as_deref());
    fill!(record.publisher, meta.publisher.as_deref());
    fill!(record.date, meta.date.as_deref());
    if record.creators.is_none() && meta.creators.is_some() {
        record.creators = meta.creators.clone();
        changed = true;
    }
    if record.zotero_item_type.as_deref() != meta.zotero_item_type.as_deref()
        && meta.zotero_item_type.is_some()
    {
        record.zotero_item_type = meta.zotero_item_type.clone();
        changed = true;
    }
    changed
}

fn now_iso() -> String {
    crate::core::time::now_rfc3339_millis()
}

/// True when `a` parses to a later instant than `b` (missing/unparseable → false).
fn newer_than(a: Option<&str>, b: Option<&str>) -> bool {
    let (Some(a), Some(b)) = (a, b) else {
        return b.is_none() && a.is_some();
    };
    match (parse_dt(a), parse_dt(b)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fill_only_empty_fields() {
        let mut record = papers::PaperRecord {
            path: "papers/x".into(),
            id: "x".into(),
            paper_type: "article".into(),
            title: "T".into(),
            authors: vec![],
            creators: None,
            year: Some(2020),
            date: None,
            abstract_text: None,
            tags: vec![],
            arxiv_id: None,
            doi: Some("10.1/keep".into()),
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
        };
        let meta = PaperMeta {
            id: "x".into(),
            paper_type: "journalArticle".into(),
            title: "T".into(),
            authors: vec![],
            creators: None,
            year: Some(2021),
            date: Some("2021-05-01".into()),
            abstract_text: Some("abstract".into()),
            tags: vec![],
            arxiv_id: Some("1706.03762".into()),
            doi: Some("10.1/new".into()),
            isbn: None,
            issn: None,
            pmid: None,
            publication: Some("Nature".into()),
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
            bibtex_key: None,
            zotero_item_type: Some("journalArticle".into()),
            meta_source: None,
            extra: None,
            summary: None,
            status: "completed".into(),
            added_at: "t".into(),
            updated_at: "t".into(),
        };
        assert!(fill_metadata(&mut record, &meta));
        // Existing values are never overwritten.
        assert_eq!(record.year, Some(2020));
        assert_eq!(record.doi.as_deref(), Some("10.1/keep"));
        // Empty fields are filled.
        assert_eq!(record.arxiv_id.as_deref(), Some("1706.03762"));
        assert_eq!(record.abstract_text.as_deref(), Some("abstract"));
        assert_eq!(record.publication.as_deref(), Some("Nature"));
    }

    #[test]
    fn parses_zotero_and_rfc3339_dates() {
        assert!(parse_dt("2026-01-02 03:04:05").is_some());
        assert!(parse_dt("2026-01-02T03:04:05Z").is_some());
        assert!(newer_than(
            Some("2026-01-02 03:04:06"),
            Some("2026-01-02T03:04:05Z")
        ));
        assert!(!newer_than(
            Some("2026-01-01 00:00:00"),
            Some("2026-01-02T00:00:00Z")
        ));
        // No watermark → anything dated counts as newer.
        assert!(newer_than(Some("2020-01-01 00:00:00"), None));
    }
}
