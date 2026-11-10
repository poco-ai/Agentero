//! Semantic lifecycle events emitted at key backend milestones.
//!
//! The tauri-free paper fact events live in `agentero_core::features::lifecycle`
//! and are re-exported here so `crate::features::lifecycle::X` paths stay
//! stable. This file keeps the desktop job events, which depend on the
//! JobCenter snapshot types.
//!
//! @see docs/architecture.md

pub use agentero_core::features::lifecycle::*;

#[cfg(feature = "desktop")]
use serde::Serialize;
#[cfg(feature = "desktop")]
use std::path::Path;
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Emitter};

#[cfg(feature = "desktop")]
pub const JOB_COMPLETED_EVENT: &str = "job:completed";
#[cfg(feature = "desktop")]
pub const JOB_FAILED_EVENT: &str = "job:failed";

#[cfg(feature = "desktop")]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobEventPayload {
    job_id: String,
    kind: crate::features::jobs::JobKind,
    /// Vault root as passed by the job's enqueuing caller (`JobSnapshot.vault_id`):
    /// frontend-initiated jobs carry the exact `getVaultPath()` string, so
    /// consumers can filter by active vault. Host-internal jobs (watcher /
    /// recognize) carry the Host's own form, usually canonical — on Windows
    /// that includes the `\\?\` prefix, so comparisons must tolerate both
    /// spellings (see `docs/backend/api.md`, `job:completed`).
    vault_id: String,
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
            let host_app = crate::features::host_hooks::wrap(app);
            emit_paper_assets_ready(
                Some(&host_app),
                Path::new(&job.vault_id),
                pid,
                job.paper_path.as_deref().unwrap_or(""),
            );
        }
    }
    emit_or_log(
        app,
        event,
        JobEventPayload {
            job_id: job.id.clone(),
            kind: job.kind,
            vault_id: job.vault_id.clone(),
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

/// Anti-drift: bind the owned `JobTerminalPayload` mirror (in
/// `app::events_contract`, feeding the `job:completed` / `job:failed` payload
/// types in bindings.ts) to the private `JobEventPayload` actually emitted
/// here. The private struct is only reachable from this module, so the test
/// lives next to it: serde shapes must be identical (both `Some` and `None`
/// variants, covering `rename_all` + `skip_serializing_if`) and the field
/// types must be identical at compile time.
#[cfg(all(test, feature = "desktop"))]
mod events_contract_shape_tests {
    use super::JobEventPayload;
    use crate::app::events_contract::JobTerminalPayload;
    use crate::features::jobs::JobKind;

    fn samples() -> (JobEventPayload, JobTerminalPayload) {
        (
            JobEventPayload {
                job_id: "job-1".to_string(),
                kind: JobKind::ParseBody,
                vault_id: "/tmp/vault".to_string(),
                paper_id: Some("paper-1".to_string()),
                timestamp: 1_700_000_000_000,
                error: Some("boom".to_string()),
            },
            JobTerminalPayload {
                job_id: "job-1".to_string(),
                kind: JobKind::ParseBody,
                vault_id: "/tmp/vault".to_string(),
                paper_id: Some("paper-1".to_string()),
                timestamp: 1_700_000_000_000,
                error: Some("boom".to_string()),
            },
        )
    }

    #[test]
    fn job_terminal_mirror_matches_emit_payload_shape() {
        let (real, mirror) = samples();
        assert_eq!(
            serde_json::to_value(&real).unwrap(),
            serde_json::to_value(&mirror).unwrap(),
            "JobTerminalPayload mirror drifted from JobEventPayload"
        );
        let real_none = JobEventPayload {
            paper_id: None,
            error: None,
            ..samples().0
        };
        let mirror_none = JobTerminalPayload {
            paper_id: None,
            error: None,
            ..samples().1
        };
        assert_eq!(
            serde_json::to_value(&real_none).unwrap(),
            serde_json::to_value(&mirror_none).unwrap(),
            "JobTerminalPayload mirror drifted from JobEventPayload (None variant)"
        );
    }

    #[test]
    fn job_terminal_mirror_field_types_match() {
        fn eq_type<T>(_: &T, _: &T) {}
        let (real, mirror) = samples();
        eq_type(&real.job_id, &mirror.job_id);
        eq_type(&real.kind, &mirror.kind);
        eq_type(&real.vault_id, &mirror.vault_id);
        eq_type(&real.paper_id, &mirror.paper_id);
        eq_type(&real.timestamp, &mirror.timestamp);
        eq_type(&real.error, &mirror.error);
    }
}
