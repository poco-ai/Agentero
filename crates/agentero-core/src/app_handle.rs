//! Host abstraction for the tauri-free domain services.
//!
//! Desktop wraps its `tauri::AppHandle` into [`AppHandle`] with a [`HostHooks`]
//! implementation (see `agentero_lib::core::app_handle`), letting the shared
//! business logic emit frontend events and schedule follow-up jobs without
//! knowing about Tauri. Headless consumers (CLI) pass `None`. `emit` is then
//! a no-op. Commit and asset download do not schedule follow-up jobs through
//! the spawn hooks below; they return a preparation plan. Desktop enqueues
//! that plan, and the CLI prints the skipped steps. The spawn methods remain
//! for callers that still schedule directly (auto-ingest, Connector
//! standalone recognition) and stay no-ops without a host.

use serde::Serialize;
use std::path::Path;
use std::sync::Arc;

/// Host-side callbacks the shared domain logic may trigger.
///
/// Every method defaults to a no-op so hosts only implement what they own.
pub trait HostHooks: Send + Sync + 'static {
    /// Emit a frontend event with an already-serialized JSON payload
    /// (desktop: `tauri::Emitter::emit`).
    fn emit(&self, event: &str, payload: serde_json::Value);
    /// Enqueue a ParseBody job after assets landed (desktop: JobCenter).
    ///
    /// Paper commit and download no longer call this. They return a
    /// preparation plan for the adapter to enqueue.
    fn spawn_parse_body_after_assets(&self, vault: &Path, path_rel: &str, force: bool) {
        let _ = (vault, path_rel, force);
    }

    /// Enqueue layout analysis (and the optional import translation) after a
    /// PDF lands outside the DownloadAssets runner, e.g. a Connector
    /// attachment. No-op on headless hosts.
    fn spawn_layout_analysis(&self, vault: &Path, path_rel: &str) {
        let _ = (vault, path_rel);
    }
    /// Schedule a references parse after an import/download finished.
    /// Returning `true` means the host took over scheduling (desktop:
    /// JobCenter); `false` makes the caller fall back to a direct in-process
    /// `tokio::spawn`.
    fn spawn_parse_after_import(&self, vault: &Path, path_rel: &str) -> bool {
        let _ = (vault, path_rel);
        false
    }
    /// Enqueue a RecognizeMetadata job (desktop: JobCenter).
    fn spawn_recognize_metadata(&self, vault: &Path, path_rel: &str) {
        let _ = (vault, path_rel);
    }
}

/// Opaque host handle threaded through the domain services.
#[derive(Default)]
pub struct AppHandle {
    hooks: Option<Arc<dyn HostHooks>>,
}

impl AppHandle {
    /// Headless handle without host hooks (every callback is a no-op).
    pub fn headless() -> Self {
        Self::default()
    }
    /// Handle backed by a host implementation (desktop).
    pub fn with_hooks(hooks: Arc<dyn HostHooks>) -> Self {
        Self { hooks: Some(hooks) }
    }
    /// Emit a frontend event; no-op without host hooks.
    pub fn emit(&self, event: &str, payload: &impl Serialize) {
        if let Some(hooks) = &self.hooks {
            if let Ok(value) = serde_json::to_value(payload) {
                hooks.emit(event, value);
            }
        }
    }
    /// Enqueue a ParseBody job after assets landed; no-op without hooks.
    pub fn spawn_parse_body_after_assets(&self, vault: &Path, path_rel: &str, force: bool) {
        if let Some(hooks) = &self.hooks {
            hooks.spawn_parse_body_after_assets(vault, path_rel, force);
        }
    }
    /// Schedule a refs parse; `true` when the host took over scheduling.
    pub fn spawn_parse_after_import(&self, vault: &Path, path_rel: &str) -> bool {
        self.hooks
            .as_ref()
            .is_some_and(|hooks| hooks.spawn_parse_after_import(vault, path_rel))
    }
    /// Enqueue a RecognizeMetadata job; no-op without hooks.
    pub fn spawn_recognize_metadata(&self, vault: &Path, path_rel: &str) {
        if let Some(hooks) = &self.hooks {
            hooks.spawn_recognize_metadata(vault, path_rel);
        }
    }
    /// Enqueue layout analysis (+ optional import translation); no-op without
    /// hooks.
    pub fn spawn_layout_analysis(&self, vault: &Path, path_rel: &str) {
        if let Some(hooks) = &self.hooks {
            hooks.spawn_layout_analysis(vault, path_rel);
        }
    }
}
