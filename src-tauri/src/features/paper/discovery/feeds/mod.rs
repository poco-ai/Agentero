//! Plaza RSS / Atom / JSON Feed subscriptions.
//!
//! Stored in `$XDG_DATA_HOME/agentero/feeds.sqlite`. Does not write catalog or
//! Vault. The tauri-free body lives in
//! `agentero_core::features::paper::discovery::feeds`; desktop command shell here.

pub use agentero_core::features::paper::discovery::feeds::*;

#[cfg(feature = "desktop")]
pub mod commands;
