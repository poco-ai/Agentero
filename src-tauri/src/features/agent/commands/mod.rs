//! Tauri command shells for the Agent feature.
//!
//! Keep handlers thin: extract params / State, call services, map errors.
//! Command paths stay `features::agent::commands::*` for `app/handlers.rs`.
//! Shared logic lives in `features::agent::service` (also consumed by the
//! desktop bridge RPC).

mod citation;
mod doctor;
mod interaction;
mod pi;
mod registry;
mod remote;
mod session;

use serde::Serialize;

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentUserAgentResponse {
    pub user_agent: String,
    pub user_agent_provider_ids: String,
}

pub use citation::*;
pub use doctor::*;
pub use interaction::*;
pub use pi::*;
pub use registry::*;
pub use remote::*;
pub use session::*;
