//! Desktop / CLI side effects that the shared tool surface must not own.
//!
//! The default methods are the headless behavior: no job queue, no live wiki
//! index, paper text hidden, import follow-up logged and skipped.

use super::McpStatus;
use agentero_core::features::paper::import::{skipped_preparation_line, PreparationPlan};
use agentero_core::features::vault::rename::WikiIndex;
use std::path::Path;
use std::sync::{Arc, Mutex};

pub use agentero_core::ops::execute::ImportContext;

#[async_trait::async_trait]
pub trait McpHost: Send + Sync + 'static {
    /// Snapshot the grants for this request, including revocations on a running listener.
    fn permissions(&self) -> crate::Permissions {
        crate::Permissions::default()
    }

    fn import_context(&self) -> ImportContext {
        ImportContext::default()
    }

    /// Desktop enqueues parse / layout jobs. Headless logs the skipped plan.
    fn after_import(&self, _vault: &Path, plan: &PreparationPlan) {
        if let Some(line) = skipped_preparation_line(plan) {
            log::info!(target: "agentero::import", "{line}");
        }
    }

    /// Live wiki index for the vault the desktop app currently has open.
    ///
    /// The tool uses this only when the move stays inside that vault. Other
    /// vaults build a local snapshot so the UI index is not rewritten.
    fn open_wiki_index(&self) -> Option<Arc<Mutex<WikiIndex>>> {
        None
    }

    /// Cancel desktop jobs whose paper path was just deleted.
    async fn after_delete(&self, _vault: &Path, _rels: &[String]) {}

    fn on_status(&self, _status: &McpStatus) {}
}

/// Headless host: every hook keeps its default.
#[derive(Debug, Default)]
pub struct NullHost;

impl McpHost for NullHost {}

#[async_trait::async_trait]
impl agentero_core::ops::execute::OperationHost for crate::McpController {
    fn translator_url(&self) -> Option<String> {
        self.translator_url()
    }
    fn parent_dir(&self) -> String {
        self.parent_dir()
    }
    fn paper_note_mode(&self) -> String {
        self.paper_note_mode()
    }
    fn import_context(&self) -> ImportContext {
        self.host().import_context()
    }
    fn wiki_index(&self, vault: &Path) -> Option<Arc<Mutex<WikiIndex>>> {
        self.local_vault()
            .ok()
            .filter(|p| p == vault)
            .and_then(|_| self.host().open_wiki_index())
    }
    fn after_import(&self, vault: &Path, plan: &PreparationPlan) {
        self.host().after_import(vault, plan);
    }
    async fn after_delete(&self, vault: &Path, paths: &[String]) {
        self.host().after_delete(vault, paths).await;
    }
}
