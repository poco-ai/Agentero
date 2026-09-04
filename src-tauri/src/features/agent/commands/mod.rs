//! Tauri command shells for the Agent feature.
//!
//! Keep handlers thin: extract params / State, call services, map errors.
//! Command paths stay `features::agent::commands::*` for `app/handlers.rs`.

mod interaction;
mod registry;
mod remote;
mod session;

use crate::features::agent::models::{AgentDescriptor, AgentListResponse};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOnly {
    pub agent: AgentDescriptor,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnabledResponse {
    pub enabled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUserAgentResponse {
    pub user_agent: String,
    pub user_agent_provider_ids: String,
}

pub(super) fn list_from_state(
    state: crate::features::agent::models::AgentRegistryState,
) -> AgentListResponse {
    AgentListResponse {
        agents: state.agents,
        default_id: state.default_id,
        enabled: state.enabled,
    }
}

/// Mounted Agent panels cache their agent list; notify every window after a
/// registry mutation (probe / install / upsert / remove / default) so they
/// refresh without a remount.
pub(super) fn emit_registry_changed(app: &AppHandle) {
    let _ = app.emit("agent:registry-changed", serde_json::json!({}));
}

pub use interaction::*;
pub use registry::*;
pub use remote::*;
pub use session::*;
