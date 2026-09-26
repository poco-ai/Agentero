//! Paper domain: catalog metadata, import/discovery, citation analysis, and
//! paper-scoped filesystem operations.
//!
//! The tauri-free bodies live in `agentero_core::features::paper`; the
//! directories kept here are thin bridges around their desktop-only shells
//! (commands / job runners / remote engines).

pub mod analyze;
pub mod catalog;
pub mod discovery;
pub mod import;
pub mod ingest;
pub mod zotero;

pub use agentero_core::features::paper::capabilities;
pub use agentero_core::features::paper::scholar_api;
