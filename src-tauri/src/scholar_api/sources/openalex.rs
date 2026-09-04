//! OpenAlex API source.

use async_trait::async_trait;
use serde_json::Value;

use crate::scholar_api::client;
use crate::scholar_api::traits::AcademicApi;
use crate::scholar_api::{
    ApiCapability, ApiError, ApiPaper, ApiQuery, PaperIdentifiers, PaperUrls,
};

const SOURCE: &str = "openalex";
const API_BASE: &str = "https://api.openalex.org/works";
const MAILTO: &str = "agentero@users.noreply.github.com";

/// OpenAlex metadata source.
#[derive(Debug, Clone, Default)]
pub struct OpenAlexApi;

#[async_trait]
impl AcademicApi for OpenAlexApi {
    fn name(&self) -> &'static str {
        SOURCE
    }

    fn capabilities(&self) -> ApiCapability {
        ApiCapability::SEARCH_BY_TITLE | ApiCapability::FETCH_BY_DOI | ApiCapability::PROVIDE_VENUE
    }

    async fn fetch(&self, query: &ApiQuery) -> Result<Vec<ApiPaper>, ApiError> {
        match query {
            ApiQuery::Title(title) => search_by_title(title, 5).await,
            ApiQuery::Doi(doi) => fetch_by_doi(doi).await.map(|p| vec![p]),
            _ => Err(ApiError::UnsupportedQuery(query.clone())),
        }
    }
}

async fn fetch_by_doi(doi: &str) -> Result<ApiPaper, ApiError> {
    let url = format!(
        "{API_BASE}/doi:{}?select=title,display_name,publication_year,doi,authorships,primary_location,biblio,id",
        urlencoding::encode(doi.trim())
    );
    let value = client::get_json(&url).await?;
    map_work(&value).ok_or(ApiError::NotFound)
}

async fn search_by_title(title: &str, limit: usize) -> Result<Vec<ApiPaper>, ApiError> {
    let url = format!(
        "{API_BASE}?search={}&per_page={}&select=title,display_name,publication_year,doi,authorships,primary_location,biblio,id&mailto={}",
        urlencoding::encode(title),
        limit,
        MAILTO
    );
    let value = client::get_json(&url).await?;
    let Some(items) = value.get("results").and_then(|v| v.as_array()) else {
        return Ok(Vec::new());
    };

    let mut out = Vec::new();
    for item in items {
        if let Some(paper) = map_work(item) {
            out.push(paper);
        }
    }
    Ok(out)
}

fn map_work(work: &Value) -> Option<ApiPaper> {
    let title = work
        .get("display_name")
        .or_else(|| work.get("title"))
        .and_then(|v| v.as_str())?
        .to_string();

    let authors: Vec<String> = work
        .get("authorships")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|a| {
                    a.get("author")
                        .and_then(|auth| auth.get("display_name"))
                        .and_then(|v| v.as_str())
                })
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();

    let year = work
        .get("publication_year")
        .and_then(|v| v.as_i64())
        .map(|y| y as i32);

    let doi = work
        .get("doi")
        .and_then(|v| v.as_str())
        .map(|s| s.trim_start_matches("https://doi.org/").to_string());

    let venue = work
        .pointer("/primary_location/source/display_name")
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| {
            work.pointer("/biblio/venue")
                .and_then(|v| v.as_str())
                .map(String::from)
        });

    let volume = work
        .pointer("/biblio/volume")
        .and_then(|v| v.as_str())
        .map(String::from);
    let issue = work
        .pointer("/biblio/issue")
        .and_then(|v| v.as_str())
        .map(String::from);
    let pages = work.get("biblio").and_then(pages_from_biblio);

    Some(ApiPaper {
        identifiers: PaperIdentifiers {
            doi,
            arxiv_id: None,
            isbn: None,
            pmid: None,
        },
        title,
        authors,
        year,
        date: year.map(|y| y.to_string()),
        venue,
        volume,
        issue,
        pages,
        publisher: None,
        abstract_text: None,
        urls: PaperUrls::default(),
        citation_count: None,
        language: None,
        source: SOURCE,
    })
}

fn pages_from_biblio(biblio: &Value) -> Option<String> {
    let first = biblio.get("first_page").and_then(|v| v.as_str())?;
    let last = biblio.get("last_page").and_then(|v| v.as_str());
    match last {
        Some(last) if !last.is_empty() && last != first => Some(format!("{first}--{last}")),
        _ => Some(first.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_openalex_work() {
        let work = json!({
            "display_name": "Attention Is All You Need",
            "publication_year": 2017,
            "doi": "https://doi.org/10.48550/arXiv.1706.03762",
            "authorships": [
                { "author": { "display_name": "Ashish Vaswani" } }
            ],
            "primary_location": {
                "source": { "display_name": "Neural Information Processing Systems" }
            },
            "biblio": {
                "volume": "30",
                "first_page": "5998",
                "last_page": "6008"
            }
        });
        let paper = map_work(&work).expect("mapped");
        assert_eq!(paper.title, "Attention Is All You Need");
        assert_eq!(paper.year, Some(2017));
        assert_eq!(
            paper.venue.as_deref(),
            Some("Neural Information Processing Systems")
        );
        assert_eq!(paper.pages.as_deref(), Some("5998--6008"));
    }
}
