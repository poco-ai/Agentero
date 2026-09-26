//! Shared HTTP plumbing for `scholar_api` sources.
//!
//! Centralizes timeout, User-Agent, proxy, request concurrency, and error
//! wrapping so that individual sources only need to build URLs and parse
//! responses.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::error::AppError;
use crate::features::scholar_api::ApiError;

/// Default timeout for one metadata HTTP request.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(20);

/// Default timeout for slower endpoints (PDF URL probes, translation-server import).
pub const LONG_TIMEOUT: Duration = Duration::from_secs(60);

/// Product User-Agent sent by all `scholar_api` clients.
pub const USER_AGENT: &str = concat!(
    "Agentero/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/poco-ai/agentero; mailto:agentero@users.noreply.github.com)"
);

/// Global concurrency limit across all `scholar_api` HTTP calls. Keeps polite
/// pools happy (Semantic Scholar free tier, arXiv Atom, Crossref).
const GLOBAL_CONCURRENCY: usize = 4;

/// Semantic Scholar API host that `auth_headers` gates on.
const S2_API_HOST_PREFIX: &str = "https://api.semanticscholar.org/";

/// Optional BYOK credential read from the environment at request time.
/// Empty/whitespace values are ignored so the unauthenticated free tier stays
/// the default.
fn env_credential(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// `x-api-key` header value for Semantic Scholar (free key from
/// semanticscholar.org/product/api; raises the shared-pool rate limit).
/// Pure so the header shape is unit-testable without touching the environment.
fn s2_key_header(key: Option<&str>) -> Option<(&'static str, String)> {
    let key = key?.trim();
    (!key.is_empty()).then(|| ("x-api-key", key.to_string()))
}

/// Extra request headers derived from `url` and BYOK environment variables.
fn auth_headers(url: &str) -> Vec<(&'static str, String)> {
    let mut headers = Vec::new();
    if url.starts_with(S2_API_HOST_PREFIX) {
        if let Some(header) = s2_key_header(env_credential("SEMANTIC_SCHOLAR_API_KEY").as_deref()) {
            headers.push(header);
        }
    }
    headers
}

fn global_limiter() -> &'static Arc<Semaphore> {
    static LIMITER: OnceLock<Arc<Semaphore>> = OnceLock::new();
    LIMITER.get_or_init(|| Arc::new(Semaphore::new(GLOBAL_CONCURRENCY)))
}

async fn acquire_permit() -> OwnedSemaphorePermit {
    global_limiter()
        .clone()
        .acquire_owned()
        .await
        .expect("scholar_api limiter should not be closed")
}

fn http_client(timeout: Duration) -> Result<reqwest::Client, ApiError> {
    crate::http::client_with(timeout, crate::http::DEFAULT_REDIRECT_LIMIT, USER_AGENT)
        .map_err(|e| ApiError::Network(e.to_string()))
}

/// Fetch `url` and return the raw response body as text.
///
/// Returns `ApiError::Network` on transport failures and `ApiError::Parse`
/// on non-2xx status codes.
pub async fn get_text(url: &str) -> Result<String, ApiError> {
    get_text_with_timeout(url, DEFAULT_TIMEOUT).await
}

pub async fn get_text_with_timeout(url: &str, timeout: Duration) -> Result<String, ApiError> {
    let _permit = acquire_permit().await;
    let client = http_client(timeout)?;
    let mut request = client.get(url);
    for (name, value) in auth_headers(url) {
        request = request.header(name, value);
    }
    let res = request
        .send()
        .await
        .map_err(|e| ApiError::Network(e.to_string()))?;
    handle_response(res).await
}

/// Fetch `url` and parse the response as JSON.
pub async fn get_json(url: &str) -> Result<Value, ApiError> {
    get_json_with_timeout(url, DEFAULT_TIMEOUT).await
}

pub async fn get_json_with_timeout(url: &str, timeout: Duration) -> Result<Value, ApiError> {
    let text = get_text_with_timeout(url, timeout).await?;
    serde_json::from_str(&text).map_err(|e| ApiError::Parse(format!("json: {e}")))
}

pub async fn post_text_json_with_timeout(
    url: &str,
    body: String,
    timeout: Duration,
) -> Result<Value, ApiError> {
    let _permit = acquire_permit().await;
    let client = http_client(timeout)?;
    let mut request = client
        .post(url)
        .header("Content-Type", "text/plain")
        .body(body);
    for (name, value) in auth_headers(url) {
        request = request.header(name, value);
    }
    let res = request
        .send()
        .await
        .map_err(|e| ApiError::Network(e.to_string()))?;
    let text = handle_response(res).await?;
    serde_json::from_str(&text).map_err(|e| ApiError::Parse(format!("json: {e}")))
}

pub async fn post_json_with_timeout(
    url: &str,
    body: Value,
    timeout: Duration,
) -> Result<Value, ApiError> {
    let _permit = acquire_permit().await;
    let client = http_client(timeout)?;
    let mut request = client
        .post(url)
        .header("Content-Type", "application/json")
        .json(&body);
    for (name, value) in auth_headers(url) {
        request = request.header(name, value);
    }
    let res = request
        .send()
        .await
        .map_err(|e| ApiError::Network(e.to_string()))?;
    let text = handle_response(res).await?;
    serde_json::from_str(&text).map_err(|e| ApiError::Parse(format!("json: {e}")))
}

async fn handle_response(res: reqwest::Response) -> Result<String, ApiError> {
    let status = res.status();
    if status == 429 {
        return Err(ApiError::RateLimited);
    }
    if status.as_u16() == 404 {
        return Err(ApiError::NotFound);
    }
    let text = res
        .text()
        .await
        .map_err(|e| ApiError::Network(format!("read body: {e}")))?;
    if !status.is_success() {
        let snippet: String = text.chars().take(180).collect();
        return Err(ApiError::Network(format!("HTTP {status}: {snippet}")));
    }
    Ok(text)
}

/// Wrap a cancellation check so callers can short-circuit long-running work.
pub fn check_cancelled(task_id: Option<&str>) -> Result<(), ApiError> {
    if let Some(id) = task_id {
        if crate::cancel::is_cancelled(id) {
            return Err(ApiError::Cancelled);
        }
    }
    Ok(())
}

impl From<AppError> for ApiError {
    fn from(value: AppError) -> Self {
        ApiError::Other(value.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn s2_key_header_ignores_missing_or_blank_key() {
        assert_eq!(s2_key_header(None), None);
        assert_eq!(s2_key_header(Some("   ")), None);
    }

    #[test]
    fn s2_key_header_builds_header_from_trimmed_key() {
        assert_eq!(
            s2_key_header(Some(" abcd1234 ")),
            Some(("x-api-key", "abcd1234".to_string()))
        );
    }

    #[test]
    fn auth_headers_skips_non_semantic_scholar_urls() {
        // Only Semantic Scholar requests carry a BYOK header; other sources
        // authenticate via query parameters owned by their source modules.
        assert!(auth_headers("https://api.openalex.org/works?search=x").is_empty());
        assert!(
            auth_headers("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi").is_empty()
        );
    }
}
