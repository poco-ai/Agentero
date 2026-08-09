//! Domain features (feature-first layout, aligned with frontend `src/lib`).
//!
//! Each submodule owns its service logic and thin `commands` shells.
//! The headless CLI may import non-agent features; BYOA (`agent`) is desktop-only.

pub mod agent;
pub mod arxiv_proxy;
pub mod bridge;
pub mod catalog;
pub mod cli_install;
pub mod connector;
pub mod doctor;
pub mod export;
pub mod import;
pub mod layout_model;
pub mod network;
pub mod open_request;
pub mod refs;
pub mod remote;
pub mod search;
pub mod settings;
pub mod telemetry;
pub mod terminal;
pub mod translate;
pub mod trash;
pub mod vault;
pub mod watcher;
pub mod wiki;
pub mod window;
pub mod zotero_sync;
