//! OpenReview bot-challenge credentials (#1157).
//!
//! OpenReview answers anonymous PDF / API requests with `403` and a Cloudflare
//! Turnstile page (`ChallengeRequiredError`) instead of the file. A real
//! browser visit that clears the check — or a signed-in session — receives the
//! `openreview.clearanceToken` cookie (an IP-bound JWT with a 5-minute TTL),
//! and replaying that cookie as a plain `Cookie` header returns the PDF.
//!
//! The desktop Host owns the interactive part: its verification window
//! captures the cookie and stores it through the settings store, which calls
//! [`set_openreview_cookie`]. Downloads then attach it for OpenReview hosts.
//! Because the credential is short-lived, a challenged request asks the Host
//! (through [`super::web_verify`]) to re-open the window once and retries with
//! the fresh cookie.
//!
//! Keep this module free of Tauri/window code so the headless CLI can load the
//! same credential from `settings.json` and skip the challenge while it is
//! still valid.

use base64::Engine;
use futures_util::future::BoxFuture;
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// OpenReview's registrable host; subdomains (`api2.…`) share the cookie jar.
const OPENREVIEW_HOST: &str = "openreview.net";
/// Public forum page used to tell a working credential from the challenge
/// gate. A missing paper (404) still proves the gate was passed, so only the
/// challenge page / `403` count as failure.
const PROBE_URL: &str = "https://openreview.net/forum?id=KS8mIvetg2";
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
/// Redirect budget for the probe (forum → challenge is a single hop).
const PROBE_REDIRECTS: usize = 5;

static CREDENTIAL: RwLock<Option<String>> = RwLock::new(None);

pub const ACCESS_COOKIE: &str = "openreview.accessToken";
pub const REFRESH_COOKIE: &str = "openreview.refreshToken";
const API_ORIGIN: &str = "https://api2.openreview.net";

type AccessTokenProvider = fn(Option<String>) -> BoxFuture<'static, Option<String>>;
static ACCESS_TOKEN_PROVIDER: OnceLock<AccessTokenProvider> = OnceLock::new();

pub fn install_access_token_provider(provider: AccessTokenProvider) {
    let _ = ACCESS_TOKEN_PROVIDER.set(provider);
}

/// Account tokens and the remaining browser cookies have different lifetimes
/// and storage. Drop account cookies from the settings-backed verification jar.
pub fn verification_cookies(cookie: &str) -> String {
    cookie
        .split(';')
        .map(str::trim)
        .filter(|pair| {
            pair.split_once('=').is_some_and(|(name, _)| {
                !matches!(
                    name.trim(),
                    ACCESS_COOKIE | REFRESH_COOKIE | "openreview.user"
                )
            })
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn account_pdf_url(raw: &str) -> Option<reqwest::Url> {
    let mut url = reqwest::Url::parse(raw).ok()?;
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(
            url.host_str(),
            Some("openreview.net" | "api2.openreview.net" | "api.openreview.net")
        )
        || !(matches!(
            url.path(),
            "/pdf" | "/attachment" | "/notes/edits/attachment"
        ) || url.path().starts_with("/pdf/"))
    {
        return None;
    }
    if url.host_str() == Some("openreview.net") {
        url.set_host(Some("api2.openreview.net")).ok()?;
    }
    url.set_fragment(None);
    Some(url)
}

/// Try the official attachment API with the signed-in account first.
/// A rejected or unavailable account falls back to the regular download chain.
pub(crate) async fn account_pdf_response(
    raw_url: &str,
    timeout: Duration,
) -> Option<reqwest::Response> {
    let url = account_pdf_url(raw_url)?;
    let client = crate::http::client_builder()
        .timeout(timeout)
        .user_agent(crate::http::BROWSER_USER_AGENT)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            // Reqwest strips Authorization on cross-host redirects. Also stop
            // before any redirect that would downgrade the HTTPS connection.
            if attempt.url().scheme() != "https" || attempt.previous().len() >= 5 {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .ok()?;
    let request = client.get(url).header(
        reqwest::header::ACCEPT,
        "application/pdf,application/octet-stream",
    );
    let response = send_with_account(request).await?;
    let binary = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_none_or(|mime| {
            mime.starts_with("application/pdf") || mime.starts_with("application/octet-stream")
        });
    (response.status().is_success() && binary).then_some(response)
}

async fn send_with_account(request: reqwest::RequestBuilder) -> Option<reqwest::Response> {
    let provider = ACCESS_TOKEN_PROVIDER.get()?;
    let token = provider(None).await?;
    let response = request.try_clone()?.bearer_auth(&token).send().await.ok()?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        let refreshed = provider(Some(token)).await?;
        return request.bearer_auth(refreshed).send().await.ok();
    }
    Some(response)
}

/// Read one submission through the official API. The session that can
/// download an attachment can also supply its bibliographic fields.
pub(crate) async fn submission(id: &str) -> Option<serde_json::Value> {
    let url = format!("{API_ORIGIN}/notes");
    let client = crate::http::client_builder()
        .timeout(Duration::from_secs(10))
        .user_agent(crate::http::BROWSER_USER_AGENT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()?;
    let request = client
        .get(&url)
        .query(&[("id", id)])
        .header(reqwest::header::ACCEPT, "application/json");
    if let Some(response) = send_with_account(request.try_clone()?).await {
        if response.status().is_success() {
            if let Ok(json) = response.json().await {
                return Some(json);
            }
        }
    }
    if let Some(cookie) = cookie_header_for(&url) {
        if let Ok(response) = request.header(reqwest::header::COOKIE, cookie).send().await {
            if response.status().is_success() {
                if let Ok(json) = response.json().await {
                    return Some(json);
                }
            }
        }
    }
    // The public search API supports exact note IDs, even when the forum and
    // direct note endpoints require authentication. Only query the submission.
    client
        .post(format!("{API_ORIGIN}/notes/search"))
        .json(&serde_json::json!({ "ids": [id], "source": "forum", "limit": 1 }))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()
}

pub async fn probe_account_pdf(url: &str) -> bool {
    let Some(mut response) = account_pdf_response(url, PROBE_TIMEOUT).await else {
        return false;
    };
    let mut prefix = Vec::new();
    while prefix.len() < 4 {
        let Ok(Some(bytes)) = response.chunk().await else {
            return false;
        };
        prefix.extend_from_slice(&bytes[..bytes.len().min(4 - prefix.len())]);
    }
    prefix == b"%PDF"
}

/// Refresh via the same API used by OpenReview's website. The refresh cookie
/// only goes to this one endpoint, and any rotated refresh token is retained.
pub async fn refresh_account(refresh: &str) -> Option<(String, Option<String>)> {
    let client = crate::http::client_builder()
        .timeout(PROBE_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()?;
    let response = client
        .post(format!("{API_ORIGIN}/refreshToken"))
        .header(
            reqwest::header::COOKIE,
            format!("{REFRESH_COOKIE}={refresh}"),
        )
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    let rotated = response.cookies().find_map(|cookie| {
        (cookie.name() == REFRESH_COOKIE && !cookie.value().is_empty())
            .then(|| cookie.value().to_owned())
    });
    #[derive(serde::Deserialize)]
    struct RefreshResponse {
        token: String,
    }
    let refreshed = response.json::<RefreshResponse>().await.ok()?;
    Some((refreshed.token, rotated))
}

/// True when `url` belongs to OpenReview (main site or an API subdomain).
pub fn is_openreview_url(url: &str) -> bool {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(is_openreview_host))
        .unwrap_or(false)
}

/// True when `host` is `openreview.net` or one of its subdomains.
pub fn is_openreview_host(host: &str) -> bool {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    host == OPENREVIEW_HOST
        || host
            .strip_suffix(OPENREVIEW_HOST)
            .is_some_and(|prefix| prefix.ends_with('.'))
}

/// Unix expiry encoded in a JWT value (`header.payload.signature`).
pub fn jwt_expiry(value: &str) -> Option<i64> {
    let mut parts = value.split('.');
    parts.next()?;
    let payload = parts.next()?.trim();
    parts.next()?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let json: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    json.get("exp").and_then(serde_json::Value::as_i64)
}

/// Latest JWT expiry in the cookie header. Accepts a bare JWT as well.
pub fn credential_expiry(cookie: &str) -> Option<i64> {
    cookie
        .split(';')
        .filter_map(|pair| {
            let value = pair.split_once('=').map_or(pair, |(_, value)| value);
            jwt_expiry(value.trim())
        })
        .max()
}

pub fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or_default()
}

/// Install the captured cookie (empty clears it). The Host calls this from the
/// settings store on load / set, so every download sees the latest credential.
pub fn set_openreview_cookie(cookie: &str) {
    // Header values reject control characters; captured cookies occasionally
    // carry stray CR/LF/TAB when pasted, and the settings file is plain JSON.
    let cookie: String = verification_cookies(cookie)
        .chars()
        .filter(|c| !matches!(c, '\r' | '\n' | '\t'))
        .collect();
    if let Ok(mut slot) = CREDENTIAL.write() {
        *slot = (!cookie.is_empty()).then_some(cookie);
    }
}

fn openreview_cookie() -> Option<String> {
    CREDENTIAL.read().ok().and_then(|slot| slot.clone())
}

/// Cookie header to attach to `url`; only OpenReview hosts receive it.
pub fn cookie_header_for(url: &str) -> Option<String> {
    if !is_openreview_url(url) {
        return None;
    }
    openreview_cookie()
}

/// OpenReview wire keys in the shared `settings.json` (camelCase).
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenReviewSettings {
    #[serde(default)]
    openreview_cookie: String,
}

/// Install the OpenReview credential from the shared `settings.json` into this
/// process. The desktop Host pushes it through its settings store; the headless
/// CLI has no store, so it reads the same file here before downloading.
/// Returns true when a credential was installed.
pub fn load_openreview_from_settings() -> bool {
    let Some(raw) = std::fs::read_to_string(crate::paths::settings_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<OpenReviewSettings>(&raw).ok())
    else {
        return false;
    };
    set_openreview_cookie(&raw.openreview_cookie);
    openreview_cookie().is_some()
}

/// Recognize an OpenReview browser challenge or explicit sign-in prompt.
pub fn looks_like_challenge(status: u16, body: &[u8]) -> bool {
    if status != 403 && status != 401 {
        return false;
    }
    let body = String::from_utf8_lossy(body);
    body.contains("ChallengeRequiredError")
        || body.contains("Verifying your browser")
        || body.contains("challenges.cloudflare.com/turnstile")
        || body.contains("cf-turnstile")
        || body.contains("Please check that you are logged in to OpenReview")
}

/// Verify that `cookie` gets past the challenge gate.
///
/// Returns `Err("challenge")` while the gate is still closed (any other status,
/// including a missing probe paper, means the request reached OpenReview).
pub async fn probe_openreview_auth(cookie: &str) -> Result<(), String> {
    let cookie = cookie.trim();
    if cookie.is_empty() {
        return Err("challenge".into());
    }
    let client = crate::http::client_with(
        PROBE_TIMEOUT,
        PROBE_REDIRECTS,
        crate::http::BROWSER_USER_AGENT,
    )
    .map_err(|error| format!("openreview probe: {error}"))?;
    let response = client
        .get(PROBE_URL)
        .header(reqwest::header::COOKIE, cookie)
        .send()
        .await
        .map_err(|error| format!("openreview probe: {error}"))?;
    let status = response.status();
    let final_url = response.url().clone();
    let body = response
        .bytes()
        .await
        .map_err(|error| format!("openreview probe body: {error}"))?;
    let challenged = status == 403
        || final_url.path().starts_with("/challenge")
        || looks_like_challenge(status.as_u16(), &body);
    if challenged {
        Err("challenge".into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jwt(payload: &serde_json::Value) -> String {
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(payload).unwrap());
        format!("eyJhbGciOiJIUzI1NiJ9.{encoded}.signature")
    }

    #[test]
    fn matches_openreview_hosts_only() {
        assert!(is_openreview_host("openreview.net"));
        assert!(is_openreview_host("api2.openreview.net"));
        assert!(is_openreview_host("openreview.net."));
        assert!(!is_openreview_host("evilopenreview.net"));
        assert!(!is_openreview_host("openreview.net.evil.example"));
        assert!(is_openreview_url("https://openreview.net/pdf?id=x"));
        assert!(is_openreview_url("https://api2.openreview.net/notes?id=x"));
        assert!(!is_openreview_url("https://example.com/openreview.net"));
        assert!(!is_openreview_url("not a url"));
    }

    #[test]
    fn reads_the_latest_expiry_from_cookie_jwts() {
        let clearance = jwt(&serde_json::json!({ "exp": 1_800_000_300i64 }));
        let session = jwt(&serde_json::json!({ "exp": 1_800_090_000i64 }));
        assert_eq!(credential_expiry(&clearance), Some(1_800_000_300));
        assert_eq!(
            credential_expiry(&format!(
                "openreview.clearanceToken={clearance}; openreview.session={session}"
            )),
            Some(1_800_090_000)
        );
        // Non-JWT and unsigned values carry no readable expiry.
        assert_eq!(credential_expiry("_ga=GA1.1.1"), None);
        assert_eq!(credential_expiry("openreview.clearanceToken=boom"), None);
    }

    #[test]
    fn classifies_the_turnstile_challenge_page() {
        let challenge = br#"<html><title>Verifying your browser</title>
            <script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></html>"#;
        assert!(looks_like_challenge(403, challenge));
        assert!(looks_like_challenge(
            403,
            br#"{"error":{"code":"ChallengeRequiredError"}}"#
        ));
        let login_prompt = b"<h1>Error 403</h1><p>Access to this page is restricted.
            Please check that you are logged in to OpenReview and try again.</p>";
        assert!(looks_like_challenge(403, login_prompt));
        assert!(looks_like_challenge(401, login_prompt));
        assert!(!looks_like_challenge(403, b"<html>Forbidden</html>"));
        assert!(!looks_like_challenge(200, challenge));
        assert!(!looks_like_challenge(404, b"<html>Not Found</html>"));
    }
}
