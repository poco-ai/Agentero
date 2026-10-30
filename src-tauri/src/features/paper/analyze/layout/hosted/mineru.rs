//! MinerU remote layout engine (https://mineru.net) — an asynchronous batch
//! flow: `POST {base}/api/v4/file-urls/batch` (request a presigned upload
//! URL) → `PUT` the PDF bytes → poll
//! `GET {base}/api/v4/extract-results/batch/{batch_id}` → download the result
//! zip and read `*content_list.json` (0–1000 normalized boxes) plus the
//! intermediate result — `*middle.json` in older zips, `layout.json` in
//! cloud v4 — for per-page sizes.
//!
//! The `selfHosted` option switches to a self-hosted deployment instead: its
//! dialect is detected from the health endpoint (see [`MineruDialect`]), and
//! the same zip is read back — 4.0 zips carry `middle_json.json`
//! (`docvortex.middle`, 0–1 normalized boxes), 3.x zips the cloud-shaped
//! `*content_list.json` + `*middle.json` pair.

use crate::core::error::AppError;
use crate::core::http;
use crate::features::paper::analyze::layout::hosted::engine::{
    HostedLayoutAnalyzer, HostedProviderCredentials, LayoutAnalyzeContext,
};
use crate::features::paper::analyze::layout::hosted::{
    emit_cloud_progress, LayoutRemoteAnalyzePdfResult, LayoutRemoteBox, LayoutRemotePageResult,
    LayoutRemoteProbeArgs, LayoutRemoteProbeResult,
};
use crate::features::paper::import::CANCELLED_MESSAGE;
use async_trait::async_trait;
use reqwest::StatusCode;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::Read;
use std::time::{Duration, Instant};

mod extract;

const MINERU_BASE_URL: &str = "https://mineru.net";
const MINERU_POLL_INTERVAL: Duration = Duration::from_secs(3);
const MINERU_JOB_DEADLINE: Duration = Duration::from_secs(600);
const MINERU_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
/// Document language sent when the user has not picked one. `ch` is also
/// MinerU's own default and covers Chinese (Simplified / Traditional) plus
/// English, which fits mixed-language papers.
const MINERU_DEFAULT_LANGUAGE: &str = "ch";
/// Untrusted result zip: cap the download and each decompressed JSON entry
/// to prevent zip-bomb OOM (same rationale as the sync gunzip caps).
const MAX_RESULT_ZIP_BYTES: usize = 256 * 1024 * 1024;
const MAX_JSON_ENTRY_BYTES: u64 = 128 * 1024 * 1024;
/// MinerU Markdown refers to extracted figures through `images/...` paths.
/// Keep the individual and aggregate unpacked sizes bounded because result ZIPs
/// are remote, untrusted input.
const MAX_BODY_IMAGE_ENTRY_BYTES: u64 = 32 * 1024 * 1024;
const MAX_BODY_IMAGE_BYTES: u64 = 128 * 1024 * 1024;

/// The Markdown and figure files required to materialize a MinerU body parse.
/// Paths remain relative to `PAPER.md`, for example `images/figure-1.jpg`.
pub(crate) struct MineruMarkdownBundle {
    pub markdown: String,
    pub assets: Vec<MineruMarkdownAsset>,
}

/// One image extracted from a MinerU result ZIP.
pub(crate) struct MineruMarkdownAsset {
    pub relative_path: String,
    pub bytes: Vec<u8>,
}

pub struct MineruEngine;

#[async_trait]
impl HostedLayoutAnalyzer for MineruEngine {
    fn id(&self) -> &'static str {
        "mineru"
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

/// Self-hosted deployments run on a LAN, where plain http is the norm; the
/// official cloud default is https either way.
fn ensure_base_url_scheme(base: &str) -> Result<(), AppError> {
    if base.starts_with("https://") || base.starts_with("http://") {
        return Ok(());
    }
    Err(AppError::message(
        "MinerU baseUrl must start with http:// or https://",
    ))
}

/// Attach the API token only when one was configured: a self-hosted server may
/// run anonymously, and a cross-origin upload URL must never see the token.
fn authed(request: reqwest::RequestBuilder, auth: &str) -> reqwest::RequestBuilder {
    if auth.is_empty() {
        request
    } else {
        request.header("Authorization", auth)
    }
}

/// Resolve `(base_url, authorization header)`. The official cloud always needs
/// a token; a self-hosted endpoint may leave it empty.
fn resolve_target(credentials: &HostedProviderCredentials) -> Result<(String, String), AppError> {
    let configured_base = credentials
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let base = match configured_base {
        Some(base) => {
            ensure_base_url_scheme(base)?;
            base.trim_end_matches('/').to_string()
        }
        None => MINERU_BASE_URL.to_string(),
    };
    let auth = match credentials
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
    {
        Some(api_key) => format!("Bearer {api_key}"),
        // The official cloud (and its relays) always authenticates; a
        // self-hosted server may run anonymously.
        None if !credentials.self_hosted => {
            return Err(AppError::message(
                "MinerU official cloud API requires apiKey (Settings → Layout)",
            ))
        }
        None => String::new(),
    };
    Ok((base, auth))
}

/// Self-hosted transport dialect. MinerU 4.0 replaced the 3.x `/file_parse` +
/// `/tasks` routes with the V1 upload → parse-job → artifact flow.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MineruDialect {
    V1,
    Legacy,
}

/// Read and parse a JSON response; when the body is not JSON, report the HTTP
/// status together with a body snippet instead of a bare parse error.
async fn json_body(response: reqwest::Response, what: &str) -> Result<Value, AppError> {
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| AppError::message(format!("MinerU {what} read failed: {e}")))?;
    serde_json::from_str(&text).map_err(|_| {
        let snippet = http::http_err_snippet(&text);
        AppError::message(format!("MinerU {what} failed (HTTP {status}): {snippet}"))
    })
}

/// Detect the self-hosted dialect from the health endpoint and return it with
/// the server version (`GET /v1/health` on 4.0+, `GET /health` on 3.x).
async fn detect_self_hosted(
    client: &reqwest::Client,
    base: &str,
    auth: &str,
) -> Result<(MineruDialect, String), AppError> {
    for (path, dialect) in [
        ("/v1/health", MineruDialect::V1),
        ("/health", MineruDialect::Legacy),
    ] {
        let Ok(response) = authed(client.get(format!("{base}{path}")), auth)
            .send()
            .await
        else {
            continue;
        };
        if !response.status().is_success() {
            continue;
        }
        let version = response
            .json::<Value>()
            .await
            .ok()
            .and_then(|value| {
                value
                    .get("version")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "unknown".to_string());
        return Ok((dialect, version));
    }
    Err(AppError::message(format!(
        "MinerU self-hosted server {base} answered neither /v1/health (4.0+) nor /health (3.x)"
    )))
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

/// MinerU cloud replies always carry a business code (`code`, or `msgCode` on
/// newer versions); a 404 page, an HTML error or a proxy body does not.
fn is_mineru_reply(body: &Value) -> bool {
    body.get("code").is_some() || body.get("msgCode").is_some()
}

/// Error for a failed cloud call. A body without a business code is reported
/// with its HTTP status plus the self-hosted hint — that combination is what a
/// self-hosted address (or a wrong path) looks like when the `selfHosted`
/// switch is off.
fn mineru_api_error(context: &str, body: &Value, status: StatusCode) -> AppError {
    let code = mineru_code(body);
    if is_token_error_code(&code) {
        return AppError::message(format!(
            "MinerU {context} failed: invalid API token ({code})"
        ));
    }
    if !code.is_empty() {
        return AppError::message(format!(
            "MinerU {context} failed ({code}): {}",
            mineru_msg(body)
        ));
    }
    if status == StatusCode::UNAUTHORIZED {
        return AppError::message(format!(
            "MinerU {context} failed: invalid API token (HTTP 401)"
        ));
    }
    AppError::message(format!(
        "MinerU {context} failed (HTTP {status}). This endpoint did not answer as the official \
         cloud API — a self-hosted server needs \"Self-hosted API\" enabled in Settings → Layout"
    ))
}

/// Poll-state classification for `extract_result[].state` (cloud v4) and
/// `status` (3.x).
#[derive(Debug, PartialEq, Eq)]
enum ExtractState {
    Done,
    Failed,
    InProgress,
}

fn classify_extract_state(state: &str) -> ExtractState {
    match state.trim().to_ascii_lowercase().as_str() {
        // The cloud reports `done`; 3.x reports `completed`.
        "done" | "completed" => ExtractState::Done,
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
        // 4.0 labels the running page number; PP-DocLayoutV3 calls it `number`.
        "page_number" => "number".to_string(),
        "footnote" | "page_footnote" => "footnote".to_string(),
        "ref_text" | "reference" => "reference".to_string(),
        "image_caption" | "table_caption" => "figure_title".to_string(),
        other => other.to_string(),
    }
}

/// Content List captions are arrays; text and intermediate spans are strings.
fn mineru_text(value: Option<&Value>) -> Option<String> {
    let text = match value? {
        Value::String(text) => text.trim().to_string(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    (!text.is_empty()).then_some(text)
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
            text: mineru_text(item.get("text")).or_else(|| mineru_text(item.get("content"))),
            caption: mineru_text(item.get("image_caption"))
                .or_else(|| mineru_text(item.get("table_caption"))),
        });
    }
    Ok(pages)
}

/// Only intermediate caption blocks have independent geometry. Their bboxes
/// already use page points, unlike the normalized Content List bboxes.
fn append_middle_captions(pages: &mut [LayoutRemotePageResult], middle: &Value) {
    let Some(source_pages) = middle.get("pdf_info").and_then(Value::as_array) else {
        return;
    };
    for (page, source) in pages.iter_mut().zip(source_pages) {
        // para_blocks contains the final reading order; preproc_blocks repeats
        // those blocks in many results and is only a fallback for older output.
        let blocks = source
            .get("para_blocks")
            .and_then(Value::as_array)
            .filter(|blocks| !blocks.is_empty())
            .or_else(|| source.get("preproc_blocks").and_then(Value::as_array));
        let Some(blocks) = blocks else { continue };
        let mut pending: Vec<&Value> = blocks.iter().rev().collect();
        while let Some(block) = pending.pop() {
            if let Some(children) = block.get("blocks").and_then(Value::as_array) {
                pending.extend(children.iter().rev());
            }
            if !matches!(
                block.get("type").and_then(Value::as_str),
                Some("image_caption" | "table_caption")
            ) {
                continue;
            }
            let Some(bbox) = block.get("bbox").and_then(Value::as_array) else {
                continue;
            };
            let nums: Vec<f64> = bbox.iter().filter_map(Value::as_f64).collect();
            if bbox.len() != 4 || nums.len() != 4 || nums[2] <= nums[0] || nums[3] <= nums[1] {
                continue;
            }
            let text = mineru_text(block.get("text")).or_else(|| {
                let lines = block.get("lines")?.as_array()?;
                let text = lines
                    .iter()
                    .filter_map(|line| line.get("spans")?.as_array())
                    .map(|spans| {
                        spans
                            .iter()
                            .filter_map(|span| span.get("content")?.as_str())
                            .collect::<String>()
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                let text = text.trim();
                (!text.is_empty()).then(|| text.to_string())
            });
            let Some(text) = text else { continue };
            page.boxes.push(LayoutRemoteBox {
                cls_id: -1,
                label: "figure_title".to_string(),
                score: 1.0,
                coordinate: [nums[0], nums[1], nums[2], nums[3]],
                text: Some(text),
                caption: None,
            });
        }
    }
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
            let name = entry.name().map_err(|e| {
                AppError::message(format!("MinerU result zip entry name failed: {e}"))
            })?;
            if name == *candidate {
                index = Some(i);
                break;
            }
        }
        if index.is_none() {
            for i in 0..archive.len() {
                let entry = archive.by_index(i).map_err(|e| {
                    AppError::message(format!("MinerU result zip entry failed: {e}"))
                })?;
                let name = entry.name().map_err(|e| {
                    AppError::message(format!("MinerU result zip entry name failed: {e}"))
                })?;
                if name.ends_with(candidate) {
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
            .filter_map(|i| {
                archive
                    .by_index(i)
                    .ok()
                    .and_then(|e| e.name().ok().map(|name| name.into_owned()))
            })
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

/// Return a safe, slash-separated image path below `images/`, or `None` for
/// unrelated ZIP entries. MinerU may prefix ZIP members with a task id, so the
/// returned path starts at the first `images` directory. Backslashes are
/// normalized before validation because they become path separators on Windows.
fn safe_mineru_image_path(name: &str) -> Result<Option<String>, AppError> {
    let normalized = name.replace('\\', "/");
    if normalized.contains('\0') || normalized.starts_with('/') {
        return Err(AppError::message(
            "MinerU result zip contains an invalid image path",
        ));
    }
    if !normalized.starts_with("images/") && !normalized.contains("/images/") {
        return Ok(None);
    }
    let parts: Vec<&str> = normalized.split('/').collect();
    if parts
        .iter()
        .any(|part| part.is_empty() || *part == "." || *part == ".." || part.contains(':'))
    {
        return Err(AppError::message(
            "MinerU result zip contains an unsafe image path",
        ));
    }
    let Some(images_index) = parts.iter().position(|part| *part == "images") else {
        return Ok(None);
    };
    let image_parts = &parts[images_index + 1..];
    if image_parts.is_empty() {
        return Ok(None);
    }
    Ok(Some(format!("images/{}", image_parts.join("/"))))
}

/// Extract the Markdown and the `images/` files it references by relative path.
/// The caller writes them beside `PAPER.md`, preserving MinerU's portable
/// Markdown instead of rewriting the links to application-specific URLs.
/// Entry names differ per protocol: `full.md` (cloud v4), `markdown.md`
/// (self-hosted 4.0) and `<stem>.md` (3.x).
pub(crate) fn read_mineru_markdown_bundle(bytes: &[u8]) -> Result<MineruMarkdownBundle, AppError> {
    let markdown = read_zip_entry_by_candidates(bytes, &["full.md", "markdown.md", ".md"])?;
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| AppError::message(format!("MinerU result zip open failed: {e}")))?;
    let mut assets = Vec::new();
    let mut paths = HashSet::new();
    let mut total_bytes = 0u64;

    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|e| AppError::message(format!("MinerU result zip entry failed: {e}")))?;
        if entry.is_dir() {
            continue;
        }
        let name = entry
            .name()
            .map_err(|e| AppError::message(format!("MinerU result zip entry name failed: {e}")))?;
        let Some(relative_path) = safe_mineru_image_path(name.as_ref())? else {
            continue;
        };
        if !paths.insert(relative_path.clone()) {
            return Err(AppError::message(format!(
                "MinerU result zip contains duplicate image `{relative_path}`"
            )));
        }
        if entry.size() > MAX_BODY_IMAGE_ENTRY_BYTES {
            return Err(AppError::message(format!(
                "MinerU result image `{relative_path}` is too large"
            )));
        }
        let mut image = Vec::with_capacity(entry.size() as usize);
        entry
            .take(MAX_BODY_IMAGE_ENTRY_BYTES + 1)
            .read_to_end(&mut image)
            .map_err(|e| AppError::message(format!("MinerU result image read failed: {e}")))?;
        if image.len() as u64 > MAX_BODY_IMAGE_ENTRY_BYTES {
            return Err(AppError::message(format!(
                "MinerU result image `{relative_path}` is too large"
            )));
        }
        total_bytes = total_bytes
            .checked_add(image.len() as u64)
            .ok_or_else(|| AppError::message("MinerU result images are too large"))?;
        if total_bytes > MAX_BODY_IMAGE_BYTES {
            return Err(AppError::message("MinerU result images are too large"));
        }
        assets.push(MineruMarkdownAsset {
            relative_path,
            bytes: image,
        });
    }

    Ok(MineruMarkdownBundle { markdown, assets })
}

/// Intermediate-result entry names: `*_middle.json` / `middle.json` in older
/// zips, `layout.json` in cloud v4 (same `pdf_info[].page_size` schema).
const MIDDLE_CANDIDATES: &[&str] = &["middle.json", "layout.json"];

/// MinerU 4.0 result protocol (`docvortex.middle`): `pages[].blocks[]` are
/// page-relative (0–1) boxes and per-page sizes live in
/// `extensions.docvortex_layout.pages[]`. Caption sub-blocks keep their own
/// geometry, so they become independent `figure_title` boxes.
fn parse_docvortex_pages(middle: &Value) -> Result<Vec<LayoutRemotePageResult>, AppError> {
    let sizes: Vec<(f64, f64)> = middle
        .get("extensions")
        .and_then(|extensions| extensions.get("docvortex_layout"))
        .and_then(|layout| layout.get("pages"))
        .and_then(Value::as_array)
        .map(|pages| {
            pages
                .iter()
                .map(|page| {
                    (
                        page.get("width_pt").and_then(Value::as_f64).unwrap_or(0.0),
                        page.get("height_pt").and_then(Value::as_f64).unwrap_or(0.0),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    if sizes.is_empty() {
        return Err(AppError::message(
            "MinerU result parse failed: docvortex layout has no page sizes",
        ));
    }
    let mut pages: Vec<LayoutRemotePageResult> = sizes
        .iter()
        .map(|&(w, h)| LayoutRemotePageResult {
            boxes: Vec::new(),
            width_px: (w > 0.0).then(|| w.round() as u32),
            height_px: (h > 0.0).then(|| h.round() as u32),
        })
        .collect();
    let Some(source_pages) = middle.get("pages").and_then(Value::as_array) else {
        return Ok(pages);
    };
    for source in source_pages {
        let Some(page_idx) = source.get("page_idx").and_then(Value::as_u64) else {
            continue;
        };
        let Some(page) = pages.get_mut(page_idx as usize) else {
            continue;
        };
        let (w, h) = sizes[page_idx as usize];
        let Some(blocks) = source.get("blocks").and_then(Value::as_array) else {
            continue;
        };
        for block in blocks {
            let Some(item_type) = block.get("type").and_then(Value::as_str) else {
                continue;
            };
            let item_type = item_type.trim();
            if item_type.is_empty() {
                continue;
            }
            let Some(coordinate) = docvortex_box(block.get("bbox"), w, h) else {
                continue;
            };
            let text_level = block.get("level").and_then(Value::as_i64);
            page.boxes.push(LayoutRemoteBox {
                cls_id: -1,
                label: map_mineru_label(item_type, text_level),
                // The protocol carries no confidence; 1.0 passes the frontend
                // min-score gate without distorting relative ordering.
                score: 1.0,
                coordinate,
                text: docvortex_text(block.get("content")),
                caption: None,
            });
            let Some(content) = block.get("content").and_then(Value::as_array) else {
                continue;
            };
            for sub in content {
                let Some(sub_type) = sub.get("type").and_then(Value::as_str) else {
                    continue;
                };
                if !matches!(
                    sub_type.trim(),
                    "image_caption" | "table_caption" | "chart_caption"
                ) {
                    continue;
                }
                let Some(caption_coordinate) = docvortex_box(sub.get("bbox"), w, h) else {
                    continue;
                };
                let Some(caption) = docvortex_text(sub.get("content")) else {
                    continue;
                };
                page.boxes.push(LayoutRemoteBox {
                    cls_id: -1,
                    label: "figure_title".to_string(),
                    score: 1.0,
                    coordinate: caption_coordinate,
                    text: Some(caption),
                    caption: None,
                });
            }
        }
    }
    Ok(pages)
}

/// Page-relative (0–1) box → rendered-page pixels. Empty boxes are dropped.
fn docvortex_box(bbox: Option<&Value>, width: f64, height: f64) -> Option<[f64; 4]> {
    let bbox = bbox?.as_array()?;
    let nums: Vec<f64> = bbox.iter().filter_map(Value::as_f64).collect();
    if nums.len() != 4 {
        return None;
    }
    let coordinate = [
        nums[0] * width,
        nums[1] * height,
        nums[2] * width,
        nums[3] * height,
    ];
    (coordinate[2] > coordinate[0] && coordinate[3] > coordinate[1]).then_some(coordinate)
}

/// Concatenate the text spans of a docvortex `content` array (spans nest).
fn docvortex_text(value: Option<&Value>) -> Option<String> {
    fn collect(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::String(text) => {
                let text = text.trim();
                if !text.is_empty() {
                    out.push(text.to_string());
                }
            }
            Value::Array(items) => items.iter().for_each(|item| collect(item, out)),
            Value::Object(map) => {
                if let Some(content) = map.get("content") {
                    collect(content, out);
                }
            }
            _ => {}
        }
    }
    let mut parts = Vec::new();
    collect(value?, &mut parts);
    (!parts.is_empty()).then(|| parts.join(" "))
}

fn parse_result_zip(bytes: &[u8]) -> Result<LayoutRemoteAnalyzePdfResult, AppError> {
    // Self-hosted 4.0 zips carry the shared docvortex document instead of the
    // cloud content-list + middle-json pair (which 3.x still produces).
    if let Ok(middle_text) = read_zip_entry_by_candidates(bytes, &["middle_json.json"]) {
        let middle: Value = serde_json::from_str(&middle_text).map_err(|e| {
            AppError::message(format!("MinerU result parse failed: middle_json: {e}"))
        })?;
        let pages = parse_docvortex_pages(&middle)?;
        let rendered_pages = pages
            .iter()
            .map(|page| (page.width_px.unwrap_or(0), page.height_px.unwrap_or(0)))
            .collect();
        return Ok(LayoutRemoteAnalyzePdfResult {
            pages,
            rendered_pages,
        });
    }
    let content_list_text = read_zip_entry_by_candidates(bytes, &["content_list.json"])?;
    let middle_text = read_zip_entry_by_candidates(bytes, MIDDLE_CANDIDATES)?;
    let content_list: Value = serde_json::from_str(&content_list_text)
        .map_err(|e| AppError::message(format!("MinerU result parse failed: content_list: {e}")))?;
    let middle: Value = serde_json::from_str(&middle_text)
        .map_err(|e| AppError::message(format!("MinerU result parse failed: middle: {e}")))?;
    let page_sizes = parse_middle_page_sizes(&middle)?;
    let mut pages = build_pages(&content_list, &page_sizes)?;
    append_middle_captions(&mut pages, &middle);
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
        return Err(mineru_api_error("batch submit", &value, status));
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

    let zip_bytes =
        run_mineru_extract(&credentials, pdf_bytes, &file_name, &emit_progress, &|| {
            false
        })
        .await?;

    // Extract content_list.json + middle.json and map to page boxes.
    let result = parse_result_zip(&zip_bytes)?;
    log::info!(
        target: "agentero::layout::hosted",
        "mineru result: pages={} boxes={}",
        result.pages.len(),
        result.pages.iter().map(|p| p.boxes.len()).sum::<usize>()
    );
    Ok(result)
}

/// Whole-document MinerU extract returning the result zip. Shared by the
/// layout analyze path and the PAPER.md body-parse engine, both of which read
/// their own entries out of that zip. Identical concurrent requests share one
/// extraction; completed ZIPs are not retained in a cache.
///
/// `selfHosted` chooses between the cloud batch flow (including custom relays)
/// and a self-hosted deployment, whose dialect is detected from `/v1/health`
/// (4.0+) or `/health` (3.x).
pub(crate) async fn run_mineru_extract(
    credentials: &HostedProviderCredentials,
    pdf_bytes: Vec<u8>,
    file_name: &str,
    progress: super::ProgressFn<'_>,
    cancel: super::CancelFn<'_>,
) -> Result<std::sync::Arc<Vec<u8>>, AppError> {
    extract::run(credentials, pdf_bytes, file_name, progress, cancel).await
}

async fn run_mineru_extract_unshared(
    credentials: &HostedProviderCredentials,
    pdf_bytes: Vec<u8>,
    file_name: &str,
    progress: super::ProgressFn<'_>,
    cancel: super::CancelFn<'_>,
) -> Result<Vec<u8>, AppError> {
    let (base, auth) = resolve_target(credentials)?;
    let client = http::client(MINERU_REQUEST_TIMEOUT)?;
    // The `selfHosted` switch decides the protocol, not the host — that is what
    // keeps a relay (or the default mineru.net) on the cloud batch API.
    if !credentials.self_hosted {
        return run_cloud_extract(
            &client,
            &base,
            &auth,
            pdf_bytes,
            file_name,
            credentials,
            progress,
            cancel,
        )
        .await;
    }
    let (dialect, version) = detect_self_hosted(&client, &base, &auth).await?;
    log::info!(
        target: "agentero::layout::hosted",
        "mineru self-hosted: {dialect:?} version={version}"
    );
    match dialect {
        MineruDialect::V1 => {
            run_v1_extract(
                &client,
                &base,
                &auth,
                pdf_bytes,
                file_name,
                credentials,
                progress,
                cancel,
            )
            .await
        }
        MineruDialect::Legacy => {
            run_legacy_extract(
                &client,
                &base,
                &auth,
                pdf_bytes,
                file_name,
                credentials,
                progress,
                cancel,
            )
            .await
        }
    }
}

/// Cloud batch flow: request the presigned upload URL, PUT the bytes, poll the
/// batch id, then download the result zip.
#[allow(clippy::too_many_arguments)]
async fn run_cloud_extract(
    client: &reqwest::Client,
    base: &str,
    auth: &str,
    pdf_bytes: Vec<u8>,
    file_name: &str,
    credentials: &HostedProviderCredentials,
    progress: super::ProgressFn<'_>,
    cancel: super::CancelFn<'_>,
) -> Result<Vec<u8>, AppError> {
    // 1) Request the presigned upload URL, then PUT the raw PDF bytes
    //    (no Content-Type — the presigned signature does not cover one).
    progress("uploading", None, None);
    let language = credentials
        .language
        .as_deref()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .unwrap_or(MINERU_DEFAULT_LANGUAGE);
    let (batch_id, upload_url) =
        request_upload_url(client, base, auth, file_name, language, credentials.is_ocr).await?;
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
            .header("Authorization", auth)
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
            return Err(mineru_api_error("task poll", &poll_value, poll_status));
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
    read_capped_zip(zip_response).await
}

/// Stream an untrusted result zip into memory, capped so a remote zip bomb
/// cannot exhaust the Host.
async fn read_capped_zip(mut response: reqwest::Response) -> Result<Vec<u8>, AppError> {
    let mut zip_bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = response
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

/// Trimmed non-empty value; used for the optional request parameters.
fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// V1 job states: `completed` and `partial` are successful terminal states,
/// `failed` and `canceled` are failures, everything else is still running.
fn classify_v1_status(status: &str) -> ExtractState {
    match status.trim().to_ascii_lowercase().as_str() {
        "completed" | "partial" => ExtractState::Done,
        "failed" | "canceled" => ExtractState::Failed,
        _ => ExtractState::InProgress,
    }
}

/// `file.id` of a V1 upload response.
fn v1_upload_file_id(upload: &Value) -> Result<String, AppError> {
    upload
        .get("file")
        .and_then(|file| file.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| AppError::message("Unexpected MinerU response: missing upload file id"))
}

/// Per-file error text of a V1 job (falls back to the job status).
fn v1_failure(job: &Value, status: &str) -> String {
    job.get("files")
        .and_then(Value::as_array)
        .and_then(|files| files.iter().find_map(|file| file.get("error")))
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .filter(|message| !message.trim().is_empty())
        .unwrap_or(status)
        .to_string()
}

/// `file_id` of the `zip` artifact of a finished V1 job.
fn v1_zip_file_id(job: &Value) -> Result<String, AppError> {
    job.get("files")
        .and_then(Value::as_array)
        .and_then(|files| {
            files
                .iter()
                .find(|file| file.get("status").and_then(Value::as_str) == Some("completed"))
                .or_else(|| files.first())
        })
        .and_then(|file| file.get("output_files"))
        .and_then(|outputs| outputs.get("zip"))
        .and_then(|zip| zip.get("file_id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            AppError::message(format!(
                "MinerU task done without a zip artifact: {}",
                v1_failure(job, "completed")
            ))
        })
}

/// Resolve the service-provided upload URL (self-hosted servers return a
/// same-origin path) against the API base.
fn resolve_upload_url(base: &str, target: &str) -> Result<String, AppError> {
    if target.starts_with("http://") || target.starts_with("https://") {
        return Ok(target.to_string());
    }
    if !target.starts_with('/') {
        return Err(AppError::message(format!(
            "MinerU upload URL is neither absolute nor rooted: {target}"
        )));
    }
    Ok(format!("{base}{target}"))
}

/// Scheme + host + effective port comparison, used to decide whether the API
/// token may travel to the upload URL the service handed back.
fn same_origin(base: &str, target: &str) -> bool {
    let origin = |value: &str| {
        reqwest::Url::parse(value).ok().map(|url| {
            (
                url.scheme().to_string(),
                url.host_str().unwrap_or_default().to_string(),
                url.port_or_known_default(),
            )
        })
    };
    matches!((origin(base), origin(target)), (Some(a), Some(b)) if a == b)
}

/// Self-hosted 4.0 flow: create upload → PUT bytes → complete → submit parse
/// job → poll → download the `zip` artifact.
#[allow(clippy::too_many_arguments)]
async fn run_v1_extract(
    client: &reqwest::Client,
    base: &str,
    auth: &str,
    pdf_bytes: Vec<u8>,
    file_name: &str,
    credentials: &HostedProviderCredentials,
    progress: super::ProgressFn<'_>,
    cancel: super::CancelFn<'_>,
) -> Result<Vec<u8>, AppError> {
    progress("uploading", None, None);
    let create = authed(client.post(format!("{base}/v1/uploads")), auth)
        .json(&json!({
            "filename": file_name,
            "bytes": pdf_bytes.len(),
            "mime_type": "application/pdf",
            "purpose": "parse",
        }))
        .send()
        .await
        .map_err(|e| AppError::message(format!("MinerU upload request failed: {e}")))?;
    let upload = json_body(create, "upload request").await?;
    let upload_id = upload
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::message("Unexpected MinerU response: missing upload id"))?
        .to_string();

    let file_id = if upload.get("status").and_then(Value::as_str) == Some("completed") {
        // The server already holds these bytes; the PUT is skipped.
        v1_upload_file_id(&upload)?
    } else {
        let target = upload
            .get("upload_url")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::message("Unexpected MinerU response: missing upload_url"))?;
        let url = resolve_upload_url(base, target)?;
        let mut request = client.request(reqwest::Method::PUT, &url).body(pdf_bytes);
        if let Some(headers) = upload.get("upload_headers").and_then(Value::as_object) {
            for (name, value) in headers {
                if let Some(value) = value.as_str() {
                    request = request.header(name, value);
                }
            }
        }
        // A same-origin upload needs the API token; a presigned cross-origin
        // URL must never receive it.
        if same_origin(base, &url) {
            request = authed(request, auth);
        }
        let response = request
            .send()
            .await
            .map_err(|e| AppError::message(format!("MinerU upload failed: {e}")))?;
        let status = response.status();
        if !status.is_success() {
            return Err(AppError::message(format!(
                "MinerU upload failed (HTTP {status})"
            )));
        }
        let complete = authed(
            client.post(format!("{base}/v1/uploads/{upload_id}/complete")),
            auth,
        )
        .json(&json!({}))
        .send()
        .await
        .map_err(|e| AppError::message(format!("MinerU upload complete failed: {e}")))?;
        let completed = json_body(complete, "upload complete").await?;
        v1_upload_file_id(&completed)?
    };

    let job = json!({
        "files": [{ "source": { "type": "file_id", "file_id": file_id } }],
        // `ocr` treats every page as an image; `auto` prefers the text layer
        // and still OCRs scanned pages.
        "ocr_mode": if credentials.is_ocr { "ocr" } else { "auto" },
        // One zip keeps the artifact handling identical to the cloud path and
        // is the only output that also carries the `images/` assets.
        "output_formats": ["zip"],
    });
    let submit = authed(client.post(format!("{base}/v1/parse/jobs")), auth)
        .json(&job)
        .send()
        .await
        .map_err(|e| AppError::message(format!("MinerU job submit failed: {e}")))?;
    let submitted = json_body(submit, "job submit").await?;
    let job_id = submitted
        .get("job_id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::message("Unexpected MinerU response: missing job_id"))?;

    // Poll until a terminal state (deadline guards a stuck task).
    let poll_url = format!("{base}/v1/parse/jobs/{job_id}");
    let started = Instant::now();
    let artifact_url = loop {
        if cancel() {
            return Err(AppError::message(CANCELLED_MESSAGE));
        }
        if started.elapsed() > MINERU_JOB_DEADLINE {
            return Err(AppError::message("MinerU task timed out"));
        }
        tokio::time::sleep(MINERU_POLL_INTERVAL).await;
        let poll = authed(client.get(&poll_url), auth)
            .send()
            .await
            .map_err(|e| AppError::message(format!("MinerU task poll failed: {e}")))?;
        let poll = json_body(poll, "task poll").await?;
        let status = poll.get("status").and_then(Value::as_str).unwrap_or("");
        let job_progress = poll.get("progress");
        let completed = job_progress
            .and_then(|p| p.get("completed"))
            .and_then(Value::as_u64);
        let total = job_progress
            .and_then(|p| p.get("total"))
            .and_then(Value::as_u64);
        match classify_v1_status(status) {
            ExtractState::Done => {
                let file_id = v1_zip_file_id(&poll)?;
                progress("done", completed, total);
                break format!("{base}/v1/files/{file_id}/content");
            }
            ExtractState::Failed => {
                return Err(AppError::message(format!(
                    "MinerU task {status}: {}",
                    v1_failure(&poll, status)
                )))
            }
            ExtractState::InProgress => progress(status, completed, total),
        }
    };

    progress("downloading", None, None);
    let response = authed(client.get(&artifact_url), auth)
        .send()
        .await
        .map_err(|e| AppError::message(format!("MinerU result download failed: {e}")))?;
    let status = response.status();
    if !status.is_success() {
        return Err(AppError::message(format!(
            "MinerU result download failed (HTTP {status})"
        )));
    }
    read_capped_zip(response).await
}

/// 3.x `/tasks` form fields; 4.0 removed every one of them.
fn legacy_form_fields(credentials: &HostedProviderCredentials) -> Vec<(&'static str, String)> {
    let language = non_empty(credentials.language.as_deref()).unwrap_or(MINERU_DEFAULT_LANGUAGE);
    vec![
        ("lang_list", language.to_string()),
        (
            "parse_method",
            if credentials.is_ocr { "ocr" } else { "auto" }.to_string(),
        ),
        ("formula_enable", "true".to_string()),
        ("table_enable", "true".to_string()),
        ("return_md", "true".to_string()),
        ("return_middle_json", "true".to_string()),
        ("return_content_list", "true".to_string()),
        // Zip, so the layout and body paths read the same artifact.
        ("response_format_zip", "true".to_string()),
    ]
}

/// Self-hosted 3.x flow: `POST /tasks` → poll `GET /tasks/{id}` → download the
/// zip from `GET /tasks/{id}/result`.
#[allow(clippy::too_many_arguments)]
async fn run_legacy_extract(
    client: &reqwest::Client,
    base: &str,
    auth: &str,
    pdf_bytes: Vec<u8>,
    file_name: &str,
    credentials: &HostedProviderCredentials,
    progress: super::ProgressFn<'_>,
    cancel: super::CancelFn<'_>,
) -> Result<Vec<u8>, AppError> {
    progress("uploading", None, None);
    let mut form = reqwest::multipart::Form::new().part(
        "files",
        reqwest::multipart::Part::bytes(pdf_bytes)
            .file_name(file_name.to_string())
            .mime_str("application/pdf")
            .map_err(|e| AppError::message(format!("MinerU upload form failed: {e}")))?,
    );
    for (field, value) in legacy_form_fields(credentials) {
        form = form.text(field, value);
    }
    let submit = authed(client.post(format!("{base}/tasks")), auth)
        .multipart(form)
        .send()
        .await
        .map_err(|e| AppError::message(format!("MinerU task submit failed: {e}")))?;
    let submitted = json_body(submit, "task submit").await?;
    let task_id = submitted
        .get("task_id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::message("Unexpected MinerU response: missing task_id"))?
        .to_string();

    let poll_url = format!("{base}/tasks/{task_id}");
    let started = Instant::now();
    loop {
        if cancel() {
            return Err(AppError::message(CANCELLED_MESSAGE));
        }
        if started.elapsed() > MINERU_JOB_DEADLINE {
            return Err(AppError::message("MinerU task timed out"));
        }
        tokio::time::sleep(MINERU_POLL_INTERVAL).await;
        let poll = authed(client.get(&poll_url), auth)
            .send()
            .await
            .map_err(|e| AppError::message(format!("MinerU task poll failed: {e}")))?;
        let poll = json_body(poll, "task poll").await?;
        let status = poll.get("status").and_then(Value::as_str).unwrap_or("");
        match classify_extract_state(status) {
            ExtractState::Done => {
                progress("done", None, None);
                break;
            }
            ExtractState::Failed => {
                let message = poll
                    .get("error")
                    .and_then(Value::as_str)
                    .filter(|message| !message.trim().is_empty())
                    .unwrap_or("unknown error");
                return Err(AppError::message(format!("MinerU task failed: {message}")));
            }
            // 3.x states: `pending` / `processing`.
            ExtractState::InProgress => progress(status, None, None),
        }
    }

    progress("downloading", None, None);
    let response = authed(client.get(format!("{poll_url}/result")), auth)
        .send()
        .await
        .map_err(|e| AppError::message(format!("MinerU result download failed: {e}")))?;
    let status = response.status();
    if !status.is_success() {
        return Err(AppError::message(format!(
            "MinerU result download failed (HTTP {status})"
        )));
    }
    read_capped_zip(response).await
}

/// Probe outcome for the settings connectivity check. A non-auth business
/// response (currently `-10002 file list is empty`) proves the endpoint is the
/// cloud API and the token was accepted; token error codes and HTTP 401 do not,
/// and neither does a body without a business code — otherwise a self-hosted
/// address (404) would probe green while every real request failed.
fn probe_token_valid(body: &Value, status: StatusCode) -> bool {
    is_mineru_reply(body)
        && !is_token_error_code(&mineru_code(body))
        && status != StatusCode::UNAUTHORIZED
}

/// Connectivity probe: send a minimal (invalid-params) batch request; a
/// parameter error proves the token was accepted, a token error code does
/// not. Runs in the Host so it is not subject to WebView CORS and honors
/// the app proxy. The probe image is unused — MinerU has no image endpoint.
async fn probe(
    credentials: &HostedProviderCredentials,
    _args: LayoutRemoteProbeArgs,
) -> Result<LayoutRemoteProbeResult, AppError> {
    let (base, auth) = resolve_target(credentials)?;
    let client = http::client(Duration::from_secs(30))?;
    if credentials.self_hosted {
        return probe_self_hosted(&client, &base, &auth).await;
    }
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
        Err(mineru_api_error("probe", &value, status))
    }
}

/// Self-hosted probe: the health endpoint identifies the dialect and version
/// (both are anonymous), and on V1 the job listing additionally proves the
/// token is accepted.
async fn probe_self_hosted(
    client: &reqwest::Client,
    base: &str,
    auth: &str,
) -> Result<LayoutRemoteProbeResult, AppError> {
    let (dialect, version) = detect_self_hosted(client, base, auth).await?;
    if dialect == MineruDialect::V1 {
        let response = authed(client.get(format!("{base}/v1/parse/jobs")), auth)
            .query(&[("limit", "1")])
            .send()
            .await
            .map_err(|e| AppError::message(format!("MinerU probe failed: {e}")))?;
        let status = response.status();
        if status == StatusCode::UNAUTHORIZED {
            return Err(AppError::message(
                "MinerU probe failed: invalid API token (HTTP 401)",
            ));
        }
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            let snippet = http::http_err_snippet(&text);
            return Err(AppError::message(format!(
                "MinerU probe failed (HTTP {status}): {snippet}"
            )));
        }
    }
    Ok(LayoutRemoteProbeResult {
        job_id: format!("mineru {version}"),
    })
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
    fn preserves_content_text_and_captions_without_inventing_title_boxes() {
        let content = json!([
            {"type":"text", "page_idx":0, "bbox":[10,20,500,50], "text":"Fig. 1 | Overview."},
            {"type":"image", "page_idx":0, "bbox":[10,100,500,500], "image_caption":["Fig. 1 | Overview.", "Panel details."]},
            {"type":"table", "page_idx":0, "bbox":[500,100,900,500], "table_caption":["Table 1. Results."]},
            {"type":"chart", "page_idx":0, "bbox":[10,600,500,900], "image_caption":[], "content":"Chart text"}
        ]);
        let pages = build_pages(&content, &[(600.0, 800.0)]).unwrap();
        let boxes = serde_json::to_value(&pages[0].boxes).unwrap();
        assert_eq!(boxes[0]["text"], "Fig. 1 | Overview.");
        assert_eq!(boxes[1]["caption"], "Fig. 1 | Overview.\nPanel details.");
        assert_eq!(boxes[2]["caption"], "Table 1. Results.");
        assert_eq!(boxes[3]["text"], "Chart text");
        assert_eq!(boxes[3].get("caption"), Some(&Value::Null));
        assert_eq!(boxes[1].get("text"), Some(&Value::Null));
        assert_eq!(pages[0].boxes.len(), 4);
        assert!(pages[0].boxes.iter().all(|b| b.label != "figure_title"));
    }

    fn result_zip_fixture(content: &Value, middle: &Value) -> Vec<u8> {
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            for (name, value) in [("content_list.json", content), ("layout.json", middle)] {
                writer
                    .start_file(name, SimpleFileOptions::default())
                    .unwrap();
                writer
                    .write_all(&serde_json::to_vec(value).unwrap())
                    .unwrap();
            }
            writer.finish().unwrap();
        }
        cursor.into_inner()
    }

    #[test]
    fn extracts_nested_caption_geometry_in_page_points() {
        let caption = json!({"type":"image_caption", "bbox":[60,410,540,450], "lines":[
            {"spans":[{"content":"Fig. 2 | "},{"content":"Overview."}]},
            {"spans":[{"content":"Panel details."}]}
        ]});
        let middle = json!({"pdf_info":[
            {"page_idx":0,"page_size":[600,800],"para_blocks":[]},
            {"page_idx":1,"page_size":[600,800],"para_blocks":[
                {"type":"image", "bbox":[50,50,550,450], "blocks":[
                    {"type":"image_body","bbox":[50,50,550,400]}, caption.clone(),
                    {"type":"image_caption","lines":[{"spans":[{"content":"No box"}]}]},
                    {"type":"image_caption","bbox":[90,80,20,10],"text":"Invalid box"}
                ]},
                {"type":"table", "blocks":[{"type":"table_caption","bbox":[60,500,540,530],"text":"Table 1. Results."}]}
            ],"preproc_blocks":[caption]}
        ]});
        let result = parse_result_zip(&result_zip_fixture(&json!([]), &middle)).unwrap();
        assert!(result.pages[0].boxes.is_empty());
        let boxes = &result.pages[1].boxes;
        assert_eq!(boxes.len(), 2);
        assert_eq!(boxes[0].label, "figure_title");
        assert_eq!(boxes[0].coordinate, [60.0, 410.0, 540.0, 450.0]);
        let wire = serde_json::to_value(boxes).unwrap();
        assert_eq!(wire[0]["text"], "Fig. 2 | Overview.\nPanel details.");
        assert_eq!(wire[1]["text"], "Table 1. Results.");
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

    /// The Markdown entry differs per protocol — `full.md` (cloud v4),
    /// `markdown.md` (self-hosted 4.0) and `<stem>.md` (3.x) — while the
    /// `images/` assets resolve relatively to `PAPER.md` in all three.
    #[test]
    fn reads_markdown_bundle_with_figure_assets() {
        for (entry, image_entry) in [
            ("task/full.md", "task/images/figure-1.jpg"),
            ("markdown.md", "images/figure-1.jpg"),
            ("paper.pdf.md", "images/figure-1.jpg"),
        ] {
            let bytes = zip_fixture(&[
                (entry, b"# Paper\n\n![](images/figure-1.jpg)\n"),
                (image_entry, b"jpeg-bytes"),
                ("model.json", b"{}"),
            ]);
            let bundle = read_mineru_markdown_bundle(&bytes).unwrap();
            assert!(bundle.markdown.contains("images/figure-1.jpg"), "{entry}");
            assert_eq!(bundle.assets.len(), 1, "{entry}");
            assert_eq!(
                bundle.assets[0].relative_path, "images/figure-1.jpg",
                "{entry}"
            );
            assert_eq!(bundle.assets[0].bytes, b"jpeg-bytes", "{entry}");
        }
    }

    #[test]
    fn rejects_unsafe_mineru_image_paths() {
        for path in [
            "images/../escape.jpg",
            "images\\..\\escape.jpg",
            "images/./figure.jpg",
        ] {
            let err = safe_mineru_image_path(path).unwrap_err();
            assert!(err.to_string().contains("unsafe"));
        }
        assert!(safe_mineru_image_path("other/figure.jpg")
            .unwrap()
            .is_none());
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
        // 3.x reports `completed` where the cloud reports `done`.
        assert_eq!(classify_extract_state("completed"), ExtractState::Done);
        assert_eq!(classify_extract_state("failed"), ExtractState::Failed);
        for s in ["waiting-file", "pending", "running", "converting", ""] {
            assert_eq!(classify_extract_state(s), ExtractState::InProgress);
        }
    }

    #[test]
    fn classifies_v1_job_statuses() {
        for status in ["completed", "partial"] {
            assert_eq!(classify_v1_status(status), ExtractState::Done);
        }
        for status in ["failed", "canceled"] {
            assert_eq!(classify_v1_status(status), ExtractState::Failed);
        }
        for status in ["queued", "running", ""] {
            assert_eq!(classify_v1_status(status), ExtractState::InProgress);
        }
    }

    #[test]
    fn cloud_requires_a_token_but_a_self_hosted_server_does_not() {
        assert!(resolve_target(&HostedProviderCredentials::default()).is_err());
        // A relay keeps the cloud protocol and its own host, but still needs a
        // token.
        assert!(resolve_target(&HostedProviderCredentials {
            base_url: Some("https://relay.example.com".to_string()),
            ..Default::default()
        })
        .is_err());
        let relay = resolve_target(&HostedProviderCredentials {
            base_url: Some("https://relay.example.com/".to_string()),
            api_key: Some("sk-relay".to_string()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(relay.0, "https://relay.example.com");
        assert_eq!(relay.1, "Bearer sk-relay");
        // Self-hosted: no token required, host kept as the API base.
        let (base, auth) = resolve_target(&HostedProviderCredentials {
            base_url: Some("http://mineru.lan:8000/".to_string()),
            self_hosted: true,
            ..Default::default()
        })
        .unwrap();
        assert_eq!(base, "http://mineru.lan:8000");
        assert!(auth.is_empty());
        let (_, auth) = resolve_target(&HostedProviderCredentials {
            base_url: Some("https://mineru.lan:8443".to_string()),
            api_key: Some("sk-local".to_string()),
            self_hosted: true,
            ..Default::default()
        })
        .unwrap();
        assert_eq!(auth, "Bearer sk-local");
        assert!(resolve_target(&HostedProviderCredentials {
            base_url: Some("ftp://mineru.lan".to_string()),
            self_hosted: true,
            ..Default::default()
        })
        .is_err());
    }

    #[test]
    fn resolves_upload_urls_and_compares_origins() {
        assert_eq!(
            resolve_upload_url("http://host:8000", "/v1/uploads/u1/content").unwrap(),
            "http://host:8000/v1/uploads/u1/content"
        );
        assert_eq!(
            resolve_upload_url("http://host:8000", "https://bucket.example/x").unwrap(),
            "https://bucket.example/x"
        );
        assert!(resolve_upload_url("http://host:8000", "v1/uploads/u1").is_err());
        assert!(same_origin(
            "http://host:8000",
            "http://host:8000/v1/uploads/u1/content"
        ));
        // A different port is a different origin: the token must not travel.
        assert!(!same_origin(
            "http://host:8000",
            "http://host:9000/v1/uploads/u1/content"
        ));
        assert!(!same_origin("http://host:8000", "https://host:8000/x"));
    }

    #[test]
    fn builds_legacy_form_fields() {
        let map: std::collections::HashMap<&str, String> =
            legacy_form_fields(&HostedProviderCredentials::default())
                .into_iter()
                .collect();
        assert_eq!(map.get("lang_list").map(String::as_str), Some("ch"));
        assert_eq!(map.get("parse_method").map(String::as_str), Some("auto"));
        assert_eq!(
            map.get("response_format_zip").map(String::as_str),
            Some("true")
        );
        // 4.0 removed `backend` / `server_url`, so they are never sent.
        assert!(!map.contains_key("backend"));
        assert!(!map.contains_key("server_url"));

        let map: std::collections::HashMap<&str, String> =
            legacy_form_fields(&HostedProviderCredentials {
                language: Some("en".to_string()),
                is_ocr: true,
                ..Default::default()
            })
            .into_iter()
            .collect();
        assert_eq!(map.get("lang_list").map(String::as_str), Some("en"));
        assert_eq!(map.get("parse_method").map(String::as_str), Some("ocr"));
    }

    /// Build a zip from `(entry name, bytes)` pairs.
    fn zip_fixture(entries: &[(&str, &[u8])]) -> Vec<u8> {
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            for (name, bytes) in entries {
                writer
                    .start_file(*name, SimpleFileOptions::default())
                    .unwrap();
                writer.write_all(bytes).unwrap();
            }
            writer.finish().unwrap();
        }
        cursor.into_inner()
    }

    /// Self-hosted 4.0 zips carry `middle_json.json` (docvortex) with page
    /// sizes in `extensions.docvortex_layout` and 0–1 page-relative boxes.
    #[test]
    fn builds_pages_from_docvortex_middle_json() {
        let middle = json!({
            "schema": "docvortex.middle",
            "schema_version": "2.0",
            "extensions": { "docvortex_layout": { "version": 1, "pages": [
                { "page_idx": 0, "width_pt": 600.0, "height_pt": 800.0 },
                { "page_idx": 1, "width_pt": 600.0, "height_pt": 800.0 }
            ]}},
            "pages": [
                { "page_idx": 0, "blocks": [
                    { "type": "doc_title", "index": 0, "bbox": [0.1, 0.05, 0.9, 0.1],
                      "content": [{ "type": "text", "content": "Paper title" }]},
                    { "type": "image", "index": 1, "bbox": [0.1, 0.2, 0.5, 0.5], "content": [
                        { "type": "image_body", "index": 0, "bbox": [0.1, 0.2, 0.5, 0.5], "content": "" },
                        { "type": "image_caption", "index": 1, "bbox": [0.12, 0.51, 0.48, 0.53],
                          "content": [{ "type": "text", "content": "Figure 1: caption." }]}
                    ]}
                ]},
                { "page_idx": 1, "blocks": [
                    { "type": "page_number", "index": 0, "bbox": [0.45, 0.95, 0.55, 0.97],
                      "content": [{ "type": "text", "content": "2" }]}
                ]}
            ]
        });
        let text = serde_json::to_string(&middle).unwrap();
        let bytes = zip_fixture(&[("middle_json.json", text.as_bytes())]);
        let result = parse_result_zip(&bytes).unwrap();
        assert_eq!(result.rendered_pages, vec![(600, 800), (600, 800)]);
        let boxes = &result.pages[0].boxes;
        assert_eq!(boxes.len(), 3);
        assert_eq!(boxes[0].label, "doc_title");
        assert_eq!(boxes[0].coordinate, [60.0, 40.0, 540.0, 80.0]);
        assert_eq!(boxes[0].text.as_deref(), Some("Paper title"));
        assert_eq!(boxes[1].label, "image");
        // The caption sub-block keeps its own geometry.
        assert_eq!(boxes[2].label, "figure_title");
        assert_eq!(boxes[2].coordinate, [72.0, 408.0, 288.0, 424.0]);
        assert_eq!(boxes[2].text.as_deref(), Some("Figure 1: caption."));
        assert_eq!(result.pages[1].boxes[0].label, "number");
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
        // A self-hosted address with the switch off: FastAPI's 404 body has no
        // business code, so it must never probe green.
        let not_found: Value = serde_json::from_str(r#"{"detail":"Not Found"}"#).unwrap();
        assert!(!probe_token_valid(&not_found, StatusCode::NOT_FOUND));
        assert!(mineru_api_error("probe", &not_found, StatusCode::NOT_FOUND)
            .to_string()
            .contains("Self-hosted API"));
    }
}
