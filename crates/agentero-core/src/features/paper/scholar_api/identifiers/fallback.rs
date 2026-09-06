//! Direct-connect fallback fetchers used when the Translator Runtime fails.

use crate::error::AppError;
use crate::features::scholar_api::sources::{
    arxiv::ArxivApi, crossref::CrossrefApi, pubmed::PubMedApi,
};
use crate::features::scholar_api::traits::AcademicApi;
use crate::features::scholar_api::{ApiPaper, ApiQuery};

use super::kind::{ResolvedIdentifier, ARXIV, DOI, PMID};
use super::resolver;

/// `GET https://export.arxiv.org/api/query?id_list=…` (Atom) → `ApiPaper`.
pub async fn fetch_arxiv_metadata(
    arxiv_id: &str,
    task_id: Option<&str>,
) -> Result<ApiPaper, AppError> {
    check_cancelled(task_id)?;
    let source = ArxivApi;
    let mut papers = source
        .fetch(&ApiQuery::ArxivId(arxiv_id.to_string()))
        .await?;
    check_cancelled(task_id)?;
    papers
        .pop()
        .ok_or_else(|| AppError::message("arXiv metadata not found"))
}

/// `GET https://api.crossref.org/works/{doi}` → `ApiPaper`.
pub async fn fetch_crossref_metadata(doi: &str) -> Result<ApiPaper, AppError> {
    let source = CrossrefApi;
    let mut papers = source.fetch(&ApiQuery::Doi(doi.to_string())).await?;
    papers
        .pop()
        .ok_or_else(|| AppError::message("crossref metadata not found"))
}

/// `GET https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=...` → `ApiPaper`.
pub async fn fetch_pubmed_metadata(pmid: &str) -> Result<ApiPaper, AppError> {
    let source = PubMedApi;
    let mut papers = source.fetch(&ApiQuery::Pmid(pmid.to_string())).await?;
    papers
        .pop()
        .ok_or_else(|| AppError::message("pubmed metadata not found"))
}

/// First direct-connect fallback whose resolver matches `text`, probing the
/// table independently of the primary identifier: a `doi.org` URL resolves
/// as `url` first, yet its DOI still gets the Crossref fallback.
pub async fn fetch_direct_fallback(
    text: &str,
    task_id: Option<&str>,
) -> Option<Result<ApiPaper, AppError>> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    for resolver in resolver::resolvers() {
        let Some(ResolvedIdentifier { kind, value, .. }) = resolver.extract(t) else {
            continue;
        };
        let fallback = match kind {
            ARXIV => Some(fetch_arxiv_metadata(&value, task_id).await),
            DOI => Some(fetch_crossref_metadata(&value).await),
            PMID => Some(fetch_pubmed_metadata(&value).await),
            _ => None,
        };
        if fallback.is_some() {
            return fallback;
        }
    }
    None
}

fn check_cancelled(task_id: Option<&str>) -> Result<(), AppError> {
    if task_id.is_some_and(crate::cancel::is_cancelled) {
        return Err(AppError::message("background task cancelled"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::kind::{ADS, ISBN, URL};
    use super::*;

    #[test]
    fn direct_fallbacks_match_resolver_kinds() {
        let has_fallback = |kind: &str| matches!(kind, ARXIV | DOI | PMID);
        assert!(has_fallback(ARXIV));
        assert!(has_fallback(DOI));
        assert!(has_fallback(PMID));
        for kind in [URL, ISBN, ADS] {
            assert!(!has_fallback(kind), "{kind} should have no fallback");
        }
    }
}
