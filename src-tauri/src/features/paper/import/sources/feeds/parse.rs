//! Feed parsing, HTML autodiscovery, URL normalization, paper-id extraction.

use crate::core::error::AppError;
use crate::features::import::extract_arxiv_id;
use feed_rs::model::{Entry, Feed};
use feed_rs::parser;
use url::Url;

#[derive(Debug, Clone)]
pub struct ParsedFeed {
    pub title: String,
    pub items: Vec<ParsedItem>,
}

#[derive(Debug, Clone)]
pub struct ParsedItem {
    pub guid: String,
    pub title: String,
    pub url: Option<String>,
    pub published_at: Option<String>,
    pub summary_text: String,
    pub content_html: Option<String>,
    pub paper_url: Option<String>,
}

pub fn normalize_feed_url(raw: &str) -> Result<String, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::message("feeds.invalid_url"));
    }
    let parsed = Url::parse(trimmed).map_err(|_| AppError::message("feeds.invalid_url"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(AppError::message("feeds.invalid_url"));
    }
    if parsed.host_str().is_none() {
        return Err(AppError::message("feeds.invalid_url"));
    }
    let mut out = parsed;
    if let Some(host) = out.host_str() {
        let lower = host.to_ascii_lowercase();
        let _ = out.set_host(Some(&lower));
    }
    out.set_fragment(None);
    if out.path() != "/" {
        let path = out.path().trim_end_matches('/').to_string();
        out.set_path(&path);
    }
    Ok(out.to_string())
}

pub fn looks_like_html(content_type: &str, body: &str) -> bool {
    let ct = content_type.to_ascii_lowercase();
    if ct.contains("rss") || ct.contains("atom") || ct.contains("xml") || ct.contains("json") {
        return false;
    }
    if ct.contains("text/html") {
        return true;
    }
    let start = body.trim_start();
    let head = start.get(..64).unwrap_or(start).to_ascii_lowercase();
    head.starts_with("<!doctype html") || head.starts_with("<html")
}

/// First `<link rel=alternate>` whose type is RSS / Atom / JSON Feed.
pub fn discover_feed_href(html: &str) -> Option<String> {
    let mut best: Option<(u8, String)> = None;
    let lower = html.to_ascii_lowercase();
    let mut from = 0;
    while let Some(rel) = lower[from..].find("<link") {
        let start = from + rel;
        let Some(end_off) = lower[start..].find('>') else {
            break;
        };
        let end = start + end_off + 1;
        from = end;
        let tag = &html[start..end];
        let tag_l = &lower[start..end];
        if !rel_is_alternate(tag_l) {
            continue;
        }
        let ty = attr(tag, tag_l, "type").unwrap_or_default();
        let href = attr(tag, tag_l, "href")?;
        let pri = feed_type_priority(&ty)?;
        if best.as_ref().is_none_or(|(p, _)| pri < *p) {
            best = Some((pri, href));
        }
    }
    best.map(|(_, href)| href)
}

pub fn resolve_href(base: &str, href: &str) -> Result<String, AppError> {
    let base_url = Url::parse(base).map_err(|_| AppError::message("feeds.invalid_url"))?;
    let joined = base_url
        .join(href.trim())
        .map_err(|_| AppError::message("feeds.invalid_url"))?;
    normalize_feed_url(joined.as_str())
}

pub fn parse_feed_bytes(bytes: &[u8], fallback_title: &str) -> Result<ParsedFeed, AppError> {
    let feed = parser::parse(bytes).map_err(|e| AppError::message(format!("feeds.parse:{e}")))?;
    Ok(parsed_from_model(feed, fallback_title))
}

fn parsed_from_model(feed: Feed, fallback_title: &str) -> ParsedFeed {
    let title = feed
        .title
        .as_ref()
        .map(|t| t.content.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback_title)
        .to_string();
    let items = feed.entries.into_iter().filter_map(parse_entry).collect();
    ParsedFeed { title, items }
}

fn parse_entry(entry: Entry) -> Option<ParsedItem> {
    let url = entry_url(&entry);
    let title = entry
        .title
        .as_ref()
        .map(|t| t.content.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| url.clone())
        .unwrap_or_else(|| entry.id.clone());
    if title.is_empty() && url.is_none() {
        return None;
    }
    let guid = if !entry.id.trim().is_empty() {
        entry.id.trim().to_string()
    } else if let Some(ref u) = url {
        u.clone()
    } else {
        title.clone()
    };
    let published_at = entry
        .published
        .or(entry.updated)
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    let content_html = entry
        .content
        .as_ref()
        .and_then(|c| c.body.clone())
        .filter(|s| !s.trim().is_empty());
    let summary_src = entry
        .summary
        .as_ref()
        .map(|t| t.content.as_str())
        .or(content_html.as_deref())
        .unwrap_or("");
    let summary_text = clean_summary_text(summary_src);
    let paper_url = extract_paper_url(&[
        url.as_deref().unwrap_or(""),
        &entry.id,
        &title,
        &summary_text,
        content_html.as_deref().unwrap_or(""),
    ]);
    Some(ParsedItem {
        guid,
        title,
        url,
        published_at,
        summary_text,
        content_html,
        paper_url,
    })
}

fn entry_url(entry: &Entry) -> Option<String> {
    let alternate = entry
        .links
        .iter()
        .find(|l| l.rel.as_deref() == Some("alternate"))
        .or_else(|| entry.links.first())?;
    let href = alternate.href.trim();
    if href.is_empty() {
        None
    } else {
        Some(href.to_string())
    }
}

pub fn extract_paper_url(parts: &[&str]) -> Option<String> {
    let blob = parts.join("\n").replace("rss.arxiv.org", "arxiv.org");
    if let Some(id) = find_arxiv_id(&blob) {
        return Some(format!("https://arxiv.org/abs/{id}"));
    }
    if let Some(doi) = find_doi(&blob) {
        return Some(format!("https://doi.org/{doi}"));
    }
    // Deterministic last resort for feeds that only link the publisher page.
    find_nature_doi_url(&blob)
}

/// Nature article URLs embed the DOI suffix: `nature.com/articles/<slug>` maps
/// to `https://doi.org/10.1038/<slug>`. Only research-article slugs qualify
/// (`s<journal>-…` and legacy `nature…`); news-magazine pages (`d41586-…`)
/// and anything else are left alone as regular stories.
fn find_nature_doi_url(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    let mut from = 0;
    while let Some(idx) = lower[from..].find("nature.com/articles/") {
        let start = from + idx + "nature.com/articles/".len();
        let rest = &lower[start..];
        let token = rest
            .split(|c: char| c.is_whitespace() || matches!(c, '?' | '#' | '"' | '\'' | '<' | '&'))
            .next()
            .unwrap_or(rest)
            .trim_end_matches(['.', ',', ')', ']']);
        if is_nature_article_slug(token) {
            return Some(format!("https://doi.org/10.1038/{token}"));
        }
        from = start;
    }
    None
}

fn is_nature_article_slug(slug: &str) -> bool {
    // Modern: s41592-026-03201-y / s41467-026-76837-1 — journal code, year,
    // sequence, check char. Legacy: nature12373.
    let parts: Vec<&str> = slug.split('-').collect();
    (slug.starts_with('s')
        && parts.len() == 4
        && parts[0][1..].len() == 5
        && parts[0][1..].bytes().all(|b| b.is_ascii_digit())
        && parts[1].len() >= 2
        && parts[1].bytes().all(|b| b.is_ascii_digit())
        && parts[2].len() >= 4
        && parts[2].bytes().all(|b| b.is_ascii_alphanumeric())
        && parts[3].len() == 1
        && parts[3].bytes().all(|b| b.is_ascii_alphanumeric()))
        || (slug.starts_with("nature")
            && slug.len() > 6
            && slug[6..].bytes().all(|b| b.is_ascii_digit()))
}

fn find_arxiv_id(text: &str) -> Option<String> {
    if let Some(id) = extract_arxiv_id(text) {
        return Some(id);
    }
    let lower = text.to_ascii_lowercase();
    for needle in ["arxiv.org/abs/", "arxiv.org/pdf/", "arxiv.org/html/"] {
        if let Some(idx) = lower.find(needle) {
            let rest = &text[idx + needle.len()..];
            let token = rest
                .split(|c: char| c.is_whitespace() || matches!(c, '?' | '#' | '"' | '\'' | '<'))
                .next()
                .unwrap_or(rest);
            if let Some(id) = extract_arxiv_id(&format!("https://arxiv.org/abs/{token}")) {
                return Some(id);
            }
        }
    }
    for (idx, _) in lower.match_indices("arxiv:") {
        let rest = text[idx + "arxiv:".len()..].trim_start();
        let token = rest
            .split(|c: char| c.is_whitespace() || matches!(c, ')' | ']' | ',' | ';' | '"' | '\''))
            .next()
            .unwrap_or(rest);
        if let Some(id) = extract_arxiv_id(token) {
            return Some(id);
        }
    }
    None
}

fn find_doi(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    let start = if let Some(i) = lower.find("doi.org/") {
        i + "doi.org/".len()
    } else if let Some(i) = lower.find("doi:") {
        i + "doi:".len()
    } else {
        lower.find("10.")?
    };
    let rest = text[start..].trim_start();
    let cand = rest
        .split(|c: char| c.is_whitespace() || matches!(c, '<' | '"' | '\'' | ',' | ';'))
        .next()
        .unwrap_or(rest)
        .trim_end_matches(['.', ',', ')', ']']);
    if cand.starts_with("10.") && cand.contains('/') {
        Some(cand.to_string())
    } else {
        None
    }
}

/// Drop arXiv RSS boilerplate (`arXiv:…`, `Announce Type:`, `Abstract:`) so
/// the card/detail show the actual abstract.
pub fn clean_summary_text(input: &str) -> String {
    let mut rest = strip_html(input);
    loop {
        let trimmed = rest.trim();
        if trimmed.is_empty() {
            return String::new();
        }
        let lower = trimmed.to_ascii_lowercase();
        if let Some(next) = strip_labeled_prefix(trimmed, &lower, "arxiv:") {
            rest = next;
            continue;
        }
        if let Some(next) = strip_labeled_prefix(trimmed, &lower, "announce type:") {
            rest = next;
            continue;
        }
        if let Some(next) = strip_labeled_prefix(trimmed, &lower, "comments:") {
            rest = next;
            continue;
        }
        if let Some(next) = strip_labeled_prefix(trimmed, &lower, "subjects:") {
            rest = next;
            continue;
        }
        if let Some(next) = strip_labeled_prefix(trimmed, &lower, "journal-ref:") {
            rest = next;
            continue;
        }
        if let Some(next) = strip_labeled_prefix(trimmed, &lower, "report-no:") {
            rest = next;
            continue;
        }
        if let Some(next) = strip_labeled_prefix(trimmed, &lower, "license:") {
            rest = next;
            continue;
        }
        if let Some(next) = strip_labeled_prefix(trimmed, &lower, "abstract:") {
            rest = next;
            continue;
        }
        break;
    }
    rest.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn strip_labeled_prefix(orig: &str, lower: &str, label: &str) -> Option<String> {
    if !lower.starts_with(label) {
        return None;
    }
    let after = orig.get(label.len()..)?.trim_start();
    if label == "abstract:" {
        return Some(after.to_string());
    }
    let skip = after
        .find(|c: char| c.is_whitespace())
        .unwrap_or(after.len());
    Some(after[skip..].trim_start().to_string())
}

pub fn strip_html(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;
    for ch in input.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    let decoded = decode_entities(&out);
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn decode_entities(s: &str) -> String {
    s.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
}

fn rel_is_alternate(tag_lower: &str) -> bool {
    let Some(rel) = attr_from_lower(tag_lower, "rel") else {
        return false;
    };
    rel.split(|c: char| c.is_whitespace() || c == ',')
        .any(|t| t == "alternate")
}

fn feed_type_priority(ty: &str) -> Option<u8> {
    if ty.contains("rss") {
        Some(0)
    } else if ty.contains("atom") {
        Some(1)
    } else if ty.contains("json") {
        Some(2)
    } else {
        None
    }
}

fn attr(orig: &str, lower: &str, name: &str) -> Option<String> {
    let needle = format!("{name}=");
    let idx = lower.find(&needle)?;
    let rest_orig = &orig[idx + needle.len()..];
    let rest_l = &lower[idx + needle.len()..];
    let quote = rest_l.as_bytes().first().copied();
    if quote == Some(b'"') || quote == Some(b'\'') {
        let q = quote? as char;
        let end = rest_orig[1..].find(q)?;
        Some(rest_orig[1..1 + end].trim().to_string())
    } else {
        let end = rest_orig
            .find(|c: char| c.is_whitespace() || c == '/' || c == '>')
            .unwrap_or(rest_orig.len());
        Some(rest_orig[..end].trim().to_string())
    }
}

fn attr_from_lower(lower: &str, name: &str) -> Option<String> {
    attr(lower, lower, name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_url() {
        assert_eq!(
            normalize_feed_url("https://RSS.ArXiv.ORG/rss/cs.LG/").unwrap(),
            "https://rss.arxiv.org/rss/cs.LG"
        );
        assert!(normalize_feed_url("ftp://x").is_err());
        assert!(normalize_feed_url("not a url").is_err());
    }

    #[test]
    fn discovers_rss_link() {
        let html = r#"<html><head>
          <link rel="stylesheet" href="/app.css">
          <link rel="alternate" type="application/rss+xml" href="/feed.xml" title="x">
        </head></html>"#;
        assert_eq!(discover_feed_href(html).as_deref(), Some("/feed.xml"));
        assert_eq!(
            resolve_href("https://example.com/blog", "/feed.xml").unwrap(),
            "https://example.com/feed.xml"
        );
    }

    #[test]
    fn paper_url_from_arxiv_and_doi() {
        assert_eq!(
            extract_paper_url(&["https://rss.arxiv.org/abs/1706.03762v1"]).as_deref(),
            Some("https://arxiv.org/abs/1706.03762")
        );
        assert_eq!(
            extract_paper_url(&["See doi:10.1038/nature12373 today"]).as_deref(),
            Some("https://doi.org/10.1038/nature12373")
        );
        assert_eq!(extract_paper_url(&["just a blog post"]), None);
    }

    #[test]
    fn paper_url_from_nature_article_slug() {
        // Subject feeds (e.g. Nature Communications health sciences) link
        // only the article page — the slug is the DOI suffix.
        assert_eq!(
            extract_paper_url(&["https://www.nature.com/articles/s41467-026-76837-1"]).as_deref(),
            Some("https://doi.org/10.1038/s41467-026-76837-1")
        );
        assert_eq!(
            extract_paper_url(&["https://www.nature.com/articles/s41592-026-03201-y"]).as_deref(),
            Some("https://doi.org/10.1038/s41592-026-03201-y")
        );
        // Legacy short slug.
        assert_eq!(
            extract_paper_url(&["https://www.nature.com/articles/nature12373"]).as_deref(),
            Some("https://doi.org/10.1038/nature12373")
        );
        // News-magazine pages are not papers.
        assert_eq!(
            extract_paper_url(&["https://www.nature.com/articles/d41586-026-01674-2"]),
            None
        );
        // Non-article nature.com paths stay stories.
        assert_eq!(
            extract_paper_url(&["https://www.nature.com/nature/articles?type=news"]),
            None
        );
        // Query strings / trailing markup do not leak into the slug.
        assert_eq!(
            extract_paper_url(&[
                r#"<link>https://www.nature.com/articles/s41563-026-01234-w?from=feed</link>"#
            ])
            .as_deref(),
            Some("https://doi.org/10.1038/s41563-026-01234-w")
        );
        // An explicit DOI in the item still wins over the slug guess.
        assert_eq!(
            extract_paper_url(&[
                "https://www.nature.com/articles/s41467-026-76837-1",
                "doi: 10.1100/other-paper"
            ])
            .as_deref(),
            Some("https://doi.org/10.1100/other-paper")
        );
    }

    #[test]
    fn strips_html_summary() {
        assert_eq!(
            strip_html("<p>Hello&nbsp;<b>world</b> &amp; friends</p>"),
            "Hello world & friends"
        );
    }

    #[test]
    fn strips_arxiv_rss_boilerplate() {
        let raw = "arXiv:1706.03762\nAnnounce Type: new\nAbstract: The dominant sequence transduction models.";
        assert_eq!(
            clean_summary_text(raw),
            "The dominant sequence transduction models."
        );
        assert_eq!(
            clean_summary_text(
                "arXiv:2608.08516 Announce Type: replace Abstract: We study transformers."
            ),
            "We study transformers."
        );
    }

    #[test]
    fn parses_rss_fixture() {
        let rss = br#"<?xml version="1.0"?>
        <rss version="2.0"><channel>
          <title>cs.LG</title>
          <item>
            <title>Attention Is All You Need</title>
            <link>https://arxiv.org/abs/1706.03762</link>
            <guid>https://arxiv.org/abs/1706.03762</guid>
            <description>Transformer architecture.</description>
          </item>
        </channel></rss>"#;
        let parsed = parse_feed_bytes(rss, "fallback").unwrap();
        assert_eq!(parsed.title, "cs.LG");
        assert_eq!(parsed.items.len(), 1);
        assert_eq!(parsed.items[0].title, "Attention Is All You Need");
        assert_eq!(
            parsed.items[0].paper_url.as_deref(),
            Some("https://arxiv.org/abs/1706.03762")
        );
    }
}
