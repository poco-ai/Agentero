//! arXiv daily recommendation — rank new arXiv papers against the Vault library.
//!
//! Candidates come from the arXiv category RSS feeds; the corpus is every
//! library paper that has an abstract. Both sides are embedded through the
//! user's OpenAI-compatible endpoint (Settings → Agent → Embedding) and scored
//! by cosine similarity weighted by how recently each corpus paper was added.
//!
//! Vectors and the last run are cached in `catalog.sqlite` (schema v6), so a
//! same-day open reuses the previous result without touching the network.

use crate::core::error::AppError;
use crate::core::http;
use crate::features::catalog::papers;
use crate::features::catalog::with_catalog;
use crate::features::feeds::parse::parse_feed_bytes;
use chrono::Utc;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

/// Categories used when the caller and the stored state have none.
pub const DEFAULT_CATEGORIES: &[&str] = &["cs.AI", "cs.CL", "cs.LG", "cs.CV", "stat.ML"];

/// Recommendations returned to the page when the caller does not ask for more.
pub const DEFAULT_TOP_N: usize = 20;

/// Cap on abstracts embedded per request so one run cannot fan out unbounded.
const MAX_CORPUS: usize = 2_000;
/// Abstracts per `/embeddings` call. Large batches trip provider input limits.
const EMBED_BATCH: usize = 64;
/// Chars of an abstract sent for embedding (providers cap tokens per input).
const MAX_EMBED_CHARS: usize = 4_000;
const FEED_TIMEOUT: Duration = Duration::from_secs(30);
const EMBED_TIMEOUT: Duration = Duration::from_secs(120);
/// Shorter than a real embed because the probe only needs the response shape.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// Marker error the UI turns into "configure an embedding model first".
pub const ERR_NO_EMBEDDING: &str = "recommend.no_embedding";
/// Marker error the UI turns into "embedding endpoint is unreachable".
pub const ERR_PROBE_FAILED: &str = "recommend.probe_failed";

/// Single token sent for a liveness probe — cheap, and any real embedding
/// provider must accept an input of this length.
const PROBE_INPUT: &str = "hi";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendItem {
    pub arxiv_id: String,
    pub title: String,
    #[serde(rename = "abstract")]
    pub abstract_text: String,
    pub url: String,
    pub published_at: Option<String>,
    pub score: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendResult {
    pub items: Vec<RecommendItem>,
    /// RFC3339 timestamp of the run that produced `items`.
    pub computed_at: String,
    pub categories: Vec<String>,
    pub corpus_size: usize,
    /// True when `items` came from the stored same-day run.
    pub reused_cache: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeEmbeddingResult {
    /// Dimensionality reported by the embedding endpoint for the probe input.
    pub dim: usize,
    /// Wall-clock latency of the probe request in milliseconds.
    pub latency_ms: u64,
}

/// Resolve a user-supplied embedding base URL into a full `/embeddings` URL.
///
/// Accepts trailing slashes and bases that already end in `/embeddings`.
/// All other paths get `/embeddings` appended after a single separator.
fn resolve_endpoint(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return String::new();
    }
    if base.ends_with("/embeddings") {
        base.to_string()
    } else {
        format!("{base}/embeddings")
    }
}

/// Read the stored run without recomputing (page open / stale check).
pub fn last_result(vault_root: &Path) -> Result<Option<RecommendResult>, AppError> {
    with_catalog(vault_root, read_state)
}

/// Categories to use when the caller passes none: last run's, else defaults.
fn resolve_categories(conn: &Connection, requested: Option<Vec<String>>) -> Vec<String> {
    if let Some(list) = requested {
        let cleaned = normalize_categories(list);
        if !cleaned.is_empty() {
            return cleaned;
        }
    }
    if let Ok(Some(state)) = read_state(conn) {
        if !state.categories.is_empty() {
            return state.categories;
        }
    }
    DEFAULT_CATEGORIES.iter().map(|c| c.to_string()).collect()
}

/// Trim, drop empties, and de-duplicate while preserving the caller's order.
fn normalize_categories(raw: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for cat in raw {
        let trimmed = cat.trim();
        if trimmed.is_empty() || trimmed.len() > 40 {
            continue;
        }
        if !out.iter().any(|c| c.eq_ignore_ascii_case(trimmed)) {
            out.push(trimmed.to_string());
        }
    }
    out
}

fn read_state(conn: &Connection) -> Result<Option<RecommendResult>, AppError> {
    let row: Option<(String, String, String)> = conn
        .query_row(
            "SELECT computed_at, categories_json, results_json FROM arxiv_rec_state WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(AppError::from)?;
    let Some((computed_at, categories_json, results_json)) = row else {
        return Ok(None);
    };
    let categories: Vec<String> = serde_json::from_str(&categories_json).unwrap_or_default();
    let items: Vec<RecommendItem> = serde_json::from_str(&results_json).unwrap_or_default();
    Ok(Some(RecommendResult {
        items,
        computed_at,
        categories,
        corpus_size: 0,
        reused_cache: true,
    }))
}

fn write_state(conn: &Connection, result: &RecommendResult) -> Result<(), AppError> {
    let categories_json = serde_json::to_string(&result.categories)?;
    let results_json = serde_json::to_string(&result.items)?;
    conn.execute(
        "INSERT INTO arxiv_rec_state(id, computed_at, categories_json, results_json)
         VALUES(1, ?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET
            computed_at = excluded.computed_at,
            categories_json = excluded.categories_json,
            results_json = excluded.results_json",
        rusqlite::params![result.computed_at, categories_json, results_json],
    )
    .map_err(AppError::from)?;
    Ok(())
}

/// True when `computed_at` falls on today's UTC date and covers `categories`.
fn is_fresh(state: &RecommendResult, categories: &[String]) -> bool {
    if state.items.is_empty() {
        return false;
    }
    if state.categories.len() != categories.len() {
        return false;
    }
    let same = state
        .categories
        .iter()
        .zip(categories.iter())
        .all(|(a, b)| a.eq_ignore_ascii_case(b));
    if !same {
        return false;
    }
    let today = Utc::now().format("%Y-%m-%d").to_string();
    state.computed_at.starts_with(&today)
}

/// One arXiv candidate before scoring.
struct Candidate {
    arxiv_id: String,
    title: String,
    abstract_text: String,
    url: String,
    published_at: Option<String>,
}

/// Fetch each category RSS and collect de-duplicated candidates with abstracts.
async fn fetch_candidates(categories: &[String]) -> Result<Vec<Candidate>, AppError> {
    let client = http::client_builder()
        .timeout(FEED_TIMEOUT)
        .build()
        .map_err(|e| AppError::message(format!("recommend http client: {e}")))?;
    let mut out: Vec<Candidate> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let mut last_error: Option<AppError> = None;

    for category in categories {
        let url = format!("https://rss.arxiv.org/rss/{category}");
        let parsed = match fetch_feed(&client, &url, category).await {
            Ok(feed) => feed,
            Err(e) => {
                log::warn!(target: "agentero::recommend", "feed {category} failed: {e}");
                last_error = Some(e);
                continue;
            }
        };
        for item in parsed {
            let abstract_text = item.summary_text.trim().to_string();
            let title = item.title.trim().to_string();
            if abstract_text.is_empty() || title.is_empty() {
                continue;
            }
            // `paper_url` is already normalized to https://arxiv.org/abs/<id>.
            let Some(paper_url) = item.paper_url.clone() else {
                continue;
            };
            let arxiv_id = paper_url.rsplit('/').next().unwrap_or_default().to_string();
            if arxiv_id.is_empty() || seen.iter().any(|s| s == &arxiv_id) {
                continue;
            }
            seen.push(arxiv_id.clone());
            out.push(Candidate {
                arxiv_id,
                title,
                abstract_text,
                url: paper_url,
                published_at: item.published_at.clone(),
            });
        }
    }

    if out.is_empty() {
        if let Some(e) = last_error {
            return Err(e);
        }
    }
    Ok(out)
}

async fn fetch_feed(
    client: &reqwest::Client,
    url: &str,
    fallback_title: &str,
) -> Result<Vec<crate::features::feeds::parse::ParsedItem>, AppError> {
    let resp = client
        .get(url)
        .header("User-Agent", "Agentero/1.0 (+https://github.com/Phil-Fan)")
        .send()
        .await
        .map_err(|e| AppError::message(format!("recommend feed fetch: {e}")))?;
    let status = resp.status();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| AppError::message(format!("recommend feed body: {e}")))?;
    if !status.is_success() {
        return Err(AppError::message(format!(
            "recommend feed {url} returned {status}"
        )));
    }
    Ok(parse_feed_bytes(&bytes, fallback_title)?.items)
}

fn embed_text(title: &str, abstract_text: &str) -> String {
    let joined = format!("{}\n\n{}", title.trim(), abstract_text.trim());
    joined.chars().take(MAX_EMBED_CHARS).collect()
}

fn text_hash(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn vector_to_blob(vector: &[f32]) -> Vec<u8> {
    vector.iter().flat_map(|v| v.to_le_bytes()).collect()
}

fn blob_to_vector(blob: &[u8]) -> Vec<f32> {
    blob.as_chunks::<4>()
        .0
        .iter()
        .map(|c| f32::from_le_bytes(*c))
        .collect()
}

/// Look up cached vectors for `hashes`, keyed by hash.
fn read_cached_vectors(
    conn: &Connection,
    model: &str,
    hashes: &[String],
) -> Result<HashMap<String, Vec<f32>>, AppError> {
    let mut out = HashMap::new();
    let mut stmt = conn
        .prepare("SELECT vector FROM embed_cache WHERE text_hash = ?1 AND model = ?2")
        .map_err(AppError::from)?;
    for hash in hashes {
        let blob: Option<Vec<u8>> = stmt
            .query_row(rusqlite::params![hash, model], |r| r.get(0))
            .optional()
            .map_err(AppError::from)?;
        if let Some(blob) = blob {
            let vector = blob_to_vector(&blob);
            if !vector.is_empty() {
                out.insert(hash.clone(), vector);
            }
        }
    }
    Ok(out)
}

fn write_cached_vectors(
    conn: &Connection,
    model: &str,
    entries: &[(String, Vec<f32>)],
) -> Result<(), AppError> {
    let mut stmt = conn
        .prepare(
            "INSERT INTO embed_cache(text_hash, model, dim, vector) VALUES(?1, ?2, ?3, ?4)
             ON CONFLICT(text_hash, model) DO UPDATE SET
                dim = excluded.dim, vector = excluded.vector",
        )
        .map_err(AppError::from)?;
    for (hash, vector) in entries {
        stmt.execute(rusqlite::params![
            hash,
            model,
            vector.len() as i64,
            vector_to_blob(vector)
        ])
        .map_err(AppError::from)?;
    }
    Ok(())
}

#[derive(Serialize)]
struct EmbedRequest<'a> {
    model: &'a str,
    input: &'a [String],
}

/// POST one batch of texts to `{base}/embeddings` and return their vectors.
async fn embed_batch(
    client: &reqwest::Client,
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, AppError> {
    let mut request = client.post(endpoint).json(&EmbedRequest {
        model,
        input: texts,
    });
    if let Some(key) = api_key {
        request = request.header("Authorization", format!("Bearer {key}"));
    }
    let resp = request
        .send()
        .await
        .map_err(|e| AppError::message(format!("embeddings request failed: {e}")))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| AppError::message(format!("embeddings read body: {e}")))?;
    if !status.is_success() {
        let snippet = http::http_err_snippet(&body);
        return Err(AppError::message(format!(
            "embeddings endpoint returned {status}: {snippet}"
        )));
    }
    let value: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| AppError::message(format!("embeddings parse: {e}")))?;
    let data = value
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or_else(|| AppError::message("embeddings response has no data array"))?;
    let mut out = Vec::with_capacity(data.len());
    for entry in data {
        let vector: Vec<f32> = entry
            .get("embedding")
            .and_then(|e| e.as_array())
            .ok_or_else(|| AppError::message("embeddings entry has no embedding"))?
            .iter()
            .filter_map(|v| v.as_f64())
            .map(|v| v as f32)
            .collect();
        if vector.is_empty() {
            return Err(AppError::message("embeddings entry is empty"));
        }
        out.push(vector);
    }
    if out.len() != texts.len() {
        return Err(AppError::message(format!(
            "embeddings returned {} vectors for {} inputs",
            out.len(),
            texts.len()
        )));
    }
    Ok(out)
}

/// Liveness probe: POST one tiny input, confirm the endpoint actually serves
/// `/embeddings`, and report the returned dimensionality + latency.
///
/// Returns `AppError::message(ERR_PROBE_FAILED)` for any failure so the UI
/// can switch the arxiv daily panel into its "unreachable" state.
pub async fn probe_embedding_endpoint(
    base_url: &str,
    api_key: Option<&str>,
    model: &str,
) -> Result<ProbeEmbeddingResult, AppError> {
    let endpoint = resolve_endpoint(base_url);
    if endpoint.is_empty() {
        return Err(AppError::message(format!(
            "{ERR_PROBE_FAILED}: empty base URL"
        )));
    }
    let client = http::client_builder()
        .timeout(PROBE_TIMEOUT)
        .build()
        .map_err(|e| AppError::message(format!("{ERR_PROBE_FAILED}: {e}")))?;
    let inputs = [PROBE_INPUT.to_string()];
    let mut request = client.post(&endpoint).json(&EmbedRequest {
        model,
        input: &inputs,
    });
    if let Some(key) = api_key {
        request = request.header("Authorization", format!("Bearer {key}"));
    }
    let started = std::time::Instant::now();
    let resp = request
        .send()
        .await
        .map_err(|e| AppError::message(format!("{ERR_PROBE_FAILED}: {e}")))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| AppError::message(format!("{ERR_PROBE_FAILED}: {e}")))?;
    if !status.is_success() {
        let snippet = http::http_err_snippet(&body);
        return Err(AppError::message(format!(
            "{ERR_PROBE_FAILED}: HTTP {status} — {snippet}"
        )));
    }
    let value: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| AppError::message(format!("{ERR_PROBE_FAILED}: parse {e}")))?;
    let vector: Vec<f64> = value
        .get("data")
        .and_then(|d| d.as_array())
        .and_then(|arr| arr.first())
        .and_then(|entry| entry.get("embedding"))
        .and_then(|e| e.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_f64()).collect())
        .unwrap_or_default();
    if vector.is_empty() {
        return Err(AppError::message(format!(
            "{ERR_PROBE_FAILED}: response has no embedding"
        )));
    }
    Ok(ProbeEmbeddingResult {
        dim: vector.len(),
        latency_ms: started.elapsed().as_millis() as u64,
    })
}

/// Embed every text, serving hits from `embed_cache` and caching new vectors.
async fn embed_all(
    vault_root: &Path,
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, AppError> {
    let hashes: Vec<String> = texts.iter().map(|t| text_hash(t)).collect();
    let cached = {
        let vault = vault_root.to_path_buf();
        let model = model.to_string();
        let hashes = hashes.clone();
        with_catalog(&vault, |conn| read_cached_vectors(conn, &model, &hashes))?
    };

    // Unique misses only: the same abstract can appear twice in one request.
    let mut missing: Vec<(String, String)> = Vec::new();
    for (hash, text) in hashes.iter().zip(texts.iter()) {
        if cached.contains_key(hash) || missing.iter().any(|(h, _)| h == hash) {
            continue;
        }
        missing.push((hash.clone(), text.clone()));
    }

    let client = http::client_builder()
        .timeout(EMBED_TIMEOUT)
        .build()
        .map_err(|e| AppError::message(format!("recommend http client: {e}")))?;
    let mut fresh: Vec<(String, Vec<f32>)> = Vec::new();
    for chunk in missing.chunks(EMBED_BATCH) {
        let inputs: Vec<String> = chunk.iter().map(|(_, t)| t.clone()).collect();
        let vectors = embed_batch(&client, endpoint, api_key, model, &inputs).await?;
        for ((hash, _), vector) in chunk.iter().zip(vectors) {
            fresh.push((hash.clone(), vector));
        }
    }

    if !fresh.is_empty() {
        let vault = vault_root.to_path_buf();
        let model = model.to_string();
        let entries = fresh.clone();
        with_catalog(&vault, |conn| write_cached_vectors(conn, &model, &entries))?;
    }

    let mut by_hash = cached;
    for (hash, vector) in fresh {
        by_hash.insert(hash, vector);
    }
    hashes
        .iter()
        .map(|hash| {
            by_hash
                .get(hash)
                .cloned()
                .ok_or_else(|| AppError::message("embedding missing after fetch"))
        })
        .collect()
}

fn normalize(vector: &mut [f32]) {
    let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm > 0.0 {
        for v in vector.iter_mut() {
            *v /= norm;
        }
    }
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

/// Weights for corpus papers ordered newest-first: `1/(1+log10(rank+1))`,
/// normalized to sum to 1 so recently added papers dominate the score.
fn time_decay_weights(len: usize) -> Vec<f32> {
    let raw: Vec<f32> = (0..len)
        .map(|i| 1.0 / (1.0 + ((i + 1) as f32).log10()))
        .collect();
    let total: f32 = raw.iter().sum();
    if total <= 0.0 {
        return vec![0.0; len];
    }
    raw.into_iter().map(|w| w / total).collect()
}

/// Recompute recommendations, or return the stored run when it is still fresh.
///
/// `settings` is the resolved embedding endpoint `(base_url, api_key, model)`;
/// callers read it from `AppSettingsStore` before awaiting.
pub async fn recommend(
    vault_root: &Path,
    requested_categories: Option<Vec<String>>,
    top_n: Option<usize>,
    force: bool,
    embedding: Option<(String, Option<String>, String)>,
) -> Result<RecommendResult, AppError> {
    let categories = {
        let vault = vault_root.to_path_buf();
        with_catalog(&vault, |conn| {
            Ok(resolve_categories(conn, requested_categories))
        })?
    };
    let top_n = top_n.unwrap_or(DEFAULT_TOP_N).clamp(1, 100);

    if !force {
        let stored = {
            let vault = vault_root.to_path_buf();
            with_catalog(&vault, read_state)?
        };
        if let Some(state) = stored {
            if is_fresh(&state, &categories) {
                return Ok(state);
            }
        }
    }

    let Some((base_url, api_key, model)) = embedding else {
        return Err(AppError::message(ERR_NO_EMBEDDING));
    };
    let endpoint = resolve_endpoint(&base_url);
    if endpoint.is_empty() {
        return Err(AppError::message(ERR_NO_EMBEDDING));
    }

    // Corpus: library papers with an abstract, newest-added first.
    let corpus_texts = {
        let vault = vault_root.to_path_buf();
        let mut rows = papers::list_all_unique_by_id(&vault)?
            .into_iter()
            .filter_map(|row| {
                let abstract_text = row.abstract_text.unwrap_or_default();
                if abstract_text.trim().is_empty() {
                    return None;
                }
                Some((row.added_at, embed_text(&row.title, &abstract_text)))
            })
            .collect::<Vec<_>>();
        rows.sort_by(|a, b| b.0.cmp(&a.0));
        rows.truncate(MAX_CORPUS);
        rows.into_iter().map(|(_, text)| text).collect::<Vec<_>>()
    };
    if corpus_texts.is_empty() {
        return Err(AppError::message("recommend.empty_corpus"));
    }

    let candidates = fetch_candidates(&categories).await?;
    if candidates.is_empty() {
        return Err(AppError::message("recommend.no_candidates"));
    }

    let candidate_texts: Vec<String> = candidates
        .iter()
        .map(|c| embed_text(&c.title, &c.abstract_text))
        .collect();

    let mut corpus_vectors = embed_all(
        vault_root,
        &endpoint,
        api_key.as_deref(),
        &model,
        &corpus_texts,
    )
    .await?;
    let mut candidate_vectors = embed_all(
        vault_root,
        &endpoint,
        api_key.as_deref(),
        &model,
        &candidate_texts,
    )
    .await?;
    for v in corpus_vectors.iter_mut() {
        normalize(v);
    }
    for v in candidate_vectors.iter_mut() {
        normalize(v);
    }

    let weights = time_decay_weights(corpus_vectors.len());
    let mut scored: Vec<RecommendItem> = candidates
        .into_iter()
        .zip(candidate_vectors.iter())
        .map(|(candidate, cv)| {
            let score = corpus_vectors
                .iter()
                .zip(weights.iter())
                .map(|(corpus_vector, weight)| {
                    // Mismatched dims mean two different models wrote the cache.
                    if corpus_vector.len() == cv.len() {
                        dot(corpus_vector, cv) * weight
                    } else {
                        0.0
                    }
                })
                .sum::<f32>();
            RecommendItem {
                arxiv_id: candidate.arxiv_id,
                title: candidate.title,
                abstract_text: candidate.abstract_text,
                url: candidate.url,
                published_at: candidate.published_at,
                score,
            }
        })
        .collect();
    scored.sort_by(|a, b| b.score.total_cmp(&a.score));
    scored.truncate(top_n);

    let result = RecommendResult {
        items: scored,
        computed_at: crate::core::time::now_rfc3339_millis(),
        categories,
        corpus_size: corpus_vectors.len(),
        reused_cache: false,
    };
    {
        let vault = vault_root.to_path_buf();
        let to_store = result.clone();
        with_catalog(&vault, |conn| write_state(conn, &to_store))?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weights_favor_recent_and_sum_to_one() {
        let w = time_decay_weights(4);
        assert_eq!(w.len(), 4);
        assert!((w.iter().sum::<f32>() - 1.0).abs() < 1e-5);
        // Newest-first ordering means each weight is smaller than the previous.
        for pair in w.windows(2) {
            assert!(pair[0] > pair[1], "weights must decay: {w:?}");
        }
    }

    #[test]
    fn vector_blob_roundtrip() {
        let vector = vec![0.5_f32, -1.25, 0.0, 3.75];
        assert_eq!(blob_to_vector(&vector_to_blob(&vector)), vector);
    }

    #[test]
    fn normalize_makes_unit_length() {
        let mut v = vec![3.0_f32, 4.0];
        normalize(&mut v);
        assert!((dot(&v, &v) - 1.0).abs() < 1e-5);
    }

    #[test]
    fn categories_dedupe_and_trim() {
        let out = normalize_categories(vec![
            " cs.AI ".into(),
            "cs.ai".into(),
            String::new(),
            "cs.LG".into(),
        ]);
        assert_eq!(out, vec!["cs.AI".to_string(), "cs.LG".to_string()]);
    }

    #[test]
    fn resolve_endpoint_appends_embeddings_path() {
        assert_eq!(
            resolve_endpoint("https://api.openai.com/v1"),
            "https://api.openai.com/v1/embeddings"
        );
        assert_eq!(
            resolve_endpoint("https://api.openai.com/v1/"),
            "https://api.openai.com/v1/embeddings"
        );
        assert_eq!(
            resolve_endpoint("https://api.openai.com/v1/embeddings"),
            "https://api.openai.com/v1/embeddings"
        );
        assert_eq!(
            resolve_endpoint("https://api.openai.com/v1/embeddings/"),
            "https://api.openai.com/v1/embeddings"
        );
        assert_eq!(
            resolve_endpoint("  https://api.openai.com/v1/  "),
            "https://api.openai.com/v1/embeddings"
        );
        assert_eq!(resolve_endpoint(""), "");
    }

    #[test]
    fn freshness_requires_same_day_and_categories() {
        let cats = vec!["cs.AI".to_string()];
        let today = RecommendResult {
            items: vec![RecommendItem {
                arxiv_id: "1".into(),
                title: "t".into(),
                abstract_text: "a".into(),
                url: "u".into(),
                published_at: None,
                score: 1.0,
            }],
            computed_at: crate::core::time::now_rfc3339_millis(),
            categories: cats.clone(),
            corpus_size: 1,
            reused_cache: true,
        };
        assert!(is_fresh(&today, &cats));
        // Different category set → recompute.
        assert!(!is_fresh(&today, &["cs.LG".to_string()]));
        // Stale date → recompute.
        let stale = RecommendResult {
            computed_at: "2020-01-01T00:00:00Z".into(),
            ..today.clone()
        };
        assert!(!is_fresh(&stale, &cats));
        // No items → recompute even when the date matches.
        let empty = RecommendResult {
            items: Vec::new(),
            ..today
        };
        assert!(!is_fresh(&empty, &cats));
    }
}

/// Tauri command shells for this feature.
pub mod commands;
