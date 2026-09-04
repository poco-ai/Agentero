//! MinerU remote layout engine (https://mineru.net) — an asynchronous batch
//! flow: `POST {base}/api/v4/file-urls/batch` (request a presigned upload
//! URL) → `PUT` the PDF bytes → poll
//! `GET {base}/api/v4/extract-results/batch/{batch_id}` → download the result
//! zip and read `*content_list.json` (0–1000 normalized boxes) plus the
//! intermediate result — `*middle.json` in older zips, `layout.json` in
//! cloud v4 — for per-page sizes.

use crate::core::error::AppError;
use crate::core::http;
use crate::features::import::CANCELLED_MESSAGE;
use crate::features::layout_remote::engine::{AnalyzeCtx, ProviderCredentials, RemoteLayoutEngine};
use crate::features::layout_remote::{
    emit_cloud_progress, LayoutRemoteAnalyzePdfResult, LayoutRemoteBox, LayoutRemotePageResult,
    LayoutRemoteProbeArgs, LayoutRemoteProbeResult,
};
use async_trait::async_trait;
use base64::Engine;
use reqwest::StatusCode;
use serde_json::{json, Value};
use std::io::Read;
use std::time::{Duration, Instant};

const MINERU_BASE_URL: &str = "https://mineru.net";
const MINERU_POLL_INTERVAL: Duration = Duration::from_secs(3);
const MINERU_JOB_DEADLINE: Duration = Duration::from_secs(600);
const MINERU_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
/// Document language sent when the user has not picked one. `ch` is also
/// MinerU's own default and covers Chinese (Simplified / Traditional) plus
/// English, which fits mixed-language papers.
const MINERU_DEFAULT_LANGUAGE: &str = "ch";
/// Per-request payload cap for the whole-PDF upload (base64 chars).
const MAX_PDF_BASE64_CHARS: usize = 96 * 1024 * 1024;
/// Untrusted result zip: cap the download and each decompressed JSON entry
/// to prevent zip-bomb OOM (same rationale as the sync gunzip caps).
const MAX_RESULT_ZIP_BYTES: usize = 256 * 1024 * 1024;
const MAX_JSON_ENTRY_BYTES: u64 = 128 * 1024 * 1024;

pub struct MineruEngine;

#[async_trait]
impl RemoteLayoutEngine for MineruEngine {
    fn id(&self) -> &'static str {
        "mineru"
    }

    async fn analyze_pdf(&self, ctx: AnalyzeCtx) -> Result<LayoutRemoteAnalyzePdfResult, AppError> {
        analyze_pdf(ctx).await
    }

    async fn probe(
        &self,
        credentials: &ProviderCredentials,
        args: LayoutRemoteProbeArgs,
    ) -> Result<LayoutRemoteProbeResult, AppError> {
        probe(credentials, args).await
    }
}

fn ensure_base_url_scheme(base: &str) -> Result<(), AppError> {
    if base.starts_with("https://") {
        return Ok(());
    }
    if let Some(rest) = base.strip_prefix("http://") {
        let authority = rest.split('/').next().unwrap_or("");
        let host = match authority.strip_prefix('[') {
            Some(v6) => v6.split(']').next().unwrap_or(""),
            None => authority.split(':').next().unwrap_or(""),
        };
        if matches!(host, "localhost" | "127.0.0.1" | "::1") {
            return Ok(());
        }
    }
    Err(AppError::message(
        "MinerU baseUrl must use https (plain http is allowed for loopback only)",
    ))
}

fn resolve_target(credentials: &ProviderCredentials) -> Result<(String, String), AppError> {
    let api_key = credentials
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .ok_or_else(|| {
            AppError::message("MinerU layout service requires apiKey (Settings → Layout)")
        })?
        .to_string();
    let base = credentials
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(MINERU_BASE_URL)
        .trim_end_matches('/')
        .to_string();
    ensure_base_url_scheme(&base)?;
    Ok((base, format!("Bearer {api_key}")))
}

/// MinerU top-level `code` may be a number (`0`, `-500`, `-10002`) or a
/// string (`"A0202"`); newer API versions use `msgCode` for auth errors.
/// Canonicalize for matching.
fn mineru_code(body: &Value) -> String {
    for key in ["code", "msgCode"] {
        match body.get(key) {
            Some(Value::Number(n)) => return n.to_string(),
            Some(Value::String(s)) => return s.trim().to_string(),
            _ => {}
        }
    }
    String::new()
}

fn mineru_msg(body: &Value) -> String {
    body.get("msg")
        .and_then(Value::as_str)
        .unwrap_or("unknown error")
        .to_string()
}

fn is_token_error_code(code: &str) -> bool {
    matches!(code, "A0202" | "A0211")
}

fn mineru_api_error(context: &str, body: &Value) -> AppError {
    let code = mineru_code(body);
    let msg = mineru_msg(body);
    if is_token_error_code(&code) {
        AppError::message(format!(
            "MinerU {context} failed: invalid API token ({code})"
        ))
    } else {
        AppError::message(format!("MinerU {context} failed ({code}): {msg}"))
    }
}

/// Poll-state classification for `extract_result[].state`.
#[derive(Debug, PartialEq, Eq)]
enum ExtractState {
    Done,
    Failed,
    InProgress,
}

fn classify_extract_state(state: &str) -> ExtractState {
    match state.trim().to_ascii_lowercase().as_str() {
        "done" => ExtractState::Done,
        "failed" => ExtractState::Failed,
        _ => ExtractState::InProgress,
    }
}

/// MinerU `content_list.json` types → the PP-StructureV3 label vocabulary the
/// frontend already understands (`layoutLabelToKind`). Unmapped types keep
/// their original string (dropped by the frontend, visible in raw dumps).
fn map_mineru_label(item_type: &str, text_level: Option<i64>) -> String {
    match item_type.trim().to_ascii_lowercase().as_str() {
        "text" => {
            if text_level.is_some_and(|l| l >= 1) {
                "paragraph_title".to_string()
            } else {
                "text".to_string()
            }
        }
        "title" => "paragraph_title".to_string(),
        "image" => "image".to_string(),
        "chart" => "chart".to_string(),
        "table" => "table".to_string(),
        "equation" | "interline_equation" => "formula".to_string(),
        "code" | "algorithm" => "algorithm".to_string(),
        "list" => "text".to_string(),
        "header" | "page_header" => "header".to_string(),
        "footer" | "page_footer" => "footer".to_string(),
        "footnote" | "page_footnote" => "footnote".to_string(),
        "ref_text" | "reference" => "reference".to_string(),
        other => other.to_string(),
    }
}

/// `middle.json` → per-page sizes from `pdf_info[].page_size` (`[w, h]`).
fn parse_middle_page_sizes(middle: &Value) -> Result<Vec<(f64, f64)>, AppError> {
    let pages = middle
        .get("pdf_info")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            AppError::message("MinerU result parse failed: middle.json missing pdf_info")
        })?;
    let mut sizes = Vec::with_capacity(pages.len());
    for page in pages {
        let size = page.get("page_size").and_then(Value::as_array);
        let (w, h) = match size {
            Some(s) if s.len() == 2 => (s[0].as_f64().unwrap_or(0.0), s[1].as_f64().unwrap_or(0.0)),
            _ => (0.0, 0.0),
        };
        sizes.push((w, h));
    }
    Ok(sizes)
}

/// Combine `content_list.json` (0–1000 normalized bboxes, top-left origin)
/// with the `middle.json` page sizes: `px = bbox / 1000 * page_size`. Every
/// page from middle.json is emitted so page indices stay aligned.
fn build_pages(
    content_list: &Value,
    page_sizes: &[(f64, f64)],
) -> Result<Vec<LayoutRemotePageResult>, AppError> {
    let items = content_list.as_array().ok_or_else(|| {
        AppError::message("MinerU result parse failed: content_list is not an array")
    })?;
    let mut pages: Vec<LayoutRemotePageResult> = page_sizes
        .iter()
        .map(|&(w, h)| LayoutRemotePageResult {
            boxes: Vec::new(),
            width_px: (w > 0.0).then(|| w.round() as u32),
            height_px: (h > 0.0).then(|| h.round() as u32),
        })
        .collect();
    for item in items {
        let Some(page_idx) = item.get("page_idx").and_then(Value::as_u64) else {
            continue;
        };
        let Some(page) = pages.get_mut(page_idx as usize) else {
            continue;
        };
        let Some(bbox) = item.get("bbox").and_then(Value::as_array) else {
            continue;
        };
        if bbox.len() != 4 {
            continue;
        }
        let nums: Vec<f64> = bbox.iter().filter_map(Value::as_f64).collect();
        if nums.len() != 4 {
            continue;
        }
        let (w, h) = page_sizes[page_idx as usize];
        if w <= 0.0 || h <= 0.0 {
            continue;
        }
        let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
        if item_type.is_empty() {
            continue;
        }
        let text_level = item.get("text_level").and_then(Value::as_i64);
        page.boxes.push(LayoutRemoteBox {
            cls_id: -1,
            label: map_mineru_label(item_type, text_level),
            // content_list carries no confidence; 1.0 passes the frontend
            // min-score gate without distorting relative ordering.
            score: 1.0,
            coordinate: [
                nums[0] / 1000.0 * w,
                nums[1] / 1000.0 * h,
                nums[2] / 1000.0 * w,
                nums[3] / 1000.0 * h,
            ],
        });
    }
    Ok(pages)
}

/// Find a zip entry by candidate names — an exact entry name match wins
/// first, then a name-suffix match (MinerU prefixes entries with the task
/// id). On miss, the error lists the actual entries so cloud-side naming
/// changes are diagnosable.
pub(crate) fn read_zip_entry_by_candidates(
    bytes: &[u8],
    candidates: &[&str],
) -> Result<String, AppError> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| AppError::message(format!("MinerU result zip open failed: {e}")))?;
    let mut index = None;
    for candidate in candidates {
        for i in 0..archive.len() {
            let entry = archive
                .by_index(i)
                .map_err(|e| AppError::message(format!("MinerU result zip entry failed: {e}")))?;
            if entry.name() == *candidate {
                index = Some(i);
                break;
            }
        }
        if index.is_none() {
            for i in 0..archive.len() {
                let entry = archive.by_index(i).map_err(|e| {
                    AppError::message(format!("MinerU result zip entry failed: {e}"))
                })?;
                if entry.name().ends_with(candidate) {
                    index = Some(i);
                    break;
                }
            }
        }
        if index.is_some() {
            break;
        }
    }
    let index = index.ok_or_else(|| {
        let names: Vec<String> = (0..archive.len())
            .filter_map(|i| archive.by_index(i).ok().map(|e| e.name().to_string()))
            .collect();
        AppError::message(format!(
            "MinerU result zip missing {:?} entry (entries: {})",
            candidates,
            names.join(", ")
        ))
    })?;
    let entry = archive
        .by_index(index)
        .map_err(|e| AppError::message(format!("MinerU result zip entry failed: {e}")))?;
    let mut text = String::new();
    entry
        .take(MAX_JSON_ENTRY_BYTES + 1)
        .read_to_string(&mut text)
        .map_err(|e| AppError::message(format!("MinerU result zip read failed: {e}")))?;
    if text.len() as u64 > MAX_JSON_ENTRY_BYTES {
        return Err(AppError::message(format!(
            "MinerU result zip entry {:?} too large",
            candidates
        )));
    }
    Ok(text)
}

/// Intermediate-result entry names: `*_middle.json` / `middle.json` in older
/// zips, `layout.json` in cloud v4 (same `pdf_info[].page_size` schema).
const MIDDLE_CANDIDATES: &[&str] = &["middle.json", "layout.json"];

fn parse_result_zip(bytes: &[u8]) -> Result<LayoutRemoteAnalyzePdfResult, AppError> {
    let content_list_text = read_zip_entry_by_candidates(bytes, &["content_list.json"])?;
    let middle_text = read_zip_entry_by_candidates(bytes, MIDDLE_CANDIDATES)?;
    let content_list: Value = serde_json::from_str(&content_list_text)
        .map_err(|e| AppError::message(format!("MinerU result parse failed: content_list: {e}")))?;
    let middle: Value = serde_json::from_str(&middle_text)
        .map_err(|e| AppError::message(format!("MinerU result parse failed: middle: {e}")))?;
    let page_sizes = parse_middle_page_sizes(&middle)?;
    let pages = build_pages(&content_list, &page_sizes)?;
    let rendered_pages = page_sizes
        .iter()
        .map(|&(w, h)| (w.round() as u32, h.round() as u32))
        .collect();
    Ok(LayoutRemoteAnalyzePdfResult {
        pages,
        rendered_pages,
    })
}

/// Request one presigned upload URL; returns `(batch_id, upload_url)`.
/// `language` selects the OCR language pack; `is_ocr` forces OCR even when
/// the PDF carries a text layer (scanned-document option).
async fn request_upload_url(
    client: &reqwest::Client,
    base: &str,
    auth: &str,
    file_name: &str,
    language: &str,
    is_ocr: bool,
) -> Result<(String, String), AppError> {
    let body = json!({
        "files": [{ "name": file_name, "is_ocr": is_ocr }],
        "language": language,
        "model_version": "vlm",
        "enable_formula": true,
        "enable_table": true,
    });
    let response = client
        .post(format!("{base}/api/v4/file-urls/batch"))
        .header("Authorization", auth)
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::message(format!("MinerU batch submit failed: {e}")))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| AppError::message(format!("MinerU response read failed: {e}")))?;
    let value: Value = serde_json::from_str(&text).map_err(|_| {
        let snippet = http::http_err_snippet(&text);
        AppError::message(format!(
            "MinerU batch submit failed (HTTP {status}): {snippet}"
        ))
    })?;
    if mineru_code(&value) != "0" {
        return Err(mineru_api_error("batch submit", &value));
    }
    let data = value.get("data").cloned().unwrap_or_default();
    let batch_id = data
        .get("batch_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| AppError::message("Unexpected MinerU response: missing batch_id"))?;
    let upload_url = data
        .get("file_urls")
        .and_then(Value::as_array)
        .and_then(|urls| urls.first())
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| AppError::message("Unexpected MinerU response: missing file_urls"))?;
    Ok((batch_id, upload_url))
}

async fn analyze_pdf(ctx: AnalyzeCtx) -> Result<LayoutRemoteAnalyzePdfResult, AppError> {
    let AnalyzeCtx {
        app,
        credentials,
        args,
    } = ctx;
    if args.pdf_base64.trim().is_empty() {
        return Err(AppError::message("layout_remote: PDF is empty"));
    }
    if args.pdf_base64.len() > MAX_PDF_BASE64_CHARS {
        return Err(AppError::message("layout_remote: PDF too large"));
    }
    let pdf_bytes = base64::engine::general_purpose::STANDARD
        .decode(args.pdf_base64.trim())
        .map_err(|e| AppError::message(format!("layout_remote: invalid PDF base64: {e}")))?;

    let request_id = args.request_id.clone();
    let emit_progress = move |phase: &str, extracted: Option<u64>, total: Option<u64>| {
        emit_cloud_progress(&app, phase, extracted, total, request_id.clone());
    };
    let file_name = args
        .file_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("paper.pdf")
        .to_string();

    let zip_bytes =
        run_mineru_extract(&credentials, pdf_bytes, &file_name, &emit_progress, &|| {
            false
        })
        .await?;

    // Extract content_list.json + middle.json and map to page boxes.
    let result = parse_result_zip(&zip_bytes)?;
    log::info!(
        target: "agentero::layout_remote",
        "mineru result: pages={} boxes={}",
        result.pages.len(),
        result.pages.iter().map(|p| p.boxes.len()).sum::<usize>()
    );
    Ok(result)
}

/// Whole-document MinerU extract: presigned upload → poll → download the
/// result zip. Shared by the layout analyze path and the PAPER.md body-parse
/// engine (which reads `full.md` from the same zip).
pub(crate) async fn run_mineru_extract(
    credentials: &ProviderCredentials,
    pdf_bytes: Vec<u8>,
    file_name: &str,
    progress: super::ProgressFn<'_>,
    cancel: super::CancelFn<'_>,
) -> Result<Vec<u8>, AppError> {
    let (base, auth) = resolve_target(credentials)?;
    let client = http::client(MINERU_REQUEST_TIMEOUT)?;

    // 1) Request the presigned upload URL, then PUT the raw PDF bytes
    //    (no Content-Type — the presigned signature does not cover one).
    progress("uploading", None, None);
    let language = credentials
        .language
        .as_deref()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .unwrap_or(MINERU_DEFAULT_LANGUAGE);
    let (batch_id, upload_url) = request_upload_url(
        &client,
        &base,
        &auth,
        file_name,
        language,
        credentials.is_ocr,
    )
    .await?;
    let upload = client
        .put(&upload_url)
        .body(pdf_bytes)
        .send()
        .await
        .map_err(|e| AppError::message(format!("MinerU upload failed: {e}")))?;
    let upload_status = upload.status();
    if !upload_status.is_success() {
        return Err(AppError::message(format!(
            "MinerU upload failed (HTTP {upload_status})"
        )));
    }

    // 2) Poll until done (deadline guards a stuck task).
    let poll_url = format!("{base}/api/v4/extract-results/batch/{batch_id}");
    let started = Instant::now();
    let zip_url = loop {
        if cancel() {
            return Err(AppError::message(CANCELLED_MESSAGE));
        }
        if started.elapsed() > MINERU_JOB_DEADLINE {
            return Err(AppError::message("MinerU task timed out"));
        }
        tokio::time::sleep(MINERU_POLL_INTERVAL).await;
        let poll = client
            .get(&poll_url)
            .header("Authorization", &auth)
            .send()
            .await
            .map_err(|e| AppError::message(format!("MinerU task poll failed: {e}")))?;
        let poll_status = poll.status();
        let poll_text = poll
            .text()
            .await
            .map_err(|e| AppError::message(format!("MinerU poll read failed: {e}")))?;
        let poll_value: Value = serde_json::from_str(&poll_text).map_err(|_| {
            let snippet = http::http_err_snippet(&poll_text);
            AppError::message(format!(
                "MinerU task poll failed (HTTP {poll_status}): {snippet}"
            ))
        })?;
        if mineru_code(&poll_value) != "0" {
            return Err(mineru_api_error("task poll", &poll_value));
        }
        let result = poll_value
            .get("data")
            .and_then(|d| d.get("extract_result"))
            .and_then(Value::as_array)
            .and_then(|r| {
                r.iter()
                    .find(|e| e.get("file_name").and_then(Value::as_str) == Some(file_name))
                    .or_else(|| r.first())
            })
            .cloned()
            .unwrap_or_default();
        let state = result
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let extract_progress = result.get("extract_progress");
        let extracted = extract_progress
            .and_then(|p| p.get("extracted_pages"))
            .and_then(Value::as_u64);
        let total = extract_progress
            .and_then(|p| p.get("total_pages"))
            .and_then(Value::as_u64);
        match classify_extract_state(&state) {
            ExtractState::Done => {
                let url = result
                    .get("full_zip_url")
                    .and_then(Value::as_str)
                    .ok_or_else(|| AppError::message("MinerU task done without result URL"))?
                    .to_string();
                progress("done", extracted, total);
                break url;
            }
            ExtractState::Failed => {
                let msg = result
                    .get("err_msg")
                    .and_then(Value::as_str)
                    .filter(|m| !m.trim().is_empty())
                    .unwrap_or("unknown error");
                return Err(AppError::message(format!("MinerU task failed: {msg}")));
            }
            ExtractState::InProgress => progress(&state, extracted, total),
        }
    };

    // 3) Download the result zip (presigned URL, no auth header).
    progress("downloading", None, None);
    let zip_response = client
        .get(&zip_url)
        .send()
        .await
        .map_err(|e| AppError::message(format!("MinerU result download failed: {e}")))?;
    let zip_status = zip_response.status();
    if !zip_status.is_success() {
        return Err(AppError::message(format!(
            "MinerU result download failed (HTTP {zip_status})"
        )));
    }
    let mut zip_bytes: Vec<u8> = Vec::new();
    let mut zip_response = zip_response;
    while let Some(chunk) = zip_response
        .chunk()
        .await
        .map_err(|e| AppError::message(format!("MinerU result read failed: {e}")))?
    {
        if zip_bytes.len() + chunk.len() > MAX_RESULT_ZIP_BYTES {
            return Err(AppError::message("MinerU result zip too large"));
        }
        zip_bytes.extend_from_slice(&chunk);
    }
    Ok(zip_bytes)
}

/// Probe outcome for the settings connectivity check.
/// A non-auth business response (currently `-10002 file list is empty`)
/// proves the token was authenticated; token error codes or HTTP 401 do not.
fn probe_token_valid(body: &Value, status: StatusCode) -> bool {
    !is_token_error_code(&mineru_code(body)) && status != StatusCode::UNAUTHORIZED
}

/// Connectivity probe: send a minimal (invalid-params) batch request; a
/// parameter error proves the token was accepted, a token error code does
/// not. Runs in the Host so it is not subject to WebView CORS and honors
/// the app proxy. The probe image is unused — MinerU has no image endpoint.
async fn probe(
    credentials: &ProviderCredentials,
    _args: LayoutRemoteProbeArgs,
) -> Result<LayoutRemoteProbeResult, AppError> {
    let (base, auth) = resolve_target(credentials)?;
    let client = http::client(Duration::from_secs(30))?;
    let response = client
        .post(format!("{base}/api/v4/file-urls/batch"))
        .header("Authorization", &auth)
        .json(&json!({ "files": [] }))
        .send()
        .await
        .map_err(|e| AppError::message(format!("MinerU probe failed: {e}")))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| AppError::message(format!("MinerU probe read failed: {e}")))?;
    let value: Value = serde_json::from_str(&text).map_err(|_| {
        let snippet = http::http_err_snippet(&text);
        AppError::message(format!("MinerU probe failed (HTTP {status}): {snippet}"))
    })?;
    if probe_token_valid(&value, status) {
        let job_id = ["traceId", "trace_id"]
            .iter()
            .find_map(|k| value.get(*k).and_then(Value::as_str))
            .unwrap_or("mineru-probe-ok")
            .to_string();
        Ok(LayoutRemoteProbeResult { job_id })
    } else {
        let code = mineru_code(&value);
        Err(AppError::message(format!(
            "MinerU probe failed: invalid API token ({code})"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_mineru_types_to_paddle_labels() {
        assert_eq!(map_mineru_label("text", None), "text");
        assert_eq!(map_mineru_label("text", Some(0)), "text");
        assert_eq!(map_mineru_label("text", Some(1)), "paragraph_title");
        assert_eq!(map_mineru_label("text", Some(2)), "paragraph_title");
        assert_eq!(map_mineru_label("title", None), "paragraph_title");
        assert_eq!(map_mineru_label("image", None), "image");
        assert_eq!(map_mineru_label("chart", None), "chart");
        assert_eq!(map_mineru_label("table", None), "table");
        assert_eq!(map_mineru_label("equation", None), "formula");
        assert_eq!(map_mineru_label("interline_equation", None), "formula");
        assert_eq!(map_mineru_label("code", None), "algorithm");
        assert_eq!(map_mineru_label("list", None), "text");
        assert_eq!(map_mineru_label("header", None), "header");
        assert_eq!(map_mineru_label("footer", None), "footer");
        assert_eq!(map_mineru_label("discarded", None), "discarded");
    }

    #[test]
    fn builds_pages_from_content_list_and_middle() {
        let middle: Value = serde_json::from_str(
            r#"{"pdf_info":[{"page_size":[612.0,792.0]},{"page_size":[612.0,792.0]}]}"#,
        )
        .unwrap();
        let content_list: Value = serde_json::from_str(
            r#"[
                {"type":"text","page_idx":0,"bbox":[100,200,500,300],"text":"body"},
                {"type":"text","text_level":1,"page_idx":0,"bbox":[100,50,500,90],"text":"1 Intro"},
                {"type":"image","page_idx":1,"bbox":[0,0,1000,500]},
                {"type":"table","page_idx":5,"bbox":[0,0,10,10]},
                {"type":"text","page_idx":1,"bbox":[0,0,10]},
                {"page_idx":1,"bbox":[0,0,10,10]}
            ]"#,
        )
        .unwrap();
        let sizes = parse_middle_page_sizes(&middle).unwrap();
        assert_eq!(sizes, vec![(612.0, 792.0), (612.0, 792.0)]);
        let pages = build_pages(&content_list, &sizes).unwrap();
        assert_eq!(pages.len(), 2);
        assert_eq!(pages[0].width_px, Some(612));
        assert_eq!(pages[0].height_px, Some(792));
        assert_eq!(pages[0].boxes.len(), 2);
        let body = &pages[0].boxes[0];
        assert_eq!(body.label, "text");
        assert_eq!(body.score, 1.0);
        // 0–1000 → page px: x = 100/1000*612 = 61.2, y = 200/1000*792 = 158.4.
        assert!((body.coordinate[0] - 61.2).abs() < 1e-9);
        assert!((body.coordinate[1] - 158.4).abs() < 1e-9);
        assert!((body.coordinate[2] - 306.0).abs() < 1e-9);
        assert!((body.coordinate[3] - 237.6).abs() < 1e-9);
        assert_eq!(pages[0].boxes[1].label, "paragraph_title");
        // Page 1: full-width image, half height.
        assert_eq!(pages[1].boxes.len(), 1);
        assert_eq!(pages[1].boxes[0].label, "image");
        assert!((pages[1].boxes[0].coordinate[2] - 612.0).abs() < 1e-9);
        assert!((pages[1].boxes[0].coordinate[3] - 396.0).abs() < 1e-9);
    }

    #[test]
    fn parses_result_zip_entries_by_suffix() {
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            let opts = SimpleFileOptions::default();
            writer.start_file("abc123_content_list.json", opts).unwrap();
            writer
                .write_all(br#"[{"type":"table","page_idx":0,"bbox":[100,100,900,900]}]"#)
                .unwrap();
            writer.start_file("abc123_middle.json", opts).unwrap();
            writer
                .write_all(br#"{"pdf_info":[{"page_size":[1000.0,2000.0]}]}"#)
                .unwrap();
            writer.finish().unwrap();
        }
        let result = parse_result_zip(cursor.get_ref()).unwrap();
        assert_eq!(result.pages.len(), 1);
        assert_eq!(result.rendered_pages, vec![(1000, 2000)]);
        let boxes = &result.pages[0].boxes;
        assert_eq!(boxes.len(), 1);
        assert_eq!(boxes[0].label, "table");
        assert_eq!(boxes[0].coordinate, [100.0, 200.0, 900.0, 1800.0]);
    }

    #[test]
    fn parses_result_zip_with_cloud_v4_layout_json() {
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        // Mirrors a real cloud v4 VLM result zip: the intermediate result is
        // `layout.json` (no task-id prefix) and there is no `*middle.json`.
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            let opts = SimpleFileOptions::default();
            writer.start_file("abc123_model.json", opts).unwrap();
            writer.write_all(b"{}").unwrap();
            writer.start_file("full.md", opts).unwrap();
            writer.write_all(b"# md").unwrap();
            writer.start_file("layout.json", opts).unwrap();
            writer
                .write_all(br#"{"pdf_info":[{"page_size":[1000.0,2000.0]}]}"#)
                .unwrap();
            writer.start_file("abc123_content_list.json", opts).unwrap();
            writer
                .write_all(br#"[{"type":"table","page_idx":0,"bbox":[100,100,900,900]}]"#)
                .unwrap();
            writer
                .start_file("abc123_content_list_v2.json", opts)
                .unwrap();
            writer.write_all(b"[]").unwrap();
            writer.finish().unwrap();
        }
        let result = parse_result_zip(cursor.get_ref()).unwrap();
        assert_eq!(result.pages.len(), 1);
        assert_eq!(result.rendered_pages, vec![(1000, 2000)]);
        let boxes = &result.pages[0].boxes;
        assert_eq!(boxes.len(), 1);
        assert_eq!(boxes[0].label, "table");
        assert_eq!(boxes[0].coordinate, [100.0, 200.0, 900.0, 1800.0]);
    }

    #[test]
    fn missing_middle_error_lists_zip_entries() {
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            let opts = SimpleFileOptions::default();
            writer.start_file("abc123_content_list.json", opts).unwrap();
            writer.write_all(b"[]").unwrap();
            writer.start_file("full.md", opts).unwrap();
            writer.write_all(b"# md").unwrap();
            writer.finish().unwrap();
        }
        let err = parse_result_zip(cursor.get_ref()).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("abc123_content_list.json"), "{msg}");
        assert!(msg.contains("full.md"), "{msg}");
    }

    #[test]
    fn classifies_extract_states() {
        assert_eq!(classify_extract_state("done"), ExtractState::Done);
        assert_eq!(classify_extract_state("failed"), ExtractState::Failed);
        for s in ["waiting-file", "pending", "running", "converting", ""] {
            assert_eq!(classify_extract_state(s), ExtractState::InProgress);
        }
    }

    #[test]
    fn classifies_probe_responses() {
        let ok = StatusCode::OK;
        let unauthorized = StatusCode::UNAUTHORIZED;
        let param_err: Value =
            serde_json::from_str(r#"{"code":-10002,"msg":"file list is empty"}"#).unwrap();
        assert!(probe_token_valid(&param_err, ok));
        let success: Value = serde_json::from_str(r#"{"code":0,"msg":"ok"}"#).unwrap();
        assert!(probe_token_valid(&success, ok));
        let bad_token: Value =
            serde_json::from_str(r#"{"code":"A0202","msg":"Token 错误"}"#).unwrap();
        assert!(!probe_token_valid(&bad_token, ok));
        let expired: Value =
            serde_json::from_str(r#"{"code":"A0211","msg":"Token 已过期"}"#).unwrap();
        assert!(!probe_token_valid(&expired, ok));
        // Newer API returns `msgCode` with HTTP 401 for auth failures.
        let msg_code: Value = serde_json::from_str(
            r#"{"traceId":"a","msgCode":"A0211","msg":"user token expired","success":false}"#,
        )
        .unwrap();
        assert!(!probe_token_valid(&msg_code, unauthorized));
        let bare_401: Value = serde_json::from_str(r#"{"success":false}"#).unwrap();
        assert!(!probe_token_valid(&bare_401, unauthorized));
    }
}
