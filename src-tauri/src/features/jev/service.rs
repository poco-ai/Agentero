//! jEV smart-highlight service.
//!
//! Domain logic (sentence extraction, question building, geometry) stays here;
//! every HTTP call routes through the shared [`SystemOneProvider`] so credentials and
//! error handling have a single owner.

use crate::core::decision::SystemOneProvider;
use crate::core::error::AppError;
use crate::features::pdf::locate::{extract_text_in_pdf, NormRect};
use futures_util::stream::{self, StreamExt};
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// Cloudflare Clef rejects a `questions` object with more than 64 entries.
const MAX_QUESTIONS_PER_REQUEST: usize = 64;
const MIN_SENTENCE_LEN: usize = 40;
const MAX_SENTENCE_LEN: usize = 250;
const SCORE_THRESHOLD: f64 = 2.0;

pub(crate) fn read_title_from_sidecar(paper_dir: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(paper_dir.join("metadata.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    json.get("title")?
        .as_str()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SuggestedHighlight {
    pub quote: String,
    pub page: u32,
    pub rects: Vec<crate::features::pdf::locate::NormRect>,
    pub color: String,
    pub category: String,
    pub score: f64,
    pub page_width: f32,
    pub page_height: f32,
}

#[derive(Debug, Clone)]
struct Sentence {
    id: String,
    text: String,
    page: u32,
    rects: Vec<NormRect>,
    page_width: f32,
    page_height: f32,
}

#[derive(Debug, Clone)]
struct HighlightDecision {
    key: &'static str,
    color: &'static str,
    name: &'static str,
    score: f64,
}

const DIMS: [(&str, &str, &str); 5] = [
    ("method", "blue", "核心方法"),
    ("claim", "purple", "关键判断"),
    ("novelty", "green", "反常识结论"),
    ("effect", "yellow", "核心效果"),
    ("limitation", "pink", "局限"),
];

const COLOR_PRIORITY: [&str; 5] = ["method", "novelty", "effect", "claim", "limitation"];

/// How a smart-highlight pass may load the decision endpoint.
#[derive(Debug, Clone, Copy)]
pub struct SmartHighlightLimits {
    /// Batches allowed in flight. Waiting batches are not polled, so their
    /// HTTP timeout has not started.
    pub concurrency: usize,
    /// Deadline for one batch, measured from when its request is sent.
    pub request_timeout: Duration,
}

impl Default for SmartHighlightLimits {
    fn default() -> Self {
        Self {
            concurrency: 16,
            request_timeout: Duration::from_secs(120),
        }
    }
}

/// Sentences that fit in one request. Each sentence asks one score question
/// per dimension, and the request must stay at or under
/// [`MAX_QUESTIONS_PER_REQUEST`].
fn sentences_per_request() -> usize {
    (MAX_QUESTIONS_PER_REQUEST / DIMS.len()).max(1)
}

/// Best-effort sentence extraction from a paper's PDF, including each
/// sentence's on-page geometry so a second locate pass is unnecessary.
fn extract_paper_sentences(pdf_path: &Path) -> Vec<Sentence> {
    let Ok(bytes) = std::fs::read(pdf_path) else {
        return Vec::new();
    };
    let Ok(extracted) = extract_text_in_pdf(&bytes) else {
        return Vec::new();
    };

    extracted
        .into_iter()
        .filter_map(clean_sentence)
        .enumerate()
        .map(
            |(idx, (text, page, rects, page_width, page_height))| Sentence {
                id: format!("s{idx}"),
                text,
                page,
                rects,
                page_width,
                page_height,
            },
        )
        .collect()
}

fn clean_sentence(
    s: crate::features::pdf::locate::ExtractedSentence,
) -> Option<(String, u32, Vec<NormRect>, f32, f32)> {
    let trimmed = s.text.trim();
    // Drop obvious Markdown/list/header noise.
    if trimmed.starts_with('#') || trimmed.starts_with("-") || trimmed.starts_with("*") {
        return None;
    }
    // Normalize internal whitespace for scoring while keeping the original
    // geometry for rendering.
    let cleaned = trimmed
        .replace('\n', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if cleaned.len() < MIN_SENTENCE_LEN || cleaned.len() > MAX_SENTENCE_LEN {
        return None;
    }
    Some((cleaned, s.page, s.rects, s.page_width, s.page_height))
}

fn build_questions(sentences: &[Sentence]) -> HashMap<String, Value> {
    let mut questions = HashMap::new();
    for s in sentences {
        for (key, _, _) in DIMS {
            let qid = format!("{}_{}_score", s.id, key);
            let (instructions, criteria) = match key {
                "method" => (
                    format!("Does `sentences['{}']` describe a key method, algorithm, or technical contribution of the paper?", s.id),
                    vec!["Not a method / only background", "Mentions a method but not central", "Key method or algorithm", "Novel core method that defines the paper"],
                ),
                "claim" => (
                    format!("Does `sentences['{}']` contain a key claim, judgment, or central argument of the paper?", s.id),
                    vec!["No claim / purely factual background", "Minor claim", "Key claim or judgment", "Central thesis of the paper"],
                ),
                "novelty" => (
                    format!("Does `sentences['{}']` state a conclusion or finding that differs from common practice or prior work?", s.id),
                    vec!["Aligns with common knowledge", "Slight twist", "Notably different from prior assumptions", "Directly contradicts or overturns conventional wisdom"],
                ),
                "effect" => (
                    format!("Does `sentences['{}']` present a core experimental result, effect, or main finding?", s.id),
                    vec!["No result / background", "Secondary result", "Important result or effect", "Main result that demonstrates the paper's value"],
                ),
                _ => (
                    format!("Does `sentences['{}']` discuss limitations, caveats, failure cases, or future work?", s.id),
                    vec!["No limitation mentioned", "Minor caveat", "Important limitation", "Critical limitation that affects interpretation"],
                ),
            };
            questions.insert(
                qid,
                serde_json::json!({
                    "type": "score",
                    "instructions": instructions,
                    "criteria": criteria,
                }),
            );
        }
    }
    questions
}

fn decide_highlight(scores: &HashMap<String, f64>) -> Option<HighlightDecision> {
    let mut candidates = Vec::new();
    for (key, color, name) in DIMS {
        if let Some(&score) = scores.get(key) {
            if score >= SCORE_THRESHOLD {
                candidates.push(HighlightDecision {
                    key,
                    color,
                    name,
                    score,
                });
            }
        }
    }
    if candidates.is_empty() {
        return None;
    }
    let priority_index: std::collections::HashMap<&str, usize> = COLOR_PRIORITY
        .iter()
        .enumerate()
        .map(|(i, k)| (*k, i))
        .collect();
    candidates.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| priority_index[a.key].cmp(&priority_index[b.key]))
    });
    Some(candidates[0].clone())
}

/// Lightweight health probe: send one tiny `score` question to verify key/endpoint.
pub async fn jev_probe_health(provider: &SystemOneProvider) -> Result<(), AppError> {
    let request = serde_json::json!({
        "state": { "paper_title": "probe" },
        "questions": {
            "health_score": {
                "type": "score",
                "instructions": "Sanity check: does the state contain a paper_title?",
                "criteria": ["No", "Maybe", "Yes"],
            }
        }
    });
    provider.complete(request).await.map(|_| ())
}

async fn jev_suggest_highlights_impl<F: FnMut(usize, usize) + Send>(
    provider: Arc<SystemOneProvider>,
    pdf_path: &Path,
    title: &str,
    limits: SmartHighlightLimits,
    cancel_token: &CancellationToken,
    on_progress: F,
) -> Result<Vec<SuggestedHighlight>, AppError> {
    let sentences = extract_paper_sentences(pdf_path);
    if sentences.is_empty() {
        return Err(AppError::message("jevNoReadableText"));
    }

    let batch_size = sentences_per_request();
    let total_batches = sentences.chunks(batch_size).len();
    let on_progress = std::sync::Arc::new(std::sync::Mutex::new(on_progress));
    let completed_batches = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let concurrency = limits.concurrency.max(1);

    // Phase 1: score sentences in batches that stay under the question cap.
    // `buffer_unordered` polls only `concurrency` futures, so a batch waiting
    // for a slot has not called `send` and is not on the request timeout.
    let batches: Vec<(usize, Vec<Sentence>)> = sentences
        .chunks(batch_size)
        .enumerate()
        .map(|(idx, chunk)| (idx, chunk.to_vec()))
        .collect();

    let scored_batches: Vec<(usize, Vec<(Sentence, HighlightDecision)>)> = stream::iter(batches)
        .map(|(batch_index, chunk)| {
            let title = title.to_string();
            let on_progress = on_progress.clone();
            let completed_batches = completed_batches.clone();
            let provider = provider.clone();
            async move {
                if cancel_token.is_cancelled() {
                    return Err(AppError::message("jEV smart highlight cancelled"));
                }

                let state_items: HashMap<String, String> = chunk
                    .iter()
                    .map(|s| (s.id.clone(), s.text.clone()))
                    .collect();
                let questions = build_questions(&chunk);
                let request = serde_json::json!({
                    "state": {
                        "paper_title": title,
                        "sentences": state_items,
                    },
                    "questions": questions,
                });

                let resp = provider
                    .complete_with_timeout(request, Some(limits.request_timeout))
                    .await?;
                let answers = resp
                    .get("answers")
                    .and_then(|a| a.as_object())
                    .cloned()
                    .unwrap_or_default();

                let mut decisions = Vec::new();
                for s in chunk {
                    let mut scores = HashMap::new();
                    for (key, _, _) in DIMS {
                        let qid = format!("{}_{}_score", s.id, key);
                        let score = answers
                            .get(&qid)
                            .and_then(|a| a.get("score"))
                            .and_then(|v| v.as_f64())
                            .unwrap_or(0.0);
                        scores.insert(key.to_string(), score);
                    }

                    if let Some(decision) = decide_highlight(&scores) {
                        decisions.push((s, decision));
                    }
                }

                let done = completed_batches.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                if let Ok(mut cb) = on_progress.lock() {
                    cb(done, total_batches);
                }

                Ok::<_, AppError>((batch_index, decisions))
            }
        })
        .buffer_unordered(concurrency)
        .try_collect()
        .await?;

    // Sort by batch index so output order is deterministic.
    let mut scored_batches = scored_batches;
    scored_batches.sort_by_key(|(idx, _)| *idx);

    let scored_sentences: Vec<(Sentence, HighlightDecision)> = scored_batches
        .into_iter()
        .flat_map(|(_, decisions)| decisions)
        .collect();

    // Phase 2: build highlights from the pre-computed sentence geometry.
    // No second PDF locate pass is needed because extract_text_in_pdf already
    // returned each sentence's on-page rects.
    let mut all_highlights: Vec<SuggestedHighlight> = Vec::new();
    for (sentence, decision) in &scored_sentences {
        if cancel_token.is_cancelled() {
            return Err(AppError::message("jEV smart highlight cancelled"));
        }

        if sentence.rects.is_empty() {
            continue;
        }

        all_highlights.push(SuggestedHighlight {
            quote: sentence.text.clone(),
            page: sentence.page,
            rects: sentence.rects.clone(),
            color: decision.color.to_string(),
            category: decision.name.to_string(),
            score: decision.score,
            page_width: sentence.page_width,
            page_height: sentence.page_height,
        });
    }

    // Deduplicate by quote to avoid overlapping identical suggestions
    let mut seen = std::collections::HashSet::new();
    all_highlights.retain(|h| seen.insert(h.quote.clone()));

    Ok(all_highlights)
}

/// Extract highlights for one paper by calling jEV, with cancellation and per-batch progress.
pub async fn jev_suggest_highlights_with_progress<F: FnMut(usize, usize) + Send>(
    provider: &Arc<SystemOneProvider>,
    pdf_path: &Path,
    title: &str,
    limits: SmartHighlightLimits,
    cancel_token: &CancellationToken,
    on_progress: F,
) -> Result<Vec<SuggestedHighlight>, AppError> {
    jev_suggest_highlights_impl(
        provider.clone(),
        pdf_path,
        title,
        limits,
        cancel_token,
        on_progress,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sentence(id: &str) -> Sentence {
        Sentence {
            id: id.to_string(),
            text: "x".repeat(MIN_SENTENCE_LEN),
            page: 1,
            rects: Vec::new(),
            page_width: 1.0,
            page_height: 1.0,
        }
    }

    #[test]
    fn each_highlight_batch_stays_within_the_question_cap() {
        let size = sentences_per_request();
        let sentences: Vec<Sentence> = (0..size).map(|i| sentence(&format!("s{i}"))).collect();
        let questions = build_questions(&sentences);
        assert_eq!(questions.len(), size * DIMS.len());
        assert!(questions.len() <= MAX_QUESTIONS_PER_REQUEST);
        assert!((size + 1) * DIMS.len() > MAX_QUESTIONS_PER_REQUEST);
    }
}
