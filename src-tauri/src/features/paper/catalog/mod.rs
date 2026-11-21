//! Vault paper catalog: `.agentero/catalog.sqlite`.
//!
//! Authoritative store for paper set + structured metadata; the tauri-free
//! body lives in `agentero_core::features::paper::catalog`.

pub use agentero_core::features::paper::catalog::*;

#[cfg(feature = "desktop")]
pub mod commands;

#[cfg(feature = "desktop")]
pub mod service;
