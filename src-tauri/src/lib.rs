//! Agentero Host library (`agentero_lib`).
//!
//! - [`run`] — Tauri app entry (desktop / mobile).
//! - [`core`] / [`features`] — shared with the headless CLI (`agentero-cli`).
//!
//! Assembly lives in [`app`]; domain logic in [`features`].

#[cfg(feature = "desktop")]
mod app;
/// Cross-cutting foundations (error, fs, paths, logging helpers).
pub mod core;
/// Domain features (Vault / Catalog / Import / Wiki / …).
/// The CLI path-depends on this crate and may
/// `use agentero_lib::features::{vault, catalog, import, …}`;
/// it must **not** use `features::agent` (BYOA is desktop-only).
pub mod features;
/// External integrations (bridge, MCP, remote vault, cloud sync).
/// Desktop-only; CLI must not depend on these.
pub mod integration;
#[cfg(feature = "desktop")]
pub use app::run;
