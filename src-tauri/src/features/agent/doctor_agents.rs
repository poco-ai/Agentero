//! Doctor-side ACP diagnostics: re-probe every registered Agent and classify
//! failure reasons so Settings can show actionable causes instead of raw text.

use crate::core::error::AppError;
use crate::features::agent::acp::client::{
    effective_local_agent_env, resolve_command_in_agent_env,
};
use crate::features::agent::acp::probe_agent;
use crate::features::agent::doctor::{
    diagnose_claude_auth, diagnose_codex_auth, diagnose_tool, CodexAuthStatus, HostToolStatus,
};
use crate::features::agent::models::{AgentDescriptor, AgentTemplate, ProbeResult};
use crate::features::agent::registry::store::chrono_like_now;
use crate::features::agent::registry::template_info;
use crate::features::agent::service::emit_registry_changed;
use crate::features::agent::{AgentRegistry, AgentWarmGate};
use futures_util::stream::{self, StreamExt};
use serde::Serialize;
use tauri::AppHandle;

/// Cold starts (node adapters, MCP discovery) are slow; keep concurrency small
/// so Doctor does not spawn every CLI at once.
const PROBE_CONCURRENCY: usize = 3;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum AcpFailureCategory {
    CommandMissing,
    NotLoggedIn,
    Timeout,
    SpawnFailed,
    ProtocolFailed,
    Unknown,
}

/// Login / auth state shown on each Agent Doctor card.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum AgentAuthStatus {
    Authenticated,
    Unauthenticated,
    NotApplicable,
    Unknown,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentAcpDiagnostic {
    pub agent_id: String,
    pub name: String,
    pub template: AgentTemplate,
    pub command: String,
    /// Agent host CLI (`detect_command`), when distinct from the ACP entrypoint.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_command: Option<String>,
    /// Host CLI OAuth/login command from the built-in template.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login_command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_version: Option<String>,
    /// ACP entrypoint resolved path (`command`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_path: Option<String>,
    /// ACP entrypoint `--version` output (not the ACP protocol version).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acp_version: Option<String>,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_category: Option<AcpFailureCategory>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub auth_status: AgentAuthStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub probed_at: Option<String>,
}

/// Map raw ACP/probe error text onto a fixed category. Order matters: auth
/// failures are often wrapped in `initialize failed: {e}` (probe.rs), so
/// NotLoggedIn must be checked before ProtocolFailed. Mirrors the frontend
/// `isAgentAuthFailure` classifier in `src/lib/agent/api.ts`.
pub(crate) fn classify_acp_error(text: &str) -> AcpFailureCategory {
    let lower = text.to_ascii_lowercase();
    let contains_any = |needles: &[&str]| needles.iter().any(|needle| lower.contains(needle));

    if contains_any(&[
        "not found on path",
        "no such file or directory",
        "(os error 2)",
    ]) {
        return AcpFailureCategory::CommandMissing;
    }
    if contains_any(&[
        "invalid_grant",
        "failed to authenticate",
        "authentication failed",
        "not authenticated",
        "login required",
        "unauthenticated",
        "authentication required",
        "authrequired",
        "not logged in",
    ]) {
        return AcpFailureCategory::NotLoggedIn;
    }
    if lower.contains("timed out") {
        return AcpFailureCategory::Timeout;
    }
    if contains_any(&[
        "failed to start",
        "permission denied",
        "(os error 13)",
        "(os error 193)",
    ]) {
        return AcpFailureCategory::SpawnFailed;
    }
    if contains_any(&[
        "initialize failed",
        "no initialize response",
        "unsupported protocol",
        "method not found",
    ]) {
        return AcpFailureCategory::ProtocolFailed;
    }
    AcpFailureCategory::Unknown
}

/// Probe one agent without spawning when its command is known to be missing
/// (mirrors the `agent_probe` fast path in commands/registry.rs).
async fn probe_one(registry: &AgentRegistry, desc: &AgentDescriptor) -> ProbeResult {
    let result = if !desc.available {
        ProbeResult {
            agent_id: desc.id.clone(),
            available: false,
            agent_name: None,
            protocol_version: None,
            error: desc
                .last_error
                .clone()
                .or_else(|| Some(format!("command `{}` not found on PATH", desc.command))),
            session_capabilities: None,
        }
    } else {
        probe_agent(desc, None).await
    };
    let _ = registry.apply_probe_result(&desc.id, &result);
    result
}

fn detect_command_for(desc: &AgentDescriptor) -> Option<String> {
    template_info(desc.template.as_str())
        .and_then(|info| info.detect_command)
        .filter(|cmd| !cmd.is_empty())
}

fn auth_status_from_probe(
    result: &ProbeResult,
    failure_category: Option<AcpFailureCategory>,
) -> AgentAuthStatus {
    if result.available {
        return AgentAuthStatus::Authenticated;
    }
    match failure_category {
        Some(AcpFailureCategory::NotLoggedIn) => AgentAuthStatus::Unauthenticated,
        Some(AcpFailureCategory::CommandMissing) => AgentAuthStatus::NotApplicable,
        _ => AgentAuthStatus::Unknown,
    }
}

fn auth_from_codex(status: CodexAuthStatus) -> AgentAuthStatus {
    match status {
        CodexAuthStatus::Authenticated => AgentAuthStatus::Authenticated,
        CodexAuthStatus::Unauthenticated => AgentAuthStatus::Unauthenticated,
        CodexAuthStatus::NotApplicable => AgentAuthStatus::NotApplicable,
        CodexAuthStatus::Unknown => AgentAuthStatus::Unknown,
    }
}

async fn diagnostic(desc: &AgentDescriptor, result: &ProbeResult) -> AgentAcpDiagnostic {
    let environment = effective_local_agent_env(desc);
    // Fall back to the ACP entrypoint when the template has no distinct detect binary
    // (custom agents, or native-ACP CLIs where command == detect).
    let agent_command = detect_command_for(desc)
        .or_else(|| (!desc.command.is_empty()).then(|| desc.command.clone()));
    let same_binary = agent_command
        .as_ref()
        .is_some_and(|cmd| cmd == &desc.command);
    // Claude/Codex adapters ship bundled with the app (see `registry/bundled.rs`),
    // so a PATH probe of the adapter is meaningless and would spawn a console
    // window on Windows. Their Doctor card omits the ACP row; only the host CLI
    // row and login status matter. (#686)
    let acp_bundled = matches!(
        desc.template,
        AgentTemplate::CodexAcp | AgentTemplate::ClaudeAcp
    );
    let acp_tool = if acp_bundled {
        None
    } else {
        Some(diagnose_tool(&desc.command, &environment).await)
    };
    let agent_tool = if same_binary {
        None
    } else if let Some(ref cmd) = agent_command {
        Some(diagnose_tool(cmd, &environment).await)
    } else {
        None
    };
    // Prefer diagnose_tool paths; fall back to which() when --version failed.
    let (agent_path, agent_version) = if same_binary {
        (
            acp_tool
                .as_ref()
                .and_then(|tool| tool.resolved_path.clone())
                .or_else(|| {
                    resolve_command_in_agent_env(&desc.command, &environment)
                        .map(|path| path.display().to_string())
                }),
            acp_tool.as_ref().and_then(|tool| {
                (tool.status == HostToolStatus::Available)
                    .then(|| tool.version.clone())
                    .flatten()
            }),
        )
    } else {
        (
            agent_tool
                .as_ref()
                .and_then(|tool| tool.resolved_path.clone())
                .or_else(|| {
                    agent_command
                        .as_ref()
                        .and_then(|cmd| resolve_command_in_agent_env(cmd, &environment))
                        .map(|path| path.display().to_string())
                }),
            agent_tool.as_ref().and_then(|tool| {
                (tool.status == HostToolStatus::Available)
                    .then(|| tool.version.clone())
                    .flatten()
            }),
        )
    };
    let resolved_path = acp_tool.as_ref().and_then(|tool| {
        tool.resolved_path.clone().or_else(|| {
            resolve_command_in_agent_env(&desc.command, &environment)
                .map(|path| path.display().to_string())
        })
    });
    let acp_version = acp_tool.as_ref().and_then(|tool| {
        (tool.status == HostToolStatus::Available)
            .then(|| tool.version.clone())
            .flatten()
    });

    let error = if result.available {
        None
    } else {
        result.error.clone()
    };
    let failure_category = error
        .as_deref()
        .map(|text| Some(classify_acp_error(text)))
        .unwrap_or_else(|| {
            if result.available {
                None
            } else {
                Some(AcpFailureCategory::Unknown)
            }
        });

    let auth_status =
        if desc.template == AgentTemplate::CodexAcp || desc.template == AgentTemplate::ClaudeAcp {
            // Probe already fails OAuth-gated agents when login status is unauthenticated;
            // reuse that signal and only re-query when the failure reason is ambiguous.
            match failure_category {
                Some(AcpFailureCategory::NotLoggedIn) => AgentAuthStatus::Unauthenticated,
                Some(AcpFailureCategory::CommandMissing) => AgentAuthStatus::NotApplicable,
                _ if result.available => AgentAuthStatus::Authenticated,
                _ => {
                    let diagnosed = if desc.template == AgentTemplate::ClaudeAcp {
                        diagnose_claude_auth(desc).await.status
                    } else {
                        diagnose_codex_auth(desc).await.status
                    };
                    auth_from_codex(diagnosed)
                }
            }
        } else {
            auth_status_from_probe(result, failure_category)
        };

    AgentAcpDiagnostic {
        agent_id: desc.id.clone(),
        name: desc.name.clone(),
        template: desc.template.clone(),
        command: desc.command.clone(),
        agent_command,
        login_command: template_info(desc.template.as_str()).and_then(|info| info.login_command),
        agent_path,
        agent_version,
        resolved_path,
        acp_version,
        ok: result.available,
        failure_category,
        error,
        auth_status,
        agent_name: result.agent_name.clone(),
        protocol_version: result.protocol_version.clone(),
        probed_at: Some(chrono_like_now()),
    }
}

/// Re-probe every registered Agent over ACP initialize and write results back
/// to the registry (so the Agent settings pane stays in sync). Doctor is a
/// user-initiated retry: it ignores the warm-gate cooldown and clears the gate
/// on success, but never records new failures there.
pub async fn diagnose_agents(
    registry: &AgentRegistry,
    warm_gate: &AgentWarmGate,
    app: &AppHandle,
) -> Result<Vec<AgentAcpDiagnostic>, AppError> {
    // Auto-register catalog agents that are on PATH but not yet persisted —
    // same path as Settings → Agent / chat switcher. Without this, Doctor
    // would only see an empty registry until the user visited Agent settings.
    let _ = registry.scan_catalog()?;

    // Snapshot once: it already refreshes command availability, and repeated
    // snapshots would re-run `which` for every agent each time.
    let agents = registry.snapshot()?.agents;
    if agents.is_empty() {
        return Ok(Vec::new());
    }

    let diagnostics = stream::iter(agents.into_iter().map(|desc| async move {
        let result = probe_one(registry, &desc).await;
        if result.available {
            warm_gate.clear(&desc.id);
        }
        diagnostic(&desc, &result).await
    }))
    .buffered(PROBE_CONCURRENCY)
    .collect::<Vec<_>>()
    .await;

    emit_registry_changed(app);
    Ok(diagnostics)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_command_missing() {
        assert_eq!(
            classify_acp_error(
                "command `codex-acp` not found on PATH (or common install locations)"
            ),
            AcpFailureCategory::CommandMissing
        );
        assert_eq!(
            classify_acp_error("failed to spawn agent: No such file or directory (os error 2)"),
            AcpFailureCategory::CommandMissing
        );
    }

    #[test]
    fn classifies_not_logged_in() {
        assert_eq!(
            classify_acp_error("Codex is not logged in"),
            AcpFailureCategory::NotLoggedIn
        );
        assert_eq!(
            classify_acp_error("invalid_grant: token expired"),
            AcpFailureCategory::NotLoggedIn
        );
    }

    #[test]
    fn classifies_timeout() {
        assert_eq!(
            classify_acp_error("probe timed out after 30s (check Agent proxy / network)"),
            AcpFailureCategory::Timeout
        );
        assert_eq!(
            classify_acp_error("initialize timed out after 30s"),
            AcpFailureCategory::Timeout
        );
    }

    #[test]
    fn classifies_spawn_failed() {
        assert_eq!(
            classify_acp_error("failed to start: Permission denied (os error 13)"),
            AcpFailureCategory::SpawnFailed
        );
        assert_eq!(
            classify_acp_error("%1 is not a valid Win32 application. (os error 193)"),
            AcpFailureCategory::SpawnFailed
        );
    }

    #[test]
    fn classifies_protocol_failed() {
        assert_eq!(
            classify_acp_error("initialize failed: agent returned an error"),
            AcpFailureCategory::ProtocolFailed
        );
        assert_eq!(
            classify_acp_error("no initialize response"),
            AcpFailureCategory::ProtocolFailed
        );
    }

    #[test]
    fn auth_wrapped_in_initialize_wins_over_protocol() {
        assert_eq!(
            classify_acp_error("initialize failed: authentication required"),
            AcpFailureCategory::NotLoggedIn
        );
        assert_eq!(
            classify_acp_error("initialize failed: request timed out after 15s"),
            AcpFailureCategory::Timeout
        );
    }

    #[test]
    fn os_error_2_does_not_match_other_codes() {
        assert_eq!(
            classify_acp_error("boom (os error 22)"),
            AcpFailureCategory::Unknown
        );
    }

    #[test]
    fn falls_back_to_unknown() {
        assert_eq!(
            classify_acp_error("something went wrong"),
            AcpFailureCategory::Unknown
        );
    }
}
