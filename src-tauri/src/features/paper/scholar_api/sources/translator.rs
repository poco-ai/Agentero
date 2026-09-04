//! Translator Runtime source (Zotero translation-server).

use async_trait::async_trait;
use serde_json::Value;

use crate::features::scholar_api::client;
use crate::features::scholar_api::traits::{AcademicApi, BibliographySource};
use crate::features::scholar_api::{
    ApiCapability, ApiError, ApiPaper, ApiQuery, PaperIdentifiers, PaperUrls,
};

/// Translator Runtime source.
#[derive(Debug, Clone)]
pub struct TranslatorApi {
    pub base_url: String,
}

impl TranslatorApi {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
        }
    }

    /// POST a prepared body to a Translator endpoint and return the raw Zotero
    /// item(s). This is the primitive used by both metadata lookup and
    /// bibliography import; callers that need `PaperMeta` map the items with
    /// `features::import::map::map_zotero_item`.
    pub async fn fetch_raw_items(
        &self,
        endpoint: &str,
        body: String,
    ) -> Result<Vec<Value>, ApiError> {
        let url = format!(
            "{}/{}",
            self.base_url.trim_end_matches('/'),
            endpoint.trim_start_matches('/')
        );
        let value = client::post_text_json_with_timeout(&url, body, client::LONG_TIMEOUT).await?;

        let arr = if value.is_array() {
            value.as_array().cloned().unwrap_or_default()
        } else if value.is_object() {
            vec![value]
        } else {
            return Err(ApiError::Parse(
                "unexpected translator response shape".to_string(),
            ));
        };

        if arr.is_empty() {
            return Err(ApiError::NotFound);
        }
        Ok(arr)
    }
}

impl Default for TranslatorApi {
    fn default() -> Self {
        Self {
            base_url: "https://translator.philfan.cn".to_string(),
        }
    }
}

#[async_trait]
impl AcademicApi for TranslatorApi {
    fn name(&self) -> &'static str {
        "translator"
    }

    fn capabilities(&self) -> ApiCapability {
        ApiCapability::SEARCH_BY_TITLE
            | ApiCapability::FETCH_BY_DOI
            | ApiCapability::FETCH_BY_ARXIV
            | ApiCapability::FETCH_BY_ISBN
            | ApiCapability::FETCH_BY_PMID
            | ApiCapability::FETCH_BY_URL
            | ApiCapability::PROVIDE_ABSTRACT
            | ApiCapability::PROVIDE_VENUE
    }

    async fn fetch(&self, query: &ApiQuery) -> Result<Vec<ApiPaper>, ApiError> {
        let (endpoint, body) = match query {
            ApiQuery::Title(t) => ("search", t.clone()),
            ApiQuery::Doi(d) => ("search", d.clone()),
            ApiQuery::ArxivId(id) => ("web", format!("https://arxiv.org/abs/{id}")),
            ApiQuery::Url(u) => ("web", u.clone()),
            ApiQuery::Isbn(i) => ("search", i.clone()),
            ApiQuery::Pmid(p) => ("search", p.clone()),
        };
        let items = self.fetch_raw_items(endpoint, body).await?;
        Ok(items.iter().filter_map(map_zotero_item).collect())
    }
}

#[async_trait]
impl BibliographySource for TranslatorApi {
    fn name(&self) -> &'static str {
        "translator"
    }

    async fn import_items(&self, content: &str) -> Result<Vec<Value>, ApiError> {
        self.fetch_raw_items("import", content.to_string()).await
    }

    async fn export_items(&self, _items: &[Value], _format: &str) -> Result<String, ApiError> {
        // Not yet needed by any caller; keep the trait implementation complete.
        Err(ApiError::UnsupportedQuery(ApiQuery::Title(
            "translator export is not implemented".to_string(),
        )))
    }
}

fn map_zotero_item(item: &Value) -> Option<ApiPaper> {
    let title = item
        .get("title")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .to_string();

    let authors: Vec<String> = item
        .get("creators")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|c| {
                    let ctype = c
                        .get("creatorType")
                        .and_then(|v| v.as_str())
                        .unwrap_or("author");
                    if ctype != "author" && ctype != "editor" {
                        return None;
                    }
                    if let Some(name) = c.get("name").and_then(|v| v.as_str()) {
                        let n = name.trim().to_string();
                        return if n.is_empty() { None } else { Some(n) };
                    }
                    let first = c
                        .get("firstName")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim();
                    let last = c
                        .get("lastName")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim();
                    let n = format!("{first} {last}").trim().to_string();
                    if n.is_empty() {
                        None
                    } else {
                        Some(n)
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    let date = item
        .get("date")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let year = date.as_ref().and_then(|d| {
        d.chars()
            .take(4)
            .collect::<String>()
            .parse::<i32>()
            .ok()
            .filter(|&y| (1000..=2100).contains(&y))
    });

    let doi = str_field(item, "DOI").or_else(|| str_field(item, "doi"));
    let isbn = str_field(item, "ISBN");
    let pmid = item
        .get("PMID")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let extra = str_field(item, "extra");
    let url = str_field(item, "url");

    let arxiv_id = extract_arxiv_from_extra(extra.as_deref())
        .or_else(|| normalize_arxiv_field(str_field(item, "archiveID").as_deref()))
        .or_else(|| normalize_arxiv_field(str_field(item, "archiveLocation").as_deref()))
        .or_else(|| url.as_deref().and_then(extract_arxiv_from_url))
        .or_else(|| doi.as_deref().and_then(extract_arxiv_from_doi));

    let publication = str_field(item, "publicationTitle")
        .or_else(|| str_field(item, "proceedingsTitle"))
        .or_else(|| str_field(item, "bookTitle"));

    let mut pdf_url = None;
    if let Some(atts) = item.get("attachments").and_then(|v| v.as_array()) {
        for a in atts {
            let mime = a.get("mimeType").and_then(|v| v.as_str()).unwrap_or("");
            let aurl = a.get("url").and_then(|v| v.as_str()).unwrap_or("");
            if (mime.contains("pdf") || aurl.contains(".pdf") || aurl.contains("/pdf/"))
                && !aurl.is_empty()
            {
                pdf_url = Some(aurl.to_string());
                break;
            }
        }
    }
    if pdf_url.is_none() {
        if let Some(ref u) = url {
            if u.contains("/pdf/") || u.ends_with(".pdf") {
                pdf_url = Some(u.clone());
            }
        }
    }

    let html_url = url.clone().filter(|u| pdf_url.as_ref() != Some(u));
    let landing = url;

    Some(ApiPaper {
        identifiers: PaperIdentifiers {
            doi,
            arxiv_id,
            isbn,
            pmid,
        },
        title,
        authors,
        year,
        date,
        venue: publication,
        volume: str_field(item, "volume"),
        issue: str_field(item, "issue"),
        pages: str_field(item, "pages"),
        publisher: str_field(item, "publisher"),
        abstract_text: str_field(item, "abstractNote"),
        urls: PaperUrls {
            pdf: pdf_url,
            html: html_url,
            landing,
        },
        citation_count: None,
        language: str_field(item, "language"),
        source: "translator",
    })
}

fn str_field(item: &Value, key: &str) -> Option<String> {
    item.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn normalize_arxiv_field(s: Option<&str>) -> Option<String> {
    let s = s?;
    let s = s
        .trim()
        .trim_start_matches("arXiv:")
        .trim_start_matches("arxiv:");
    if s.is_empty() {
        return None;
    }
    Some(strip_arxiv_version(s).to_string())
}

fn strip_arxiv_version(id: &str) -> String {
    if let Some(i) = id.rfind('v') {
        if id[i + 1..].chars().all(|c| c.is_ascii_digit()) && i > 0 {
            return id[..i].to_string();
        }
    }
    id.to_string()
}

fn extract_arxiv_from_url(url: &str) -> Option<String> {
    let lower = url.to_ascii_lowercase();
    if lower.contains("arxiv.org/abs/") {
        let rest = lower.split("arxiv.org/abs/").nth(1)?;
        let id = rest.split(&['/', '?', '#'][..]).next()?;
        return Some(strip_arxiv_version(id).to_string());
    }
    if lower.contains("arxiv.org/pdf/") {
        let rest = lower.split("arxiv.org/pdf/").nth(1)?;
        let id = rest.split(&['/', '?', '#'][..]).next()?;
        return Some(strip_arxiv_version(id).to_string());
    }
    None
}

fn extract_arxiv_from_doi(doi: &str) -> Option<String> {
    let lower = doi.to_ascii_lowercase();
    lower
        .strip_prefix("10.48550/arxiv.")
        .map(|s| strip_arxiv_version(s).to_string())
}

fn extract_arxiv_from_extra(extra: Option<&str>) -> Option<String> {
    let extra = extra?;
    for line in extra.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("arXiv:") {
            let token = rest.split_whitespace().next()?.trim();
            return Some(strip_arxiv_version(token).to_string());
        }
        if line.to_ascii_lowercase().starts_with("arxiv:") {
            let token = line.split_once(':')?.1.split_whitespace().next()?.trim();
            return Some(strip_arxiv_version(token).to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_zotero_journal_article() {
        let item = json!({
            "title": "Attention Is All You Need",
            "creators": [
                { "creatorType": "author", "firstName": "Ashish", "lastName": "Vaswani" }
            ],
            "date": "2017",
            "DOI": "10.48550/arXiv.1706.03762",
            "publicationTitle": "NeurIPS",
            "volume": "30",
            "pages": "5998-6008",
            "abstractNote": "The dominant sequence transduction models.",
            "language": "en"
        });
        let paper = map_zotero_item(&item).expect("mapped");
        assert_eq!(paper.title, "Attention Is All You Need");
        assert_eq!(
            paper.identifiers.doi.as_deref(),
            Some("10.48550/arXiv.1706.03762")
        );
        assert_eq!(paper.identifiers.arxiv_id.as_deref(), Some("1706.03762"));
        assert_eq!(paper.year, Some(2017));
        assert_eq!(paper.venue.as_deref(), Some("NeurIPS"));
        assert_eq!(paper.authors, vec!["Ashish Vaswani"]);
    }

    #[test]
    fn extracts_arxiv_from_extra() {
        let item = json!({
            "title": "A Paper",
            "extra": "arXiv:2101.00001v2\nsome other line",
        });
        let paper = map_zotero_item(&item).expect("mapped");
        assert_eq!(paper.identifiers.arxiv_id.as_deref(), Some("2101.00001"));
    }
}
