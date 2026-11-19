//! Attach one turn's context plan to the ACP prompt and, locally, to stdio MCP.

use crate::core::error::AppError;
use agent_client_protocol::v1::schema::{McpServer, McpServerStdio};
use agentero_core::features::context::{
    facts_from_anchors, grant_path, plan_from_facts, render_prompt_block, resolve_in_vault,
    resume_allowed, session_fingerprint, usage_path, write_grant, ContextExpansion, ContextGrant,
    ContextPlan, ContextRequest, GRANT_SCHEMA_VERSION, MCP_WORKER_ARG,
};
use std::path::{Path, PathBuf};

/// What `run_once` needs from the context layer. Absent when the turn has no anchors.
pub(crate) struct PreparedContext {
    pub block: String,
    pub mcp_servers: Vec<McpServer>,
    pub fingerprint: Option<String>,
    pub usage_path: Option<PathBuf>,
    pub vault: Option<PathBuf>,
    /// A warm ACP session was created without this MCP server. Do not reuse it.
    pub skip_warm_pool: bool,
    pub resume_session_id: Option<String>,
}

pub(crate) fn prepare_context(
    runtime_session_id: &str,
    vault_path: Option<&str>,
    remote: bool,
    request: Option<&ContextRequest>,
    resume_session_id: Option<String>,
) -> PreparedContext {
    let Some(request) = request.filter(|request| !request.anchors.is_empty()) else {
        return PreparedContext {
            block: String::new(),
            mcp_servers: Vec::new(),
            fingerprint: None,
            usage_path: None,
            vault: None,
            skip_warm_pool: false,
            resume_session_id,
        };
    };
    let vault = vault_path.map(PathBuf::from).filter(|path| path.is_dir());
    let mut expansion = if remote || vault.is_none() {
        ContextExpansion::PromptOnly
    } else {
        ContextExpansion::Mcp
    };
    let mut plan = match vault.as_deref() {
        Some(vault) => resolve_in_vault(vault, request, expansion).unwrap_or_else(|error| {
            log::warn!(target: "agentero::agent", "context resolve failed: {error}");
            plan_from_facts(
                request,
                &facts_from_anchors(&request.anchors),
                ContextExpansion::PromptOnly,
            )
        }),
        None => plan_from_facts(
            request,
            &facts_from_anchors(&request.anchors),
            ContextExpansion::PromptOnly,
        ),
    };
    if plan.expansion == ContextExpansion::PromptOnly {
        expansion = ContextExpansion::PromptOnly;
    }
    let mut mcp_servers = Vec::new();
    let mut usage = None;
    if expansion == ContextExpansion::Mcp {
        if let Some(vault) = vault.as_deref() {
            match attach_mcp(vault, runtime_session_id, &plan) {
                Ok((servers, usage_path)) => {
                    mcp_servers = servers;
                    usage = Some(usage_path);
                }
                Err(error) => {
                    log::warn!(
                        target: "agentero::agent",
                        "context mcp unavailable, prompt-only fallback: {error}"
                    );
                    match resolve_in_vault(vault, request, ContextExpansion::PromptOnly) {
                        Ok(resolved) => plan = resolved,
                        Err(_) => plan.expansion = ContextExpansion::PromptOnly,
                    }
                }
            }
        }
    }
    let fingerprint = plan.fingerprint.clone();
    let resume_session_id = match vault.as_deref() {
        Some(vault) => gate_resume(vault, resume_session_id, &fingerprint),
        None => resume_session_id,
    };
    let block = render_prompt_block(&plan);
    PreparedContext {
        block,
        mcp_servers,
        fingerprint: Some(fingerprint),
        usage_path: usage,
        vault,
        skip_warm_pool: plan.expansion == ContextExpansion::Mcp,
        resume_session_id,
    }
}

fn gate_resume(
    vault: &Path,
    resume_session_id: Option<String>,
    fingerprint: &str,
) -> Option<String> {
    let resume = resume_session_id?;
    let stored = session_fingerprint(vault, &resume);
    if resume_allowed(stored.as_deref(), fingerprint) {
        Some(resume)
    } else {
        log::info!(
            target: "agentero::agent",
            "context fingerprint changed; starting a new ACP session"
        );
        None
    }
}

fn attach_mcp(
    vault: &Path,
    runtime_session_id: &str,
    plan: &ContextPlan,
) -> Result<(Vec<McpServer>, PathBuf), AppError> {
    let grant_file = grant_path(vault, runtime_session_id);
    let grant = ContextGrant {
        schema_version: GRANT_SCHEMA_VERSION,
        session_id: runtime_session_id.to_string(),
        vault_path: vault.display().to_string(),
        fingerprint: plan.fingerprint.clone(),
        allowed: plan.allowed.clone(),
        budget: plan.budget.clone(),
        mode: plan.mode,
    };
    write_grant(&grant_file, &grant)?;
    let exe = std::env::current_exe()
        .map_err(|error| AppError::message(format!("locate agentero for context mcp: {error}")))?;
    let stdio = McpServerStdio::new("agentero-context", exe).args(vec![
        MCP_WORKER_ARG.to_string(),
        grant_file.display().to_string(),
    ]);
    Ok((
        vec![McpServer::Stdio(stdio)],
        usage_path(vault, runtime_session_id),
    ))
}

/// Insert the evidence block before the human request so chat history still
/// shows only what the user typed.
pub(crate) fn insert_context_block(prompt: &str, block: &str) -> String {
    let block = block.trim();
    if block.is_empty() {
        return prompt.to_string();
    }
    const MARKER: &str = crate::features::agent::prompt::envelope::USER_REQUEST_MARKER;
    match prompt.rfind(MARKER) {
        Some(index) => {
            let mut out = String::with_capacity(prompt.len() + block.len() + 2);
            out.push_str(&prompt[..index]);
            out.push_str(block);
            out.push_str("\n\n");
            out.push_str(&prompt[index..]);
            out
        }
        None => format!("{block}\n\n{prompt}"),
    }
}

/// Prior turns for a session the fingerprint refused to resume. They sit inside
/// the user request, after the evidence block, so the new session still has the
/// conversation.
pub(crate) fn insert_resume_transcript(prompt: &str, transcript: &str) -> String {
    let transcript = transcript.trim();
    if transcript.is_empty() {
        return prompt.to_string();
    }
    const MARKER: &str = crate::features::agent::prompt::envelope::USER_REQUEST_MARKER;
    match prompt.rfind(MARKER) {
        Some(index) => {
            let at = index + MARKER.len();
            let mut out = String::with_capacity(prompt.len() + transcript.len() + 2);
            out.push_str(&prompt[..at]);
            out.push_str(transcript);
            out.push_str("\n\n");
            out.push_str(&prompt[at..]);
            out
        }
        None => format!("{transcript}\n\n{prompt}"),
    }
}

#[cfg(test)]
mod tests {
    use super::{insert_context_block, insert_resume_transcript};

    #[test]
    fn evidence_stays_above_the_user_request() {
        let prompt = "You are an assistant.\n\nUser request:\nwhat does this mean?";
        let out = insert_context_block(prompt, "Paper ref: attention\nTitle: Attention");
        let evidence = out.find("Paper ref: attention").unwrap();
        let request = out.find("User request:\n").unwrap();
        assert!(evidence < request);
        assert!(out.ends_with("what does this mean?"));
    }

    #[test]
    fn rejected_resume_keeps_earlier_turns_inside_the_request() {
        let prompt = insert_context_block(
            "You are an assistant.\n\nUser request:\nwhat next?",
            "Paper ref: attention",
        );
        let out = insert_resume_transcript(
            &prompt,
            "Earlier turns in this conversation:\n\nUser: hello",
        );
        let request = out.find("User request:\n").unwrap();
        let earlier = out.find("Earlier turns").unwrap();
        let question = out.find("what next?").unwrap();
        assert!(out.find("Paper ref: attention").unwrap() < request);
        assert!(request < earlier && earlier < question);
    }
}
