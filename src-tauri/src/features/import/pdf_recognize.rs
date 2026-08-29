//! PDF metadata recognition: local probe (liteparse word boxes) → Zotero
//! recognizer service → identifier resolution (Translator / Crossref / arXiv).
//!
//! The recognizer request shape mirrors Zotero's
//! `PDFWorker.getRecognizerData` JSON: the first pages' word geometry, not the
//! PDF bytes themselves. Recognition results are treated as leads: a DOI /
//! arXiv id is re-resolved through the authoritative metadata chain, and only
//! when no identifier is found do we fall back to the recognizer's own
//! title/authors extraction.
//!
//! @see docs/backend/paper-import.md § PDF 元数据识别

use crate::core::error::AppError;
use crate::features::import::pdf_parse::{run_liteparse_probe, ProbePage, ProbeWord};
use crate::features::import::resolver::fetch_arxiv_metadata;
use crate::features::import::{map, resolve_metadata, PaperMeta};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

/// Zotero's hosted recognizer endpoint. Undocumented and unsuitable as a
/// hard dependency: every failure here degrades silently to filename-based
/// metadata.
pub(crate) const ZOTERO_RECOGNIZER_ENDPOINT: &str =
    "https://services.zotero.org/recognizer/recognize";

const RECOGNIZE_TIMEOUT: Duration = Duration::from_secs(30);

/// Subset of the recognizer response we consume. Missing fields stay `None`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecognizeHit {
    #[serde(rename = "type", default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub doi: Option<String>,
    #[serde(default)]
    pub arxiv: Option<String>,
    #[serde(default)]
    pub isbn: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub authors: Vec<RecognizeAuthor>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub year: Option<String>,
    #[serde(default)]
    pub container: Option<String>,
    #[serde(default)]
    pub publisher: Option<String>,
    #[serde(default)]
    pub volume: Option<String>,
    #[serde(default)]
    pub issue: Option<String>,
    #[serde(default)]
    pub pages: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecognizeAuthor {
    #[serde(default)]
    pub first_name: Option<String>,
    #[serde(default)]
    pub last_name: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

impl RecognizeHit {
    fn has_identifier(&self) -> bool {
        self.doi.as_deref().is_some_and(nonempty)
            || self.arxiv.as_deref().is_some_and(nonempty)
            || self.isbn.as_deref().is_some_and(nonempty)
    }

    fn author_names(&self) -> Vec<String> {
        self.authors
            .iter()
            .map(|a| {
                if let Some(name) = a.name.as_deref().filter(|s| !s.trim().is_empty()) {
                    return name.trim().to_string();
                }
                let first = a.first_name.as_deref().unwrap_or("").trim();
                let last = a.last_name.as_deref().unwrap_or("").trim();
                format!("{first} {last}").trim().to_string()
            })
            .filter(|s| !s.is_empty())
            .collect()
    }
}

fn nonempty(s: &str) -> bool {
    !s.trim().is_empty()
}

/// Build the recognizer request payload from probe pages.
///
/// Layout (document-worker `getRecognizerData`):
/// `pages[i] = [width, height, [[[[0,0,0,0, lines]]]]]`,
/// `lines[k] = [word, …]` (each element is one line),
/// `word = [xMin, yMin, xMax, yMax, fontSize, spaceAfter, baseline,
///          rotation, underlined, bold, italic, colorIndex, fontIndex, text]`
/// with y in PDF bottom-left coords (liteparse viewport y flipped).
pub(crate) fn build_recognizer_payload(pages: &[ProbePage], file_name: &str) -> Value {
    let pages_json: Vec<Value> = pages
        .iter()
        .map(|page| {
            // Per-page font index table, first-seen order (Zotero's worker).
            let mut fonts: Vec<String> = Vec::new();
            let lines_json: Vec<Value> = page
                .lines
                .iter()
                .map(|line| {
                    let words: Vec<Value> = line
                        .words
                        .iter()
                        .enumerate()
                        .map(|(i, word)| {
                            let (y_min, y_max, baseline) = flip_y(page.height, word);
                            // The server joins words with a space when
                            // spaceAfter=1; derive it from the gap to the
                            // next word in the line.
                            let space_after = line
                                .words
                                .get(i + 1)
                                .map(|next| {
                                    if next.x_min > word.x_max
                                        && next.x_min - word.x_max > word.font_size * 0.2
                                    {
                                        1
                                    } else {
                                        0
                                    }
                                })
                                .unwrap_or(1);
                            let font_index = match &word.font_name {
                                Some(name) => match fonts.iter().position(|f| f == name) {
                                    Some(idx) => idx,
                                    None => {
                                        fonts.push(name.clone());
                                        fonts.len() - 1
                                    }
                                },
                                None => 0,
                            };
                            json!([
                                round4(word.x_min),
                                round4(y_min),
                                round4(word.x_max),
                                round4(y_max),
                                round4(word.font_size),
                                space_after,
                                round4(baseline),
                                0, // rotation: always 0, matching Zotero's worker
                                0, // underlined
                                if word.bold { 1 } else { 0 },
                                if word.italic { 1 } else { 0 },
                                0, // colorIndex
                                font_index,
                                word.text,
                            ])
                        })
                        .collect();
                    json!([words])
                })
                .collect();
            json!([page.width, page.height, [[[[0, 0, 0, 0, lines_json]]]]])
        })
        .collect();
    json!({
        "metadata": {},
        "totalPages": pages.len(),
        "pages": pages_json,
        "fileName": file_name,
    })
}

fn round4(v: f32) -> f32 {
    (v * 10000.0).round() / 10000.0
}

/// Flip liteparse viewport y (top-left origin) to PDF bottom-left origin.
/// Returns `(yMin, yMax, baseline)`.
fn flip_y(page_height: f32, word: &ProbeWord) -> (f32, f32, f32) {
    let y_max = page_height - word.y_min;
    let y_min = page_height - word.y_max;
    (y_min, y_max, page_height - word.baseline)
}

/// Recognize one local PDF. Returns `Ok(None)` when nothing usable came back
/// (probe failure, no text, no hit) — never blocks the caller's flow.
pub(crate) async fn recognize_pdf(
    pdf_path: &Path,
    task_id: Option<&str>,
) -> Result<Option<RecognizeHit>, AppError> {
    let pages = match run_liteparse_probe(pdf_path, task_id).await {
        Ok(pages) => pages,
        Err(e)
            if e.to_string()
                .contains(crate::features::import::pdf_parse::CANCELLED_MESSAGE) =>
        {
            return Err(e)
        }
        Err(e) => {
            log::debug!(target: "agentero::recognize", "probe failed for {}: {e}", pdf_path.display());
            return Ok(None);
        }
    };
    if pages
        .iter()
        .all(|p| p.lines.iter().all(|l| l.words.is_empty()))
    {
        // Scanned PDF without a text layer — the recognizer only sees text.
        return Ok(None);
    }
    let file_name = pdf_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("paper.pdf")
        .to_string();
    let payload = build_recognizer_payload(&pages, &file_name);

    let client = crate::core::http::client_builder()
        .timeout(RECOGNIZE_TIMEOUT)
        .user_agent(concat!(
            "Agentero/",
            env!("CARGO_PKG_VERSION"),
            " (paper metadata recognition; +https://github.com/poco-ai/agentero)"
        ))
        .build()
        .map_err(|e| AppError::message(format!("recognizer http client: {e}")))?;

    let response = client
        .post(ZOTERO_RECOGNIZER_ENDPOINT)
        .json(&payload)
        .send()
        .await;
    let response = match response {
        Ok(r) => r,
        Err(e) => {
            log::debug!(target: "agentero::recognize", "recognizer request failed: {e}");
            return Ok(None);
        }
    };
    if !response.status().is_success() {
        log::debug!(
            target: "agentero::recognize",
            "recognizer HTTP {}",
            response.status()
        );
        return Ok(None);
    }
    let hit: RecognizeHit = match response.json().await {
        Ok(hit) => hit,
        Err(e) => {
            log::debug!(target: "agentero::recognize", "recognizer body decode: {e}");
            return Ok(None);
        }
    };
    if hit.has_identifier() || hit.title.as_deref().is_some_and(nonempty) {
        Ok(Some(hit))
    } else {
        Ok(None)
    }
}

/// Result of recognizing one PDF: resolved metadata (`ok`), a recognizer
/// title/authors hit without identifiers (`title`), or nothing usable
/// (`no-match` / `error`). Best-effort — never blocks an import.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfIdentProbe {
    pub file_path: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arxiv_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub authors: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub abstract_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publication: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pages: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub source: String,
}

impl PdfIdentProbe {
    fn from_meta(file_path: &str, meta: &PaperMeta, source: &str) -> Self {
        Self {
            file_path: file_path.to_string(),
            status: "ok".into(),
            error: None,
            doi: meta.doi.clone().filter(|d| !d.trim().is_empty()),
            arxiv_id: meta.arxiv_id.clone().filter(|a| !a.trim().is_empty()),
            title: Some(meta.title.clone()),
            authors: meta.authors.clone(),
            year: meta.year,
            abstract_text: meta.abstract_text.clone(),
            publication: meta.publication.clone(),
            volume: meta.volume.clone(),
            issue: meta.issue.clone(),
            pages: meta.pages.clone(),
            publisher: meta.publisher.clone(),
            source: source.to_string(),
        }
    }

    fn no_match(file_path: &str) -> Self {
        Self {
            file_path: file_path.to_string(),
            status: "no-match".into(),
            error: None,
            doi: None,
            arxiv_id: None,
            title: None,
            authors: Vec::new(),
            year: None,
            abstract_text: None,
            publication: None,
            volume: None,
            issue: None,
            pages: None,
            publisher: None,
            source: String::new(),
        }
    }

    pub(crate) fn error(file_path: &str, message: String) -> Self {
        let mut probe = Self::no_match(file_path);
        probe.status = "error".into();
        probe.error = Some(message);
        probe
    }
}

/// Full recognition pipeline for one PDF:
/// probe → recognizer → (identifier resolution | title fallback).
/// Cancellation propagates; every other failure degrades to a status row.
pub(crate) async fn recognize_and_resolve(
    pdf_path: &Path,
    translator_base: &str,
    task_id: Option<&str>,
) -> PdfIdentProbe {
    let file_path = pdf_path.to_string_lossy().to_string();
    let hit = match recognize_pdf(pdf_path, task_id).await {
        Ok(Some(hit)) => hit,
        Ok(None) => return PdfIdentProbe::no_match(&file_path),
        Err(e)
            if e.to_string()
                .contains(crate::features::import::pdf_parse::CANCELLED_MESSAGE) =>
        {
            return PdfIdentProbe::error(&file_path, e.to_string());
        }
        Err(e) => return PdfIdentProbe::error(&file_path, e.to_string()),
    };

    // Identifier hits are leads: re-resolve against authoritative sources.
    if let Some(doi) = hit.doi.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        match resolve_metadata(doi, translator_base, task_id).await {
            Ok((meta, used_translator)) => {
                let source = if used_translator {
                    "translator"
                } else {
                    "crossref"
                };
                return PdfIdentProbe::from_meta(&file_path, &meta, source);
            }
            Err(e) => {
                log::debug!(target: "agentero::recognize", "doi {doi} resolve failed: {e}");
                // Fall through to arXiv / title fallback with the DOI kept.
                let mut probe = title_fallback(&file_path, &hit);
                probe.doi = Some(doi.to_string());
                return probe;
            }
        }
    }
    if let Some(arxiv) = hit
        .arxiv
        .as_deref()
        .map(str::trim)
        .filter(|a| !a.is_empty())
    {
        match fetch_arxiv_metadata(arxiv, task_id).await {
            Ok(meta) => return PdfIdentProbe::from_meta(&file_path, &meta, "arxiv"),
            Err(e) => {
                log::debug!(target: "agentero::recognize", "arXiv {arxiv} resolve failed: {e}");
                let mut probe = title_fallback(&file_path, &hit);
                probe.arxiv_id = Some(arxiv.to_string());
                return probe;
            }
        }
    }
    title_fallback(&file_path, &hit)
}

/// Recognizer-provided title/authors without identifiers (Zotero's fallback).
fn title_fallback(file_path: &str, hit: &RecognizeHit) -> PdfIdentProbe {
    if hit.title.as_deref().is_some_and(nonempty) {
        let stem = Path::new(file_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("paper");
        let meta = meta_from_recognize(hit, stem);
        let mut probe = PdfIdentProbe::from_meta(file_path, &meta, "recognize");
        probe.status = "title".into();
        probe
    } else {
        PdfIdentProbe::no_match(file_path)
    }
}

/// Best-effort metadata from a recognizer hit when no identifier resolved:
/// use the recognizer's own title/authors extraction (Zotero's fallback too).
pub(crate) fn meta_from_recognize(hit: &RecognizeHit, fallback_id: &str) -> PaperMeta {
    let authors = hit.author_names();
    let title = hit
        .title
        .clone()
        .filter(|t| nonempty(t))
        .unwrap_or_else(|| "Untitled".to_string());
    let year = hit
        .year
        .as_deref()
        .and_then(|y| y.trim().chars().take(4).collect::<String>().parse().ok());
    let mut meta = map::local_pdf_meta(crate::features::import::slug_from_stem(fallback_id), title);
    meta.authors = authors;
    meta.year = year;
    meta.language = hit.language.clone().filter(|l| nonempty(l));
    meta.publication = hit.container.clone().filter(|c| nonempty(c));
    meta.publisher = hit.publisher.clone().filter(|p| nonempty(p));
    meta.volume = hit.volume.clone().filter(|v| nonempty(v));
    meta.issue = hit.issue.clone().filter(|i| nonempty(i));
    meta.pages = hit.pages.clone().filter(|p| nonempty(p));
    meta.doi = hit.doi.clone().filter(|d| nonempty(d));
    meta.isbn = hit.isbn.clone().filter(|i| nonempty(i));
    meta.meta_source = Some("recognize".into());
    meta
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::import::pdf_parse::ProbeLine;

    fn word(text: &str, x: f32, y: f32, size: f32) -> ProbeWord {
        ProbeWord {
            text: text.into(),
            x_min: x,
            y_min: y,
            x_max: x + 20.0,
            y_max: y + size,
            baseline: y + size,
            font_size: size,
            rotation: 0,
            bold: false,
            italic: false,
            font_name: Some("Serif".into()),
        }
    }

    fn page(lines: Vec<Vec<ProbeWord>>) -> ProbePage {
        ProbePage {
            width: 612.0,
            height: 792.0,
            lines: lines.into_iter().map(|words| ProbeLine { words }).collect(),
        }
    }

    #[test]
    fn payload_matches_zotero_worker_shape() {
        let payload = build_recognizer_payload(
            &[page(vec![
                vec![
                    word("Attention", 100.0, 60.0, 14.0),
                    word("Is", 130.0, 60.0, 14.0),
                ],
                vec![word("All", 150.0, 80.0, 10.0)],
            ])],
            "t.pdf",
        );

        assert_eq!(payload["metadata"], json!({}));
        assert_eq!(payload["totalPages"], 1);
        assert_eq!(payload["fileName"], "t.pdf");
        let p = &payload["pages"][0];
        assert_eq!(p[0], 612.0);
        assert_eq!(p[1], 792.0);
        // grids → columns → cells → cell = [0,0,0,0, lines]
        let lines = &p[2][0][0][0][4];
        assert_eq!(lines.as_array().unwrap().len(), 2);
        // each lines element wraps one line (`lines.push([currentLine])`)
        let first_word = &lines[0][0][0];
        assert_eq!(first_word.as_array().unwrap().len(), 14);
        assert_eq!(first_word[13], "Attention");
        // y flip: viewport y_min=60 → pdf y_max = 792-60 = 732
        assert_eq!(first_word[3], 732.0);
        assert_eq!(first_word[1], 792.0 - 74.0);
        assert_eq!(first_word[4], 14.0);
        assert_eq!(first_word[12], 0, "fontIndex for first font");
        // gap between "Attention"(ends 120) and "Is"(starts 130) > 0.2×14
        assert_eq!(lines[0][0][0][5], 1, "spaceAfter between words");
        assert_eq!(lines[0][0][1][13], "Is");
        // last word in a line defaults to spaceAfter=1
        assert_eq!(lines[0][0][1][5], 1);
    }

    #[test]
    fn font_indices_are_per_page_first_seen() {
        let mut mono = word("code", 10.0, 60.0, 10.0);
        mono.font_name = Some("Mono".into());
        let payload = build_recognizer_payload(
            &[page(vec![vec![word("a", 10.0, 60.0, 10.0), mono]])],
            "t.pdf",
        );
        let lines = &payload["pages"][0][2][0][0][0][4];
        assert_eq!(lines[0][0][0][12], 0, "Serif");
        assert_eq!(lines[0][0][1][12], 1, "Mono");
    }

    #[test]
    fn recognize_hit_parses_zotero_shapes() {
        let arxiv: RecognizeHit = serde_json::from_str(
            r#"{"type":"journal-article","authors":[],"language":"en","arxiv":"1706.03762","timeMs":125}"#,
        )
        .unwrap();
        assert_eq!(arxiv.arxiv.as_deref(), Some("1706.03762"));
        assert!(arxiv.has_identifier());
        assert!(!arxiv.title.as_deref().is_some_and(nonempty));

        let doi: RecognizeHit = serde_json::from_str(
            r#"{"type":"journal-article","authors":[{"firstName":"Maximilian","lastName":"Patzig"}],"language":"en","title":"Measurement of structural integrity","doi":"10.1371/journal.pone.0224078"}"#,
        )
        .unwrap();
        assert_eq!(doi.author_names(), vec!["Maximilian Patzig".to_string()]);
    }

    #[test]
    fn meta_from_recognize_uses_hit_fields() {
        let hit = RecognizeHit {
            title: Some("A Study".into()),
            authors: vec![RecognizeAuthor {
                first_name: Some("Ada".into()),
                last_name: Some("Lovelace".into()),
                name: None,
            }],
            year: Some("2019".into()),
            container: Some("Nature".into()),
            ..Default::default()
        };
        let meta = meta_from_recognize(&hit, "10.1371_x");
        assert_eq!(meta.title, "A Study");
        assert_eq!(meta.authors, vec!["Ada Lovelace".to_string()]);
        assert_eq!(meta.year, Some(2019));
        assert_eq!(meta.publication.as_deref(), Some("Nature"));
        assert_eq!(meta.meta_source.as_deref(), Some("recognize"));
    }

    /// Live end-to-end check against the real Zotero recognizer:
    /// liteparse probe → payload builder → HTTP 200 with identifiers.
    /// Run manually with a real PDF:
    /// `AGENTERO_RECOGNIZE_LIVE_PDF=<path> cargo test -p agentero --lib live_recognize -- --ignored --nocapture`
    #[cfg(all(test, not(any(target_os = "ios", target_os = "android"))))]
    #[tokio::test]
    #[ignore = "network test; requires AGENTERO_RECOGNIZE_LIVE_PDF"]
    async fn live_recognize_payload_round_trip() {
        let Ok(pdf) = std::env::var("AGENTERO_RECOGNIZE_LIVE_PDF") else {
            panic!("set AGENTERO_RECOGNIZE_LIVE_PDF to a real PDF path");
        };
        let pages = crate::features::import::pdf_parse::run_liteparse_probe_direct(Path::new(&pdf))
            .await
            .expect("probe");
        assert!(!pages.is_empty() && pages.iter().any(|p| !p.lines.is_empty()));
        let payload = build_recognizer_payload(&pages, "live-test.pdf");
        if std::env::var_os("AGENTERO_RECOGNIZE_DEBUG").is_some() {
            for (pi, page) in payload["pages"].as_array().unwrap().iter().enumerate() {
                let lines = &page[2][0][0][0][4];
                for (li, line) in lines.as_array().unwrap().iter().take(40).enumerate() {
                    let text: Vec<&str> = line[0]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|w| w[13].as_str().unwrap_or(""))
                        .collect();
                    println!("page{pi} line{li}: {}", text.join(" "));
                }
            }
        }
        let client = crate::core::http::client_builder()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap();
        let response = client
            .post(ZOTERO_RECOGNIZER_ENDPOINT)
            .json(&payload)
            .send()
            .await
            .expect("request");
        let status = response.status();
        let body: RecognizeHit = response.json().await.expect("decode");
        println!(
            "HTTP {status} -> doi={:?} arxiv={:?} title={:?}",
            body.doi, body.arxiv, body.title
        );
        assert!(status.is_success());
        assert!(
            body.has_identifier() || body.title.is_some(),
            "recognizer returned nothing usable: {body:?}"
        );
    }
}
