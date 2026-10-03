//! PDF features.
//!
//! `locate` (quote → page rects + annotation store) and `marks` (reading
//! marks) are tauri-free and live in `agentero_core::features::pdf`; only the
//! desktop export shell stays here.

#[cfg(feature = "desktop")]
pub mod export;
pub use agentero_core::features::pdf::layout_index;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub use agentero_core::features::pdf::locate;
pub use agentero_core::features::pdf::marks;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub use agentero_core::features::pdf::text;
