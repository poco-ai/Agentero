use crate::features::catalog::papers::PaperRecord;
use crate::features::scholar_api::scoring::{author_overlap, title_similarity_key};
use dom_query::Document;
use std::time::Duration;

const PROCEEDINGS: &str = "https://proceedings.iclr.cc";

/// Resolve an OpenReview paper to its official ICLR conference edition.
pub(crate) async fn proceedings_pdf_url(paper: &PaperRecord) -> Option<String> {
    let venue = paper.publication.as_deref()?.to_lowercase();
    if !(venue
        .split(|c: char| !c.is_alphanumeric())
        .any(|word| word == "iclr")
        || venue.contains("international conference on learning representations"))
        || venue.contains("workshop")
    {
        return None;
    }
    let year = paper.year?;
    if year < 2024 || paper.title.trim().is_empty() || paper.authors.is_empty() {
        return None;
    }
    let index =
        crate::http::client_with(Duration::from_secs(10), 3, crate::http::BROWSER_USER_AGENT)
            .ok()?
            .get(format!("{PROCEEDINGS}/paper_files/paper/{year}"))
            .send()
            .await
            .ok()?
            .error_for_status()
            .ok()?
            .text()
            .await
            .ok()?;
    match_conference_pdf(&index, year, &paper.title, &paper.authors)
}

fn match_conference_pdf(index: &str, year: i32, title: &str, authors: &[String]) -> Option<String> {
    let title = title_similarity_key(title);
    let prefix = format!("/paper_files/paper/{year}/hash/");
    let document = Document::from(index);
    let papers = document.select(r#"li.conference .paper-content > a[title="paper title"]"#);

    let mut matched = papers.nodes().iter().filter_map(|paper| {
        if title_similarity_key(&paper.text()) != title {
            return None;
        }
        let listed = paper.next_element_sibling()?;
        if !listed.has_class("paper-authors") {
            return None;
        }
        let listed_authors: Vec<_> = listed
            .text()
            .split(',')
            .map(str::trim)
            .map(str::to_owned)
            .collect();
        if listed_authors.len() != authors.len() || author_overlap(&listed_authors, authors) < 1.0 {
            return None;
        }
        let href = paper.attr("href")?;
        let hash = href
            .strip_prefix(&prefix)?
            .strip_suffix("-Abstract-Conference.html")?;
        (hash.len() == 32 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())).then(|| {
            format!("{PROCEEDINGS}/paper_files/paper/{year}/file/{hash}-Paper-Conference.pdf")
        })
    });
    let url = matched.next()?;
    matched.next().is_none().then_some(url)
}
