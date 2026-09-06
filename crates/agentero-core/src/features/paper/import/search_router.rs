//! Route raw lookup inputs to the right import pipeline.
//!
//! This module classifies user input segments (identifiers, Skill sources,
//! free-text queries), resolves identifiers, runs title/keyword search, and
//! produces the batched preflight result used by `import_by_identifier_batch`.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;

use crate::error::AppError;
use crate::features::catalog::papers;
use crate::features::scholar_api::identifiers::{
    extract_skill_source, skill_identifier, ResolvedIdentifier, SkillSource,
};
use crate::features::scholar_api::search::{rank_candidates, search_papers_by_title};

use super::SkippedImport;

/// Returns the first recognized identifier in `text`.
///
/// Skill sources are diverted up front (front-dispatch outside the resolver
/// table); everything else is probed through
/// [`scholar_api::identifiers`](crate::features::scholar_api::identifiers) in
/// priority order.
pub fn extract_primary_identifier(text: &str) -> Option<ResolvedIdentifier> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    if let Some(ident) = skill_identifier(t) {
        return Some(ident);
    }
    crate::features::scholar_api::identifiers::extract(t)
}

/// Frontend-facing title/keyword search candidate.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PaperSearchCandidate {
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<i32>,
    pub venue: Option<String>,
    pub doi: Option<String>,
    pub arxiv_id: Option<String>,
    pub citation_count: Option<i64>,
    pub url: Option<String>,
    /// Text handed back to the identifier pipeline (arXiv id preferred over DOI).
    pub identifier: String,
    /// Source that produced the candidate, e.g. `"s2"` or `"arxiv"`.
    pub source: &'static str,
}

impl From<crate::features::scholar_api::ApiPaper> for PaperSearchCandidate {
    fn from(p: crate::features::scholar_api::ApiPaper) -> Self {
        let identifier = p
            .identifiers
            .arxiv_id
            .clone()
            .or(p.identifiers.doi.clone())
            .unwrap_or_default();
        Self {
            title: p.title,
            authors: p.authors,
            year: p.year,
            venue: p.venue,
            doi: p.identifiers.doi,
            arxiv_id: p.identifiers.arxiv_id,
            citation_count: p.citation_count,
            url: p.urls.landing,
            identifier,
            source: p.source,
        }
    }
}

/// A query together with its importable candidates.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PaperSearchGroup {
    pub query: String,
    pub candidates: Vec<PaperSearchCandidate>,
}

/// Search papers by title/keyword. Returns at most `limit` candidates that carry
/// an arXiv id or DOI.
///
/// Delegates to [`crate::features::scholar_api::search::search_papers_by_title`]
/// and maps the results into frontend-facing candidates.
pub async fn search_papers(
    query: &str,
    limit: usize,
) -> Result<Vec<PaperSearchCandidate>, AppError> {
    let hits = search_papers_by_title(query, limit).await?;
    Ok(rank_candidates(hits, query, limit)
        .into_iter()
        .map(PaperSearchCandidate::from)
        .collect())
}

/// True when the current `publication` value should be replaced from S2.
pub fn needs_s2_venue_enrichment(publication: Option<&str>) -> bool {
    use crate::features::scholar_api::sources::semantic_scholar::is_usable_publication;
    match publication {
        None => true,
        Some(s) => !is_usable_publication(s),
    }
}

/// Top-N candidates shown in the magic-wand picker.
const SEARCH_CANDIDATE_LIMIT: usize = 3;

/// Resolve free-text queries to importable candidates. Empty results and search
/// failures become errors so a title that matches nothing is never a silent no-op.
/// A cancelled `task_id` (picker card closed) skips the remaining queries.
pub async fn resolve_search_queries(
    queries: &[String],
    errors: &mut Vec<String>,
    task_id: Option<&str>,
) -> Vec<PaperSearchGroup> {
    let mut groups = Vec::new();
    for query in queries {
        if super::check_task_not_cancelled(task_id).is_err() {
            break;
        }
        match search_papers(query, SEARCH_CANDIDATE_LIMIT).await {
            Ok(candidates) if candidates.is_empty() => {
                errors.push(format!("{query}: no search results"));
            }
            Ok(candidates) => groups.push(PaperSearchGroup {
                query: query.clone(),
                candidates,
            }),
            Err(e) => errors.push(format!("{query}: {e}")),
        }
    }
    groups
}

/// How to handle Skill sources when preflighting a remote vault batch.
pub enum SkillBatchMode {
    Collect,
    RejectRemote,
}

pub struct PendingIdentifierImport {
    pub raw: String,
}

pub struct PendingSkillImport {
    pub raw: String,
    pub source: SkillSource,
}

pub struct IdentifierBatchPreflight {
    pub papers: Vec<PendingIdentifierImport>,
    pub skills: Vec<PendingSkillImport>,
    /// Free text with no recognizable identifier → title/keyword search.
    pub queries: Vec<String>,
    pub skipped: Vec<SkippedImport>,
    pub errors: Vec<String>,
}

/// Preflight a batch of raw lookup inputs: classify each segment, dedupe within
/// the batch, and check the catalog for already-imported identifiers.
pub fn preflight_identifier_batch(
    texts: &[String],
    catalog_root: &Path,
    skill_mode: SkillBatchMode,
    remote_catalog: bool,
) -> IdentifierBatchPreflight {
    let mut papers = Vec::new();
    let mut skills = Vec::new();
    let mut queries = Vec::new();
    let mut skipped = Vec::new();
    let mut errors = Vec::new();
    let mut seen: HashMap<String, String> = HashMap::new();

    for input in texts {
        let input = input.trim();
        if input.is_empty() {
            continue;
        }
        let units = match classify_segment(input) {
            Segment::Identifiers(units) => units,
            Segment::Query(query) => {
                queries.push(query);
                continue;
            }
        };

        for (raw, ident) in units {
            let raw = raw.as_str();
            // Skill 分流不在 resolver 表内：由 extract_skill_source 判定。
            let skill = extract_skill_source(raw);
            if skill.is_some() && matches!(skill_mode, SkillBatchMode::RejectRemote) {
                errors.push(format!(
                    "{raw}: skill import is not supported for remote vaults"
                ));
                continue;
            }

            let kind_str = ident.kind.to_string();
            let dedup_key = format!("{kind_str}:{}", ident.value);
            if seen.contains_key(&dedup_key) {
                skipped.push(SkippedImport {
                    raw: raw.to_string(),
                    kind: kind_str,
                    value: ident.value.clone(),
                    reason: "duplicate_in_batch".to_string(),
                });
                continue;
            }
            seen.insert(dedup_key, raw.to_string());

            if let Some(source) = skill {
                skills.push(PendingSkillImport {
                    raw: raw.to_string(),
                    source,
                });
                continue;
            }

            if let Some(column) = ident.catalog_column {
                match papers::find_by_identifier(catalog_root, column, &ident.value) {
                    Ok(Some(_record)) => {
                        skipped.push(SkippedImport {
                            raw: raw.to_string(),
                            kind: kind_str.clone(),
                            value: ident.value.clone(),
                            reason: "already_in_library".to_string(),
                        });
                        continue;
                    }
                    Ok(None) => {}
                    Err(e) => {
                        if remote_catalog {
                            log::warn!("remote catalog lookup failed for {}: {e}", ident.value);
                        } else {
                            log::warn!("catalog lookup failed for {}: {e}", ident.value);
                        }
                    }
                }
            }

            papers.push(PendingIdentifierImport {
                raw: raw.to_string(),
            });
        }
    }

    IdentifierBatchPreflight {
        papers,
        skills,
        queries,
        skipped,
        errors,
    }
}

enum Segment {
    Identifiers(Vec<(String, ResolvedIdentifier)>),
    Query(String),
}

/// Classify one input segment. Space-separated identifier lists still expand
/// (`"1706.03762 10.1038/…"`); anything else with no identifier is free text.
///
/// Only single tokens are matched as a whole: the DOI / ISBN resolvers scan
/// the entire string, so a whole-segment match on multi-word input would
/// swallow the rest of a list or a title.
fn classify_segment(input: &str) -> Segment {
    let tokens: Vec<&str> = input.split_whitespace().collect();
    if tokens.len() <= 1 {
        return match extract_primary_identifier(input) {
            Some(ident) => Segment::Identifiers(vec![(input.to_string(), ident)]),
            None => Segment::Query(input.to_string()),
        };
    }

    // Skill sources (`npx skills add …`) are the only identifiers with spaces.
    if let Some(ident) = skill_identifier(input) {
        return Segment::Identifiers(vec![(input.to_string(), ident)]);
    }

    let mut units = Vec::with_capacity(tokens.len());
    for token in &tokens {
        let Some(ident) = extract_primary_identifier(token) else {
            return Segment::Query(input.to_string());
        };
        units.push((token.to_string(), ident));
    }
    Segment::Identifiers(units)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::scholar_api::identifiers::SKILL_KIND;

    fn kinds(input: &str) -> Option<Vec<&'static str>> {
        match classify_segment(input) {
            Segment::Identifiers(units) => Some(units.into_iter().map(|(_, i)| i.kind).collect()),
            Segment::Query(_) => None,
        }
    }

    #[test]
    fn keeps_multi_word_skill_command_intact() {
        assert_eq!(
            kinds("npx skills add anthropics/skills --skill pptx"),
            Some(vec!["skill"])
        );
    }

    #[test]
    fn expands_space_separated_identifiers() {
        assert_eq!(
            kinds("1706.03762 10.1038/nature12373"),
            Some(vec!["arxiv", "doi"])
        );
    }

    #[test]
    fn treats_free_text_as_query() {
        assert!(matches!(
            classify_segment("Attention is all you need"),
            Segment::Query(q) if q == "Attention is all you need"
        ));
        assert!(matches!(classify_segment("AlphaFold"), Segment::Query(_)));
    }

    #[test]
    fn does_not_swallow_a_title_containing_a_doi_fragment() {
        assert!(matches!(
            classify_segment("Revisiting 10.1038/nature12373 and friends"),
            Segment::Query(_)
        ));
    }

    #[test]
    fn extract_primary_identifier_priority_order() {
        // Locks the detection order: Skill → URL → DOI → arXiv → ISBN →
        // PMID → ADS. Same input hitting multiple sources must resolve to
        // the higher-priority kind.
        let cases: &[(&str, &'static str, &str)] = &[
            // Skill wins over the URL branch (GitHub repo URL is not a paper URL).
            (
                "https://github.com/openai/skills",
                SKILL_KIND,
                "https://github.com/openai/skills",
            ),
            // URL wins over the DOI embedded in it.
            (
                "https://doi.org/10.1038/nature12373",
                "url",
                "https://doi.org/10.1038/nature12373",
            ),
            // DOI wins over the arXiv id embedded in it.
            (
                "10.48550/arXiv.1706.03762",
                "doi",
                "10.48550/arXiv.1706.03762",
            ),
            ("1706.03762", "arxiv", "1706.03762"),
            ("978-0-262-03384-8", "isbn", "9780262033848"),
            ("PMID:24297125", "pmid", "24297125"),
            ("2015ApJ...810...89S", "ads", "2015ApJ...810...89S"),
        ];
        for (input, want_kind, want_value) in cases {
            let ident =
                extract_primary_identifier(input).unwrap_or_else(|| panic!("no match: {input}"));
            assert_eq!(ident.kind, *want_kind, "kind for {input}");
            assert_eq!(ident.value, *want_value, "value for {input}");
        }
    }

    #[test]
    fn extract_primary_identifier_does_not_swallow_titles() {
        // Titles containing an identifier-looking fragment stay unrecognized
        // (multi-token input must go through batch classification instead).
        assert_eq!(
            extract_primary_identifier("Attention is all you need"),
            None
        );
        assert_eq!(
            extract_primary_identifier("Revisiting 1706.03762 and friends"),
            None
        );
    }

    #[test]
    fn parses_requested_skill_import_examples() {
        use crate::features::scholar_api::identifiers::extract_skill_source;

        for input in [
            "https://github.com/mattpocock/skills",
            "https://github.com/alchaincyf/nuwa-skill",
        ] {
            let ident = extract_primary_identifier(input).unwrap();
            assert_eq!(ident.kind, SKILL_KIND);
            assert_eq!(ident.value, input);
        }

        let input = "npx skills add https://github.com/anthropics/skills --skill pptx";
        let ident = extract_primary_identifier(input).unwrap();
        assert_eq!(ident.kind, SKILL_KIND);
        assert_eq!(ident.value, input);
        let source = extract_skill_source(input).unwrap();
        assert_eq!(source.owner, "anthropics");
        assert_eq!(source.repo, "skills");
        assert_eq!(source.skill_names, vec!["pptx"]);
    }

    #[tokio::test]
    async fn cancelled_task_skips_title_search() {
        let task_id = "test-resolve-search-cancelled";
        crate::cancel::testing::cancel(task_id);
        let mut errors = Vec::new();
        let groups = resolve_search_queries(
            &["attention is all you need".to_string()],
            &mut errors,
            Some(task_id),
        )
        .await;
        crate::cancel::testing::finish(task_id);
        // Cancelled before the first query runs: no groups, no network, no errors.
        assert!(groups.is_empty());
        assert!(errors.is_empty());
    }

    #[test]
    fn maps_api_paper_to_candidate() {
        use crate::features::scholar_api::{ApiPaper, PaperIdentifiers, PaperUrls};
        let p = ApiPaper {
            title: "Attention Is All You Need".into(),
            authors: vec!["Ashish Vaswani".into()],
            year: Some(2017),
            date: Some("2017".into()),
            venue: Some("NeurIPS".into()),
            volume: None,
            issue: None,
            pages: None,
            publisher: None,
            abstract_text: None,
            language: None,
            citation_count: Some(42),
            identifiers: PaperIdentifiers {
                arxiv_id: Some("1706.03762".into()),
                doi: Some("10.48550/arXiv.1706.03762".into()),
                ..Default::default()
            },
            urls: PaperUrls {
                landing: Some("https://arxiv.org/abs/1706.03762".into()),
                ..Default::default()
            },
            source: "arxiv",
        };
        let c = PaperSearchCandidate::from(p);
        assert_eq!(c.title, "Attention Is All You Need");
        assert_eq!(c.identifier, "1706.03762");
        assert_eq!(c.source, "arxiv");
    }
}
