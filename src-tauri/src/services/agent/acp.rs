//! ACP client: launch agent processes and drive the Agent Client Protocol.
//!
//! Split across submodules:
//! - [`convert`]: ACP type conversions + small formatting helpers.
//! - [`config`]: model / effort / fast-mode extraction and `agent:*` updates.
//! - [`permission`]: permission policy, event payloads, request resolution.
//! - [`run`]: [`run_once`] one-shot prompt run.
//! - [`probe`]: [`probe_agent`] capability probe + [`warm_agent`] warm-up.
//! - [`sessions`]: [`list_acp_sessions`] / [`load_acp_session`].

use crate::error::AppError;
use crate::models::agent::{
    AcpHistoryLine, AcpListSessionsResult, AcpLoadSessionResult, AcpSessionCapabilities,
    AcpSessionInfo, AgentDescriptor, AgentEffortChoice, AgentEffortEvent, AgentFailedEvent,
    AgentFastModeEvent, AgentModelChoice, AgentModelsEvent, AgentPlanEntry, AgentPlanEvent,
    AgentResultPayload, AgentStreamEvent, AgentStreamKind, AgentToolEvent, AgentUsageEvent,
    ProbeResult, PromptImage, WarmResult,
};
use crate::services::agent::discover::{path_entries, resolve_command};
use crate::services::agent::events::AgentEventEmitter;
use crate::services::agent::permission::PermissionGate;
use crate::services::agent::prompts::{build_prompt, extract_sources};
use crate::services::agent::skills::{
    load_skill_instructions, skill_activation_prefix, skill_mention_style,
};
use agent_client_protocol::schema::v1::{
    CancelNotification, ContentBlock, EnvVariable, ImageContent, InitializeRequest,
    ListSessionsRequest, LoadSessionRequest, McpServer, McpServerStdio, NewSessionRequest,
    PermissionOptionKind, PlanEntryPriority, PlanEntryStatus, PromptRequest,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    ResumeSessionRequest, SelectedPermissionOutcome, SessionConfigId, SessionConfigKind,
    SessionConfigOption, SessionConfigOptionCategory, SessionConfigOptionValue,
    SessionConfigSelectOptions, SessionId, SessionNotification, SessionUpdate,
    SetSessionConfigOptionRequest, TextContent, ToolCallStatus, ToolKind,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{util, AcpAgent, Agent, ConnectionTo};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::watch;
use uuid::Uuid;

mod config;
mod convert;
mod permission;
mod probe;
mod run;
mod sessions;

// Re-export sibling helpers so each submodule's `use super::*` resolves them.
use config::*;
use convert::*;
use permission::*;

pub(crate) use permission::permission_response;
pub use permission::PermissionPolicy;
pub use probe::{probe_agent, warm_agent};
pub use run::run_once;
pub use sessions::{list_acp_sessions, load_acp_session};

/// Shared budget for ACP initialize / session RPCs and settings probe.
const ACP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

async fn wait_for_cancellation(cancellation: &mut watch::Receiver<bool>) {
    if *cancellation.borrow() {
        return;
    }
    let _ = cancellation.changed().await;
}

async fn timed_acp_request<T, E>(
    label: &str,
    request: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, agent_client_protocol::Error>
where
    E: std::fmt::Display,
{
    tokio::time::timeout(ACP_TIMEOUT, request)
        .await
        .map_err(|_| {
            acp_err(format!(
                "{label} timed out after {}s",
                ACP_TIMEOUT.as_secs()
            ))
        })?
        .map_err(|error| acp_err(format!("{label}: {error}")))
}

pub fn new_ids() -> (String, String) {
    (Uuid::new_v4().to_string(), Uuid::new_v4().to_string())
}
