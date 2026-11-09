//! Generic `agentero-web` proxy for HTML paper reading.
//!
//! The viewer frame loads remote pages as `agentero-web://localhost/<host>/<path>`
//! (Windows WebView2 surfaces the same shape as `http://agentero-web.localhost/…`).
//! Rebuilding the response here drops the upstream `X-Frame-Options` / CSP that
//! would refuse the embed, and — unlike the 广场 site proxies, whose origin is a
//! hardcoded constant — serves any host on the [`allowlist`](super::allowlist),
//! which the frontend seeds with a paper's host before loading its frame.
//!
//! Documents get two injections right after `<head>` opens, plus one deletion:
//!
//! - `<meta http-equiv="Content-Security-Policy">` is stripped. Sites that
//!   embed their CSP in HTML (not headers) would enforce it inside the frame,
//!   where `'self'` is the proxy origin — so the site's own stylesheets and
//!   scripts, steered to the real origin by the `<base>`, all fail the policy
//!   and the page renders as unstyled HTML.
//! - `<base href="https://<host>/<dir>/">` — every relative, root-relative and
//!   protocol-relative subresource (stylesheets, images, fonts, CSS `url()`)
//!   then resolves against the real origin and loads directly from the site,
//!   never through the proxy. Only page navigations need to stay proxied, and
//!   those are rewritten by the bridge at click time.
//! - [`WEB_BRIDGE`] — the selection / shortcut / navigation bridge that lets
//!   the app see and act on text selected inside the cross-origin frame.

use super::allowlist;
use tauri::http::{header, Response, StatusCode};

/// Reuse the 广场 proxy's header filter (content negotiation only, never
/// credential-bearing headers: the proxy carries no login state).
use crate::features::paper::discovery::proxy::looks_like_document;

/// Selection / shortcut / navigation bridge injected into proxied documents.
///
/// Shared selection IIFE with no namespace leakage. The app validates both
/// `event.origin` and the sending iframe before consuming its messages.
pub(crate) const SELECTION_BRIDGE: &str = concat!(
    "<script>",
    include_str!("../../../../src/lib/web-view/selection-bridge.js"),
    "</script>"
);

pub(crate) fn inject_selection_bridge(html: &str) -> String {
    match html.to_ascii_lowercase().find("</head>") {
        Some(index) => format!("{}{}{}", &html[..index], SELECTION_BRIDGE, &html[index..]),
        None => format!("{SELECTION_BRIDGE}{html}"),
    }
}

const WEB_BRIDGE: &str = concat!(
    "<script>",
    include_str!("../../../../src/lib/web-view/selection-bridge.js"),
    "</script>",
    r##"<script>
(function () {
  try {
    // Only the top-level proxied document talks to the app. A nested frame on
    // the same proxy origin has a readable parent and stays uninstrumented.
    try {
      if (parent === window) return;
      void parent.location.href;
      return;
    } catch (e) {}
    var post = function (message) {
      message.source = "agentero-web";
      parent.postMessage(message, "*");
    };
    // The upstream host rides in the first path segment of the proxy URL.
    var host = "";
    try {
      host = decodeURIComponent((location.pathname.match(/^\/([^/]+)/) || [])[1] || "") || "";
    } catch (e) {}

    // ---- navigation policy --------------------------------------------------
    // Same-site navigations stay inside the proxy so the bridge survives;
    // everything else belongs to the system browser, where the user has a
    // real session.
    document.addEventListener("click", function (event) {
      var anchor =
        event.target && event.target.closest
          ? event.target.closest("a[href]")
          : null;
      if (!anchor) return;
      var raw = anchor.getAttribute("href");
      if (!raw || raw.charAt(0) === "#" || /^javascript:/i.test(raw)) return;
      var url;
      try {
        url = new URL(anchor.href, location.href);
      } catch (e) {
        return;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        // Never leak our private scheme to the system browser.
        event.preventDefault();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (host && url.hostname === host) {
        location.assign("/" + host + url.pathname + url.search + url.hash);
        return;
      }
      post({ type: "external", url: url.href });
    }, true);

    // SPA routers push site-root paths; keep the host segment in the URL.
    if (host) {
      ["pushState", "replaceState"].forEach(function (name) {
        var original = history[name];
        if (typeof original !== "function") return;
        history[name] = function (state, title, url) {
          if (
            typeof url === "string" &&
            url.charAt(0) === "/" &&
            url.charAt(1) !== "/" &&
            url.indexOf("/" + host + "/") !== 0
          ) {
            arguments[2] = "/" + host + url;
          }
          return original.apply(history, arguments);
        };
      });
    }

  } catch (e) {}
})();
</script>"##
);

/// Where a proxy request goes upstream.
struct Target {
    host: String,
    /// Path + query; the path always starts with '/'.
    path_query: String,
}

/// Parse the upstream target from an `agentero-web` request URI.
///
/// Two shapes arrive:
/// - host-in-path `agentero-web://localhost/<host>/<path>` — the iframe's src
///   and every link the bridge rewrites; on Windows WebView2 the same shape
///   arrives as `http://agentero-web.localhost/<host>/<path>` because custom
///   schemes are surfaced as `http://<scheme>.localhost`,
/// - direct-host `agentero-web://<host>/<path>` — protocol-relative URLs the
///   page resolved against the custom scheme (macOS/Linux).
fn target_from_uri(uri: &tauri::http::Uri) -> Option<Target> {
    let host = uri.host()?;
    let path = uri.path();
    if !path.starts_with('/') || path.contains("..") {
        return None;
    }
    let query = uri.query().map(|q| format!("?{q}")).unwrap_or_default();
    if host == "localhost" || host == "agentero-web.localhost" {
        // The first path segment carries the upstream host.
        let rest = path.strip_prefix('/')?;
        let (upstream, tail) = rest.split_once('/')?;
        if upstream.is_empty() {
            return None;
        }
        Some(Target {
            host: upstream.to_string(),
            path_query: format!("/{tail}{query}"),
        })
    } else {
        Some(Target {
            host: host.to_string(),
            path_query: format!("{path}{query}"),
        })
    }
}

/// The proxy client: shared proxy config, but every redirect hop must itself
/// be allowlisted — reqwest's default follow would happily relay a hop into
/// hosts the frontend never allowed.
fn proxy_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        crate::core::http::client_builder()
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= crate::core::http::DEFAULT_REDIRECT_LIMIT {
                    return attempt.error("too many redirects");
                }
                match attempt.url().host_str() {
                    Some(host) if allowlist::is_allowed(host) => attempt.follow(),
                    // Error rather than `stop()`: a passed-through 3xx would
                    // navigate the frame to a real origin and silently drop
                    // the bridge.
                    _ => attempt.error("agentero-web: redirect target not allowed"),
                }
            }))
            .build()
            .expect("agentero-web proxy client builds")
    })
}

fn response(status: StatusCode, content_type: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .body(body)
        .expect("valid web proxy response")
}

/// Minimal HTML attribute escaping for the injected `<base>` URL.
fn escape_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
}

/// Byte offset just past the opening `<head …>` tag, if the document has one.
///
/// `<header …>` must not match: the character after `<head` has to be
/// whitespace or the tag close.
fn find_head_open(html: &str) -> Option<usize> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<head")?;
    let tag_end = start + lower[start..].find('>')?;
    let between = &lower[start + 5..tag_end];
    let next = between.chars().next();
    match next {
        None => Some(tag_end + 1),
        Some(c) if c.is_ascii_whitespace() => Some(tag_end + 1),
        _ => None,
    }
}

/// Prepare a proxied document: drop any in-HTML CSP, then inject the `<base>`
/// + bridge right after `<head>` opens.
///
/// The `<base>` must precede every URL-bearing node in `<head>` (stylesheets,
/// preload links) to steer their resolution to the real origin — injecting at
/// `</head>` the way the 广场 proxies do would leave early links resolving
/// against the proxy scheme.
fn inject_document(html: &str, base_url: &str) -> String {
    let html = strip_meta_csp(html);
    let head = format!("<base href=\"{}\">{}", escape_attr(base_url), WEB_BRIDGE);
    match find_head_open(&html) {
        Some(at) => format!("{}{}{}", &html[..at], head, &html[at..]),
        None => format!("{head}{html}"),
    }
}

/// Delete every `<meta http-equiv="content-security-policy">` tag.
///
/// Header CSP already dies in the response rebuild; this catches sites that
/// embed the policy in HTML instead. Tags may span lines, and the `http-equiv`
/// / `content` attributes may appear in either order, so the tag is parsed
/// attribute by attribute rather than pattern-matched. CSP values cannot
/// contain `>` (a policy with `>` is unparseable), so cutting each tag at the
/// next `>` cannot clip mid-value.
fn strip_meta_csp(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len());
    let mut copied = 0usize;
    let mut scan = 0usize;
    while let Some(found) = lower[scan..].find("<meta") {
        let start = scan + found;
        let Some(gt) = lower[start..].find('>').map(|at| start + at) else {
            break;
        };
        let end = gt + 1;
        if meta_sets_csp(&lower[start..end]) {
            out.push_str(&html[copied..start]);
            copied = end;
        }
        scan = end;
    }
    out.push_str(&html[copied..]);
    out
}

/// Whether a lowercased `<meta …>` tag (including its `>`) sets a CSP.
fn meta_sets_csp(tag: &str) -> bool {
    let bytes = tag.as_bytes();
    // `<metadata>`-style prefixes must not match (same caveat as
    // `find_head_open`'s `<header>` guard).
    match tag[5..].chars().next() {
        Some(c) if c.is_ascii_whitespace() || c == '>' || c == '/' => {}
        _ => return false,
    }
    let mut at = 5usize;
    while at < bytes.len() {
        while at < bytes.len() && bytes[at].is_ascii_whitespace() {
            at += 1;
        }
        let name_start = at;
        while at < bytes.len() && !bytes[at].is_ascii_whitespace() && bytes[at] != b'=' {
            at += 1;
        }
        let name = &tag[name_start..at];
        while at < bytes.len() && bytes[at].is_ascii_whitespace() {
            at += 1;
        }
        if at >= bytes.len() || bytes[at] != b'=' {
            // A valueless attribute (or stray text); nothing to compare.
            continue;
        }
        at += 1;
        while at < bytes.len() && bytes[at].is_ascii_whitespace() {
            at += 1;
        }
        let quoted = at < bytes.len() && (bytes[at] == b'"' || bytes[at] == b'\'');
        if quoted {
            at += 1;
        }
        let value_start = at;
        while at < bytes.len() {
            let b = bytes[at];
            if quoted && (b == b'"' || b == b'\'') {
                break;
            }
            if !quoted && (b.is_ascii_whitespace() || b == b'>') {
                break;
            }
            at += 1;
        }
        if name == "http-equiv" && &tag[value_start..at] == "content-security-policy" {
            return true;
        }
    }
    false
}

/// The `<base>` for a page served from `final_url` (after redirects): the
/// document URL minus its query, so relative links resolve as siblings.
fn base_url_for(final_url: &str) -> String {
    match final_url.split_once('?') {
        Some((without_query, _)) => without_query.to_string(),
        None => final_url.to_string(),
    }
}

pub fn handle(request: tauri::http::Request<Vec<u8>>, responder: tauri::UriSchemeResponder) {
    let Some(target) = target_from_uri(request.uri()) else {
        responder.respond(response(
            StatusCode::BAD_REQUEST,
            "text/plain",
            b"agentero-web: malformed request".to_vec(),
        ));
        return;
    };
    if !allowlist::is_allowed(&target.host) {
        log::warn!(target: "agentero::web_proxy", "refused host not allowed: {}", target.host);
        responder.respond(response(
            StatusCode::FORBIDDEN,
            "text/plain",
            format!("agentero-web: {} is not allowed here", target.host).into_bytes(),
        ));
        return;
    }
    let url = format!("https://{}{}", target.host, target.path_query);
    let (parts, body) = request.into_parts();

    tauri::async_runtime::spawn(async move {
        let result = async {
            let client = proxy_client();
            let method = reqwest::Method::from_bytes(parts.method.as_str().as_bytes())
                .unwrap_or(reqwest::Method::GET);
            let mut outgoing = client.request(method, url).header(
                reqwest::header::USER_AGENT,
                // Sites routinely refuse non-browser agents; the feeds fetcher
                // impersonates a browser for the same reason.
                crate::core::http::BROWSER_USER_AGENT,
            );
            for (name, value) in parts.headers.iter() {
                if crate::features::paper::discovery::proxy::is_forwardable(name.as_str()) {
                    outgoing = outgoing.header(name.as_str(), value.as_bytes());
                }
            }
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
            // The final URL after any redirects is what the document should
            // resolve its relative links against.
            let final_url = remote.url().to_string();
            let bytes = remote.bytes().await.map_err(|e| e.to_string())?;
            let body = if content_type.starts_with("text/html") {
                match String::from_utf8(bytes.to_vec()) {
                    Ok(text) if looks_like_document(&text) => {
                        inject_document(&text, &base_url_for(&final_url)).into_bytes()
                    }
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
                log::warn!(target: "agentero::web_proxy", "request failed: {error}");
                responder.respond(response(
                    StatusCode::BAD_GATEWAY,
                    "text/plain",
                    b"agentero-web: upstream unavailable".to_vec(),
                ));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uri(value: &str) -> tauri::http::Uri {
        value.parse().expect("test uri parses")
    }

    #[test]
    fn parses_host_in_path_shapes() {
        // macOS/Linux custom scheme.
        let t = target_from_uri(&uri("agentero-web://localhost/arxiv.org/abs/1234?fmt=html"))
            .expect("target");
        assert_eq!(t.host, "arxiv.org");
        assert_eq!(t.path_query, "/abs/1234?fmt=html");
        // Windows WebView2 form.
        let t = target_from_uri(&uri(
            "http://agentero-web.localhost/blog.nature.com/posts/x",
        ))
        .expect("target");
        assert_eq!(t.host, "blog.nature.com");
        assert_eq!(t.path_query, "/posts/x");
    }

    #[test]
    fn parses_direct_host_shape() {
        // Protocol-relative URLs resolved against the custom scheme.
        let t = target_from_uri(&uri("agentero-web://cdn.example.com/a/b.js?v=2")).expect("target");
        assert_eq!(t.host, "cdn.example.com");
        assert_eq!(t.path_query, "/a/b.js?v=2");
    }

    #[test]
    fn rejects_pathless_and_traversal_requests() {
        // No host segment to route to.
        assert!(target_from_uri(&uri("agentero-web://localhost/about")).is_none());
        assert!(target_from_uri(&uri("agentero-web://localhost//x")).is_none());
        // Traversal must never reach the upstream URL join.
        assert!(target_from_uri(&uri("agentero-web://localhost/arxiv.org/../secret")).is_none());
    }

    #[test]
    fn injects_base_and_bridge_after_head_open() {
        let html = "<html><head><title>t</title><link rel=\"stylesheet\" href=\"/css/main.css\"></head><body></body></html>";
        let out = inject_document(html, "https://arxiv.org/abs/1234");
        let base = out
            .find("<base href=\"https://arxiv.org/abs/1234\">")
            .expect("base");
        let bridge = out.find("agentero-web").expect("bridge");
        let title = out.find("<title>").expect("title after injections");
        // Both land before any URL-bearing node (the stylesheet link).
        let link = out.find("<link").expect("link");
        assert!(base < link && bridge < link && title > base);
        // The document is otherwise untouched.
        assert!(out.contains("</head>"));
        assert!(out.ends_with("</html>"));
    }

    #[test]
    fn does_not_mistake_header_for_head() {
        let html = "<html><body><header><h1>x</h1></header></body></html>";
        let out = inject_document(html, "https://example.com/a");
        // No <head> → prepended wholesale, body content preserved.
        let base = out
            .find("<base href=\"https://example.com/a\">")
            .expect("base");
        assert_eq!(base, 0);
        assert!(out.contains("<header>"));
    }

    #[test]
    fn escapes_the_base_url() {
        let out = inject_document("<html><head></head></html>", "https://x.com/a?b=1&c=<\"");
        assert!(out.contains("<base href=\"https://x.com/a?b=1&amp;c=&lt;&quot;\">"));
    }

    #[test]
    fn base_url_drops_the_query() {
        assert_eq!(base_url_for("https://x.com/a/b?pg=2"), "https://x.com/a/b");
        assert_eq!(base_url_for("https://x.com/a/b"), "https://x.com/a/b");
    }

    /// SvelteKit sites (e.g. justin.poehnelt.com) ship a multi-line CSP meta;
    /// left in place, its `style-src 'self'` blocks the site's own stylesheets
    /// once the `<base>` steers them to the real origin, and the page renders
    /// unstyled. (Fix: HTML-embedded CSP must not survive the proxy.)
    #[test]
    fn strips_multiline_csp_meta() {
        let html = "<html><head>\n<meta\n  http-equiv=\"Content-Security-Policy\"\n  content=\"default-src 'self'; style-src 'self' 'unsafe-inline'\">\n<link rel=\"stylesheet\" href=\"/app.css\"></head></html>";
        let out = inject_document(html, "https://x.com/a");
        assert!(!out.to_ascii_lowercase().contains("content-security-policy"));
        // Everything around the removed tag survives, including the stylesheet.
        assert!(out.contains("<link rel=\"stylesheet\" href=\"/app.css\">"));
        assert!(out.contains("<base href=\"https://x.com/a\">"));
        assert!(out.ends_with("</html>"));
    }

    #[test]
    fn strips_csp_meta_regardless_of_attribute_order_or_case() {
        // `content` first, mixed-case directive name, single quotes.
        let html = "<head><meta content='Content-Security-Policy' http-equiv='Content-Security-Policy'><title>t</title></head>";
        assert!(!strip_meta_csp(html)
            .to_lowercase()
            .contains("content-security-policy"));
        // Unquoted attribute value.
        assert!(
            !strip_meta_csp("<meta http-equiv=Content-Security-Policy content=x>").contains("CSP")
        );
    }

    #[test]
    fn keeps_unrelated_and_body_metas() {
        let html = "<head><meta charset=\"utf-8\"><meta name=\"description\" content=\"csp talk: Content-Security-Policy explained\"></head><body><p>a &lt; metaphor</p></body>";
        let out = strip_meta_csp(html);
        assert!(out.contains("<meta charset=\"utf-8\">"));
        assert!(out.contains("Content-Security-Policy explained"));
    }

    /// The bridge reports selections with a viewport rect the app positions
    /// its toolbar against.
    #[test]
    fn bridge_reports_selection_with_rect() {
        assert!(WEB_BRIDGE.contains("type: \"selection\""));
        assert!(WEB_BRIDGE.contains("rect = { x: r.left, y: r.top"));
        assert!(WEB_BRIDGE.contains("MAX_SELECTION_CHARS = 4000"));
    }

    /// Frame bindings come from the app; forwarded keys are resolved there.
    #[test]
    fn bridge_forwards_shortcuts() {
        assert!(WEB_BRIDGE.contains("\"quickChat\""));
        assert!(WEB_BRIDGE.contains("\"addSelectionToChat\""));
        assert!(WEB_BRIDGE.contains("\"toggleChat\""));
        assert!(WEB_BRIDGE.contains("data.type === \"shortcuts\""));
        // Editable targets keep their keystrokes (site search boxes, comment
        // forms).
        assert!(WEB_BRIDGE.contains("isEditable"));
    }

    /// Escape cannot cross the frame boundary; every proxied site must relay it
    /// so the app can close its selection chrome.
    #[test]
    fn bridge_relays_escape() {
        assert!(WEB_BRIDGE.contains("type: \"escape\""));
        assert!(WEB_BRIDGE.contains("event.key === \"Escape\""));
    }

    /// Same-site navigations stay proxied; foreign ones are handed to the app.
    #[test]
    fn bridge_confines_navigation() {
        assert!(WEB_BRIDGE.contains("location.assign(\"/\" + host"));
        assert!(WEB_BRIDGE.contains("type: \"external\""));
        // The private scheme must never escape to the system browser.
        assert!(WEB_BRIDGE.contains("url.protocol !== \"http:\" && url.protocol !== \"https:\""));
    }

    /// The app can ask the frame to clear its selection (post add-to-chat).
    #[test]
    fn bridge_honors_host_messages() {
        assert!(WEB_BRIDGE.contains("agentero-web-host"));
        assert!(WEB_BRIDGE.contains("clearSelection"));
    }
}
