//! Attach one turn's context plan to the ACP prompt and bind its local evidence CLI.

use agentero_core::features::context::{
    facts_from_anchors, plan_from_facts, render_prompt_block, resolve_in_vault, resume_allowed,
    session_fingerprint, ContextExpansion, ContextGrant, ContextRequest, GRANT_SCHEMA_VERSION,
};
use std::path::{Path, PathBuf};

/// What `run_once` needs from the context layer. Absent when the turn has no anchors.
pub(crate) struct PreparedContext {
    pub block: String,
    pub grant: Option<ContextGrant>,
    pub prefetched_sources: Vec<String>,
    pub fingerprint: Option<String>,
    pub vault: Option<PathBuf>,
    /// A warm ACP process cannot acquire a new environment. Do not reuse it.
    pub skip_warm_pool: bool,
    pub resume_session_id: Option<String>,
}

pub(crate) fn prepare_context(
    runtime_session_id: &str,
    vault_path: Option<&str>,
    cli: Option<&Path>,
    request: Option<&ContextRequest>,
    resume_session_id: Option<String>,
) -> PreparedContext {
    let Some(request) = request.filter(|request| !request.anchors.is_empty()) else {
        return PreparedContext {
            block: String::new(),
            grant: None,
            prefetched_sources: Vec::new(),
            fingerprint: None,
            vault: None,
            skip_warm_pool: false,
            resume_session_id,
        };
    };
    let vault = vault_path.map(PathBuf::from).filter(|path| path.is_dir());
    let expansion = if cli.is_none() || vault.is_none() {
        ContextExpansion::PromptOnly
    } else {
        ContextExpansion::Cli
    };
    let plan = match vault.as_deref() {
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
    let grant = vault
        .as_ref()
        .filter(|_| !plan.allowed.is_empty())
        .map(|vault| ContextGrant {
            schema_version: GRANT_SCHEMA_VERSION,
            session_id: runtime_session_id.to_owned(),
            vault_path: vault.display().to_string(),
            fingerprint: plan.fingerprint.clone(),
            allowed: plan.allowed.clone(),
            budget: plan.budget.clone(),
            mode: plan.mode,
        });
    let fingerprint = plan.fingerprint.clone();
    let resume_session_id = match vault.as_deref() {
        Some(vault) => gate_resume(vault, resume_session_id, &fingerprint),
        None => resume_session_id,
    };
    let mut block = render_prompt_block(&plan);
    let mut prefetched_sources = Vec::new();
    let grant = if plan.expansion == ContextExpansion::PromptOnly {
        if let Some(authority) = &grant {
            prefetched_sources = prefetch(authority, &plan, &request.question, &mut block);
        }
        None
    } else {
        grant
    };
    if let Some(exe) = cli.filter(|_| grant.is_some()) {
        block.push_str(&format!(
            "\nAgentero CLI executable for this turn: {}\n",
            exe.display()
        ));
    }
    PreparedContext {
        block,
        grant,
        prefetched_sources,
        fingerprint: Some(fingerprint),
        vault,
        skip_warm_pool: plan.expansion == ContextExpansion::Cli,
        resume_session_id,
    }
}

/// Include a small amount of real text for prompt-only providers with a local vault.
fn prefetch(
    grant: &ContextGrant,
    plan: &agentero_core::features::context::ContextPlan,
    question: &str,
    block: &mut String,
) -> Vec<String> {
    use agentero_core::features::evidence::execute_scoped;
    use serde_json::json;
    let mut sources = Vec::new();
    let mut spent = 0;
    for item in plan.immediate.iter().take(2) {
        let is_directory = item.directory_path.is_some();
        let Some(path) = item
            .file_path
            .as_ref()
            .or(item.paper_path.as_ref())
            .or(item.directory_path.as_ref())
        else {
            continue;
        };
        let (name, args, cards) = if is_directory {
            if question.trim().is_empty() {
                continue;
            }
            (
                "evidence_search",
                json!({"query":question,"in":[path],"limit":1}),
                "items",
            )
        } else {
            let mut args = json!({"source":path,"max_chars":grant.budget.card_chars});
            if let Some(line) = item.line_from {
                args["lines"] = json!(format!("{line}-{}", item.line_to.unwrap_or(line)));
            } else if let Some(page) = item.page {
                args["pages"] = json!([page]);
            } else if let Some(section) = &item.section {
                args["section"] = json!(section);
            }
            ("evidence_read", args, "evidence")
        };
        let Ok((value, cost, _)) = execute_scoped(grant, name, args, spent) else {
            continue;
        };
        spent += cost;
        if let Some(card) = value[cards].as_array().and_then(|rows| rows.first()) {
            if let (Some(excerpt), Some(cite)) = (card["excerpt"].as_str(), card["cite"].as_str()) {
                if excerpt.is_empty() || sources.iter().any(|s| s == cite) {
                    continue;
                }
                let excerpt = excerpt
                    .chars()
                    .take(grant.budget.card_chars as usize)
                    .collect::<String>();
                block.push_str(&format!(
                    "\nEvidence from {path} ({cite}):\n> {}\n",
                    excerpt.replace('\n', "\n> ")
                ));
                sources.push(cite.to_owned());
            }
        }
    }
    sources
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
