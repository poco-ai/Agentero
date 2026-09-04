//! Local PDF → `PAPER.md` via liteparse (no TeX papers).
//!
//! @see docs/backend/data-model.md § PAPER.md
//! @see docs/backend/api.md `paper_parse_body`

use crate::core::error::AppError;
use crate::features::catalog::{papers, probe_paper_caps, CapsCache};
#[cfg(not(any(target_os = "ios", target_os = "android")))]
use crate::features::pdf_locate::{LocateRequest, LocateResult};
#[cfg(not(any(target_os = "ios", target_os = "android")))]
use liteparse::config::{ImageMode, LiteParseConfig, OutputFormat};
#[cfg(not(any(target_os = "ios", target_os = "android")))]
use liteparse::LiteParse;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(not(any(target_os = "ios", target_os = "android")))]
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
#[cfg(not(any(target_os = "ios", target_os = "android")))]
use std::time::Duration;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const PAPER_MD: &str = "PAPER.md";
/// Cancellation is a user action, not a parse failure; `PaperParseResult::fail`
/// keys off this to avoid reporting cancelled work as broken.
pub(crate) const CANCELLED_MESSAGE: &str = "background task cancelled";
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const PDF_PARSE_WORKER_ARG: &str = "--agentero-internal-pdf-parse-worker";
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const PDF_PROBE_WORKER_ARG: &str = "--agentero-internal-pdf-recognize-worker";
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const PDF_RENDER_WORKER_ARG: &str = "--agentero-internal-pdf-render-worker";
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const PDF_LOCATE_WORKER_ARG: &str = "--agentero-internal-pdf-locate-worker";
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const PDF_PARSE_TIMEOUT: Duration = Duration::from_secs(120);
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const PDF_PROBE_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const PDF_LOCATE_TIMEOUT: Duration = Duration::from_secs(30);
/// Rendering many pages at 150 DPI can exceed the parse timeout on large PDFs.
#[cfg(all(
    feature = "desktop",
    not(any(target_os = "ios", target_os = "android"))
))]
const PDF_RENDER_TIMEOUT: Duration = Duration::from_secs(300);
/// Page cap for the VLM OCR engine (per-page cloud requests are costly).
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub(crate) const VLM_MAX_PAGES: usize = 100;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const RENDER_DPI: f32 = 150.0;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const MAX_CONCURRENT_PDF_PARSE: usize = 2;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const PDFIUM_LIB_PATH_ENV: &str = "PDFIUM_LIB_PATH";

#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub mod engines;

#[cfg(not(any(target_os = "ios", target_os = "android")))]
#[derive(Debug)]
struct PdfParseAdmission {
    key: PathBuf,
    _permit: OwnedSemaphorePermit,
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
impl Drop for PdfParseAdmission {
    fn drop(&mut self) {
        if let Ok(mut in_flight) = pdf_parse_in_flight().lock() {
            in_flight.remove(&self.key);
        }
    }
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn pdf_parse_limiter() -> &'static Arc<Semaphore> {
    static LIMITER: OnceLock<Arc<Semaphore>> = OnceLock::new();
    LIMITER.get_or_init(|| Arc::new(Semaphore::new(MAX_CONCURRENT_PDF_PARSE)))
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn pdf_parse_in_flight() -> &'static Mutex<HashSet<PathBuf>> {
    static IN_FLIGHT: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    IN_FLIGHT.get_or_init(|| Mutex::new(HashSet::new()))
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn pdf_parse_key(pdf_path: &Path) -> PathBuf {
    fs::canonicalize(pdf_path).unwrap_or_else(|_| pdf_path.to_path_buf())
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
async fn acquire_pdf_parse_permit(task_id: Option<&str>) -> Result<OwnedSemaphorePermit, AppError> {
    loop {
        if pdf_parse_task_is_cancelled(task_id) {
            return Err(AppError::message(CANCELLED_MESSAGE));
        }
        match pdf_parse_limiter().clone().try_acquire_owned() {
            Ok(permit) => return Ok(permit),
            Err(tokio::sync::TryAcquireError::NoPermits) => {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(tokio::sync::TryAcquireError::Closed) => {
                return Err(AppError::message("PDF parse limiter closed"));
            }
        }
    }
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
async fn enter_pdf_parse(
    pdf_path: &Path,
    task_id: Option<&str>,
) -> Result<Option<PdfParseAdmission>, AppError> {
    let permit = acquire_pdf_parse_permit(task_id).await?;
    if pdf_parse_task_is_cancelled(task_id) {
        return Err(AppError::message(CANCELLED_MESSAGE));
    }
    let key = pdf_parse_key(pdf_path);
    let mut in_flight = pdf_parse_in_flight()
        .lock()
        .map_err(|_| AppError::message("PDF parse in-flight set poisoned"))?;
    if !in_flight.insert(key.clone()) {
        return Ok(None);
    }
    Ok(Some(PdfParseAdmission {
        key,
        _permit: permit,
    }))
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperParseResult {
    pub paper_md: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_quality: Option<String>,
    /// Set only when the parse genuinely failed, never for a skip. Callers
    /// surface it as an error instead of reporting a silent success.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub messages: Vec<String>,
}

impl PaperParseResult {
    fn fail(&mut self, message: String) {
        if !message.contains(CANCELLED_MESSAGE) {
            self.error = Some(message.clone());
        }
        self.messages.push(message);
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperParseBodyArgs {
    pub vault_path: String,
    /// Vault-relative paper folder, e.g. `papers/1706.03762`.
    pub path: String,
    /// When true, overwrite existing `PAPER.md`. Default false.
    #[serde(default)]
    pub force: bool,
    /// Frontend background-task id; passed to the isolated parser worker for cancellation.
    #[serde(default)]
    pub task_id: Option<String>,
}

/// After PDF/TeX download: if no TeX and PDF present, generate `PAPER.md` when missing.
pub async fn maybe_generate_paper_md_after_download(
    vault: &Path,
    path_rel: &str,
    paper_dir: &Path,
) -> PaperParseResult {
    maybe_generate_paper_md_after_download_with_task(vault, path_rel, paper_dir, None).await
}

/// Auto-parse variant used by frontend background tasks.
///
/// `task_id` connects frontend cancellation to the parser worker. The parser
/// runs in a killable child process so a stuck PDFium/OCR call cannot keep the
/// import or download command alive indefinitely.
pub async fn maybe_generate_paper_md_after_download_with_task(
    vault: &Path,
    path_rel: &str,
    paper_dir: &Path,
    task_id: Option<&str>,
) -> PaperParseResult {
    parse_paper_body_inner(vault, path_rel, paper_dir, false, task_id, None).await
}

/// Manual / bulk parse entry (command).
pub async fn parse_paper_body(
    args: PaperParseBodyArgs,
    cache: Option<&CapsCache>,
) -> Result<PaperParseResult, AppError> {
    let vault = crate::core::fs::resolve_vault(&args.vault_path)?;
    let (paper_dir, path_rel) = crate::core::fs::resolve_paper_dir(&vault, &args.path)?;
    Ok(parse_paper_body_inner(
        &vault,
        &path_rel,
        &paper_dir,
        args.force,
        args.task_id.as_deref(),
        cache,
    )
    .await)
}

async fn parse_paper_body_inner(
    vault: &Path,
    path_rel: &str,
    paper_dir: &Path,
    force: bool,
    task_id: Option<&str>,
    cache: Option<&CapsCache>,
) -> PaperParseResult {
    let mut out = PaperParseResult::default();
    let caps = cache
        .map(|c| c.caps_for(vault, path_rel))
        .unwrap_or_else(|| probe_paper_caps(paper_dir));

    if caps.has_tex {
        out.messages.push("skip: local TeX present".into());
        return out;
    }

    if caps.has_paper_md && !force {
        out.paper_md = true;
        out.messages.push("PAPER.md already present".into());
        return out;
    }

    let Some(pdf_path) = caps.pdf_path else {
        out.messages.push("skip: no local PDF".into());
        return out;
    };

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    let _admission = match enter_pdf_parse(&pdf_path, task_id).await {
        Ok(Some(admission)) => admission,
        Ok(None) => {
            out.messages
                .push("skip: PDF parse already in flight".into());
            return out;
        }
        Err(e) => {
            out.fail(format!("liteparse failed: {e}"));
            return out;
        }
    };

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    let parse_result = engines::parse_body_with_engine(&pdf_path, task_id, &mut out.messages)
        .await
        .map(|o| (o.markdown, o.body_source, o.body_quality));
    #[cfg(any(target_os = "ios", target_os = "android"))]
    let parse_result = run_liteparse_markdown(&pdf_path, task_id).await;

    match parse_result {
        Ok((markdown, body_source, body_quality)) => {
            if markdown.trim().is_empty() {
                out.fail("liteparse returned empty text".into());
                return out;
            }
            match fs::write(paper_dir.join(PAPER_MD), &markdown) {
                Ok(()) => {
                    out.paper_md = true;
                    out.body_source = Some(body_source.clone());
                    out.body_quality = Some(body_quality.clone());
                    out.messages.push("PAPER.md written".into());
                    if let Err(e) =
                        update_catalog_body(vault, path_rel, &body_source, &body_quality)
                    {
                        out.messages
                            .push(format!("catalog body fields update failed: {e}"));
                    }
                }
                Err(e) => out.fail(format!("write PAPER.md failed: {e}")),
            }
        }
        Err(e) => out.fail(format!("liteparse failed: {e}")),
    }

    if let Some(c) = cache {
        c.invalidate(vault, path_rel);
    }

    out
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum PdfParseWorkerResponse {
    Ok {
        markdown: String,
        body_source: String,
        body_quality: String,
    },
    Err {
        message: String,
    },
}

/// One word's geometry from a PDF page, in liteparse viewport coords
/// (top-left origin, 72 DPI). Feeds the recognizer payload builder.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeWord {
    pub text: String,
    pub x_min: f32,
    pub y_min: f32,
    pub x_max: f32,
    pub y_max: f32,
    pub font_size: f32,
    /// Bottom of the word box; approximates the typographic baseline.
    pub baseline: f32,
    pub rotation: i32,
    pub bold: bool,
    pub italic: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_name: Option<String>,
}

/// One projected line's words, in reading order.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeLine {
    pub words: Vec<ProbeWord>,
}

/// Flattened first-pages line data for metadata recognition.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbePage {
    pub width: f32,
    pub height: f32,
    pub lines: Vec<ProbeLine>,
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum PdfProbeWorkerResponse {
    Ok { pages: Vec<ProbePage> },
    Err { message: String },
}

/// One page rendered to PNG by the render worker; `file` is the PNG name
/// inside the worker directory.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenderedPngPage {
    pub page_num: u32,
    pub width: u32,
    pub height: u32,
    pub file: String,
    pub is_solid_fill: bool,
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum PdfRenderWorkerResponse {
    Ok { pages: Vec<RenderedPngPage> },
    Err { message: String },
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum PdfLocateWorkerResponse {
    Ok { result: LocateResult },
    Err { message: String },
}

/// Keeps a worker temp directory alive (render output PNGs are read by the
/// parent after the worker exits); removed on drop.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
#[derive(Debug)]
pub(crate) struct WorkerDirGuard(PathBuf);

#[cfg(all(
    feature = "desktop",
    not(any(target_os = "ios", target_os = "android"))
))]
impl WorkerDirGuard {
    pub(crate) fn path(&self) -> &Path {
        &self.0
    }
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
impl Drop for WorkerDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
#[derive(Debug, PartialEq, Eq)]
struct PdfParseWorkerRequest {
    worker_arg: &'static str,
    pdf_path: PathBuf,
    response_path: PathBuf,
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn pdf_parse_worker_request_from_args(
    args: impl IntoIterator<Item = OsString>,
) -> Result<Option<PdfParseWorkerRequest>, String> {
    let mut args = args.into_iter();
    let _executable = args.next();
    let Some(mode) = args.next() else {
        return Ok(None);
    };
    let worker_arg = if mode == OsStr::new(PDF_PARSE_WORKER_ARG) {
        PDF_PARSE_WORKER_ARG
    } else if mode == OsStr::new(PDF_PROBE_WORKER_ARG) {
        PDF_PROBE_WORKER_ARG
    } else if mode == OsStr::new(PDF_RENDER_WORKER_ARG) {
        PDF_RENDER_WORKER_ARG
    } else if mode == OsStr::new(PDF_LOCATE_WORKER_ARG) {
        PDF_LOCATE_WORKER_ARG
    } else {
        return Ok(None);
    };
    let pdf_path = args
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| "PDF parse worker is missing its input path".to_string())?;
    let response_path = args
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| "PDF parse worker is missing its response path".to_string())?;
    if args.next().is_some() {
        return Err("PDF parse worker received unexpected arguments".to_string());
    }
    Ok(Some(PdfParseWorkerRequest {
        worker_arg,
        pdf_path,
        response_path,
    }))
}

/// Handle the private parser-worker mode before Tauri or CLI initialization.
///
/// Returns `None` for a normal application launch. Desktop entrypoints exit
/// immediately with the returned status code when worker mode is selected.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub fn try_run_pdf_parse_worker() -> Option<i32> {
    let request = match pdf_parse_worker_request_from_args(std::env::args_os()) {
        Ok(Some(request)) => request,
        Ok(None) => return None,
        Err(_) => return Some(2),
    };

    let response = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => {
            // Both response enums share the identical
            // `{"status":"err","message":…}` encoding, so failures from
            // either mode decode in the parent process.
            let outcome = if request.worker_arg == PDF_PROBE_WORKER_ARG {
                runtime
                    .block_on(run_liteparse_probe_direct(&request.pdf_path))
                    .map(|pages| PdfProbeWorkerResponse::Ok { pages })
                    .map_err(|error| error.to_string())
                    .and_then(|r| serde_json::to_value(&r).map_err(|e| e.to_string()))
            } else if request.worker_arg == PDF_RENDER_WORKER_ARG {
                let out_dir = request
                    .response_path
                    .parent()
                    .map(Path::to_path_buf)
                    .unwrap_or_else(std::env::temp_dir);
                runtime
                    .block_on(run_liteparse_render_direct(&request.pdf_path, &out_dir))
                    .map(|pages| PdfRenderWorkerResponse::Ok { pages })
                    .map_err(|error| error.to_string())
                    .and_then(|r| serde_json::to_value(&r).map_err(|e| e.to_string()))
            } else if request.worker_arg == PDF_LOCATE_WORKER_ARG {
                locate_worker_body(&request.pdf_path, &request.response_path)
                    .map(|result| PdfLocateWorkerResponse::Ok { result })
                    .map_err(|error| error.to_string())
                    .and_then(|r| serde_json::to_value(&r).map_err(|e| e.to_string()))
            } else {
                runtime
                    .block_on(run_liteparse_markdown_direct(&request.pdf_path))
                    .map(
                        |(markdown, body_source, body_quality)| PdfParseWorkerResponse::Ok {
                            markdown,
                            body_source,
                            body_quality,
                        },
                    )
                    .map_err(|error| error.to_string())
                    .and_then(|r| serde_json::to_value(&r).map_err(|e| e.to_string()))
            };
            match outcome {
                Ok(value) => value,
                Err(message) => serde_json::json!({ "status": "err", "message": message }),
            }
        }
        Err(error) => serde_json::json!({
            "status": "err",
            "message": format!("start PDF parse worker runtime: {error}"),
        }),
    };

    let result = serde_json::to_vec(&response)
        .map_err(|error| AppError::message(format!("serialize PDF parse result: {error}")))
        .and_then(|bytes| {
            fs::write(&request.response_path, bytes)
                .map_err(|error| AppError::message(format!("write PDF parse result: {error}")))
        });
    Some(if result.is_ok() { 0 } else { 1 })
}

#[cfg(any(target_os = "ios", target_os = "android"))]
pub fn try_run_pdf_parse_worker() -> Option<i32> {
    None
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn pdfium_lib_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "libpdfium.dylib"
    } else if cfg!(target_os = "windows") {
        "pdfium.dll"
    } else {
        "libpdfium.so"
    }
}

/// Directory holding the PDFium shared library shipped with the installed app.
///
/// liteparse `dlopen`s PDFium and `liteparse-pdfium-sys`'s build script bakes
/// the build machine's download cache path into the binary, which does not
/// exist on a user machine. `scripts/prepare-pdfium.mjs` stages the library
/// into the bundle instead; these are the places it lands.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn bundled_pdfium_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    let mut candidates = Vec::new();
    if cfg!(target_os = "macos") {
        candidates.push(exe_dir.join("../Frameworks"));
    }
    candidates.push(exe_dir.join("pdfium"));
    // deb / AppImage put bundle resources under /usr/lib/<product>/.
    candidates.push(exe_dir.join("../lib/agentero/pdfium"));
    candidates.push(exe_dir.join("../lib/Agentero/pdfium"));
    candidates.push(exe_dir.to_path_buf());

    let name = pdfium_lib_name();
    candidates.into_iter().find(|dir| dir.join(name).is_file())
}

/// `PDFIUM_LIB_PATH` to hand the worker, unless the caller already set one.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn pdfium_lib_path_override() -> Option<PathBuf> {
    if std::env::var_os(PDFIUM_LIB_PATH_ENV).is_some() {
        return None;
    }
    bundled_pdfium_dir()
}

/// Tail of the worker's stderr, so a panic that never reaches the response file
/// (a missing PDFium library aborts the process with exit code 101) still
/// reaches the user.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn worker_stderr_tail(path: &Path) -> Option<String> {
    const MAX_CHARS: usize = 800;
    let text = fs::read_to_string(path).ok()?;
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let mut tail: Vec<char> = text.chars().rev().take(MAX_CHARS).collect();
    tail.reverse();
    Some(tail.into_iter().collect())
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
async fn run_liteparse_markdown(
    pdf_path: &Path,
    task_id: Option<&str>,
) -> Result<(String, String, String), AppError> {
    let bytes =
        spawn_pdf_worker(PDF_PARSE_WORKER_ARG, pdf_path, task_id, PDF_PARSE_TIMEOUT).await?;
    let response = serde_json::from_slice::<PdfParseWorkerResponse>(&bytes).map_err(|error| {
        AppError::message(format!("decode isolated PDF parser response: {error}"))
    })?;
    match response {
        PdfParseWorkerResponse::Ok {
            markdown,
            body_source,
            body_quality,
        } => Ok((markdown, body_source, body_quality)),
        PdfParseWorkerResponse::Err { message } => Err(AppError::message(message)),
    }
}

/// Spawn the isolated parser worker in the given mode and return its raw
/// response bytes. Shared by the body-parse and metadata-probe paths.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
async fn spawn_pdf_worker(
    worker_arg: &str,
    pdf_path: &Path,
    task_id: Option<&str>,
    timeout_limit: Duration,
) -> Result<Vec<u8>, AppError> {
    let (bytes, _dir) =
        spawn_pdf_worker_with_dir(worker_arg, pdf_path, task_id, timeout_limit, None).await?;
    Ok(bytes)
}

/// Like [`spawn_pdf_worker`], but hands the worker directory back to the
/// caller (the render worker leaves page PNGs beside `response.json`).
///
/// `request_json` lands in `request.json` inside that directory for modes that
/// need more input than a PDF path.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
async fn spawn_pdf_worker_with_dir(
    worker_arg: &str,
    pdf_path: &Path,
    task_id: Option<&str>,
    timeout_limit: Duration,
    request_json: Option<&str>,
) -> Result<(Vec<u8>, WorkerDirGuard), AppError> {
    if pdf_parse_task_is_cancelled(task_id) {
        return Err(AppError::message(CANCELLED_MESSAGE));
    }
    let executable = std::env::current_exe()
        .map_err(|error| AppError::message(format!("resolve PDF parse worker: {error}")))?;
    let worker_dir = std::env::temp_dir().join(format!(
        "agentero-pdf-parse-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    fs::create_dir_all(&worker_dir).map_err(|error| {
        AppError::message(format!("create PDF parse worker directory: {error}"))
    })?;
    // Removes the directory on every early-error path and once the caller drops it.
    let dir_guard = WorkerDirGuard(worker_dir.clone());
    let response_path = worker_dir.join("response.json");
    let stderr_path = worker_dir.join("stderr.log");
    let stderr_sink = fs::File::create(&stderr_path)
        .map_err(|error| AppError::message(format!("create PDF parse worker log: {error}")))?;
    if let Some(payload) = request_json {
        fs::write(worker_dir.join("request.json"), payload)
            .map_err(|error| AppError::message(format!("write PDF worker request: {error}")))?;
    }

    let mut command = tokio::process::Command::new(executable);
    command
        .arg(worker_arg)
        .arg(pdf_path)
        .arg(&response_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr_sink))
        .kill_on_drop(true);
    if let Some(dir) = pdfium_lib_path_override() {
        command.env(PDFIUM_LIB_PATH_ENV, dir);
    }

    let mut child = command
        .spawn()
        .map_err(|error| AppError::message(format!("start isolated PDF parser: {error}")))?;

    let timeout = tokio::time::sleep(timeout_limit);
    tokio::pin!(timeout);
    let mut cancel_poll = tokio::time::interval(Duration::from_millis(100));
    cancel_poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let status = loop {
        tokio::select! {
            result = child.wait() => {
                break result.map_err(|error| AppError::message(format!(
                    "wait for isolated PDF parser: {error}"
                )))?;
            }
            _ = &mut timeout => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(AppError::message(format!(
                    "isolated PDF worker timed out after {}s",
                    timeout_limit.as_secs()
                )));
            }
            _ = cancel_poll.tick(), if task_id.is_some() => {
                if pdf_parse_task_is_cancelled(task_id) {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    return Err(AppError::message(CANCELLED_MESSAGE));
                }
            }
        }
    };

    let bytes = fs::read(&response_path).map_err(|error| {
        let tail = worker_stderr_tail(&stderr_path)
            .map(|tail| format!(": {tail}"))
            .unwrap_or_default();
        AppError::message(format!(
            "isolated PDF parser produced no response ({status}, {error}){tail}"
        ))
    })?;
    Ok((bytes, dir_guard))
}

/// Worker side of quote locating: the parent leaves the `LocateRequest` as
/// `request.json` beside `response.json`.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn locate_worker_body(pdf_path: &Path, response_path: &Path) -> Result<LocateResult, AppError> {
    let request_path = response_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("request.json");
    let raw = fs::read_to_string(&request_path)
        .map_err(|error| AppError::message(format!("read locate request: {error}")))?;
    let request: LocateRequest = serde_json::from_str(&raw)
        .map_err(|error| AppError::message(format!("decode locate request: {error}")))?;
    // std::fs read for the same reason as the parse path: FPDF_LoadDocument's
    // path handling is unreliable for non-ASCII paths on Windows.
    let data = fs::read(pdf_path).map_err(|e| AppError::message(format!("read pdf: {e}")))?;
    crate::features::pdf_locate::locate_in_pdf(&data, &request)
}

/// Resolve a quote to page rects in the isolated PDFium worker (killable, with
/// a hard timeout — an Agent-facing command must not hang on a broken PDF).
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub async fn run_pdf_locate(
    pdf_path: &Path,
    request: &LocateRequest,
) -> Result<LocateResult, AppError> {
    let payload = serde_json::to_string(request)
        .map_err(|error| AppError::message(format!("serialize locate request: {error}")))?;
    let (bytes, _dir) = spawn_pdf_worker_with_dir(
        PDF_LOCATE_WORKER_ARG,
        pdf_path,
        None,
        PDF_LOCATE_TIMEOUT,
        Some(&payload),
    )
    .await?;
    let response = serde_json::from_slice::<PdfLocateWorkerResponse>(&bytes).map_err(|error| {
        AppError::message(format!("decode isolated PDF locate response: {error}"))
    })?;
    match response {
        PdfLocateWorkerResponse::Ok { result } => Ok(result),
        PdfLocateWorkerResponse::Err { message } => Err(AppError::message(message)),
    }
}

/// Probe the first pages of a local PDF for metadata recognition.
/// Runs in the same isolated worker as body parsing (killable, PDFium-safe).
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub async fn run_liteparse_probe(
    pdf_path: &Path,
    task_id: Option<&str>,
) -> Result<Vec<ProbePage>, AppError> {
    let bytes =
        spawn_pdf_worker(PDF_PROBE_WORKER_ARG, pdf_path, task_id, PDF_PROBE_TIMEOUT).await?;
    let response = serde_json::from_slice::<PdfProbeWorkerResponse>(&bytes).map_err(|error| {
        AppError::message(format!("decode isolated PDF probe response: {error}"))
    })?;
    match response {
        PdfProbeWorkerResponse::Ok { pages } => Ok(pages),
        PdfProbeWorkerResponse::Err { message } => Err(AppError::message(message)),
    }
}

#[cfg(any(target_os = "ios", target_os = "android"))]
pub async fn run_liteparse_probe(
    _pdf_path: &Path,
    _task_id: Option<&str>,
) -> Result<Vec<ProbePage>, AppError> {
    Err(AppError::message(
        "PDF metadata recognition runs on the paired desktop host",
    ))
}

/// Render a local PDF's pages to PNG files in the isolated PDFium worker
/// (capped at [`VLM_MAX_PAGES`]). The returned guard owns the PNG directory.
#[cfg(all(
    feature = "desktop",
    not(any(target_os = "ios", target_os = "android"))
))]
pub(crate) async fn run_liteparse_render_pngs(
    pdf_path: &Path,
    task_id: Option<&str>,
) -> Result<(Vec<RenderedPngPage>, WorkerDirGuard), AppError> {
    let (bytes, dir_guard) = spawn_pdf_worker_with_dir(
        PDF_RENDER_WORKER_ARG,
        pdf_path,
        task_id,
        PDF_RENDER_TIMEOUT,
        None,
    )
    .await?;
    let response = serde_json::from_slice::<PdfRenderWorkerResponse>(&bytes).map_err(|error| {
        AppError::message(format!("decode isolated PDF render response: {error}"))
    })?;
    match response {
        PdfRenderWorkerResponse::Ok { pages } => Ok((pages, dir_guard)),
        PdfRenderWorkerResponse::Err { message } => Err(AppError::message(message)),
    }
}

/// Worker body for the render mode: write per-page PNGs into `out_dir`.
///
/// `render_pages_to_png` errors on out-of-range page numbers, so a cheap
/// capped text pass determines how many pages exist (≤ [`VLM_MAX_PAGES`]).
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub(crate) async fn run_liteparse_render_direct(
    pdf_path: &Path,
    out_dir: &Path,
) -> Result<Vec<RenderedPngPage>, AppError> {
    let data = fs::read(pdf_path).map_err(|e| AppError::message(format!("read pdf: {e}")))?;
    let input = liteparse::types::PdfInput::Bytes(data);
    let page_count =
        liteparse::extract::extract_pages_from_input(&input, None, VLM_MAX_PAGES, None)
            .map_err(|e| AppError::message(format!("liteparse page scan: {e}")))?
            .len();
    if page_count == 0 {
        return Err(AppError::message("PDF has no pages"));
    }
    let numbers: Vec<u32> = (1..=page_count as u32).collect();
    let rendered = liteparse::render::render_pages_to_png(
        &input,
        Some(&numbers),
        RENDER_DPI,
        None,
        false,
        false,
    )
    .map_err(|e| AppError::message(format!("liteparse render: {e}")))?;
    let mut pages = Vec::with_capacity(rendered.len());
    for page in rendered {
        let file = format!("page-{:04}.png", page.page_num);
        fs::write(out_dir.join(&file), &page.png_bytes)
            .map_err(|e| AppError::message(format!("write page png: {e}")))?;
        pages.push(RenderedPngPage {
            page_num: page.page_num,
            width: page.width,
            height: page.height,
            file,
            is_solid_fill: page.is_solid_fill,
        });
    }
    Ok(pages)
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn pdf_parse_task_is_cancelled(task_id: Option<&str>) -> bool {
    task_id.is_some_and(crate::features::import::is_background_task_cancelled)
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
async fn run_liteparse_markdown_direct(
    pdf_path: &Path,
) -> Result<(String, String, String), AppError> {
    // Read the PDF via std::fs (Unicode-safe on Windows) and hand PDFium an
    // in-memory buffer. `FPDF_LoadDocument`'s path handling is unreliable for
    // non-ASCII paths on Windows (e.g. a Chinese `文档` segment in a OneDrive
    // vault path), which made Zotero-imported papers silently fail to produce
    // PAPER.md; `FPDF_LoadMemDocument` (used for `PdfInput::Bytes`) has no path
    // step and is immune.
    let data = fs::read(pdf_path).map_err(|e| AppError::message(format!("read pdf: {e}")))?;

    // Prefer native text; OCR is best-effort and must not abort the whole parse.
    let config = LiteParseConfig {
        ocr_enabled: true,
        ocr_failure_fatal: false,
        output_format: OutputFormat::Markdown,
        image_mode: ImageMode::Off,
        quiet: true,
        max_pages: 500,
        extract_links: true,
        ..Default::default()
    };

    let parser = LiteParse::new(config);

    // Complexity pre-pass for quality labeling (cheap text-layer only).
    let needs_ocr = match parser
        .is_complex(liteparse::types::PdfInput::Bytes(data.clone()))
        .await
    {
        Ok(pages) => pages.iter().any(|p| p.needs_ocr),
        Err(_) => false,
    };

    let result = parser
        .parse_input(liteparse::types::PdfInput::Bytes(data))
        .await
        .map_err(|e| AppError::message(format!("liteparse: {e}")))?;

    let (body_source, body_quality) = if needs_ocr {
        ("ocr".to_string(), "low".to_string())
    } else {
        ("pdf".to_string(), "medium".to_string())
    };

    Ok((result.text, body_source, body_quality))
}

#[cfg(any(target_os = "ios", target_os = "android"))]
async fn run_liteparse_markdown(
    _pdf_path: &Path,
    _task_id: Option<&str>,
) -> Result<(String, String, String), AppError> {
    Err(AppError::message(
        "PDF body parsing runs on the paired desktop host",
    ))
}

/// Worker body for the metadata probe: first pages only, native text,
/// word boxes on. Mirrors Zotero's `PDFWorker.getRecognizerData` scope.
/// Also called directly (no worker subprocess) by in-crate live tests.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub(crate) async fn run_liteparse_probe_direct(
    pdf_path: &Path,
) -> Result<Vec<ProbePage>, AppError> {
    let data = fs::read(pdf_path).map_err(|e| AppError::message(format!("read pdf: {e}")))?;

    let config = LiteParseConfig {
        ocr_enabled: false,
        output_format: OutputFormat::Text,
        image_mode: ImageMode::Off,
        quiet: true,
        max_pages: PROBE_MAX_PAGES,
        target_pages: Some("1-5".to_string()),
        emit_word_boxes: true,
        ..Default::default()
    };
    let parser = LiteParse::new(config);
    let result = parser
        .parse_input(liteparse::types::PdfInput::Bytes(data))
        .await
        .map_err(|e| AppError::message(format!("liteparse probe: {e}")))?;

    Ok(result
        .pages
        .iter()
        .take(PROBE_MAX_PAGES)
        .map(probe_page_from_parsed)
        .collect())
}

/// Number of leading pages the recognizer probe extracts (Zotero uses 5).
#[cfg(not(any(target_os = "ios", target_os = "android")))]
const PROBE_MAX_PAGES: usize = 5;

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn probe_page_from_parsed(page: &liteparse::types::ParsedPage) -> ProbePage {
    // Use liteparse's projected lines (the same decomposition the Markdown
    // emitter consumes): rotated margin stamps land in their own lines
    // instead of polluting body lines, matching the reading order real
    // Zotero payloads get from PDF.js line structure.
    let mut lines = Vec::with_capacity(page.projected_lines.len());
    for line in &page.projected_lines {
        let mut words = Vec::new();
        let fallback_size = if line.dominant_font_size > 0.1 {
            line.dominant_font_size
        } else {
            line.bbox.height.max(6.0)
        };
        let mut spans: Vec<&liteparse::types::TextItem> = line.spans.iter().collect();
        // `spans` is x-ascending; RTL lines read right-to-left.
        if line.rtl {
            spans.reverse();
        }
        for span in spans {
            collect_probe_words(span, fallback_size, &mut words);
        }
        if !words.is_empty() {
            lines.push(ProbeLine { words });
        }
    }
    ProbePage {
        width: page.page_width,
        height: page.page_height,
        lines,
    }
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn collect_probe_words(
    item: &liteparse::types::TextItem,
    fallback_size: f32,
    out: &mut Vec<ProbeWord>,
) {
    let text = item.text.trim();
    if text.is_empty() {
        return;
    }
    let font_size = item.font_size.unwrap_or(item.height).max(0.1);
    let font_name = item.font_name.clone();
    let name_lower = font_name
        .as_deref()
        .map(|n| n.to_ascii_lowercase())
        .unwrap_or_default();
    let bold = item.font_weight.is_some_and(|w| w >= 600) || name_lower.contains("bold");
    let italic = item.font_flags.is_some_and(|f| f & 2 != 0)
        || name_lower.contains("italic")
        || name_lower.contains("oblique");
    let rotation = item.rotation.round() as i32;
    let size = if font_size > 0.1 {
        font_size
    } else {
        fallback_size
    };
    let make = |text: String, x: f32, y: f32, w: f32, h: f32| ProbeWord {
        text,
        x_min: x,
        y_min: y,
        x_max: x + w,
        y_max: y + h,
        baseline: y + h,
        font_size: size,
        rotation,
        bold,
        italic,
        font_name: font_name.clone(),
    };

    if item.words.is_empty() {
        out.push(make(
            item.text.trim().to_string(),
            item.x,
            item.y,
            item.width,
            item.height,
        ));
        return;
    }
    for word in &item.words {
        let wt = word.text.trim();
        if wt.is_empty() {
            continue;
        }
        out.push(make(
            wt.to_string(),
            word.x,
            word.y,
            word.width,
            word.height,
        ));
    }
}

fn update_catalog_body(
    vault: &Path,
    path_rel: &str,
    body_source: &str,
    body_quality: &str,
) -> Result<(), AppError> {
    let Some(mut row) = papers::get_by_path(vault, path_rel)? else {
        // No catalog row yet — still wrote PAPER.md; skip SQLite.
        return Ok(());
    };
    row.body_source = Some(body_source.to_string());
    row.body_quality = Some(body_quality.to_string());
    row.updated_at = crate::core::time::now_rfc3339_millis();
    papers::upsert_paper(vault, &row)?;
    Ok(())
}

#[cfg(all(test, not(any(target_os = "ios", target_os = "android"))))]
mod tests {
    use super::*;

    #[test]
    fn fail_records_real_errors_but_not_cancellation() {
        let mut broken = PaperParseResult::default();
        broken.fail("liteparse failed: could not find pdfium".into());
        assert_eq!(
            broken.error.as_deref(),
            Some("liteparse failed: could not find pdfium")
        );
        assert_eq!(broken.messages.len(), 1);

        let mut cancelled = PaperParseResult::default();
        cancelled.fail(format!("liteparse failed: {CANCELLED_MESSAGE}"));
        assert!(cancelled.error.is_none());
        assert_eq!(cancelled.messages.len(), 1);
    }

    #[test]
    fn worker_stderr_tail_skips_empty_and_truncates() {
        let dir = std::env::temp_dir().join(format!("pdf-parse-stderr-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();

        let missing = dir.join("absent.log");
        assert!(worker_stderr_tail(&missing).is_none());

        let blank = dir.join("blank.log");
        fs::write(&blank, "  \n\n").unwrap();
        assert!(worker_stderr_tail(&blank).is_none());

        let long = dir.join("long.log");
        fs::write(&long, format!("{}tail-marker", "x".repeat(4000))).unwrap();
        let tail = worker_stderr_tail(&long).unwrap();
        assert_eq!(tail.chars().count(), 800);
        assert!(tail.ends_with("tail-marker"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn worker_args_are_private_and_exact() {
        let normal = vec![OsString::from("agentero"), OsString::from("paper")];
        assert_eq!(pdf_parse_worker_request_from_args(normal).unwrap(), None);

        let request = pdf_parse_worker_request_from_args(vec![
            OsString::from("agentero"),
            OsString::from(PDF_PARSE_WORKER_ARG),
            OsString::from("input.pdf"),
            OsString::from("response.json"),
        ])
        .unwrap()
        .unwrap();
        assert_eq!(request.pdf_path, PathBuf::from("input.pdf"));
        assert_eq!(request.response_path, PathBuf::from("response.json"));

        let render = pdf_parse_worker_request_from_args(vec![
            OsString::from("agentero"),
            OsString::from(PDF_RENDER_WORKER_ARG),
            OsString::from("input.pdf"),
            OsString::from("response.json"),
        ])
        .unwrap()
        .unwrap();
        assert_eq!(render.worker_arg, PDF_RENDER_WORKER_ARG);

        let incomplete = vec![
            OsString::from("agentero"),
            OsString::from(PDF_PARSE_WORKER_ARG),
            OsString::from("input.pdf"),
        ];
        assert!(pdf_parse_worker_request_from_args(incomplete).is_err());
    }

    #[test]
    fn worker_response_round_trips_success_and_failure() {
        for response in [
            PdfParseWorkerResponse::Ok {
                markdown: "# Paper".into(),
                body_source: "pdf".into(),
                body_quality: "medium".into(),
            },
            PdfParseWorkerResponse::Err {
                message: "broken PDF".into(),
            },
        ] {
            let encoded = serde_json::to_vec(&response).unwrap();
            let decoded: PdfParseWorkerResponse = serde_json::from_slice(&encoded).unwrap();
            assert_eq!(
                serde_json::to_value(decoded).unwrap(),
                serde_json::to_value(response).unwrap()
            );
        }
    }

    #[tokio::test]
    async fn pdf_parse_admission_rejects_duplicate_until_guard_drops() {
        let pdf_path =
            std::env::temp_dir().join(format!("pdf-parse-admission-{}.pdf", uuid::Uuid::new_v4()));

        let first = enter_pdf_parse(&pdf_path, None)
            .await
            .unwrap()
            .expect("first parse should enter admission");
        let duplicate = enter_pdf_parse(&pdf_path, None).await.unwrap();

        assert!(duplicate.is_none());

        drop(first);

        let next = enter_pdf_parse(&pdf_path, None).await.unwrap();
        assert!(next.is_some());
    }

    #[tokio::test]
    async fn cancelled_task_does_not_enter_pdf_parse_admission() {
        let task_id = format!("pdf-parse-test-{}", uuid::Uuid::new_v4());
        crate::core::background_tasks::cancel(&task_id);

        let result = enter_pdf_parse(Path::new("missing-test-input.pdf"), Some(&task_id)).await;

        crate::core::background_tasks::finish(&task_id);
        assert_eq!(result.unwrap_err().to_string(), "background task cancelled");
    }

    #[tokio::test]
    async fn cancelled_task_does_not_start_parser_worker() {
        let task_id = format!("pdf-parse-test-{}", uuid::Uuid::new_v4());
        crate::core::background_tasks::cancel(&task_id);

        let result =
            run_liteparse_markdown(Path::new("missing-test-input.pdf"), Some(&task_id)).await;

        crate::core::background_tasks::finish(&task_id);
        assert_eq!(result.unwrap_err().to_string(), "background task cancelled");
    }
}
