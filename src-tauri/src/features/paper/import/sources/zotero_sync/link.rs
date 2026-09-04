//! Paper ↔ Zotero item linkage for bidirectional sync.
//!
//! Matching order mirrors migration dedup: exact `zotero_item_id` first, then
//! DOI → arXiv id → normalized title. Fallback matches backfill the item id
//! into the catalog row so later syncs take the fast exact path.

use crate::core::error::AppError;
use crate::features::catalog::papers::{self, PaperRecord};
use crate::features::zotero::db::normalize_title;
use std::collections::HashMap;
use std::path::Path;

/// How a paper was matched to a Zotero item.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchedBy {
    ZoteroId,
    Doi,
    Arxiv,
    Title,
}

/// One catalog paper plus how it was linked.
#[derive(Debug)]
pub struct LinkedPaper {
    pub record: PaperRecord,
    pub matched_by: MatchedBy,
}

/// In-memory catalog index keyed by every supported match key.
#[derive(Debug, Default)]
pub struct CatalogIndex {
    records: Vec<PaperRecord>,
    by_zotero_id: HashMap<i64, usize>,
    by_doi: HashMap<String, usize>,
    by_arxiv: HashMap<String, usize>,
    by_title: HashMap<String, usize>,
}

impl CatalogIndex {
    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    /// Match one Zotero item against the catalog.
    pub fn find(
        &self,
        zotero_item_id: i64,
        doi: Option<&str>,
        arxiv_id: Option<&str>,
        title: &str,
    ) -> Option<LinkedPaper> {
        if let Some(&idx) = self.by_zotero_id.get(&zotero_item_id) {
            return Some(LinkedPaper {
                record: self.records[idx].clone(),
                matched_by: MatchedBy::ZoteroId,
            });
        }
        if let Some(key) = doi
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
        {
            if let Some(&idx) = self.by_doi.get(&key) {
                return Some(LinkedPaper {
                    record: self.records[idx].clone(),
                    matched_by: MatchedBy::Doi,
                });
            }
        }
        if let Some(key) = arxiv_id
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
        {
            if let Some(&idx) = self.by_arxiv.get(&key) {
                return Some(LinkedPaper {
                    record: self.records[idx].clone(),
                    matched_by: MatchedBy::Arxiv,
                });
            }
        }
        let key = normalize_title(title);
        if !key.is_empty() {
            if let Some(&idx) = self.by_title.get(&key) {
                return Some(LinkedPaper {
                    record: self.records[idx].clone(),
                    matched_by: MatchedBy::Title,
                });
            }
        }
        None
    }
}

/// Build the match index from the vault catalog.
pub fn build_catalog_index(vault: &Path) -> Result<CatalogIndex, AppError> {
    let rows = papers::list_all(vault)?;
    let mut index = CatalogIndex::default();
    for (idx, row) in rows.iter().enumerate() {
        if let Some(id) = row.zotero_item_id {
            index.by_zotero_id.entry(id).or_insert(idx);
        }
        if let Some(doi) = row
            .doi
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_lowercase)
        {
            index.by_doi.entry(doi).or_insert(idx);
        }
        if let Some(aid) = row
            .arxiv_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_lowercase)
        {
            index.by_arxiv.entry(aid).or_insert(idx);
        }
        let title = normalize_title(&row.title);
        if !title.is_empty() {
            index.by_title.entry(title).or_insert(idx);
        }
    }
    index.records = rows;
    Ok(index)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(path: &str, doi: Option<&str>, arxiv: Option<&str>, title: &str) -> PaperRecord {
        PaperRecord {
            path: path.into(),
            id: path.rsplit('/').next().unwrap_or(path).into(),
            paper_type: "article".into(),
            title: title.into(),
            authors: vec![],
            creators: None,
            year: None,
            date: None,
            abstract_text: None,
            tags: vec![],
            arxiv_id: arxiv.map(String::from),
            doi: doi.map(String::from),
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

    fn index_of(records: Vec<PaperRecord>) -> CatalogIndex {
        let mut index = CatalogIndex::default();
        for (idx, row) in records.iter().enumerate() {
            if let Some(id) = row.zotero_item_id {
                index.by_zotero_id.entry(id).or_insert(idx);
            }
            if let Some(doi) = row.doi.as_deref().map(str::to_lowercase) {
                index.by_doi.entry(doi).or_insert(idx);
            }
            if let Some(a) = row.arxiv_id.as_deref().map(str::to_lowercase) {
                index.by_arxiv.entry(a).or_insert(idx);
            }
            let t = normalize_title(&row.title);
            if !t.is_empty() {
                index.by_title.entry(t).or_insert(idx);
            }
        }
        index.records = records;
        index
    }

    #[test]
    fn exact_zotero_id_wins_over_other_keys() {
        let mut a = record("papers/a", Some("10.1/x"), None, "Paper A");
        a.zotero_item_id = Some(7);
        let b = record("papers/b", None, Some("1706.03762"), "Paper B");
        let index = index_of(vec![a, b]);
        // Item 7 carries a DOI that points at paper b — the exact id still wins.
        let hit = index.find(7, Some("10.9/other"), None, "Paper B").unwrap();
        assert_eq!(hit.record.path, "papers/a");
        assert_eq!(hit.matched_by, MatchedBy::ZoteroId);
    }

    #[test]
    fn fallback_chain_doi_arxiv_title() {
        let a = record("papers/a", Some("10.1/x"), None, "Paper A");
        let b = record("papers/b", None, Some("1706.03762"), "Paper B");
        let c = record("papers/c", None, None, "Paper C");
        let index = index_of(vec![a, b, c]);

        assert_eq!(
            index.find(1, Some("10.1/X"), None, "").unwrap().matched_by,
            MatchedBy::Doi
        );
        assert_eq!(
            index
                .find(2, None, Some("1706.03762"), "")
                .unwrap()
                .matched_by,
            MatchedBy::Arxiv
        );
        assert_eq!(
            index
                .find(3, None, None, "  paper   c ")
                .unwrap()
                .matched_by,
            MatchedBy::Title
        );
        assert!(index
            .find(4, Some("10.9/zzz"), Some("9999.9"), "nope")
            .is_none());
    }
}
