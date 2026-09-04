//! Zotero Connector–compatible local HTTP server (loopback :23119).
//!
//! Official browser extensions POST `/connector/*` here so saves land in the
//! current Agentero Vault. See `docs/backend/connector.md`.

mod import;
mod server;
mod state;
mod targets;

pub use state::{
    ConnectorController, ConnectorItemSaved, ConnectorProgress, ConnectorStatus,
    DEFAULT_CONNECTOR_PORT,
};

pub mod commands;
