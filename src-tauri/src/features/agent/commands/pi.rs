//! Pi project-trust commands.
//!
//! Trust is never granted automatically: the Host only reports Pi's effective
//! decision, and `agent_pi_project_trust_grant` writes the Vault entry when the
//! user explicitly asks. The global Pi `settings.json` is read-only here.

use crate::core::error::{map_err, ApiResult, AppError};
use crate::features::agent::acp::client::effective_local_agent_env;
use crate::features::agent::models::AgentTemplate;
use crate::features::agent::pi_trust::{self, PiProjectTrustStatus};
use crate::features::agent::{AgentRegistry, AgentWarmPool};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

fn pi_agent_env(
    registry: &AgentRegistry,
    agent_id: &str,
) -> Result<HashMap<String, String>, AppError> {
    let descriptor = registry.resolve_default(Some(agent_id))?;
    if descriptor.template != AgentTemplate::Pi {
        return Err(AppError::domain(
            "not_pi_agent",
            format!("agent is not a Pi agent: {agent_id}"),
        ));
    }
    // Use the same merged environment the ACP child receives, so a custom
    // `PI_CODING_AGENT_DIR` points at the store Pi itself will read.
    Ok(effective_local_agent_env(&descriptor))
}

fn local_vault_path(vault_path: &str) -> Result<PathBuf, AppError> {
    let trimmed = vault_path.trim();
    if trimmed.is_empty() {
        return Err(AppError::message("Pi project trust: vault path is empty"));
    }
    if trimmed.starts_with("remote:") {
        return Err(AppError::message(
            "Pi project trust only applies to local Vaults",
        ));
    }
    let path = PathBuf::from(trimmed);
    if !path.is_dir() {
        return Err(AppError::message(format!(
            "Pi project trust: vault is not a directory: {}",
            path.display()
        )));
    }
    Ok(path)
}

/// Read Pi's effective project-trust decision for a local Vault.
#[tauri::command]
#[specta::specta]
pub fn agent_pi_project_trust_status(
    registry: State<'_, AgentRegistry>,
    agent_id: String,
    vault_path: String,
) -> ApiResult<PiProjectTrustStatus> {
    let result = (|| {
        let env = pi_agent_env(registry.inner(), &agent_id)?;
        let vault = local_vault_path(&vault_path)?;
        let (agent_dir, home) = pi_trust::dirs_from_env(&env, &vault)?;
        pi_trust::status(&vault, &agent_dir, &home)
    })();
    match result {
        Ok(status) => ApiResult::ok(status),
        Err(error) => map_err(error),
    }
}

/// Trust this Vault for Pi, then drop the agent's warm connections so the next
/// session starts with project resources loaded.
///
/// The warm pool also keys Pi connections by the effective trust decision, so
/// a grant made outside Agentero (Pi's own prompt, settings edit) invalidates
/// them on the next turn too.
#[tauri::command]
#[specta::specta]
pub fn agent_pi_project_trust_grant(
    registry: State<'_, AgentRegistry>,
    pool: State<'_, Arc<AgentWarmPool>>,
    queries: State<'_, Arc<crate::features::agent::session::query::AgentQueryPool>>,
    agent_id: String,
    vault_path: String,
) -> ApiResult<PiProjectTrustStatus> {
    let result = (|| {
        let env = pi_agent_env(registry.inner(), &agent_id)?;
        let vault = local_vault_path(&vault_path)?;
        let (agent_dir, home) = pi_trust::dirs_from_env(&env, &vault)?;
        let status = pi_trust::grant(&vault, &agent_dir, &home)?;
        pool.discard_agent(&agent_id);
        queries.discard_agent(&agent_id);
        log::info!(
            target: "agentero::agent",
            "agent={agent_id} pi project trust granted vault={} required={} trusted={}",
            vault.display(),
            status.required,
            status.trusted
        );
        Ok(status)
    })();
    match result {
        Ok(status) => ApiResult::ok(status),
        Err(error) => map_err(error),
    }
}
