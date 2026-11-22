//! PDF metadata recognition: local probe (liteparse word boxes) → Zotero
//! recognizer service → identifier resolution (Translator / Crossref / arXiv).
//!
//! The recognizer request shape mirrors Zotero's
//! `PDFWorker.getRecognizerData` JSON: the first pages' word geometry, not the
//! PDF bytes themselves. Recognition results are treated as leads: a DOI /
//! arXiv id is re-resolved through the authoritative metadata chain. If
//! unresolved, a conservative scholarly title search can fill metadata before
//! falling back to the recognizer's own result.
//!
//! The hosted recognizer is a convenience, not a dependency. It never returns
//! a CJK title (for a Chinese paper it echoes the DOI but not the title), so a
//! local evidence pass reads the first page itself — the title from the
//! largest type and any labelled DOI — and is used whenever the recognizer
//! misses, fails, or only identifies the paper. Without it, a Chinese PDF
//! imported as `paper2019.pdf` keeps that filename as its title.

use crate::error::AppError;
use crate::features::paper::catalog::papers::PaperRecord;
use crate::features::paper::import::api_mapper::api_paper_to_meta;
use crate::features::paper::import::pdf_parse::{
    run_liteparse_probe, ProbeLine, ProbePage, ProbeWord,
};
use crate::features::paper::import::resolve_metadata;
use crate::features::paper::import::{
    check_task_not_cancelled, doi_slug, slug_from_stem, CANCELLED_MESSAGE,
};
use crate::features::paper::scholar_api::identifiers::{extract_arxiv_id, fetch_arxiv_metadata};
use crate::features::paper::scholar_api::scoring::{
    author_overlap, title_similarity, title_similarity_key,
};
use crate::features::paper::scholar_api::search::{search_papers_by_title, SourceScope};
use crate::features::paper::scholar_api::{ApiError, ApiPaper};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::LazyLock;
use std::time::Duration;

/// Zotero's hosted recognizer endpoint. Undocumented and unsuitable as a
/// hard dependency: the import keeps its local record when recognition fails.
pub const ZOTERO_RECOGNIZER_ENDPOINT: &str = "https://services.zotero.org/recognizer/recognize";

const RECOGNIZE_TIMEOUT: Duration = Duration::from_secs(30);
const RECOGNIZER_SERVICE_ERROR: &str = "recognizer_service_error";

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
    pub fn has_identifier(&self) -> bool {
        self.doi.as_deref().is_some_and(nonempty)
            || self.arxiv.as_deref().is_some_and(nonempty)
            || self.isbn.as_deref().is_some_and(nonempty)
    }

    fn publication_year(&self) -> Option<i32> {
        self.year
            .as_deref()
            .and_then(|y| y.trim().chars().take(4).collect::<String>().parse().ok())
    }

    pub fn author_names(&self) -> Vec<String> {
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

/// Normalize the title returned by Zotero's recognizer.
///
/// Some PDFs carry a UTF-8 byte-order mark in their first text run. The
/// recognizer can echo it back either as the actual U+FEFF character or after
/// it has been decoded once more as the visible `ï»¿` prefix. Neither is part
/// of the paper title, and letting it reach the catalog makes the title look
/// corrupt in the library.
fn clean_recognizer_title(title: &str) -> Option<String> {
    let mut title = title.trim();
    loop {
        let cleaned = title
            .trim_start_matches('\u{feff}')
            .trim_start_matches("ï»¿")
            .trim_start();
        if cleaned.len() == title.len() {
            break;
        }
        title = cleaned;
    }
    (!title.is_empty()).then(|| title.to_string())
}

/// Evidence a PDF carries about itself, read from the first page's layout.
///
/// The Zotero recognizer reads the same geometry remotely and never surfaces
/// CJK titles, so this local pass is what keeps a Chinese paper from staying
/// named after its file. It is deterministic and free of network I/O.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct LocalEvidence {
    /// Title candidate set in the largest type near the top of page 1.
    pub title: Option<String>,
    /// Labelled DOI printed on page 1, in its bare `10.…/…` form.
    pub doi: Option<String>,
}

impl LocalEvidence {
    pub(crate) fn from_pages(pages: &[ProbePage]) -> Self {
        let Some(first) = pages.first() else {
            return Self::default();
        };
        Self {
            title: local_title(first),
            doi: local_doi(first),
        }
    }
}

/// A word's visual size. PDFium often bakes the text-matrix size into
/// `font_size` as ~1.0; the glyph box height is the reliable signal there.
fn word_visual_size(word: &ProbeWord) -> f32 {
    if word.font_size > 2.0 {
        word.font_size
    } else {
        (word.y_max - word.y_min).max(0.1)
    }
}

fn median_f32(mut values: Vec<f32>) -> Option<f32> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    Some(values[values.len() / 2])
}

fn is_cjk(c: char) -> bool {
    matches!(
        c as u32,
        0x2E80..=0x9FFF        // radicals, CJK punctuation, unified ideographs
            | 0xF900..=0xFAFF  // compatibility ideographs
            | 0xFE30..=0xFE4F  // vertical/compact forms
            | 0xFF00..=0xFFEF  // full-width forms
            | 0x20000..=0x2FA1F // extension B and beyond
    )
}

/// Join one visual line's words without inventing spaces for CJK text.
fn line_text(line: &ProbeLine) -> String {
    let mut out = String::new();
    for word in &line.words {
        let text = word.text.trim();
        if text.is_empty() {
            continue;
        }
        if !out.is_empty() {
            let prev_cjk = out.chars().last().is_some_and(is_cjk);
            let next_cjk = text.chars().next().is_some_and(is_cjk);
            if !prev_cjk && !next_cjk {
                out.push(' ');
            }
        }
        out.push_str(text);
    }
    out
}

/// Text and typographic size of one visual line, when it has text.
fn line_metrics(line: &ProbeLine) -> Option<(String, f32, f32)> {
    let text = line_text(line);
    if text.trim().is_empty() {
        return None;
    }
    let sizes: Vec<f32> = line
        .words
        .iter()
        .filter(|word| !word.text.trim().is_empty())
        .map(word_visual_size)
        .collect();
    let size = median_f32(sizes)?;
    let y = line
        .words
        .iter()
        .map(|word| word.y_min)
        .fold(f32::INFINITY, f32::min);
    Some((text, size, y))
}

fn join_title_lines(lines: &[String]) -> String {
    let mut out = String::new();
    for text in lines {
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        if !out.is_empty() {
            let prev = out.chars().last();
            let next = text.chars().next();
            let needs_space =
                !prev.is_some_and(is_cjk) && !next.is_some_and(is_cjk) && prev != Some('-');
            if needs_space {
                out.push(' ');
            }
        }
        out.push_str(text);
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// True for page furniture that shares the title's font size but is not the
/// title: running heads, identifiers, abstract labels, section numbers.
fn plausible_title_text(text: &str) -> bool {
    let text = text.trim();
    let chars = text.chars().count();
    if !(3..=300).contains(&chars) {
        return false;
    }
    if page_furniture(text) || section_heading(&text.to_lowercase()) {
        return false;
    }
    if text.chars().filter(|c| c.is_alphanumeric()).count() < 2 {
        return false;
    }
    true
}

/// Running heads, identifiers and metadata labels: typography that shares a
/// page with the title and must not be mistaken for it.
fn page_furniture(text: &str) -> bool {
    hard_furniture(text) || label_furniture(&text.to_lowercase())
}

/// Text that is never body copy: URLs, identifiers, volume/page markers.
fn hard_furniture(text: &str) -> bool {
    let lower = text.to_lowercase();
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.contains("://")
        || lower.contains("www.")
        || lower.contains("issn")
        || lower.contains("isbn")
        || lower.contains("arxiv:")
        || lower.contains("doi:")
        || lower.contains("doi：")
        || lower.contains("doi.org/")
    {
        return true;
    }
    // Volume/issue/page markers ("第35卷", "35(1): 3-13", "2020").
    let marker_chars = "第卷期年()-:,.";
    text.chars()
        .all(|c| c.is_numeric() || c.is_whitespace() || marker_chars.contains(c))
}

/// Labels that head a metadata block ("摘要：", "Keywords:") rather than body
/// prose; a line carrying real sentences after the label stays body copy.
fn label_furniture(lower: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "摘要",
        "关键词",
        "收稿日期",
        "基金项目",
        "作者简介",
        "文章编号",
        "中图分类号",
        "文献标识码",
        "引用格式",
        "目录",
        "abstract",
        "keywords",
        "received",
        "accepted",
        "article history",
        "citation",
        "contents",
        "vol.",
        "no.",
    ];
    if let Some(rest) = PREFIXES
        .iter()
        .find_map(|prefix| lower.strip_prefix(prefix))
    {
        // A bare label ("Abstract") is a heading; "摘要：…" is prose.
        if rest.trim().is_empty() || rest.trim_start().len() <= 12 {
            return true;
        }
    }
    false
}

fn section_heading(lower: &str) -> bool {
    static SECTION: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^\d{1,2}(?:\.\d+)*\s+\S").unwrap());
    lower.chars().count() <= 60 && SECTION.is_match(lower)
}

/// Body size of page 1: the size carrying the most characters. Counting
/// characters rather than words keeps a long title from outvoting a short
/// abstract, which a plain median of word sizes would let it do.
fn body_font_size(page: &ProbePage) -> Option<f32> {
    let mut buckets: Vec<(f32, usize)> = Vec::new();
    for line in &page.lines {
        let text = line_text(line);
        // A masthead URL or DOI line is not body text and can outweigh the
        // body in characters, which would push the title threshold above the
        // title itself.
        if text.is_empty() || hard_furniture(&text) {
            continue;
        }
        for word in &line.words {
            let word_text = word.text.trim();
            if word_text.is_empty() {
                continue;
            }
            let size = (word_visual_size(word) * 2.0).round() / 2.0;
            let chars = word_text.chars().count();
            match buckets.iter_mut().find(|(value, _)| *value == size) {
                Some((_, weight)) => *weight += chars,
                None => buckets.push((size, chars)),
            }
        }
    }
    buckets
        .into_iter()
        .max_by_key(|(_, weight)| *weight)
        .map(|(size, _)| size)
}

/// Title from the largest type in the upper part of page 1.
///
/// A wrapped title is a run of consecutive near-largest lines; when several
/// candidates exist (a masthead, a section heading) the run's area breaks the
/// tie: titles are wide as well as large.
fn local_title(page: &ProbePage) -> Option<String> {
    let body_size = body_font_size(page)?;
    let min_size = body_size * 1.35 + 0.5;
    let title_area = page.height * 0.65;
    let candidates: Vec<(usize, String, f32)> = page
        .lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| {
            let (text, size, y) = line_metrics(line)?;
            (size >= min_size && y <= title_area && plausible_title_text(&text))
                .then_some((index, text, size))
        })
        .collect();
    let max_size = candidates
        .iter()
        .map(|(_, _, size)| *size)
        .fold(0.0, f32::max);
    if max_size <= 0.0 {
        return None;
    }
    // Group near-largest lines into runs of adjacent visual lines.
    let mut runs: Vec<Vec<(usize, String, f32)>> = Vec::new();
    for candidate in candidates
        .into_iter()
        .filter(|(_, _, size)| *size >= max_size * 0.85)
    {
        match runs.last_mut() {
            Some(run) if candidate.0 <= run.last().map_or(0, |last| last.0) + 1 => {
                run.push(candidate)
            }
            _ => runs.push(vec![candidate]),
        }
    }
    let best = runs.into_iter().max_by(|a, b| {
        let score = |run: &[(usize, String, f32)]| {
            let size = run.iter().map(|line| line.2).fold(0.0, f32::max);
            let chars: usize = run.iter().map(|line| line.1.chars().count()).sum();
            (size * (chars as f32).sqrt() * 1000.0) as i64
        };
        score(a).cmp(&score(b))
    })?;
    let texts: Vec<String> = best.into_iter().map(|(_, text, _)| text).collect();
    let title = join_title_lines(&texts);
    let chars = title.chars().count();
    (3..=300).contains(&chars).then_some(title)
}

/// DOI printed on page 1. Words are re-joined around `.` and `/` first: the
/// PDF's text runs can split a bare DOI into `10 .31497/zrzyxb .20200102`.
fn local_doi(page: &ProbePage) -> Option<String> {
    let mut text = String::new();
    for line in page.lines.iter().take(80) {
        let line = line_text(line);
        if line.is_empty() {
            continue;
        }
        text.push_str(&SPACED_PUNCT.replace_all(&line, "$1"));
        text.push('\n');
    }
    for pattern in [&*LABELLED_DOI, &*BARE_DOI] {
        for captures in pattern.captures_iter(&text) {
            if let Some(doi) = clean_local_doi(&captures[1]) {
                return Some(doi);
            }
        }
    }
    None
}

fn clean_local_doi(raw: &str) -> Option<String> {
    let doi = raw
        .trim()
        .trim_end_matches([
            '.', ',', ';', ':', ')', ']', '}', '\'', '"', '>', '。', '，', '；', '：', '）', '】',
        ])
        .to_string();
    (doi.contains('/') && doi.len() >= 8 && !doi.chars().any(|c| c.is_whitespace() || is_cjk(c)))
        .then_some(doi)
}

static SPACED_PUNCT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s*([./])\s*").expect("valid dotted token regex"));
static LABELLED_DOI: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)doi\s*[:：]?\s*(10\.\d{4,9}/[A-Za-z0-9][A-Za-z0-9._;()/:\-]*)")
        .expect("valid labelled DOI regex")
});
static BARE_DOI: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(10\.\d{4,9}/[A-Za-z0-9][A-Za-z0-9._;()/:\-]*)").expect("valid DOI regex")
});

/// Build the recognizer request payload from probe pages.
///
/// Layout (document-worker `getRecognizerData`):
/// `pages[i] = [width, height, [[[[0,0,0,0, lines]]]]]`,
/// `lines[k] = [word, …]` (each element is one line),
/// `word = [xMin, yMin, xMax, yMax, fontSize, spaceAfter, baseline,
///          rotation, underlined, bold, italic, colorIndex, fontIndex, text]`
/// with y in PDF bottom-left coords (liteparse viewport y flipped).
pub fn build_recognizer_payload(pages: &[ProbePage], file_name: &str) -> Value {
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

/// Read the visible title on the first page without calling a recognition service.
pub(crate) async fn first_page_title(pdf: &Path, task_id: Option<&str>) -> Option<String> {
    let pages = run_liteparse_probe(pdf, task_id).await.ok()?;
    pages.first().and_then(local_title)
}

/// Recognize one local PDF. No text or no usable hit is `Ok(None)`;
/// parser, transport and response failures are errors, not misses.
pub async fn recognize_pdf(
    pdf_path: &Path,
    task_id: Option<&str>,
) -> Result<Option<RecognizeHit>, AppError> {
    let pages = run_liteparse_probe(pdf_path, task_id).await?;
    recognize_probed_pages(&pages, pdf_path).await
}

/// Ask the hosted recognizer about pages already probed from the PDF.
async fn recognize_probed_pages(
    pages: &[ProbePage],
    pdf_path: &Path,
) -> Result<Option<RecognizeHit>, AppError> {
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
    let payload = build_recognizer_payload(pages, &file_name);

    let client = crate::http::client_builder()
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
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| {
            AppError::domain(RECOGNIZER_SERVICE_ERROR, format!("recognizer request: {e}"))
        })?;
    let hit: RecognizeHit = response.json().await.map_err(|e| {
        AppError::domain(
            RECOGNIZER_SERVICE_ERROR,
            format!("recognizer response: {e}"),
        )
    })?;
    if hit.has_identifier()
        || hit
            .title
            .as_deref()
            .is_some_and(|title| clean_recognizer_title(title).is_some())
    {
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
    /// Soft warning code for the UI (e.g. `arxiv_rate_limited`) when
    /// recognition partially succeeded but an authoritative lookup failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

impl PdfIdentProbe {
    /// A matching folder slug alone does not prove the target is the same work.
    pub fn matches_canonical_identifiers(&self, record: &PaperRecord) -> bool {
        let arxiv = self.arxiv_id.as_deref().and_then(extract_arxiv_id);
        let other_arxiv = record.arxiv_id.as_deref().and_then(extract_arxiv_id);
        same_work_ids(
            self.doi.as_deref(),
            arxiv.as_deref(),
            record.doi.as_deref(),
            other_arxiv.as_deref(),
        )
    }

    pub fn from_meta(file_path: &str, meta: &PaperRecord, source: &str) -> Self {
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
            warning: None,
        }
    }

    pub fn no_match(file_path: &str) -> Self {
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
            warning: None,
        }
    }

    pub fn error(file_path: &str, message: String) -> Self {
        let mut probe = Self::no_match(file_path);
        probe.status = "error".into();
        probe.error = Some(message);
        probe
    }
}

/// Folder-safe canonical base id from a resolved probe: bare arXiv id or
/// DOI slug (mirrors identifier-import naming, e.g. `papers/1706.03762`).
pub fn canonical_base_id(probe: &PdfIdentProbe) -> Option<String> {
    probe
        .arxiv_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(slug_from_stem)
        .or_else(|| {
            probe
                .doi
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(doi_slug)
        })
        .filter(|s| !s.is_empty())
}

/// Copy the recognized fields onto a catalog row. Only `Some`/non-empty
/// probe values overwrite; placeholders start empty so this never discards
/// information. `meta_source` records the provenance (`recognize` /
/// `local-unresolved`).
pub fn apply_probe_fields(record: &mut PaperRecord, probe: &PdfIdentProbe, meta_source: &str) {
    fn take(slot: &mut Option<String>, incoming: &Option<String>) {
        if let Some(v) = incoming.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
            *slot = Some(v.to_string());
        }
    }
    if let Some(title) = probe
        .title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        record.title = title.to_string();
    }
    if !probe.authors.is_empty() {
        record.authors = probe.authors.clone();
    }
    if let Some(year) = probe.year {
        record.year = Some(year);
    }
    take(&mut record.doi, &probe.doi);
    take(&mut record.arxiv_id, &probe.arxiv_id);
    take(&mut record.abstract_text, &probe.abstract_text);
    take(&mut record.publication, &probe.publication);
    take(&mut record.volume, &probe.volume);
    take(&mut record.issue, &probe.issue);
    take(&mut record.pages, &probe.pages);
    take(&mut record.publisher, &probe.publisher);
    record.meta_source = Some(meta_source.to_string());
    record.updated_at = crate::time::now_rfc3339_millis();
}

/// Probe → recognizer → identifier resolution or a conservative title lookup.
/// `known_title` is treated as a filename-derived hint, not as PDF evidence.
pub async fn recognize_and_resolve(
    pdf_path: &Path,
    translator_base: &str,
    task_id: Option<&str>,
    known_title: Option<&str>,
) -> PdfIdentProbe {
    let file_path = pdf_path.to_string_lossy();
    if check_task_not_cancelled(task_id).is_err() {
        return PdfIdentProbe::error(&file_path, CANCELLED_MESSAGE.into());
    }
    let probe =
        recognize_and_resolve_inner(pdf_path, &file_path, translator_base, task_id, known_title)
            .await;
    if check_task_not_cancelled(task_id).is_err() {
        return PdfIdentProbe::error(&file_path, CANCELLED_MESSAGE.into());
    }
    probe
}

async fn recognize_and_resolve_inner(
    pdf_path: &Path,
    file_path: &str,
    translator_base: &str,
    task_id: Option<&str>,
    known_title: Option<&str>,
) -> PdfIdentProbe {
    // Probe once: recognition and local evidence need the same pages.
    let pages = run_liteparse_probe(pdf_path, task_id).await;
    if check_task_not_cancelled(task_id).is_err() {
        return PdfIdentProbe::error(file_path, CANCELLED_MESSAGE.into());
    }
    let (recognized, local) = match pages {
        Ok(pages) => (
            recognize_probed_pages(&pages, pdf_path).await,
            LocalEvidence::from_pages(&pages),
        ),
        Err(e) => (Err(e), LocalEvidence::default()),
    };
    if check_task_not_cancelled(task_id).is_err() {
        return PdfIdentProbe::error(file_path, CANCELLED_MESSAGE.into());
    }
    let hit = match recognized {
        Ok(Some(hit)) => hit,
        Ok(None) => {
            return local_fallback(
                file_path,
                &local,
                known_title,
                translator_base,
                task_id,
                PdfIdentProbe::no_match(file_path),
            )
            .await;
        }
        Err(e) => {
            let fallback = PdfIdentProbe::error(file_path, e.to_string());
            return if e.code() == RECOGNIZER_SERVICE_ERROR {
                local_fallback(
                    file_path,
                    &local,
                    known_title,
                    translator_base,
                    task_id,
                    fallback,
                )
                .await
            } else {
                fallback
            };
        }
    };

    // Identifier hits are leads: re-resolve against authoritative sources.
    if let Some(doi) = hit.doi.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        match resolve_metadata(doi, translator_base, task_id).await {
            Ok(resolved) => {
                let source = if resolved.used_translator {
                    "translator"
                } else {
                    "crossref"
                };
                return PdfIdentProbe::from_meta(file_path, &resolved.record, source);
            }
            Err(e) => {
                log::debug!(target: "agentero::recognize", "doi {doi} resolve failed: {e}");
                let mut probe = with_local_title(title_fallback(file_path, &hit), &local);
                probe.doi = Some(doi.to_string());
                return lookup_recognizer_title(&hit, &local, probe, task_id).await;
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
            // The chain names whichever source actually answered (arxiv / s2
            // / alphaxiv), so meta_source reflects the failover.
            Ok(meta) => {
                return PdfIdentProbe::from_meta(file_path, &api_paper_to_meta(&meta), meta.source);
            }
            Err(e) => {
                log::debug!(target: "agentero::recognize", "arXiv {arxiv} resolve failed: {e}");
                let mut probe = with_local_title(title_fallback(file_path, &hit), &local);
                probe.arxiv_id = Some(arxiv.to_string());
                // The chain only reports rate limiting after its internal
                // retry pass, so this warning means every source throttled.
                if e.code() == "rate_limited" {
                    probe.warning = Some("arxiv_rate_limited".into());
                }
                return lookup_recognizer_title(&hit, &local, probe, task_id).await;
            }
        }
    }
    let fallback = with_local_title(title_fallback(file_path, &hit), &local);
    if hit.has_identifier() {
        return fallback; // ISBN-only hits still use Zotero's original metadata.
    }
    lookup_recognizer_title(&hit, &local, fallback, task_id).await
}

/// Continue after the recognizer missed or failed: resolve a DOI printed on
/// the page, then search the page's own title, and always keep that title as
/// the fallback so the entry stops showing its filename.
async fn local_fallback(
    file_path: &str,
    local: &LocalEvidence,
    known_title: Option<&str>,
    translator_base: &str,
    task_id: Option<&str>,
    mut fallback: PdfIdentProbe,
) -> PdfIdentProbe {
    if let Some(doi) = local.doi.as_deref() {
        if check_task_not_cancelled(task_id).is_err() {
            return PdfIdentProbe::error(file_path, CANCELLED_MESSAGE.into());
        }
        match resolve_metadata(doi, translator_base, task_id).await {
            Ok(resolved) => {
                let source = if resolved.used_translator {
                    "translator"
                } else {
                    "crossref"
                };
                return PdfIdentProbe::from_meta(file_path, &resolved.record, source);
            }
            Err(e) => {
                // Keep the DOI even though its metadata did not resolve.
                log::debug!(target: "agentero::recognize", "local doi {doi} resolve failed: {e}");
                fallback.doi = Some(doi.to_string());
            }
        }
    }
    fallback = with_local_title(fallback, local);
    // The PDF's title is evidence; a filename-derived hint is weak and only
    // consulted when page 1 offered nothing usable.
    let title = local.title.as_deref().or(known_title);
    lookup_title(title, None, fallback, task_id).await
}

/// Fill a title the recognizer could not provide from the PDF's own layout.
fn with_local_title(mut probe: PdfIdentProbe, local: &LocalEvidence) -> PdfIdentProbe {
    let has_title = probe
        .title
        .as_deref()
        .is_some_and(|title| !title.trim().is_empty());
    if has_title {
        return probe;
    }
    if let Some(title) = local.title.as_deref().filter(|t| !t.trim().is_empty()) {
        probe.title = Some(title.to_string());
        probe.status = "title".into();
        probe.source = "local-pdf".into();
    }
    probe
}

async fn lookup_recognizer_title(
    hit: &RecognizeHit,
    local: &LocalEvidence,
    fallback: PdfIdentProbe,
    task_id: Option<&str>,
) -> PdfIdentProbe {
    let title = hit
        .title
        .as_deref()
        .and_then(clean_recognizer_title)
        .or_else(|| local.title.clone());
    lookup_title(title.as_deref(), Some(hit), fallback, task_id).await
}

async fn lookup_title(
    title: Option<&str>,
    hit: Option<&RecognizeHit>,
    fallback: PdfIdentProbe,
    task_id: Option<&str>,
) -> PdfIdentProbe {
    let Some(title) = title.and_then(searchable_title) else {
        return fallback;
    };
    if check_task_not_cancelled(task_id).is_err() {
        return PdfIdentProbe::error(&fallback.file_path, CANCELLED_MESSAGE.into());
    }
    let result = search_papers_by_title(title, SourceScope::All, 5).await;
    title_lookup_result(title, hit, fallback, result)
}

fn title_lookup_result(
    title: &str,
    hit: Option<&RecognizeHit>,
    fallback: PdfIdentProbe,
    result: Result<Vec<ApiPaper>, ApiError>,
) -> PdfIdentProbe {
    let has_identifier = canonical_base_id(&fallback).is_some();
    match result {
        Ok(papers) => select_title_match(title, hit, papers)
            .and_then(|paper| {
                let meta = api_paper_to_meta(&paper);
                if has_identifier && !fallback.matches_canonical_identifiers(&meta) {
                    return None;
                }
                let mut probe = PdfIdentProbe::from_meta(&fallback.file_path, &meta, paper.source);
                if has_identifier {
                    // Title search may enrich a known identifier, but cannot change
                    // which identifier anchors the existing recognition result.
                    probe.doi.clone_from(&fallback.doi);
                    probe.arxiv_id.clone_from(&fallback.arxiv_id);
                }
                Some(probe)
            })
            .unwrap_or(fallback),
        Err(e)
            if !has_identifier
                && fallback.status == "no-match"
                && !matches!(e, ApiError::NotFound) =>
        {
            PdfIdentProbe::error(&fallback.file_path, format!("scholarly title lookup: {e}"))
        }
        Err(_) => fallback,
    }
}

fn searchable_title(title: &str) -> Option<&str> {
    let title = title.trim();
    let key = title_similarity_key(title);
    if key.chars().filter(|c| c.is_alphabetic()).take(8).count() < 8
        || (key.is_ascii()
            && key
                .split_whitespace()
                .filter(|word| word.chars().any(char::is_alphabetic))
                .take(2)
                .count()
                < 2)
        || uuid::Uuid::parse_str(title).is_ok()
        || key.split_whitespace().all(|word| {
            matches!(
                word,
                "paper" | "untitled" | "document" | "download" | "pdf" | "copy"
            ) || word.chars().all(|c| c.is_numeric())
        })
    {
        return None;
    }
    Some(title)
}

fn select_title_match(
    title: &str,
    hit: Option<&RecognizeHit>,
    papers: Vec<ApiPaper>,
) -> Option<ApiPaper> {
    let query = title_similarity_key(title);
    let authors = hit.map(RecognizeHit::author_names).unwrap_or_default();
    let year = hit.and_then(RecognizeHit::publication_year);
    let mut candidates: Vec<_> = papers
        .into_iter()
        .filter_map(|mut paper| {
            let key = title_similarity_key(&paper.title);
            let author_match = author_overlap(&authors, &paper.authors) >= 0.30;
            let year_match = year.zip(paper.year).map(|(a, b)| a.abs_diff(b) <= 1);
            if (!authors.is_empty() && !paper.authors.is_empty() && !author_match)
                || year_match == Some(false)
                || (key != query
                    && (!(author_match || year_match == Some(true))
                        || title_similarity(&query, &key) < 85))
            {
                return None;
            }
            paper.identifiers.doi = paper.identifiers.doi.as_deref().and_then(scholarly_doi);
            paper.identifiers.arxiv_id = paper
                .identifiers
                .arxiv_id
                .as_deref()
                .and_then(extract_arxiv_id);
            Some((key, paper))
        })
        .collect();

    // A record with both identifiers can link the DOI and arXiv records.
    // Inspect raw results: fuzzy fusion can hide real identifier conflicts.
    candidates.sort_by_key(|(key, p)| {
        std::cmp::Reverse((
            usize::from(p.identifiers.doi.is_some())
                + usize::from(p.identifiers.arxiv_id.is_some()),
            key == &query,
            !p.authors.is_empty() && p.year.is_some(),
        ))
    });
    let mut candidates = candidates.into_iter();
    let (best_key, best) = candidates.next()?;
    let ids = &best.identifiers;
    let has_id = ids.doi.is_some() || ids.arxiv_id.is_some();
    if !has_id && (best.authors.is_empty() || best.year.is_none()) {
        return None;
    }
    for (key, paper) in candidates {
        let other = &paper.identifiers;
        if has_id && (other.doi.is_some() || other.arxiv_id.is_some()) {
            if !same_work_ids(
                ids.doi.as_deref(),
                ids.arxiv_id.as_deref(),
                other.doi.as_deref(),
                other.arxiv_id.as_deref(),
            ) {
                return None;
            }
        } else if key != best_key
            || paper.year.is_none()
            || paper.year != best.year
            || author_overlap(&paper.authors, &best.authors) < 0.30
        {
            return None;
        }
    }
    Some(best)
}

// Title search results can cause a local rename. Use bare, path-safe DOI
// values; DOI punctuation remains significant when comparing identities.
fn scholarly_doi(doi: &str) -> Option<String> {
    let (prefix, suffix) = doi.trim().split_once('/')?;
    let registrant = prefix.strip_prefix("10.")?;
    (!registrant.is_empty()
        && registrant.bytes().all(|b| b.is_ascii_digit() || b == b'.')
        && !suffix.is_empty()
        && suffix.chars().all(|c| {
            !c.is_control()
                && !c.is_whitespace()
                && !matches!(c, '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        }))
    .then(|| doi.trim().to_string())
}

fn same_work_ids(
    doi: Option<&str>,
    arxiv: Option<&str>,
    other_doi: Option<&str>,
    other_arxiv: Option<&str>,
) -> bool {
    let doi = doi
        .filter(|d| nonempty(d))
        .zip(other_doi.filter(|d| nonempty(d)))
        .map(|(a, b)| a.trim().eq_ignore_ascii_case(b.trim()));
    let arxiv = arxiv
        .zip(other_arxiv)
        .map(|(a, b)| a.eq_ignore_ascii_case(b));
    doi != Some(false) && arxiv != Some(false) && (doi == Some(true) || arxiv == Some(true))
}

/// Recognizer-provided title/authors without identifiers (Zotero's fallback).
fn title_fallback(file_path: &str, hit: &RecognizeHit) -> PdfIdentProbe {
    if hit
        .title
        .as_deref()
        .is_some_and(|title| clean_recognizer_title(title).is_some())
    {
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
pub fn meta_from_recognize(hit: &RecognizeHit, fallback_id: &str) -> PaperRecord {
    let authors = hit.author_names();
    let title = hit
        .title
        .as_deref()
        .and_then(clean_recognizer_title)
        .unwrap_or_else(|| "Untitled".to_string());
    let mut meta = PaperRecord::local_pdf(
        crate::features::paper::import::slug_from_stem(fallback_id),
        title,
    );
    meta.authors = authors;
    meta.year = hit.publication_year();
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
    use crate::features::paper::import::pdf_parse::ProbeLine;

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

    #[test]
    fn removes_bom_mojibake_from_recognizer_titles() {
        for prefix in ['\u{feff}'.to_string(), "ï»¿".to_string()] {
            let hit = RecognizeHit {
                title: Some(format!("{prefix}  Attention Is All You Need")),
                ..Default::default()
            };
            let meta = meta_from_recognize(&hit, "attention");
            assert_eq!(meta.title, "Attention Is All You Need");
        }

        assert_eq!(clean_recognizer_title("ï»¿\u{feff} "), None);
    }

    /// Live end-to-end check against the real Zotero recognizer:
    /// liteparse probe → payload builder → HTTP 200 with identifiers.
    /// Run manually with a real PDF:
    /// `AGENTERO_RECOGNIZE_LIVE_PDF=<path> cargo test -p agentero-core --lib live_recognize -- --ignored --nocapture`
    #[cfg(all(test, not(any(target_os = "ios", target_os = "android"))))]
    #[tokio::test]
    #[ignore = "network test; requires AGENTERO_RECOGNIZE_LIVE_PDF"]
    async fn live_recognize_payload_round_trip() {
        let Ok(pdf) = std::env::var("AGENTERO_RECOGNIZE_LIVE_PDF") else {
            panic!("set AGENTERO_RECOGNIZE_LIVE_PDF to a real PDF path");
        };
        let pages =
            crate::features::paper::import::pdf_parse::run_liteparse_probe_direct(Path::new(&pdf))
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
        let client = crate::http::client_builder()
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

    /// The reported failure: a Chinese paper imported from `paper2019.pdf`
    /// kept its filename because the hosted recognizer never returns a CJK
    /// title. Page-1 layout alone still knows both the title and the DOI.
    #[test]
    fn local_evidence_reads_cjk_title_and_labelled_doi() {
        let pages = vec![page(vec![
            vec![
                word("自然资源学报,", 60.0, 34.0, 9.0),
                word("DOI:", 334.0, 47.0, 9.0),
                word("10", 358.0, 47.0, 9.0),
                word(".31497/zrzyxb", 370.0, 47.0, 9.0),
                word(".20200102", 430.0, 47.0, 9.0),
            ],
            vec![
                word("过程耦合与空间集成：", 98.0, 88.0, 20.0),
                word("国土空间生态修复的", 269.0, 88.0, 20.0),
            ],
            vec![word("景观生态学认知", 202.0, 112.0, 20.0)],
            vec![
                word("彭建", 110.0, 151.0, 10.0),
                word("吕丹娜", 200.0, 151.0, 10.0),
            ],
            vec![
                word("摘要：", 83.0, 225.0, 10.0),
                word(
                    "新时期国土空间生态修复的核心是整体保护与系统治理。",
                    120.0,
                    225.0,
                    10.0,
                ),
            ],
        ])];

        let local = LocalEvidence::from_pages(&pages);
        assert_eq!(
            local.title.as_deref(),
            Some("过程耦合与空间集成：国土空间生态修复的景观生态学认知")
        );
        assert_eq!(local.doi.as_deref(), Some("10.31497/zrzyxb.20200102"));
    }

    #[test]
    fn local_title_joins_wrapped_latin_lines_with_spaces() {
        let pages = vec![page(vec![
            vec![
                word("Attention", 100.0, 60.0, 18.0),
                word("Is", 150.0, 60.0, 18.0),
            ],
            vec![
                word("All", 100.0, 84.0, 18.0),
                word("You", 130.0, 84.0, 18.0),
                word("Need", 160.0, 84.0, 18.0),
            ],
            vec![word("Abstract", 100.0, 140.0, 10.0)],
            vec![
                word("The", 100.0, 154.0, 10.0),
                word("dominant", 120.0, 154.0, 10.0),
                word("sequence", 170.0, 154.0, 10.0),
            ],
            vec![
                word("transduction", 100.0, 168.0, 10.0),
                word("models", 170.0, 168.0, 10.0),
                word("are", 200.0, 168.0, 10.0),
                word("based", 220.0, 168.0, 10.0),
                word("on", 250.0, 168.0, 10.0),
                word("complex", 265.0, 168.0, 10.0),
                word("recurrent", 300.0, 168.0, 10.0),
                word("or", 350.0, 168.0, 10.0),
                word("convolutional", 365.0, 168.0, 10.0),
                word("neural", 430.0, 168.0, 10.0),
                word("networks", 460.0, 168.0, 10.0),
            ],
        ])];

        let local = LocalEvidence::from_pages(&pages);
        assert_eq!(local.title.as_deref(), Some("Attention Is All You Need"));
    }

    #[test]
    fn local_title_ignores_a_large_url_masthead() {
        let pages = vec![page(vec![
            vec![word("https://www.jnr.ac.cn", 200.0, 20.0, 24.0)],
            vec![word("A Study Of Things", 100.0, 100.0, 20.0)],
            vec![word("Abstract", 100.0, 200.0, 10.0)],
            vec![
                word("Body", 100.0, 220.0, 10.0),
                word("text", 140.0, 220.0, 10.0),
                word("explains", 180.0, 220.0, 10.0),
                word("the", 240.0, 220.0, 10.0),
                word("result", 265.0, 220.0, 10.0),
                word("in", 310.0, 220.0, 10.0),
                word("enough", 325.0, 220.0, 10.0),
                word("detail", 375.0, 220.0, 10.0),
                word("for", 415.0, 220.0, 10.0),
                word("this", 435.0, 220.0, 10.0),
            ],
        ])];

        let local = LocalEvidence::from_pages(&pages);
        assert_eq!(local.title.as_deref(), Some("A Study Of Things"));
    }

    #[test]
    fn local_doi_requires_a_page_one_occurrence() {
        let pages = vec![page(vec![
            vec![
                word("Proceedings", 60.0, 40.0, 10.0),
                word("of", 130.0, 40.0, 10.0),
                word("Things", 145.0, 40.0, 10.0),
            ],
            vec![word("Body", 60.0, 200.0, 10.0)],
        ])];

        let local = LocalEvidence::from_pages(&pages);
        assert_eq!(local.doi, None);
    }

    #[test]
    fn local_title_fills_a_missing_recognizer_title_only() {
        let local = LocalEvidence {
            title: Some("过程耦合与空间集成".into()),
            doi: None,
        };
        let empty = with_local_title(PdfIdentProbe::no_match("paper2019.pdf"), &local);
        assert_eq!(empty.title.as_deref(), Some("过程耦合与空间集成"));
        assert_eq!(empty.status, "title");
        assert_eq!(empty.source, "local-pdf");

        let mut recognized = PdfIdentProbe::no_match("paper2019.pdf");
        recognized.title = Some("Recognizer Title".into());
        recognized.status = "ok".into();
        let kept = with_local_title(recognized, &local);
        assert_eq!(kept.title.as_deref(), Some("Recognizer Title"));
        assert_eq!(kept.status, "ok");
    }

    #[cfg(all(test, not(any(target_os = "ios", target_os = "android"))))]
    #[tokio::test]
    #[ignore = "manual: real PDF local evidence"]
    async fn local_evidence_live_pdf() {
        let Ok(pdf) = std::env::var("AGENTERO_LOCAL_EVIDENCE_PDF") else {
            return;
        };
        let pages =
            crate::features::paper::import::pdf_parse::run_liteparse_probe_direct(Path::new(&pdf))
                .await
                .expect("probe");
        let local = LocalEvidence::from_pages(&pages);
        println!("title={:?} doi={:?}", local.title, local.doi);
    }
}
