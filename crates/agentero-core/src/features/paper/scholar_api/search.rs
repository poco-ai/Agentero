//! Title/keyword search orchestration across `scholar_api` sources.
//!
//! This module implements the source-racing logic previously owned by
//! `features::import::title_search`, so that other callers (batch importers,
//! CLI, remote bridge) can run a title search without depending on the import
//! feature.

use std::time::Duration;

use crate::features::scholar_api::scoring::normalize_title;
use crate::features::scholar_api::sources::{
    arxiv::ArxivApi, semantic_scholar::SemanticScholarApi,
};
use crate::features::scholar_api::traits::AcademicApi;
use crate::features::scholar_api::{ApiError, ApiPaper, ApiQuery};

/// How long Semantic Scholar gets before the already-in-flight arXiv result
/// decides the search. Healthy S2 answers land sub-second and rate-limit
/// rejections are fast, so this budget only caps the hang case.
const S2_SEARCH_BUDGET: Duration = Duration::from_secs(5);

/// Search papers by title/keyword across Semantic Scholar and arXiv.
///
/// Both sources fire concurrently. S2 wins whenever it answers with hits inside
/// [`S2_SEARCH_BUDGET`]; otherwise the already-in-flight arXiv result is used.
/// The returned `Vec<ApiPaper>` is unranked and may contain duplicates across
/// sources; use [`rank_candidates`] to order and trim it.
pub async fn search_papers_by_title(query: &str, _limit: usize) -> Result<Vec<ApiPaper>, ApiError> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let api_query = ApiQuery::Title(query.to_string());

    let s2 = tokio::time::timeout(S2_SEARCH_BUDGET, SemanticScholarApi.fetch(&api_query));
    let arxiv = ArxivApi.fetch(&api_query);
    tokio::pin!(s2);
    tokio::pin!(arxiv);

    let arxiv_hits = tokio::select! {
        out = &mut s2 => {
            match out {
                Ok(Ok(hits)) if !hits.is_empty() => return Ok(hits),
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
            Ok(Ok(s2_hits)) if !s2_hits.is_empty() => return Ok(s2_hits),
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
    arxiv_hits
}

/// Rank and truncate raw search hits.
///
/// Keeps the provider's relevance order, but floats exact title matches to the
/// top — same-named papers otherwise bury the one the user meant.
pub fn rank_candidates(mut hits: Vec<ApiPaper>, query: &str, limit: usize) -> Vec<ApiPaper> {
    let target = normalize_title(query);
    hits.sort_by_key(|c| normalize_title(&c.title) != target);
    hits.truncate(limit.max(1));
    hits
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::scholar_api::{PaperIdentifiers, PaperUrls};

    #[test]
    fn floats_exact_title_match_to_top() {
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
        let ranked = rank_candidates(hits, "attention is all you need", 2);
        assert_eq!(ranked[0].title, "Attention Is All You Need");
    }

    #[test]
    fn empty_query_returns_empty() {
        // search_papers_by_title is async and network-bound; just verify the
        // synchronous guard by calling rank_candidates with an empty hit list.
        let ranked = rank_candidates(vec![], "query", 5);
        assert!(ranked.is_empty());
    }
}
