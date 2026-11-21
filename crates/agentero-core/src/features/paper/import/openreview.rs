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
use std::sync::RwLock;
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

/// Captured verification cookie plus the expiry read out of its JWT, if any.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenReviewCredential {
    /// Ready-to-send `Cookie` header value (`name=value; …`).
    pub cookie: String,
    /// Unix seconds from the credential JWT's `exp`; `None` for browser-session
    /// cookies without a readable expiry.
    pub expires_at: Option<i64>,
}

static CREDENTIAL: RwLock<Option<OpenReviewCredential>> = RwLock::new(None);

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
fn jwt_expiry(value: &str) -> Option<i64> {
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

/// Latest `exp` found among the JWT-valued cookies of a `Cookie` header.
///
/// The clearance token is the usual carrier, but a signed-in browser session
/// may also arrive as a JWT; taking the maximum keeps the status honest when
/// both are present.
pub fn credential_expiry(cookie: &str) -> Option<i64> {
    let mut expiry: Option<i64> = None;
    for pair in cookie.split(';') {
        let pair = pair.trim();
        if pair.is_empty() {
            continue;
        }
        // A cookie pair is `name=value`; a bare JWT is accepted too so callers
        // can pass a raw credential value.
        let value = match pair.split_once('=') {
            Some((_, value)) => value,
            None => pair,
        };
        let Some(exp) = jwt_expiry(value.trim()) else {
            continue;
        };
        expiry = Some(expiry.map_or(exp, |current| current.max(exp)));
    }
    expiry
}

/// Whether the credential's own expiry has passed (browser-session cookies
/// without an `exp` stay "unknown", not expired).
pub fn credential_expired(credential: &OpenReviewCredential) -> bool {
    credential
        .expires_at
        .is_some_and(|expiry| expiry <= now_unix())
}

fn now_unix() -> i64 {
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
    let cookie: String = cookie
        .trim()
        .chars()
        .filter(|c| !matches!(c, '\r' | '\n' | '\t'))
        .collect();
    let next = if cookie.is_empty() {
        None
    } else {
        let expires_at = credential_expiry(&cookie);
        Some(OpenReviewCredential { cookie, expires_at })
    };
    if let Ok(mut slot) = CREDENTIAL.write() {
        *slot = next;
    }
}

/// The captured credential, if any state is configured.
pub fn openreview_credential() -> Option<OpenReviewCredential> {
    CREDENTIAL.read().ok().and_then(|slot| slot.clone())
}

/// The captured cookie header value, if any.
pub fn openreview_cookie() -> Option<String> {
    openreview_credential()
        .map(|credential| credential.cookie)
        .filter(|cookie| !cookie.is_empty())
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

/// True when a `403` body is OpenReview's bot-challenge gate rather than a
/// genuine permission error.
pub fn looks_like_challenge(status: u16, body: &[u8]) -> bool {
    if status != 403 {
        return false;
    }
    let body = String::from_utf8_lossy(body);
    body.contains("ChallengeRequiredError")
        || body.contains("Verifying your browser")
        || body.contains("challenges.cloudflare.com/turnstile")
        || body.contains("cf-turnstile")
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
        // An expired credential is recognised without a network request.
        let credential = OpenReviewCredential {
            cookie: "openreview.clearanceToken=x".into(),
            expires_at: Some(1),
        };
        assert!(credential_expired(&credential));
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
        assert!(!looks_like_challenge(403, b"<html>Forbidden</html>"));
        assert!(!looks_like_challenge(200, challenge));
        assert!(!looks_like_challenge(404, b"<html>Not Found</html>"));
    }
}
