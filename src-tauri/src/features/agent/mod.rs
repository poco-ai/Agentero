pub mod acp;
#[cfg(test)]
mod acp_tests;
pub mod ask_user;
pub mod background_commands;
pub mod commands;
pub mod discover;
pub mod elicitation;
mod events;
pub mod models;
pub mod permission;
pub mod prompts;
pub mod registry;
pub mod remote_catalog;
pub mod remote_catalog_commands;
pub mod runtime;
pub mod skills;
pub mod stream_coalesce;
pub mod templates;
pub mod terminal_acp;
pub mod tool_lifecycle;

pub use acp::{
    list_acp_sessions, load_acp_session, new_ids, probe_agent, run_once, warm_agent,
    PermissionPolicy, RunOnceParams,
};
pub use ask_user::AskUserGate;
pub use elicitation::ElicitationGate;
pub use events::AgentEventEmitter;
pub use models::AgentTelemetrySummary;
pub use permission::PermissionGate;
pub use registry::AgentRegistry;
pub use runtime::{AgentRunController, AgentWarmGate};
pub use skills::list_agent_skills;
pub use templates::builtin_templates;
