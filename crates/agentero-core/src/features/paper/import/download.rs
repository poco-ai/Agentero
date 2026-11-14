//! Paper asset download: PDF + arXiv LaTeX source fetch, byte progress aggregation,
//! and on-demand re-download for an existing paper folder.
//!
//! Flow:
//! - `ensure_paper_assets*` is used by the commit pipeline to fetch resources for
//!   a freshly created paper folder.
//! - `download_paper_assets*` is the on-demand entry for an existing folder
//!   (Library right-click / CLI `paper download`).
//! - Always try PDF; arXiv IDs also try e-print TeX; caller runs liteparse when
//!   no TeX is available.

use super::{institution_proxy, AppHandle, PaperDownloadAssetsArgs};
use crate::error::AppError;
use crate::features::catalog::{papers, probe_paper_caps, CapsCache};
use crate::features::paper::source::{self, SourceStatus};
use crate::features::scholar_api::identifiers::{extract_arxiv_id, strip_arxiv_version};
use crate::http;
use flate2::read::GzDecoder;
use serde::Serialize;
use std::fs::{self, File};
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tar::Archive;

/// Upper bound for the network asset phase of one paper import.
///
/// Individual requests have shorter reqwest timeouts, but an import may try
/// several PDF fallbacks before fetching the arXiv source. Keep the whole
/// phase bounded so one paper cannot hold an import task indefinitely.
pub const PAPER_ASSET_TIMEOUT: Duration = Duration::from_secs(3 * 60);

#[derive(Debug, Default, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AssetDownloadResult {
    pub pdf: bool,
    pub tex: bool,
    /// True when `PAPER.md` was written (or already present after auto-parse).
    #[serde(default)]
    pub paper_md: bool,
    pub messages: Vec<String>,
    /// Follow-up steps for this download. Not part of the IPC payload.
    #[serde(skip)]
    #[specta(skip)]
    pub preparation: super::preparation::PreparationPlan,
}

/// Byte/count progress wire event for projected JobCenter rows. `task_id`
/// carries the JobCenter job id; the desktop contract mirror lives in
/// `events_contract.rs` (`JobProgressEvent`). Host-side emitters go through
/// `features::jobs::emit_job_progress`; core emitters share this name.
pub const JOB_PROGRESS_EVENT: &str = "job:progress";

#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetDownloadProgress {
    pub task_id: String,
    pub phase: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub progress: Option<u8>,
    /// Optional item counters for batch operations (e.g. import 2/5).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_count: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_count: Option<usize>,
}

#[derive(Clone, Copy)]
pub struct AssetProgressContext<'a> {
    pub app: Option<&'a AppHandle>,
    pub task_id: Option<&'a str>,
}

/// Throttle byte-level download progress events.
///
/// reqwest yields 8–16KB chunks, so a 20MB PDF used to emit 1000–2500
/// `job:progress` events (×5 with batch import concurrency),
/// flooding the webview event loop. Emit only when enough time passed or the
/// percentage actually moved; the caller emits the final value unconditionally
/// when the download completes.
pub(crate) struct ProgressThrottle {
    min_interval: Duration,
    last_emit: Option<std::time::Instant>,
    last_percent: Option<u8>,
}

impl ProgressThrottle {
    pub(crate) fn new(min_interval: Duration) -> Self {
        Self {
            min_interval,
            last_emit: None,
            last_percent: None,
        }
    }

    /// True when this sample should be emitted: first sample, ≥ interval since
    /// the last emit, or the percent moved by ≥ 1 point since the last emit.
    pub(crate) fn should_emit(&mut self, now: std::time::Instant, percent: Option<u8>) -> bool {
        let elapsed_ok = match self.last_emit {
            None => true,
            Some(last) => now.duration_since(last) >= self.min_interval,
        };
        let percent_moved = match (self.last_percent, percent) {
            (Some(prev), Some(cur)) => cur != prev,
            (None, Some(_)) => true,
            _ => false,
        };
        if !elapsed_ok && !percent_moved {
            return false;
        }
        self.last_emit = Some(now);
        if percent.is_some() {
            self.last_percent = percent;
        }
        true
    }
}

/// Minimum spacing between byte-progress events when the percent is unknown.
pub(crate) const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(100);

/// Byte progress of one download stream inside an [`AssetProgressAggregator`].
#[derive(Debug, Clone, Copy, Default)]
struct ProgressSlot {
    downloaded: u64,
    total: Option<u64>,
    /// The stream ended (saved or gave up), so its size is final and a missing
    /// `Content-Length` no longer holds the merged total back.
    finished: bool,
}

/// Merged totals across every stream sharing one JobCenter row.
///
/// A stream still running with no `Content-Length` keeps the merged size
/// unknown: guessing at it would let the other stream read 100% on its own.
fn merged_progress(slots: &[ProgressSlot]) -> (u64, Option<u64>, Option<u8>) {
    let mut downloaded = 0_u64;
    let mut total = 0_u64;
    for slot in slots {
        downloaded = downloaded.saturating_add(slot.downloaded);
        let Some(size) = slot
            .total
            .or_else(|| slot.finished.then_some(slot.downloaded))
        else {
            return (downloaded, None, None);
        };
        total = total.saturating_add(size);
    }
    let percent = ((downloaded.saturating_mul(100) / total.max(1)).min(100)) as u8;
    (downloaded, Some(total), Some(percent))
}

/// Merges the byte progress of every stream that shares one JobCenter row.
///
/// PDF and TeX share a single `task_id`, so per-phase
/// percentages cannot be weighted on the frontend: whichever stream finished
/// first pinned the shared bar at 100% while the other was still fetching.
/// The slot count fixed at construction is the denominator, which also keeps a
/// PDF-only import (no TeX stream) spanning the whole bar.
pub(crate) struct AssetProgressAggregator<'a> {
    app: Option<&'a AppHandle>,
    task_id: Option<&'a str>,
    phase: &'static str,
    state: Mutex<AggregatorState>,
}

struct AggregatorState {
    slots: Vec<ProgressSlot>,
    throttle: ProgressThrottle,
}

impl<'a> AssetProgressAggregator<'a> {
    pub(crate) fn new(
        app: Option<&'a AppHandle>,
        task_id: Option<&'a str>,
        phase: &'static str,
        streams: usize,
    ) -> Self {
        Self {
            app,
            task_id,
            phase,
            state: Mutex::new(AggregatorState {
                slots: vec![ProgressSlot::default(); streams.max(1)],
                throttle: ProgressThrottle::new(PROGRESS_EMIT_INTERVAL),
            }),
        }
    }

    /// Handle for one stream of this aggregator.
    pub(crate) fn stream(&self, slot: usize) -> StreamProgress<'_, 'a> {
        StreamProgress { agg: self, slot }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, AggregatorState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Build the wire payload, or `None` when the throttle swallowed it.
    fn sample(&self, state: &mut AggregatorState, force: bool) -> Option<AssetDownloadProgress> {
        let task_id = self.task_id?;
        let (downloaded_bytes, total_bytes, progress) = merged_progress(&state.slots);
        if !force
            && !state
                .throttle
                .should_emit(std::time::Instant::now(), progress)
        {
            return None;
        }
        Some(AssetDownloadProgress {
            task_id: task_id.to_string(),
            phase: self.phase.to_string(),
            downloaded_bytes,
            total_bytes,
            progress,
            current_count: None,
            total_count: None,
        })
    }

    fn emit_progress(&self, payload: Option<AssetDownloadProgress>) {
        let (Some(app), Some(payload)) = (self.app, payload) else {
            return;
        };
        app.emit(JOB_PROGRESS_EVENT, &payload);
    }
}

/// One stream's view into an [`AssetProgressAggregator`].
#[derive(Clone, Copy)]
pub(crate) struct StreamProgress<'agg, 'ctx> {
    agg: &'agg AssetProgressAggregator<'ctx>,
    slot: usize,
}

impl<'agg, 'ctx> StreamProgress<'agg, 'ctx> {
    pub(crate) fn task_id(&self) -> Option<&'ctx str> {
        self.agg.task_id
    }

    /// The next candidate URL starts its byte count over (PDF fallbacks).
    fn restart(&self) {
        if let Some(slot) = self.agg.lock().slots.get_mut(self.slot) {
            *slot = ProgressSlot::default();
        }
    }

    fn record(&self, downloaded: u64, total: Option<u64>, force: bool) {
        let payload = {
            let mut state = self.agg.lock();
            if let Some(slot) = state.slots.get_mut(self.slot) {
                slot.downloaded = downloaded;
                slot.total = total;
            }
            self.agg.sample(&mut state, force)
        };
        self.agg.emit_progress(payload);
    }

    pub(crate) fn report(&self, downloaded: u64, total: Option<u64>) {
        self.record(downloaded, total, false);
    }

    /// The stream ended. Always emits: the merged bar must reach the final
    /// byte count even when the throttle swallowed the last chunk, and a
    /// stream that gave up before any byte landed must not keep the merged
    /// total unknown forever.
    pub(crate) fn finish(&self) {
        let payload = {
            let mut state = self.agg.lock();
            if let Some(slot) = state.slots.get_mut(self.slot) {
                slot.finished = true;
            }
            self.agg.sample(&mut state, true)
        };
        self.agg.emit_progress(payload);
    }
}

/// Download missing PDF (always try when URL known) and arXiv LaTeX source.
///
/// - **PDF** → paper folder root: `{paper}/{id}.pdf` (not under `source/`)
/// - **TeX** (arXiv e-print) → `{paper}/source/`
///
/// PDF lands first to pin the source to its arXiv version stamp; both streams
/// share byte progress. The body preparation chooses TeX before PDF parsing.
pub async fn ensure_paper_assets(
    paper_dir: &Path,
    id: &str,
    arxiv_id: Option<&str>,
    pdf_url: Option<&str>,
    doi: Option<&str>,
) -> Result<AssetDownloadResult, AppError> {
    ensure_paper_assets_with_cookies(paper_dir, id, arxiv_id, pdf_url, doi, None).await
}

#[allow(clippy::too_many_arguments)]
pub async fn ensure_paper_assets_with_progress(
    paper_dir: &Path,
    vault: &Path,
    paper_path: &str,
    id: &str,
    arxiv_id: Option<&str>,
    pdf_url: Option<&str>,
    doi: Option<&str>,
    cookies: Option<&str>,
    cache: Option<&CapsCache>,
    progress: AssetProgressContext<'_>,
) -> Result<AssetDownloadResult, AppError> {
    tokio::time::timeout(
        PAPER_ASSET_TIMEOUT,
        ensure_paper_assets_impl(
            paper_dir, vault, paper_path, id, arxiv_id, pdf_url, doi, cookies, cache, progress,
            true,
        ),
    )
    .await
    .map_err(|_| {
        AppError::message(format!(
            "asset download timeout after {}s",
            PAPER_ASSET_TIMEOUT.as_secs()
        ))
    })?
}

/// Variant used by browser integrations that provide the page's cookie jar.
/// The cookie string is only sent to the explicitly supplied attachment URL.
pub async fn ensure_paper_assets_with_cookies(
    paper_dir: &Path,
    id: &str,
    arxiv_id: Option<&str>,
    pdf_url: Option<&str>,
    doi: Option<&str>,
    cookies: Option<&str>,
) -> Result<AssetDownloadResult, AppError> {
    tokio::time::timeout(
        PAPER_ASSET_TIMEOUT,
        ensure_paper_assets_impl(
            paper_dir,
            paper_dir,
            "",
            id,
            arxiv_id,
            pdf_url,
            doi,
            cookies,
            None,
            AssetProgressContext {
                app: None,
                task_id: None,
            },
            false,
        ),
    )
    .await
    .map_err(|_| {
        AppError::message(format!(
            "asset download timeout after {}s",
            PAPER_ASSET_TIMEOUT.as_secs()
        ))
    })?
}

#[derive(Debug, Default)]
struct PdfAssetResult {
    ok: bool,
    messages: Vec<String>,
}

#[derive(Debug, Default)]
struct TexAssetResult {
    messages: Vec<String>,
    error: Option<AppError>,
}

#[allow(clippy::too_many_arguments)]
async fn ensure_paper_assets_impl(
    paper_dir: &Path,
    vault: &Path,
    paper_path: &str,
    id: &str,
    arxiv_id: Option<&str>,
    pdf_url: Option<&str>,
    doi: Option<&str>,
    cookies: Option<&str>,
    cache: Option<&CapsCache>,
    progress: AssetProgressContext<'_>,
    retry_source: bool,
) -> Result<AssetDownloadResult, AppError> {
    super::check_task_not_cancelled(progress.task_id)?;
    let mut out = AssetDownloadResult::default();
    fs::create_dir_all(paper_dir)?;

    let before = probe_paper_caps(paper_dir);
    let need_pdf = !before.has_pdf();
    let need_tex = !before.has_tex;
    let request = source::asset_request(arxiv_id, pdf_url, None);
    let tex_arxiv_id = request.as_deref();

    // Both streams share one JobCenter row, so their byte progress is merged
    // here instead of being weighted per phase in the frontend. The slot count
    // is the denominator: a stream that never starts must not let the other
    // one reach 100%.
    let streams = usize::from(need_pdf) + usize::from(need_tex && tex_arxiv_id.is_some());
    let aggregator = AssetProgressAggregator::new(
        progress.app,
        progress.task_id,
        if streams > 1 {
            "assets"
        } else if need_pdf {
            "pdf"
        } else {
            "tex"
        },
        streams,
    );
    let pdf_stream = aggregator.stream(0);
    let tex_stream = aggregator.stream(usize::from(need_pdf));

    let pdf_task = async {
        if !need_pdf {
            return PdfAssetResult {
                ok: true,
                messages: vec!["pdf already present".into()],
            };
        }
        let res = fetch_pdf_assets(
            paper_dir,
            id,
            tex_arxiv_id,
            pdf_url,
            doi,
            cookies,
            pdf_stream,
        )
        .await;
        // The candidate loop may have given up before any byte landed.
        pdf_stream.finish();
        res
    };

    let tex_task = async {
        if !need_tex {
            return TexAssetResult {
                messages: vec!["tex already present".into()],
                ..Default::default()
            };
        }
        let Some(aid) = tex_arxiv_id else {
            return TexAssetResult::default();
        };
        let res = match prepare_arxiv_source_with_progress(paper_dir, aid, tex_stream, retry_source)
            .await
        {
            Ok(tex) => TexAssetResult {
                messages: vec![if tex {
                    "tex ready"
                } else {
                    "e-print has no TeX"
                }
                .into()],
                ..Default::default()
            },
            Err(error) => TexAssetResult {
                messages: vec![format!("tex failed: {error}")],
                error: Some(error),
            },
        };
        tex_stream.finish();
        res
    };

    // Land the PDF first so its native arXiv version stamp can pin the source.
    let pdf_res = pdf_task.await;
    let tex_res = tex_task.await;
    let tex_error = tex_res.error;
    out.messages.extend(pdf_res.messages);
    out.messages.extend(tex_res.messages);

    // Refresh presence after attempts. Directory content may have changed, so
    // invalidate any cached entry first; caps_for then re-probes and caches.
    if let Some(c) = cache {
        c.invalidate(vault, paper_path);
    }
    let after = cache
        .map(|c| c.caps_for(vault, paper_path))
        .unwrap_or_else(|| probe_paper_caps(paper_dir));
    if after.has_pdf() {
        out.pdf = true;
    }
    if after.has_tex {
        out.tex = true;
    }
    out.paper_md = after.has_paper_md;
    if !paper_path.is_empty() {
        source::reconcile_body(vault, paper_path)?;
    }
    if after.has_pdf() && !paper_path.is_empty() {
        super::code_repo::fill_code_repo_from_pdf(vault, paper_path).await;
    }
    super::check_task_not_cancelled(progress.task_id)?;

    if let Some(error) = tex_error {
        return Err(error);
    }
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
async fn fetch_pdf_assets(
    paper_dir: &Path,
    id: &str,
    arxiv_id: Option<&str>,
    pdf_url: Option<&str>,
    doi: Option<&str>,
    cookies: Option<&str>,
    progress: StreamProgress<'_, '_>,
) -> PdfAssetResult {
    let mut out = PdfAssetResult::default();
    let mut candidates = pdf_url_candidates(id, arxiv_id, pdf_url);
    let mut ok = try_download_candidates_with_cookies(
        paper_dir,
        id,
        &candidates,
        &mut out,
        cookies,
        progress,
    )
    .await;
    // DOI fallback: Crossref often lists a direct / open-access PDF link even
    // when the Translator gave no pdf_url (or the publisher landing page failed).
    if !ok {
        if let Err(e) = super::check_task_not_cancelled(progress.task_id()) {
            out.messages.push(format!("pdf cancelled: {e}"));
            return out;
        }
        if let Some(doi) = doi.map(str::trim).filter(|s| !s.is_empty()) {
            let extra: Vec<String> = crossref_pdf_urls(doi)
                .await
                .into_iter()
                .filter(|u| !candidates.iter().any(|c| c == u))
                .collect();
            if extra.is_empty() {
                out.messages
                    .push("pdf: no Crossref PDF link for DOI".into());
            } else {
                ok = try_download_candidates_with_cookies(
                    paper_dir, id, &extra, &mut out, cookies, progress,
                )
                .await;
                candidates.extend(extra);
            }
        }
    }
    // Unpaywall fallback: open-access PDF for DOI papers (helps some ACM/IEEE
    // and other paywalled papers that have an OA copy; no API key required).
    if !ok {
        if let Err(e) = super::check_task_not_cancelled(progress.task_id()) {
            out.messages.push(format!("pdf cancelled: {e}"));
            return out;
        }
        if let Some(doi) = doi.map(str::trim).filter(|s| !s.is_empty()) {
            if let Some(url) = unpaywall_pdf_url(doi).await {
                if !candidates.iter().any(|c| c == &url) {
                    ok = try_download_candidates_with_cookies(
                        paper_dir,
                        id,
                        std::slice::from_ref(&url),
                        &mut out,
                        cookies,
                        progress,
                    )
                    .await;
                    candidates.push(url);
                }
            }
        }
    }
    // Institution proxy fallback (EZProxy/WebVPN): rewrite the DOI target
    // through the user's proxy prefix + session cookie. Only active when the
    // host configured one; uses the user's own institution subscription.
    if !ok {
        if let Err(e) = super::check_task_not_cancelled(progress.task_id()) {
            out.messages.push(format!("pdf cancelled: {e}"));
            return out;
        }
        if let Some(doi) = doi.map(str::trim).filter(|s| !s.is_empty()) {
            // Direct connection first: on campus networks the institution IP
            // carries the subscription, so this needs zero configuration.
            // Falls back to the configured gateway (if any) when it fails.
            let outcome = institution_proxy::fetch_pdf(doi).await;
            out.messages.extend(outcome.messages);
            if let Some(bytes) = outcome.bytes {
                let name = safe_filename(id, "pdf");
                match fs::write(paper_dir.join(name), &bytes) {
                    Ok(()) => {
                        if let Some(source) = outcome.source {
                            out.messages
                                .push(format!("pdf ok via institution proxy ({source})"));
                        }
                        ok = true;
                    }
                    Err(e) => out
                        .messages
                        .push(format!("institution proxy write failed: {e}")),
                }
            }
        }
    }
    if !ok && candidates.is_empty() {
        out.messages.push("pdf: no url".into());
    }
    out.ok = ok;
    out
}

/// Pick the e-print id. A stamp read from the local PDF pins the download,
/// including when the save itself was unversioned. An explicit version that
/// disagrees with that stamp is refused. With no stamp the request is kept:
/// a bare id is arXiv's latest version.
fn resolve_eprint_request(requested: &str, stamp: Option<&str>) -> Result<String, String> {
    let bare = strip_arxiv_version(requested);
    if let Some(versioned) = stamp {
        if requested != bare && requested != versioned {
            return Err(format!(
                "arXiv source version {requested} does not match local PDF {versioned}"
            ));
        }
        return Ok(versioned.to_string());
    }
    Ok(requested.to_string())
}

/// Papers saved before unversioned requests fell through to latest recorded
/// this refusal. It is no longer a failure, so the retry backoff must not
/// keep replaying it.
fn is_retired_unversioned_stamp_refusal(error: &str) -> bool {
    error.contains("Cannot determine the local PDF's arXiv version")
}

pub async fn prepare_arxiv_source(
    paper_dir: &Path,
    arxiv_id: &str,
    task_id: Option<&str>,
) -> Result<bool, AppError> {
    let aggregator = AssetProgressAggregator::new(None, task_id, "tex", 1);
    prepare_arxiv_source_with_progress(paper_dir, arxiv_id, aggregator.stream(0), false).await
}

async fn prepare_arxiv_source_with_progress(
    paper_dir: &Path,
    arxiv_id: &str,
    progress: StreamProgress<'_, '_>,
    retry: bool,
) -> Result<bool, AppError> {
    let _guard = source::lock(paper_dir, progress.task_id()).await?;
    if source::read_tex(paper_dir).is_some() {
        return Ok(true);
    }
    if let Some(state) =
        source::state(paper_dir).filter(|s| source::matches_request(arxiv_id, &s.arxiv_id))
    {
        if state.status == SourceStatus::Unavailable {
            return Ok(false);
        }
        if !retry
            && state.status == SourceStatus::RetryableError
            && !source::retry_due(paper_dir, arxiv_id)
            && !state
                .error
                .as_deref()
                .is_some_and(is_retired_unversioned_stamp_refusal)
        {
            return Err(AppError::message(
                state
                    .error
                    .unwrap_or_else(|| "arXiv source download needs retry".into()),
            ));
        }
    }
    let mut request = arxiv_id.to_string();
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    if let Some(pdf) = probe_paper_caps(paper_dir).pdf_path {
        let bare = strip_arxiv_version(&request);
        if let Ok(pages) =
            crate::features::paper::analyze::parse::run_liteparse_probe(&pdf, progress.task_id())
                .await
        {
            let text = pages
                .iter()
                .flat_map(|page| &page.lines)
                .flat_map(|line| &line.words)
                .map(|word| word.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            if let Some(versioned) = source::version_from_text(&text, &bare) {
                request = match resolve_eprint_request(&request, Some(&versioned)) {
                    Ok(request) => request,
                    Err(message) => {
                        source::record_state(
                            paper_dir,
                            arxiv_id,
                            SourceStatus::RetryableError,
                            Some(message.clone()),
                        )?;
                        return Err(AppError::message(message));
                    }
                };
            }
        }
        super::check_task_not_cancelled(progress.task_id())?;
        // No readable stamp: an unversioned id stays bare and downloads latest.
    }
    let source = paper_dir.join("source");
    fs::create_dir_all(&source)?;
    match download_arxiv_source(&source, paper_dir, &request, progress).await {
        Ok(()) => {
            let ready = source::read_tex(paper_dir).is_some();
            source::record_state(
                paper_dir,
                &request,
                if ready {
                    SourceStatus::Ready
                } else {
                    SourceStatus::Unavailable
                },
                None,
            )?;
            Ok(ready)
        }
        Err(error) => {
            super::check_task_not_cancelled(progress.task_id())?;
            source::record_state(
                paper_dir,
                arxiv_id,
                SourceStatus::RetryableError,
                Some(error.to_string()),
            )?;
            Err(error)
        }
    }
}

/// Build ordered PDF URL candidates (first success wins).
fn pdf_url_candidates(id: &str, arxiv_id: Option<&str>, pdf_url: Option<&str>) -> Vec<String> {
    let mut out = Vec::new();
    let mut push = |u: String| {
        let t = u.trim().to_string();
        if !t.is_empty() && !out.iter().any(|x| x == &t) {
            out.push(t);
        }
    };

    if let Some(u) = pdf_url.map(str::trim).filter(|s| !s.is_empty()) {
        push(u.to_string());
    }

    let bare_arxiv = arxiv_id
        .and_then(crate::features::scholar_api::identifiers::extract_arxiv_request)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            // Folder / id often is the arXiv id
            let s = id.trim().to_string();
            if looks_like_arxiv_id(&s) {
                Some(s)
            } else {
                None
            }
        });

    if let Some(bare) = bare_arxiv {
        push(format!("https://arxiv.org/pdf/{bare}"));
        push(format!("https://arxiv.org/pdf/{bare}.pdf"));
        push(format!("https://export.arxiv.org/pdf/{bare}"));
    }

    out
}

/// Query Unpaywall for a DOI's best open-access PDF location.
async fn unpaywall_pdf_url(doi: &str) -> Option<String> {
    use crate::features::scholar_api::sources::unpaywall::UnpaywallApi;
    use crate::features::scholar_api::traits::PdfUrlSource;
    use crate::features::scholar_api::ApiQuery;

    let source = UnpaywallApi::new("agentero@users.noreply.github.com");
    source
        .pdf_url(&ApiQuery::Doi(doi.trim().to_string()))
        .await
        .ok()
        .flatten()
}

/// Try each PDF URL in order; write on first success. Returns true when a PDF was saved.
async fn try_download_candidates_with_cookies(
    paper_dir: &Path,
    id: &str,
    urls: &[String],
    out: &mut PdfAssetResult,
    cookies: Option<&str>,
    progress: StreamProgress<'_, '_>,
) -> bool {
    for url in urls {
        // PDF lives next to NOTES.md, not under source/
        match download_pdf_with_cookies(paper_dir, id, url, cookies, progress).await {
            Ok(()) => {
                out.ok = true;
                out.messages.push(format!("pdf ok ({url})"));
                return true;
            }
            Err(e) => {
                out.messages
                    .push(format!("pdf candidate failed ({url}): {e}"));
            }
        }
    }
    false
}

/// Query Crossref for a DOI's direct / open-access PDF links (no API key needed).
/// Prefers links whose content-type is application/pdf; falls back to any link URL.
async fn crossref_pdf_urls(doi: &str) -> Vec<String> {
    let api = format!(
        "https://api.crossref.org/works/{}",
        doi.trim().replace(' ', "%20")
    );
    let Ok(client) = http::client_with(Duration::from_secs(20), 10, http::BROWSER_USER_AGENT)
    else {
        return Vec::new();
    };
    let Ok(res) = client
        .get(&api)
        .header("Accept", "application/json")
        .send()
        .await
    else {
        return Vec::new();
    };
    if !res.status().is_success() {
        return Vec::new();
    }
    let Ok(text) = res.text().await else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    let mut pdf_links = Vec::new();
    let mut other_links = Vec::new();
    if let Some(links) = value.pointer("/message/link").and_then(|v| v.as_array()) {
        for l in links {
            let url = l.get("URL").and_then(|v| v.as_str()).unwrap_or("").trim();
            if url.is_empty() {
                continue;
            }
            let ct = l.get("content-type").and_then(|v| v.as_str()).unwrap_or("");
            if ct.eq_ignore_ascii_case("application/pdf")
                || url.to_ascii_lowercase().ends_with(".pdf")
            {
                pdf_links.push(url.to_string());
            } else {
                other_links.push(url.to_string());
            }
        }
    }
    if pdf_links.is_empty() {
        other_links
    } else {
        pdf_links
    }
}

fn looks_like_arxiv_id(s: &str) -> bool {
    // 1412.6980 or hep-th/9901001
    let s = s.trim();
    if s.is_empty() {
        return false;
    }
    if s.contains('/') {
        return true;
    }
    let parts: Vec<_> = s.split('.').collect();
    parts.len() == 2
        && parts[0].len() == 4
        && parts[0].chars().all(|c| c.is_ascii_digit())
        && parts[1].chars().all(|c| c.is_ascii_digit())
        && (parts[1].len() >= 4 && parts[1].len() <= 5)
}

async fn download_pdf_with_cookies(
    source_dir: &Path,
    id: &str,
    url: &str,
    cookies: Option<&str>,
    progress: StreamProgress<'_, '_>,
) -> Result<(), AppError> {
    let bytes =
        http_get_bytes_with_progress(url, Duration::from_secs(180), cookies, progress).await?;
    // Reject HTML error pages disguised as PDF
    if bytes.len() >= 4 && &bytes[..4] == b"%PDF" {
        let name = safe_filename(id, "pdf");
        fs::write(source_dir.join(name), &bytes)?;
        return Ok(());
    }
    // Some servers omit magic; still write if URL looks like pdf and body is large
    if (url.contains("/pdf/") || url.ends_with(".pdf")) && bytes.len() > 1024 {
        // Avoid writing HTML error pages
        let head = String::from_utf8_lossy(&bytes[..bytes.len().min(200)]).to_ascii_lowercase();
        if head.contains("<!doctype") || head.contains("<html") {
            return Err(AppError::message("download returned HTML, not PDF"));
        }
        let name = safe_filename(id, "pdf");
        fs::write(source_dir.join(name), &bytes)?;
        return Ok(());
    }
    Err(AppError::message("download did not look like a PDF"))
}

/// Fetch arXiv e-print and unpack TeX into `source/`.
/// PDF-only e-prints are written to the **paper folder root** (same as normal PDF download).
async fn download_arxiv_source(
    source_dir: &Path,
    paper_dir: &Path,
    arxiv_id: &str,
    progress: StreamProgress<'_, '_>,
) -> Result<(), AppError> {
    let bare = strip_arxiv_version(arxiv_id);
    // Prefer e-print; /src/ is an alias
    let url = format!("https://arxiv.org/e-print/{arxiv_id}");
    let bytes =
        http_get_bytes_with_progress(&url, Duration::from_secs(180), None, progress).await?;
    unpack_arxiv_eprint(source_dir, paper_dir, &bare, &bytes)
}

fn unpack_arxiv_eprint(
    source_dir: &Path,
    paper_dir: &Path,
    bare_id: &str,
    bytes: &[u8],
) -> Result<(), AppError> {
    if bytes.is_empty() {
        return Err(AppError::message("empty e-print response"));
    }

    const MAX_SOURCE: u64 = 128 * 1024 * 1024;
    let payload = if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut inflated = Vec::new();
        GzDecoder::new(Cursor::new(bytes))
            .take(MAX_SOURCE + 1)
            .read_to_end(&mut inflated)?;
        inflated
    } else {
        bytes.to_vec()
    };
    if payload.len() as u64 > MAX_SOURCE {
        return Err(AppError::message("arXiv source exceeds unpack limit"));
    }
    if payload.starts_with(b"%PDF") {
        let dest = paper_dir.join(safe_filename(bare_id, "pdf"));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(dest)
        {
            Ok(mut file) => file.write_all(&payload)?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        return Ok(());
    }
    if payload.starts_with(b"%!PS") {
        return Ok(());
    }

    // Validate the whole archive before publishing any source file. The staging
    // directory is outside source/ and ignored by capability/tree/sync scans.
    let staging = tempfile::Builder::new()
        .prefix(".agentero-source-")
        .tempdir_in(paper_dir)?;
    if looks_like_tar(&payload) {
        extract_tar_safe(staging.path(), &payload)?;
    } else {
        let text = String::from_utf8_lossy(&payload);
        if payload.contains(&0) || !source::tex::has_indicator(&source::tex::strip_comments(&text))
        {
            return Err(AppError::message(
                "arXiv e-print is not a TeX document or PDF",
            ));
        }
        fs::write(staging.path().join(safe_filename(bare_id, "tex")), &payload)?;
    }
    if source::read_tex(staging.path()).is_none() {
        // A successfully decoded archive with no TeX is a known unsupported
        // submission, unlike a broken/incomplete TeX project.
        if !source::contains_tex_files(staging.path()) {
            return Ok(());
        }
        return Err(AppError::message(
            "arXiv source has no readable main TeX document or has missing inputs",
        ));
    }
    // Preserve user edits and derived sidecars. Publish only new files, and roll
    // those back if a later file conflicts or fails. Never replace source/ whole.
    let mut created = Vec::new();
    let result = publish_source(staging.path(), source_dir, &mut created);
    if let Err(error) = result {
        for path in created.iter().rev() {
            let _ = fs::remove_file(path);
        }
        return Err(error);
    }
    Ok(())
}

fn publish_source(from: &Path, to: &Path, created: &mut Vec<PathBuf>) -> Result<(), AppError> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            if target.is_symlink() {
                return Err(AppError::message("source directory is a symlink"));
            }
            publish_source(&entry.path(), &target, created)?;
        } else {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("agentero-")
                || matches!(name.as_str(), "layout.json" | "layout-index.json")
            {
                continue;
            }
            let bytes = fs::read(entry.path())?;
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
            {
                Ok(mut file) => {
                    created.push(target);
                    file.write_all(&bytes)?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    if target.is_symlink() || fs::read(&target)? != bytes {
                        return Err(AppError::message(format!(
                            "source conflicts with existing file: {}",
                            target.display()
                        )));
                    }
                }
                Err(error) => return Err(error.into()),
            }
        }
    }
    Ok(())
}

fn looks_like_tar(bytes: &[u8]) -> bool {
    // ustar magic at offset 257
    if bytes.len() > 262 {
        let magic = &bytes[257..262];
        if magic == b"ustar" || magic == b"ustar\0" {
            return true;
        }
        // Some tars use "ustar " (POSIX)
        if &bytes[257..263] == b"ustar " {
            return true;
        }
    }
    // Heuristic: 512-byte blocks with NUL padding in header
    bytes.len() >= 512 && bytes[0] != 0 && bytes.iter().take(100).any(|&b| b == 0)
}

pub(crate) fn extract_tar_safe(dest: &Path, tar_bytes: &[u8]) -> Result<(), AppError> {
    let mut archive = Archive::new(Cursor::new(tar_bytes));
    let entries = archive
        .entries()
        .map_err(|e| AppError::message(format!("tar entries: {e}")))?;

    for (index, entry) in entries.enumerate() {
        if index >= 10_000 {
            return Err(AppError::message("source archive has too many entries"));
        }
        let mut entry = entry.map_err(|e| AppError::message(format!("tar entry: {e}")))?;
        if entry.size() > 128 * 1024 * 1024 {
            return Err(AppError::message("source archive entry exceeds limit"));
        }
        let path = entry
            .path()
            .map_err(|e| AppError::message(format!("tar path: {e}")))?
            .into_owned();

        let safe = sanitize_tar_path(&path)?;
        if safe.as_os_str().is_empty() {
            continue;
        }
        let out_path = dest.join(&safe);

        if entry.header().entry_type().is_dir() {
            fs::create_dir_all(&out_path)?;
            continue;
        }
        if !entry.header().entry_type().is_file() {
            return Err(AppError::message(
                "source archive contains unsupported link or special file",
            ));
        }

        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let mut file =
            File::create(&out_path).map_err(|e| AppError::message(format!("create: {e}")))?;
        let mut buf = Vec::new();
        entry
            .read_to_end(&mut buf)
            .map_err(|e| AppError::message(format!("tar read: {e}")))?;
        file.write_all(&buf)
            .map_err(|e| AppError::message(format!("write: {e}")))?;
    }
    Ok(())
}

/// Reject absolute paths and `..` components.
fn sanitize_tar_path(path: &Path) -> Result<PathBuf, AppError> {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::Normal(s) => out.push(s),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(AppError::message("tar path traversal rejected"));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(AppError::message("absolute tar path rejected"));
            }
        }
    }
    Ok(out)
}

pub(crate) async fn http_get_bytes_with_progress(
    url: &str,
    timeout: Duration,
    cookies: Option<&str>,
    progress: StreamProgress<'_, '_>,
) -> Result<Vec<u8>, AppError> {
    let task_id = progress.task_id();
    super::check_task_not_cancelled(task_id)?;
    // Each attempt counts from zero: PDF falls back across candidate URLs.
    progress.restart();
    let client = http::client_with(timeout, 10, http::BROWSER_USER_AGENT)?;
    let mut request = client
        .get(url)
        .header("Accept", "application/pdf,application/octet-stream,*/*");
    if let Some(cookie) = cookies.map(str::trim).filter(|s| !s.is_empty()) {
        request = request.header(reqwest::header::COOKIE, cookie);
    }
    let mut res = request
        .send()
        .await
        .map_err(|e| AppError::message(format!("download: {e}")))?;
    super::check_task_not_cancelled(task_id)?;
    if !res.status().is_success() {
        return Err(AppError::message(format!("download HTTP {}", res.status())));
    }
    let total_bytes = res.content_length();
    let mut downloaded_bytes = 0_u64;
    let mut bytes = Vec::new();
    while let Some(chunk) = res
        .chunk()
        .await
        .map_err(|e| AppError::message(format!("download body: {e}")))?
    {
        if let Some(task_id) = task_id {
            if super::is_task_cancelled(task_id) {
                return Err(AppError::message("background task cancelled"));
            }
        }
        downloaded_bytes += chunk.len() as u64;
        bytes.extend_from_slice(&chunk);
        // Per-chunk emits flood the webview event loop; the aggregator
        // throttles to percent moves / ≥100ms.
        progress.report(downloaded_bytes, total_bytes);
    }
    // Settling always lands an event, even when the throttle just swallowed
    // the last chunk: the task bar must reach the final byte count.
    progress.finish();
    Ok(bytes)
}

/// On-demand download of PDF (+ arXiv LaTeX) for an existing paper folder.
pub async fn download_paper_assets(
    args: PaperDownloadAssetsArgs,
) -> Result<AssetDownloadResult, AppError> {
    download_paper_assets_with_progress(args, None, None).await
}

pub async fn download_paper_assets_with_progress(
    args: PaperDownloadAssetsArgs,
    app: Option<&AppHandle>,
    cache: Option<&CapsCache>,
) -> Result<AssetDownloadResult, AppError> {
    // Resolve the vault/paper folder (fs::canonicalize) and read the catalog
    // row (rusqlite, which acquires the process-wide catalog lock) on the
    // blocking pool so neither a slow filesystem nor a held catalog lock stalls
    // a tokio worker.
    let vault_arg = args.vault_path.clone();
    let path_arg = args.path.clone();
    let (vault, paper_dir, path_rel, id, arxiv_id, pdf_url, doi, rebuilt_row) =
        tokio::task::spawn_blocking(move || {
            let vault = crate::fs::resolve_vault(&vault_arg)?;
            let (paper_dir, path_rel) = crate::fs::resolve_paper_dir(&vault, &path_arg)?;

            let resolved = if let Ok(Some(row)) = papers::get_by_path(&vault, &path_rel) {
                let request = source::arxiv_request(&row);
                (row.id, request, row.pdf_url, row.doi, None)
            } else if let Ok(Some(row)) = papers::ensure_row_for_path(&vault, &path_rel) {
                // Orphaned folder (import failed after shell + folder were written but
                // before the catalog row landed): rebuild the row so the Library sees it.
                (
                    row.id.clone(),
                    row.arxiv_id,
                    row.pdf_url,
                    row.doi,
                    Some(row.id),
                )
            } else {
                // Fallback: folder name as id; treat as arXiv if it looks like one
                let name = paper_dir
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("paper")
                    .to_string();
                let arxiv = extract_arxiv_id(&name);
                let pdf = arxiv
                    .as_ref()
                    .map(|a| format!("https://arxiv.org/pdf/{}", a));
                (name, arxiv, pdf, None, None)
            };
            let (id, arxiv_id, pdf_url, doi, rebuilt_row) = resolved;
            Ok::<_, AppError>((
                vault,
                paper_dir,
                path_rel,
                id,
                arxiv_id,
                pdf_url,
                doi,
                rebuilt_row,
            ))
        })
        .await
        .map_err(|e| AppError::message(format!("blocking task failed: {e}")))??;

    if let Some(row_id) = rebuilt_row {
        crate::features::lifecycle::emit_paper_imported(app, &vault, &row_id, &path_rel);
    }

    let mut result = ensure_paper_assets_with_progress(
        &paper_dir,
        &vault,
        &path_rel,
        &id,
        arxiv_id.as_deref(),
        pdf_url.as_deref(),
        doi.as_deref(),
        None,
        cache,
        AssetProgressContext {
            app,
            task_id: args.task_id.as_deref(),
        },
    )
    .await?;
    super::check_task_not_cancelled(args.task_id.as_deref())?;

    source::reconcile_body(&vault, &path_rel)?;

    result.preparation = super::preparation::plan_after_assets(
        &path_rel,
        result.pdf,
        result.tex,
        result.paper_md,
        false,
    );
    Ok(result)
}

fn safe_filename(id: &str, ext: &str) -> String {
    let base = id
        .replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_")
        .trim()
        .to_string();
    let base = if base.is_empty() {
        "paper".into()
    } else {
        base
    };
    format!("{base}.{ext}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;

    /// 2000 × 8KB chunks of a 16MB known-size download at the same instant
    /// (time gate never opens) must be capped by percent moves: ≤ ~100 emits
    /// plus one unconditional completion event.
    #[test]
    fn progress_throttle_caps_known_size_chunk_storm() {
        let mut throttle = ProgressThrottle::new(PROGRESS_EMIT_INTERVAL);
        let now = std::time::Instant::now();
        let total: u64 = 2000 * 8 * 1024;
        let mut downloaded: u64 = 0;
        let mut emits = 0usize;
        for _ in 0..2000 {
            downloaded += 8 * 1024;
            let percent = Some(((downloaded * 100 / total).min(100)) as u8);
            if throttle.should_emit(now, percent) {
                emits += 1;
            }
        }
        // Final event bypasses the throttle in http_get_bytes_with_progress.
        let final_emits = emits + 1;
        assert!(
            final_emits <= 102,
            "expected ≤102 emits for 2000 chunks, got {final_emits}"
        );
        assert!(final_emits >= 50, "throttle must not starve the task bar");
        println!("throttled 2000 progress callbacks to {final_emits} emits (incl. final)");
    }

    /// Unknown content-length downloads fall back to the time gate: at most
    /// one emit per interval.
    #[test]
    fn progress_throttle_time_gates_unknown_size() {
        let mut throttle = ProgressThrottle::new(Duration::from_millis(100));
        let start = std::time::Instant::now();
        let mut emits = 0usize;
        for i in 0..2000u64 {
            // 2000 chunks arriving over 2 seconds.
            let now = start + Duration::from_millis(i);
            if throttle.should_emit(now, None) {
                emits += 1;
            }
        }
        assert!(
            emits <= 21,
            "expected ≤21 time-gated emits over 2s, got {emits}"
        );
        assert!(emits >= 1, "first sample must emit");
    }

    /// The first sample always emits so the task bar leaves 'queued' quickly.
    #[test]
    fn progress_throttle_first_sample_emits() {
        let mut throttle = ProgressThrottle::new(PROGRESS_EMIT_INTERVAL);
        assert!(throttle.should_emit(std::time::Instant::now(), Some(0)));
    }

    /// A finished concurrent stream must not pin the shared row at 100% while
    /// the other one is still fetching (TeX used to land first and freeze the
    /// bar above a PDF that was only 60% downloaded).
    #[test]
    fn merged_progress_stays_below_100_while_a_stream_runs() {
        let slots = vec![
            ProgressSlot {
                downloaded: 1024,
                total: Some(1024),
                finished: true,
            },
            ProgressSlot {
                downloaded: 352,
                total: Some(586),
                finished: false,
            },
        ];
        let (downloaded, total, percent) = merged_progress(&slots);
        assert_eq!(downloaded, 1376);
        assert_eq!(total, Some(1610));
        assert_eq!(percent, Some(85));
    }

    /// Guessing at a running stream's size would let the other one read 100%,
    /// so an unknown `Content-Length` keeps the merged total unknown instead.
    #[test]
    fn merged_progress_is_indeterminate_while_a_size_is_unknown() {
        let slots = vec![
            ProgressSlot {
                downloaded: 1024,
                total: Some(1024),
                finished: true,
            },
            ProgressSlot {
                downloaded: 64,
                total: None,
                finished: false,
            },
        ];
        assert_eq!(merged_progress(&slots), (1088, None, None));
    }

    /// Once a stream settles, whatever it received is all there is: it stops
    /// holding the merged total back.
    #[test]
    fn merged_progress_counts_a_settled_stream_of_unknown_size() {
        let slots = vec![ProgressSlot {
            downloaded: 40,
            total: None,
            finished: true,
        }];
        assert_eq!(merged_progress(&slots), (40, Some(40), Some(100)));
    }

    /// A DOI-only import has no TeX stream, so the PDF alone must span the
    /// whole bar instead of stalling at 50%.
    #[test]
    fn merged_progress_single_stream_spans_the_whole_bar() {
        let running = vec![ProgressSlot {
            downloaded: 293,
            total: Some(586),
            finished: false,
        }];
        assert_eq!(merged_progress(&running).2, Some(50));

        let done = vec![ProgressSlot {
            downloaded: 586,
            total: Some(586),
            finished: true,
        }];
        assert_eq!(merged_progress(&done).2, Some(100));
    }

    /// Force a payload without an `AppHandle`, bypassing the throttle.
    fn sample(agg: &AssetProgressAggregator<'_>) -> AssetDownloadProgress {
        let mut state = agg.lock();
        agg.sample(&mut state, true).expect("task id present")
    }

    /// The reported regression, through the real slot bookkeeping: TeX settles
    /// first, and the shared row must keep tracking the PDF's remaining bytes
    /// instead of claiming 100% above "PDF · 352 KB / 586 KB".
    #[test]
    fn aggregator_merges_concurrent_streams_without_overshooting() {
        let agg = AssetProgressAggregator::new(None, Some("job-1"), "assets", 2);
        let (pdf, tex) = (agg.stream(0), agg.stream(1));

        pdf.restart();
        tex.restart();
        pdf.report(0, Some(586));
        tex.report(0, Some(1024));
        tex.report(1024, Some(1024));
        tex.finish();
        pdf.report(352, Some(586));

        let payload = sample(&agg);
        assert_eq!(payload.phase, "assets");
        assert_eq!(payload.task_id, "job-1");
        assert_eq!(payload.downloaded_bytes, 1376);
        assert_eq!(payload.total_bytes, Some(1610));
        assert_eq!(payload.progress, Some(85));

        // The bar and the byte detail stay in agreement until the PDF lands.
        pdf.report(586, Some(586));
        pdf.finish();
        assert_eq!(sample(&agg).progress, Some(100));
    }

    /// Each PDF candidate URL counts its bytes from zero, so an attempt that
    /// failed mid-body cannot inflate the merged total.
    #[test]
    fn aggregator_restarts_the_byte_count_for_each_pdf_candidate() {
        let agg = AssetProgressAggregator::new(None, Some("job-1"), "assets", 2);
        let (pdf, tex) = (agg.stream(0), agg.stream(1));

        pdf.restart();
        pdf.report(300, Some(586));
        tex.restart();
        tex.report(512, Some(1024));

        pdf.restart();
        pdf.report(100, Some(400));

        let payload = sample(&agg);
        assert_eq!(payload.downloaded_bytes, 612);
        assert_eq!(payload.total_bytes, Some(1424));
        assert_eq!(payload.progress, Some(42));
    }

    #[test]
    fn sanitize_rejects_parent() {
        assert!(sanitize_tar_path(Path::new("../evil")).is_err());
        assert!(sanitize_tar_path(Path::new("/abs")).is_err());
        assert_eq!(
            sanitize_tar_path(Path::new("a/b.tex")).unwrap(),
            PathBuf::from("a/b.tex")
        );
    }

    #[test]
    fn unpack_plain_and_gzipped_tex() {
        let paper = std::env::temp_dir().join(format!("agentero-paper-{}", std::process::id()));
        let source = paper.join("source");
        let _ = fs::remove_dir_all(&paper);
        fs::create_dir_all(&source).unwrap();

        let tex = b"\\documentclass{article}\\begin{document}Hi\\end{document}";
        unpack_arxiv_eprint(&source, &paper, "1706.03762", tex).unwrap();
        assert!(source.join("1706.03762.tex").exists());

        let mut enc = GzEncoder::new(Vec::new(), Compression::default());
        enc.write_all(b"\\documentclass{article}\n").unwrap();
        let gz = enc.finish().unwrap();
        unpack_arxiv_eprint(&source, &paper, "1234.5678", &gz).unwrap();
        assert!(source.join("1234.5678.tex").exists());

        let _ = fs::remove_dir_all(&paper);
    }

    #[test]
    fn unpack_pdf_only_eprint_to_paper_root() {
        let paper =
            std::env::temp_dir().join(format!("agentero-pdf-eprint-{}", std::process::id()));
        let source = paper.join("source");
        let _ = fs::remove_dir_all(&paper);
        fs::create_dir_all(&source).unwrap();

        let mut pdf = b"%PDF-1.4".to_vec();
        pdf.extend_from_slice(&[0u8; 64]);
        unpack_arxiv_eprint(&source, &paper, "1412.6980", &pdf).unwrap();
        assert!(paper.join("1412.6980.pdf").exists());
        assert!(!source.join("1412.6980.pdf").exists());

        let _ = fs::remove_dir_all(&paper);
    }

    #[test]
    fn rejects_error_pages_and_corrupt_archives_without_publishing_partial_tex() {
        let paper = tempfile::tempdir().unwrap();
        let source = paper.path().join("source");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("layout.json"), "KEEP-SIDECAR").unwrap();
        assert!(unpack_arxiv_eprint(
            &source,
            paper.path(),
            "1706.03762",
            b"<html>Unavailable</html>"
        )
        .is_err());
        let mut builder = tar::Builder::new(Vec::new());
        let tex = b"\\documentclass{article}\\begin{document}Body\\end{document}";
        let mut header = tar::Header::new_gnu();
        header.set_size(tex.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder
            .append_data(&mut header, "main.tex", Cursor::new(tex))
            .unwrap();
        let mut broken = builder.into_inner().unwrap();
        broken.truncate(1024);
        broken.extend_from_slice(&[b'x'; 512]);
        assert!(unpack_arxiv_eprint(&source, paper.path(), "1706.03762", &broken).is_err());
        assert!(!source.join("main.tex").exists());
        assert!(!source.join("1706.03762.tex").exists());
        assert_eq!(
            fs::read_to_string(source.join("layout.json")).unwrap(),
            "KEEP-SIDECAR"
        );
    }

    #[test]
    fn gzipped_pdf_is_pdf_only_and_valid_tar_preserves_user_sources() {
        let paper = tempfile::tempdir().unwrap();
        let source = paper.path().join("source");
        fs::create_dir_all(&source).unwrap();
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(b"%PDF-1.4 test").unwrap();
        unpack_arxiv_eprint(
            &source,
            paper.path(),
            "1706.03762",
            &encoder.finish().unwrap(),
        )
        .unwrap();
        assert!(paper.path().join("1706.03762.pdf").is_file());
        assert!(!probe_paper_caps(paper.path()).has_tex);
        let mut builder = tar::Builder::new(Vec::new());
        let tex = b"\\documentclass{article}\\begin{document}Body\\end{document}";
        let mut header = tar::Header::new_gnu();
        header.set_size(tex.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder
            .append_data(&mut header, "main.tex", Cursor::new(tex))
            .unwrap();
        let archive = builder.into_inner().unwrap();
        unpack_arxiv_eprint(&source, paper.path(), "1706.03762", &archive).unwrap();
        assert!(probe_paper_caps(paper.path()).has_tex);
        fs::write(source.join("main.tex"), "USER EDIT").unwrap();
        assert!(unpack_arxiv_eprint(&source, paper.path(), "1706.03762", &archive).is_err());
        assert_eq!(
            fs::read_to_string(source.join("main.tex")).unwrap(),
            "USER EDIT"
        );
    }

    #[test]
    fn pdf_candidates_include_arxiv() {
        let c = pdf_url_candidates(
            "1412.6980",
            Some("1412.6980"),
            Some("https://arxiv.org/pdf/1412.6980"),
        );
        assert!(c.iter().any(|u| u.contains("arxiv.org/pdf/1412.6980")));
        assert!(c.len() >= 2);
    }

    #[test]
    fn unversioned_arxiv_without_stamp_downloads_latest() {
        assert_eq!(
            resolve_eprint_request("2505.02387", None).as_deref(),
            Ok("2505.02387")
        );
        assert_eq!(
            resolve_eprint_request("2505.02387", Some("2505.02387v4")).as_deref(),
            Ok("2505.02387v4")
        );
        assert_eq!(
            resolve_eprint_request("2505.02387v4", None).as_deref(),
            Ok("2505.02387v4")
        );
        assert!(resolve_eprint_request("2505.02387v1", Some("2505.02387v4")).is_err());
        assert!(is_retired_unversioned_stamp_refusal(
            "Cannot determine the local PDF's arXiv version; set a versioned arXiv PDF/source URL before supplementing LaTeX"
        ));
    }

    #[test]
    fn looks_like_arxiv_id_basic() {
        assert!(looks_like_arxiv_id("1412.6980"));
        assert!(looks_like_arxiv_id("1706.03762"));
        assert!(!looks_like_arxiv_id("not-an-id"));
    }

    #[test]
    fn pdf_only_eprint_does_not_overwrite_existing_pdf() {
        let paper = std::env::temp_dir().join(format!(
            "agentero-pdf-race-{}-{}-existing",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let source = paper.join("source");
        let _ = fs::remove_dir_all(&paper);
        fs::create_dir_all(&source).unwrap();

        let existing_pdf = paper.join("1412.6980.pdf");
        fs::write(&existing_pdf, b"%PDF existing").unwrap();

        let eprint_pdf = b"%PDF e-print";
        unpack_arxiv_eprint(&source, &paper, "1412.6980", eprint_pdf).unwrap();

        // Existing PDF must remain; e-print PDF should have been discarded.
        assert_eq!(fs::read(&existing_pdf).unwrap(), b"%PDF existing");
        fs::remove_dir_all(&paper).ok();
    }

    #[test]
    fn pdf_only_eprint_writes_when_no_existing_pdf() {
        let paper = std::env::temp_dir().join(format!(
            "agentero-pdf-race-{}-{}-new",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let source = paper.join("source");
        let _ = fs::remove_dir_all(&paper);
        fs::create_dir_all(&source).unwrap();

        let eprint_pdf = b"%PDF e-print";
        unpack_arxiv_eprint(&source, &paper, "1412.6980", eprint_pdf).unwrap();

        let written = paper.join("1412.6980.pdf");
        assert!(written.exists());
        assert_eq!(fs::read(&written).unwrap(), eprint_pdf);
        fs::remove_dir_all(&paper).ok();
    }
}
