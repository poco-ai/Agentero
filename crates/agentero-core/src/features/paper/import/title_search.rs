//! Frontend-facing title/keyword search wrapper.
//!
//! The source-racing logic lives in [`crate::features::scholar_api::search`];
//! this module only keeps the `PaperSearchCandidate` / `PaperSearchGroup` shapes
//! and the `needs_s2_venue_enrichment` helper used by the import UI.

use serde::Serialize;

use crate::error::AppError;
use crate::features::scholar_api::search::{rank_candidates, search_papers_by_title};

#[derive(Debug, Clone, Serialize, specta::Type)]
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
    /// Source that produced the candidate, e.g. `"s2"` or `"arxiv"`.
    pub source: &'static str,
}

impl From<crate::features::scholar_api::ApiPaper> for PaperSearchCandidate {
    fn from(p: crate::features::scholar_api::ApiPaper) -> Self {
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

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PaperSearchGroup {
    pub query: String,
    pub candidates: Vec<PaperSearchCandidate>,
}

/// Search papers by title/keyword. Returns at most `limit` candidates that carry
/// an arXiv id or DOI.
///
/// Delegates to [`crate::features::scholar_api::search::search_papers_by_title`]
/// and maps the results into frontend-facing candidates.
pub async fn search_papers(
    query: &str,
    limit: usize,
) -> Result<Vec<PaperSearchCandidate>, AppError> {
    let hits = search_papers_by_title(query, limit).await?;
    Ok(rank_candidates(hits, query, limit)
        .into_iter()
        .map(PaperSearchCandidate::from)
        .collect())
}

/// True when the current `publication` value should be replaced from S2.
pub fn needs_s2_venue_enrichment(publication: Option<&str>) -> bool {
    use crate::features::scholar_api::sources::semantic_scholar::is_usable_publication;
    match publication {
        None => true,
        Some(s) => !is_usable_publication(s),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_api_paper_to_candidate() {
        use crate::features::scholar_api::{ApiPaper, PaperIdentifiers, PaperUrls};
        let p = ApiPaper {
            title: "Attention Is All You Need".into(),
            authors: vec!["Ashish Vaswani".into()],
            year: Some(2017),
            date: Some("2017".into()),
            venue: Some("NeurIPS".into()),
            volume: None,
            issue: None,
            pages: None,
            publisher: None,
            abstract_text: None,
            language: None,
            citation_count: Some(42),
            identifiers: PaperIdentifiers {
                arxiv_id: Some("1706.03762".into()),
                doi: Some("10.48550/arXiv.1706.03762".into()),
                ..Default::default()
            },
            urls: PaperUrls {
                landing: Some("https://arxiv.org/abs/1706.03762".into()),
                ..Default::default()
            },
            source: "arxiv",
        };
        let c = PaperSearchCandidate::from(p);
        assert_eq!(c.title, "Attention Is All You Need");
        assert_eq!(c.identifier, "1706.03762");
        assert_eq!(c.source, "arxiv");
    }
}
