//! Device-local activity log: `$XDG_DATA_HOME/agentero/usage.sqlite`.
//!
//! Not stored in the Vault. Remote catalog mirroring and file watchers never
//! see this file. Events are scoped by vault path so one install can hold
//! several libraries.
//!
//! Shared by the desktop Host. The `#[tauri::command]` surface lives in the
//! desktop shell (`agentero_lib::core::usage::commands`); everything here is
//! tauri-free.

mod projection;
mod query;
mod record;
mod schema;

use crate::error::AppError;

pub use crate::paths::usage_db_path;
pub use projection::{telemetry_projection, ActivityProjection};
pub use query::{
    clear_all, clear_vault, list_events, reading_durations, rename_path, summarize, ListFilter,
    UsageEvent, UsageKindCount,
};
pub use record::{record_events, UsageRecord};

/// [`rename_path`] against the process default database. Failures only warn: a
/// stale activity row must never fail the move itself.
pub fn rename_path_best_effort(vault: &str, from: &str, to: &str) {
    if let Err(e) = rename_path(&usage_db_path(), vault, from, to) {
        log::warn!(target: "agentero::usage", "rename usage paths {from} → {to}: {e}");
    }
}

pub fn record_default(events: &[UsageRecord]) -> Result<usize, AppError> {
    record_events(&usage_db_path(), events)
}

pub fn clear_default(vault: Option<&str>) -> Result<u64, AppError> {
    let path = usage_db_path();
    match vault.map(str::trim).filter(|s| !s.is_empty()) {
        Some(v) => clear_vault(&path, v),
        None => clear_all(&path),
    }
}

#[cfg(test)]
pub(super) fn temp_db() -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};

    // Parallel test threads can draw the same clock tick, and each test deletes
    // its whole directory at the end — a shared name means one test removes
    // another's live database ("database is locked"). The counter makes the name
    // unique per call; pid + timestamp still separate concurrent processes.
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "agentero-usage-{}-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("usage.sqlite")
}

#[cfg(test)]
pub(super) fn rec(kind: &str, path: &str) -> UsageRecord {
    UsageRecord {
        ts: Some("2026-08-14T10:00:00.000Z".into()),
        vault: Some("/vaults/demo".into()),
        kind: kind.into(),
        path: Some(path.into()),
        mode: Some("pdf".into()),
        dur_ms: Some(1200),
        extra: Some(serde_json::json!({ "source": "arxiv" })),
    }
}
