//! Vault paper catalog: `.agentero/catalog.sqlite`.
//!
//! Authoritative store for paper set + structured metadata.
//! `metadata.json` is a projection synced after SQLite writes.
//! See `docs/backend/catalog.md`.

pub mod db;
pub mod papers;
mod schema;

pub use db::blocking;
#[allow(unused_imports)] // public surface for tests / future commands
pub use schema::{catalog_db_path, ensure_catalog, schema_version, SCHEMA_VERSION};
