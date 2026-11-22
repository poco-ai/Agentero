//! Paddle remote layout engine: the AI Studio hosted PP-StructureV3 OCR
//! service — an asynchronous whole-document job:
//! `POST {base}/api/v2/ocr/jobs` (multipart PDF upload) → poll
//! `GET {base}/api/v2/ocr/jobs/{jobId}` → download the JSONL result.

use crate::error::AppError;
use crate::features::paper::analyze::layout::hosted::engine::{
    HostedLayoutAnalyzer, HostedProviderCredentials, LayoutAnalyzeContext,
};
use crate::features::paper::analyze::layout::hosted::{
    emit_cloud_progress, parse_det_boxes, LayoutRemoteAnalyzePdfResult, LayoutRemotePageResult,
    LayoutRemoteProbeArgs, LayoutRemoteProbeResult,
};
use crate::features::paper::import::CANCELLED_MESSAGE;
use crate::http;
use async_trait::async_trait;
use base64::Engine;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

/// Fixed AI Studio PaddleOCR jobs endpoint (not configurable).
const CLOUD_JOBS_URL: &str = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs";
/// Layout-analysis model: the only one that returns `layout_det_res` boxes.
const CLOUD_MODEL: &str = "PP-StructureV3";
const CLOUD_POLL_INTERVAL: Duration = Duration::from_secs(3);
const CLOUD_JOB_DEADLINE: Duration = Duration::from_secs(600);
const CLOUD_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

pub struct PaddleEngine;

#[async_trait]
impl HostedLayoutAnalyzer for PaddleEngine {
    fn id(&self) -> &'static str {
        "paddle"
    }

    async fn analyze_pdf(
        &self,
        ctx: LayoutAnalyzeContext,
    ) -> Result<LayoutRemoteAnalyzePdfResult, AppError> {
        analyze_pdf(ctx).await
    }

    async fn probe(
        &self,
        credentials: &HostedProviderCredentials,
        args: LayoutRemoteProbeArgs,
    ) -> Result<LayoutRemoteProbeResult, AppError> {
        probe(credentials, args).await
    }
}

/// Decode a base64 JPEG and read its SOF dimensions (best effort).
fn jpeg_dimensions_base64(b64: &str) -> Option<(u32, u32)> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .ok()?;
    let mut i = 2; // skip SOI
    while i + 4 < bytes.len() {
        if bytes[i] != 0xFF {
            return None;
        }
        let marker = bytes[i + 1];
        // SOF0–SOF15 except DHT/JPG/DAC.
        if (0xC0..=0xCF).contains(&marker) && !matches!(marker, 0xC4 | 0xC8 | 0xCC) {
            if i + 9 < bytes.len() {
                let height = u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]) as u32;
                let width = u16::from_be_bytes([bytes[i + 7], bytes[i + 8]]) as u32;
                if width > 0 && height > 0 {
                    return Some((width, height));
                }
            }
            return None;
        }
        if marker == 0xD9 {
            return None; // EOI
        }
        // Standalone markers (RST*, SOI, EOI) carry no length.
        if marker == 0xD8 || (0xD0..=0xD7).contains(&marker) {
            i += 2;
            continue;
        }
        let len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
        if len < 2 {
            return None;
        }
        i += 2 + len;
    }
    None
}

/// Best-effort rendered-page size: the matching `dataInfo.pages[]` entry,
/// else the inline `inputImage` JPEG header. The `&'static str` names the
/// source (`"none"` → frontend must assume a render DPI).
fn page_rendered_size(
    page: &Value,
    data_info: Option<&Value>,
    rendered_pages: &[(u32, u32)],
    page_index: usize,
) -> (Option<u32>, Option<u32>, &'static str) {
    if let Some(&(w, h)) = rendered_pages.get(page_index) {
        if w > 0 && h > 0 {
            return (Some(w), Some(h), "dataInfo");
        }
    }
    // Legacy / alternate shapes: width & height directly on dataInfo.
    if let Some(info) = data_info {
        let width = info
            .get("width")
            .or_else(|| info.get("pageWidth"))
            .or_else(|| info.get("imageWidth"))
            .and_then(Value::as_u64);
        let height = info
            .get("height")
            .or_else(|| info.get("pageHeight"))
            .or_else(|| info.get("imageHeight"))
            .and_then(Value::as_u64);
        if let (Some(w), Some(h)) = (width, height) {
            if w > 0 && h > 0 {
                return (Some(w as u32), Some(h as u32), "dataInfo");
            }
        }
    }
    if let Some(b64) = page.get("inputImage").and_then(Value::as_str) {
        if let Some((w, h)) = jpeg_dimensions_base64(b64) {
            return (Some(w), Some(h), "inputImage");
        }
    }
    (None, None, "none")
}

/// Parse `dataInfo.pages` → per-page rendered pixel sizes.
fn parse_rendered_pages(data_info: Option<&Value>) -> Vec<(u32, u32)> {
    let Some(pages) = data_info
        .and_then(|d| d.get("pages"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    pages
        .iter()
        .map(|p| {
            let w = p.get("width").and_then(Value::as_u64).unwrap_or(0) as u32;
            let h = p.get("height").and_then(Value::as_u64).unwrap_or(0) as u32;
            (w, h)
        })
        .collect()
}

fn parse_cloud_page(
    page: &Value,
    data_info: Option<&Value>,
    rendered_pages: &[(u32, u32)],
    page_index: usize,
) -> (LayoutRemotePageResult, &'static str) {
    let boxes = page
        .get("prunedResult")
        .and_then(|p| p.get("layout_det_res"))
        .and_then(|d| d.get("boxes"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let (width_px, height_px, source) =
        page_rendered_size(page, data_info, rendered_pages, page_index);
    (
        LayoutRemotePageResult {
            boxes: parse_det_boxes(&boxes),
            width_px,
            height_px,
        },
        source,
    )
}

/// Why a Paddle cloud job runs: the callers read different parts of the JSONL
/// result, so they must ask the server for different pipelines.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaddleJobPurpose {
    /// PAPER.md body parsing: needs the markdown pipeline (`markdown.text`,
    /// with `prunedResult.parsing_res_list[].block_content` as the fallback),
    /// so all recognizers and block-content formatting stay enabled.
    BodyParse,
    /// Figure/layout boxes: only `prunedResult.layout_det_res.boxes` is read.
    Layout,
}

impl PaddleJobPurpose {
    fn optional_payload(self) -> String {
        match self {
            Self::BodyParse => body_parse_optional_payload(),
            Self::Layout => layout_optional_payload(),
        }
    }
}

/// `optionalPayload` for body parsing: the historical preset. It keeps the
/// markdown pipeline intact — only the document-prep stages we never need are
/// disabled, so `markdown.text` and the `block_content` fallback still arrive.
fn body_parse_optional_payload() -> String {
    json!({
        "useDocOrientationClassify": false,
        "useDocUnwarping": false,
        "useChartRecognition": false,
    })
    .to_string()
}

/// `optionalPayload` for the layout path: disable every sub-pipeline whose
/// output we never read.
///
/// The layout path only consumes `prunedResult.layout_det_res.boxes` (see
/// [`parse_cloud_page`]), so doc orientation, unwarping, chart/table/formula/
/// seal/textline recognition, region detection and block-content formatting
/// only add server latency — the layout path is slow because they all run
/// (issue #1153, root cause 1). `useLayoutDetection` deliberately stays enabled:
/// the boxes we return come from it. `visualize` also stays untouched because
/// [`page_rendered_size`] falls back to the inline `inputImage` JPEG header.
fn layout_optional_payload() -> String {
    json!({
        "useDocOrientationClassify": false,
        "useDocUnwarping": false,
        "useChartRecognition": false,
        "useTableRecognition": false,
        "useFormulaRecognition": false,
        "useSealRecognition": false,
        "useTextlineOrientation": false,
        "useRegionDetection": false,
        "formatBlockContent": false,
    })
    .to_string()
}

/// Submit one OCR job (multipart file upload) and return the job id.
#[allow(clippy::too_many_arguments)]
async fn submit_job(
    client: &reqwest::Client,
    jobs_url: &str,
    auth: &str,
    file_bytes: Vec<u8>,
    file_name: String,
    mime: &str,
    model: &str,
    purpose: PaddleJobPurpose,
) -> Result<String, AppError> {
    let form = reqwest::multipart::Form::new()
        .part(
            "file",
            reqwest::multipart::Part::bytes(file_bytes)
                .file_name(file_name)
                .mime_str(mime)
                .map_err(|e| AppError::message(format!("layout_remote: multipart: {e}")))?,
        )
        .text("model", model.to_string())
        .text("optionalPayload", purpose.optional_payload());
    let response = client
        .post(jobs_url)
        .header("Authorization", auth)
        .multipart(form)
        .send()
        .await
        .map_err(|e| AppError::message(format!("Paddle job submit failed: {e}")))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| AppError::message(format!("Paddle response read failed: {e}")))?;
    if !status.is_success() {
        let snippet = http::http_err_snippet(&text);
        return Err(AppError::message(format!(
            "Paddle job submit failed (HTTP {status}): {snippet}"
        )));
    }
    let created: Value = serde_json::from_str(&text)
        .map_err(|e| AppError::message(format!("Unexpected Paddle response: {e}")))?;
    created
        .get("data")
        .and_then(|d| d.get("jobId"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| AppError::message("Unexpected Paddle response: missing jobId"))
}

fn resolve_cloud_target(api_key: Option<&str>) -> Result<(String, String), AppError> {
    let api_key = api_key
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .ok_or_else(|| {
            AppError::message("Paddle layout service requires apiKey (Settings → Layout)")
        })?
        .to_string();
    Ok((CLOUD_JOBS_URL.to_string(), format!("bearer {api_key}")))
}

/// Whole-document PP-StructureV3 job: multipart upload → poll → download the
/// JSONL result. Shared by the layout analyze path and the PAPER.md body-parse
/// engine (which reads per-page markdown from the same JSONL). `purpose` picks
/// the `optionalPayload`: body parsing keeps the full markdown pipeline, while
/// layout analysis disables the sub-pipelines it never reads (#1153). Returns
/// the raw JSONL text plus the job-level `dataInfo` (rendered page sizes).
#[allow(clippy::too_many_arguments)]
pub async fn run_paddle_ocr_job(
    api_key: Option<&str>,
    file_bytes: Vec<u8>,
    file_name: String,
    mime: &str,
    model: &str,
    purpose: PaddleJobPurpose,
    progress: super::ProgressFn<'_>,
    cancel: super::CancelFn<'_>,
) -> Result<(String, Option<Value>), AppError> {
    let (jobs_url, auth) = resolve_cloud_target(api_key)?;
    let client = http::client(CLOUD_REQUEST_TIMEOUT)?;

    // 1) Submit the whole-document job (multipart file upload).
    progress("uploading", None, None);
    let job_id = submit_job(
        &client, &jobs_url, &auth, file_bytes, file_name, mime, model, purpose,
    )
    .await?;

    // 2) Poll until done (deadline guards a stuck job).
    let job_url = format!("{}/{}", jobs_url.trim_end_matches('/'), job_id);
    let started = Instant::now();
    let (json_url, data_info) = loop {
        if cancel() {
            return Err(AppError::message(CANCELLED_MESSAGE));
        }
        if started.elapsed() > CLOUD_JOB_DEADLINE {
            return Err(AppError::message("Paddle job timed out"));
        }
        tokio::time::sleep(CLOUD_POLL_INTERVAL).await;
        let poll = client
            .get(&job_url)
            .header("Authorization", &auth)
            .send()
            .await
            .map_err(|e| AppError::message(format!("Paddle job poll failed: {e}")))?;
        let poll_status = poll.status();
        let poll_text = poll
            .text()
            .await
            .map_err(|e| AppError::message(format!("Paddle poll read failed: {e}")))?;
        if !poll_status.is_success() {
            let snippet = http::http_err_snippet(&poll_text);
            return Err(AppError::message(format!(
                "Paddle job poll failed (HTTP {poll_status}): {snippet}"
            )));
        }
        let poll_value: Value = serde_json::from_str(&poll_text)
            .map_err(|e| AppError::message(format!("Unexpected Paddle poll response: {e}")))?;
        let data = poll_value.get("data").cloned().unwrap_or_default();
        let state = data
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let extract_progress = data.get("extractProgress");
        let extracted = extract_progress
            .and_then(|p| p.get("extractedPages"))
            .and_then(Value::as_u64);
        let total = extract_progress
            .and_then(|p| p.get("totalPages"))
            .and_then(Value::as_u64);
        match state.as_str() {
            "done" => {
                let url = data
                    .get("resultUrl")
                    .and_then(|r| r.get("jsonUrl"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| AppError::message("Paddle job done without result URL"))?
                    .to_string();
                progress("done", extracted, total);
                break (url, data.get("dataInfo").cloned());
            }
            "failed" => {
                let msg = data
                    .get("errorMsg")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown error");
                return Err(AppError::message(format!("Paddle job failed: {msg}")));
            }
            _ => progress(&state, extracted, total),
        }
    };

    // 3) Download the JSONL result; each line carries page results.
    progress("downloading", None, None);
    let result_response = client
        .get(&json_url)
        .send()
        .await
        .map_err(|e| AppError::message(format!("Paddle result download failed: {e}")))?;
    let result_status = result_response.status();
    let result_text = result_response
        .text()
        .await
        .map_err(|e| AppError::message(format!("Paddle result read failed: {e}")))?;
    if !result_status.is_success() {
        return Err(AppError::message(format!(
            "Paddle result download failed (HTTP {result_status})"
        )));
    }

    // Keep the raw JSONL for diagnosis (scale/field issues), but only on demand:
    // a long PDF makes this a large file. Set `AGENTERO_PADDLE_DUMP` to opt in.
    if std::env::var_os("AGENTERO_PADDLE_DUMP").is_some() {
        let debug_path = crate::paths::agentero_cache_dir().join("paddle-last-result.jsonl");
        if let Some(parent) = debug_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Err(e) = std::fs::write(&debug_path, result_text.as_bytes()) {
            log::warn!(target: "agentero::layout::hosted", "failed to write {debug_path:?}: {e}");
        } else {
            log::info!(target: "agentero::layout::hosted", "raw cloud result saved to {debug_path:?}");
        }
    } else {
        log::debug!(
            target: "agentero::layout::hosted",
            "raw cloud result kept in memory only ({} bytes; set AGENTERO_PADDLE_DUMP=1 to save it)",
            result_text.len()
        );
    }

    Ok((result_text, data_info))
}

async fn analyze_pdf(ctx: LayoutAnalyzeContext) -> Result<LayoutRemoteAnalyzePdfResult, AppError> {
    let LayoutAnalyzeContext {
        app,
        credentials,
        args,
    } = ctx;
    let (pdf_bytes, file_name) =
        super::prepare_pdf_upload(&args.pdf_base64, args.file_name.as_deref())?;

    let request_id = args.request_id.clone();
    let emit_progress = move |phase: &str, extracted: Option<u64>, total: Option<u64>| {
        emit_cloud_progress(&app, phase, extracted, total, request_id.clone());
    };

    let (result_text, data_info) = run_paddle_ocr_job(
        credentials.api_key.as_deref(),
        pdf_bytes,
        file_name,
        "application/pdf",
        CLOUD_MODEL,
        PaddleJobPurpose::Layout,
        &emit_progress,
        &|| false,
    )
    .await?;

    let mut pages: Vec<LayoutRemotePageResult> = Vec::new();
    let mut dim_sources: Vec<&'static str> = Vec::new();
    let mut unknown_diag: Option<String> = None;
    // `dataInfo.pages` covers the whole document; take the first occurrence.
    let mut rendered_pages: Vec<(u32, u32)> = Vec::new();
    for line in result_text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(line_value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let result = line_value
            .get("result")
            .cloned()
            .unwrap_or_else(|| line_value.clone());
        let Some(results) = result.get("layoutParsingResults").and_then(Value::as_array) else {
            continue;
        };
        let info = result.get("dataInfo").or(data_info.as_ref()).cloned();
        if rendered_pages.is_empty() {
            rendered_pages = parse_rendered_pages(info.as_ref());
        }
        for page in results {
            let page_index = pages.len();
            let (parsed, source) =
                parse_cloud_page(page, info.as_ref(), &rendered_pages, page_index);
            if source == "none" && unknown_diag.is_none() {
                // One-time dump so the missing rendered size can be diagnosed:
                // which fields exist, what dataInfo says, whether inputImage is
                // present (and how big), and a sample box.
                let keys: Vec<String> = page
                    .as_object()
                    .map(|o| o.keys().cloned().collect())
                    .unwrap_or_default();
                let data_info_raw: String = info
                    .as_ref()
                    .map(|v| v.to_string())
                    .unwrap_or_default()
                    .chars()
                    .take(300)
                    .collect();
                let input_image_chars = page
                    .get("inputImage")
                    .and_then(Value::as_str)
                    .map(str::len)
                    .unwrap_or(0);
                unknown_diag = Some(format!(
                    "page_keys={keys:?} dataInfo={data_info_raw} inputImage_chars={input_image_chars} first_box={:?}",
                    parsed.boxes.first()
                ));
            }
            dim_sources.push(source);
            pages.push(parsed);
        }
    }
    let unknown = dim_sources.iter().filter(|s| **s == "none").count();
    log::info!(
        target: "agentero::layout::hosted",
        "cloud result: pages={} rendered_size_known={} unknown={}{}",
        pages.len(),
        pages.len() - unknown,
        unknown,
        unknown_diag
            .map(|d| format!(" | unknown-size diag: {d}"))
            .unwrap_or_default()
    );
    Ok(LayoutRemoteAnalyzePdfResult {
        pages,
        rendered_pages,
    })
}

/// Connectivity probe: submit a tiny OCR job through the same async path;
/// a jobId means endpoint + token are valid. Runs in the Host so it is not
/// subject to WebView CORS and honors the app proxy.
async fn probe(
    credentials: &HostedProviderCredentials,
    args: LayoutRemoteProbeArgs,
) -> Result<LayoutRemoteProbeResult, AppError> {
    let (jobs_url, auth) = resolve_cloud_target(credentials.api_key.as_deref())?;
    if args.image_base64.trim().is_empty() {
        return Err(AppError::message("layout_remote: probe image is empty"));
    }
    let image_bytes = base64::engine::general_purpose::STANDARD
        .decode(args.image_base64.trim())
        .map_err(|e| AppError::message(format!("layout_remote: invalid probe image: {e}")))?;
    let client = http::client(Duration::from_secs(30))?;
    // Probe with the same payload the real layout analysis sends, so a green
    // probe also validates that preset against the service.
    let job_id = submit_job(
        &client,
        &jobs_url,
        &auth,
        image_bytes,
        "probe.jpg".to_string(),
        "image/jpeg",
        CLOUD_MODEL,
        PaddleJobPurpose::Layout,
    )
    .await?;
    Ok(LayoutRemoteProbeResult { job_id })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jpeg_dimensions_reads_sof0() {
        // Minimal JPEG: SOI, SOF0 (11x7, 1 component), EOI.
        let mut bytes: Vec<u8> = vec![0xFF, 0xD8];
        bytes.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x0B, 0x08]);
        bytes.extend_from_slice(&7u16.to_be_bytes()); // height
        bytes.extend_from_slice(&11u16.to_be_bytes()); // width
        bytes.push(0x01);
        bytes.extend_from_slice(&[0xFF, 0xD9]);
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        assert_eq!(jpeg_dimensions_base64(&b64), Some((11, 7)));
        assert_eq!(jpeg_dimensions_base64("not-base64!!"), None);
    }

    #[test]
    fn layout_optional_payload_disables_unused_sub_pipelines() {
        let payload: Value = serde_json::from_str(&layout_optional_payload())
            .expect("optionalPayload must be valid JSON");
        for flag in [
            "useDocOrientationClassify",
            "useDocUnwarping",
            "useChartRecognition",
            "useTableRecognition",
            "useFormulaRecognition",
            "useSealRecognition",
            "useTextlineOrientation",
            "useRegionDetection",
            "formatBlockContent",
        ] {
            assert_eq!(
                payload.get(flag),
                Some(&Value::Bool(false)),
                "{flag} must be disabled"
            );
        }
        // Layout detection supplies the boxes we consume; never disable it.
        assert_ne!(
            payload.get("useLayoutDetection").and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            PaddleJobPurpose::Layout.optional_payload(),
            layout_optional_payload()
        );
    }

    #[test]
    fn body_parse_optional_payload_keeps_the_markdown_pipeline() {
        let payload: Value = serde_json::from_str(&body_parse_optional_payload())
            .expect("optionalPayload must be valid JSON");
        // Byte-for-byte the historical preset: the same three flags, nothing new.
        assert_eq!(payload.as_object().map(|o| o.len()), Some(3));
        for flag in [
            "useDocOrientationClassify",
            "useDocUnwarping",
            "useChartRecognition",
        ] {
            assert_eq!(
                payload.get(flag),
                Some(&Value::Bool(false)),
                "{flag} must stay disabled"
            );
        }
        // Body parsing reads `markdown.text` / `parsing_res_list[].block_content`,
        // so these pipelines must stay enabled.
        for flag in [
            "useTableRecognition",
            "useFormulaRecognition",
            "useSealRecognition",
            "useTextlineOrientation",
            "useRegionDetection",
            "formatBlockContent",
        ] {
            assert_ne!(
                payload.get(flag).and_then(Value::as_bool),
                Some(false),
                "{flag} must stay enabled for body parsing"
            );
        }
        assert_eq!(
            PaddleJobPurpose::BodyParse.optional_payload(),
            body_parse_optional_payload()
        );
    }
}
