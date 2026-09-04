//! arXiv Atom API source.

use async_trait::async_trait;

use crate::scholar_api::client;
use crate::scholar_api::traits::AcademicApi;
use crate::scholar_api::{
    ApiCapability, ApiError, ApiPaper, ApiQuery, PaperIdentifiers, PaperUrls,
};

const SOURCE: &str = "arxiv";
const API_BASE: &str = "https://export.arxiv.org/api/query";

/// arXiv metadata source.
#[derive(Debug, Clone, Default)]
pub struct ArxivApi;

#[async_trait]
impl AcademicApi for ArxivApi {
    fn name(&self) -> &'static str {
        SOURCE
    }

    fn capabilities(&self) -> ApiCapability {
        ApiCapability::SEARCH_BY_TITLE
            | ApiCapability::FETCH_BY_ARXIV
            | ApiCapability::PROVIDE_ABSTRACT
            | ApiCapability::PROVIDE_VENUE
    }

    async fn fetch(&self, query: &ApiQuery) -> Result<Vec<ApiPaper>, ApiError> {
        match query {
            ApiQuery::ArxivId(id) => fetch_by_id(id).await.map(|p| vec![p]),
            ApiQuery::Title(title) => search_by_title(title, 5).await,
            _ => Err(ApiError::UnsupportedQuery(query.clone())),
        }
    }
}

async fn fetch_by_id(id: &str) -> Result<ApiPaper, ApiError> {
    let bare = strip_arxiv_version(id);
    let url = format!("{API_BASE}?id_list={}", urlencoding::encode(&bare));
    let xml = client::get_text(&url).await?;
    parse_entries(&xml, 1)
        .into_iter()
        .next()
        .ok_or(ApiError::NotFound)
}

async fn search_by_title(title: &str, limit: usize) -> Result<Vec<ApiPaper>, ApiError> {
    let phrase = title.replace('"', " ");
    let url = format!(
        "{API_BASE}?search_query={}&start=0&max_results={}&sortBy=relevance",
        urlencoding::encode(&format!("ti:\"{}\"", phrase.trim())),
        (limit * 2).min(50)
    );
    let xml = client::get_text(&url).await?;
    Ok(parse_entries(&xml, limit))
}

fn parse_entries(xml: &str, limit: usize) -> Vec<ApiPaper> {
    let mut out = Vec::new();
    for entry in xml.split("<entry>").skip(1) {
        let entry = entry.split("</entry>").next().unwrap_or(entry);
        let Some(title) = tag_text(entry, "title") else {
            continue;
        };
        let Some(arxiv_id) = tag_text(entry, "id")
            .and_then(|id| id.rsplit('/').next().map(str::to_string))
            .map(|id| strip_arxiv_version(&id))
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        let authors: Vec<String> = entry
            .split("<author>")
            .skip(1)
            .filter_map(|a| tag_text(a, "name"))
            .collect();
        let year = tag_text(entry, "published")
            .and_then(|d| d.get(..4).and_then(|y| y.parse::<i32>().ok()));
        let bare = arxiv_id.clone();
        out.push(ApiPaper {
            identifiers: PaperIdentifiers {
                doi: tag_text(entry, "arxiv:doi"),
                arxiv_id: Some(arxiv_id),
                isbn: None,
                pmid: None,
            },
            title,
            authors,
            year,
            date: tag_text(entry, "published"),
            venue: tag_text(entry, "arxiv:journal_ref"),
            volume: None,
            issue: None,
            pages: None,
            publisher: None,
            abstract_text: tag_text(entry, "summary"),
            urls: PaperUrls {
                pdf: Some(format!("https://arxiv.org/pdf/{bare}")),
                html: Some(format!("https://arxiv.org/html/{bare}")),
                landing: Some(format!("https://arxiv.org/abs/{bare}")),
            },
            citation_count: None,
            language: None,
            source: SOURCE,
        });
        if out.len() >= limit {
            break;
        }
    }
    out
}

/// First `<tag>…</tag>` in `xml`, whitespace collapsed.
fn tag_text(xml: &str, tag: &str) -> Option<String> {
    let body = xml
        .split(&format!("<{tag}>"))
        .nth(1)?
        .split(&format!("</{tag}>"))
        .next()?;
    let text = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// Bare arXiv id without version suffix (`v1`, `v2`, …).
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_arxiv_version_and_prefix() {
        assert_eq!(strip_arxiv_version("1706.03762"), "1706.03762");
        assert_eq!(strip_arxiv_version("1706.03762v7"), "1706.03762");
        assert_eq!(strip_arxiv_version("arXiv:1706.03762v2"), "1706.03762");
    }

    #[test]
    fn parses_atom_entry() {
        let xml = r#"<feed>
            <entry>
                <id>http://arxiv.org/abs/1706.03762v7</id>
                <published>2017-06-12T17:57:34Z</published>
                <title>Attention Is All
  You Need</title>
                <summary>The dominant sequence transduction models.</summary>
                <author><name>Ashish Vaswani</name></author>
                <author><name>Noam Shazeer</name></author>
                <arxiv:journal_ref>NeurIPS 2017</arxiv:journal_ref>
                <arxiv:doi>10.48550/arXiv.1706.03762</arxiv:doi>
            </entry>
        </feed>"#;
        let papers = parse_entries(xml, 1);
        assert_eq!(papers.len(), 1);
        let p = &papers[0];
        assert_eq!(p.title, "Attention Is All You Need");
        assert_eq!(p.identifiers.arxiv_id.as_deref(), Some("1706.03762"));
        assert_eq!(p.year, Some(2017));
        assert_eq!(p.venue.as_deref(), Some("NeurIPS 2017"));
        assert_eq!(
            p.abstract_text.as_deref(),
            Some("The dominant sequence transduction models.")
        );
        assert_eq!(p.authors.len(), 2);
        assert!(p.urls.pdf.as_deref().unwrap().contains("/pdf/1706.03762"));
    }
}
