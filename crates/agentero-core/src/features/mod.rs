//! Tauri-free domain features shared by the desktop Host and the headless CLI.
//!
//! Mirrors the Host's semantic `features::` tree (minus desktop-only domains
//! like jobs/agent/watcher). The flat aliases below are kept for the headless
//! CLI and migrated code; the desktop Host calls the semantic paths directly.

pub mod lifecycle;
pub mod markdown;
pub mod open_request;
pub mod paper;
pub mod pdf;
pub mod translate;
pub mod vault;

// Stable historical `features::` paths, backed by the semantic module tree.
pub use markdown::wiki;
pub use paper::analyze::refs;
pub use paper::catalog;
pub use paper::import;
pub use paper::scholar_api;
pub use vault::doctor;
pub use vault::rename;
pub use vault::trash;

pub use paper::analyze::parse as pdf_parse;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub use pdf::locate as pdf_locate;

pub use paper::discovery::feeds;
pub use paper::import::sources::zotero;
