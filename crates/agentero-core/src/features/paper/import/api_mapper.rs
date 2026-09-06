//! Map [`ApiPaper`] candidates from `scholar_api` into [`PaperRecord`].

use serde_json::Value;

use crate::error::AppError;
use crate::features::catalog::papers::{hide_arxiv_category_tag, PaperKind, PaperRecord, PaperTag};
use crate::features::scholar_api::identifiers::{doi_slug, strip_arxiv_version};
use crate::features::scholar_api::sources::translator::map_zotero_item;
use crate::features::scholar_api::urls::{
    acl_anthology_pdf_url, arxiv_canonical_urls, doi_landing_url,
};
use crate::features::scholar_api::ApiPaper;

/// Convert a single API candidate into a `PaperRecord`, choosing an id and
/// paper type from the available identifiers.
pub fn api_paper_to_meta(paper: &ApiPaper) -> PaperRecord {
    let id = paper
        .identifiers
        .arxiv_id
        .clone()
        .or_else(|| paper.identifiers.doi.clone().map(|d| doi_slug(&d)))
        .or_else(|| paper.identifiers.isbn.clone())
        .unwrap_or_else(|| citekey_fallback(&paper.authors, paper.year, &paper.title));

    let paper_type = if paper.identifiers.arxiv_id.is_some() {
        PaperKind::Arxiv
    } else if paper.identifiers.doi.is_some() {
        PaperKind::Doi
    } else {
        PaperKind::Pdf
    };

    let mut meta = PaperRecord::local_pdf(id, paper.title.clone());
    meta.paper_type = paper_type;
    meta.authors = paper.authors.clone();
    meta.year = paper.year;
    meta.date = paper.date.clone();
    meta.publication = paper.venue.clone();
    meta.doi = paper.identifiers.doi.clone();
    meta.arxiv_id = paper.identifiers.arxiv_id.clone();
    meta.isbn = paper.identifiers.isbn.clone();
    meta.pmid = paper.identifiers.pmid.clone();
    meta.volume = paper.volume.clone();
    meta.issue = paper.issue.clone();
    meta.pages = paper.pages.clone();
    meta.publisher = paper.publisher.clone();
    meta.abstract_text = paper.abstract_text.clone();
    meta.language = paper.language.clone();
    meta.pdf_url = paper.urls.pdf.clone();
    meta.html_url = paper.urls.html.clone();
    meta.source_url = paper.urls.landing.clone();
    meta.meta_source = Some(paper.source.into());
    meta.citation_count = paper.citation_count;

    // Ensure canonical arXiv URLs when we have an arXiv id.
    enrich_remote_urls(&mut meta);

    meta
}

/// Map a raw Zotero/Translator item into a `PaperRecord`.
///
/// This is the single entry point for Zotero-shaped JSON: it first turns the
/// item into an [`ApiPaper`] via the translator source, then maps to
/// `PaperRecord`, and finally preserves Zotero-only fields.
pub fn map_zotero_item_to_record(item: &Value) -> Result<PaperRecord, AppError> {
    let api_paper = map_zotero_item(item)
        .ok_or_else(|| AppError::message("translator item missing title or unparseable"))?;
    let mut record = api_paper_to_meta(&api_paper);
    apply_zotero_extras(item, &mut record);
    Ok(record)
}

/// Preserve Zotero-specific fields that do not fit the generic [`ApiPaper`]
/// shape.
fn apply_zotero_extras(item: &Value, record: &mut PaperRecord) {
    record.creators = item.get("creators").cloned();
    record.zotero_item_type = str_field(item, "itemType");
    record.extra = str_field(item, "extra");
    record.issn = str_field(item, "ISSN");
    record.place = str_field(item, "place");
    record.series = str_field(item, "series");

    if let Some(tags) = item.get("tags").and_then(|v| v.as_array()) {
        record.tags = tags
            .iter()
            .filter_map(|t| {
                t.get("tag")
                    .and_then(|v| v.as_str())
                    .or_else(|| t.as_str())
                    .map(hide_arxiv_category_tag)
                    .filter(|s| !s.is_empty())
                    .map(PaperTag::new)
            })
            .collect();
    }

    if (record.paper_type == PaperKind::Pdf || record.paper_type == PaperKind::Other)
        && str_field(item, "itemType").as_deref() == Some("webpage")
    {
        record.paper_type = PaperKind::Html;
    }
}

/// Merge `other` into `base`, preferring non-empty fields from `other`.
/// The returned `PaperRecord` keeps `base.source` unless `other` contributes
/// identifiers or bibliographic fields.
pub fn merge_api_papers(base: &ApiPaper, other: &ApiPaper) -> PaperRecord {
    let mut merged = api_paper_to_meta(base);

    if other.identifiers.doi.is_some() {
        merged.doi = other.identifiers.doi.clone();
    }
    if other.year.is_some() {
        merged.year = other.year;
        merged.date = other.date.clone();
    }
    if other.venue.is_some() {
        merged.publication = other.venue.clone();
    }
    if other.volume.is_some() {
        merged.volume = other.volume.clone();
    }
    if other.issue.is_some() {
        merged.issue = other.issue.clone();
    }
    if other.pages.is_some() {
        merged.pages = other.pages.clone();
    }
    if other.publisher.is_some() {
        merged.publisher = other.publisher.clone();
    }
    if other.abstract_text.is_some() {
        merged.abstract_text = other.abstract_text.clone();
    }
    if other.urls.html.is_some() || other.urls.landing.is_some() {
        merged.html_url = other.urls.html.clone().or(other.urls.landing.clone());
        merged.source_url = other.urls.landing.clone();
    }
    // Same quantity, different coverage: the larger count is the tighter lower bound.
    merged.citation_count = match (merged.citation_count, other.citation_count) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    };

    merged.meta_source = Some(format!("{}+{}", base.source, other.source));

    // Re-apply arXiv canonicalization in case the merge changed identifiers.
    enrich_remote_urls(&mut merged);

    merged
}

/// Canonicalize remote URLs on a `PaperRecord`.
///
/// - arXiv ids get standard `https://arxiv.org/{pdf,html,abs}` URLs.
/// - DOI-only records get a `https://doi.org/{doi}` source URL.
/// - ACL Anthology landing pages get their predictable PDF URL.
pub fn enrich_remote_urls(meta: &mut PaperRecord) {
    if let Some(ref aid) = meta.arxiv_id {
        let bare = strip_arxiv_version(aid.trim().trim_start_matches("arXiv:"));
        let urls = arxiv_canonical_urls(&bare);
        meta.pdf_url = Some(urls.pdf);
        meta.html_url = Some(urls.html);
        meta.source_url = Some(urls.abs);
        if meta.bibtex_key.is_none() {
            meta.bibtex_key = Some(bare.replace('/', ""));
        }
        if meta.paper_type == PaperKind::Other || meta.paper_type == PaperKind::Pdf {
            meta.paper_type = PaperKind::Arxiv;
        }
    } else if let Some(ref doi) = meta.doi {
        if meta.source_url.as_ref().is_none_or(|s| s.is_empty()) {
            meta.source_url = Some(doi_landing_url(doi));
        }
    }

    // ACL Anthology landing pages don't expose a PDF attachment, but the PDF
    // is always available at <landing>.pdf.
    if meta.pdf_url.is_none() {
        if let Some(url) = meta.source_url.as_deref().or(meta.html_url.as_deref()) {
            if let Some(pdf) = acl_anthology_pdf_url(url) {
                meta.pdf_url = Some(pdf);
            }
        }
    }

    if meta.bibtex_key.is_none() {
        meta.bibtex_key = Some(meta.id.replace(['/', '.'], "_"));
    }
}

pub(crate) fn citekey_fallback(authors: &[String], year: Option<i32>, title: &str) -> String {
    let author = authors
        .first()
        .map(|a| {
            a.split_whitespace()
                .last()
                .unwrap_or("paper")
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .collect::<String>()
                .to_lowercase()
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "paper".into());
    let y = year.map(|y| y.to_string()).unwrap_or_else(|| "0000".into());
    let word = title
        .split_whitespace()
        .next()
        .unwrap_or("item")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_lowercase();
    format!("{author}{y}{word}")
}

fn str_field(item: &Value, key: &str) -> Option<String> {
    item.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::scholar_api::{PaperIdentifiers, PaperUrls};

    fn api_paper(source: &'static str, citation_count: Option<i64>) -> ApiPaper {
        ApiPaper {
            identifiers: PaperIdentifiers {
                doi: Some("10.1/attention".into()),
                ..Default::default()
            },
            title: "Attention Is All You Need".into(),
            authors: vec!["Vaswani".into()],
            year: Some(2017),
            date: None,
            venue: Some("NeurIPS".into()),
            volume: None,
            issue: None,
            pages: None,
            publisher: None,
            abstract_text: None,
            urls: PaperUrls::default(),
            citation_count,
            language: None,
            source,
        }
    }

    #[test]
    fn api_paper_to_meta_maps_bibliographic_fields() {
        let mut paper = api_paper("s2", Some(42));
        paper.identifiers.arxiv_id = Some("1706.03762".into());
        paper.identifiers.doi = Some("10.48550/arXiv.1706.03762".into());

        let mapped = api_paper_to_meta(&paper);
        assert_eq!(mapped.title, "Attention Is All You Need");
        assert_eq!(mapped.publication.as_deref(), Some("NeurIPS"));
        assert_eq!(mapped.arxiv_id.as_deref(), Some("1706.03762"));
        assert_eq!(mapped.doi.as_deref(), Some("10.48550/arXiv.1706.03762"));
        // arXiv id wins over the DOI slug for the folder id.
        assert_eq!(mapped.id, "1706.03762");
    }

    #[test]
    fn api_paper_to_meta_falls_back_through_id_sources() {
        let by_doi = api_paper_to_meta(&api_paper("crossref", None));
        assert_eq!(by_doi.id, "10_1_attention");

        let mut no_identifier = api_paper("openalex", None);
        no_identifier.identifiers.doi = None;
        assert_eq!(api_paper_to_meta(&no_identifier).id, "vaswani2017attention");
    }

    #[test]
    fn api_paper_to_meta_keeps_citation_count() {
        let mapped = api_paper_to_meta(&api_paper("s2", Some(123_456)));
        assert_eq!(mapped.citation_count, Some(123_456));
        assert_eq!(mapped.meta_source.as_deref(), Some("s2"));

        let unmapped = api_paper_to_meta(&api_paper("crossref", None));
        assert_eq!(unmapped.citation_count, None);
    }

    #[test]
    fn merge_api_papers_keeps_the_larger_citation_count() {
        // Sources disagree in both directions; neither may downgrade the other.
        let low = api_paper("s2", Some(900));
        let high = api_paper("crossref", Some(1_500));
        assert_eq!(merge_api_papers(&low, &high).citation_count, Some(1_500));
        assert_eq!(merge_api_papers(&high, &low).citation_count, Some(1_500));

        // A missing count never erases a known one.
        let unknown = api_paper("openalex", None);
        assert_eq!(
            merge_api_papers(&high, &unknown).citation_count,
            Some(1_500)
        );
        assert_eq!(
            merge_api_papers(&unknown, &high).citation_count,
            Some(1_500)
        );
        assert_eq!(
            merge_api_papers(&api_paper("s2", None), &unknown).citation_count,
            None
        );
    }

    #[test]
    fn maps_zotero_item_to_record() {
        let item = serde_json::json!({
            "itemType": "preprint",
            "title": "Attention Is All You Need",
            "creators": [
                {"firstName": "Ashish", "lastName": "Vaswani", "creatorType": "author"}
            ],
            "date": "2023-08-02",
            "abstractNote": "The dominant sequence transduction models…",
            "archiveID": "arXiv:1706.03762",
            "extra": "arXiv:1706.03762 [cs]",
            "libraryCatalog": "arXiv.org",
            "repository": "arXiv",
            "url": "http://arxiv.org/abs/1706.03762",
            "DOI": "10.48550/arXiv.1706.03762",
            "tags": [
                {"tag": "Computer Science - Machine Learning"},
                {"tag": "survey"}
            ]
        });
        let meta = map_zotero_item_to_record(&item).expect("map");
        assert_eq!(meta.arxiv_id.as_deref(), Some("1706.03762"));
        assert_eq!(
            meta.tags,
            vec![
                PaperTag::new("@arxiv:Computer Science - Machine Learning"),
                PaperTag::new("survey"),
            ]
        );
        assert_eq!(
            meta.pdf_url.as_deref(),
            Some("https://arxiv.org/pdf/1706.03762")
        );
        assert_eq!(
            meta.html_url.as_deref(),
            Some("https://arxiv.org/html/1706.03762")
        );
        assert_eq!(
            meta.source_url.as_deref(),
            Some("https://arxiv.org/abs/1706.03762")
        );
        // metadata.json must use snake_case keys for the frontend
        let json = serde_json::to_string(&meta).unwrap();
        assert!(json.contains("\"pdf_url\""), "got {json}");
        assert!(json.contains("\"arxiv_id\""), "got {json}");
        assert!(!json.contains("\"pdfUrl\""));
    }

    #[test]
    fn enrich_remote_urls_fills_acl_anthology_pdf() {
        // Translator response shape for an ACL Anthology conference paper.
        let item = serde_json::json!({
            "itemType": "conferencePaper",
            "title": "Enabling Agents to Communicate Entirely in Latent Space",
            "creators": [
                {"firstName": "Zhuoyun", "lastName": "Du", "creatorType": "author"}
            ],
            "date": "2026-07",
            "url": "https://aclanthology.org/2026.acl-long.1248/",
            "DOI": "10.18653/v1/2026.acl-long.1248",
            "libraryCatalog": "ACLWeb"
        });
        let meta = map_zotero_item_to_record(&item).expect("map");
        assert_eq!(
            meta.pdf_url.as_deref(),
            Some("https://aclanthology.org/2026.acl-long.1248.pdf")
        );
    }
}
