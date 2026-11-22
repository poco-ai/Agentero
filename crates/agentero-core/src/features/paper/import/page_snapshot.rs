//! Readable snapshot of a web page, stored inside the paper folder it belongs to.
//!
//! A webpage import must stay readable when the origin is slow, gone, or behind
//! a WAF. Two derived files sit next to `NOTES.md`:
//!
//! - `webpage.html` — the Readability article wrapped in a complete document
//!   with `<base href>` so relative media still resolves; the local HTML view
//!   renders it in a sandboxed frame.
//! - `PAPER.md` — the Markdown body. `evidence_read`, search, and the agent
//!   read `PAPER.md` as a paper body, so a collected page is a first-class
//!   library object offline instead of a bare URL.
//!
//! Snapshots are derived data: a failed fetch or write is logged by the caller
//! and never fails the import. Re-imports and the recapture command refresh
//! them.

use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;
use url::Url;

use crate::error::AppError;
use crate::features::paper::discovery::feeds::body::{
    ensure_heading, extract_article_html, html_to_markdown,
};
use crate::http;

use super::openreview;
use super::web_verify;

/// Readable article snapshot rendered by the local HTML view.
pub const WEBPAGE_HTML_FILE: &str = "webpage.html";
/// Markdown body shared with `PAPER.md` consumers (search / evidence_read).
pub const WEBPAGE_BODY_FILE: &str = "PAPER.md";

/// Fetch budget for the page itself. Webpage imports run after the Translator
/// already spent its own budget.
const PAGE_TIMEOUT: Duration = Duration::from_secs(20);
/// Reader-visible text lives well inside this; guards memory on media pages.
const MAX_PAGE_BYTES: usize = 4 * 1024 * 1024;

/// Minimal reading typography for the standalone snapshot (the app frame has
/// no site CSS to inherit).
const READER_CSS: &str = ":root{color-scheme:light dark}\
body{margin:0 auto;max-width:46rem;padding:2rem 1.25rem 4rem;\
font:16px/1.75 -apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",\"Hiragino Sans GB\",sans-serif;\
overflow-wrap:break-word}\
img,video,svg{max-width:100%;height:auto}\
pre{overflow:auto;padding:.75rem;border-radius:.5rem;background:rgba(127,127,127,.12)}\
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em}\
table{border-collapse:collapse;display:block;overflow:auto}\
td,th{border:1px solid rgba(127,127,127,.35);padding:.3rem .6rem}\
blockquote{margin:0;padding-left:1rem;border-left:3px solid rgba(127,127,127,.35)}\
a{color:#2563eb}\
@media (prefers-color-scheme:dark){body{background:#111;color:#e5e5e5}a{color:#7aa7ff}}";

/// A page fetched for archiving: the redirect-resolved URL and its HTML.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedPage {
    pub final_url: String,
    pub html: String,
}

/// The two derived files written into a paper folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageSnapshot {
    pub html: String,
    pub markdown: String,
}

/// Fetch a reader-facing page like a browser.
///
/// Some WAFs answer the first visit with `403` + `Set-Cookie` + a JS reload
/// stub; replaying the request with the cookie jar returns the article (the
/// same exchange the feed reader performs for spaces.ac.cn). The
/// redirect-resolved URL is returned so metadata and `<base href>` use the
/// canonical final address.
///
/// Sites behind an interactive wall (OpenReview's Turnstile, Cloudflare's
/// `Just a moment…`) hand anonymous readers a challenge page instead of the
/// article. A cookie captured by the desktop verification window is attached
/// here before the first request; a challenge that still comes back asks the
/// Host to verify (a popup on this exact URL) and replays once.
pub async fn fetch_page(url: &str) -> Result<FetchedPage, AppError> {
    fetch_page_with_verification(url, true).await
}

pub(crate) async fn fetch_page_with_verification(
    url: &str,
    interactive: bool,
) -> Result<FetchedPage, AppError> {
    let url = url.trim();
    if !is_web_url(url) {
        return Err(AppError::message("page.url"));
    }
    let client = http::browser_client(PAGE_TIMEOUT)?;
    let mut page = get(&client, url, stored_cookie(url).as_deref()).await?;
    if interactive && verification_wall(&page) {
        let _ = web_verify::request_auth(url.to_string()).await;
        page = get(&client, url, stored_cookie(url).as_deref()).await?;
    }
    if verification_wall(&page) {
        return Err(verification_error(url));
    }
    if page.status == 403 && http::looks_like_js_challenge(&page.body) {
        page = get(&client, url, None).await?;
    }
    if !(200..300).contains(&page.status) {
        return Err(AppError::message(format!("page.http:{}", page.status)));
    }
    let html = String::from_utf8_lossy(&page.body).into_owned();
    if html.trim().is_empty() {
        return Err(AppError::message("page.empty"));
    }
    Ok(FetchedPage {
        final_url: page.final_url,
        html,
    })
}

struct RawPage {
    final_url: String,
    status: u16,
    headers: reqwest::header::HeaderMap,
    body: Vec<u8>,
}

/// Process cookie for `url`: the durable OpenReview credential first, then any
/// session credential captured for another site.
fn stored_cookie(url: &str) -> Option<String> {
    openreview::cookie_header_for(url).or_else(|| web_verify::cookie_header_for(url))
}

/// Whether the page is a verification wall: a Cloudflare/Turnstile challenge
/// body, OpenReview's `403`, or a redirect that landed on `/challenge`
/// (reqwest follows the 307 before we see it).
fn verification_wall(page: &RawPage) -> bool {
    openreview::looks_like_challenge(page.status, &page.body)
        || web_verify::challenge_detected(page.status, &page.headers, &page.body)
        || (Url::parse(&page.final_url)
            .ok()
            .is_some_and(|url| url.path().starts_with("/challenge")))
}

fn verification_error(url: &str) -> AppError {
    if openreview::is_openreview_url(url) {
        AppError::domain(
            "openreview_auth_required",
            "OpenReview requires browser verification before it serves the paper page; open Settings → General → OpenReview, complete the check, then retry",
        )
    } else {
        AppError::domain(
            "site_verification_required",
            "The site requires browser verification before it serves the page; retry the import and complete the verification window",
        )
    }
}

async fn get(
    client: &reqwest::Client,
    url: &str,
    cookie: Option<&str>,
) -> Result<RawPage, AppError> {
    let mut request = client.get(url).header(
        reqwest::header::ACCEPT,
        "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    );
    if let Some(cookie) = cookie.map(str::trim).filter(|value| !value.is_empty()) {
        request = request.header(reqwest::header::COOKIE, cookie);
    }
    let response = request
        .send()
        .await
        .map_err(|e| AppError::message(format!("page.fetch:{e}")))?;
    let final_url = response.url().to_string();
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let body = response
        .bytes()
        .await
        .map_err(|e| AppError::message(format!("page.body:{e}")))?;
    if body.len() > MAX_PAGE_BYTES {
        return Err(AppError::message("page.too_large"));
    }
    Ok(RawPage {
        final_url,
        status,
        headers,
        body: body.to_vec(),
    })
}

/// Build the two derived files from already-fetched HTML. No network.
pub fn snapshot_from_html(html: &str, page_url: &str, title: &str) -> PageSnapshot {
    let article = extract_article_html(html, Some(page_url));
    let content = if article.trim().is_empty() {
        // Readability rejects short or unusual pages; keep the readable body
        // rather than losing the page entirely.
        body_inner(html)
    } else {
        article
    };
    let content = absolutize_urls(&sanitize_html(&content), page_url);
    let markdown = ensure_heading(&html_to_markdown(&content), title);
    PageSnapshot {
        html: wrap_document(&content, page_url, title),
        markdown: markdown.trim_end().to_string(),
    }
}

/// Write (or replace) both snapshot files. Returns the total bytes written.
pub fn write_snapshot(paper_dir: &Path, snapshot: &PageSnapshot) -> Result<u64, AppError> {
    std::fs::create_dir_all(paper_dir)?;
    std::fs::write(paper_dir.join(WEBPAGE_HTML_FILE), snapshot.html.as_bytes())?;
    std::fs::write(
        paper_dir.join(WEBPAGE_BODY_FILE),
        snapshot.markdown.as_bytes(),
    )?;
    Ok((snapshot.html.len() + snapshot.markdown.len()) as u64)
}

/// Whether this folder already holds a readable page snapshot.
pub fn snapshot_present(paper_dir: &Path) -> bool {
    paper_dir.join(WEBPAGE_HTML_FILE).is_file()
}

/// Fetch `url` and replace this folder's snapshot files.
pub async fn fetch_and_write(paper_dir: &Path, url: &str, title: &str) -> Result<u64, AppError> {
    let page = fetch_page(url).await?;
    let snapshot = snapshot_from_html(&page.html, &page.final_url, title);
    write_snapshot(paper_dir, &snapshot)
}

fn is_web_url(text: &str) -> bool {
    let text = text.trim();
    text.starts_with("http://") || text.starts_with("https://")
}

fn wrap_document(content: &str, page_url: &str, title: &str) -> String {
    format!(
        "<!doctype html>\n<html>\n<head>\n\
         <meta charset=\"utf-8\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <title>{}</title>\n\
         <base href=\"{}\">\n\
         <style>{READER_CSS}</style>\n\
         </head>\n<body>\n<article class=\"agentero-webpage\">\n{}\n</article>\n</body>\n</html>\n",
        escape_attr(title.trim()),
        escape_attr(page_url.trim()),
        content.trim()
    )
}

fn escape_attr(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

macro_rules! static_regex {
    ($name:ident, $pattern:literal) => {
        fn $name() -> &'static Regex {
            static RE: OnceLock<Regex> = OnceLock::new();
            RE.get_or_init(|| Regex::new($pattern).expect("page snapshot regex is valid"))
        }
    };
}

static_regex!(script_block, r"(?is)<script\b[^>]*>.*?</script\s*>");
static_regex!(style_block, r"(?is)<style\b[^>]*>.*?</style\s*>");
static_regex!(noscript_block, r"(?is)<noscript\b[^>]*>.*?</noscript\s*>");
static_regex!(template_block, r"(?is)<template\b[^>]*>.*?</template\s*>");
static_regex!(iframe_block, r"(?is)<iframe\b[^>]*>.*?</iframe\s*>");
static_regex!(iframe_void, r"(?is)<iframe\b[^>]*/?>");
static_regex!(
    embedded_object,
    r"(?is)<(?:object|embed|frame|frameset)\b[^>]*>"
);
static_regex!(comment_block, r"(?s)<!--.*?-->");
static_regex!(
    event_handler_attr,
    r#"(?i)\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)"#
);
static_regex!(
    javascript_url_attr,
    r#"(?i)\b(href|src|poster)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)"#
);
static_regex!(
    custom_url_attr,
    r#"(?i)\b(src|href|poster)\s*=\s*"([^"]*)""#
);
static_regex!(body_block, r"(?is)<body\b[^>]*>(.*?)</body\s*>");
static_regex!(head_block, r"(?is)<head\b[^>]*>.*?</head\s*>");
static_regex!(document_tag, r"(?i)<?/?(?:html|body)\b[^>]*>");

/// Strip active content from an extracted article before it is stored and
/// rendered locally: scripts, styles, embedded frames, comments, inline event
/// handlers, and `javascript:` URLs.
fn sanitize_html(html: &str) -> String {
    let mut out = html.to_string();
    for remove in [
        script_block(),
        style_block(),
        noscript_block(),
        template_block(),
        iframe_block(),
        iframe_void(),
        embedded_object(),
        comment_block(),
    ] {
        out = remove.replace_all(&out, "").into_owned();
    }
    let without_handlers = event_handler_attr().replace_all(&out, "").into_owned();
    javascript_url_attr()
        .replace_all(&without_handlers, "$1=\"#\"")
        .into_owned()
}

/// Resolve relative `src`/`href`/`poster` attributes against the page URL so
/// the snapshot (and the Markdown body derived from it) keeps its media.
fn absolutize_urls(html: &str, page_url: &str) -> String {
    let Ok(base) = Url::parse(page_url) else {
        return html.to_string();
    };
    custom_url_attr()
        .replace_all(html, |caps: &regex::Captures<'_>| {
            let name = &caps[1];
            let raw = caps[2].trim();
            if raw.is_empty()
                || raw.starts_with('#')
                || raw.starts_with("data:")
                || raw.starts_with("mailto:")
                || raw.starts_with("javascript:")
            {
                return caps[0].to_string();
            }
            match base.join(raw) {
                Ok(absolute) => format!("{name}=\"{}\"", escape_attr(absolute.as_str())),
                Err(_) => caps[0].to_string(),
            }
        })
        .into_owned()
}

/// The `<body>` contents of a full page, minus document scaffolding.
fn body_inner(html: &str) -> String {
    if let Some(caps) = body_block().captures(html) {
        return caps
            .get(1)
            .map(|part| part.as_str().to_string())
            .unwrap_or_default();
    }
    let without_head = head_block().replace_all(html, "").into_owned();
    let without_tags = document_tag().replace_all(&without_head, "").into_owned();
    without_tags.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ARTICLE: &str = r#"<!DOCTYPE html><html><head>
<meta charset="utf-8">
<title>Site | Blog</title>
<script>window.tracker = "x";</script>
<style>body{color:red}</style>
</head><body>
<nav>menu</nav>
<article>
<h1>如何理解注意力机制</h1>
<p onclick="steal()">正文第一段，包含公式 $q^\top k$。</p>
<p><a href="javascript:void(0)">unused</a>
<a href="/relative/next">next</a>
<img src="images/diagram.png" alt="diagram">
<iframe src="https://example.com/embed"></iframe></p>
</article>
</body></html>"#;

    #[test]
    fn openreview_challenge_is_detected_from_redirect_and_body() {
        let page = |final_url: &str, status: u16, body: &[u8]| RawPage {
            final_url: final_url.to_string(),
            status,
            headers: reqwest::header::HeaderMap::new(),
            body: body.to_vec(),
        };
        // An anonymous visit is redirected to /challenge; reqwest follows the
        // 307 so the challenge page itself answers 200.
        assert!(verification_wall(&page(
            "https://openreview.net/challenge?redirect=%2Fforum%3Fid%3Dx",
            200,
            b"<html>Verifying your browser</html>"
        )));
        assert!(verification_wall(&page(
            "https://openreview.net/forum?id=x",
            403,
            b"<html>Verifying your browser</html>"
        )));
        assert!(!verification_wall(&page(
            "https://openreview.net/forum?id=x",
            200,
            b"<html>paper page</html>"
        )));
    }

    #[test]
    fn snapshot_wraps_article_with_base_url_and_strips_active_content() {
        let snap = snapshot_from_html(
            ARTICLE,
            "https://example.com/notes/post/",
            "如何理解注意力机制",
        );
        assert!(snap.html.starts_with("<!doctype html>"));
        assert!(snap
            .html
            .contains("<base href=\"https://example.com/notes/post/\">"));
        assert!(snap.html.contains("<title>如何理解注意力机制</title>"));
        assert!(snap.html.contains("正文第一段"));
        assert!(!snap.html.contains("<script"));
        assert!(!snap.html.contains("onclick"));
        assert!(!snap.html.contains("<style>body"));
        assert!(!snap.html.to_lowercase().contains("javascript:"));
        assert!(snap
            .html
            .contains("src=\"https://example.com/notes/post/images/diagram.png\""));
        assert!(snap.markdown.starts_with("# 如何理解注意力机制"));
        assert!(snap.markdown.contains("正文第一段"));
        assert!(!snap.markdown.contains("<p>"));
        assert!(!snap.html.contains("<iframe"));
    }

    #[test]
    fn short_page_falls_back_to_the_body_without_readability() {
        let html = "<html><head><title>x</title></head><body><p>tiny note</p></body></html>";
        let snap = snapshot_from_html(html, "https://example.com/x", "");
        assert!(snap.html.contains("<p>tiny note</p>"));
        assert!(snap.markdown.contains("tiny note"));
        assert!(!snap.html.contains("<html><head><title>x"));
    }

    #[test]
    fn snapshot_detection_and_write() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!snapshot_present(dir.path()));
        let snap = PageSnapshot {
            html: "<!doctype html><p>body</p>".into(),
            markdown: "# title\n\nbody".into(),
        };
        let bytes = write_snapshot(dir.path(), &snap).unwrap();
        assert_eq!(bytes as usize, snap.html.len() + snap.markdown.len());
        assert!(dir.path().join(WEBPAGE_HTML_FILE).is_file());
        assert!(dir.path().join(WEBPAGE_BODY_FILE).is_file());
        assert!(snapshot_present(dir.path()));
    }

    #[test]
    fn escape_attr_keeps_attribute_values_inert() {
        assert_eq!(escape_attr(r#"a"b<c>&"#), "a&quot;b&lt;c&gt;&amp;");
    }
}
