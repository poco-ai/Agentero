//! Title-driven metadata resolver that follows the Bibtex-Verifier pipeline:
//!
//! 1. Semantic Scholar `/paper/search/match`
//! 2. Crossref title search (5 results)
//! 3. OpenAlex title search (5 results)
//! 4. Semantic Scholar ordinary title search (5 results)
//! 5. arXiv title search fallback (5 results)
//!
//! A candidate is accepted when its normalized title is at least 70% similar to
//! the query. When S2 match and a Crossref result describe the same paper
//! (title ≥ 85%, year within 2 years, author surname overlap ≥ 30%), their
//! metadata are merged, with Crossref preferred for volume/issue/pages/publisher.

use crate::core::error::AppError;
use crate::features::import::api_mapper::{
    api_paper_to_meta, best_match, merge_api_papers, score_against_query,
};
use crate::features::import::map::{enrich_remote_urls, PaperMeta};
use crate::scholar_api::scoring::{is_same_paper, normalize_title};
use crate::scholar_api::sources::{
    arxiv::ArxivApi, crossref::CrossrefApi, openalex::OpenAlexApi,
    semantic_scholar::SemanticScholarApi,
};
use crate::scholar_api::traits::AcademicApi;
use crate::scholar_api::{ApiPaper, ApiQuery};

const MATCH_THRESHOLD: i32 = 70;

/// Resolve metadata for a free-form title query.
pub async fn resolve_metadata_chain(query: &str) -> Result<PaperMeta, AppError> {
    let query = query.trim();
    if query.is_empty() {
        return Err(AppError::message("empty title query"));
    }
    let norm_query = normalize_title(query);

    // 1. S2 /paper/search/match
    let s2_match = SemanticScholarApi
        .search_match(query)
        .await
        .unwrap_or_else(|e| {
            log::warn!("s2 search/match failed: {e}");
            None
        });
    if let Some(s2) = s2_match {
        let score = score_against_query(&s2, &norm_query);
        if score >= MATCH_THRESHOLD {
            // 2. Crossref query 5
            let crossref = CrossrefApi
                .fetch(&ApiQuery::Title(query.to_string()))
                .await
                .unwrap_or_else(|e| {
                    log::warn!("crossref title search failed: {e}");
                    Vec::new()
                });
            if let Some(cr) = find_same_paper(&s2, &crossref) {
                let mut merged = merge_api_papers(&s2, cr);
                enrich_remote_urls(&mut merged);
                return Ok(merged);
            }
            let mut meta = api_paper_to_meta(&s2);
            enrich_remote_urls(&mut meta);
            return Ok(meta);
        }
    }

    // 3. Crossref query 5
    let crossref = CrossrefApi
        .fetch(&ApiQuery::Title(query.to_string()))
        .await
        .map_err(|e| AppError::message(format!("crossref title search failed: {e}")))?;
    if let Some(cr) = best_match(&crossref, &norm_query) {
        if score_against_query(cr, &norm_query) >= MATCH_THRESHOLD {
            let mut meta = api_paper_to_meta(cr);
            enrich_remote_urls(&mut meta);
            return Ok(meta);
        }
    }

    // 4. OpenAlex query 5
    let openalex = OpenAlexApi
        .fetch(&ApiQuery::Title(query.to_string()))
        .await
        .map_err(|e| AppError::message(format!("openalex title search failed: {e}")))?;
    if let Some(oa) = best_match(&openalex, &norm_query) {
        if score_against_query(oa, &norm_query) >= MATCH_THRESHOLD {
            let mut meta = api_paper_to_meta(oa);
            enrich_remote_urls(&mut meta);
            return Ok(meta);
        }
    }

    // 5. S2 ordinary search 5
    let s2_hits = SemanticScholarApi
        .fetch(&ApiQuery::Title(query.to_string()))
        .await
        .map_err(|e| AppError::message(format!("s2 search failed: {e}")))?;
    if let Some(s2) = best_match(&s2_hits, &norm_query) {
        if score_against_query(s2, &norm_query) >= MATCH_THRESHOLD {
            let mut meta = api_paper_to_meta(s2);
            enrich_remote_urls(&mut meta);
            return Ok(meta);
        }
    }

    // 6. arXiv fallback
    let arxiv_hits = ArxivApi
        .fetch(&ApiQuery::Title(query.to_string()))
        .await
        .map_err(|e| AppError::message(format!("arXiv search failed: {e}")))?;
    if let Some(arx) = best_match(&arxiv_hits, &norm_query) {
        let mut meta = api_paper_to_meta(arx);
        enrich_remote_urls(&mut meta);
        return Ok(meta);
    }

    Err(AppError::message(
        "could not resolve metadata for the given title",
    ))
}

fn find_same_paper<'a>(target: &ApiPaper, candidates: &'a [ApiPaper]) -> Option<&'a ApiPaper> {
    candidates.iter().find(|c| is_same_paper(target, c, 2))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "live network latency benchmark"]
    async fn live_latency_benchmark() {
        use std::time::Instant;

        let title = "Attention Is All You Need";
        let norm = normalize_title(title);

        let t0 = Instant::now();
        let s2 = SemanticScholarApi.search_match(title).await.unwrap_or(None);
        let s2_elapsed = t0.elapsed();
        println!("S2 /paper/search/match: {s2_elapsed:?}");
        if let Some(c) = &s2 {
            println!(
                "  -> {} (score vs query: {})",
                c.title,
                score_against_query(c, &norm)
            );
        }

        let t0 = Instant::now();
        let cr = CrossrefApi
            .fetch(&ApiQuery::Title(title.to_string()))
            .await
            .unwrap_or_default();
        let cr_elapsed = t0.elapsed();
        println!(
            "Crossref title search: {cr_elapsed:?} ({} results)",
            cr.len()
        );

        let t0 = Instant::now();
        let oa = OpenAlexApi
            .fetch(&ApiQuery::Title(title.to_string()))
            .await
            .unwrap_or_default();
        let oa_elapsed = t0.elapsed();
        println!(
            "OpenAlex title search: {oa_elapsed:?} ({} results)",
            oa.len()
        );

        let t0 = Instant::now();
        let s2_hits = SemanticScholarApi
            .fetch(&ApiQuery::Title(title.to_string()))
            .await
            .unwrap_or_default();
        let s2_search_elapsed = t0.elapsed();
        println!(
            "S2 ordinary search: {s2_search_elapsed:?} ({} results)",
            s2_hits.len()
        );

        let t0 = Instant::now();
        let arx = ArxivApi
            .fetch(&ApiQuery::Title(title.to_string()))
            .await
            .unwrap_or_default();
        let arx_elapsed = t0.elapsed();
        println!(
            "arXiv title search: {arx_elapsed:?} ({} results)",
            arx.len()
        );

        let t0 = Instant::now();
        match resolve_metadata_chain(title).await {
            Ok(meta) => {
                let full_elapsed = t0.elapsed();
                println!("Full chain (first success): {full_elapsed:?}");
                println!("  -> title: {}", meta.title);
                println!("  -> source: {:?}", meta.meta_source);
            }
            Err(e) => println!("Full chain failed: {e}"),
        }
    }
}
