//! Translation providers (free MT + LLM) shared by the Host and the CLI.
//!
//! Body in `agentero_core::features::translate`; desktop command shell here.

pub use agentero_core::features::translate::*;

#[cfg(feature = "desktop")]
pub mod commands;

#[cfg(feature = "desktop")]
pub mod dictionary;

#[cfg(feature = "desktop")]
pub mod layout_cache;
