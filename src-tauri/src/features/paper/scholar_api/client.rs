//! Shared HTTP plumbing for `scholar_api` sources.
//!
//! Centralizes timeout, User-Agent, proxy, request concurrency, and error
//! wrapping so that individual sources only need to build URLs and parse
//! responses.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::core::error::AppError;
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
    crate::core::http::client_with(
        timeout,
        crate::core::http::DEFAULT_REDIRECT_LIMIT,
        USER_AGENT,
    )
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
    let res = client
        .get(url)
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

/// POST `body` as plain text to `url` and parse the response as JSON.
pub async fn post_text_json(url: &str, body: String) -> Result<Value, ApiError> {
    post_text_json_with_timeout(url, body, DEFAULT_TIMEOUT).await
}

pub async fn post_text_json_with_timeout(
    url: &str,
    body: String,
    timeout: Duration,
) -> Result<Value, ApiError> {
    let _permit = acquire_permit().await;
    let client = http_client(timeout)?;
    let res = client
        .post(url)
        .header("Content-Type", "text/plain")
        .body(body)
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
        if crate::core::background_tasks::is_cancelled(id) {
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
