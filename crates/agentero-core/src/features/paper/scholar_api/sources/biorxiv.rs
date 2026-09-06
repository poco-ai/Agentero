//! bioRxiv and medRxiv metadata source.
//!
//! Both preprint servers share the same public API shape:
//!   `https://api.biorxiv.org/details/{server}/{doi}`
//! where `{server}` is `biorxiv` or `medrxiv`.
//!
//! The API is DOI-centric: it has no title search endpoint, so these sources
//! only implement `FETCH_BY_DOI`.

use async_trait::async_trait;
use serde_json::Value;

use crate::features::scholar_api::client;
use crate::features::scholar_api::traits::AcademicApi;
use crate::features::scholar_api::{
    ApiCapability, ApiError, ApiPaper, ApiQuery, PaperIdentifiers, PaperUrls,
};

const API_BASE: &str = "https://api.biorxiv.org/details";

/// bioRxiv metadata source.
#[derive(Debug, Clone, Default)]
pub struct BiorxivApi;

/// medRxiv metadata source.
#[derive(Debug, Clone, Default)]
pub struct MedrxivApi;

#[async_trait]
impl AcademicApi for BiorxivApi {
    fn name(&self) -> &'static str {
        "biorxiv"
    }

    fn capabilities(&self) -> ApiCapability {
        ApiCapability::FETCH_BY_DOI | ApiCapability::PROVIDE_ABSTRACT
    }

    async fn fetch(&self, query: &ApiQuery) -> Result<Vec<ApiPaper>, ApiError> {
        let ApiQuery::Doi(doi) = query else {
            return Err(ApiError::UnsupportedQuery(query.clone()));
        };
        fetch_detail("biorxiv", doi).await.map(|p| vec![p])
    }
}

#[async_trait]
impl AcademicApi for MedrxivApi {
    fn name(&self) -> &'static str {
        "medrxiv"
    }

    fn capabilities(&self) -> ApiCapability {
        ApiCapability::FETCH_BY_DOI | ApiCapability::PROVIDE_ABSTRACT
    }

    async fn fetch(&self, query: &ApiQuery) -> Result<Vec<ApiPaper>, ApiError> {
        let ApiQuery::Doi(doi) = query else {
            return Err(ApiError::UnsupportedQuery(query.clone()));
        };
        fetch_detail("medrxiv", doi).await.map(|p| vec![p])
    }
}

async fn fetch_detail(server: &str, doi: &str) -> Result<ApiPaper, ApiError> {
    let url = format!("{API_BASE}/{server}/{}", urlencoding::encode(doi.trim()));
    let value = client::get_json(&url).await?;
    let item = value
        .get("collection")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .ok_or(ApiError::NotFound)?;
    map_item(server, item).ok_or(ApiError::NotFound)
}

fn map_item(server: &str, item: &Value) -> Option<ApiPaper> {
    let doi = str_field(item, "doi")?;
    let title = str_field(item, "title")?;
    let version = str_field(item, "version").unwrap_or_default();
    let bare_doi = doi.trim_start_matches("https://doi.org/");

    let authors: Vec<String> = item
        .get("authors")
        .and_then(|v| v.as_str())
        .map(|s| {
            s.split(';')
                .map(|part| part.trim().to_string())
                .filter(|part| !part.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let date = str_field(item, "date");
    let year = date
        .as_ref()
        .and_then(|d| d.get(..4).and_then(|y| y.parse::<i32>().ok()));

    let abstract_text = str_field(item, "abstract");

    let landing = if version.is_empty() {
        format!("https://www.{server}.org/content/{bare_doi}")
    } else {
        format!("https://www.{server}.org/content/{bare_doi}v{version}")
    };
    let pdf = if version.is_empty() {
        format!("{landing}.full.pdf")
    } else {
        format!("{landing}.full.pdf")
    };

    Some(ApiPaper {
        identifiers: PaperIdentifiers {
            doi: Some(doi),
            arxiv_id: None,
            isbn: None,
            pmid: None,
        },
        title,
        authors,
        year,
        date,
        venue: Some(format!("{server} preprint")),
        volume: None,
        issue: None,
        pages: None,
        publisher: Some("Cold Spring Harbor Laboratory".to_string()),
        abstract_text,
        urls: PaperUrls {
            pdf: Some(pdf),
            html: Some(landing.clone()),
            landing: Some(landing),
        },
        citation_count: None,
        language: None,
        source: if server == "medrxiv" {
            "medrxiv"
        } else {
            "biorxiv"
        },
    })
}

fn str_field(item: &Value, key: &str) -> Option<String> {
    item.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_biorxiv_item() {
        let item = json!({
            "doi": "10.1101/2020.01.01.123456",
            "title": "A preprint about gene editing",
            "authors": "Alice One; Bob Two",
            "date": "2020-01-01",
            "version": "1",
            "category": "bioinformatics",
            "abstract": "We present early results.",
            "server": "biorxiv"
        });
        let paper = map_item("biorxiv", &item).expect("mapped");
        assert_eq!(paper.title, "A preprint about gene editing");
        assert_eq!(
            paper.identifiers.doi.as_deref(),
            Some("10.1101/2020.01.01.123456")
        );
        assert_eq!(paper.year, Some(2020));
        assert_eq!(paper.authors, vec!["Alice One", "Bob Two"]);
        assert_eq!(
            paper.abstract_text.as_deref(),
            Some("We present early results.")
        );
        assert_eq!(paper.venue.as_deref(), Some("biorxiv preprint"));
        assert!(paper
            .urls
            .landing
            .as_deref()
            .unwrap()
            .contains("biorxiv.org/content/10.1101/2020.01.01.123456v1"));
        assert!(paper.urls.pdf.as_deref().unwrap().ends_with(".full.pdf"));
    }

    #[test]
    fn maps_medrxiv_item() {
        let item = json!({
            "doi": "10.1101/2021.05.05.21256789",
            "title": "A clinical study",
            "authors": "Carol Three",
            "date": "2021-05-05",
            "version": "2",
            "abstract": "Clinical findings.",
            "server": "medrxiv"
        });
        let paper = map_item("medrxiv", &item).expect("mapped");
        assert_eq!(paper.source, "medrxiv");
        assert!(paper
            .urls
            .landing
            .as_deref()
            .unwrap()
            .contains("medrxiv.org"));
    }

    #[test]
    fn missing_title_returns_none() {
        let item = json!({ "doi": "10.1101/1" });
        assert!(map_item("biorxiv", &item).is_none());
    }
}
