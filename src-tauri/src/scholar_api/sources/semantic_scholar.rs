//! Semantic Scholar Graph API source.

use async_trait::async_trait;
use serde_json::Value;

use crate::scholar_api::client;
use crate::scholar_api::traits::AcademicApi;
use crate::scholar_api::{
    ApiCapability, ApiError, ApiPaper, ApiQuery, PaperIdentifiers, PaperUrls,
};

const SOURCE: &str = "s2";
const API_BASE: &str = "https://api.semanticscholar.org/graph/v1";

/// Semantic Scholar metadata source.
#[derive(Debug, Clone, Default)]
pub struct SemanticScholarApi;

#[async_trait]
impl AcademicApi for SemanticScholarApi {
    fn name(&self) -> &'static str {
        SOURCE
    }

    fn capabilities(&self) -> ApiCapability {
        ApiCapability::SEARCH_BY_TITLE
            | ApiCapability::FETCH_BY_DOI
            | ApiCapability::FETCH_BY_ARXIV
            | ApiCapability::PROVIDE_CITATION_COUNT
            | ApiCapability::PROVIDE_VENUE
    }

    async fn fetch(&self, query: &ApiQuery) -> Result<Vec<ApiPaper>, ApiError> {
        match query {
            ApiQuery::Title(title) => search_by_title(title, 5).await,
            ApiQuery::Doi(doi) => fetch_by_id(&format!("DOI:{doi}")).await.map(|p| vec![p]),
            ApiQuery::ArxivId(id) => fetch_by_id(&format!("ARXIV:{id}")).await.map(|p| vec![p]),
            _ => Err(ApiError::UnsupportedQuery(query.clone())),
        }
    }
}

impl SemanticScholarApi {
    /// `/paper/search/match` returns the single best title match.
    /// This endpoint is S2-specific and not part of the generic `AcademicApi`
    /// trait, so it is exposed as an inherent method.
    pub async fn search_match(&self, title: &str) -> Result<Option<ApiPaper>, ApiError> {
        let url = format!(
            "{API_BASE}/paper/search/match?query={}&fields=title,authors,year,venue,publicationVenue,journal,externalIds,citationCount,url",
            urlencoding::encode(title)
        );
        let value = client::get_json(&url).await?;

        // The endpoint usually returns a single paper object. The `/search`
        // family wraps results in `data`; accept both shapes.
        let item = if let Some(arr) = value.get("data").and_then(|v| v.as_array()) {
            arr.first()
        } else {
            Some(&value)
        };

        let Some(item) = item else {
            return Ok(None);
        };

        // Unlike the regular search endpoint, keep a match even if it has no
        // DOI/arXiv id — this path is used for metadata refresh.
        map_paper(item).map(Some).ok_or(ApiError::NotFound)
    }
}

async fn fetch_by_id(paper_id: &str) -> Result<ApiPaper, ApiError> {
    let (prefix, rest) = paper_id.split_once(':').unwrap_or(("", paper_id));
    let url = if prefix.is_empty() {
        format!(
            "{API_BASE}/paper/{}?fields=title,authors,year,venue,publicationVenue,journal,externalIds,citationCount,url",
            urlencoding::encode(paper_id)
        )
    } else {
        format!(
            "{API_BASE}/paper/{}:{}?fields=title,authors,year,venue,publicationVenue,journal,externalIds,citationCount,url",
            prefix,
            urlencoding::encode(rest)
        )
    };
    let value = client::get_json(&url).await?;
    map_paper(&value).ok_or(ApiError::NotFound)
}

async fn search_by_title(title: &str, limit: usize) -> Result<Vec<ApiPaper>, ApiError> {
    let url = format!(
        "{API_BASE}/paper/search?query={}&limit={}&fields=title,authors,year,venue,publicationVenue,journal,externalIds,citationCount,url",
        urlencoding::encode(title),
        (limit * 4).min(100)
    );
    let value = client::get_json(&url).await?;
    let Some(items) = value.get("data").and_then(|v| v.as_array()) else {
        return Ok(Vec::new());
    };

    let mut out = Vec::new();
    for item in items {
        let Some(paper) = map_paper(item) else {
            continue;
        };
        // Skip entries that cannot be imported (no DOI or arXiv id).
        if paper.identifiers.doi.is_none() && paper.identifiers.arxiv_id.is_none() {
            continue;
        }
        out.push(paper);
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

fn map_paper(item: &Value) -> Option<ApiPaper> {
    let title = str_field(item, "title")?;
    let doi = str_field_at(item, "/externalIds/DOI");
    let arxiv_id = str_field_at(item, "/externalIds/ArXiv").map(|s| strip_arxiv_version(&s));

    let authors: Vec<String> = item
        .get("authors")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|a| str_field(a, "name"))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let year = item.get("year").and_then(|v| v.as_i64()).map(|y| y as i32);
    let venue = venue_from_paper(item);

    Some(ApiPaper {
        identifiers: PaperIdentifiers {
            doi,
            arxiv_id,
            isbn: None,
            pmid: None,
        },
        title,
        authors,
        year,
        date: year.map(|y| y.to_string()),
        venue,
        volume: None,
        issue: None,
        pages: None,
        publisher: None,
        abstract_text: None,
        urls: PaperUrls {
            pdf: None,
            html: None,
            landing: str_field(item, "url"),
        },
        citation_count: item.get("citationCount").and_then(|v| v.as_i64()),
        language: None,
        source: SOURCE,
    })
}

pub fn venue_from_paper(v: &Value) -> Option<String> {
    let pv = v.get("publicationVenue").and_then(|pv| {
        let is_repo = pv
            .get("type")
            .and_then(|t| t.as_str())
            .is_some_and(|t| t.eq_ignore_ascii_case("repository"));
        if is_repo {
            None
        } else {
            str_field(pv, "name").filter(|s| is_usable_publication(s))
        }
    });
    let journal = str_field_at(v, "/journal/name").filter(|s| is_usable_publication(s));
    let venue = str_field(v, "venue").filter(|s| is_usable_publication(s));
    better_publication(
        better_publication(pv.as_deref(), journal.as_deref()).as_deref(),
        venue.as_deref(),
    )
}

pub fn is_usable_publication(s: &str) -> bool {
    let t = s.trim();
    if t.is_empty() {
        return false;
    }
    let n = t.to_ascii_lowercase();
    !matches!(
        n.as_str(),
        "arxiv" | "arxiv.org" | "corr" | "biorxiv" | "medrxiv" | "preprint" | "preprints"
    ) && !n.starts_with("arxiv:")
}

pub fn better_publication(primary: Option<&str>, other: Option<&str>) -> Option<String> {
    let a = primary.map(str::trim).filter(|s| is_usable_publication(s));
    let b = other.map(str::trim).filter(|s| is_usable_publication(s));
    match (a, b) {
        (Some(x), Some(y)) => {
            if y.len() > x.len() {
                Some(y.to_string())
            } else {
                Some(x.to_string())
            }
        }
        (Some(x), None) => Some(x.to_string()),
        (None, Some(y)) => Some(y.to_string()),
        _ => None,
    }
}

impl SemanticScholarApi {
    /// Fetch the published venue for a paper via S2 `publicationVenue`/`journal`.
    /// `paper_id` may be a bare S2 id, `DOI:...`, or `ARXIV:...`.
    pub async fn fetch_venue(&self, paper_id: &str) -> Option<String> {
        let (prefix, rest) = paper_id.split_once(':').unwrap_or(("", paper_id));
        let url = if prefix.is_empty() {
            format!(
                "{API_BASE}/paper/{}?fields=venue,publicationVenue,journal",
                urlencoding::encode(paper_id)
            )
        } else {
            format!(
                "{API_BASE}/paper/{}:{}?fields=venue,publicationVenue,journal",
                prefix,
                urlencoding::encode(rest)
            )
        };
        match client::get_json(&url).await {
            Ok(value) => venue_from_paper(&value),
            Err(e) => {
                log::debug!(
                    target: "agentero::lookup",
                    "s2 venue lookup for {paper_id} failed: {e}"
                );
                None
            }
        }
    }

    /// Convenience wrapper for an arXiv id.
    pub async fn fetch_venue_by_arxiv(&self, arxiv_id: &str) -> Option<String> {
        let bare = strip_arxiv_version(arxiv_id);
        self.fetch_venue(&format!("ARXIV:{bare}")).await
    }

    /// Convenience wrapper for a DOI, skipping arXiv-issued DOIs.
    pub async fn fetch_venue_by_doi(&self, doi: &str) -> Option<String> {
        let doi = doi.trim();
        if doi.is_empty() || is_arxiv_doi(doi) {
            return None;
        }
        self.fetch_venue(&format!("DOI:{doi}")).await
    }

    /// Try arXiv first, then DOI.
    pub async fn fetch_venue_by_ids(
        &self,
        arxiv_id: Option<&str>,
        doi: Option<&str>,
    ) -> Option<String> {
        if let Some(id) = arxiv_id.map(str::trim).filter(|s| !s.is_empty()) {
            if let Some(venue) = self.fetch_venue_by_arxiv(id).await {
                return Some(venue);
            }
        }
        if let Some(doi) = doi.map(str::trim).filter(|s| !s.is_empty()) {
            return self.fetch_venue_by_doi(doi).await;
        }
        None
    }
}

fn is_arxiv_doi(doi: &str) -> bool {
    doi.to_ascii_lowercase().contains("10.48550/arxiv.")
}

fn strip_arxiv_version(id: &str) -> String {
    let id = id
        .trim()
        .trim_start_matches("arXiv:")
        .trim_start_matches("arxiv:");
    if let Some(i) = id.rfind('v') {
        if id[i + 1..].chars().all(|c| c.is_ascii_digit()) && i > 0 {
            return id[..i].to_string();
        }
    }
    id.to_string()
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn str_field_at(v: &Value, pointer: &str) -> Option<String> {
    v.pointer(pointer)
        .and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn venue_prefers_publication_venue_name() {
        let paper = json!({
            "venue": "NeurIPS",
            "publicationVenue": {
                "name": "Neural Information Processing Systems",
                "type": "conference"
            }
        });
        assert_eq!(
            venue_from_paper(&paper).as_deref(),
            Some("Neural Information Processing Systems")
        );
    }

    #[test]
    fn venue_skips_repository() {
        let paper = json!({
            "venue": "arXiv",
            "publicationVenue": {
                "name": "arXiv.org",
                "type": "repository"
            },
            "journal": { "name": "Nature" }
        });
        assert_eq!(venue_from_paper(&paper).as_deref(), Some("Nature"));
    }
}
