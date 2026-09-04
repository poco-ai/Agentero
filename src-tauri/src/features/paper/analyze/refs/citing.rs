//! Reverse citation discovery: which *new* papers cite the library?
//!
//! The inverse of [`super`]: forward references come from local TeX/`.bbl`, but
//! "who cites me" exists only online. Semantic Scholar is the only usable
//! source — OpenAlex's graph barely contains arXiv preprint→preprint edges,
//! which is exactly where new work lives.
//!
//! Three filter layers keep the output small enough to read:
//!   L0 hard filters — skip mega-cited seeds (their citers are cross-domain
//!      noise), drop candidates outside the date window / already in the
//!      library / without an importable identifier.
//!   L1 IDF overlap — weight each cited paper by `1/log10(citations + 10)`, so
//!      citing a 190k-citation classic counts for almost nothing.
//!   L2 SPECTER2 similarity — centered max-sim against my own papers, with the
//!      threshold self-calibrated from my own library.
//!
//! @see docs/backend/citation-parsing.md

use super::latex;
use crate::core::error::AppError;
use crate::core::http;
use crate::features::catalog::papers;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures_util::stream::{self, StreamExt};

const CITING_SCAN_REL: &str = ".agentero/citing-scan.json";
const CACHE_SCHEMA_VERSION: u32 = 1;
const S2_BASE: &str = "https://api.semanticscholar.org/graph/v1";

/// Above this, a paper is a field-defining classic: its citers say nothing
/// about *my* direction, and paging through 100k of them is pointless.
const SEED_CITES_MAX: u32 = 2000;
/// 8 parallel citation requests measured 4.6x faster than sequential with no
/// sustained 429s on the shared pool.
const FETCH_CONCURRENCY: usize = 8;
const BATCH_IDS_MAX: usize = 500;
const CITATION_PAGE: usize = 1000;
/// S2 rejects `offset + limit >= 10000`.
const OFFSET_CAP: usize = 10000;
const DEFAULT_SINCE_DAYS: i64 = 183;
const DEFAULT_BUDGET: usize = 20;
/// Relevance vs. redundancy in the final pick. 0.7 keeps the strongest hits
/// while still leaving room for a second research direction.
const MMR_LAMBDA: f32 = 0.7;
/// MMR is quadratic; there is no point diversifying a long tail.
const MMR_POOL: usize = 150;
const MAX_RETRIES: usize = 6;

// ---------------------------------------------------------------- public types

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CitingCandidate {
    pub s2_id: String,
    pub title: String,
    pub date: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arxiv_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
    /// Ready for `lookupSubmit`: `arXiv:{id}` or a bare DOI.
    pub identifier: String,
    /// Vault-relative paths of my papers this candidate cites.
    pub cited_by_mine: Vec<String>,
    /// IDF-weighted overlap; the primary ranking signal.
    pub weight: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub similarity: Option<f32>,
    pub citation_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oa_pdf_url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CitingScanResult {
    pub generated_at: String,
    pub since_date: String,
    pub library_total: usize,
    /// Papers eligible as seeds (in S2, cited at least once, not mega-cited).
    pub seeds_total: usize,
    /// Seeds that actually hit the network this run (rest came from cache).
    pub seeds_fetched: usize,
    pub skipped_mega_cited: usize,
    pub skipped_uncited: usize,
    /// No identifier, or the identifier is unknown to S2.
    pub skipped_unknown: usize,
    pub raw_citing: usize,
    pub after_filters: usize,
    pub gate_passed: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub similarity_threshold: Option<f32>,
    pub candidates: Vec<CitingCandidate>,
    pub cancelled: bool,
    #[serde(default)]
    pub messages: Vec<String>,
}

/// `(phase, done, total, percent)`
type ProgressFn = dyn Fn(&str, Option<usize>, Option<usize>, Option<u8>) + Send + Sync;

/// Host-side hooks. Kept as plain callbacks so this module stays free of
/// Tauri: `features::agent` (cancellation) and event emit are desktop-only,
/// while `refs` is also compiled into the headless CLI.
#[derive(Default, Clone, Copy)]
pub struct ScanHooks<'a> {
    pub cancelled: Option<&'a (dyn Fn() -> bool + Send + Sync)>,
    pub progress: Option<&'a ProgressFn>,
}

impl ScanHooks<'_> {
    fn is_cancelled(&self) -> bool {
        self.cancelled.map(|f| f()).unwrap_or(false)
    }

    fn report(&self, phase: &str, done: Option<usize>, total: Option<usize>, pct: Option<u8>) {
        if let Some(f) = self.progress {
            f(phase, done, total, pct);
        }
    }
}

pub struct ScanOptions {
    pub since_days: i64,
    pub budget: usize,
    /// Ignore cached citation pages and refetch every seed.
    pub force: bool,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            since_days: DEFAULT_SINCE_DAYS,
            budget: DEFAULT_BUDGET,
            force: false,
        }
    }
}

// ----------------------------------------------------------------- cache types

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CitingRaw {
    s2_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    /// `publicationDate`, or `{year}-01-01` when only the year is known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    arxiv_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    doi: Option<String>,
    #[serde(default)]
    citation_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    oa_pdf_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeedCache {
    s2_id: String,
    citation_count: u32,
    fetched_at: String,
    citing: Vec<CitingRaw>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CitingScanCache {
    #[serde(default)]
    schema_version: u32,
    #[serde(default)]
    generated_at: String,
    /// Keyed by vault-relative paper path.
    #[serde(default)]
    seeds: BTreeMap<String, SeedCache>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_result: Option<CitingScanResult>,
}

fn cache_path(vault: &Path) -> PathBuf {
    vault.join(CITING_SCAN_REL)
}

fn load_cache(vault: &Path) -> CitingScanCache {
    let Ok(raw) = fs::read_to_string(cache_path(vault)) else {
        return CitingScanCache::default();
    };
    let cache: CitingScanCache = serde_json::from_str(&raw).unwrap_or_default();
    if cache.schema_version != CACHE_SCHEMA_VERSION {
        return CitingScanCache::default();
    }
    cache
}

fn save_cache(vault: &Path, cache: &CitingScanCache) -> Result<(), AppError> {
    let path = cache_path(vault);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    // Plain write, no tmp+rename: the vault watcher reports renames without a
    // verified from/to pair as an "unverified rename" toast (see
    // `write_sidecar`). This cache is rebuildable, so atomicity is not worth
    // that noise.
    fs::write(path, serde_json::to_string(cache)?)?;
    Ok(())
}

/// Last scan result for this vault, if any. Lets the UI reopen the candidate
/// list without going back online.
pub fn cached_result(vault: &Path) -> Option<CitingScanResult> {
    load_cache(vault).last_result
}

// -------------------------------------------------------------- pure functions

/// Informativeness of a cited paper: citing a 190k-citation classic tells us
/// almost nothing, citing a brand-new preprint tells us a lot.
fn idf_weight(citation_count: u32) -> f32 {
    1.0 / ((citation_count as f32 + 10.0).log10())
}

fn norm(v: &[f32]) -> Vec<f32> {
    let len = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if len <= f32::EPSILON {
        return v.to_vec();
    }
    v.iter().map(|x| x / len).collect()
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

fn mean_vec(vs: &[Vec<f32>]) -> Vec<f32> {
    let Some(dim) = vs.first().map(|v| v.len()) else {
        return Vec::new();
    };
    let mut out = vec![0.0; dim];
    for v in vs {
        for (slot, x) in out.iter_mut().zip(v) {
            *slot += *x;
        }
    }
    let n = vs.len() as f32;
    for slot in &mut out {
        *slot /= n;
    }
    out
}

/// Raw SPECTER2 cosines all sit in 0.80–0.96, so an absolute threshold cannot
/// discriminate. Subtracting the background mean spreads them out.
fn center(v: &[f32], bg: &[f32]) -> Vec<f32> {
    let unit = norm(v);
    norm(&unit.iter().zip(bg).map(|(x, b)| x - b).collect::<Vec<_>>())
}

fn percentile(sorted_input: &[f32], p: usize) -> f32 {
    if sorted_input.is_empty() {
        return 0.0;
    }
    let mut xs = sorted_input.to_vec();
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let idx = (xs.len() * p / 100).min(xs.len() - 1);
    xs[idx]
}

/// Self-calibrated relevance threshold: the p10 of "how similar is each of my
/// papers to its nearest *other* paper". Absolute constants do not transfer
/// across fields, this does.
fn self_similarity_threshold(refs: &[Vec<f32>]) -> Option<f32> {
    if refs.len() < 2 {
        return None;
    }
    let scores: Vec<f32> = refs
        .iter()
        .enumerate()
        .map(|(i, v)| {
            refs.iter()
                .enumerate()
                .filter(|(j, _)| *j != i)
                .map(|(_, o)| cosine(v, o))
                .fold(f32::MIN, f32::max)
        })
        .collect();
    Some(percentile(&scores, 10))
}

/// Max similarity to any single one of my papers — not to their centroid. A
/// multi-topic library has no meaningful average, and a candidate only needs
/// to be close to *one* of my directions to be relevant.
fn max_similarity(v: &[f32], refs: &[Vec<f32>]) -> Option<f32> {
    refs.iter()
        .map(|r| cosine(v, r))
        .fold(None, |acc: Option<f32>, s| {
            Some(acc.map_or(s, |a| a.max(s)))
        })
}

/// Greedy maximal-marginal-relevance pick. Without it the budget fills up with
/// near-duplicates from whichever direction happens to be hottest.
fn mmr_select(scores: &[f32], vectors: &[Option<Vec<f32>>], budget: usize) -> Vec<usize> {
    let mut remaining: Vec<usize> = (0..scores.len()).collect();
    let mut picked: Vec<usize> = Vec::new();
    while picked.len() < budget && !remaining.is_empty() {
        let mut best_pos = 0;
        let mut best_val = f32::MIN;
        for (pos, &idx) in remaining.iter().enumerate() {
            let redundancy = match &vectors[idx] {
                Some(v) => picked
                    .iter()
                    .filter_map(|p| vectors[*p].as_ref())
                    .map(|p| cosine(v, p))
                    .fold(0.0_f32, f32::max),
                None => 0.0,
            };
            let val = MMR_LAMBDA * scores[idx] - (1.0 - MMR_LAMBDA) * redundancy;
            if val > best_val {
                best_val = val;
                best_pos = pos;
            }
        }
        picked.push(remaining.remove(best_pos));
    }
    picked
}

fn normalize_doi(raw: &str) -> Option<String> {
    let cleaned = raw
        .trim()
        .trim_start_matches("https://doi.org/")
        .trim_start_matches("http://doi.org/")
        .trim()
        .to_ascii_lowercase();
    (!cleaned.is_empty()).then_some(cleaned)
}

fn normalize_arxiv(raw: &str) -> Option<String> {
    let cleaned = latex::strip_arxiv_version(raw.trim())
        .trim()
        .to_ascii_lowercase();
    (!cleaned.is_empty()).then_some(cleaned)
}

/// Both identifier routes must be checked: a candidate may carry only a DOI
/// while the library entry has only an arXiv id (and vice versa).
fn already_in_library(
    arxiv: Option<&String>,
    doi: Option<&String>,
    lib_arxiv: &HashSet<String>,
    lib_doi: &HashSet<String>,
) -> bool {
    if let Some(a) = arxiv {
        if lib_arxiv.contains(a) {
            return true;
        }
    }
    if let Some(d) = doi {
        if lib_doi.contains(d) {
            return true;
        }
        // arXiv DOIs (`10.48550/arxiv.2501.00001`) alias an arXiv id.
        if let Some(rest) = d.strip_prefix("10.48550/arxiv.") {
            if lib_arxiv.contains(rest) {
                return true;
            }
        }
    }
    false
}

/// `arXiv:{id}` preferred over DOI — matches `citationImportIdentifier` on the
/// frontend and gives the importer a source with a fetchable PDF.
fn import_identifier(arxiv: Option<&String>, doi: Option<&String>) -> Option<String> {
    if let Some(a) = arxiv {
        return Some(format!("arXiv:{a}"));
    }
    doi.cloned()
}

fn since_date(days: i64) -> String {
    (chrono::Utc::now().date_naive() - chrono::Duration::days(days.max(0)))
        .format("%Y-%m-%d")
        .to_string()
}

// ------------------------------------------------------------------ S2 client

fn http_client() -> Result<reqwest::Client, AppError> {
    http::shared_client()
}

async fn s2_get(client: &reqwest::Client, url: &str) -> Result<serde_json::Value, AppError> {
    for attempt in 0..MAX_RETRIES {
        let res = client
            .get(url)
            .header("Accept", "application/json")
            .header("User-Agent", http::USER_AGENT)
            .timeout(Duration::from_secs(90))
            .send()
            .await;
        match res {
            Ok(r) if r.status().as_u16() == 429 => {
                tokio::time::sleep(Duration::from_secs(2 + attempt as u64 * 2)).await;
            }
            Ok(r) if r.status().is_success() => {
                return r
                    .json()
                    .await
                    .map_err(|e| AppError::message(format!("s2 json: {e}")));
            }
            Ok(r) => return Err(AppError::message(format!("s2 http {}", r.status()))),
            Err(e) if attempt + 1 < MAX_RETRIES => {
                tokio::time::sleep(Duration::from_secs(1 + attempt as u64)).await;
                let _ = e;
            }
            Err(e) => return Err(AppError::message(format!("s2 request: {e}"))),
        }
    }
    Err(AppError::message("s2 rate limited"))
}

/// `POST /paper/batch` — up to 500 ids in one request; entries align with the
/// input and are `null` for unknown ids.
async fn s2_batch(
    client: &reqwest::Client,
    ids: &[String],
    fields: &str,
) -> Result<Vec<Option<serde_json::Value>>, AppError> {
    let url = format!("{S2_BASE}/paper/batch?fields={fields}");
    for attempt in 0..MAX_RETRIES {
        let res = client
            .post(&url)
            .header("User-Agent", http::USER_AGENT)
            .timeout(Duration::from_secs(120))
            .json(&serde_json::json!({ "ids": ids }))
            .send()
            .await;
        match res {
            Ok(r) if r.status().as_u16() == 429 => {
                tokio::time::sleep(Duration::from_secs(2 + attempt as u64 * 2)).await;
            }
            Ok(r) if r.status().is_success() => {
                let value: serde_json::Value = r
                    .json()
                    .await
                    .map_err(|e| AppError::message(format!("s2 batch json: {e}")))?;
                let arr = value
                    .as_array()
                    .ok_or_else(|| AppError::message("s2 batch: expected array"))?;
                return Ok(arr
                    .iter()
                    .map(|v| if v.is_null() { None } else { Some(v.clone()) })
                    .collect());
            }
            Ok(r) => return Err(AppError::message(format!("s2 batch http {}", r.status()))),
            Err(e) if attempt + 1 < MAX_RETRIES => {
                tokio::time::sleep(Duration::from_secs(1 + attempt as u64)).await;
                let _ = e;
            }
            Err(e) => return Err(AppError::message(format!("s2 batch request: {e}"))),
        }
    }
    Err(AppError::message("s2 batch rate limited"))
}

fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn parse_citing(cp: &serde_json::Value) -> Option<CitingRaw> {
    let s2_id = str_field(cp, "paperId")?;
    let ext = cp.get("externalIds");
    let arxiv = ext
        .and_then(|e| e.get("ArXiv"))
        .and_then(|v| v.as_str())
        .and_then(normalize_arxiv);
    let doi = ext
        .and_then(|e| e.get("DOI"))
        .and_then(|v| v.as_str())
        .and_then(normalize_doi);
    let date = str_field(cp, "publicationDate").or_else(|| {
        cp.get("year")
            .and_then(|v| v.as_i64())
            .map(|y| format!("{y}-01-01"))
    });
    Some(CitingRaw {
        s2_id,
        title: str_field(cp, "title"),
        date,
        arxiv_id: arxiv,
        doi,
        citation_count: cp
            .get("citationCount")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32,
        oa_pdf_url: cp
            .get("openAccessPdf")
            .and_then(|v| v.get("url"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    })
}

/// All citers of one paper. Paginated at 1000; the offset cap means the tail of
/// a mega-cited paper is unreachable — which is why those are skipped upstream.
async fn s2_citations(client: &reqwest::Client, s2_id: &str) -> Result<Vec<CitingRaw>, AppError> {
    let mut out = Vec::new();
    let mut offset = 0usize;
    loop {
        let url = format!(
            "{S2_BASE}/paper/{}/citations?fields=title,publicationDate,year,externalIds,citationCount,openAccessPdf&limit={CITATION_PAGE}&offset={offset}",
            urlencoding::encode(s2_id)
        );
        let value = s2_get(client, &url).await?;
        let Some(items) = value.get("data").and_then(|v| v.as_array()) else {
            break;
        };
        for item in items {
            if let Some(cp) = item.get("citingPaper") {
                if let Some(raw) = parse_citing(cp) {
                    out.push(raw);
                }
            }
        }
        let next = value
            .get("next")
            .and_then(|v| v.as_u64())
            .map(|n| n as usize);
        match next {
            Some(n) if n + CITATION_PAGE <= OFFSET_CAP => offset = n,
            _ => break,
        }
    }
    Ok(out)
}

// ------------------------------------------------------------------ scan entry

struct LibPaper {
    path: String,
    arxiv: Option<String>,
    doi: Option<String>,
    s2_query_id: Option<String>,
    s2_id: Option<String>,
    citation_count: Option<u32>,
    vector: Option<Vec<f32>>,
}

/// Scan the whole library for new papers citing it.
pub async fn scan(
    vault: &Path,
    opts: &ScanOptions,
    hooks: ScanHooks<'_>,
) -> Result<CitingScanResult, AppError> {
    let since = since_date(opts.since_days);
    let mut messages: Vec<String> = Vec::new();

    // ---- library side -----------------------------------------------------
    hooks.report("citingMeta", None, None, Some(2));
    let records = papers::list_all(vault)?;
    let mut library: Vec<LibPaper> = records
        .iter()
        .map(|r| {
            let arxiv = r.arxiv_id.as_deref().and_then(normalize_arxiv);
            let doi = r.doi.as_deref().and_then(normalize_doi);
            let s2_query_id = arxiv
                .as_ref()
                .map(|a| format!("arXiv:{a}"))
                .or_else(|| doi.as_ref().map(|d| format!("DOI:{d}")));
            LibPaper {
                path: r.path.clone(),
                arxiv,
                doi,
                s2_query_id,
                s2_id: None,
                citation_count: None,
                vector: None,
            }
        })
        .collect();

    let lib_arxiv: HashSet<String> = library.iter().filter_map(|p| p.arxiv.clone()).collect();
    let lib_doi: HashSet<String> = library.iter().filter_map(|p| p.doi.clone()).collect();

    if hooks.is_cancelled() {
        return Ok(cancelled_result(&since, library.len()));
    }

    // One batch request buys citation counts (the L0 skip list) and SPECTER2
    // vectors (the L2 gate) for the entire library.
    let client = http_client()?;
    let query_indices: Vec<usize> = library
        .iter()
        .enumerate()
        .filter_map(|(i, p)| p.s2_query_id.as_ref().map(|_| i))
        .collect();
    for chunk in query_indices.chunks(BATCH_IDS_MAX) {
        let ids: Vec<String> = chunk
            .iter()
            .map(|i| library[*i].s2_query_id.clone().unwrap_or_default())
            .collect();
        match s2_batch(&client, &ids, "paperId,citationCount,embedding.specter_v2").await {
            Ok(rows) => {
                for (i, row) in chunk.iter().zip(rows) {
                    let Some(row) = row else { continue };
                    library[*i].s2_id = str_field(&row, "paperId");
                    library[*i].citation_count = row
                        .get("citationCount")
                        .and_then(|v| v.as_u64())
                        .map(|v| v as u32);
                    library[*i].vector = row
                        .get("embedding")
                        .and_then(|e| e.get("vector"))
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|x| x.as_f64())
                                .map(|x| x as f32)
                                .collect::<Vec<f32>>()
                        })
                        .filter(|v| !v.is_empty());
                }
            }
            Err(e) => messages.push(format!("library metadata: {e}")),
        }
    }

    let skipped_mega_cited = library
        .iter()
        .filter(|p| p.citation_count.is_some_and(|c| c > SEED_CITES_MAX))
        .count();
    let skipped_uncited = library
        .iter()
        .filter(|p| p.citation_count == Some(0))
        .count();
    let skipped_unknown = library
        .iter()
        .filter(|p| p.citation_count.is_none())
        .count();

    let seed_indices: Vec<usize> = library
        .iter()
        .enumerate()
        .filter(|(_, p)| {
            p.s2_id.is_some()
                && p.citation_count
                    .is_some_and(|c| c > 0 && c <= SEED_CITES_MAX)
        })
        .map(|(i, _)| i)
        .collect();

    if hooks.is_cancelled() {
        return Ok(cancelled_result(&since, library.len()));
    }

    // ---- citations, reusing cache for unchanged seeds ----------------------
    let mut cache = if opts.force {
        CitingScanCache::default()
    } else {
        load_cache(vault)
    };
    let stale: Vec<usize> = seed_indices
        .iter()
        .copied()
        .filter(|i| {
            let p = &library[*i];
            match cache.seeds.get(&p.path) {
                Some(entry) => {
                    Some(entry.citation_count) != p.citation_count
                        || entry.s2_id != p.s2_id.clone().unwrap_or_default()
                }
                None => true,
            }
        })
        .collect();

    let total_fetch = stale.len();
    if total_fetch > 0 {
        hooks.report("citingFetch", Some(0), Some(total_fetch), Some(5));
    }
    let done = AtomicUsize::new(0);
    let fetched: Vec<(usize, Result<Vec<CitingRaw>, AppError>)> =
        stream::iter(stale.iter().copied())
            .map(|idx| {
                let client = client.clone();
                let s2_id = library[idx].s2_id.clone().unwrap_or_default();
                let done = &done;
                async move {
                    if hooks.is_cancelled() {
                        return (idx, Ok(Vec::new()));
                    }
                    let result = s2_citations(&client, &s2_id).await;
                    let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                    // The fetch phase owns 5%..85% of the task.
                    let pct = 5 + (n * 80 / total_fetch.max(1)).min(80);
                    hooks.report("citingFetch", Some(n), Some(total_fetch), Some(pct as u8));
                    (idx, result)
                }
            })
            .buffer_unordered(FETCH_CONCURRENCY)
            .collect()
            .await;

    let cancelled = hooks.is_cancelled();
    let now = crate::core::time::now_rfc3339_millis();
    let mut seeds_fetched = 0usize;
    for (idx, result) in fetched {
        let p = &library[idx];
        match result {
            Ok(citing) => {
                if cancelled {
                    continue;
                }
                seeds_fetched += 1;
                cache.seeds.insert(
                    p.path.clone(),
                    SeedCache {
                        s2_id: p.s2_id.clone().unwrap_or_default(),
                        citation_count: p.citation_count.unwrap_or(0),
                        fetched_at: now.clone(),
                        citing,
                    },
                );
            }
            // A single failed seed must not sink the whole scan.
            Err(e) => messages.push(format!("{}: {e}", p.path)),
        }
    }
    if cancelled {
        return Ok(cancelled_result(&since, library.len()));
    }

    // Drop cache entries for papers that left the library or became seeds no
    // longer eligible, so the file cannot grow forever.
    let live: HashSet<String> = seed_indices
        .iter()
        .map(|i| library[*i].path.clone())
        .collect();
    cache.seeds.retain(|path, _| live.contains(path));

    // ---- L0: aggregate + hard filters -------------------------------------
    hooks.report("citingScore", None, None, Some(88));
    let by_path: HashMap<&str, &LibPaper> = library.iter().map(|p| (p.path.as_str(), p)).collect();
    let mut aggregated: HashMap<String, (CitingRaw, Vec<String>)> = HashMap::new();
    for (path, entry) in &cache.seeds {
        for raw in &entry.citing {
            let slot = aggregated
                .entry(raw.s2_id.clone())
                .or_insert_with(|| (raw.clone(), Vec::new()));
            slot.1.push(path.clone());
        }
    }
    let raw_citing = aggregated.len();

    let mut filtered: Vec<CitingCandidate> = Vec::new();
    for (_, (raw, mut cited_by)) in aggregated {
        if already_in_library(
            raw.arxiv_id.as_ref(),
            raw.doi.as_ref(),
            &lib_arxiv,
            &lib_doi,
        ) {
            continue;
        }
        let Some(identifier) = import_identifier(raw.arxiv_id.as_ref(), raw.doi.as_ref()) else {
            continue;
        };
        let Some(date) = raw.date.clone().filter(|d| d.as_str() >= since.as_str()) else {
            continue;
        };
        cited_by.sort();
        cited_by.dedup();
        // L1: IDF-weighted overlap.
        let weight = cited_by
            .iter()
            .filter_map(|p| by_path.get(p.as_str()))
            .map(|p| idf_weight(p.citation_count.unwrap_or(0)))
            .sum();
        filtered.push(CitingCandidate {
            s2_id: raw.s2_id,
            title: raw.title.unwrap_or_else(|| "(untitled)".to_string()),
            date,
            arxiv_id: raw.arxiv_id,
            doi: raw.doi,
            identifier,
            cited_by_mine: cited_by,
            weight,
            similarity: None,
            citation_count: raw.citation_count,
            oa_pdf_url: raw.oa_pdf_url,
        });
    }
    let after_filters = filtered.len();

    if hooks.is_cancelled() {
        return Ok(cancelled_result(&since, library.len()));
    }

    // ---- L2: SPECTER2 similarity gate -------------------------------------
    let mut cand_vectors: HashMap<String, Vec<f32>> = HashMap::new();
    for chunk in filtered.chunks(BATCH_IDS_MAX) {
        let ids: Vec<String> = chunk.iter().map(|c| c.s2_id.clone()).collect();
        match s2_batch(&client, &ids, "paperId,embedding.specter_v2").await {
            Ok(rows) => {
                for (cand, row) in chunk.iter().zip(rows) {
                    let Some(row) = row else { continue };
                    if let Some(vec) = row
                        .get("embedding")
                        .and_then(|e| e.get("vector"))
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|x| x.as_f64())
                                .map(|x| x as f32)
                                .collect::<Vec<f32>>()
                        })
                        .filter(|v| !v.is_empty())
                    {
                        cand_vectors.insert(cand.s2_id.clone(), vec);
                    }
                }
            }
            Err(e) => messages.push(format!("candidate embeddings: {e}")),
        }
    }

    // Reference set = my own non-classic papers. Classics are generic and
    // would drag the topic model toward "deep learning in general".
    let ref_raw: Vec<Vec<f32>> = library
        .iter()
        .filter(|p| p.citation_count.unwrap_or(0) <= SEED_CITES_MAX)
        .filter_map(|p| p.vector.clone())
        .collect();

    let mut similarity_threshold = None;
    if !ref_raw.is_empty() && !cand_vectors.is_empty() {
        let mut background_input: Vec<Vec<f32>> = ref_raw.iter().map(|v| norm(v)).collect();
        background_input.extend(cand_vectors.values().map(|v| norm(v)));
        let bg = mean_vec(&background_input);
        let refs: Vec<Vec<f32>> = ref_raw.iter().map(|v| center(v, &bg)).collect();
        similarity_threshold = self_similarity_threshold(&refs);
        for cand in &mut filtered {
            if let Some(v) = cand_vectors.get(&cand.s2_id) {
                cand.similarity = max_similarity(&center(v, &bg), &refs);
            }
        }
    } else {
        messages.push("similarity gate skipped: no embeddings available".to_string());
    }

    let mut gated: Vec<CitingCandidate> = match similarity_threshold {
        Some(thr) => filtered
            .into_iter()
            .filter(|c| c.similarity.is_some_and(|s| s >= thr))
            .collect(),
        None => filtered,
    };
    let gate_passed = gated.len();

    // ---- rank + MMR under a fixed budget ----------------------------------
    let w_max = gated
        .iter()
        .map(|c| c.weight)
        .fold(0.0_f32, f32::max)
        .max(f32::EPSILON);
    let s_max = gated
        .iter()
        .filter_map(|c| c.similarity)
        .fold(0.0_f32, f32::max)
        .max(f32::EPSILON);
    let mut scored: Vec<(f32, CitingCandidate)> = gated
        .drain(..)
        .map(|c| {
            let score =
                0.65 * (c.weight / w_max) + 0.35 * (c.similarity.unwrap_or(0.0).max(0.0) / s_max);
            (score, c)
        })
        .collect();
    scored.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.1.date.cmp(&a.1.date))
    });
    scored.truncate(MMR_POOL);

    let scores: Vec<f32> = scored.iter().map(|(s, _)| *s).collect();
    let vectors: Vec<Option<Vec<f32>>> = scored
        .iter()
        .map(|(_, c)| cand_vectors.get(&c.s2_id).map(|v| norm(v)))
        .collect();
    let order = mmr_select(&scores, &vectors, opts.budget.max(1));
    let candidates: Vec<CitingCandidate> = order.into_iter().map(|i| scored[i].1.clone()).collect();

    let result = CitingScanResult {
        generated_at: now,
        since_date: since,
        library_total: library.len(),
        seeds_total: seed_indices.len(),
        seeds_fetched,
        skipped_mega_cited,
        skipped_uncited,
        skipped_unknown,
        raw_citing,
        after_filters,
        gate_passed,
        similarity_threshold,
        candidates,
        cancelled: false,
        messages,
    };

    cache.schema_version = CACHE_SCHEMA_VERSION;
    cache.generated_at = result.generated_at.clone();
    cache.last_result = Some(result.clone());
    if let Err(e) = save_cache(vault, &cache) {
        log::warn!(target: "agentero::refs", "citing scan cache write failed: {e}");
    }
    hooks.report("citingScore", None, None, Some(100));
    Ok(result)
}

fn cancelled_result(since: &str, library_total: usize) -> CitingScanResult {
    CitingScanResult {
        generated_at: crate::core::time::now_rfc3339_millis(),
        since_date: since.to_string(),
        library_total,
        cancelled: true,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idf_weight_discounts_classics() {
        // A 190k-citation classic must carry far less weight than a new paper.
        let classic = idf_weight(189_493);
        let fresh = idf_weight(0);
        assert!(classic < 0.2, "classic weight was {classic}");
        assert!((fresh - 1.0).abs() < 1e-6, "fresh weight was {fresh}");
        assert!(idf_weight(580) > classic);
    }

    #[test]
    fn centering_spreads_out_cosines() {
        let a = vec![1.0, 0.9, 0.1];
        let b = vec![0.95, 1.0, 0.05];
        let c = vec![0.9, 0.95, 0.9];
        let raw = cosine(&norm(&a), &norm(&c));
        let bg = mean_vec(&[norm(&a), norm(&b), norm(&c)]);
        let centered = cosine(&center(&a, &bg), &center(&c, &bg));
        assert!(raw > 0.7, "raw cosines should be compressed high: {raw}");
        assert!(
            centered < raw,
            "centering should spread: {centered} vs {raw}"
        );
    }

    #[test]
    fn threshold_is_self_calibrated_and_needs_two_refs() {
        assert!(self_similarity_threshold(&[vec![1.0, 0.0]]).is_none());
        let refs = vec![
            norm(&[1.0, 0.0, 0.0]),
            norm(&[0.9, 0.1, 0.0]),
            norm(&[0.0, 0.0, 1.0]),
        ];
        let thr = self_similarity_threshold(&refs).expect("threshold");
        // The outlier's nearest neighbour is weak, so p10 lands low.
        assert!(thr < 0.5, "threshold was {thr}");
    }

    #[test]
    fn max_similarity_uses_nearest_single_paper() {
        let refs = vec![norm(&[1.0, 0.0]), norm(&[0.0, 1.0])];
        let v = norm(&[0.95, 0.05]);
        let sim = max_similarity(&v, &refs).expect("sim");
        // Centroid similarity would be ~0.7; max-sim keeps the real match.
        assert!(sim > 0.9, "sim was {sim}");
        assert!(max_similarity(&v, &[]).is_none());
    }

    #[test]
    fn mmr_prefers_a_second_topic_over_a_near_duplicate() {
        let scores = vec![1.0, 0.95, 0.6];
        let vectors = vec![
            Some(norm(&[1.0, 0.0])),
            Some(norm(&[0.99, 0.01])), // near-duplicate of #0
            Some(norm(&[0.0, 1.0])),   // different direction
        ];
        let picked = mmr_select(&scores, &vectors, 2);
        assert_eq!(picked[0], 0);
        assert_eq!(picked[1], 2, "MMR should skip the near-duplicate");
    }

    #[test]
    fn mmr_respects_budget_and_missing_vectors() {
        let scores = vec![0.9, 0.8];
        let vectors = vec![None, None];
        assert_eq!(mmr_select(&scores, &vectors, 5).len(), 2);
        assert_eq!(mmr_select(&scores, &vectors, 1), vec![0]);
    }

    #[test]
    fn already_in_library_matches_both_identifier_routes() {
        let lib_arxiv: HashSet<String> = ["2501.00001".to_string()].into_iter().collect();
        let lib_doi: HashSet<String> = ["10.1109/abc.2026.1".to_string()].into_iter().collect();

        // arXiv id with a version suffix must still match.
        let versioned = normalize_arxiv("2501.00001v3").unwrap();
        assert!(already_in_library(
            Some(&versioned),
            None,
            &lib_arxiv,
            &lib_doi
        ));
        // Candidate carries only an arXiv DOI while the library has the id.
        let arxiv_doi = normalize_doi("https://doi.org/10.48550/arXiv.2501.00001").unwrap();
        assert!(already_in_library(
            None,
            Some(&arxiv_doi),
            &lib_arxiv,
            &lib_doi
        ));
        // Plain DOI route, case-insensitive.
        let doi = normalize_doi("10.1109/ABC.2026.1").unwrap();
        assert!(already_in_library(None, Some(&doi), &lib_arxiv, &lib_doi));

        let other = normalize_arxiv("2602.09999").unwrap();
        assert!(!already_in_library(
            Some(&other),
            None,
            &lib_arxiv,
            &lib_doi
        ));
    }

    #[test]
    fn import_identifier_prefers_arxiv() {
        let arxiv = "2501.00001".to_string();
        let doi = "10.1109/abc".to_string();
        assert_eq!(
            import_identifier(Some(&arxiv), Some(&doi)).as_deref(),
            Some("arXiv:2501.00001")
        );
        assert_eq!(
            import_identifier(None, Some(&doi)).as_deref(),
            Some("10.1109/abc")
        );
        assert!(import_identifier(None, None).is_none());
    }

    #[test]
    fn since_date_is_iso_and_comparable_as_string() {
        let recent = since_date(0);
        let older = since_date(400);
        assert_eq!(recent.len(), 10);
        assert!(older < recent, "{older} should sort before {recent}");
    }

    #[test]
    fn percentile_clamps_to_bounds() {
        let xs = vec![0.1, 0.5, 0.9];
        assert_eq!(percentile(&xs, 0), 0.1);
        assert_eq!(percentile(&xs, 100), 0.9);
    }
}
