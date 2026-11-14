//! Gateway classification for custom prefixes: URL heuristics, unauthenticated
//! fingerprints, then rewrite probes.

use super::kind::InstitutionProxyKind;
use super::rewrite::{looks_like_ezproxy_prefix, subdomain_rewrite, wengine_rewrite};
use crate::http;
use std::sync::Mutex;
use std::time::Duration;

/// Classify an arbitrary gateway prefix without a full PDF probe.
///
/// Cheap rules run first (explicit EZProxy query form), then the gateway root
/// is fingerprinted (wengine sets `wengine_vpn_ticket`, Astraeus sets
/// `_astraeus_session` / `_webvpn_key`), then each rewrite form is tried.
/// Returns `None` when no candidate answers recognisably.
pub async fn detect_institution_proxy_kind(
    prefix: &str,
    cookie: &str,
) -> Option<InstitutionProxyKind> {
    let prefix = prefix.trim().trim_end_matches('/');
    if prefix.is_empty() {
        return None;
    }
    // Explicit `/login?url=` (or a bare `/login`) only makes sense for EZProxy.
    if looks_like_ezproxy_prefix(prefix) {
        return Some(InstitutionProxyKind::EzProxy);
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent(http::BROWSER_USER_AGENT)
        .redirect(reqwest::redirect::Policy::none())
        .cookie_store(true)
        .build()
        .ok()?;

    // 1. Gateway-root fingerprint. Unauthenticated wengine still issues its
    //    ticket cookie; Astraeus issues a session cookie and bounces to its
    //    own sign-in page.
    if let Some(res) = gateway_get(&client, prefix, cookie).await {
        let mut set_cookie = String::new();
        for value in res.headers().get_all(reqwest::header::SET_COOKIE) {
            if let Ok(value) = value.to_str() {
                set_cookie.push_str(&value.to_ascii_lowercase());
                set_cookie.push(' ');
            }
        }
        let location = response_location(&res);
        if set_cookie.contains("wengine_vpn_ticket") {
            return Some(InstitutionProxyKind::Wengine);
        }
        if set_cookie.contains("_astraeus")
            || set_cookie.contains("webvpn_key")
            || location.contains("/vpn_key/")
            || location.contains("/users/sign_in")
        {
            return Some(InstitutionProxyKind::Subdomain);
        }
    }

    // 2. Subdomain mapping: a wengine gateway has no wildcard DNS for the
    //    mapped host, so only Astraeus-style gateways answer here.
    if let Some(mapped) = subdomain_rewrite(prefix, "https://www.nature.com/") {
        if let Some(res) = gateway_get(&client, &mapped, cookie).await {
            let location = response_location(&res);
            if location.contains("/vpn_key/") || res.status().is_success() {
                return Some(InstitutionProxyKind::Subdomain);
            }
        }
    }

    // 3. wengine path rewrite: non-wengine gateways reject the `/https/{hex}`
    //    form with 400/404 instead of serving a login page.
    if let Some(mapped) = wengine_rewrite(prefix, "https://www.nature.com/") {
        if let Some(res) = gateway_get(&client, &mapped, cookie).await {
            if !matches!(
                res.status(),
                reqwest::StatusCode::BAD_REQUEST | reqwest::StatusCode::NOT_FOUND
            ) {
                return Some(InstitutionProxyKind::Wengine);
            }
        }
    }

    // 4. EZProxy query passthrough.
    let mapped = format!(
        "{prefix}/login?url={}",
        urlencoding::encode("https://www.nature.com/")
    );
    if let Some(res) = gateway_get(&client, &mapped, cookie).await {
        if !matches!(
            res.status(),
            reqwest::StatusCode::BAD_REQUEST | reqwest::StatusCode::NOT_FOUND
        ) {
            return Some(InstitutionProxyKind::EzProxy);
        }
    }
    None
}

fn response_location(res: &reqwest::Response) -> String {
    res.headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

async fn gateway_get(
    client: &reqwest::Client,
    url: &str,
    cookie: &str,
) -> Option<reqwest::Response> {
    let mut req = client.get(url);
    let cookie = cookie.trim();
    if !cookie.is_empty() {
        if let Ok(value) = reqwest::header::HeaderValue::from_str(cookie) {
            req = req.header(reqwest::header::COOKIE, value);
        }
    }
    req.send().await.ok()
}

/// Cache of `prefix -> detected kind`, so `Auto` fingerprints at most once per
/// process (batch imports reuse it).
static DETECTED_KINDS: Mutex<Vec<(String, InstitutionProxyKind)>> = Mutex::new(Vec::new());

fn cached_detected_kind(prefix: &str) -> Option<InstitutionProxyKind> {
    DETECTED_KINDS
        .lock()
        .ok()?
        .iter()
        .rev()
        .find(|(cached, _)| cached == prefix)
        .map(|(_, kind)| *kind)
}

fn remember_detected_kind(prefix: &str, kind: InstitutionProxyKind) {
    if let Ok(mut cache) = DETECTED_KINDS.lock() {
        cache.retain(|(cached, _)| cached != prefix);
        cache.push((prefix.to_string(), kind));
        if cache.len() > 16 {
            cache.remove(0);
        }
    }
}

/// Resolve `Auto` to a concrete kind, caching the result. Explicit kinds pass
/// through unchanged.
pub async fn resolve_institution_proxy_kind(
    kind: InstitutionProxyKind,
    prefix: &str,
    cookie: &str,
) -> Option<InstitutionProxyKind> {
    if kind != InstitutionProxyKind::Auto {
        return Some(kind);
    }
    let prefix = prefix.trim().trim_end_matches('/');
    if let Some(kind) = cached_detected_kind(prefix) {
        return Some(kind);
    }
    let kind = detect_institution_proxy_kind(prefix, cookie).await?;
    remember_detected_kind(prefix, kind);
    Some(kind)
}
