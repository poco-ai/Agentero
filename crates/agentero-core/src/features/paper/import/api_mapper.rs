//! Map [`ApiPaper`] candidates from `scholar_api` into [`PaperRecord`].

use serde_json::Value;

use crate::error::AppError;
use crate::features::catalog::papers::{hide_arxiv_category_tag, PaperKind, PaperRecord, PaperTag};
use crate::features::paper::util::str_field;
use crate::features::scholar_api::identifiers::{doi_slug, strip_arxiv_version};
use crate::features::scholar_api::sources::translator::map_zotero_item;
use crate::features::scholar_api::urls::{arxiv_canonical_urls, doi_landing_url};
use crate::features::scholar_api::{ApiPaper, PaperIdentifiers, PaperUrls};

use super::sources::venue_pdf_url;

/// Convert a single API candidate into a `PaperRecord`, choosing an id and
/// paper type from the available identifiers.
pub fn api_paper_to_meta(paper: &ApiPaper) -> PaperRecord {
    let id = paper
        .identifiers
        .arxiv_id
        .as_ref()
        .map(|id| strip_arxiv_version(id))
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

    // Better BibTeX users cite the same work from several tools through the
    // key Zotero already stores on the item, so it wins over the keys derived
    // from identifiers. Keep it verbatim: CJK keys and disambiguation suffixes
    // are part of the contract, and the folder id is assigned independently.
    //
    // Zotero 8 stores it in the native `citationKey` field; Zotero 7 pinned
    // keys lived in the Extra field as a `Citation Key: <key>` line.
    if let Some(key) = str_field(item, "citationKey") {
        record.bibtex_key = Some(key);
    } else if let Some(key) = pinned_citation_key(record.extra.as_deref()) {
        record.bibtex_key = Some(key);
    }

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

/// Pinned Better BibTeX key carried by Zotero 7's `extra` field.
///
/// Before Zotero 8 introduced the native field, Better BibTeX wrote one
/// `Citation Key: <key>` line into `extra`. The key is everything after the
/// first colon, so keys that contain a colon survive unchanged.
fn pinned_citation_key(extra: Option<&str>) -> Option<String> {
    extra?.lines().find_map(|line| {
        let (label, value) = line.split_once(':')?;
        if !label.trim().eq_ignore_ascii_case("citation key") {
            return None;
        }
        let key = value.trim();
        (!key.is_empty()).then(|| key.to_string())
    })
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

/// Source preference order for venue/publication names.
const VENUE_SOURCE_ORDER: &[&str] = &["s2", "crossref", "openalex", "arxiv", "pubmed"];

/// Source preference order for bibliographic detail fields (volume/issue/pages/publisher).
const BIBLIO_SOURCE_ORDER: &[&str] = &["crossref", "s2", "openalex", "arxiv", "pubmed"];

/// Source preference order for abstracts.
const ABSTRACT_SOURCE_ORDER: &[&str] = &["arxiv", "s2", "crossref", "openalex", "pubmed"];

fn pick_by_source<T: Clone>(
    candidates: &[ApiPaper],
    extractor: fn(&ApiPaper) -> &Option<T>,
    order: &[&str],
) -> Option<T> {
    for name in order {
        if let Some(v) = candidates
            .iter()
            .find(|p| p.source == *name)
            .and_then(|p| extractor(p).clone())
        {
            return Some(v);
        }
    }
    candidates.iter().find_map(|p| extractor(p).clone())
}

fn best_title(candidates: &[ApiPaper]) -> String {
    candidates
        .iter()
        .max_by(|a, b| {
            let a_usable = !a
                .title
                .chars()
                .all(|c| c.is_uppercase() || c.is_whitespace() || c.is_ascii_punctuation());
            let b_usable = !b
                .title
                .chars()
                .all(|c| c.is_uppercase() || c.is_whitespace() || c.is_ascii_punctuation());
            a_usable
                .cmp(&b_usable)
                .then_with(|| a.title.len().cmp(&b.title.len()))
        })
        .map(|p| p.title.clone())
        .unwrap_or_default()
}

fn best_authors(candidates: &[ApiPaper]) -> Vec<String> {
    candidates
        .iter()
        .max_by_key(|p| p.authors.len())
        .map(|p| p.authors.clone())
        .unwrap_or_default()
}

fn best_year(candidates: &[ApiPaper]) -> Option<i32> {
    candidates
        .iter()
        .filter(|p| p.year.is_some())
        .max_by_key(|p| p.date.as_ref().map(|d| d.len()).unwrap_or(0))
        .and_then(|p| p.year)
}

fn best_date(candidates: &[ApiPaper]) -> Option<String> {
    candidates
        .iter()
        .filter(|p| p.year.is_some())
        .max_by_key(|p| p.date.as_ref().map(|d| d.len()).unwrap_or(0))
        .and_then(|p| p.date.clone())
}

fn merge_identifiers(candidates: &[ApiPaper]) -> PaperIdentifiers {
    let mut doi = None;
    let mut arxiv_id = None;
    let mut isbn = None;
    let mut pmid = None;
    for p in candidates {
        if doi.is_none() {
            doi = p.identifiers.doi.clone().map(|d| d.trim().to_lowercase());
        }
        if arxiv_id.is_none() {
            arxiv_id = p
                .identifiers
                .arxiv_id
                .clone()
                .map(|a| strip_arxiv_version(a.trim()));
        }
        if isbn.is_none() {
            isbn = p.identifiers.isbn.clone();
        }
        if pmid.is_none() {
            pmid = p.identifiers.pmid.clone();
        }
    }
    PaperIdentifiers {
        doi,
        arxiv_id,
        isbn,
        pmid,
    }
}

fn merge_urls(candidates: &[ApiPaper]) -> PaperUrls {
    let mut pdf = None;
    let mut html = None;
    let mut landing = None;
    for p in candidates {
        if pdf.is_none() {
            pdf = p.urls.pdf.clone();
        }
        if html.is_none() {
            html = p.urls.html.clone();
        }
        if landing.is_none() {
            landing = p.urls.landing.clone();
        }
    }
    PaperUrls { pdf, html, landing }
}

fn merge_citation_count(candidates: &[ApiPaper]) -> Option<i64> {
    candidates.iter().filter_map(|p| p.citation_count).max()
}

fn first_language(candidates: &[ApiPaper]) -> Option<String> {
    candidates
        .iter()
        .find_map(|p| p.language.clone().filter(|l| !l.trim().is_empty()))
}

/// Merge multiple `ApiPaper` candidates describing the same work.
///
/// `candidates` must be pre-sorted by preferred source priority (highest first).
/// The returned `ApiPaper` combines the richest fields from all candidates,
/// with source-specific preferences (e.g. Crossref for bibliographic details,
/// arXiv for abstracts).
pub fn merge_api_paper_candidates(candidates: &[ApiPaper]) -> ApiPaper {
    assert!(!candidates.is_empty());
    let base = &candidates[0];

    ApiPaper {
        identifiers: merge_identifiers(candidates),
        title: best_title(candidates),
        authors: best_authors(candidates),
        year: best_year(candidates),
        date: best_date(candidates),
        venue: pick_by_source(candidates, |p| &p.venue, VENUE_SOURCE_ORDER),
        volume: pick_by_source(candidates, |p| &p.volume, BIBLIO_SOURCE_ORDER),
        issue: pick_by_source(candidates, |p| &p.issue, BIBLIO_SOURCE_ORDER),
        pages: pick_by_source(candidates, |p| &p.pages, BIBLIO_SOURCE_ORDER),
        publisher: pick_by_source(candidates, |p| &p.publisher, BIBLIO_SOURCE_ORDER),
        abstract_text: pick_by_source(candidates, |p| &p.abstract_text, ABSTRACT_SOURCE_ORDER),
        urls: merge_urls(candidates),
        citation_count: merge_citation_count(candidates),
        language: first_language(candidates).or_else(|| base.language.clone()),
        source: base.source,
        raw: None,
    }
}

/// Canonicalize remote URLs on a `PaperRecord`.
///
/// - arXiv ids get standard `https://arxiv.org/{pdf,html,abs}` URLs.
/// - DOI-only records get a `https://doi.org/{doi}` source URL.
/// - Venue landing pages the Translator returns without a PDF attachment get
///   their deterministic PDF URL (see `sources::venue_pdf_url`).
pub fn enrich_remote_urls(meta: &mut PaperRecord) {
    if let Some(ref aid) = meta.arxiv_id {
        let bare = strip_arxiv_version(aid.trim().trim_start_matches("arXiv:"));
        let request =
            crate::features::paper::source::arxiv_request(meta).unwrap_or_else(|| bare.clone());
        let urls = arxiv_canonical_urls(&request);
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

    // Venue landing pages (ACL Anthology, USENIX, NeurIPS, CVF, PMLR, …) don't
    // expose a PDF attachment in Translator, but each has a deterministic PDF
    // URL pattern — see `sources::{acl,usenix,…}`.
    if meta.pdf_url.is_none() {
        if let Some(url) = meta.source_url.as_deref().or(meta.html_url.as_deref()) {
            if let Some(pdf) = venue_pdf_url(url) {
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
            raw: None,
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
    fn zotero_citation_key_wins_over_the_derived_key() {
        let item = serde_json::json!({
            "itemType": "journalArticle",
            "title": "示例论文标题",
            "creators": [
                {"firstName": "San", "lastName": "Zhang", "creatorType": "author"}
            ],
            "date": "2099",
            "DOI": "10.9999/example.2099",
            "citationKey": "示例2099a"
        });
        let meta = map_zotero_item_to_record(&item).expect("map");
        // Verbatim: the CJK key and its year/disambiguation suffix survive.
        assert_eq!(meta.bibtex_key.as_deref(), Some("示例2099a"));
        // The catalog id (and therefore the folder) still follows the DOI.
        assert_eq!(meta.id, "10_9999_example_2099");
    }

    #[test]
    fn zotero_item_without_a_citation_key_keeps_the_derived_key() {
        let item = serde_json::json!({
            "itemType": "journalArticle",
            "title": "Example Paper",
            "creators": [
                {"firstName": "San", "lastName": "Zhang", "creatorType": "author"}
            ],
            "date": "2099",
            "DOI": "10.9999/example.2099"
        });
        let meta = map_zotero_item_to_record(&item).expect("map");
        assert_eq!(meta.bibtex_key.as_deref(), Some("10_9999_example_2099"));

        // A blank or null key is treated as missing, not as an empty key.
        for blank in [
            serde_json::json!(""),
            serde_json::json!("   "),
            serde_json::Value::Null,
        ] {
            let mut item = item.clone();
            item["citationKey"] = blank;
            let meta = map_zotero_item_to_record(&item).expect("map");
            assert_eq!(meta.bibtex_key.as_deref(), Some("10_9999_example_2099"));
        }
    }

    #[test]
    fn zotero_extra_citation_key_is_used_when_the_native_field_is_missing() {
        // Zotero 7: Better BibTeX pinned the key in the Extra field.
        let item = serde_json::json!({
            "itemType": "journalArticle",
            "title": "示例论文标题",
            "creators": [
                {"firstName": "San", "lastName": "Zhang", "creatorType": "author"}
            ],
            "date": "2099",
            "DOI": "10.9999/example.2099",
            "extra": "TL;DR: short summary\nCitation Key: 示例2099a\nfoo: bar"
        });
        let meta = map_zotero_item_to_record(&item).expect("map");
        assert_eq!(meta.bibtex_key.as_deref(), Some("示例2099a"));
        assert_eq!(meta.id, "10_9999_example_2099");
    }

    #[test]
    fn native_citation_key_wins_over_the_extra_field() {
        let item = serde_json::json!({
            "itemType": "journalArticle",
            "title": "Example Paper",
            "date": "2099",
            "DOI": "10.9999/example.2099",
            "citationKey": "native2099",
            "extra": "Citation Key: pinned2099"
        });
        let meta = map_zotero_item_to_record(&item).expect("map");
        assert_eq!(meta.bibtex_key.as_deref(), Some("native2099"));
    }

    #[test]
    fn extra_citation_key_keeps_colons_and_matches_the_label_case_insensitively() {
        let meta = map_zotero_item_to_record(&serde_json::json!({
            "itemType": "journalArticle",
            "title": "Example Paper",
            "date": "2099",
            "extra": "citation key: smith:2099"
        }))
        .expect("map");
        assert_eq!(meta.bibtex_key.as_deref(), Some("smith:2099"));
    }

    fn api_paper_with(
        source: &'static str,
        title: &str,
        identifiers: PaperIdentifiers,
        extra: impl FnOnce(&mut ApiPaper),
    ) -> ApiPaper {
        let mut p = ApiPaper {
            title: title.into(),
            authors: vec!["Vaswani".into()],
            year: Some(2017),
            date: None,
            venue: None,
            volume: None,
            issue: None,
            pages: None,
            publisher: None,
            abstract_text: None,
            language: None,
            citation_count: None,
            identifiers,
            urls: PaperUrls::default(),
            source,
            raw: None,
        };
        extra(&mut p);
        p
    }

    #[test]
    fn merge_api_paper_candidates_prefers_crossref_bibliography() {
        let s2 = api_paper_with(
            "s2",
            "Attention Is All You Need",
            PaperIdentifiers {
                arxiv_id: Some("1706.03762".into()),
                ..Default::default()
            },
            |p| {
                p.venue = Some("NeurIPS".into());
                p.citation_count = Some(123_456);
            },
        );
        let crossref = api_paper_with(
            "crossref",
            "Attention is all you need",
            PaperIdentifiers {
                doi: Some("10.1/attention".into()),
                ..Default::default()
            },
            |p| {
                p.volume = Some("30".into());
                p.issue = Some("1".into());
                p.pages = Some("1-11".into());
                p.publisher = Some("NeurIPS Proceedings".into());
            },
        );

        let merged = merge_api_paper_candidates(&[s2, crossref]);
        assert_eq!(merged.identifiers.doi.as_deref(), Some("10.1/attention"));
        assert_eq!(merged.identifiers.arxiv_id.as_deref(), Some("1706.03762"));
        assert_eq!(merged.volume.as_deref(), Some("30"));
        assert_eq!(merged.issue.as_deref(), Some("1"));
        assert_eq!(merged.pages.as_deref(), Some("1-11"));
        assert_eq!(merged.publisher.as_deref(), Some("NeurIPS Proceedings"));
        assert_eq!(merged.citation_count, Some(123_456));
    }

    #[test]
    fn merge_api_paper_candidates_prefers_arxiv_abstract() {
        let s2 = api_paper_with(
            "s2",
            "Attention Is All You Need",
            PaperIdentifiers::default(),
            |p| {
                p.abstract_text = Some("Short abstract.".into());
            },
        );
        let arxiv = api_paper_with(
            "arxiv",
            "Attention Is All You Need",
            PaperIdentifiers::default(),
            |p| {
                p.abstract_text = Some("The dominant sequence transduction models...".into());
            },
        );

        let merged = merge_api_paper_candidates(&[s2, arxiv]);
        assert_eq!(
            merged.abstract_text.as_deref(),
            Some("The dominant sequence transduction models...")
        );
    }

    #[test]
    fn merge_api_paper_candidates_keeps_max_citation_count() {
        let low = api_paper_with("s2", "X", PaperIdentifiers::default(), |p| {
            p.citation_count = Some(900);
        });
        let high = api_paper_with("crossref", "X", PaperIdentifiers::default(), |p| {
            p.citation_count = Some(1_500);
        });
        let none = api_paper_with("openalex", "X", PaperIdentifiers::default(), |_| {});

        assert_eq!(
            merge_api_paper_candidates(&[low, high.clone(), none]).citation_count,
            Some(1_500)
        );
    }

    #[test]
    fn merge_api_paper_candidates_merges_identifiers() {
        let arxiv = api_paper_with(
            "arxiv",
            "X",
            PaperIdentifiers {
                arxiv_id: Some("1706.03762".into()),
                ..Default::default()
            },
            |_| {},
        );
        let crossref = api_paper_with(
            "crossref",
            "X",
            PaperIdentifiers {
                doi: Some("10.1/attention".into()),
                ..Default::default()
            },
            |_| {},
        );

        let merged = merge_api_paper_candidates(&[arxiv, crossref]);
        assert_eq!(merged.identifiers.arxiv_id.as_deref(), Some("1706.03762"));
        assert_eq!(merged.identifiers.doi.as_deref(), Some("10.1/attention"));
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

    #[test]
    fn enrich_remote_urls_fills_usenix_presentation_pdf() {
        let item = serde_json::json!({
            "itemType": "conferencePaper",
            "title": "Harmonizing Efficiency and Practicability: Optimizing Resource Utilization in Serverless Computing with Jiagu",
            "creators": [
                {"firstName": "Qingyuan", "lastName": "Liu", "creatorType": "author"}
            ],
            "date": "2024",
            "conferenceName": "2024 USENIX Annual Technical Conference (USENIX ATC 24)",
            "ISBN": "9781939133410",
            "url": "https://www.usenix.org/conference/atc24/presentation/liu-qingyuan"
        });
        let meta = map_zotero_item_to_record(&item).expect("map");
        assert_eq!(
            meta.pdf_url.as_deref(),
            Some("https://www.usenix.org/system/files/atc24-liu-qingyuan.pdf")
        );
        assert_eq!(
            meta.publication.as_deref(),
            Some("2024 USENIX Annual Technical Conference (USENIX ATC 24)")
        );
    }

    #[test]
    fn enrich_remote_urls_fills_other_venue_pdfs() {
        // NeurIPS abstract page.
        let item = serde_json::json!({
            "itemType": "conferencePaper",
            "title": "Some NeurIPS Paper",
            "date": "2023",
            "url": "https://proceedings.neurips.cc/paper_files/paper/2023/hash/0001ca33ba34ce0351e4612b744b3936-Abstract-Conference.html"
        });
        let meta = map_zotero_item_to_record(&item).expect("map");
        assert_eq!(
            meta.pdf_url.as_deref(),
            Some("https://proceedings.neurips.cc/paper_files/paper/2023/file/0001ca33ba34ce0351e4612b744b3936-Paper-Conference.pdf")
        );

        // OpenReview forum page.
        let item = serde_json::json!({
            "itemType": "conferencePaper",
            "title": "Some ICLR Paper",
            "date": "2024",
            "url": "https://openreview.net/forum?id=KS8mIvetg2"
        });
        let meta = map_zotero_item_to_record(&item).expect("map");
        assert_eq!(
            meta.pdf_url.as_deref(),
            Some("https://openreview.net/pdf?id=KS8mIvetg2")
        );
    }
}
