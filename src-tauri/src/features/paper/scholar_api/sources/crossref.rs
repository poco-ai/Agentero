//! Crossref REST API source.

use async_trait::async_trait;
use serde_json::Value;

use crate::features::scholar_api::client;
use crate::features::scholar_api::traits::AcademicApi;
use crate::features::scholar_api::{
    ApiCapability, ApiError, ApiPaper, ApiQuery, PaperIdentifiers, PaperUrls,
};

const SOURCE: &str = "crossref";
const API_BASE: &str = "https://api.crossref.org/works";

/// Crossref metadata source.
#[derive(Debug, Clone, Default)]
pub struct CrossrefApi;

#[async_trait]
impl AcademicApi for CrossrefApi {
    fn name(&self) -> &'static str {
        SOURCE
    }

    fn capabilities(&self) -> ApiCapability {
        ApiCapability::SEARCH_BY_TITLE
            | ApiCapability::FETCH_BY_DOI
            | ApiCapability::PROVIDE_ABSTRACT
            | ApiCapability::PROVIDE_VENUE
    }

    async fn fetch(&self, query: &ApiQuery) -> Result<Vec<ApiPaper>, ApiError> {
        match query {
            ApiQuery::Doi(doi) => fetch_by_doi(doi).await.map(|p| vec![p]),
            ApiQuery::Title(title) => search_by_title(title, 5).await,
            _ => Err(ApiError::UnsupportedQuery(query.clone())),
        }
    }
}

async fn fetch_by_doi(doi: &str) -> Result<ApiPaper, ApiError> {
    let url = format!("{API_BASE}/{}", urlencoding::encode(doi.trim()));
    let value = client::get_json(&url).await?;
    let message = value.pointer("/message").unwrap_or(&Value::Null);
    map_work(message, Some(doi.trim())).ok_or(ApiError::NotFound)
}

async fn search_by_title(title: &str, limit: usize) -> Result<Vec<ApiPaper>, ApiError> {
    let url = format!(
        "{API_BASE}?query.title={}&rows={}&select=title,author,published-print,published-online,container-title,volume,issue,page,DOI,publisher,URL,type,abstract",
        urlencoding::encode(title),
        limit
    );
    let value = client::get_json(&url).await?;
    let Some(items) = value.pointer("/message/items").and_then(|v| v.as_array()) else {
        return Ok(Vec::new());
    };

    let mut out = Vec::new();
    for item in items {
        if let Some(paper) = map_work(item, None) {
            out.push(paper);
        }
    }
    Ok(out)
}

fn map_work(message: &Value, known_doi: Option<&str>) -> Option<ApiPaper> {
    let title = message
        .get("title")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .and_then(|v| v.as_str())
        .map(collapse_ws)
        .filter(|s| !s.is_empty())?;

    let doi = known_doi
        .map(str::to_string)
        .or_else(|| str_field(message, "DOI"))?;

    let mut authors = Vec::new();
    if let Some(arr) = message.get("author").and_then(|v| v.as_array()) {
        for a in arr {
            if let Some(name) = a.get("name").and_then(|v| v.as_str()) {
                let n = collapse_ws(name);
                if !n.is_empty() {
                    authors.push(n);
                }
                continue;
            }
            let given = a.get("given").and_then(|v| v.as_str()).unwrap_or("");
            let family = a.get("family").and_then(|v| v.as_str()).unwrap_or("");
            let n = format!("{given} {family}").trim().to_string();
            if !n.is_empty() {
                authors.push(n);
            }
        }
    }

    let date = message
        .pointer("/issued/date-parts/0/0")
        .and_then(|v| v.as_i64())
        .map(|y| y.to_string());
    let year = date.as_ref().and_then(|d| d.parse::<i32>().ok());

    // Crossref abstracts are JATS XML; strip tags so downstream text stays plain.
    let abstract_text = str_or_first(message, "abstract").map(|s| {
        let mut plain = String::with_capacity(s.len());
        let mut in_tag = false;
        for c in s.chars() {
            match c {
                '<' => in_tag = true,
                '>' => in_tag = false,
                _ if !in_tag => plain.push(c),
                _ => {}
            }
        }
        collapse_ws(&plain)
    });

    Some(ApiPaper {
        identifiers: PaperIdentifiers {
            doi: Some(doi.clone()),
            arxiv_id: None,
            isbn: None,
            pmid: None,
        },
        title,
        authors,
        year,
        date,
        venue: str_or_first(message, "container-title"),
        volume: str_field(message, "volume"),
        issue: str_field(message, "issue"),
        pages: str_field(message, "page"),
        publisher: str_or_first(message, "publisher"),
        abstract_text,
        urls: PaperUrls {
            pdf: None,
            html: Some(format!("https://doi.org/{doi}")),
            landing: Some(format!("https://doi.org/{doi}")),
        },
        citation_count: None,
        language: str_or_first(message, "language"),
        source: SOURCE,
    })
}

fn str_field(message: &Value, key: &str) -> Option<String> {
    message
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn str_or_first(message: &Value, key: &str) -> Option<String> {
    let v = message.get(key)?;
    let s = match v {
        Value::String(s) => Some(s.clone()),
        Value::Array(a) => a.first().and_then(|x| x.as_str()).map(String::from),
        _ => None,
    }?;
    let s = s.trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_crossref_work() {
        let message = json!({
            "title": ["Attention Is All You Need"],
            "author": [
                { "given": "Ashish", "family": "Vaswani" },
                { "given": "Noam", "family": "Shazeer" }
            ],
            "issued": { "date-parts": [[2017]] },
            "DOI": "10.48550/arXiv.1706.03762",
            "container-title": ["NeurIPS"],
            "volume": ["30"],
            "page": ["5998-6008"],
            "publisher": ["NeurIPS"],
            "abstract": "<p>The dominant sequence transduction models.</p>"
        });
        let paper = map_work(&message, None).expect("mapped");
        assert_eq!(paper.title, "Attention Is All You Need");
        assert_eq!(
            paper.identifiers.doi.as_deref(),
            Some("10.48550/arXiv.1706.03762")
        );
        assert_eq!(paper.year, Some(2017));
        assert_eq!(paper.venue.as_deref(), Some("NeurIPS"));
        assert_eq!(
            paper.abstract_text.as_deref(),
            Some("The dominant sequence transduction models.")
        );
        assert_eq!(paper.authors, vec!["Ashish Vaswani", "Noam Shazeer"]);
    }
}
