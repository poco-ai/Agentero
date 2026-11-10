//! Semantic lifecycle events emitted at key backend milestones (tauri-free).
//!
//! The desktop job events (`job:completed` / `job:failed`) stay in the Host
//! crate (`agentero_lib::features::lifecycle`) because they depend on the
//! JobCenter; the paper fact events live here and reach the frontend through
//! the [`crate::app_handle::HostHooks`] emit callback.
//!
//! @see docs/architecture.md

use crate::app_handle::AppHandle;
use serde::Serialize;
use std::path::Path;

pub const PAPER_IMPORTED_EVENT: &str = "paper:imported";
pub const PAPER_ASSETS_READY_EVENT: &str = "paper:assets-ready";
pub const PAPER_RENAMED_EVENT: &str = "paper:renamed";

/// Envelope for paper fact events; `vault_id` is the vault root as passed by
/// the emit site: frontend-initiated flows carry the frontend's own path
/// string (`getVaultPath()`), host-internal flows (recognize etc.) the Host's
/// form, usually canonical — not a fixed canonicalization identity.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PaperEventPayload {
    vault_id: String,
    paper_id: String,
    /// Vault-relative paper folder. Empty when the emitter only knows the id.
    path: String,
    timestamp: i64,
}

pub fn emit_paper_imported(app: Option<&AppHandle>, vault: &Path, paper_id: &str, path: &str) {
    emit_paper_event(app, PAPER_IMPORTED_EVENT, vault, paper_id, path);
}

pub fn emit_paper_assets_ready(app: Option<&AppHandle>, vault: &Path, paper_id: &str, path: &str) {
    emit_paper_event(app, PAPER_ASSETS_READY_EVENT, vault, paper_id, path);
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
    let Some(app) = app else { return };
    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Payload<'a> {
        vault_id: String,
        #[serde(flatten)]
        event: &'a PaperRenamedEvent,
        timestamp: i64,
    }
    app.emit(
        PAPER_RENAMED_EVENT,
        &Payload {
            vault_id: vault.to_string_lossy().to_string(),
            event: &event,
            timestamp: now_ms(),
        },
    );
}

fn emit_paper_event(
    app: Option<&AppHandle>,
    event: &str,
    vault: &Path,
    paper_id: &str,
    path: &str,
) {
    let Some(app) = app else { return };
    app.emit(
        event,
        &PaperEventPayload {
            vault_id: vault.to_string_lossy().to_string(),
            paper_id: paper_id.to_string(),
            path: crate::fs::normalize_rel_separators(path),
            timestamp: now_ms(),
        },
    );
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
