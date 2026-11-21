//! Tauri shell over the shared layout provider engines.
//!
//! The engines themselves live in `agentero_core` (so the headless CLI can run
//! them); [`commands`] resolves provider credentials from the Host settings
//! store, threads the Tauri [`AppHandle`](crate::core::app_handle::AppHandle)
//! through for `layout-remote:progress`, and owns the cancellation registry.
//!
//! Paths under this module stay stable for Host callers
//! (`paste::analyze::layout::hosted::paddle`, `…::engine`, …): everything is
//! re-exported from the core module.

pub use agentero_core::features::paper::analyze::layout::hosted::*;

pub mod commands;
