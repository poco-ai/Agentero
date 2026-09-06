//! PubMed / NCBI E-utilities source.
//!
//! Implements title search and PMID lookup using the public NCBI E-utilities
//! endpoints. NCBI asks polite users to include an email and a tool name.

use async_trait::async_trait;

use crate::features::scholar_api::client;
use crate::features::scholar_api::traits::AcademicApi;
use crate::features::scholar_api::{
    ApiCapability, ApiError, ApiPaper, ApiQuery, PaperIdentifiers, PaperUrls,
};

const SOURCE: &str = "pubmed";
const EUTILS_BASE: &str = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const EMAIL: &str = "agentero@users.noreply.github.com";
const TOOL: &str = "agentero";

/// PubMed metadata source.
#[derive(Debug, Clone, Default)]
pub struct PubMedApi;

#[async_trait]
impl AcademicApi for PubMedApi {
    fn name(&self) -> &'static str {
        SOURCE
    }

    fn capabilities(&self) -> ApiCapability {
        ApiCapability::SEARCH_BY_TITLE
            | ApiCapability::FETCH_BY_PMID
            | ApiCapability::PROVIDE_ABSTRACT
    }

    async fn fetch(&self, query: &ApiQuery) -> Result<Vec<ApiPaper>, ApiError> {
        match query {
            ApiQuery::Title(title) => search_by_title(title, 5).await,
            ApiQuery::Pmid(pmid) => fetch_by_pmid(pmid).await.map(|p| vec![p]),
            _ => Err(ApiError::UnsupportedQuery(query.clone())),
        }
    }
}

async fn search_by_title(title: &str, limit: usize) -> Result<Vec<ApiPaper>, ApiError> {
    let search_url = format!(
        "{EUTILS_BASE}/esearch.fcgi?db=pubmed&term={}&retmax={limit}&retmode=json&email={EMAIL}&tool={TOOL}",
        urlencoding::encode(title)
    );
    let search_value = client::get_json(&search_url).await?;
    let pmids: Vec<String> = search_value
        .pointer("/esearchresult/idlist")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    if pmids.is_empty() {
        return Ok(Vec::new());
    }

    // NCBI recommends batching; keep the first batch under a reasonable size.
    let batch: Vec<_> = pmids.into_iter().take(limit.max(1)).collect();
    fetch_by_pmids(&batch).await
}

async fn fetch_by_pmid(pmid: &str) -> Result<ApiPaper, ApiError> {
    let papers = fetch_by_pmids(&[pmid.to_string()]).await?;
    papers.into_iter().next().ok_or(ApiError::NotFound)
}

async fn fetch_by_pmids(pmids: &[String]) -> Result<Vec<ApiPaper>, ApiError> {
    if pmids.is_empty() {
        return Ok(Vec::new());
    }
    let ids = pmids.join(",");
    let fetch_url = format!(
        "{EUTILS_BASE}/efetch.fcgi?db=pubmed&id={ids}&rettype=xml&retmode=xml&email={EMAIL}&tool={TOOL}"
    );
    let xml = client::get_text(&fetch_url).await?;
    Ok(parse_articles(&xml))
}

fn parse_articles(xml: &str) -> Vec<ApiPaper> {
    let mut out = Vec::new();
    for article in xml.split("<PubmedArticle>").skip(1) {
        let article = article.split("</PubmedArticle>").next().unwrap_or(article);
        if let Some(paper) = parse_article(article) {
            out.push(paper);
        }
    }
    out
}

fn parse_article(xml: &str) -> Option<ApiPaper> {
    let title = tag_text(xml, "ArticleTitle")?;
    let pmid = tag_text(xml, "PMID")?;

    let authors: Vec<String> = xml
        .split("<Author>")
        .skip(1)
        .filter_map(|block| {
            let block = block.split("</Author>").next()?;
            let last = tag_text(block, "LastName").unwrap_or_default();
            let fore = tag_text(block, "ForeName").unwrap_or_default();
            let initials = tag_text(block, "Initials").unwrap_or_default();
            let name = match (last.is_empty(), fore.is_empty()) {
                (false, false) => format!("{fore} {last}"),
                (false, true) => {
                    if initials.is_empty() {
                        last
                    } else {
                        format!("{initials}. {last}")
                    }
                }
                (true, false) => fore,
                (true, true) => return None,
            };
            let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
            if name.is_empty() {
                None
            } else {
                Some(name)
            }
        })
        .collect();

    let year = tag_text(xml, "Year")
        .and_then(|y| y.parse::<i32>().ok())
        .or_else(|| {
            tag_text(xml, "MedlineDate").and_then(|d| {
                d.chars()
                    .filter(|c| c.is_ascii_digit())
                    .take(4)
                    .collect::<String>()
                    .parse::<i32>()
                    .ok()
            })
        });
    let date = year.map(|y| y.to_string());

    let venue = tag_text(xml, "Journal").and_then(|journal| tag_text(&journal, "Title"));
    let volume = tag_text(xml, "Volume");
    let issue = tag_text(xml, "Issue");
    let pages = tag_text(xml, "MedlinePgn");

    let doi = article_id(xml, "doi");

    let abstract_text = tag_text(xml, "Abstract").map(|abs| {
        // Multiple <AbstractText> fragments are common; concatenate them.
        // Fragments may carry attributes: <AbstractText Label="Conclusion">.
        split_tagged_fragments(&abs, "AbstractText")
            .into_iter()
            .map(|s| collapse_ws(&s))
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    });
    let abstract_text = abstract_text.filter(|s| !s.is_empty());

    let pmc = article_id(xml, "pmc");
    let html = Some(format!("https://pubmed.ncbi.nlm.nih.gov/{pmid}/"));
    let pdf = pmc
        .as_ref()
        .map(|pmc| format!("https://pmc.ncbi.nlm.nih.gov/articles/{pmc}/pdf/"));

    Some(ApiPaper {
        identifiers: PaperIdentifiers {
            doi,
            arxiv_id: None,
            isbn: None,
            pmid: Some(pmid),
        },
        title,
        authors,
        year,
        date,
        venue,
        volume,
        issue,
        pages,
        publisher: None,
        abstract_text,
        urls: PaperUrls {
            pdf,
            html: html.clone(),
            landing: html,
        },
        citation_count: None,
        language: None,
        source: SOURCE,
    })
}

/// First occurrence of `<tag>` or `<tag …>` … `</tag>` in `xml`, whitespace collapsed.
/// The tag name must be followed by `>` or whitespace to avoid matching a
/// longer tag name that merely starts with the same letters.
fn tag_text(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut pos = 0;
    while let Some(start) = xml[pos..].find(&open) {
        let absolute = pos + start;
        let after = &xml[absolute + open.len()..];
        let next = after.chars().next()?;
        if next == '>' || next.is_whitespace() {
            let body = after.split_once('>')?.1.split(&close).next()?;
            let text = collapse_ws(body);
            return if text.is_empty() { None } else { Some(text) };
        }
        pos = absolute + 1;
    }
    None
}

/// Extract text from every `<tag …>…</tag>` fragment in `xml`.
fn split_tagged_fragments(xml: &str, tag: &str) -> Vec<String> {
    let mut out = Vec::new();
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut pos = 0;
    while let Some(start) = xml[pos..].find(&open) {
        let absolute = pos + start;
        let after = &xml[absolute + open.len()..];
        let Some(next) = after.chars().next() else {
            break;
        };
        if next != '>' && !next.is_whitespace() {
            pos = absolute + 1;
            continue;
        }
        let Some((_, rest)) = after.split_once('>') else {
            pos = absolute + 1;
            continue;
        };
        let Some(body) = rest.split(&close).next() else {
            pos = absolute + 1;
            continue;
        };
        let text = collapse_ws(body);
        if !text.is_empty() {
            out.push(text);
        }
        pos = absolute + open.len() + 1;
    }
    out
}

/// Extract an `<ArticleId IdType="{kind}">` value from the PubmedData block.
fn article_id(xml: &str, kind: &str) -> Option<String> {
    let list = xml.split("<ArticleIdList>").nth(1)?;
    let list = list.split("</ArticleIdList>").next()?;
    for entry in list.split("<ArticleId ").skip(1) {
        let entry = entry.split("</ArticleId>").next()?;
        let attr = format!("IdType=\"{kind}\"");
        if entry.contains(&attr) {
            let value = entry.split('>').nth(1)?;
            let value = collapse_ws(value);
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tag_text_handles_attributes() {
        assert_eq!(
            tag_text(
                r#"<Abstract><AbstractText>x</AbstractText></Abstract>"#,
                "Abstract"
            )
            .as_deref(),
            Some("<AbstractText>x</AbstractText>")
        );
        assert_eq!(
            tag_text(r#"<PMID Version="1">123</PMID>"#, "PMID").as_deref(),
            Some("123")
        );
    }

    #[test]
    fn parses_pubmed_article() {
        let xml = r#"<PubmedArticle>
            <MedlineCitation Status="PubMed-not-MEDLINE" Owner="NLM">
                <PMID Version="1">12345678</PMID>
                <Article PubModel="Print">
                    <Journal>
                        <Title>Nature</Title>
                        <JournalIssue>
                            <Volume>600</Volume>
                            <Issue>1</Issue>
                            <PubDate><Year>2022</Year><Month>Jan</Month></PubDate>
                        </JournalIssue>
                    </Journal>
                    <ArticleTitle>CRISPR gene editing in vivo</ArticleTitle>
                    <Pagination><MedlinePgn>100-110</MedlinePgn></Pagination>
                    <AuthorList>
                        <Author><LastName>Smith</LastName><ForeName>John A</ForeName><Initials>JA</Initials></Author>
                        <Author><LastName>Doe</LastName><ForeName>Jane</ForeName><Initials>J</Initials></Author>
                    </AuthorList>
                    <Abstract>
                        <AbstractText>We demonstrate in vivo gene editing.</AbstractText>
                        <AbstractText Label="Conclusion">It works.</AbstractText>
                    </Abstract>
                </Article>
                <PubmedData>
                    <ArticleIdList>
                        <ArticleId IdType="pubmed">12345678</ArticleId>
                        <ArticleId IdType="doi">10.1038/s41586-022-00001-x</ArticleId>
                        <ArticleId IdType="pmc">PMC9876543</ArticleId>
                    </ArticleIdList>
                </PubmedData>
            </MedlineCitation>
        </PubmedArticle>"#;

        let paper = parse_article(xml).expect("parsed");
        assert_eq!(paper.title, "CRISPR gene editing in vivo");
        assert_eq!(paper.identifiers.pmid.as_deref(), Some("12345678"));
        assert_eq!(
            paper.identifiers.doi.as_deref(),
            Some("10.1038/s41586-022-00001-x")
        );
        assert_eq!(paper.year, Some(2022));
        assert_eq!(paper.venue.as_deref(), Some("Nature"));
        assert_eq!(paper.volume.as_deref(), Some("600"));
        assert_eq!(paper.issue.as_deref(), Some("1"));
        assert_eq!(paper.pages.as_deref(), Some("100-110"));
        assert_eq!(paper.authors, vec!["John A Smith", "Jane Doe"]);
        assert_eq!(
            paper.abstract_text.as_deref(),
            Some("We demonstrate in vivo gene editing. It works.")
        );
        assert!(paper
            .urls
            .html
            .as_deref()
            .unwrap()
            .contains("pubmed.ncbi.nlm.nih.gov/12345678"));
        assert!(paper
            .urls
            .pdf
            .as_deref()
            .unwrap()
            .contains("PMC9876543/pdf"));
    }

    #[test]
    fn parses_medline_date_year() {
        let xml = r#"<PubmedArticle>
            <MedlineCitation><PMID>999</PMID>
            <Article><ArticleTitle>Old paper</ArticleTitle>
            <Journal><Title>Classic Journal</Title><JournalIssue><PubDate><MedlineDate>1987 Jan-Feb</MedlineDate></PubDate></JournalIssue></Journal>
            </Article>
            </MedlineCitation>
        </PubmedArticle>"#;
        let paper = parse_article(xml).expect("parsed");
        assert_eq!(paper.year, Some(1987));
    }

    #[test]
    fn returns_none_when_title_missing() {
        let xml =
            r#"<PubmedArticle><MedlineCitation><PMID>1</PMID></MedlineCitation></PubmedArticle>"#;
        assert!(parse_article(xml).is_none());
    }
}
