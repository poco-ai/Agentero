//! Import a paper straight from its papers.cool page, without the Translator.
//!
//! Every branch's page carries Highwire `citation_*` metadata — title, authors,
//! abstract, publisher, date and crucially `citation_pdf_url`. That covers all 11
//! publisher shapes papers.cool aggregates (OJS, OpenReview, ACL Anthology, PMLR,
//! CVF, ECVA, IJCAI, ISCA, MICCAI, NDSS, USENIX), several of which the Translator
//! either refuses (OpenReview serves a bot challenge), errors on (AAAI OJS 500),
//! or degrades to `webpage` / `blogPost`. The Translator also never returns a PDF
//! attachment for these pages, so going direct is both broader and richer.
//!
//! arXiv rows are deliberately *not* routed here: the native arXiv path also
//! yields `arxiv_id` and the LaTeX source.

use super::{decode_entities, http_client, ORIGIN};
use crate::core::error::AppError;
use crate::features::import::{
    map_zotero_item,
    paper_import::{
        paper_commit, AssetsPolicy, DedupePolicy, PaperCommitOptions, PaperCommitResult,
    },
    AssetProgressContext, NoteShellMode,
};
use std::path::Path;

/// Highwire metadata scraped from a papers.cool paper page.
#[derive(Debug, Default, PartialEq)]
pub struct PageMeta {
    pub title: String,
    pub authors: Vec<String>,
    pub abstract_text: Option<String>,
    pub pdf_url: Option<String>,
    pub public_url: Option<String>,
    pub publisher: Option<String>,
    /// `citation_date` when present, else `citation_year`.
    pub date: Option<String>,
}

fn meta_content(html: &str, name: &str) -> Option<String> {
    let needle = format!("<meta name=\"{name}\" content=\"");
    let start = html.find(&needle)? + needle.len();
    let rest = &html[start..];
    let end = rest.find('"')?;
    let value = decode_entities(&rest[..end]).trim().to_string();
    if value.is_empty() {
        return None;
    }
    Some(value)
}

pub fn parse_page(html: &str) -> PageMeta {
    let authors = meta_content(html, "citation_authors")
        .map(|raw| {
            raw.split(';')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    PageMeta {
        title: meta_content(html, "citation_title").unwrap_or_default(),
        authors,
        abstract_text: meta_content(html, "citation_abstract"),
        pdf_url: meta_content(html, "citation_pdf_url"),
        public_url: meta_content(html, "citation_public_url"),
        publisher: meta_content(html, "citation_publisher"),
        date: meta_content(html, "citation_date").or_else(|| meta_content(html, "citation_year")),
    }
}

/// Zotero-shaped value so the whole field mapping in `map_zotero_item` is reused
/// instead of hand-rolling a second `PaperMeta` constructor.
fn zotero_item(page: &PageMeta) -> serde_json::Value {
    let creators: Vec<serde_json::Value> = page
        .authors
        .iter()
        .map(|name| {
            let mut parts = name.rsplitn(2, ' ');
            let last = parts.next().unwrap_or(name).trim();
            let first = parts.next().unwrap_or("").trim();
            serde_json::json!({
                "creatorType": "author",
                "firstName": first,
                "lastName": last,
            })
        })
        .collect();
    serde_json::json!({
        "itemType": "conferencePaper",
        "title": page.title,
        "creators": creators,
        "abstractNote": page.abstract_text,
        "date": page.date,
        "url": page.public_url,
    })
}

pub struct ImportPageArgs<'a> {
    pub vault: &'a Path,
    /// Vault-relative destination, e.g. `papers` or `papers/nlp`.
    pub parent_dir: &'a str,
    /// papers.cool branch (`arxiv` / `venue`), i.e. the page's `<body id>`.
    pub branch: &'a str,
    /// Row id, e.g. `36962@AAAI`. Becomes the catalog id and folder name.
    pub id: &'a str,
    pub progress: AssetProgressContext<'a>,
    /// NOTES.md shell generation mode (settings `paperNoteMode`).
    pub note_mode: NoteShellMode,
}

/// Fetch the papers.cool page for one row and commit it as a paper unit.
pub async fn import_page(args: ImportPageArgs<'_>) -> Result<PaperCommitResult, AppError> {
    let branch = args.branch.trim();
    let id = args.id.trim();
    if branch.is_empty() || id.is_empty() {
        return Err(AppError::message("cool papers branch and id are required"));
    }
    if !branch.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(AppError::message("invalid cool papers branch"));
    }

    let url = format!("{ORIGIN}/{branch}/{}", urlencoding::encode(id));
    let res = http_client()?
        .get(&url)
        .timeout(std::time::Duration::from_secs(60))
        .header(reqwest::header::USER_AGENT, super::USER_AGENT)
        .send()
        .await
        .map_err(|e| AppError::message(format!("cool papers request failed: {e}")))?;
    if !res.status().is_success() {
        return Err(AppError::message(format!(
            "cool papers http {}",
            res.status()
        )));
    }
    let html = res
        .text()
        .await
        .map_err(|e| AppError::message(format!("cool papers body failed: {e}")))?;

    let page = parse_page(&html);
    if page.title.is_empty() {
        return Err(AppError::message(
            "cool papers page has no citation metadata",
        ));
    }

    let mut meta = map_zotero_item(&zotero_item(&page))?;
    // The papers.cool id is globally unique, so it dedupes precisely; the
    // derived citekey fallback can collide and would be swallowed as a dup.
    meta.id = id.to_string();
    meta.meta_source = Some("papers.cool".into());
    if meta.pdf_url.is_none() {
        meta.pdf_url = page.pdf_url.clone();
    }
    if meta.source_url.is_none() {
        meta.source_url = page.public_url.clone().or(Some(url));
    }
    if meta.publication.is_none() {
        meta.publication = page.publisher.clone();
    }

    paper_commit(
        meta,
        PaperCommitOptions {
            vault: args.vault,
            parent_dir: args.parent_dir,
            dedupe: DedupePolicy::ByCatalogId,
            assets: AssetsPolicy::SyncDownload {
                cookies: None,
                progress: args.progress,
            },
            translate_abstract: true,
            note_mode: args.note_mode,
            fresh_timestamps: false,
            cache: None,
            app: args.progress.app,
            defer_parse_jobs: false,
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = r#"<!DOCTYPE html><html><head>
<meta name="citation_title" content="Learning Structurally Stabilized Representations">
<meta name="citation_authors" content="Zhiang Cao; Yulong Li; Hao He">
<meta name="citation_abstract" content="Storing data in DNA requires students&#039; care &amp; rigor.">
<meta name="citation_pdf_url" content="https://ojs.aaai.org/index.php/AAAI/article/download/36962/40924">
<meta name="citation_public_url" content="https://papers.cool/venue/36962@AAAI">
<meta name="citation_publisher" content="AAAI.2026 - Application Domains">
<meta name="citation_year" content="2026">
</head><body id="venue"></body></html>"#;

    #[test]
    fn parses_highwire_metadata() {
        let p = parse_page(PAGE);
        assert_eq!(p.title, "Learning Structurally Stabilized Representations");
        assert_eq!(p.authors, vec!["Zhiang Cao", "Yulong Li", "Hao He"]);
        assert_eq!(p.date.as_deref(), Some("2026"));
        assert_eq!(
            p.publisher.as_deref(),
            Some("AAAI.2026 - Application Domains")
        );
        assert!(p.pdf_url.as_deref().unwrap().ends_with("36962/40924"));
    }

    /// The abstract carries HTML entities in the real pages.
    #[test]
    fn decodes_entities_in_metadata() {
        let p = parse_page(PAGE);
        assert_eq!(
            p.abstract_text.as_deref(),
            Some("Storing data in DNA requires students' care & rigor.")
        );
    }

    #[test]
    fn prefers_citation_date_over_year() {
        let html = r#"<meta name="citation_date" content="2017-06-12">
<meta name="citation_year" content="2017">"#;
        assert_eq!(parse_page(html).date.as_deref(), Some("2017-06-12"));
    }

    #[test]
    fn splits_author_names_into_first_and_last() {
        let item = zotero_item(&parse_page(PAGE));
        let creators = item["creators"].as_array().expect("creators");
        assert_eq!(creators.len(), 3);
        assert_eq!(creators[0]["firstName"], "Zhiang");
        assert_eq!(creators[0]["lastName"], "Cao");
        // A mononym must still land in lastName.
        let single = zotero_item(&PageMeta {
            authors: vec!["Plato".into()],
            ..Default::default()
        });
        assert_eq!(single["creators"][0]["lastName"], "Plato");
        assert_eq!(single["creators"][0]["firstName"], "");
    }

    #[test]
    fn missing_metadata_yields_empty_title() {
        assert!(parse_page("<html><head></head></html>").title.is_empty());
    }
}
