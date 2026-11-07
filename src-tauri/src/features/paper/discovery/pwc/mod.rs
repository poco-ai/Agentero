//! Papers with Code (paperswithcode.co) 广场 import shell.
//!
//! The tauri-free catalog client, enrichment, and import pipeline live in
//! `agentero_core::features::paper::discovery::pwc`.

pub use agentero_core::features::paper::discovery::pwc::*;

#[cfg(feature = "desktop")]
pub mod commands;
