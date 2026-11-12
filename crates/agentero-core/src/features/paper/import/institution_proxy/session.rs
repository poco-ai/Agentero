//! Cookie-aware HTTP helpers for gateway requests.
//!
//! Subdomain gateways redirect the first hop through the gateway host to mint
//! a per-subdomain token. reqwest does not replay a manually attached
//! `Cookie` header across redirects, so those requests seed a cookie jar for
//! every relevant origin instead.

use crate::http;
use std::time::Duration;

/// Fetch `url` and return `(body, final_url)`.
pub(crate) async fn fetch_bytes_checked_with_url(
    url: &str,
    cookie: &str,
) -> Result<(Vec<u8>, String), String> {
    fetch_bytes_checked_with_url_seeded(url, cookie, &[]).await
}

/// [`fetch_bytes_checked_with_url`] with optional cookie seeding.
///
/// `seed_urls` puts the saved cookie into the client's jar for every origin.
/// An empty slice keeps the old single-request header behaviour.
pub(crate) async fn fetch_bytes_checked_with_url_seeded(
    url: &str,
    cookie: &str,
    seed_urls: &[&str],
) -> Result<(Vec<u8>, String), String> {
    let cookie = cookie.trim();
    // Cookie store on: publisher bot checks (e.g. nature.com) accept the
    // request once the landing page's cookies ride along, which also makes
    // direct on-campus downloads work with zero configuration.
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .user_agent(http::BROWSER_USER_AGENT)
        .redirect(reqwest::redirect::Policy::limited(10));
    let jar = if seed_urls.is_empty() {
        builder = builder.cookie_store(true);
        None
    } else {
        let jar = std::sync::Arc::new(reqwest::cookie::Jar::default());
        if !cookie.is_empty() {
            // A pasted `Cookie` request header is `name=value; …`; the jar
            // wants one Set-Cookie-shaped string at a time.
            for seed in seed_urls {
                let Ok(mut seed_url) = reqwest::Url::parse(seed) else {
                    continue;
                };
                // Seed the whole origin: a cookie minted for a path only would
                // not ride along when the gateway redirects to another path.
                seed_url.set_path("/");
                seed_url.set_query(None);
                seed_url.set_fragment(None);
                for pair in cookie.split(';') {
                    let pair = pair.trim();
                    if !pair.is_empty() {
                        jar.add_cookie_str(pair, &seed_url);
                    }
                }
            }
        }
        builder = builder.cookie_provider(jar.clone());
        Some(jar)
    };
    let client = builder.build().map_err(|e| e.to_string())?;
    let mut req = client.get(url);
    if jar.is_none() && !cookie.is_empty() {
        let value = reqwest::header::HeaderValue::from_str(cookie)
            .map_err(|e| format!("cookie contains characters invalid in a header ({e})"))?;
        req = req.header("Cookie", value);
    }
    let res = req.send().await.map_err(|e| {
        let mut msg = e.to_string();
        let mut src = std::error::Error::source(&e);
        while let Some(s) = src {
            msg.push_str(": ");
            msg.push_str(&s.to_string());
            src = s.source();
        }
        msg
    })?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    let final_url = res.url().to_string();
    let bytes = res.bytes().await.map_err(|e| e.to_string())?.to_vec();
    Ok((bytes, final_url))
}
