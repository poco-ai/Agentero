//! Import a web page when the Translator Runtime cannot.
//!
//! A 503 / Cloudflare 1102 from the translation service used to fail the whole
//! import whenever the URL had no DOI, arXiv id, or PMID. The page itself is
//! enough to create an entry: citation metadata for a paper landing page, and
//! the URL plus title and description for an ordinary page.

use std::time::Duration;

use crate::error::AppError;
use crate::features::paper::catalog::papers::{PaperKind, PaperRecord};
use crate::features::paper::discovery::coolpapers::decode_entities;
use crate::features::paper::import::api_mapper::{api_paper_to_meta, enrich_remote_urls};
use crate::features::scholar_api::client;
use crate::features::scholar_api::identifiers::{
    clean_doi, doi_slug, extract_arxiv_id, fetch_direct_fallback, strip_arxiv_version,
};
use crate::features::scholar_api::ApiError;

use super::{check_task_not_cancelled, slug_from_stem, ResolvedMetadata};

/// How long to wait for the original page. Shorter than the translator's
/// 60s budget: this path only runs after that service has already failed.
const PAGE_TIMEOUT: Duration = Duration::from_secs(15);
/// Meta tags live in the head. Keep the prefix we parse bounded.
const PARSE_PREFIX_BYTES: usize = 512 * 1024;

/// Translator failure kept structured so retries, logs, and the user-facing
/// token share one classification.
#[derive(Debug, Clone)]
pub(crate) struct TranslatorFailure {
    pub status: Option<u16>,
    pub code: Option<u16>,
    pub detail: String,
    pub cancelled: bool,
}

impl TranslatorFailure {
    pub(crate) fn from_api(err: ApiError) -> Self {
        match err {
            ApiError::Cancelled => Self {
                status: None,
                code: None,
                detail: "cancelled".into(),
                cancelled: true,
            },
            ApiError::Unavailable(err) => Self {
                status: Some(err.status),
                code: err.code,
                detail: err.detail,
                cancelled: false,
            },
            other => Self {
                status: None,
                code: None,
                detail: other.to_string(),
                cancelled: false,
            },
        }
    }

    pub(crate) fn other(detail: impl Into<String>) -> Self {
        Self {
            status: None,
            code: None,
            detail: detail.into(),
            cancelled: false,
        }
    }

    fn token(&self) -> String {
        format!(
            "{}|{}",
            self.status.unwrap_or(0),
            self.code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "-".into())
        )
    }

    fn summary(&self) -> String {
        match self.status {
            Some(status) => {
                let code = self
                    .code
                    .map(|code| format!(", error code: {code}"))
                    .unwrap_or_default();
                format!("HTTP {status}{code}")
            }
            None => self.detail.clone(),
        }
    }
}

impl std::fmt::Display for TranslatorFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.summary())
    }
}

/// What to do after the translator misses and the identifier chains have
/// reported whether they matched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TranslatorMissPlan {
    UseIdentifier,
    ImportWebpage,
    Fail,
}

pub(crate) fn is_web_url(text: &str) -> bool {
    let text = text.trim();
    text.starts_with("http://") || text.starts_with("https://")
}

pub(crate) fn plan_after_translator_miss(
    text: &str,
    identifier_matched: bool,
) -> TranslatorMissPlan {
    if identifier_matched {
        TranslatorMissPlan::UseIdentifier
    } else if is_web_url(text) {
        TranslatorMissPlan::ImportWebpage
    } else {
        TranslatorMissPlan::Fail
    }
}

/// Continue an import after the translator failed.
///
/// Identifier chains still win when the input contains a DOI, arXiv id, or
/// PMID. A web URL with no such identifier — or whose chain also failed — is
/// imported from the page. Anything else stays a classified error.
pub(crate) async fn recover_metadata(
    text: &str,
    translator_base: &str,
    task_id: Option<&str>,
    failure: TranslatorFailure,
) -> Result<ResolvedMetadata, AppError> {
    if failure.cancelled {
        return Err(AppError::message("background task cancelled"));
    }
    check_task_not_cancelled(task_id)?;
    log::warn!(
        target: "agentero::lookup",
        "translator unavailable at {translator_base} ({failure})"
    );

    let fallback = fetch_direct_fallback(text, task_id).await;
    if let Some(Err(err)) = &fallback {
        if err.code() == "cancelled" {
            return Err(AppError::message("background task cancelled"));
        }
    }
    let identifier_matched = matches!(fallback, Some(Ok(_)));
    match plan_after_translator_miss(text, identifier_matched) {
        TranslatorMissPlan::UseIdentifier => {
            let paper = fallback
                .expect("plan only selects identifier when the chain hit")
                .expect("Ok checked above");
            log::info!(
                target: "agentero::lookup",
                "translator unavailable; resolved \"{}\" through the direct-connect identifier chain",
                paper.title
            );
            Ok(ResolvedMetadata {
                record: api_paper_to_meta(&paper),
                used_translator: false,
                notices: Vec::new(),
            })
        }
        TranslatorMissPlan::Fail => {
            if let Some(Err(err)) = fallback {
                log::warn!(
                    target: "agentero::lookup",
                    "translator unavailable and the identifier chain failed: {err}"
                );
                return Err(err);
            }
            log::warn!(
                target: "agentero::lookup",
                "translator unavailable ({}); input is not a web page and no DOI, arXiv ID, or PMID matched",
                failure.summary()
            );
            Err(unavailable_error(&failure, translator_base))
        }
        TranslatorMissPlan::ImportWebpage => {
            if let Some(Err(err)) = &fallback {
                log::warn!(
                    target: "agentero::lookup",
                    "identifier chain failed ({err}); importing the web page directly"
                );
            } else {
                log::info!(
                    target: "agentero::lookup",
                    "no DOI, arXiv ID, or PMID in {text}; importing the web page directly"
                );
            }
            import_webpage(text.trim(), translator_base, task_id, &failure).await
        }
    }
}

async fn import_webpage(
    url: &str,
    translator_base: &str,
    task_id: Option<&str>,
    failure: &TranslatorFailure,
) -> Result<ResolvedMetadata, AppError> {
    check_task_not_cancelled(task_id)?;
    let (record, mode) = match fetch_page_html(url).await {
        Ok(html) => {
            let parsed = record_from_html(url, &html);
            let record = enrich_page_record(parsed, url, task_id).await?;
            (record, "page")
        }
        Err(err) => {
            log::warn!(
                target: "agentero::lookup",
                "web page fetch failed for {url} ({err}); saving the URL without page metadata"
            );
            (record_from_url(url), "url_only")
        }
    };
    log::info!(
        target: "agentero::lookup",
        "imported web page without translator url={url} title=\"{}\" type={} mode={mode}",
        record.title,
        record.paper_type.as_str()
    );
    let notice = format!(
        "translator_degraded|{}|{mode}|{translator_base}",
        failure.token()
    );
    Ok(ResolvedMetadata {
        record,
        used_translator: false,
        notices: vec![notice],
    })
}

/// When the page itself carries a DOI that was not already in the URL, ask
/// the direct-connect chain once. A chain failure keeps the page metadata.
async fn enrich_page_record(
    page: PaperRecord,
    page_url: &str,
    task_id: Option<&str>,
) -> Result<PaperRecord, AppError> {
    let Some(doi) = page.doi.clone() else {
        return Ok(page);
    };
    if clean_doi(page_url).as_deref() == Some(doi.as_str()) {
        return Ok(page);
    }
    match fetch_direct_fallback(&doi, task_id).await {
        Some(Ok(paper)) => {
            log::info!(
                target: "agentero::lookup",
                "web page DOI {doi} resolved through the direct-connect chain"
            );
            Ok(merge_page_with_api(
                page,
                api_paper_to_meta(&paper),
                page_url,
            ))
        }
        Some(Err(err)) if err.code() == "cancelled" => {
            Err(AppError::message("background task cancelled"))
        }
        Some(Err(err)) => {
            log::warn!(
                target: "agentero::lookup",
                "web page DOI {doi} chain failed ({err}); keeping page metadata"
            );
            Ok(page)
        }
        None => Ok(page),
    }
}

fn merge_page_with_api(page: PaperRecord, mut api: PaperRecord, page_url: &str) -> PaperRecord {
    if api
        .source_url
        .as_ref()
        .is_none_or(|url| url.contains("doi.org"))
    {
        api.source_url = Some(page_url.to_string());
    }
    if api.html_url.is_none() {
        api.html_url = page.html_url.clone().or_else(|| Some(page_url.to_string()));
    }
    if api.pdf_url.is_none() {
        api.pdf_url = page.pdf_url.clone();
    }
    if api.abstract_text.is_none() {
        api.abstract_text = page.abstract_text.clone();
    }
    if api.authors.is_empty() {
        api.authors = page.authors.clone();
    }
    let source = api.meta_source.unwrap_or_else(|| "direct".into());
    api.meta_source = Some(format!("{source}+webpage"));
    api
}

fn unavailable_error(failure: &TranslatorFailure, translator_base: &str) -> AppError {
    AppError::domain(
        "translator_unavailable",
        format!(
            "translator_unavailable|{}|{translator_base} translation service unavailable ({}); input is not a web page and no DOI, arXiv ID, or PMID matched",
            failure.token(),
            failure.summary()
        ),
    )
}

async fn fetch_page_html(url: &str) -> Result<String, AppError> {
    let html = client::get_text_with_timeout(url, PAGE_TIMEOUT)
        .await
        .map_err(|err| AppError::message(err.to_string()))?;
    Ok(parse_prefix(&html))
}

fn parse_prefix(html: &str) -> String {
    if html.len() <= PARSE_PREFIX_BYTES {
        return html.to_string();
    }
    let mut end = PARSE_PREFIX_BYTES.min(html.len());
    while end > 0 && !html.is_char_boundary(end) {
        end -= 1;
    }
    html[..end].to_string()
}

/// Build a catalog record from a fetched page. No network.
pub(crate) fn record_from_html(page_url: &str, html: &str) -> PaperRecord {
    let meta = parse_html_meta(html);
    let title = meta
        .first(&["citation_title", "og:title", "twitter:title"])
        .map(str::to_string)
        .or_else(|| meta.title.clone())
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| title_from_url(page_url));
    let doi = meta
        .first(&["citation_doi", "dc.identifier", "dc.identifier.doi"])
        .and_then(clean_doi);
    let arxiv = meta
        .first(&["citation_arxiv_id"])
        .and_then(extract_arxiv_id)
        .or_else(|| extract_arxiv_id(page_url));
    let authors = if !meta.authors.is_empty() {
        meta.authors.clone()
    } else {
        meta.first(&["citation_authors", "author"])
            .map(split_authors)
            .unwrap_or_default()
    };
    let (date, year) = meta
        .first(&[
            "citation_publication_date",
            "citation_date",
            "citation_online_date",
            "citation_year",
            "article:published_time",
        ])
        .map(normalize_date)
        .unwrap_or((None, None));
    let pdf_url = meta
        .first(&["citation_pdf_url"])
        .filter(|url| url.starts_with("http://") || url.starts_with("https://"))
        .map(str::to_string);
    let canonical = meta.canonical.clone().filter(|url| is_web_url(url));
    let description = meta
        .first(&[
            "citation_abstract",
            "og:description",
            "description",
            "twitter:description",
        ])
        .map(|text| text.chars().take(4000).collect::<String>());
    let publication = meta
        .first(&["citation_journal_title", "citation_conference_title"])
        .map(str::to_string);
    let publisher = meta.first(&["citation_publisher"]).map(str::to_string);
    let pages = pages_from_meta(&meta);

    let paper_type = if arxiv.is_some() {
        PaperKind::Arxiv
    } else if doi.is_some() {
        PaperKind::Doi
    } else {
        PaperKind::Html
    };
    let id = page_id(page_url, &title, doi.as_deref(), arxiv.as_deref());
    let mut record = PaperRecord::local_pdf(id, title);
    record.paper_type = paper_type;
    record.authors = authors;
    record.year = year;
    record.date = date;
    record.abstract_text = description;
    record.doi = doi;
    record.arxiv_id = arxiv.map(|id| strip_arxiv_version(&id));
    record.publication = publication;
    record.publisher = publisher;
    record.pages = pages;
    record.volume = meta.first(&["citation_volume"]).map(str::to_string);
    record.issue = meta.first(&["citation_issue"]).map(str::to_string);
    record.pdf_url = pdf_url;
    record.html_url = canonical.clone().or_else(|| Some(page_url.to_string()));
    record.source_url = Some(page_url.to_string());
    record.zotero_item_type = Some(
        match record.paper_type {
            PaperKind::Arxiv => "preprint",
            PaperKind::Doi => "journalArticle",
            _ => "webpage",
        }
        .into(),
    );
    record.meta_source = Some("webpage".into());
    let user_url = page_url.to_string();
    enrich_remote_urls(&mut record);
    if !is_arxiv_host(&user_url) {
        record.source_url = Some(user_url.clone());
        if record.arxiv_id.is_none() {
            record.html_url = canonical.or(Some(user_url));
        }
    }
    record
}

/// Last-resort entry when the page itself cannot be fetched. The URL is the
/// record; translation being down must not block that.
pub(crate) fn record_from_url(page_url: &str) -> PaperRecord {
    let title = title_from_url(page_url);
    let id = page_id(page_url, &title, None, None);
    let mut record = PaperRecord::local_pdf(id, title);
    record.paper_type = PaperKind::Html;
    record.html_url = Some(page_url.to_string());
    record.source_url = Some(page_url.to_string());
    record.zotero_item_type = Some("webpage".into());
    record.meta_source = Some("webpage".into());
    enrich_remote_urls(&mut record);
    record.source_url = Some(page_url.to_string());
    record.html_url = Some(page_url.to_string());
    record
}

fn page_id(page_url: &str, title: &str, doi: Option<&str>, arxiv: Option<&str>) -> String {
    if let Some(id) = arxiv.map(strip_arxiv_version).filter(|id| !id.is_empty()) {
        return id;
    }
    if let Some(doi) = doi.filter(|doi| !doi.is_empty()) {
        return doi_slug(doi);
    }
    let slug = slug_from_stem(title);
    if slug != "paper" {
        return slug;
    }
    let from_url = slug_from_stem(&title_from_url(page_url));
    if from_url != "paper" {
        from_url
    } else {
        "webpage".into()
    }
}

fn pages_from_meta(meta: &HtmlMeta) -> Option<String> {
    if let Some(pages) = meta.first(&["citation_pages"]) {
        return Some(pages.to_string());
    }
    let first = meta.first(&["citation_firstpage"])?;
    match meta.first(&["citation_lastpage"]) {
        Some(last) if last != first => Some(format!("{first}-{last}")),
        _ => Some(first.to_string()),
    }
}

fn is_arxiv_host(url: &str) -> bool {
    url.contains("://arxiv.org/") || url.contains("://export.arxiv.org/")
}

#[derive(Default)]
struct HtmlMeta {
    title: Option<String>,
    canonical: Option<String>,
    authors: Vec<String>,
    fields: Vec<(String, String)>,
}

impl HtmlMeta {
    fn first(&self, names: &[&str]) -> Option<&str> {
        for name in names {
            if let Some((_, value)) = self.fields.iter().find(|(key, _)| key == name) {
                if !value.is_empty() {
                    return Some(value);
                }
            }
        }
        None
    }

    fn push_field(&mut self, name: &str, value: String) {
        let key = name.trim().to_ascii_lowercase();
        if key.is_empty() || value.is_empty() {
            return;
        }
        if key == "citation_author" || key == "dc.creator" {
            self.authors.push(value);
            return;
        }
        if !self.fields.iter().any(|(existing, _)| existing == &key) {
            self.fields.push((key, value));
        }
    }
}

fn parse_html_meta(html: &str) -> HtmlMeta {
    let mut meta = HtmlMeta::default();
    let mut rest = html;
    while let Some(start) = rest.find('<') {
        rest = &rest[start..];
        if rest.starts_with("<!--") {
            if let Some(end) = rest.find("-->") {
                rest = &rest[end + 3..];
            } else {
                break;
            }
            continue;
        }
        let Some((raw, consumed)) = read_raw_tag(rest) else {
            break;
        };
        rest = &rest[consumed..];
        let raw = raw.trim();
        if raw.is_empty() || raw.starts_with('/') || raw.starts_with('!') || raw.starts_with('?') {
            continue;
        }
        let name_end = raw
            .find(|c: char| c.is_whitespace() || c == '/')
            .unwrap_or(raw.len());
        let name = raw[..name_end].to_ascii_lowercase();
        if name == "title" && meta.title.is_none() {
            if let Some(end) = find_ignore_ascii_case(rest, "</title>") {
                meta.title = Some(clean_text(&rest[..end]));
            }
            continue;
        }
        let attrs = attributes(raw);
        if name == "meta" {
            let key = attr(&attrs, "name")
                .or_else(|| attr(&attrs, "property"))
                .or_else(|| attr(&attrs, "itemprop"));
            let content = attr(&attrs, "content").map(clean_text);
            if let (Some(key), Some(content)) = (key, content) {
                meta.push_field(key, content);
            }
        } else if name == "link" {
            let rel = attr(&attrs, "rel").unwrap_or("");
            if rel.eq_ignore_ascii_case("canonical") {
                if let Some(href) = attr(&attrs, "href").map(clean_text) {
                    if !href.is_empty() {
                        meta.canonical = Some(href);
                    }
                }
            }
        }
    }
    meta
}

fn read_raw_tag(html: &str) -> Option<(&str, usize)> {
    if !html.starts_with('<') {
        return None;
    }
    let mut quote: Option<char> = None;
    for (idx, ch) in html.char_indices().skip(1) {
        if let Some(open) = quote {
            if ch == open {
                quote = None;
            }
            continue;
        }
        match ch {
            '"' | '\'' => quote = Some(ch),
            '>' => return Some((&html[1..idx], idx + ch.len_utf8())),
            _ => {}
        }
    }
    None
}

fn attributes(tag: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = match tag.find(char::is_whitespace) {
        Some(index) => tag[index..].trim_start(),
        None => return out,
    };
    while !rest.is_empty() && !rest.starts_with('/') && !rest.starts_with('>') {
        let Some(eq) = rest.find('=') else {
            break;
        };
        let key = rest[..eq].trim().to_ascii_lowercase();
        rest = rest[eq + 1..].trim_start();
        if rest.is_empty() {
            break;
        }
        let quote = rest.chars().next().unwrap();
        if quote == '"' || quote == '\'' {
            rest = &rest[quote.len_utf8()..];
            let Some(end) = rest.find(quote) else {
                break;
            };
            out.push((key, rest[..end].to_string()));
            rest = rest[end + quote.len_utf8()..].trim_start();
        } else {
            let end = rest
                .find(|c: char| c.is_whitespace() || c == '>' || c == '/')
                .unwrap_or(rest.len());
            out.push((key, rest[..end].to_string()));
            rest = rest[end..].trim_start();
        }
    }
    out
}

fn attr<'a>(attrs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    attrs
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
        .filter(|value| !value.is_empty())
}

fn find_ignore_ascii_case(hay: &str, needle: &str) -> Option<usize> {
    hay.as_bytes()
        .windows(needle.len())
        .position(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
}

fn clean_text(value: &str) -> String {
    decode_entities(&strip_tags(value))
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn strip_tags(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_tag = false;
    for ch in value.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

fn split_authors(raw: &str) -> Vec<String> {
    let separator = if raw.contains(';') { ';' } else { '\n' };
    raw.split(separator)
        .map(str::trim)
        .filter(|author| !author.is_empty())
        .map(str::to_string)
        .collect()
}

fn normalize_date(raw: &str) -> (Option<String>, Option<i32>) {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return (None, None);
    }
    let year = trimmed
        .split(|c: char| !c.is_ascii_digit())
        .find(|part| part.len() == 4)
        .and_then(|part| part.parse::<i32>().ok())
        .filter(|year| (1000..=2100).contains(year));
    let date = trimmed.replace('/', "-");
    (Some(date), year)
}

fn title_from_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    let without_scheme = trimmed
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    let without_query = without_scheme
        .split(['?', '#'])
        .next()
        .unwrap_or(without_scheme);
    let segment = without_query
        .rsplit('/')
        .find(|part| !part.is_empty())
        .unwrap_or(without_query);
    let decoded = percent_decode(segment).replace(['-', '_'], " ");
    let collapsed = decoded.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        "Untitled".into()
    } else {
        collapsed
    }
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(
                std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or(""),
                16,
            ) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORDINARY: &str = r#"<!DOCTYPE html><html><head>
<title>Lab notes on rust | Blog</title>
<meta property="og:title" content="Lab notes on rust">
<meta property="og:description" content="How we read papers.">
<meta name="author" content="Ada Lovelace">
<link rel="canonical" href="https://example.com/notes/rust">
</head><body><p>body</p></body></html>"#;

    const PAPER: &str = r#"<html><head>
<meta name="citation_title" content="Array programming with NumPy">
<meta name="citation_author" content="Harris, Charles R.">
<meta name="citation_author" content="Millman, K. Jarrod">
<meta name="citation_doi" content="10.1038/s41586-020-2649-2">
<meta name="citation_pdf_url" content="https://www.nature.com/articles/s41586-020-2649-2.pdf">
<meta name="citation_abstract" content="Array programming provides a compact syntax.">
<meta name="citation_journal_title" content="Nature">
<meta name="citation_publication_date" content="2020/09/16">
<meta name="citation_publisher" content="Springer Nature">
<meta name="citation_volume" content="585">
<meta name="citation_issue" content="7825">
<meta name="citation_firstpage" content="357">
<meta name="citation_lastpage" content="362">
</head></html>"#;

    #[test]
    fn ordinary_page_uses_url_title_and_metadata() {
        let url = "https://example.com/notes/rust";
        let record = record_from_html(url, ORDINARY);
        assert_eq!(record.paper_type, PaperKind::Html);
        assert_eq!(record.title, "Lab notes on rust");
        assert_eq!(record.authors, vec!["Ada Lovelace"]);
        assert_eq!(record.abstract_text.as_deref(), Some("How we read papers."));
        assert_eq!(record.source_url.as_deref(), Some(url));
        assert_eq!(
            record.html_url.as_deref(),
            Some("https://example.com/notes/rust")
        );
        assert!(record.doi.is_none());
        assert!(record.arxiv_id.is_none());
        assert_eq!(record.zotero_item_type.as_deref(), Some("webpage"));
        assert_eq!(record.meta_source.as_deref(), Some("webpage"));
        assert_eq!(record.id, "Lab-notes-on-rust");
    }

    #[test]
    fn paper_page_uses_citation_metadata_without_an_id_in_the_url() {
        let url = "https://www.nature.com/articles/s41586-020-2649-2";
        let record = record_from_html(url, PAPER);
        assert_eq!(record.paper_type, PaperKind::Doi);
        assert_eq!(record.title, "Array programming with NumPy");
        assert_eq!(
            record.authors,
            vec!["Harris, Charles R.", "Millman, K. Jarrod"]
        );
        assert_eq!(record.doi.as_deref(), Some("10.1038/s41586-020-2649-2"));
        assert_eq!(record.id, "10_1038_s41586-020-2649-2");
        assert_eq!(record.year, Some(2020));
        assert_eq!(record.date.as_deref(), Some("2020-09-16"));
        assert_eq!(record.publication.as_deref(), Some("Nature"));
        assert_eq!(record.publisher.as_deref(), Some("Springer Nature"));
        assert_eq!(record.volume.as_deref(), Some("585"));
        assert_eq!(record.pages.as_deref(), Some("357-362"));
        assert_eq!(
            record.pdf_url.as_deref(),
            Some("https://www.nature.com/articles/s41586-020-2649-2.pdf")
        );
        assert_eq!(record.source_url.as_deref(), Some(url));
        assert_eq!(record.zotero_item_type.as_deref(), Some("journalArticle"));
    }

    #[test]
    fn reads_swapped_attribute_order_and_entities() {
        let html = r#"<meta content="Tom &amp; Jerry&#39;s paper" name="citation_title" />
<meta content="10.1000/xyz" name="citation_doi">"#;
        let record = record_from_html("https://publisher.example/item", html);
        assert_eq!(record.title, "Tom & Jerry's paper");
        assert_eq!(record.doi.as_deref(), Some("10.1000/xyz"));
        assert_eq!(record.paper_type, PaperKind::Doi);
    }

    #[test]
    fn page_without_metadata_still_makes_an_entry_from_the_url() {
        let url = "https://example.com/blog/hello-world/";
        let record = record_from_html(url, "<html><body>no head</body></html>");
        assert_eq!(record.paper_type, PaperKind::Html);
        assert_eq!(record.title, "hello world");
        assert_eq!(record.id, "hello-world");
        assert_eq!(record.source_url.as_deref(), Some(url));
        assert!(record.doi.is_none());
        assert!(record.arxiv_id.is_none());
    }

    #[test]
    fn url_only_record_survives_a_failed_page_fetch() {
        let url = "https://example.com/posts/a-note";
        let record = record_from_url(url);
        assert_eq!(record.paper_type, PaperKind::Html);
        assert_eq!(record.title, "a note");
        assert_eq!(record.source_url.as_deref(), Some(url));
        assert_eq!(record.html_url.as_deref(), Some(url));
        assert_eq!(record.zotero_item_type.as_deref(), Some("webpage"));
    }

    #[test]
    fn translator_miss_imports_a_url_and_rejects_a_bare_string() {
        assert_eq!(
            plan_after_translator_miss("https://example.com/blog/hello", false),
            TranslatorMissPlan::ImportWebpage
        );
        assert_eq!(
            plan_after_translator_miss("https://www.nature.com/articles/s41586-020-2649-2", false),
            TranslatorMissPlan::ImportWebpage
        );
        assert_eq!(
            plan_after_translator_miss("https://arxiv.org/abs/1706.03762", true),
            TranslatorMissPlan::UseIdentifier
        );
        assert_eq!(
            plan_after_translator_miss("not an identifier", false),
            TranslatorMissPlan::Fail
        );
    }

    #[test]
    fn unavailable_error_names_503_1102_and_the_service() {
        let failure = TranslatorFailure {
            status: Some(503),
            code: Some(1102),
            detail: "error code: 1102".into(),
            cancelled: false,
        };
        let err = unavailable_error(&failure, "https://translation-server.agentero.app");
        assert_eq!(err.code(), "translator_unavailable");
        let message = err.to_string();
        assert!(message
            .contains("translator_unavailable|503|1102|https://translation-server.agentero.app"));
        assert!(message.contains("HTTP 503, error code: 1102"));
        assert!(message.contains("no DOI, arXiv ID, or PMID"));
    }

    #[test]
    fn degraded_notice_carries_503_1102_for_the_ui() {
        let failure = TranslatorFailure {
            status: Some(503),
            code: Some(1102),
            detail: String::new(),
            cancelled: false,
        };
        let notice = format!(
            "translator_degraded|{}|page|https://translation-server.agentero.app",
            failure.token()
        );
        assert_eq!(
            notice,
            "translator_degraded|503|1102|page|https://translation-server.agentero.app"
        );
    }
}
