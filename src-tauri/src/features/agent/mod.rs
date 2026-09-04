pub mod acp;
#[cfg(test)]
mod acp_tests;
pub mod ask_user;
pub mod background_commands;
pub mod commands;
pub mod models;
pub mod prompt;
pub mod registry;
pub mod remote_catalog_commands;
pub mod runtime;
pub mod session;
pub mod terminal_acp;

pub use acp::{probe_agent, PermissionPolicy};
pub use ask_user::AskUserGate;
pub use models::AgentTelemetrySummary;
pub use prompt::skills::list_agent_skills;
pub use registry::{builtin_templates, catalog_templates, AgentRegistry};
pub use runtime::{AgentEventEmitter, AgentRunController, AgentWarmGate};
pub use runtime::{ElicitationGate, PermissionGate};
pub use session::{
    list_acp_sessions, load_acp_session, new_ids, run_once, warm_agent, RunOnceParams,
};
