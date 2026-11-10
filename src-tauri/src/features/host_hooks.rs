//! Desktop [`HostHooks`] implementation: routes the tauri-free host
//! callbacks from `agentero_core::app_handle` to the desktop runtime —
//! Tauri events for `emit`, JobCenter spawns for callers that still
//! schedule directly (auto-ingest, Connector standalone recognition).
//!
//! Paper commit and asset download do not call those spawn hooks. They
//! return a [`PreparationPlan`]; [`enqueue_preparation_plan`] puts the same
//! jobs on the JobCenter.
//!
//! Lives in `features/` (not `core/`) because it depends on
//! `features::jobs` / `features::paper::analyze::refs`; `crate::core::app_handle` only
//! re-exports the tauri-free bridge types.

use crate::core::app_handle::{AppHandle, HostHooks};
use agentero_core::features::paper::import::{PreparationPlan, PreparationStep};
use std::path::Path;
use std::sync::Arc;
use tauri::Emitter;

/// Routes the host callbacks to the desktop runtime: Tauri events for
/// `emit`, JobCenter spawns for the follow-up jobs.
pub struct TauriHostHooks(pub tauri::AppHandle);

impl HostHooks for TauriHostHooks {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        if let Err(e) = self.0.emit(event, payload) {
            log::warn!(target: "agentero::lifecycle", "emit {event} failed: {e}");
        }
    }
    fn spawn_parse_body_after_assets(&self, vault: &Path, path_rel: &str, force: bool) {
        crate::features::jobs::spawn_parse_body_after_assets(Some(&self.0), vault, path_rel, force);
    }
    fn spawn_parse_after_import(&self, vault: &Path, path_rel: &str) -> bool {
        crate::features::paper::analyze::refs::spawn_parse_after_import(
            Some(&self.0),
            vault,
            path_rel,
        );
        true
    }
    fn spawn_recognize_metadata(&self, vault: &Path, path_rel: &str) {
        crate::features::jobs::spawn_recognize_metadata(Some(&self.0), vault, path_rel);
    }

    fn spawn_layout_analysis(&self, vault: &Path, path_rel: &str) {
        crate::features::jobs::spawn_layout_after_import(Some(&self.0), vault, path_rel);
    }
}

/// Wrap a desktop handle for the migrated (tauri-free) service APIs.
pub fn wrap(app: &tauri::AppHandle) -> AppHandle {
    AppHandle::with_hooks(Arc::new(TauriHostHooks(app.clone())))
}

/// Enqueue the jobs a commit or download used to start through [`HostHooks`].
///
/// Same JobCenter helpers and the same `force` flag carried on each
/// `ParseBody` step. An empty plan does nothing.
pub fn enqueue_preparation_plan(app: &tauri::AppHandle, vault: &Path, plan: &PreparationPlan) {
    for step in &plan.steps {
        match step {
            PreparationStep::ParseBody { force } => {
                crate::features::jobs::spawn_parse_body_after_assets(
                    Some(app),
                    vault,
                    &plan.vault_rel,
                    *force,
                );
            }
            PreparationStep::ParseRefs => {
                crate::features::paper::analyze::refs::spawn_parse_after_import(
                    Some(app),
                    vault,
                    &plan.vault_rel,
                );
            }
            PreparationStep::RecognizeMetadata => {
                crate::features::jobs::spawn_recognize_metadata(Some(app), vault, &plan.vault_rel);
            }
        }
    }
}
