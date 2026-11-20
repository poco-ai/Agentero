//! Desktop / CLI side effects that the shared tool surface must not own.
//!
//! The default methods are the headless behavior: no job queue, no live wiki
//! index, paper text hidden, import follow-up logged and skipped.

use super::McpStatus;
use agentero_core::app_handle::AppHandle;
use agentero_core::features::paper::capabilities::CapsCache;
use agentero_core::features::paper::import::{skipped_preparation_line, PreparationPlan};
use agentero_core::features::vault::rename::WikiIndex;
use std::path::Path;
use std::sync::{Arc, Mutex};

/// What `paper_import` may use while a host is attached.
///
/// `app` carries [`agentero_core::app_handle::HostHooks`] for progress events.
/// `caps` is the desktop paper-capability cache. Both stay empty on the CLI.
#[derive(Default)]
pub struct ImportContext {
    pub app: Option<AppHandle>,
    pub caps: Option<CapsCache>,
}

#[async_trait::async_trait]
pub trait McpHost: Send + Sync + 'static {
    /// Paper body expansion is opt-in. Desktop reads settings; CLI reads a flag.
    fn expose_paper_text(&self) -> bool {
        false
    }

    fn allow_write(&self) -> bool {
        false
    }

    fn allow_online(&self) -> bool {
        false
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
