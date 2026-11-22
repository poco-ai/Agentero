//! Desktop commands for the AlphaXiv library key and folder list.
//!
//! Authenticated HTTP lives in `agentero_core::features::paper::alphaxiv`.
//! The key is stored by [`crate::features::system::settings::AppSettingsStore`]
//! and leaves this process only as an `Authorization` header.

#[cfg(feature = "desktop")]
pub mod commands;
