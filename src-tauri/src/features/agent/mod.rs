pub mod acp;
#[cfg(test)]
mod acp_tests;
pub mod citation;
pub mod commands;
mod context_turn;
pub mod delegate;
pub mod doctor;
pub mod doctor_agents;
pub mod models;
pub mod pi_trust;
pub mod prompt;
pub mod registry;
pub mod remote_host;
pub mod runtime;
pub mod service;
pub mod session;

pub use acp::{probe_agent, PermissionPolicy};
pub use models::AgentTelemetrySummary;
pub use prompt::skills::list_agent_skills;
pub use registry::{builtin_templates, catalog_templates, AgentRegistry};
pub use remote_host::{RemoteAgentHosts, RemoteAgentLaunch};
pub use runtime::{
    AgentEventEmitter, AgentRunController, AgentWarmGate, AskUserGate, ElicitationGate,
    PermissionGate,
};
pub use session::{
    delete_acp_session, list_acp_sessions, load_acp_session, new_ids, run_once, warm_agent,
    AgentWarmPool, RunOnceParams,
};
