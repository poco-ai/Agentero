//! Query-first arXiv discovery.
//!
//! Given a topic (keywords), a category set, and/or a submission-date window,
//! fetch candidates from the arXiv Atom API and rank them with a
//! **deterministic lexical scorer** — no embedding endpoint, no API key, no
//! catalog. This is the headless "抓当天 arXiv + 关键词排序" primitive that the
//! CLI / Agent can drive; the desktop plaza panel's library-profile ranking is
//! a separate concern.
//!
//! The score is explainable: every item carries the terms that matched and how
//! much each contributed (title hits weigh more than abstract hits).

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;

use crate::error::AppError;
use crate::features::paper::discovery::embeddings::{self, EmbeddingConfig};
use crate::features::scholar_api::sources::arxiv;
use crate::features::scholar_api::ApiPaper;

/// Title term weight — a title hit is a stronger topic signal than an abstract
/// hit, mirroring the classic keyword shortlist heuristic.
const TITLE_WEIGHT: f32 = 3.0;
/// Abstract term weight.
const ABSTRACT_WEIGHT: f32 = 1.0;
/// Candidates scanned when the caller does not cap them.
pub const DEFAULT_MAX_CANDIDATES: usize = 100;
/// Shortlist size when the caller does not ask for a specific one.
pub const DEFAULT_TOP: usize = 8;
/// Cosine weight added on top of the lexical score when semantic ranking runs.
pub const DEFAULT_SEMANTIC_WEIGHT: f32 = 1.0;
/// Chars of a candidate sent for embedding (providers cap tokens per input).
const MAX_EMBED_CHARS: usize = 4_000;

/// How multiple keywords combine in the arXiv `search_query`.
///
/// * [`KeywordMatch::All`] (default) — `all:a AND all:b`: only papers containing
///   *every* term. Historic behaviour; narrower recall.
/// * [`KeywordMatch::Any`] — `all:a OR all:b`: papers containing *any* term.
///   Broader recall for "radar" sweeps; the lexical scorer still ranks
///   multi-term hits higher, so exact AND-style papers float to the top.
///
/// Ignored when fewer than two keywords are supplied.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "lowercase")]
pub enum KeywordMatch {
    /// Combine with `AND` (a paper must contain every keyword).
    #[default]
    All,
    /// Combine with `OR` (a paper needs any keyword).
    Any,
}

/// A discovery request. At least one keyword or category is required; a date
/// window alone would scan an unbounded slice of arXiv.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverQuery {
    /// Topic terms / phrases (repeatable).
    #[serde(default)]
    pub keywords: Vec<String>,
    /// How to combine multiple keywords: `all` (AND, default) or `any` (OR).
    #[serde(default, skip_serializing_if = "is_default_keyword_match")]
    pub keyword_match: KeywordMatch,
    /// arXiv categories, e.g. `cs.AI`.
    #[serde(default)]
    pub categories: Vec<String>,
    /// Only papers submitted on/after this date (`YYYY-MM-DD`).
    #[serde(default)]
    pub since: Option<String>,
    /// Only papers submitted on/before this date (`YYYY-MM-DD`).
    #[serde(default)]
    pub until: Option<String>,
    /// Shortlist size.
    #[serde(default)]
    pub top: Option<usize>,
    /// Max candidates fetched before ranking.
    #[serde(default)]
    pub max_candidates: Option<usize>,
    /// Cosine weight added on top of the lexical score when an embedding
    /// endpoint is supplied (default [`DEFAULT_SEMANTIC_WEIGHT`]); ignored when
    /// no endpoint is passed.
    #[serde(default)]
    pub semantic_weight: Option<f32>,
}

/// One term's contribution to an item's score (for explainability).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreTerm {
    pub term: String,
    /// `"title"` or `"abstract"`.
    pub field: String,
    pub count: u32,
    pub weight: f32,
    pub contribution: f32,
}

/// A ranked discovery candidate.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverItem {
    pub arxiv_id: String,
    pub title: String,
    #[serde(rename = "abstract")]
    pub abstract_text: String,
    pub url: String,
    pub pdf_url: Option<String>,
    pub published_at: Option<String>,
    pub score: f32,
    /// Non-empty matchers, highest-contribution first is not guaranteed.
    pub matches: Vec<ScoreTerm>,
}

/// Result of one discovery run.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverResult {
    pub source: String,
    /// Echo of the request (with resolved defaults omitted).
    pub query: DiscoverQuery,
    /// The raw arXiv `search_query` expression, for transparency/replay.
    pub search_query: String,
    /// Candidates fetched before novelty filtering.
    pub candidates_scanned: usize,
    /// Candidates dropped because they are already known (e.g. in the library).
    pub excluded: usize,
    pub computed_at: String,
    /// Set when semantic ranking was requested but the endpoint failed; the
    /// result then degrades to lexical-only instead of erroring.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantic_error: Option<String>,
    pub items: Vec<DiscoverItem>,
}

/// Fetch + rank arXiv candidates for `query`.
///
/// `exclude_ids` drops candidates already known to the caller (typically the
/// library's arXiv ids) *before* ranking, so the shortlist fills with fresh
/// papers instead of being eaten by a truncated `top`. Pass an empty set for a
/// pure network discovery run.
///
/// `embedding`, when supplied, adds an optional cosine-similarity term to the
/// lexical score (see [`DiscoverQuery::semantic_weight`]); if that call fails
/// the run degrades to lexical-only and records `semantic_error`.
///
/// Network-only otherwise: does not touch the Vault or catalog.
pub async fn discover_arxiv(
    query: &DiscoverQuery,
    exclude_ids: &HashSet<String>,
    embedding: Option<&EmbeddingConfig>,
) -> Result<DiscoverResult, AppError> {
    let search_query = build_search_query(query)?;
    let max_candidates = query
        .max_candidates
        .unwrap_or(DEFAULT_MAX_CANDIDATES)
        .clamp(1, 200);
    let top = query.top.unwrap_or(DEFAULT_TOP).clamp(1, max_candidates);

    let papers = arxiv::query_atom(&search_query, 0, max_candidates).await?;
    let candidates_scanned = papers.len();

    let (kept, excluded) = drop_known(papers, exclude_ids);
    let terms = normalize_terms(&query.keywords);
    let mut items = score_lexical(kept, &terms);

    let mut semantic_error = None;
    if let Some(config) = embedding {
        if !terms.is_empty() && !items.is_empty() {
            let weight = query.semantic_weight.unwrap_or(DEFAULT_SEMANTIC_WEIGHT);
            if let Err(err) = apply_semantic(&mut items, &terms, config, weight).await {
                log::warn!(target: "agentero::discover", "semantic ranking skipped: {err}");
                semantic_error = Some(err.to_string());
            }
        }
    }

    let items = finalize(items, top);

    Ok(DiscoverResult {
        source: "arxiv".to_string(),
        query: query.clone(),
        search_query,
        candidates_scanned,
        excluded,
        computed_at: crate::time::now_rfc3339_millis(),
        semantic_error,
        items,
    })
}

/// Add `weight * cosine(query, candidate)` to each item and record it as a
/// `semantic` score term. Degrades to lexical on any endpoint error.
async fn apply_semantic(
    items: &mut [DiscoverItem],
    terms: &[String],
    config: &EmbeddingConfig,
    weight: f32,
) -> Result<(), AppError> {
    let mut texts: Vec<String> = Vec::with_capacity(items.len() + 1);
    texts.push(terms.join(" "));
    for item in items.iter() {
        texts.push(embed_input(&item.title, &item.abstract_text));
    }

    let mut vectors = embeddings::embed_texts(config, &texts).await?;
    if vectors.len() != texts.len() {
        return Err(AppError::message(
            "embeddings returned the wrong number of vectors",
        ));
    }
    for vector in vectors.iter_mut() {
        embeddings::normalize(vector);
    }
    let query_vector = vectors.remove(0);
    apply_semantic_vectors(items, &query_vector, &vectors, weight);
    Ok(())
}

/// Add `weight * cosine(query, candidate)` to each item and record it as a
/// `semantic` score term. Pure so the blend is unit-testable.
fn apply_semantic_vectors(
    items: &mut [DiscoverItem],
    query_vector: &[f32],
    vectors: &[Vec<f32>],
    weight: f32,
) {
    for (item, candidate) in items.iter_mut().zip(vectors.iter()) {
        let contribution = if query_vector.len() == candidate.len() {
            weight * embeddings::dot(query_vector, candidate)
        } else {
            0.0
        };
        item.score += contribution;
        item.matches.push(ScoreTerm {
            term: "<semantic>".to_string(),
            field: "semantic".to_string(),
            count: 0,
            weight,
            contribution,
        });
    }
}

fn embed_input(title: &str, abstract_text: &str) -> String {
    let joined = format!("{}\n\n{}", title.trim(), abstract_text.trim());
    joined.chars().take(MAX_EMBED_CHARS).collect()
}

/// Split candidates into "kept" and "already known" (dropped). Papers with no
/// arXiv id are always kept — novelty cannot be judged.
fn drop_known(papers: Vec<ApiPaper>, exclude: &HashSet<String>) -> (Vec<ApiPaper>, usize) {
    if exclude.is_empty() {
        return (papers, 0);
    }
    let mut kept = Vec::with_capacity(papers.len());
    let mut dropped = 0usize;
    for paper in papers {
        match paper.identifiers.arxiv_id.as_deref() {
            Some(id) if exclude.contains(id) => dropped += 1,
            _ => kept.push(paper),
        }
    }
    (kept, dropped)
}

/// arXiv ids already present in the vault's catalog, for novelty filtering.
///
/// Returns an empty set when the catalog has no arXiv papers.
pub fn known_arxiv_ids(vault_root: &Path) -> Result<HashSet<String>, AppError> {
    let papers = crate::features::paper::catalog::papers::list_all_unique_by_id(vault_root)?;
    Ok(papers
        .into_iter()
        .filter_map(|paper| paper.arxiv_id)
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect())
}

/// Compose the arXiv `search_query` expression from keywords / categories /
/// submission-date bounds. Pure so it is unit-testable without the network.
///
/// Keywords combine per [`DiscoverQuery::keyword_match`] (`AND` by default,
/// `OR` for broader recall). An `OR` keyword group is parenthesised so it stays
/// grouped against the AND-ed category / date clauses; a flat `AND` group needs
/// no parens, keeping the default query byte-identical to the historic form.
fn build_search_query(query: &DiscoverQuery) -> Result<String, AppError> {
    let mut clauses: Vec<String> = Vec::new();

    // Keywords, combined per keyword_match (default AND).
    let mut kw_clauses: Vec<String> = Vec::new();
    for keyword in &query.keywords {
        let keyword = keyword.trim();
        if keyword.is_empty() {
            continue;
        }
        if keyword.chars().any(char::is_whitespace) {
            // Multi-word phrase → quoted so arXiv treats it as one unit.
            let q = '"';
            let phrase = keyword.replace(q, " ");
            kw_clauses.push(format!("all:{q}{phrase}{q}"));
        } else {
            kw_clauses.push(format!("all:{keyword}"));
        }
    }
    match kw_clauses.len() {
        0 => {}
        1 => clauses.push(kw_clauses.pop().expect("len == 1")),
        _ => {
            let is_or = matches!(query.keyword_match, KeywordMatch::Any);
            let group = kw_clauses.join(if is_or { " OR " } else { " AND " });
            // Parenthesise only the OR group; a flat AND group stays bare.
            clauses.push(if is_or { format!("({group})") } else { group });
        }
    }

    for category in &query.categories {
        let category = category.trim();
        if !category.is_empty() {
            clauses.push(format!("cat:{category}"));
        }
    }

    let from = query
        .since
        .as_deref()
        .map(|d| date_bound(d, false))
        .transpose()?;
    let to = query
        .until
        .as_deref()
        .map(|d| date_bound(d, true))
        .transpose()?;
    match (from, to) {
        (Some(from), Some(to)) => clauses.push(format!("submittedDate:[{from} TO {to}]")),
        (Some(from), None) => clauses.push(format!("submittedDate:[{from} TO 999912312359]")),
        (None, Some(to)) => clauses.push(format!("submittedDate:[000001010000 TO {to}]")),
        (None, None) => {}
    }

    if clauses.is_empty() {
        return Err(AppError::domain(
            "usage",
            "discover: provide at least one keyword or category",
        ));
    }
    Ok(clauses.join(" AND "))
}

fn is_default_keyword_match(keyword_match: &KeywordMatch) -> bool {
    matches!(keyword_match, KeywordMatch::All)
}

/// `YYYY-MM-DD` → arXiv `submittedDate` bound (`YYYYMMDD0000` / `YYYYMMDD2359`).
fn date_bound(date: &str, end: bool) -> Result<String, AppError> {
    let parsed = chrono::NaiveDate::parse_from_str(date.trim(), "%Y-%m-%d").map_err(|_| {
        AppError::domain(
            "usage",
            format!("discover: invalid date '{date}' (expected YYYY-MM-DD)"),
        )
    })?;
    let suffix = if end { "2359" } else { "0000" };
    Ok(format!("{}{suffix}", parsed.format("%Y%m%d")))
}

/// Lowercased, de-duplicated, non-empty query terms.
fn normalize_terms(keywords: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for keyword in keywords {
        let term = keyword.trim().to_lowercase().replace('"', "");
        if term.is_empty() || out.iter().any(|existing| existing == &term) {
            continue;
        }
        out.push(term);
    }
    out
}

fn count_occurrences(haystack: &str, needle: &str) -> u32 {
    if needle.is_empty() {
        return 0;
    }
    haystack.matches(needle).count() as u32
}

/// Score candidates against the normalized `terms` (no sort / truncate).
/// With no terms every score is zero, so [`finalize`] preserves the
/// submission-date ordering from the arXiv query.
fn score_lexical(papers: Vec<ApiPaper>, terms: &[String]) -> Vec<DiscoverItem> {
    papers
        .into_iter()
        .map(|paper| {
            let title = paper.title.trim().to_string();
            let abstract_text = paper.abstract_text.unwrap_or_default().trim().to_string();
            let title_lower = title.to_lowercase();
            let abstract_lower = abstract_text.to_lowercase();

            let mut matches: Vec<ScoreTerm> = Vec::new();
            let mut score = 0.0_f32;
            for term in terms {
                let title_hits = count_occurrences(&title_lower, term);
                let abstract_hits = count_occurrences(&abstract_lower, term);
                if title_hits == 0 && abstract_hits == 0 {
                    continue;
                }
                if title_hits > 0 {
                    let contribution = title_hits as f32 * TITLE_WEIGHT;
                    score += contribution;
                    matches.push(ScoreTerm {
                        term: term.clone(),
                        field: "title".to_string(),
                        count: title_hits,
                        weight: TITLE_WEIGHT,
                        contribution,
                    });
                }
                if abstract_hits > 0 {
                    let contribution = abstract_hits as f32 * ABSTRACT_WEIGHT;
                    score += contribution;
                    matches.push(ScoreTerm {
                        term: term.clone(),
                        field: "abstract".to_string(),
                        count: abstract_hits,
                        weight: ABSTRACT_WEIGHT,
                        contribution,
                    });
                }
            }

            DiscoverItem {
                arxiv_id: paper.identifiers.arxiv_id.unwrap_or_default(),
                title,
                abstract_text,
                url: paper.urls.landing.unwrap_or_default(),
                pdf_url: paper.urls.pdf,
                published_at: paper.date,
                score,
                matches,
            }
        })
        .collect()
}

/// Sort by score (desc), then newest, then title; truncate to `top`.
fn finalize(mut items: Vec<DiscoverItem>, top: usize) -> Vec<DiscoverItem> {
    items.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| b.published_at.cmp(&a.published_at))
            .then_with(|| a.title.cmp(&b.title))
    });
    items.truncate(top);
    items
}

/// Lexical-only ranking helper (unit tests).
#[cfg(test)]
fn rank(papers: Vec<ApiPaper>, keywords: &[String], top: usize) -> Vec<DiscoverItem> {
    finalize(score_lexical(papers, &normalize_terms(keywords)), top)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::scholar_api::{PaperIdentifiers, PaperUrls};

    fn paper(id: &str, title: &str, abstract_text: &str, date: &str) -> ApiPaper {
        ApiPaper {
            identifiers: PaperIdentifiers {
                arxiv_id: Some(id.to_string()),
                ..Default::default()
            },
            title: title.to_string(),
            abstract_text: Some(abstract_text.to_string()),
            date: Some(date.to_string()),
            urls: PaperUrls {
                landing: Some(format!("https://arxiv.org/abs/{id}")),
                pdf: Some(format!("https://arxiv.org/pdf/{id}")),
                ..Default::default()
            },
            source: "arxiv",
            ..Default::default()
        }
    }

    #[test]
    fn builds_keyword_category_and_date_clauses() {
        let query = DiscoverQuery {
            keywords: vec!["agent".into(), "world model".into()],
            categories: vec!["cs.AI".into()],
            since: Some("2026-08-01".into()),
            until: Some("2026-08-07".into()),
            ..Default::default()
        };
        assert_eq!(
            build_search_query(&query).unwrap(),
            "all:agent AND all:\"world model\" AND cat:cs.AI \
             AND submittedDate:[202608010000 TO 202608072359]"
        );
    }

    #[test]
    fn keyword_or_is_grouped_against_category() {
        let query = DiscoverQuery {
            keywords: vec!["dance".into(), "choreography".into()],
            categories: vec!["cs.HC".into()],
            keyword_match: KeywordMatch::Any,
            ..Default::default()
        };
        assert_eq!(
            build_search_query(&query).unwrap(),
            "(all:dance OR all:choreography) AND cat:cs.HC"
        );
    }

    #[test]
    fn keyword_or_with_phrase_and_date_window() {
        let query = DiscoverQuery {
            keywords: vec!["dance".into(), "dance history".into()],
            since: Some("2026-10-01".into()),
            until: Some("2026-11-07".into()),
            keyword_match: KeywordMatch::Any,
            ..Default::default()
        };
        assert_eq!(
            build_search_query(&query).unwrap(),
            "(all:dance OR all:\"dance history\") \
             AND submittedDate:[202610010000 TO 202611072359]"
        );
    }

    #[test]
    fn single_keyword_ignores_match_mode() {
        let mut query = DiscoverQuery {
            keywords: vec!["dance".into()],
            keyword_match: KeywordMatch::Any,
            ..Default::default()
        };
        assert_eq!(build_search_query(&query).unwrap(), "all:dance");
        query.keyword_match = KeywordMatch::All;
        assert_eq!(build_search_query(&query).unwrap(), "all:dance");
    }

    #[test]
    fn date_bound_rejects_bad_dates() {
        let err = build_search_query(&DiscoverQuery {
            keywords: vec!["agent".into()],
            since: Some("2026/08/01".into()),
            ..Default::default()
        })
        .unwrap_err();
        assert_eq!(err.code(), "usage");
    }

    #[test]
    fn empty_query_is_usage_error() {
        let err = build_search_query(&DiscoverQuery::default()).unwrap_err();
        assert_eq!(err.code(), "usage");
    }

    #[test]
    fn title_hits_outweigh_abstract_hits() {
        let candidates = vec![
            paper("1", "agentic search", "", "2026-08-01T00:00:00Z"),
            paper(
                "2",
                "unrelated",
                "we study agent behaviour",
                "2026-08-02T00:00:00Z",
            ),
        ];
        let ranked = rank(candidates, &["agent".to_string()], 8);
        assert_eq!(ranked[0].arxiv_id, "1");
        assert!(ranked[0].score > ranked[1].score);
        // Title match carries the 3x weight.
        assert_eq!(ranked[0].matches[0].field, "title");
        assert_eq!(ranked[0].matches[0].weight, TITLE_WEIGHT);
    }

    #[test]
    fn no_keywords_preserve_newest_first() {
        let candidates = vec![
            paper("old", "a", "", "2026-08-01T00:00:00Z"),
            paper("new", "b", "", "2026-08-05T00:00:00Z"),
        ];
        let ranked = rank(candidates, &[], 8);
        assert_eq!(ranked[0].arxiv_id, "new");
    }

    #[test]
    fn rank_truncates_to_top() {
        let candidates = (0..10)
            .map(|i| paper(&i.to_string(), "agent", "", "2026-08-01T00:00:00Z"))
            .collect();
        assert_eq!(rank(candidates, &["agent".to_string()], 3).len(), 3);
    }

    #[test]
    fn phrase_term_matches_contiguous_text() {
        let candidates = vec![paper(
            "1",
            "a world model for agents",
            "",
            "2026-08-01T00:00:00Z",
        )];
        let ranked = rank(candidates, &["world model".to_string()], 8);
        assert!(!ranked[0].matches.is_empty());
    }

    #[test]
    fn semantic_vectors_add_cosine_and_reorder() {
        // Two candidates with equal lexical score; semantic decides.
        let candidates = vec![
            paper("low", "agent", "", "2026-08-01T00:00:00Z"),
            paper("high", "agent", "", "2026-08-01T00:00:00Z"),
        ];
        let mut items = score_lexical(candidates, &["agent".to_string()]);
        let query = vec![1.0_f32, 0.0];
        let vectors = vec![vec![0.1_f32, 0.0], vec![0.9_f32, 0.0]];
        apply_semantic_vectors(&mut items, &query, &vectors, 2.0);

        let ranked = finalize(items, 8);
        assert_eq!(ranked[0].arxiv_id, "high");
        assert!((ranked[0].score - (3.0 + 1.8)).abs() < 1e-5);
        assert_eq!(ranked[0].matches.last().unwrap().field, "semantic");
    }

    #[test]
    fn semantic_dimension_mismatch_is_zero() {
        let candidates = vec![paper("a", "agent", "", "2026-08-01T00:00:00Z")];
        let mut items = score_lexical(candidates, &["agent".to_string()]);
        let before = items[0].score;
        apply_semantic_vectors(&mut items, &[1.0, 0.0], &[vec![0.5]], 1.0);
        assert!((items[0].score - before).abs() < 1e-6);
    }

    #[test]
    fn drop_known_removes_library_ids_only() {
        let candidates = vec![
            paper("known", "a", "", "2026-08-01T00:00:00Z"),
            paper("fresh", "b", "", "2026-08-01T00:00:00Z"),
        ];
        let exclude: HashSet<String> = ["known".to_string()].into_iter().collect();
        let (kept, dropped) = drop_known(candidates, &exclude);
        assert_eq!(dropped, 1);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].identifiers.arxiv_id.as_deref(), Some("fresh"));

        // Empty exclude is a no-op.
        let single = vec![paper("x", "t", "", "2026-08-01T00:00:00Z")];
        let (kept, dropped) = drop_known(single, &HashSet::new());
        assert_eq!((kept.len(), dropped), (1, 0));
    }
}
