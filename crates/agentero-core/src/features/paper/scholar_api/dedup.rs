//! In-memory deduplication of paper candidates.
//!
//! Useful for cleaning up search results from multiple sources, or for
//! removing duplicate entries parsed from a bibliography file (BibTeX / RIS / …)
//! before they reach the import pipeline.

use std::collections::HashSet;

use crate::features::scholar_api::scoring::is_same_paper;
use crate::features::scholar_api::{ApiPaper, PaperIdentifiers};

/// Deduplicate a list of paper candidates.
///
/// The algorithm is conservative: two records are considered the same paper if
/// they share any normalized identifier (DOI, arXiv ID, PMID, ISBN), or if they
/// have no shared identifier but [`is_same_paper`] reports a fuzzy match.
///
/// The first occurrence is kept; later duplicates are dropped. Callers that
/// prefer richer metadata should enrich candidates before deduping.
pub fn dedup_api_papers(papers: Vec<ApiPaper>) -> Vec<ApiPaper> {
    let mut out: Vec<ApiPaper> = Vec::with_capacity(papers.len());
    let mut seen_ids: HashSet<String> = HashSet::new();

    for paper in papers {
        let ids = identifier_keys(&paper.identifiers);
        if ids.iter().any(|k| seen_ids.contains(k)) {
            continue;
        }

        let fuzzy_dup = out.iter().any(|kept| is_same_paper(kept, &paper, 1));
        if fuzzy_dup {
            continue;
        }

        seen_ids.extend(ids);
        out.push(paper);
    }

    out
}

/// Build a set of normalized identifier keys for exact dedup.
fn identifier_keys(ids: &PaperIdentifiers) -> Vec<String> {
    let mut keys = Vec::with_capacity(4);
    if let Some(doi) = ids.doi.as_deref() {
        keys.push(format!("doi:{}", normalize_id(doi)));
    }
    if let Some(arxiv) = ids.arxiv_id.as_deref() {
        keys.push(format!("arxiv:{}", normalize_id(arxiv)));
    }
    if let Some(pmid) = ids.pmid.as_deref() {
        keys.push(format!("pmid:{}", normalize_id(pmid)));
    }
    if let Some(isbn) = ids.isbn.as_deref() {
        keys.push(format!("isbn:{}", normalize_id(isbn)));
    }
    keys
}

fn normalize_id(s: &str) -> String {
    s.trim().to_lowercase().replace(['-', '_', ' '], "")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::scholar_api::{PaperIdentifiers, PaperUrls};

    fn paper(title: &str, authors: &[&str], year: Option<i32>, ids: PaperIdentifiers) -> ApiPaper {
        ApiPaper {
            title: title.into(),
            authors: authors.iter().map(|s| (*s).to_string()).collect(),
            year,
            date: year.map(|y| y.to_string()),
            venue: None,
            volume: None,
            issue: None,
            pages: None,
            publisher: None,
            abstract_text: None,
            language: None,
            citation_count: None,
            identifiers: ids,
            urls: PaperUrls::default(),
            source: "test",
        }
    }

    #[test]
    fn dedups_by_doi() {
        let papers = vec![
            paper(
                "A",
                &["Alice"],
                Some(2020),
                PaperIdentifiers {
                    doi: Some("10.1/abc".into()),
                    ..Default::default()
                },
            ),
            paper(
                "A'",
                &["Alice"],
                Some(2020),
                PaperIdentifiers {
                    doi: Some("10.1/ABC".into()),
                    ..Default::default()
                },
            ),
        ];
        assert_eq!(dedup_api_papers(papers).len(), 1);
    }

    #[test]
    fn dedups_fuzzy_when_no_identifiers() {
        let papers = vec![
            paper(
                "Attention Is All You Need",
                &["Vaswani"],
                Some(2017),
                PaperIdentifiers::default(),
            ),
            paper(
                "Attention is all you need",
                &["Vaswani, Ashish"],
                Some(2017),
                PaperIdentifiers::default(),
            ),
        ];
        assert_eq!(dedup_api_papers(papers).len(), 1);
    }

    #[test]
    fn keeps_distinct_papers() {
        let papers = vec![
            paper("BERT", &["Devlin"], Some(2019), PaperIdentifiers::default()),
            paper("GPT-3", &["Brown"], Some(2020), PaperIdentifiers::default()),
        ];
        assert_eq!(dedup_api_papers(papers).len(), 2);
    }

    #[test]
    fn empty_input_is_empty() {
        assert!(dedup_api_papers(vec![]).is_empty());
    }
}
