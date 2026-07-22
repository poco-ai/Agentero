//! ACP type conversions and small formatting helpers.

use super::*;

pub(super) fn to_acp_agent_local(desc: &AgentDescriptor) -> Result<AcpAgent, AppError> {
    let command = resolve_command(&desc.command).unwrap_or_else(|| PathBuf::from(&desc.command));
    let mut child_env: HashMap<String, String> = desc.env.clone();
    if !child_env.contains_key("PATH") {
        if let Ok(path) = std::env::join_paths(path_entries()) {
            child_env.insert("PATH".to_string(), path.to_string_lossy().to_string());
        }
    }
    let env: Vec<EnvVariable> = child_env
        .into_iter()
        .map(|(k, v)| EnvVariable::new(k.clone(), v.clone()))
        .collect();

    let stdio = McpServerStdio::new(desc.name.clone(), command)
        .args(desc.args.clone())
        .env(env);
    Ok(AcpAgent::new(McpServer::Stdio(stdio)))
}

/// Build ACP agent process. When `remote` is SSH, wrap launch as `ssh … 'cd vault && exec agent'`.
/// Local-sim remotes use a normal local process with cwd = remote vault path.
pub(super) fn to_acp_agent(
    desc: &AgentDescriptor,
    remote: Option<&crate::services::remote::RemoteAgentTarget>,
) -> Result<AcpAgent, AppError> {
    if let Some(r) = remote {
        if r.is_ssh() {
            use crate::services::remote::agent_exec::remote_agent_shell_command;
            if r.destination.is_empty() {
                return Err(AppError::message("remote SSH destination is empty"));
            }
            use crate::services::remote::agent_exec::proxy_env_from_map;
            let proxy_pairs = proxy_env_from_map(&desc.env);
            let env_refs: Vec<(&str, &str)> = proxy_pairs
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_str()))
                .collect();
            let shell =
                remote_agent_shell_command(&r.remote_cwd, &desc.command, &desc.args, &env_refs);
            let stdio = McpServerStdio::new(desc.name.clone(), PathBuf::from("ssh")).args(vec![
                "-T".to_string(),
                "-o".to_string(),
                "BatchMode=yes".to_string(),
                "-o".to_string(),
                "ConnectTimeout=30".to_string(),
                r.destination.clone(),
                shell,
            ]);
            return Ok(AcpAgent::new(McpServer::Stdio(stdio)));
        }
        // local-sim: local binary, cwd set via NewSessionRequest to remote_cwd
    }
    to_acp_agent_local(desc)
}

pub(super) fn text_from_content_block(block: &ContentBlock) -> Option<String> {
    match block {
        ContentBlock::Text(t) => Some(t.text.clone()),
        _ => None,
    }
}

pub(super) fn cancelled_payload(
    session_id: String,
    message_id: String,
    content: &Arc<Mutex<String>>,
    thought: &Arc<Mutex<String>>,
) -> AgentResultPayload {
    let content = content
        .lock()
        .map(|buffer| buffer.clone())
        .unwrap_or_default();
    let reasoning = thought
        .lock()
        .map(|buffer| buffer.clone())
        .unwrap_or_default();
    AgentResultPayload {
        session_id,
        message_id,
        sources: extract_sources(&content),
        content,
        reasoning: (!reasoning.is_empty()).then_some(reasoning),
        stop_reason: Some("cancelled".to_string()),
        provider_session_id: None,
    }
}

pub(super) fn stream_from_update(update: &SessionUpdate) -> Option<(String, AgentStreamKind)> {
    match update {
        SessionUpdate::AgentMessageChunk(chunk) => {
            text_from_content_block(&chunk.content).map(|t| (t, AgentStreamKind::Message))
        }
        SessionUpdate::AgentThoughtChunk(chunk) => {
            text_from_content_block(&chunk.content).map(|t| (t, AgentStreamKind::Thought))
        }
        _ => None,
    }
}

pub(super) fn tool_status_str(s: ToolCallStatus) -> &'static str {
    match s {
        ToolCallStatus::Pending => "pending",
        ToolCallStatus::InProgress => "in_progress",
        ToolCallStatus::Completed => "completed",
        ToolCallStatus::Failed => "failed",
        _ => "pending",
    }
}

pub(super) fn tool_kind_str(k: ToolKind) -> &'static str {
    match k {
        ToolKind::Read => "read",
        ToolKind::Edit => "edit",
        ToolKind::Delete => "delete",
        ToolKind::Move => "move",
        ToolKind::Search => "search",
        ToolKind::Execute => "execute",
        ToolKind::Think => "think",
        ToolKind::Fetch => "fetch",
        ToolKind::SwitchMode => "switch_mode",
        ToolKind::Other => "other",
        _ => "other",
    }
}

pub(super) fn plan_status_str(s: &PlanEntryStatus) -> &'static str {
    match s {
        PlanEntryStatus::Pending => "pending",
        PlanEntryStatus::InProgress => "in_progress",
        PlanEntryStatus::Completed => "completed",
        _ => "pending",
    }
}

pub(super) fn plan_priority_str(p: &PlanEntryPriority) -> &'static str {
    match p {
        PlanEntryPriority::High => "high",
        PlanEntryPriority::Medium => "medium",
        PlanEntryPriority::Low => "low",
        _ => "medium",
    }
}

pub(super) fn acp_err(msg: impl ToString) -> agent_client_protocol::Error {
    util::internal_error(msg)
}
