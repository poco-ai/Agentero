//! Browser-verification walls (Cloudflare / Turnstile / OpenReview).
//!
//! A growing share of publisher and proceedings pages answer scripted clients
//! with an interactive wall: Cloudflare's `Just a moment…` interstitial, or
//! OpenReview's `ChallengeRequiredError` page. Passing it in a real browser
//! mints a clearance cookie that the same server accepts as a plain cookie
//! header.
//!
//! The Host owns the interactive part: it opens a window on the very URL that
//! was blocked, captures the site cookies once the page loads, validates them
//! with [`probe_cookie`], and hands them back through [`set_site_cookie`]. The
//! download and page-snapshot layers attach those cookies per host and retry
//! once. Non-OpenReview credentials are session-only: clearance cookies are
//! IP- and time-bound, so persisting arbitrary site cookies in `settings.json`
//! would be stale immediately (OpenReview keeps its own durable setting for
//! the Settings status row).

use reqwest::header::{HeaderMap, CONTENT_TYPE};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, RwLock};
use std::time::Duration;

/// Headers/body markers shared by Cloudflare's interstitial and Turnstile.
const CHALLENGE_BODY_MARKERS: &[&str] = &[
    "Just a moment",
    "cf_chl_opt",
    "__cf_chl",
    "/cdn-cgi/challenge-platform",
    "challenges.cloudflare.com",
    "cf-turnstile",
    "ChallengeRequiredError",
    "Verifying your browser",
];
/// Interstitial bodies are tiny; anything larger is real content.
const CHALLENGE_MAX_BODY: usize = 64 * 1024;
/// Prefix read when validating a captured credential.
const PROBE_PREFIX_BYTES: usize = 16 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const PROBE_REDIRECTS: usize = 5;

/// Async host hook: opens the verification window for `url` and resolves to
/// the validated cookie for that host once the user gets past the wall.
type AuthRequester =
    dyn Fn(String) -> Pin<Box<dyn Future<Output = Option<String>> + Send>> + Send + Sync;

static SITE_COOKIES: RwLock<Option<HashMap<String, String>>> = RwLock::new(None);
static AUTH_REQUESTER: RwLock<Option<Arc<AuthRequester>>> = RwLock::new(None);

fn cookie_slot() -> &'static RwLock<Option<HashMap<String, String>>> {
    &SITE_COOKIES
}

fn site_host(url: &str) -> Option<String> {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_ascii_lowercase))
}

/// True when `host` owns `stored` (same host or a parent domain of it).
fn host_matches(host: &str, stored: &str) -> bool {
    host == stored || host.ends_with(&format!(".{stored}"))
}

/// Store the cookie captured for `url`'s site (empty clears it).
pub fn set_site_cookie(url: &str, cookie: &str) {
    let Some(host) = site_host(url) else {
        return;
    };
    // Header values reject control characters.
    let cookie: String = cookie
        .trim()
        .chars()
        .filter(|c| !matches!(c, '\r' | '\n' | '\t'))
        .collect();
    let Ok(mut guard) = cookie_slot().write() else {
        return;
    };
    let map = guard.get_or_insert_with(HashMap::new);
    if cookie.is_empty() {
        map.remove(&host);
        return;
    }
    map.insert(host, cookie);
}

/// Cookie header for `url`, when a verification for that host landed earlier
/// in this session. Longest matching stored host wins (`api.example.com` beats
/// `example.com`).
pub fn cookie_header_for(url: &str) -> Option<String> {
    let host = site_host(url)?;
    let guard = cookie_slot().read().ok()?;
    let map = guard.as_ref()?;
    map.iter()
        .filter(|(stored, _)| host_matches(&host, stored))
        .max_by_key(|(stored, _)| stored.len())
        .map(|(_, cookie)| cookie.clone())
}

/// True when `status` + headers/body describe an interactive verification
/// wall rather than real content or a plain permission error.
pub fn challenge_detected(status: u16, headers: &HeaderMap, body: &[u8]) -> bool {
    if headers.get("cf-mitigated").is_some_and(|value| {
        value
            .to_str()
            .is_ok_and(|v| v.eq_ignore_ascii_case("challenge"))
    }) {
        return true;
    }
    if headers.get(CONTENT_TYPE).is_some_and(|value| {
        value
            .to_str()
            .is_ok_and(|v| !v.to_ascii_lowercase().contains("html"))
    }) {
        return false;
    }
    if body.len() > CHALLENGE_MAX_BODY {
        return false;
    }
    let text = String::from_utf8_lossy(body);
    let marker = CHALLENGE_BODY_MARKERS
        .iter()
        .any(|marker| text.contains(marker));
    marker && (status == 403 || status == 429 || status == 503 || text.contains("Just a moment"))
}

/// Validate a captured cookie against `url`: the server must answer without
/// the wall. Reads only a bounded prefix, so validating a PDF URL does not
/// download the file.
pub async fn probe_cookie(url: &str, cookie: &str) -> bool {
    probe_with_cookie(url, cookie, false).await
}

/// Check the actual attachment before closing the OpenReview verification window.
pub async fn probe_pdf_cookie(url: &str, cookie: &str) -> bool {
    probe_with_cookie(url, cookie, true).await
}

async fn probe_with_cookie(url: &str, cookie: &str, require_pdf: bool) -> bool {
    let cookie = cookie.trim();
    if cookie.is_empty() {
        return false;
    }
    let Ok(client) = crate::http::client_with(
        PROBE_TIMEOUT,
        PROBE_REDIRECTS,
        crate::http::BROWSER_USER_AGENT,
    ) else {
        return false;
    };
    let Ok(response) = client
        .get(url)
        .header(reqwest::header::COOKIE, cookie)
        .send()
        .await
    else {
        return false;
    };
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    if !response.status().is_success() || challenge_detected(status, &headers, &[]) {
        return false;
    }
    if !require_pdf
        && headers.get(CONTENT_TYPE).is_some_and(|value| {
            value
                .to_str()
                .is_ok_and(|v| v.to_ascii_lowercase().contains("application/pdf"))
        })
    {
        return true;
    }
    let mut body = Vec::new();
    let mut stream = response;
    let limit = if require_pdf {
        b"%PDF-".len()
    } else {
        PROBE_PREFIX_BYTES
    };
    while body.len() < limit {
        match stream.chunk().await {
            Ok(Some(chunk)) => {
                let room = limit - body.len();
                body.extend_from_slice(&chunk[..chunk.len().min(room)]);
            }
            _ => break,
        }
    }
    if require_pdf {
        body.starts_with(b"%PDF-")
    } else {
        !challenge_detected(status, &headers, &body)
    }
}

/// Install (or replace) the host hook that opens the verification window.
pub fn install_auth_requester(
    requester: impl Fn(String) -> Pin<Box<dyn Future<Output = Option<String>> + Send>>
        + Send
        + Sync
        + 'static,
) {
    if let Ok(mut slot) = AUTH_REQUESTER.write() {
        *slot = Some(Arc::new(requester));
    }
}

/// Whether a host hook is installed (the headless CLI has no window).
pub fn has_auth_requester() -> bool {
    AUTH_REQUESTER
        .read()
        .map(|slot| slot.is_some())
        .unwrap_or(false)
}

/// Ask the Host to verify `url`; resolves to the validated cookie, if any.
pub(crate) async fn request_auth(url: String) -> Option<String> {
    let requester = AUTH_REQUESTER.read().ok().and_then(|slot| slot.clone())?;
    requester(url).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::{HeaderValue, CONTENT_TYPE};

    fn html_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/html"));
        headers
    }

    #[test]
    fn detects_cloudflare_and_turnstile_walls_only() {
        let headers = html_headers();
        assert!(challenge_detected(
            403,
            &headers,
            br#"<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>"#
        ));
        assert!(challenge_detected(
            503,
            &headers,
            br#"<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>"#
        ));
        assert!(challenge_detected(
            403,
            &headers,
            br#"{"error":{"code":"ChallengeRequiredError"}}"#
        ));
        // Real content, redirects, and PDFs are not walls.
        assert!(!challenge_detected(
            200,
            &headers,
            br#"<html><body>paper</body></html>"#
        ));
        let mut cf = html_headers();
        cf.insert("cf-mitigated", HeaderValue::from_static("challenge"));
        assert!(challenge_detected(200, &cf, b""));
        let mut pdf = HeaderMap::new();
        pdf.insert(CONTENT_TYPE, HeaderValue::from_static("application/pdf"));
        assert!(!challenge_detected(403, &pdf, b"%PDF-1.7"));
    }

    #[test]
    fn site_cookies_attach_to_matching_hosts_only() {
        set_site_cookie("https://example.com/a", "cf_clearance=abc");
        assert_eq!(
            cookie_header_for("https://example.com/b").as_deref(),
            Some("cf_clearance=abc")
        );
        assert_eq!(
            cookie_header_for("https://www.example.com/b").as_deref(),
            Some("cf_clearance=abc")
        );
        assert_eq!(cookie_header_for("https://other.example/b"), None);
        set_site_cookie("https://example.com/a", "");
        assert_eq!(cookie_header_for("https://example.com/b"), None);
    }
}
