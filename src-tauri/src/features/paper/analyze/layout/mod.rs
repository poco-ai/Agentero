//! PDF layout domain: Host-managed local model assets and hosted providers.
//!
//! The remote provider engines moved to `agentero_core` so the headless CLI can
//! run them; this module keeps the Tauri command shell ([`hosted::commands`])
//! and re-exports the engine API under the old paths for Host callers.

pub mod model_assets;

pub mod hosted;
