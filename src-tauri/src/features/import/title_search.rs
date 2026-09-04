//! Title/keyword search for the magic wand.
//!
//! This module delegates to `scholar_api` sources and only keeps the
//! frontend-facing `PaperSearchCandidate` / `PaperSearchGroup` shapes.

use std::time::Duration;

use serde::Serialize;

use crate::core::error::AppError;
use crate::scholar_api::sources::{arxiv::ArxivApi, semantic_scholar::SemanticScholarApi};
use crate::scholar_api::traits::AcademicApi;
use crate::scholar_api::ApiQuery;

/// How long Semantic Scholar gets before the already-in-flight arXiv result
/// decides the search. Healthy S2 answers land sub-second and rate-limit
/// rejections are fast, so this budget only caps the hang case.
const S2_SEARCH_BUDGET: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperSearchCandidate {
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<i32>,
    pub venue: Option<String>,
    pub doi: Option<String>,
    pub arxiv_id: Option<String>,
    pub citation_count: Option<i64>,
    pub url: Option<String>,
    /// Text handed back to the identifier pipeline (arXiv id preferred over DOI).
    pub identifier: String,
    /// `"s2"` or `"arxiv"`.
    pub source: &'static str,
}

impl From<crate::scholar_api::ApiPaper> for PaperSearchCandidate {
    fn from(p: crate::scholar_api::ApiPaper) -> Self {
        let identifier = p
            .identifiers
            .arxiv_id
            .clone()
            .or(p.identifiers.doi.clone())
            .unwrap_or_default();
        Self {
            title: p.title,
            authors: p.authors,
            year: p.year,
            venue: p.venue,
            doi: p.identifiers.doi,
            arxiv_id: p.identifiers.arxiv_id,
            citation_count: p.citation_count,
            url: p.urls.landing,
            identifier,
            source: p.source,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperSearchGroup {
    pub query: String,
    pub candidates: Vec<PaperSearchCandidate>,
}

/// Search papers by title/keyword. Returns at most `limit` candidates that carry
/// an arXiv id or DOI.
///
/// Semantic Scholar and arXiv fire concurrently; S2 wins whenever it answers
/// with hits inside [`S2_SEARCH_BUDGET`], otherwise the already-in-flight arXiv
/// result decides.
pub async fn search_papers(
    query: &str,
    limit: usize,
) -> Result<Vec<PaperSearchCandidate>, AppError> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.max(1);
    let api_query = ApiQuery::Title(query.to_string());

    let s2 = tokio::time::timeout(S2_SEARCH_BUDGET, SemanticScholarApi.fetch(&api_query));
    let arxiv = ArxivApi.fetch(&api_query);
    tokio::pin!(s2);
    tokio::pin!(arxiv);

    let arxiv_hits = tokio::select! {
        out = &mut s2 => {
            match out {
                Ok(Ok(hits)) if !hits.is_empty() => return Ok(rank(hits, query, limit)),
                Ok(Ok(_)) => log::warn!("title search: semantic scholar returned no results for {query}"),
                Ok(Err(e)) => log::warn!("title search: semantic scholar failed ({e}); falling back to arXiv"),
                Err(_elapsed) => log::warn!(
                    "title search: semantic scholar exceeded its {}s budget; falling back to arXiv",
                    S2_SEARCH_BUDGET.as_secs()
                ),
            }
            arxiv.await
        }
        hits = &mut arxiv => match s2.await {
            Ok(Ok(s2_hits)) if !s2_hits.is_empty() => return Ok(rank(s2_hits, query, limit)),
            Ok(Ok(_)) => {
                log::warn!("title search: semantic scholar returned no results for {query}");
                hits
            }
            Ok(Err(e)) => {
                log::warn!("title search: semantic scholar failed ({e}); using arXiv results");
                hits
            }
            Err(_elapsed) => {
                log::warn!(
                    "title search: semantic scholar exceeded its {}s budget; using arXiv results",
                    S2_SEARCH_BUDGET.as_secs()
                );
                hits
            }
        },
    };
    match arxiv_hits {
        Ok(hits) => Ok(rank(hits, query, limit)),
        Err(e) => Err(AppError::message(format!("arXiv search failed: {e}"))),
    }
}

/// Keep the provider's relevance order, but float exact title matches to the
/// top — same-named papers otherwise bury the one the user meant.
fn rank(
    mut hits: Vec<crate::scholar_api::ApiPaper>,
    query: &str,
    limit: usize,
) -> Vec<PaperSearchCandidate> {
    let target = normalize_title(query);
    hits.sort_by_key(|c| normalize_title(&c.title) != target);
    hits.truncate(limit);
    hits.into_iter().map(PaperSearchCandidate::from).collect()
}

pub(crate) fn normalize_title(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut pending_space = false;
    for ch in s.chars() {
        if ch.is_alphanumeric() {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            out.extend(ch.to_lowercase());
        } else {
            pending_space = true;
        }
    }
    out
}

/// True when the current `publication` value should be replaced from S2.
pub fn needs_s2_venue_enrichment(publication: Option<&str>) -> bool {
    use crate::scholar_api::sources::semantic_scholar::is_usable_publication;
    match publication {
        None => true,
        Some(s) => !is_usable_publication(s),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_punctuation_and_case() {
        assert_eq!(
            normalize_title("Attention Is All You Need!"),
            normalize_title("  attention is  all-you-need ")
        );
    }

    #[test]
    fn floats_exact_title_match_to_top() {
        use crate::scholar_api::{ApiPaper, PaperIdentifiers, PaperUrls};
        let hits = vec![
            ApiPaper {
                title: "Not Attention".into(),
                authors: vec![],
                year: None,
                date: None,
                venue: None,
                volume: None,
                issue: None,
                pages: None,
                publisher: None,
                abstract_text: None,
                language: None,
                citation_count: None,
                identifiers: PaperIdentifiers::default(),
                urls: PaperUrls::default(),
                source: "s2",
            },
            ApiPaper {
                title: "Attention Is All You Need".into(),
                authors: vec![],
                year: None,
                date: None,
                venue: None,
                volume: None,
                issue: None,
                pages: None,
                publisher: None,
                abstract_text: None,
                language: None,
                citation_count: None,
                identifiers: PaperIdentifiers::default(),
                urls: PaperUrls::default(),
                source: "s2",
            },
        ];
        let ranked = rank(hits, "attention is all you need", 2);
        assert_eq!(ranked[0].title, "Attention Is All You Need");
    }
}
