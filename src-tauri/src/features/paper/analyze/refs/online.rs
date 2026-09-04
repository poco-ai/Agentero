//! Online reference lookup: Semantic Scholar Graph API first, Crossref fallback.
//! Free endpoints only; failures degrade silently to local parsing.

use super::latex;
use super::RefDraft;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const CROSSREF_MAILTO: &str = "agentero@users.noreply.github.com";
const ONLINE_REFERENCE_CONCURRENCY: usize = 2;

fn online_reference_limiter() -> &'static Arc<Semaphore> {
    static LIMITER: OnceLock<Arc<Semaphore>> = OnceLock::new();
    LIMITER.get_or_init(|| Arc::new(Semaphore::new(ONLINE_REFERENCE_CONCURRENCY)))
}

async fn acquire_online_reference_permit() -> OwnedSemaphorePermit {
    online_reference_limiter()
        .clone()
        .acquire_owned()
        .await
        .expect("online reference limiter should not be closed")
}

pub struct OnlineOutcome {
    pub refs: Vec<RefDraft>,
    /// `"s2"` or `"crossref"` when any provider returned entries.
    pub provider: Option<&'static str>,
    pub messages: Vec<String>,
}

/// Fetch structured references for a paper by arXiv id / DOI.
pub async fn fetch_references(doi: Option<&str>, arxiv_id: Option<&str>) -> OnlineOutcome {
    let mut messages = Vec::new();
    let ext_id = arxiv_id
        .map(|a| format!("arXiv:{}", latex::strip_arxiv_version(a)))
        .or_else(|| doi.map(|d| format!("DOI:{}", d.trim())));
    if let Some(ext_id) = ext_id {
        match s2_references(&ext_id).await {
            Ok(refs) if !refs.is_empty() => {
                messages.push(format!("semantic scholar: {} references", refs.len()));
                return OnlineOutcome {
                    refs,
                    provider: Some("s2"),
                    messages,
                };
            }
            Ok(_) => messages.push("semantic scholar: no references".to_string()),
            Err(e) => messages.push(format!("semantic scholar failed: {e}")),
        }
    }
    if let Some(doi) = doi.filter(|d| !d.trim().is_empty()) {
        match crossref_references(doi).await {
            Ok(refs) if !refs.is_empty() => {
                messages.push(format!("crossref: {} references", refs.len()));
                return OnlineOutcome {
                    refs,
                    provider: Some("crossref"),
                    messages,
                };
            }
            Ok(_) => messages.push("crossref: no references".to_string()),
            Err(e) => messages.push(format!("crossref failed: {e}")),
        }
    }
    OnlineOutcome {
        refs: Vec::new(),
        provider: None,
        messages,
    }
}

fn http_client() -> Result<reqwest::Client, String> {
    crate::core::http::client(Duration::from_secs(20)).map_err(|e| e.to_string())
}

async fn get_json(url: &str) -> Result<serde_json::Value, String> {
    let _permit = acquire_online_reference_permit().await;
    let client = http_client()?;
    let res = client
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("request: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        return Err(format!("http {status}"));
    }
    let text = res.text().await.map_err(|e| format!("body: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("json: {e}"))
}

/// `GET /graph/v1/paper/{id}/references` — `id` is `arXiv:…` or `DOI:…`.
async fn s2_references(ext_id: &str) -> Result<Vec<RefDraft>, String> {
    let url = format!(
        "https://api.semanticscholar.org/graph/v1/paper/{}/references?fields=title,authors,year,venue,externalIds,url&limit=1000",
        urlencoding::encode(ext_id)
    );
    let value = get_json(&url).await?;
    let mut out = Vec::new();
    let Some(items) = value.get("data").and_then(|v| v.as_array()) else {
        return Ok(out);
    };
    for item in items {
        let Some(cp) = item.get("citedPaper") else {
            continue;
        };
        let title = str_field(cp, "title");
        let doi = cp
            .pointer("/externalIds/DOI")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let arxiv_id = cp
            .pointer("/externalIds/ArXiv")
            .and_then(|v| v.as_str())
            .map(|s| latex::strip_arxiv_version(s).to_string())
            .filter(|s| !s.is_empty());
        if title.is_none() && doi.is_none() && arxiv_id.is_none() {
            continue;
        }
        let authors = cp
            .get("authors")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|a| a.get("name").and_then(|n| n.as_str()))
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        out.push(RefDraft {
            key: None,
            raw: None,
            title,
            authors,
            year: cp.get("year").and_then(|v| v.as_i64()).map(|y| y as i32),
            venue: str_field(cp, "venue"),
            doi,
            arxiv_id,
            url: str_field(cp, "url"),
            source: "s2",
        });
    }
    Ok(out)
}

/// `GET https://api.crossref.org/works/{doi}` → `message.reference[]`.
async fn crossref_references(doi: &str) -> Result<Vec<RefDraft>, String> {
    let url = format!(
        "https://api.crossref.org/works/{}?mailto={CROSSREF_MAILTO}",
        urlencoding::encode(doi.trim())
    );
    let value = get_json(&url).await?;
    let mut out = Vec::new();
    let Some(items) = value
        .pointer("/message/reference")
        .and_then(|v| v.as_array())
    else {
        return Ok(out);
    };
    for item in items {
        let title = str_field(item, "article-title").or_else(|| str_field(item, "volume-title"));
        let doi = str_field(item, "DOI");
        let raw = str_field(item, "unstructured");
        if title.is_none() && doi.is_none() && raw.is_none() {
            continue;
        }
        let year = str_field(item, "year").and_then(|y| y.trim().parse::<i32>().ok());
        out.push(RefDraft {
            key: str_field(item, "key"),
            raw,
            title,
            authors: str_field(item, "author")
                .map(|a| vec![a])
                .unwrap_or_default(),
            year,
            venue: str_field(item, "journal-title"),
            doi,
            arxiv_id: None,
            url: None,
            source: "crossref",
        });
    }
    Ok(out)
}

fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}
