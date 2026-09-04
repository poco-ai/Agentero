//! Device-local activity log: `$XDG_DATA_HOME/agentero/usage.sqlite`.
//!
//! Not stored in the Vault. Remote catalog mirroring and file watchers never
//! see this file. Events are scoped by vault path so one install can hold
//! several libraries.

pub(crate) mod events;
mod schema;

pub use events::{
    clear_all, clear_vault, list_events, record_events, rename_path, since_rfc3339_days, summarize,
    telemetry_projection, ActivityProjection, ListFilter, UsageEvent, UsageKindCount, UsageRecord,
};
pub use schema::{
    ensure_usage, ensure_usage_at, paper_path_of, schema_version, usage_db_path,
    EVENT_RETENTION_DAYS, SCHEMA_VERSION,
};

#[cfg(feature = "desktop")]
pub mod commands;
