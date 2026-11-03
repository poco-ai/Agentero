//! Agentero Host library (`agentero_lib`).
//!
//! - [`run`] — Tauri app entry (desktop / mobile).
//! - [`core`] / [`features`] — bridge the tauri-free `agentero-core` crate
//!   (which the headless CLI consumes directly) and keep the desktop shells
//!   (`#[tauri::command]` surfaces, JobCenter, watcher, integrations).
//!
//! Assembly lives in [`app`]; domain logic in [`features`].

#[cfg(feature = "desktop")]
mod app;
/// Cross-cutting foundations (error, fs, paths, logging helpers).
pub mod core;
/// Domain features (Vault / Catalog / Import / Wiki / …).
/// Service bodies live in `agentero_core::features::*`; this crate keeps the
/// desktop-only shells. `features::agent` (BYOA) is desktop-only.
pub mod features;
/// External integrations (bridge, MCP, remote vault, cloud sync).
/// Desktop-only; CLI must not depend on these.
pub mod integration;
#[cfg(feature = "desktop")]
pub use app::run;

/// Point the unit-test binary's XDG config/data/cache/state homes at a fresh
/// temporary directory before any test runs, so tests never read or write the
/// developer's real `agents.json`, `usage.sqlite` or caches.
/// [`agentero_core::paths`] honors these variables on every platform.
#[cfg(test)]
#[ctor::ctor]
unsafe fn isolate_user_dirs_for_tests() {
    let root = std::env::temp_dir().join(format!("agentero-test-{}", std::process::id()));
    for (var, sub) in [
        ("XDG_CONFIG_HOME", "config"),
        ("XDG_DATA_HOME", "data"),
        ("XDG_CACHE_HOME", "cache"),
        ("XDG_STATE_HOME", "state"),
    ] {
        std::env::set_var(var, root.join(sub));
    }
}

/// Regenerate typed IPC without running the unit-test harness.
#[cfg(feature = "bindings-export")]
pub fn export_bindings() {
    std::env::set_current_dir(env!("CARGO_MANIFEST_DIR")).expect("bindings working directory");
    std::env::set_var("AGENTERO_UPDATE_BINDINGS", "1");
    app::bindings_test::export_typescript_bindings();
}
