//! OpenReview PDF derivation (ICLR / COLM / TMLR / …).
//!
//! The Translator refuses OpenReview (the site serves a bot challenge to
//! server-side fetchers), but the PDF URL is fully determined by the forum
//! page — same id, `forum` becomes `pdf`:
//!
//!   https://openreview.net/forum?id=KS8mIvetg2
//!   → https://openreview.net/pdf?id=KS8mIvetg2
//!
//! Note: the same bot challenge may also block plain HTTP downloads of the
//! derived URL; the URL itself is still the canonical one to record.

use crate::features::catalog::papers::PaperRecord;
use url::Url;

/// Derive the canonical OpenReview PDF URL from a forum page.
pub fn pdf_url(url: &str) -> Option<String> {
    let mut url = Url::parse(url.trim()).ok()?;
    if !is_openreview_https(&url) {
        return None;
    }
    match url.path() {
        "/pdf" => {}
        "/forum"
            if url
                .query_pairs()
                .any(|(key, value)| key == "id" && !value.is_empty()) =>
        {
            url.set_path("/pdf");
        }
        _ => return None,
    }
    url.set_fragment(None);
    Some(url.into())
}

pub(crate) fn is_openreview_https(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url
            .host_str()
            .is_some_and(crate::features::import::openreview::is_openreview_host)
}

pub(crate) fn forum_url(source: &str) -> Option<(String, Url)> {
    let mut url = Url::parse(&pdf_url(source)?).ok()?;
    let id = url.query_pairs().find_map(|(name, value)| {
        (name == "id"
            && !value.is_empty()
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte)))
        .then(|| value.into_owned())
    })?;
    url.set_path("/forum");
    url.query_pairs_mut().clear().append_pair("id", &id);
    Some((id, url))
}

/// OpenReview can hand the metadata translator the gate's HTML instead of the forum.
pub(crate) fn is_verification_title(title: &str) -> bool {
    let title = title.split('|').next().unwrap_or(title).trim();
    title.eq_ignore_ascii_case("Verifying your browser") || title.eq_ignore_ascii_case("Error 403")
}

pub(crate) fn url_only_record(id: &str, forum: Url) -> PaperRecord {
    let mut record = PaperRecord::local_pdf(format!("openreview-{id}"), format!("OpenReview {id}"));
    record.pdf_url = pdf_url(forum.as_str());
    record.source_url = Some(forum.into());
    record.zotero_item_type = Some("conferencePaper".into());
    record.meta_source = Some("openreview_url".into());
    record
}

/// Include older placeholders created before the metadata source was recorded.
pub(crate) fn is_stub(record: &PaperRecord, id: &str) -> bool {
    record.meta_source.as_deref() != Some("manual")
        && (record.title.trim().is_empty()
            || record.title.trim().eq_ignore_ascii_case("OpenReview")
            || record
                .title
                .trim()
                .eq_ignore_ascii_case(&format!("OpenReview {id}"))
            || is_verification_title(&record.title))
}

pub(crate) fn record_forum(paper: &PaperRecord) -> Option<(String, Url)> {
    [
        paper.source_url.as_deref(),
        paper.openreview_url.as_deref(),
        paper.html_url.as_deref(),
        paper.pdf_url.as_deref(),
    ]
    .into_iter()
    .flatten()
    .find_map(forum_url)
}

fn note_metadata(json: &serde_json::Value, id: &str, forum: Url) -> Option<PaperRecord> {
    let note = json
        .get("notes")?
        .as_array()?
        .iter()
        .find(|note| note["id"].as_str() == Some(id) && note["forum"].as_str() == Some(id))?;
    let content = note.get("content")?;
    let field = |key: &str| {
        let field = content.get(key)?;
        Some(field.get("value").unwrap_or(field))
    };
    let string = |key: &str| {
        field(key)?
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    let title = string("title")?;
    if is_verification_title(title) {
        return None;
    }
    let mut record = url_only_record(id, forum);
    record.title = title.to_owned();
    record.authors = field("authors")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str().map(str::trim))
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect();
    record.abstract_text = string("abstract").map(str::to_owned);
    record.publication = string("venue").map(str::to_owned);
    record.year = string("venueid").and_then(|venue| {
        venue.split('/').find_map(|part| {
            (part.len() == 4)
                .then(|| part.parse::<i32>().ok())
                .flatten()
        })
    });
    record.doi = string("doi").map(str::to_owned);
    record.meta_source = Some("openreview_api".into());
    Some(record)
}

pub(crate) async fn lookup_metadata(id: &str, forum: &Url) -> Option<PaperRecord> {
    let json = super::super::openreview::submission(id).await?;
    note_metadata(&json, id, forum.clone())
}

/// Attachment URL for a catalog row, including older rows that only have a forum link.
pub fn paper_pdf_url(paper: &PaperRecord) -> Option<String> {
    if let Some(url) = paper
        .pdf_url
        .as_deref()
        .and_then(|url| Url::parse(url).ok())
    {
        if is_openreview_https(&url)
            && (matches!(
                url.path(),
                "/pdf" | "/attachment" | "/notes/edits/attachment"
            ) || url.path().starts_with("/pdf/"))
        {
            return Some(url.into());
        }
    }
    [
        paper.openreview_url.as_deref(),
        paper.source_url.as_deref(),
        paper.html_url.as_deref(),
    ]
    .into_iter()
    .flatten()
    .find_map(pdf_url)
}

/// Find the preprint of this paper without replacing its OpenReview edition.
pub(crate) async fn matching_arxiv_id(paper: &PaperRecord) -> Option<String> {
    use crate::features::scholar_api::scoring::{author_overlap, title_similarity_key};
    use crate::features::scholar_api::search::{search_papers_by_title, SourceScope};

    let title = title_similarity_key(&paper.title);
    if paper.arxiv_id.is_some() || title.is_empty() || paper.authors.is_empty() {
        return None;
    }
    let matches = search_papers_by_title(&title, SourceScope::Preprint, 5)
        .await
        .ok()?;
    let mut ids = matches.into_iter().filter_map(|candidate| {
        if title_similarity_key(&candidate.title) != title
            || author_overlap(&paper.authors, &candidate.authors) < 0.8
            || paper
                .year
                .zip(candidate.year)
                .is_some_and(|(a, b)| a.abs_diff(b) > 1)
        {
            return None;
        }
        candidate.identifiers.arxiv_id
    });
    let id = ids.next()?;
    ids.all(|other| other == id).then_some(id)
}

pub(crate) fn save_matched_arxiv_id(vault: &std::path::Path, paper: &PaperRecord, id: String) {
    use crate::features::catalog::papers;
    let _ = papers::mutate_paper(vault, &paper.path, |current| {
        if current.source_url == paper.source_url
            && current.title == paper.title
            && current.authors == paper.authors
            && current.arxiv_id.is_none()
        {
            current.arxiv_id = Some(id);
        }
        Ok(())
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_pdf_from_forum() {
        assert_eq!(
            pdf_url("https://openreview.net/forum?id=KS8mIvetg2"),
            Some("https://openreview.net/pdf?id=KS8mIvetg2".to_string())
        );
    }

    #[test]
    fn passes_through_existing_pdf() {
        assert_eq!(
            pdf_url("https://openreview.net/pdf?id=KS8mIvetg2"),
            Some("https://openreview.net/pdf?id=KS8mIvetg2".to_string())
        );
    }

    #[test]
    fn rejects_non_forum_pages() {
        assert!(pdf_url("https://openreview.net/group?id=ICLR.cc/2024/Conference").is_none());
        assert!(pdf_url("https://example.com/forum?id=x").is_none());
        assert!(pdf_url("https://example.com/openreview.net/forum?id=x").is_none());
    }
}
