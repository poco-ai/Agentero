//! Paper import: identifier lookup, Translator, local PDF, PAPER.md parse.
//!
//! The tauri-free pipeline lives in `agentero_core::features::paper::import`
//! and is glob-re-exported here; this module keeps the desktop-only shells:
//! Tauri commands, JobCenter runners, remote-import ops, deferred metadata
//! recognition, and the settings-backed parser config refresh.
//!
//! @see docs/backend/identifier-lookup.md
//! @see docs/backend/paper-import-pipeline.md

pub use agentero_core::features::paper::import::*;

#[cfg(feature = "desktop")]
pub mod commands;
#[cfg(feature = "desktop")]
pub mod job_runners;
#[cfg(feature = "desktop")]
pub mod recognize;
#[cfg(feature = "desktop")]
pub mod remote_ops;

#[cfg(feature = "desktop")]
pub use remote_ops::RemoteImportOps;

// pdf_parse engine config refresh (settings-backed; desktop only). Registered
// engines resolve through the core engine registry.
#[cfg(all(
    feature = "desktop",
    not(any(target_os = "ios", target_os = "android"))
))]
pub use crate::features::paper::analyze::body_engines::refresh_parser_config;

/// Whether an import commit must queue the layout follow-up itself (plaza
/// imports). True only for a new paper with a locally downloaded PDF and no
/// `RecognizeMetadata` step: recognition owns the follow-ups against the
/// post-rename path, so queueing layout now would race it.
#[cfg(feature = "desktop")]
pub fn commit_needs_layout_follow_up(commit: &paper_import::PaperCommitResult) -> bool {
    commit.status == CommitStatus::Created
        && commit.pdf
        && !commit
            .preparation
            .steps
            .iter()
            .any(|step| matches!(step, PreparationStep::RecognizeMetadata))
}

/// Resolve the configured NOTES shell mode from the managed settings store.
#[cfg(feature = "desktop")]
pub fn note_mode_from_app(app: &tauri::AppHandle) -> NoteShellMode {
    use tauri::Manager;
    app.state::<crate::features::system::settings::AppSettingsStore>()
        .get()
        .map(|r| NoteShellMode::parse(&r.settings.paper_note_mode))
        .unwrap_or(NoteShellMode::Standard)
}

#[cfg(all(test, feature = "desktop"))]
mod tests {
    use super::*;
    use crate::features::paper::import::paper_import::PaperCommitResult;

    fn commit(status: CommitStatus, pdf: bool, steps: Vec<PreparationStep>) -> PaperCommitResult {
        PaperCommitResult {
            status,
            path: "papers/x".into(),
            id: "x".into(),
            title: "X".into(),
            paper_dir: "/vault/papers/x".into(),
            pdf,
            tex: false,
            paper_md: false,
            asset_messages: Vec::new(),
            assets_pending: false,
            preparation: PreparationPlan {
                vault_rel: "papers/x".into(),
                steps,
            },
        }
    }

    #[test]
    fn layout_follow_up_requires_a_new_pdf_commit() {
        assert!(commit_needs_layout_follow_up(&commit(
            CommitStatus::Created,
            true,
            vec![PreparationStep::ParseBody { force: false }],
        )));
        assert!(!commit_needs_layout_follow_up(&commit(
            CommitStatus::Created,
            false,
            vec![PreparationStep::ParseBody { force: false }],
        )));
        assert!(!commit_needs_layout_follow_up(&commit(
            CommitStatus::Deduped,
            true,
            Vec::new(),
        )));
        assert!(!commit_needs_layout_follow_up(&commit(
            CommitStatus::Skipped,
            true,
            Vec::new(),
        )));
    }

    #[test]
    fn recognition_owns_the_layout_follow_up() {
        assert!(!commit_needs_layout_follow_up(&commit(
            CommitStatus::Created,
            true,
            vec![PreparationStep::RecognizeMetadata],
        )));
    }
}
