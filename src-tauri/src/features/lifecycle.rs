//! Semantic lifecycle events emitted at key backend milestones.
//!
//! @see docs/development/lifecycle-events.md

#[cfg(not(feature = "desktop"))]
use crate::core::app_handle::AppHandle;
use serde::Serialize;
use std::path::Path;
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Emitter};

pub const PAPER_IMPORTED_EVENT: &str = "paper:imported";
pub const PAPER_ASSETS_READY_EVENT: &str = "paper:assets-ready";
pub const PAPER_RENAMED_EVENT: &str = "paper:renamed";
#[cfg(feature = "desktop")]
pub const JOB_COMPLETED_EVENT: &str = "job:completed";
#[cfg(feature = "desktop")]
pub const JOB_FAILED_EVENT: &str = "job:failed";

/// Envelope for paper fact events; `vault_id` is the absolute vault root path
/// (same identity as `JobSnapshot.vault_path` / catalog access).
#[cfg_attr(not(feature = "desktop"), allow(dead_code))]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PaperEventPayload {
    vault_id: String,
    paper_id: String,
    timestamp: i64,
}

pub fn emit_paper_imported(app: Option<&AppHandle>, vault: &Path, paper_id: &str) {
    emit_paper_event(app, PAPER_IMPORTED_EVENT, vault, paper_id);
}

pub fn emit_paper_assets_ready(app: Option<&AppHandle>, vault: &Path, paper_id: &str) {
    emit_paper_event(app, PAPER_ASSETS_READY_EVENT, vault, paper_id);
}

/// Fact payload for `paper:renamed`: a committed paper folder changed identity
/// (canonical-id rename or merge into an existing entry) after deferred
/// metadata recognition.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperRenamedEvent {
    /// Previous folder basename (placeholder slug).
    pub old_paper_id: String,
    /// Final folder basename (canonical id, or the merged-into entry id).
    pub new_paper_id: String,
    /// Previous vault-relative folder path.
    pub old_path: String,
    /// Final vault-relative folder path.
    pub new_path: String,
    /// `renamed` = folder moved to the canonical id; `merged` = the
    /// placeholder was merged into an existing entry and removed.
    pub outcome: String,
    /// Markdown sources whose internal links the rename transaction rewrote.
    pub updated_sources: Vec<String>,
}

pub fn emit_paper_renamed(app: Option<&AppHandle>, vault: &Path, event: PaperRenamedEvent) {
    #[cfg(not(feature = "desktop"))]
    let _ = (app, vault, event);
    #[cfg(feature = "desktop")]
    {
        let Some(app) = app else { return };
        #[derive(Clone, Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Payload<'a> {
            vault_id: String,
            #[serde(flatten)]
            event: &'a PaperRenamedEvent,
            timestamp: i64,
        }
        emit_or_log(
            app,
            PAPER_RENAMED_EVENT,
            Payload {
                vault_id: vault.to_string_lossy().to_string(),
                event: &event,
                timestamp: now_ms(),
            },
        );
    }
}

fn emit_paper_event(app: Option<&AppHandle>, event: &str, vault: &Path, paper_id: &str) {
    #[cfg(not(feature = "desktop"))]
    let _ = (app, event, vault, paper_id);
    #[cfg(feature = "desktop")]
    {
        let Some(app) = app else { return };
        emit_or_log(
            app,
            event,
            PaperEventPayload {
                vault_id: vault.to_string_lossy().to_string(),
                paper_id: paper_id.to_string(),
                timestamp: now_ms(),
            },
        );
    }
}

#[cfg(feature = "desktop")]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobEventPayload {
    job_id: String,
    kind: crate::features::jobs::JobKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    paper_id: Option<String>,
    timestamp: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Derive `job:completed` / `job:failed` when a job snapshot is terminal.
#[cfg(feature = "desktop")]
pub fn emit_job_terminal(app: &AppHandle, job: &crate::features::jobs::JobSnapshot) {
    use crate::features::jobs::JobState;
    let (event, error) = match job.state {
        JobState::Succeeded => (JOB_COMPLETED_EVENT, None),
        JobState::Failed => (JOB_FAILED_EVENT, job.error.clone()),
        _ => return,
    };
    let paper_id = job
        .paper_path
        .as_deref()
        .and_then(|p| p.rsplit(['/', '\\']).next())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if job.kind == crate::features::jobs::JobKind::DownloadAssets
        && job.state == JobState::Succeeded
    {
        if let Some(pid) = paper_id.as_deref() {
            emit_paper_assets_ready(Some(app), Path::new(&job.vault_path), pid);
        }
    }
    emit_or_log(
        app,
        event,
        JobEventPayload {
            job_id: job.id.clone(),
            kind: job.kind,
            paper_id,
            timestamp: now_ms(),
            error,
        },
    );
}

#[cfg(feature = "desktop")]
fn emit_or_log<T: Serialize + Clone>(app: &AppHandle, event: &str, payload: T) {
    if let Err(e) = app.emit(event, payload) {
        log::warn!(target: "agentero::lifecycle", "emit {event} failed: {e}");
    }
}

#[cfg(feature = "desktop")]
fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
