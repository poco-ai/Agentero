pub mod commands;

use crate::core::error::AppError;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

pub const JOB_CHANGED_EVENT: &str = "job:changed";
pub const JOB_OFFER_EVENT: &str = "job:offer";

const LAYOUT_ANALYZE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JobOfferPayload {
    pub job_id: String,
    pub kind: JobKind,
    pub vault_path: String,
    pub paper_path: Option<String>,
    pub force: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct JobId(pub String);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum JobKind {
    ParseRefs,
    ParseBody,
    LayoutAnalyze,
    LayoutTranslate,
    DownloadAssets,
    PageCount,
    WikiReindex,
    RecognizeMetadata,
}

impl JobKind {
    /// Dedupe fingerprint for enqueued jobs. The strings are part of the
    /// active-key contract and must stay stable (tests assert them).
    fn fingerprint(self, force: bool) -> String {
        let label = match self {
            JobKind::ParseRefs => "parseRefs",
            JobKind::ParseBody => "parseBody",
            JobKind::LayoutAnalyze => "layoutAnalyze",
            JobKind::LayoutTranslate => "layoutTranslate",
            JobKind::DownloadAssets => "downloadAssets",
            JobKind::PageCount => "pageCount",
            JobKind::WikiReindex => "wikiReindex",
            JobKind::RecognizeMetadata => "recognizeMetadata",
        };
        // ParseRefs always runs with online lookup enabled; the segment is
        // kept for fingerprint compatibility with pre-refactor jobs.
        let online = if self == JobKind::ParseRefs {
            ":online:true"
        } else {
            ""
        };
        format!("{label}:v1{online}:force:{force}")
    }
}

#[derive(
    Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, Default, specta::Type,
)]
#[serde(rename_all = "camelCase")]
pub enum JobLane {
    Focus,
    #[default]
    Normal,
    Idle,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum JobState {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Skipped,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum DepPolicy {
    AllSettled,
    AllSucceeded,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    pub id: String,
    pub kind: JobKind,
    pub lane: JobLane,
    pub state: JobState,
    pub vault_path: String,
    pub paper_path: Option<String>,
    pub fingerprint: String,
    pub depends_on: Vec<String>,
    pub dep_policy: DepPolicy,
    pub progress: Option<f32>,
    pub phase: Option<String>,
    pub error: Option<String>,
    pub force: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JobChangedPayload {
    pub job: JobSnapshot,
}

/// Everything a runner needs to execute a job that `try_start` has already
/// transitioned to `Running`. Runners must not re-mark the job themselves.
#[derive(Debug)]
pub struct StartedJob {
    pub snapshot: JobSnapshot,
    pub vault_path: PathBuf,
    pub paper_path: String,
    pub force: bool,
    pub task_id: Option<String>,
}

/// Outcome of `JobCenter::try_start`: whether a `Queued` job could actually
/// transition to `Running` given its `depends_on`/`dep_policy`.
#[derive(Debug)]
pub enum StartOutcome {
    /// Dependencies satisfied; caller should spawn the matching runner.
    Started(StartedJob),
    /// Dependencies not yet settled; the job stays `Queued` until woken.
    Waiting,
    /// Dependencies settled but unsatisfiable under `DepPolicy::AllSucceeded`;
    /// the job was transitioned to `Skipped`.
    Skipped(JobSnapshot),
}

/// Terminal result of a runner's business logic, mapped by `run_job` onto
/// `finish` (state/progress/phase/error kept identical to the pre-refactor
/// runners).
pub enum RunOutcome {
    /// `Succeeded`, progress 100, phase "completed".
    Succeeded,
    /// `Failed`, phase "failed", with the reported error (if any).
    Failed(Option<String>),
    /// `Cancelled`, phase "cancelled" (renderer-executed jobs only).
    Cancelled,
}

/// A job executor registered per [`JobKind`]. Business features define
/// runners in their own domain and register them at app startup, so the
/// JobCenter stays a pure scheduler with no edges into business features.
/// Runners are built on [`JobCenter::run_job`] and must not call `finish`
/// themselves.
pub type JobRunner = Arc<
    dyn Fn(
            JobCenter,
            tauri::AppHandle,
            StartedJob,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
        + Send
        + Sync,
>;

/// Reads the current layout backend string from settings. Registered by the
/// app assembly at startup so the scheduler does not depend on the settings
/// store directly.
type LayoutBackendSource = Arc<dyn Fn() -> String + Send + Sync>;

/// Per-kind check whether a paper needs a backfill job. Registered by the
/// owning domain (e.g. refs for the cite sidecar) so reconcile commands do
/// not reach into business features.
type BackfillProbe = Arc<dyn Fn(&Path, &str) -> bool + Send + Sync>;

#[derive(Debug, Clone)]
struct Job {
    id: JobId,
    kind: JobKind,
    lane: JobLane,
    vault_path: PathBuf,
    paper_path: Option<String>,
    fingerprint: String,
    depends_on: Vec<JobId>,
    dep_policy: DepPolicy,
    attempts: u8,
    state: JobState,
    progress: Option<f32>,
    phase: Option<String>,
    error: Option<String>,
    force: bool,
    task_id: Option<String>,
}

impl Job {
    fn snapshot(&self) -> JobSnapshot {
        JobSnapshot {
            id: self.id.0.clone(),
            kind: self.kind,
            lane: self.lane,
            state: self.state,
            vault_path: self.vault_path.to_string_lossy().to_string(),
            paper_path: self.paper_path.clone(),
            fingerprint: self.fingerprint.clone(),
            depends_on: self.depends_on.iter().map(|id| id.0.clone()).collect(),
            dep_policy: self.dep_policy,
            progress: self.progress,
            phase: self.phase.clone(),
            error: self.error.clone(),
            force: self.force,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct JobKey {
    kind: JobKind,
    vault_path: PathBuf,
    paper_path: Option<String>,
    fingerprint: String,
}

#[derive(Debug, Default)]
struct LaneQueues {
    focus: VecDeque<JobId>,
    normal: VecDeque<JobId>,
    idle: VecDeque<JobId>,
}

impl LaneQueues {
    fn push(&mut self, lane: JobLane, id: JobId) {
        self.queue_mut(lane).push_back(id);
    }

    fn promote_to_focus(&mut self, id: &JobId) {
        self.remove(id);
        self.focus.push_back(id.clone());
    }

    fn remove(&mut self, id: &JobId) {
        for queue in [&mut self.focus, &mut self.normal, &mut self.idle] {
            if let Some(index) = queue.iter().position(|candidate| candidate == id) {
                queue.remove(index);
                return;
            }
        }
    }

    #[cfg(test)]
    fn next_eligible(&self) -> Option<JobId> {
        self.focus
            .front()
            .or_else(|| self.normal.front())
            .or_else(|| self.idle.front())
            .cloned()
    }

    fn queue_mut(&mut self, lane: JobLane) -> &mut VecDeque<JobId> {
        match lane {
            JobLane::Focus => &mut self.focus,
            JobLane::Normal => &mut self.normal,
            JobLane::Idle => &mut self.idle,
        }
    }
}

#[derive(Default)]
struct JobCenterInner {
    jobs: HashMap<JobId, Job>,
    active_keys: HashMap<JobKey, JobId>,
    lanes: LaneQueues,
    /// Number of currently `Running` jobs per kind, used to enforce the
    /// per-kind concurrency caps from paper-pipeline-orchestration.md §7.3.
    running_by_kind: HashMap<JobKind, usize>,
    /// `LayoutAnalyze` cap: 1 for local ONNX, unlimited for the remote API.
    layout_analyze_cap: LayoutAnalyzeCap,
    /// Per-kind runners registered by business domains at app startup.
    runners: HashMap<JobKind, JobRunner>,
    /// Registered by the app assembly; re-read by `refresh_layout_backend`.
    layout_backend_source: Option<LayoutBackendSource>,
    /// Per-kind backfill probes registered by the owning domain.
    backfill_probes: HashMap<JobKind, BackfillProbe>,
}

impl std::fmt::Debug for JobCenterInner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JobCenterInner")
            .field("jobs", &self.jobs)
            .field("active_keys", &self.active_keys)
            .field("lanes", &self.lanes)
            .field("running_by_kind", &self.running_by_kind)
            .field("layout_analyze_cap", &self.layout_analyze_cap)
            .field("runners", &self.runners.keys().collect::<Vec<_>>())
            .field(
                "layout_backend_source",
                &self.layout_backend_source.is_some(),
            )
            .field(
                "backfill_probes",
                &self.backfill_probes.keys().collect::<Vec<_>>(),
            )
            .finish()
    }
}

/// Default local-ONNX cap. `Default` on `usize` would be 0 and stall the queue.
#[derive(Debug, Clone, Copy)]
struct LayoutAnalyzeCap(usize);

impl Default for LayoutAnalyzeCap {
    fn default() -> Self {
        Self(1)
    }
}

/// Per-kind concurrency cap (§7.3). `usize::MAX` = uncapped at the JobCenter
/// level (the kind is either not yet scheduled here or throttled elsewhere).
fn kind_concurrency(inner: &JobCenterInner, kind: JobKind) -> usize {
    match kind {
        JobKind::ParseBody => 1,
        JobKind::LayoutAnalyze => inner.layout_analyze_cap.0,
        JobKind::ParseRefs => 2,
        JobKind::DownloadAssets => 3,
        JobKind::LayoutTranslate => 2,
        // The liteparse probe subprocess is additionally globally capped at 2
        // (pdf_parse::MAX_CONCURRENT_PDF_PARSE); the kind cap keeps queue
        // order fair when many PDFs are imported at once.
        JobKind::RecognizeMetadata => 2,
        JobKind::PageCount | JobKind::WikiReindex => usize::MAX,
    }
}

/// Remote layout jobs are just HTTP; they must not share the ONNX cap of 1.
/// Any non-`local` backend is treated as remote so new providers need no
/// change here.
pub fn layout_analyze_concurrency(backend: &str) -> usize {
    let backend = backend.trim();
    if backend.is_empty() || backend.eq_ignore_ascii_case("local") {
        1
    } else {
        usize::MAX
    }
}

fn is_terminal_state(state: JobState) -> bool {
    matches!(
        state,
        JobState::Succeeded | JobState::Failed | JobState::Cancelled | JobState::Skipped
    )
}

fn release_running_slot(inner: &mut JobCenterInner, kind: JobKind) {
    if let Some(n) = inner.running_by_kind.get_mut(&kind) {
        *n = n.saturating_sub(1);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DepsReadiness {
    Ready,
    Pending,
    Unreachable,
}

fn deps_readiness(inner: &JobCenterInner, job: &Job) -> DepsReadiness {
    if job.depends_on.is_empty() {
        return DepsReadiness::Ready;
    }
    let mut states = Vec::with_capacity(job.depends_on.len());
    for dep_id in &job.depends_on {
        match inner.jobs.get(dep_id) {
            Some(dep) => states.push(dep.state),
            None => {
                // Dependency record no longer exists (never created, or pruned):
                // AllSettled treats a missing dep as vacuously settled; AllSucceeded
                // can never be satisfied by a dependency that doesn't exist.
                return match job.dep_policy {
                    DepPolicy::AllSettled => DepsReadiness::Ready,
                    DepPolicy::AllSucceeded => DepsReadiness::Unreachable,
                };
            }
        }
    }
    let all_settled = states.iter().all(|s| {
        matches!(
            s,
            JobState::Succeeded | JobState::Failed | JobState::Cancelled | JobState::Skipped
        )
    });
    if !all_settled {
        return DepsReadiness::Pending;
    }
    match job.dep_policy {
        DepPolicy::AllSettled => DepsReadiness::Ready,
        DepPolicy::AllSucceeded => {
            if states.iter().all(|s| *s == JobState::Succeeded) {
                DepsReadiness::Ready
            } else {
                DepsReadiness::Unreachable
            }
        }
    }
}

fn mark_running_locked(inner: &mut JobCenterInner, id: &JobId) -> Option<StartedJob> {
    let job = inner.jobs.get_mut(id)?;
    if job.state != JobState::Queued {
        return None;
    }
    job.state = JobState::Running;
    job.attempts = job.attempts.saturating_add(1);
    job.progress = None;
    job.phase = Some("running".into());
    let snapshot = job.snapshot();
    let vault_path = job.vault_path.clone();
    let paper_path = job.paper_path.clone()?;
    let force = job.force;
    let task_id = job.task_id.clone();
    let kind = job.kind;
    inner.lanes.remove(id);
    *inner.running_by_kind.entry(kind).or_insert(0) += 1;
    Some(StartedJob {
        snapshot,
        vault_path,
        paper_path,
        force,
        task_id,
    })
}

#[derive(Clone, Debug)]
pub struct JobCenter {
    inner: Arc<Mutex<JobCenterInner>>,
}

impl JobCenter {
    pub fn new() -> Self {
        let center = Self {
            inner: Arc::new(Mutex::new(JobCenterInner::default())),
        };
        // Renderer-executed layout analysis is part of the scheduler's
        // offer/report protocol (no business feature involved), so this
        // runner is built in instead of registered by a domain.
        center.register_runner(JobKind::LayoutAnalyze, Arc::new(layout_analyze_runner));
        center
    }

    pub fn handle(&self) -> Self {
        self.clone()
    }

    /// Seed the layout-analyze cap from the current settings backend.
    pub fn with_layout_backend(backend: &str) -> Self {
        let center = Self::new();
        if let Ok(mut inner) = center.inner.try_lock() {
            inner.layout_analyze_cap = LayoutAnalyzeCap(layout_analyze_concurrency(backend));
        }
        center
    }

    pub async fn set_layout_analyze_cap(&self, cap: usize) {
        self.inner.lock().await.layout_analyze_cap = LayoutAnalyzeCap(cap.max(1));
    }

    pub async fn apply_layout_backend(&self, backend: &str) {
        self.set_layout_analyze_cap(layout_analyze_concurrency(backend))
            .await;
    }

    /// Register the runner that executes jobs of `kind`. Called by business
    /// domains at app startup; registration happens before any job can run,
    /// so the center is guaranteed to be idle.
    pub fn register_runner(&self, kind: JobKind, runner: JobRunner) {
        self.inner
            .try_lock()
            .expect("job center is idle while runners are registered")
            .runners
            .insert(kind, runner);
    }

    /// Register the settings reader `refresh_layout_backend` re-reads
    /// (provided by the app assembly).
    pub fn set_layout_backend_source(&self, source: impl Fn() -> String + Send + Sync + 'static) {
        self.inner
            .try_lock()
            .expect("job center is idle while runners are registered")
            .layout_backend_source = Some(Arc::new(source));
    }

    /// Register the per-kind backfill probe used by the reconcile commands
    /// (provided by the owning domain, e.g. refs for the cite sidecar).
    pub fn register_backfill_probe(
        &self,
        kind: JobKind,
        probe: impl Fn(&Path, &str) -> bool + Send + Sync + 'static,
    ) {
        self.inner
            .try_lock()
            .expect("job center is idle while runners are registered")
            .backfill_probes
            .insert(kind, Arc::new(probe));
    }

    /// Whether the registered probe for `kind` says the paper needs a
    /// backfill job. Kinds without a probe never need backfill.
    pub async fn backfill_needed(&self, kind: JobKind, vault: &Path, path: &str) -> bool {
        let probe = self.inner.lock().await.backfill_probes.get(&kind).cloned();
        probe.is_some_and(|probe| probe(vault, path))
    }

    /// Re-read the registered layout-backend source (settings) and re-apply
    /// the `LayoutAnalyze` concurrency cap. No-op when no source is
    /// registered (headless / tests).
    pub async fn refresh_layout_backend(&self) {
        let source = self.inner.lock().await.layout_backend_source.clone();
        if let Some(source) = source {
            self.apply_layout_backend(&source()).await;
        }
    }

    pub async fn enqueue_parse_refs(
        &self,
        vault: impl Into<PathBuf>,
        path: impl Into<String>,
        lane: JobLane,
        force: bool,
    ) -> JobSnapshot {
        self.enqueue_core(JobKind::ParseRefs, vault, path, lane, force, None)
            .await
    }

    pub async fn enqueue_parse_body(
        &self,
        vault: impl Into<PathBuf>,
        path: impl Into<String>,
        lane: JobLane,
        force: bool,
        task_id: Option<String>,
    ) -> JobSnapshot {
        self.enqueue_core(JobKind::ParseBody, vault, path, lane, force, task_id)
            .await
    }

    pub async fn enqueue_layout_analyze(
        &self,
        vault: impl Into<PathBuf>,
        path: impl Into<String>,
        lane: JobLane,
        force: bool,
    ) -> JobSnapshot {
        self.enqueue_core(JobKind::LayoutAnalyze, vault, path, lane, force, None)
            .await
    }

    pub async fn enqueue_download_assets(
        &self,
        vault: impl Into<PathBuf>,
        path: impl Into<String>,
        lane: JobLane,
        force: bool,
    ) -> JobSnapshot {
        self.enqueue_core(JobKind::DownloadAssets, vault, path, lane, force, None)
            .await
    }

    pub async fn enqueue_recognize_metadata(
        &self,
        vault: impl Into<PathBuf>,
        path: impl Into<String>,
        lane: JobLane,
        force: bool,
    ) -> JobSnapshot {
        self.enqueue_core(JobKind::RecognizeMetadata, vault, path, lane, force, None)
            .await
    }

    /// Shared enqueue path for every kind: normalize, dedupe on
    /// (kind, vault, paper, fingerprint), then register on the lane.
    /// Adding a new kind only needs a `JobKind` variant (with fingerprint +
    /// concurrency cap) and a thin wrapper like the ones above.
    async fn enqueue_core(
        &self,
        kind: JobKind,
        vault: impl Into<PathBuf>,
        path: impl Into<String>,
        lane: JobLane,
        force: bool,
        task_id: Option<String>,
    ) -> JobSnapshot {
        let vault_path = normalize_vault_path(vault.into());
        let paper_path = path.into();
        let fingerprint = kind.fingerprint(force);
        let key = JobKey {
            kind,
            vault_path: vault_path.clone(),
            paper_path: Some(paper_path.clone()),
            fingerprint: fingerprint.clone(),
        };

        let mut inner = self.inner.lock().await;
        if let Some(existing_id) = inner.active_keys.get(&key) {
            if let Some(existing) = inner.jobs.get(existing_id) {
                return existing.snapshot();
            }
        }

        let id = JobId(uuid::Uuid::new_v4().to_string());
        let job = Job {
            id: id.clone(),
            kind,
            lane,
            vault_path,
            paper_path: Some(paper_path),
            fingerprint,
            depends_on: Vec::new(),
            dep_policy: DepPolicy::AllSucceeded,
            attempts: 0,
            state: JobState::Queued,
            progress: Some(0.0),
            phase: Some("queued".into()),
            error: None,
            force,
            task_id,
        };
        let snapshot = job.snapshot();
        inner.active_keys.insert(key, id.clone());
        inner.lanes.push(lane, id.clone());
        inner.jobs.insert(id, job);
        snapshot
    }

    pub async fn promote_paper(&self, vault: &Path, path: &str) -> Vec<JobSnapshot> {
        let vault = normalize_vault_path(vault.to_path_buf());
        let mut snapshots = Vec::new();
        let mut inner = self.inner.lock().await;
        let ids: Vec<JobId> = inner
            .jobs
            .iter()
            .filter(|(_, job)| {
                job.state == JobState::Queued
                    && job.vault_path == vault
                    && job.paper_path.as_deref() == Some(path)
            })
            .map(|(id, _)| id.clone())
            .collect();

        for id in ids {
            if let Some(job) = inner.jobs.get_mut(&id) {
                job.lane = JobLane::Focus;
                snapshots.push(job.snapshot());
            }
            inner.lanes.promote_to_focus(&id);
        }
        snapshots
    }

    pub async fn cancel(&self, job_id: &str) -> bool {
        let mut inner = self.inner.lock().await;
        let id = JobId(job_id.to_string());
        let Some(job) = inner.jobs.get_mut(&id) else {
            return false;
        };
        match job.state {
            JobState::Queued => {
                job.state = JobState::Cancelled;
                job.progress = None;
                job.phase = Some("cancelled".into());
                inner.lanes.remove(&id);
                release_active_key(&mut inner, &id);
                true
            }
            JobState::Running => {
                job.state = JobState::Cancelled;
                job.progress = None;
                job.phase = Some("cancelled".into());
                let kind = job.kind;
                // Signal the executing worker / renderer to stop. ParseBody's
                // liteparse worker polls this flag; the layout executor aborts
                // on the `job:changed(cancelled)` event emitted by the caller.
                let task_id = job.task_id.clone().unwrap_or_else(|| job.id.0.clone());
                release_running_slot(&mut inner, kind);
                crate::core::background_tasks::cancel(&task_id);
                release_active_key(&mut inner, &id);
                true
            }
            _ => false,
        }
    }

    /// Cancel every queued/running job for one paper (or for papers nested
    /// under `rel`), e.g. when the paper folder moves to the recycle bin.
    /// Returns the snapshots of the cancelled jobs so callers can emit
    /// `job:changed` and drain freed slots.
    pub async fn cancel_for_paper(&self, vault: &Path, rel: &str) -> Vec<JobSnapshot> {
        let vault = normalize_vault_path(vault.to_path_buf());
        let prefix = format!("{rel}/");
        let ids: Vec<JobId> = {
            let inner = self.inner.lock().await;
            inner
                .jobs
                .iter()
                .filter(|(_, job)| {
                    job.vault_path == vault
                        && job
                            .paper_path
                            .as_deref()
                            .is_some_and(|p| p == rel || p.starts_with(prefix.as_str()))
                })
                .map(|(id, _)| id.clone())
                .collect()
        };
        let mut cancelled = Vec::new();
        for id in ids {
            if self.cancel(&id.0).await {
                if let Some(snapshot) = self.snapshot(&id.0).await {
                    cancelled.push(snapshot);
                }
            }
        }
        cancelled
    }

    /// Current snapshot for a job id, if it exists.
    pub async fn snapshot(&self, job_id: &str) -> Option<JobSnapshot> {
        let inner = self.inner.lock().await;
        inner
            .jobs
            .get(&JobId(job_id.to_string()))
            .map(Job::snapshot)
    }

    pub async fn list(&self, vault: Option<&Path>, path: Option<&str>) -> Vec<JobSnapshot> {
        let vault = vault.map(|vault| normalize_vault_path(vault.to_path_buf()));
        let inner = self.inner.lock().await;
        inner
            .jobs
            .values()
            .filter(|job| {
                vault.as_ref().is_none_or(|vault| &job.vault_path == vault)
                    && path.is_none_or(|path| job.paper_path.as_deref() == Some(path))
            })
            .map(Job::snapshot)
            .collect()
    }

    pub async fn try_start(&self, job_id: &str) -> StartOutcome {
        let mut inner = self.inner.lock().await;
        let id = JobId(job_id.to_string());
        let readiness = {
            let Some(job) = inner.jobs.get(&id) else {
                return StartOutcome::Waiting;
            };
            if job.state != JobState::Queued {
                return StartOutcome::Waiting;
            }
            deps_readiness(&inner, job)
        };
        match readiness {
            DepsReadiness::Pending => StartOutcome::Waiting,
            DepsReadiness::Unreachable => {
                let job = inner.jobs.get_mut(&id).expect("job exists");
                job.state = JobState::Skipped;
                job.phase = Some("dependency failed".into());
                let snapshot = job.snapshot();
                inner.lanes.remove(&id);
                release_active_key(&mut inner, &id);
                StartOutcome::Skipped(snapshot)
            }
            DepsReadiness::Ready => {
                let Some(kind) = inner.jobs.get(&id).map(|job| job.kind) else {
                    return StartOutcome::Waiting;
                };
                let running = inner.running_by_kind.get(&kind).copied().unwrap_or(0);
                if running >= kind_concurrency(&inner, kind) {
                    // Kind is at its concurrency cap; stay queued until a slot
                    // frees and the post-finish drain re-tries this job.
                    return StartOutcome::Waiting;
                }
                match mark_running_locked(&mut inner, &id) {
                    Some(started) => StartOutcome::Started(started),
                    None => StartOutcome::Waiting,
                }
            }
        }
    }

    /// Re-evaluate every `Queued` job whose `depends_on` includes `finished_id`,
    /// now that it has settled. Callers spawn the returned `Started` jobs and
    /// emit `job:changed` for `Skipped` ones; `Waiting` entries are left queued.
    async fn wake_dependents(&self, finished_id: &str) -> Vec<StartOutcome> {
        let finished = JobId(finished_id.to_string());
        let candidate_ids: Vec<JobId> = {
            let inner = self.inner.lock().await;
            inner
                .jobs
                .values()
                .filter(|job| job.state == JobState::Queued && job.depends_on.contains(&finished))
                .map(|job| job.id.clone())
                .collect()
        };
        let mut outcomes = Vec::with_capacity(candidate_ids.len());
        for id in candidate_ids {
            outcomes.push(self.try_start(&id.0).await);
        }
        outcomes
    }

    /// Shared runner skeleton: announce the started job, await the kind-specific
    /// `work`, map its [`RunOutcome`] onto `finish`, then wake dependents.
    /// `work` receives a center handle, the app handle and the started job; it
    /// must not call `finish` itself. Public so business domains can build
    /// their registered runners on it. Boxed to avoid an unresolvable
    /// recursive opaque-`Future` type: runners call
    /// `wake_and_spawn_dependents`, which may spawn and run this same
    /// skeleton for a newly-ready dependent job.
    pub fn run_job<F, Fut>(
        self,
        app: tauri::AppHandle,
        started: StartedJob,
        work: F,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
    where
        F: FnOnce(JobCenter, tauri::AppHandle, StartedJob) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = RunOutcome> + Send + 'static,
    {
        Box::pin(async move {
            let job_id = started.snapshot.id.clone();
            emit_job_changed(&app, started.snapshot.clone());

            let outcome = work(self.handle(), app.clone(), started).await;
            let snapshot = match outcome {
                RunOutcome::Succeeded => {
                    self.finish(
                        &job_id,
                        JobState::Succeeded,
                        Some(100.0),
                        Some("completed"),
                        None,
                    )
                    .await
                }
                RunOutcome::Failed(error) => {
                    self.finish(&job_id, JobState::Failed, None, Some("failed"), error)
                        .await
                }
                RunOutcome::Cancelled => {
                    self.finish(&job_id, JobState::Cancelled, None, Some("cancelled"), None)
                        .await
                }
            };
            if let Some(snapshot) = snapshot {
                emit_job_changed(&app, snapshot);
            }
            self.wake_and_spawn_dependents(&app, &job_id).await;
        })
    }

    /// Run the registered runner for a job `try_start` just moved to
    /// `Running`, inline in the caller's task. Kinds without a registered
    /// runner are no-ops (they never start backend-side).
    pub async fn run_started(&self, app: &tauri::AppHandle, started: StartedJob) {
        let runner = {
            let inner = self.inner.lock().await;
            inner.runners.get(&started.snapshot.kind).cloned()
        };
        if let Some(runner) = runner {
            runner(self.handle(), app.clone(), started).await;
        }
    }

    /// Spawn the runner for a job `try_start` just moved to `Running`.
    pub fn spawn_runner(&self, app: &tauri::AppHandle, started: StartedJob) {
        let center = self.handle();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            center.run_started(&app, started).await;
        });
    }

    /// Wake `Queued` jobs depending on `finished_id` and spawn any that became
    /// runnable; emits `job:changed` for jobs that transitioned to `Skipped`.
    async fn wake_and_spawn_dependents(&self, app: &tauri::AppHandle, finished_id: &str) {
        for outcome in self.wake_dependents(finished_id).await {
            match outcome {
                StartOutcome::Started(started) => self.spawn_runner(app, started),
                StartOutcome::Skipped(snapshot) => emit_job_changed(app, snapshot),
                StartOutcome::Waiting => {}
            }
        }
        self.drain_and_spawn(app).await;
    }

    /// Start any `Queued` job whose dependencies are ready and whose kind has
    /// a free concurrency slot, spawning its runner. Runs after every finish so
    /// a freed slot progresses the queue (lane order: focus, normal, idle).
    pub async fn drain_and_spawn(&self, app: &tauri::AppHandle) {
        loop {
            let candidate = {
                let inner = self.inner.lock().await;
                let mut found = None;
                'outer: for queue in [&inner.lanes.focus, &inner.lanes.normal, &inner.lanes.idle] {
                    for id in queue {
                        let Some(job) = inner.jobs.get(id) else {
                            continue;
                        };
                        if job.state != JobState::Queued {
                            continue;
                        }
                        let kind = job.kind;
                        let running = inner.running_by_kind.get(&kind).copied().unwrap_or(0);
                        if running >= kind_concurrency(&inner, kind) {
                            continue;
                        }
                        if deps_readiness(&inner, job) != DepsReadiness::Ready {
                            continue;
                        }
                        found = Some(id.clone());
                        break 'outer;
                    }
                }
                found
            };
            let Some(id) = candidate else {
                return;
            };
            match self.try_start(&id.0).await {
                StartOutcome::Started(started) => self.spawn_runner(app, started),
                StartOutcome::Skipped(snapshot) => emit_job_changed(app, snapshot),
                // Slot filled between the scan and try_start, or not startable;
                // stop draining and let the next finish re-try.
                StartOutcome::Waiting => return,
            }
        }
    }

    async fn finish(
        &self,
        job_id: &str,
        state: JobState,
        progress: Option<f32>,
        phase: Option<&str>,
        error: Option<String>,
    ) -> Option<JobSnapshot> {
        let mut inner = self.inner.lock().await;
        let id = JobId(job_id.to_string());
        let job = inner.jobs.get_mut(&id)?;
        // Already settled (e.g. cancelled mid-run or renderer job_report set the
        // terminal state): keep it so a runner's late finish() cannot overwrite
        // it, don't double-free the slot, and return None so the terminal
        // snapshot (already emitted at the real transition) isn't emitted twice.
        if matches!(
            job.state,
            JobState::Succeeded | JobState::Failed | JobState::Cancelled | JobState::Skipped
        ) {
            return None;
        }
        let was_running = job.state == JobState::Running;
        let kind = job.kind;
        job.state = state;
        job.progress = progress;
        job.phase = phase.map(str::to_string);
        job.error = error;
        let snapshot = job.snapshot();
        release_active_key(&mut inner, &id);
        if was_running {
            release_running_slot(&mut inner, kind);
        }
        Some(snapshot)
    }

    /// Apply a progress or terminal-state report from the renderer executor.
    /// Returns the updated snapshot when the job exists and is still running.
    ///
    /// A terminal `state` (succeeded / failed / cancelled) must free the kind's
    /// concurrency slot here. The runner then sees the terminal state via
    /// `wait_for_terminal` and `finish()` is a no-op; if we left the slot held,
    /// every later job of that kind would stay queued forever.
    pub async fn job_report(
        &self,
        job_id: &str,
        progress: Option<f32>,
        phase: Option<String>,
        error: Option<String>,
        state: Option<JobState>,
    ) -> Option<JobSnapshot> {
        let mut inner = self.inner.lock().await;
        let id = JobId(job_id.to_string());
        let (snapshot, terminal_kind) = {
            let job = inner.jobs.get_mut(&id)?;
            if job.state != JobState::Running {
                return None;
            }
            if let Some(p) = progress {
                job.progress = Some(p);
            }
            if let Some(phase) = phase {
                job.phase = Some(phase);
            }
            if let Some(error) = error {
                job.error = Some(error);
            }
            let terminal_kind = match state {
                Some(next) if is_terminal_state(next) => {
                    job.state = next;
                    Some(job.kind)
                }
                Some(next) => {
                    job.state = next;
                    None
                }
                None => None,
            };
            (job.snapshot(), terminal_kind)
        };
        if let Some(kind) = terminal_kind {
            release_active_key(&mut inner, &id);
            release_running_slot(&mut inner, kind);
        }
        Some(snapshot)
    }

    async fn wait_for_terminal(
        &self,
        job_id: &str,
        timeout: std::time::Duration,
    ) -> Option<JobState> {
        let start = std::time::Instant::now();
        loop {
            {
                let inner = self.inner.lock().await;
                let id = JobId(job_id.to_string());
                let job = inner.jobs.get(&id)?;
                if matches!(
                    job.state,
                    JobState::Succeeded | JobState::Failed | JobState::Cancelled
                ) {
                    return Some(job.state);
                }
            }
            if start.elapsed() >= timeout {
                return None;
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
    }

    async fn take_error(&self, job_id: &str) -> Option<String> {
        let mut inner = self.inner.lock().await;
        let id = JobId(job_id.to_string());
        inner.jobs.get_mut(&id)?.error.take()
    }

    #[cfg(test)]
    async fn mark_succeeded_for_test(&self, job_id: &str) {
        self.finish(
            job_id,
            JobState::Succeeded,
            Some(100.0),
            Some("completed"),
            None,
        )
        .await;
    }

    #[cfg(test)]
    async fn next_queued_for_test(&self) -> Option<String> {
        self.inner.lock().await.lanes.next_eligible().map(|id| id.0)
    }

    #[cfg(test)]
    async fn enqueue_for_test(
        &self,
        kind: JobKind,
        vault: PathBuf,
        path: &str,
        depends_on: Vec<JobId>,
        dep_policy: DepPolicy,
    ) -> JobId {
        let id = JobId(uuid::Uuid::new_v4().to_string());
        let job = Job {
            id: id.clone(),
            kind,
            lane: JobLane::Normal,
            vault_path: normalize_vault_path(vault),
            paper_path: Some(path.to_string()),
            fingerprint: format!("test:{}", id.0),
            depends_on,
            dep_policy,
            attempts: 0,
            state: JobState::Queued,
            progress: Some(0.0),
            phase: Some("queued".into()),
            error: None,
            force: false,
            task_id: None,
        };
        let mut inner = self.inner.lock().await;
        inner.lanes.push(JobLane::Normal, id.clone());
        inner.jobs.insert(id.clone(), job);
        id
    }

    #[cfg(test)]
    async fn state_for_test(&self, job_id: &str) -> Option<JobState> {
        let inner = self.inner.lock().await;
        inner.jobs.get(&JobId(job_id.to_string())).map(|j| j.state)
    }

    #[cfg(test)]
    async fn running_count_for_test(&self, kind: JobKind) -> usize {
        self.inner
            .lock()
            .await
            .running_by_kind
            .get(&kind)
            .copied()
            .unwrap_or(0)
    }
}

impl Default for JobCenter {
    fn default() -> Self {
        Self::new()
    }
}

/// Built-in runner for [`JobKind::LayoutAnalyze`]: offer the job to the
/// frontend and wait for a terminal `job_report`. The renderer runs the ONNX
/// model and calls back with progress / success / failure. Lives in the
/// scheduler (not a business domain) because it is the renderer-offer
/// protocol itself.
fn layout_analyze_runner(
    center: JobCenter,
    app: tauri::AppHandle,
    started: StartedJob,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    center.run_job(app, started, |center, app, started| async move {
        let job_id = started.snapshot.id.clone();
        let StartedJob {
            vault_path,
            paper_path,
            force,
            ..
        } = started;
        let offer = JobOfferPayload {
            job_id: job_id.clone(),
            kind: JobKind::LayoutAnalyze,
            vault_path: vault_path.to_string_lossy().to_string(),
            paper_path: Some(paper_path),
            force,
        };
        let _ = app.emit(JOB_OFFER_EVENT, offer);

        match center
            .wait_for_terminal(&job_id, LAYOUT_ANALYZE_TIMEOUT)
            .await
        {
            Some(JobState::Succeeded) => RunOutcome::Succeeded,
            Some(JobState::Failed) => RunOutcome::Failed(center.take_error(&job_id).await),
            Some(JobState::Cancelled) => RunOutcome::Cancelled,
            _ => RunOutcome::Failed(Some("layout analyze report timeout".into())),
        }
    })
}

pub fn emit_job_changed(app: &tauri::AppHandle, job: JobSnapshot) {
    let payload = JobChangedPayload { job };
    let _ = app.emit(JOB_CHANGED_EVENT, &payload);
    crate::features::lifecycle::emit_job_terminal(app, &payload.job);
}

pub fn parse_lane(lane: Option<JobLane>) -> JobLane {
    lane.unwrap_or_default()
}

pub fn validate_job_paper(vault_path: &str, path_raw: &str) -> Result<(PathBuf, String), AppError> {
    let vault = crate::core::fs::resolve_vault(vault_path)?;
    let (_, path) = crate::core::fs::resolve_paper_dir(&vault, path_raw)?;
    Ok((vault, path))
}

pub fn spawn_parse_body_after_assets(
    app: Option<&tauri::AppHandle>,
    vault: &Path,
    path_rel: &str,
    force: bool,
) {
    let Some(app) = app else {
        return;
    };
    let app = app.clone();
    let vault = vault.to_path_buf();
    let path_rel = path_rel.to_string();
    tauri::async_runtime::spawn(async move {
        let center = app.state::<JobCenter>().handle();
        let snapshot = center
            .enqueue_parse_body(&vault, &path_rel, JobLane::Normal, force, None)
            .await;
        emit_job_changed(&app, snapshot.clone());
        match center.try_start(&snapshot.id).await {
            StartOutcome::Started(started) => {
                center.run_started(&app, started).await;
            }
            StartOutcome::Skipped(skipped) => emit_job_changed(&app, skipped),
            StartOutcome::Waiting => {}
        }
    });
}

/// Enqueue + try-start one deferred-recognition job for a freshly committed
/// local PDF import (see `import_one_local_pdf`).
pub fn spawn_recognize_metadata(app: Option<&tauri::AppHandle>, vault: &Path, path_rel: &str) {
    let Some(app) = app else {
        return;
    };
    let app = app.clone();
    let vault = vault.to_path_buf();
    let path_rel = path_rel.to_string();
    tauri::async_runtime::spawn(async move {
        let center = app.state::<JobCenter>().handle();
        let snapshot = center
            .enqueue_recognize_metadata(&vault, &path_rel, JobLane::Normal, false)
            .await;
        emit_job_changed(&app, snapshot.clone());
        match center.try_start(&snapshot.id).await {
            StartOutcome::Started(started) => {
                center.run_started(&app, started).await;
            }
            StartOutcome::Skipped(skipped) => emit_job_changed(&app, skipped),
            StartOutcome::Waiting => {}
        }
    });
}

fn release_active_key(inner: &mut JobCenterInner, job_id: &JobId) {
    inner.active_keys.retain(|_, id| id != job_id);
}

fn normalize_vault_path(path: PathBuf) -> PathBuf {
    std::fs::canonicalize(&path).unwrap_or(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault(name: &str) -> PathBuf {
        PathBuf::from(format!("/tmp/agentero-job-center-{name}"))
    }

    #[tokio::test]
    async fn enqueue_dedupes_active_job() {
        let center = JobCenter::new();
        let first = center
            .enqueue_parse_refs(vault("dedupe"), "papers/a", JobLane::Normal, false)
            .await;
        let duplicate = center
            .enqueue_parse_refs(vault("dedupe"), "papers/a", JobLane::Normal, false)
            .await;

        assert_eq!(first.id, duplicate.id);
        assert_eq!(center.list(None, None).await.len(), 1);
    }

    #[tokio::test]
    async fn enqueue_dedupes_active_parse_body_job() {
        let center = JobCenter::new();
        let first = center
            .enqueue_parse_body(
                vault("dedupe-body"),
                "papers/a",
                JobLane::Normal,
                false,
                None,
            )
            .await;
        let duplicate = center
            .enqueue_parse_body(
                vault("dedupe-body"),
                "papers/a",
                JobLane::Normal,
                false,
                None,
            )
            .await;

        assert_eq!(first.id, duplicate.id);
        assert_eq!(first.kind, JobKind::ParseBody);
        assert_eq!(first.fingerprint, "parseBody:v1:force:false");
        assert_eq!(center.list(None, None).await.len(), 1);
    }

    #[tokio::test]
    async fn completed_job_releases_dedupe_key() {
        let center = JobCenter::new();
        let first = center
            .enqueue_parse_refs(vault("release"), "papers/a", JobLane::Normal, false)
            .await;

        center.mark_succeeded_for_test(&first.id).await;

        let next = center
            .enqueue_parse_refs(vault("release"), "papers/a", JobLane::Normal, false)
            .await;
        assert_ne!(first.id, next.id);
    }

    #[tokio::test]
    async fn focus_promotes_matching_paper_jobs() {
        let center = JobCenter::new();
        let vault = vault("focus");
        let target = center
            .enqueue_parse_refs(vault.clone(), "papers/a", JobLane::Normal, false)
            .await;
        center
            .enqueue_parse_refs(vault.clone(), "papers/b", JobLane::Normal, false)
            .await;

        let promoted = center.promote_paper(&vault, "papers/a").await;

        assert_eq!(promoted.len(), 1);
        assert_eq!(promoted[0].id, target.id);
        assert_eq!(promoted[0].lane, JobLane::Focus);
        assert_eq!(
            center.next_queued_for_test().await.as_deref(),
            Some(target.id.as_str())
        );
    }

    #[tokio::test]
    async fn list_filters_by_vault_and_path() {
        let center = JobCenter::new();
        let vault_a = vault("list-a");
        let vault_b = vault("list-b");
        center
            .enqueue_parse_refs(vault_a.clone(), "papers/a", JobLane::Normal, false)
            .await;
        center
            .enqueue_parse_refs(vault_a.clone(), "papers/b", JobLane::Normal, false)
            .await;
        center
            .enqueue_parse_refs(vault_b.clone(), "papers/a", JobLane::Normal, false)
            .await;

        assert_eq!(center.list(Some(&vault_a), None).await.len(), 2);
        let filtered = center.list(Some(&vault_a), Some("papers/a")).await;
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].paper_path.as_deref(), Some("papers/a"));
    }

    #[tokio::test]
    async fn cancel_marks_queued_job_cancelled() {
        let center = JobCenter::new();
        let job = center
            .enqueue_parse_refs(vault("cancel"), "papers/a", JobLane::Normal, false)
            .await;

        assert!(center.cancel(&job.id).await);
        let jobs = center.list(None, Some("papers/a")).await;
        assert_eq!(jobs[0].state, JobState::Cancelled);
    }

    #[tokio::test]
    async fn cancel_for_paper_cancels_matching_and_nested_jobs() {
        let center = JobCenter::new();
        let vault = vault("cancel-paper");
        center
            .enqueue_parse_refs(vault.clone(), "papers/a", JobLane::Normal, false)
            .await;
        center
            .enqueue_parse_body(vault.clone(), "papers/a", JobLane::Normal, false, None)
            .await;
        center
            .enqueue_parse_refs(vault.clone(), "papers/a/sub", JobLane::Normal, false)
            .await;
        let sibling = center
            .enqueue_parse_refs(vault.clone(), "papers/ab", JobLane::Normal, false)
            .await;
        let other = center
            .enqueue_parse_refs(vault.clone(), "papers/b", JobLane::Normal, false)
            .await;

        let cancelled = center.cancel_for_paper(&vault, "papers/a").await;
        assert_eq!(cancelled.len(), 3);
        assert!(cancelled.iter().all(|job| job.state == JobState::Cancelled));

        assert_eq!(
            center.snapshot(&sibling.id).await.unwrap().state,
            JobState::Queued
        );
        assert_eq!(
            center.snapshot(&other.id).await.unwrap().state,
            JobState::Queued
        );
        // Idempotent: nothing left to cancel for that paper.
        assert!(center.cancel_for_paper(&vault, "papers/a").await.is_empty());
    }

    #[test]
    fn dependency_policy_shape_round_trips() {
        let settled = serde_json::to_value(DepPolicy::AllSettled).unwrap();
        let succeeded = serde_json::to_value(DepPolicy::AllSucceeded).unwrap();
        assert_eq!(settled, serde_json::json!("allSettled"));
        assert_eq!(succeeded, serde_json::json!("allSucceeded"));
    }

    #[tokio::test]
    async fn try_start_returns_ready_when_no_deps() {
        let center = JobCenter::new();
        let id = center
            .enqueue_for_test(
                JobKind::ParseRefs,
                vault("try-start-no-deps"),
                "papers/a",
                Vec::new(),
                DepPolicy::AllSucceeded,
            )
            .await;
        match center.try_start(&id.0).await {
            StartOutcome::Started(..) => {}
            other => panic!("expected Started, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn try_start_waits_when_dependency_pending() {
        let center = JobCenter::new();
        let vault = vault("try-start-pending");
        let dep = center
            .enqueue_for_test(
                JobKind::ParseRefs,
                vault.clone(),
                "papers/dep",
                Vec::new(),
                DepPolicy::AllSucceeded,
            )
            .await;
        let dependent = center
            .enqueue_for_test(
                JobKind::ParseBody,
                vault,
                "papers/a",
                vec![dep],
                DepPolicy::AllSucceeded,
            )
            .await;
        match center.try_start(&dependent.0).await {
            StartOutcome::Waiting => {}
            other => panic!("expected Waiting, got {other:?}"),
        }
        assert_eq!(
            center.state_for_test(&dependent.0).await,
            Some(JobState::Queued)
        );
    }

    #[tokio::test]
    async fn try_start_skips_when_all_succeeded_policy_hits_failed_dependency() {
        let center = JobCenter::new();
        let vault = vault("try-start-unreachable");
        let dep = center
            .enqueue_for_test(
                JobKind::ParseRefs,
                vault.clone(),
                "papers/dep",
                Vec::new(),
                DepPolicy::AllSucceeded,
            )
            .await;
        center
            .finish(&dep.0, JobState::Failed, None, Some("failed"), None)
            .await;
        let dependent = center
            .enqueue_for_test(
                JobKind::ParseBody,
                vault,
                "papers/a",
                vec![dep],
                DepPolicy::AllSucceeded,
            )
            .await;
        match center.try_start(&dependent.0).await {
            StartOutcome::Skipped(snapshot) => {
                assert_eq!(snapshot.state, JobState::Skipped);
            }
            other => panic!("expected Skipped, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn try_start_ready_when_all_settled_policy_hits_failed_dependency() {
        let center = JobCenter::new();
        let vault = vault("try-start-all-settled");
        let dep = center
            .enqueue_for_test(
                JobKind::ParseRefs,
                vault.clone(),
                "papers/dep",
                Vec::new(),
                DepPolicy::AllSucceeded,
            )
            .await;
        center
            .finish(&dep.0, JobState::Failed, None, Some("failed"), None)
            .await;
        let dependent = center
            .enqueue_for_test(
                JobKind::ParseBody,
                vault,
                "papers/a",
                vec![dep],
                DepPolicy::AllSettled,
            )
            .await;
        match center.try_start(&dependent.0).await {
            StartOutcome::Started(..) => {}
            other => panic!("expected Started, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn finish_wakes_ready_dependent_job() {
        let center = JobCenter::new();
        let vault = vault("wake-ready");
        let dep = center
            .enqueue_for_test(
                JobKind::ParseRefs,
                vault.clone(),
                "papers/dep",
                Vec::new(),
                DepPolicy::AllSucceeded,
            )
            .await;
        let dependent = center
            .enqueue_for_test(
                JobKind::ParseBody,
                vault,
                "papers/a",
                vec![dep.clone()],
                DepPolicy::AllSucceeded,
            )
            .await;

        center.mark_succeeded_for_test(&dep.0).await;
        let woken = center.wake_dependents(&dep.0).await;

        assert_eq!(woken.len(), 1);
        match &woken[0] {
            StartOutcome::Started(started) => {
                assert_eq!(started.snapshot.kind, JobKind::ParseBody);
                assert_eq!(started.snapshot.id, dependent.0);
            }
            other => panic!("expected Started, got {other:?}"),
        }
        assert_eq!(
            center.state_for_test(&dependent.0).await,
            Some(JobState::Running)
        );
    }

    #[tokio::test]
    async fn finish_skips_dependent_when_dependency_failed_under_all_succeeded() {
        let center = JobCenter::new();
        let vault = vault("wake-skip");
        let dep = center
            .enqueue_for_test(
                JobKind::ParseRefs,
                vault.clone(),
                "papers/dep",
                Vec::new(),
                DepPolicy::AllSucceeded,
            )
            .await;
        let dependent = center
            .enqueue_for_test(
                JobKind::ParseBody,
                vault,
                "papers/a",
                vec![dep.clone()],
                DepPolicy::AllSucceeded,
            )
            .await;

        center
            .finish(&dep.0, JobState::Failed, None, Some("failed"), None)
            .await;
        let woken = center.wake_dependents(&dep.0).await;

        assert_eq!(woken.len(), 1);
        match &woken[0] {
            StartOutcome::Skipped(snapshot) => assert_eq!(snapshot.state, JobState::Skipped),
            other => panic!("expected Skipped, got {other:?}"),
        }
        assert_eq!(
            center.state_for_test(&dependent.0).await,
            Some(JobState::Skipped)
        );
    }

    #[tokio::test]
    async fn enqueue_dedupes_active_layout_analyze_job() {
        let center = JobCenter::new();
        let first = center
            .enqueue_layout_analyze(vault("dedupe-layout"), "papers/a", JobLane::Normal, false)
            .await;
        let duplicate = center
            .enqueue_layout_analyze(vault("dedupe-layout"), "papers/a", JobLane::Normal, false)
            .await;

        assert_eq!(first.id, duplicate.id);
        assert_eq!(first.kind, JobKind::LayoutAnalyze);
        assert_eq!(first.fingerprint, "layoutAnalyze:v1:force:false");
        assert_eq!(center.list(None, None).await.len(), 1);
    }

    #[tokio::test]
    async fn layout_analyze_job_report_updates_progress_and_state() {
        let center = JobCenter::new();
        let snapshot = center
            .enqueue_layout_analyze(vault("layout-report"), "papers/a", JobLane::Normal, false)
            .await;
        match center.try_start(&snapshot.id).await {
            StartOutcome::Started(..) => {}
            other => panic!("expected Started, got {other:?}"),
        }

        let reported = center
            .job_report(
                &snapshot.id,
                Some(42.0),
                Some("analyzing".into()),
                None,
                None,
            )
            .await
            .expect("report returned snapshot");
        assert_eq!(reported.progress, Some(42.0));
        assert_eq!(reported.phase.as_deref(), Some("analyzing"));
        assert_eq!(reported.state, JobState::Running);

        let terminal = center
            .job_report(
                &snapshot.id,
                Some(100.0),
                Some("completed".into()),
                None,
                Some(JobState::Succeeded),
            )
            .await
            .expect("terminal report returned snapshot");
        assert_eq!(terminal.state, JobState::Succeeded);
        assert_eq!(terminal.progress, Some(100.0));
    }

    #[tokio::test]
    async fn layout_analyze_job_report_terminal_frees_concurrency_slot() {
        let center = JobCenter::new();
        let a = center
            .enqueue_layout_analyze(vault("report-free-a"), "papers/a", JobLane::Normal, false)
            .await;
        let b = center
            .enqueue_layout_analyze(vault("report-free-b"), "papers/b", JobLane::Normal, false)
            .await;

        match center.try_start(&a.id).await {
            StartOutcome::Started(..) => {}
            other => panic!("expected first Started, got {other:?}"),
        }
        match center.try_start(&b.id).await {
            StartOutcome::Waiting => {}
            other => panic!("expected second Waiting at cap, got {other:?}"),
        }
        assert_eq!(
            center.running_count_for_test(JobKind::LayoutAnalyze).await,
            1
        );

        // Production path: the renderer reports succeeded, then the runner
        // calls finish(). finish() must not be the only place that frees the slot.
        center
            .job_report(
                &a.id,
                Some(100.0),
                Some("completed".into()),
                None,
                Some(JobState::Succeeded),
            )
            .await
            .expect("terminal report");
        assert_eq!(
            center.running_count_for_test(JobKind::LayoutAnalyze).await,
            0
        );

        center
            .finish(
                &a.id,
                JobState::Succeeded,
                Some(100.0),
                Some("completed"),
                None,
            )
            .await;
        assert_eq!(
            center.running_count_for_test(JobKind::LayoutAnalyze).await,
            0
        );
        match center.try_start(&b.id).await {
            StartOutcome::Started(..) => {}
            other => panic!("expected Started after terminal report freed the slot, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn layout_analyze_job_report_fails_and_sets_error() {
        let center = JobCenter::new();
        let snapshot = center
            .enqueue_layout_analyze(vault("layout-fail"), "papers/a", JobLane::Normal, false)
            .await;
        center.try_start(&snapshot.id).await;

        let reported = center
            .job_report(
                &snapshot.id,
                None,
                None,
                Some("onnx failed".into()),
                Some(JobState::Failed),
            )
            .await
            .expect("failed report returned snapshot");
        assert_eq!(reported.state, JobState::Failed);
        assert_eq!(reported.error.as_deref(), Some("onnx failed"));
    }

    #[tokio::test]
    async fn layout_analyze_job_report_cancelled() {
        let center = JobCenter::new();
        let snapshot = center
            .enqueue_layout_analyze(vault("layout-cancel"), "papers/a", JobLane::Normal, false)
            .await;
        center.try_start(&snapshot.id).await;

        let reported = center
            .job_report(
                &snapshot.id,
                None,
                Some("cancelled".into()),
                None,
                Some(JobState::Cancelled),
            )
            .await
            .expect("cancelled report returned snapshot");
        assert_eq!(reported.state, JobState::Cancelled);
    }

    #[tokio::test]
    async fn layout_analyze_job_report_ignored_when_not_running() {
        let center = JobCenter::new();
        let snapshot = center
            .enqueue_layout_analyze(vault("layout-ignore"), "papers/a", JobLane::Normal, false)
            .await;
        assert!(center
            .job_report(&snapshot.id, Some(50.0), None, None, None)
            .await
            .is_none());

        center.try_start(&snapshot.id).await;
        center
            .finish(&snapshot.id, JobState::Failed, None, Some("failed"), None)
            .await;
        assert!(center
            .job_report(&snapshot.id, Some(75.0), None, None, None)
            .await
            .is_none());
    }

    #[tokio::test]
    async fn layout_analyze_job_waits_for_terminal_state() {
        let center = JobCenter::new();
        let snapshot = center
            .enqueue_layout_analyze(vault("layout-wait"), "papers/a", JobLane::Normal, false)
            .await;
        center.try_start(&snapshot.id).await;

        let reporter = center.handle();
        let id = snapshot.id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            reporter
                .job_report(&id, None, None, None, Some(JobState::Succeeded))
                .await;
        });

        let terminal = center
            .wait_for_terminal(&snapshot.id, std::time::Duration::from_secs(5))
            .await;
        assert_eq!(terminal, Some(JobState::Succeeded));
    }

    #[tokio::test]
    async fn layout_analyze_job_times_out_waiting_for_terminal_state() {
        let center = JobCenter::new();
        let snapshot = center
            .enqueue_layout_analyze(vault("layout-timeout"), "papers/a", JobLane::Normal, false)
            .await;
        center.try_start(&snapshot.id).await;

        let terminal = center
            .wait_for_terminal(&snapshot.id, std::time::Duration::from_millis(100))
            .await;
        assert_eq!(terminal, None);
    }

    #[tokio::test]
    async fn layout_analyze_concurrency_cap_is_one() {
        let center = JobCenter::new();
        let a = center
            .enqueue_layout_analyze(vault("conc-layout-a"), "papers/a", JobLane::Normal, false)
            .await;
        let b = center
            .enqueue_layout_analyze(vault("conc-layout-b"), "papers/b", JobLane::Normal, false)
            .await;

        match center.try_start(&a.id).await {
            StartOutcome::Started(..) => {}
            other => panic!("expected first Started, got {other:?}"),
        }
        // LayoutAnalyze cap is 1: the second stays queued while the first runs.
        match center.try_start(&b.id).await {
            StartOutcome::Waiting => {}
            other => panic!("expected second Waiting at cap, got {other:?}"),
        }

        center
            .finish(
                &a.id,
                JobState::Succeeded,
                Some(100.0),
                Some("completed"),
                None,
            )
            .await;
        // Slot freed: the queued job can now start.
        match center.try_start(&b.id).await {
            StartOutcome::Started(..) => {}
            other => panic!("expected Started after slot freed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn layout_analyze_paddle_backend_has_no_concurrency_cap() {
        let center = JobCenter::new();
        center.apply_layout_backend("paddle").await;
        let a = center
            .enqueue_layout_analyze(vault("paddle-a"), "papers/a", JobLane::Normal, false)
            .await;
        let b = center
            .enqueue_layout_analyze(vault("paddle-b"), "papers/b", JobLane::Normal, false)
            .await;

        match center.try_start(&a.id).await {
            StartOutcome::Started(..) => {}
            other => panic!("expected first Started, got {other:?}"),
        }
        match center.try_start(&b.id).await {
            StartOutcome::Started(..) => {}
            other => panic!("expected paddle jobs to start in parallel, got {other:?}"),
        }
        assert_eq!(
            center.running_count_for_test(JobKind::LayoutAnalyze).await,
            2
        );

        center.apply_layout_backend("local").await;
        let c = center
            .enqueue_layout_analyze(vault("paddle-c"), "papers/c", JobLane::Normal, false)
            .await;
        match center.try_start(&c.id).await {
            StartOutcome::Waiting => {}
            other => panic!("expected local cap to apply after switch, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn parse_refs_concurrency_cap_is_two() {
        let center = JobCenter::new();
        let a = center
            .enqueue_parse_refs(vault("conc-refs-a"), "papers/a", JobLane::Normal, false)
            .await;
        let b = center
            .enqueue_parse_refs(vault("conc-refs-b"), "papers/b", JobLane::Normal, false)
            .await;
        let c = center
            .enqueue_parse_refs(vault("conc-refs-c"), "papers/c", JobLane::Normal, false)
            .await;

        match center.try_start(&a.id).await {
            StartOutcome::Started(..) => {}
            other => panic!("expected a Started, got {other:?}"),
        }
        match center.try_start(&b.id).await {
            StartOutcome::Started(..) => {}
            other => panic!("expected b Started, got {other:?}"),
        }
        // ParseRefs cap is 2: the third stays queued.
        match center.try_start(&c.id).await {
            StartOutcome::Waiting => {}
            other => panic!("expected c Waiting at cap, got {other:?}"),
        }

        center
            .finish(
                &a.id,
                JobState::Succeeded,
                Some(100.0),
                Some("completed"),
                None,
            )
            .await;
        match center.try_start(&c.id).await {
            StartOutcome::Started(..) => {}
            other => panic!("expected c Started after slot freed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn concurrency_slots_are_independent_per_kind() {
        let center = JobCenter::new();
        let layout = center
            .enqueue_layout_analyze(vault("conc-mix"), "papers/a", JobLane::Normal, false)
            .await;
        let refs = center
            .enqueue_parse_refs(vault("conc-mix"), "papers/a", JobLane::Normal, false)
            .await;

        // Different kinds do not share slots.
        match center.try_start(&layout.id).await {
            StartOutcome::Started(..) => {}
            other => panic!("expected layout Started, got {other:?}"),
        }
        match center.try_start(&refs.id).await {
            StartOutcome::Started(..) => {}
            other => panic!("expected refs Started alongside layout, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn cancel_running_job_frees_slot_and_keeps_terminal_state() {
        let center = JobCenter::new();
        let a = center
            .enqueue_layout_analyze(vault("cancel-run-a"), "papers/a", JobLane::Normal, false)
            .await;
        let b = center
            .enqueue_layout_analyze(vault("cancel-run-b"), "papers/b", JobLane::Normal, false)
            .await;

        match center.try_start(&a.id).await {
            StartOutcome::Started(..) => {}
            other => panic!("expected a Started, got {other:?}"),
        }
        match center.try_start(&b.id).await {
            StartOutcome::Waiting => {}
            other => panic!("expected b Waiting at cap, got {other:?}"),
        }

        // Cancel the running job: it becomes Cancelled and frees its slot.
        assert!(center.cancel(&a.id).await);
        assert_eq!(
            center.state_for_test(&a.id).await,
            Some(JobState::Cancelled)
        );
        match center.try_start(&b.id).await {
            StartOutcome::Started(..) => {}
            other => panic!("expected b Started after cancel freed the slot, got {other:?}"),
        }

        // A late finish() from the runner must not overwrite the Cancelled state.
        center
            .finish(&a.id, JobState::Failed, None, Some("failed"), None)
            .await;
        assert_eq!(
            center.state_for_test(&a.id).await,
            Some(JobState::Cancelled)
        );
    }

    #[tokio::test]
    async fn enqueue_dedupes_active_download_assets_job() {
        let center = JobCenter::new();
        let first = center
            .enqueue_download_assets(vault("dedupe-dl"), "papers/a", JobLane::Normal, false)
            .await;
        let duplicate = center
            .enqueue_download_assets(vault("dedupe-dl"), "papers/a", JobLane::Normal, false)
            .await;

        assert_eq!(first.id, duplicate.id);
        assert_eq!(first.kind, JobKind::DownloadAssets);
        assert_eq!(first.fingerprint, "downloadAssets:v1:force:false");
        assert_eq!(center.list(None, None).await.len(), 1);
    }
}
