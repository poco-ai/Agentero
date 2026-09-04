//! Shared plumbing for the 广场 site proxies.
//!
//! Each embedded source is served under its own private URI scheme so the panel
//! frame is same-origin with it: only then can links be retargeted to navigate in
//! place and each navigation be reported back for a real history stack. Rebuilding
//! the response here also drops the upstream `X-Frame-Options` / CSP that would
//! otherwise refuse the embed.
//!
//! Every [`SiteProxy::origin`] is a hardcoded constant: these proxies must never
//! become an open relay.

use tauri::http::{header, Response, StatusCode};

pub struct SiteProxy {
    /// Human name, used in error bodies and logs.
    pub label: &'static str,
    pub origin: &'static str,
    pub user_agent: &'static str,
    /// Applied to full HTML documents only — see [`looks_like_document`].
    pub rewrite: fn(&str) -> String,
}

/// Request headers worth forwarding.
///
/// Deliberately excludes `Origin`, `Referer`, `Cookie` and everything else
/// credential-bearing: no Plaza source carries login state.
fn is_forwardable(name: &str) -> bool {
    matches!(name, "content-type" | "accept" | "accept-language")
}

fn response(status: StatusCode, content_type: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .body(body)
        .expect("valid site proxy response")
}

/// Whether a body is a full page rather than an XHR fragment.
///
/// Sites fetch `text/html` fragments and write the response text straight into
/// the DOM (papers.cool does this for the Kimi analysis and the bare star
/// counter). Injecting into those renders the bridge source as visible text, so
/// only real documents may be touched.
pub fn looks_like_document(body: &str) -> bool {
    let head: String = body
        .trim_start_matches('\u{feff}')
        .trim_start()
        .chars()
        .take(16)
        .collect::<String>()
        .to_ascii_lowercase();
    head.starts_with("<!doctype") || head.starts_with("<html")
}

pub fn handle(
    site: &'static SiteProxy,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    let path = request.uri().path().to_string();
    if !path.starts_with('/') || path.contains("..") {
        responder.respond(response(
            StatusCode::BAD_REQUEST,
            "text/plain",
            format!("invalid {} path", site.label).into_bytes(),
        ));
        return;
    }
    let query = request
        .uri()
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let url = format!("{}{path}{query}", site.origin);
    let (parts, body) = request.into_parts();

    tauri::async_runtime::spawn(async move {
        let result = async {
            let client = crate::core::http::shared_client().map_err(|e| e.to_string())?;
            let method = reqwest::Method::from_bytes(parts.method.as_str().as_bytes())
                .unwrap_or(reqwest::Method::GET);
            let mut outgoing = client
                .request(method, url)
                .header(reqwest::header::USER_AGENT, site.user_agent);
            for (name, value) in parts.headers.iter() {
                if is_forwardable(name.as_str()) {
                    outgoing = outgoing.header(name.as_str(), value.as_bytes());
                }
            }
            // Single-page sources load their lists over `PUT`/`POST` with a JSON
            // body; dropping it answers 400 and the page renders empty.
            if !body.is_empty() {
                outgoing = outgoing.body(body);
            }
            let remote = outgoing.send().await.map_err(|e| e.to_string())?;
            let status =
                StatusCode::from_u16(remote.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let content_type = remote
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("application/octet-stream")
                .to_string();
            let bytes = remote.bytes().await.map_err(|e| e.to_string())?;
            let body = if content_type.starts_with("text/html") {
                match String::from_utf8(bytes.to_vec()) {
                    Ok(text) if looks_like_document(&text) => (site.rewrite)(&text).into_bytes(),
                    // XHR fragments go through as-is.
                    _ => bytes.to_vec(),
                }
            } else {
                bytes.to_vec()
            };
            Ok::<_, String>((status, content_type, body))
        }
        .await;

        match result {
            Ok((status, content_type, body)) => {
                responder.respond(response(status, &content_type, body))
            }
            Err(error) => {
                log::warn!(
                    target: "agentero::site_proxy",
                    "{} proxy request failed: {error}", site.label
                );
                responder.respond(response(
                    StatusCode::BAD_GATEWAY,
                    "text/plain",
                    format!("{} unavailable", site.label).into_bytes(),
                ));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn treats_full_pages_as_documents() {
        assert!(looks_like_document("<!DOCTYPE html>\n<html>\n<head>"));
        assert!(looks_like_document("\n  <!doctype html><html>"));
        assert!(looks_like_document("<html lang=\"en\">"));
    }

    /// papers.cool's `toggleKimi` writes this body into the DOM; a bridge here
    /// shows up as text.
    #[test]
    fn treats_kimi_fragment_as_non_document() {
        let fragment = "<p class=\"faq-q\"><strong>Q1</strong>: 试图解决什么问题？</p>\n\n<div class=\"faq-a\">\n\n答案\n\n</div>";
        assert!(!looks_like_document(fragment));
    }

    /// papers.cool's `POST /star` answers with a bare count — the stray `0` users
    /// saw rendered as a page.
    #[test]
    fn treats_star_counter_as_non_document() {
        assert!(!looks_like_document("1060"));
        assert!(!looks_like_document("0"));
        assert!(!looks_like_document(""));
    }

    /// Forwarding `Cookie` / `Origin` would leak the WebView's state (and our
    /// private scheme) upstream; the sources are all browsed anonymously.
    #[test]
    fn forwards_only_content_negotiation_headers() {
        assert!(is_forwardable("content-type"));
        assert!(is_forwardable("accept"));
        assert!(!is_forwardable("cookie"));
        assert!(!is_forwardable("origin"));
        assert!(!is_forwardable("authorization"));
    }
}
