pub mod acp;
#[cfg(test)]
mod acp_tests;
pub mod commands;
pub mod models;
pub mod prompt;
pub mod registry;
pub mod runtime;
pub mod session;

pub use acp::{probe_agent, PermissionPolicy};
pub use models::AgentTelemetrySummary;
pub use prompt::skills::list_agent_skills;
pub use registry::{builtin_templates, catalog_templates, AgentRegistry};
pub use runtime::{
    AskUserGate, AgentEventEmitter, AgentRunController, AgentWarmGate, ElicitationGate,
    PermissionGate,
};
pub use session::{
    list_acp_sessions, load_acp_session, new_ids, run_once, warm_agent, RunOnceParams,
};
