//! Discover and ACP-probe agents on a remote vault host (SSH).

use super::models::{AgentDescriptor, CatalogAcpStatus, CatalogEntry, ProbeResult};
use super::probe_agent;
use super::templates::{catalog_templates, template_from_id, template_info};
use super::tool_lifecycle;
use crate::core::error::AppError;
use crate::features::remote::agent_exec;
use crate::features::remote::launch::resolve_remote_target;
use crate::features::remote::session::{RemoteRegistry, RemoteSession, LOCAL_SIM_HOST};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAgentScanResponse {
    pub session_id: String,
    pub destination: String,
    pub entries: Vec<CatalogEntry>,
}

/// List catalog templates with remote PATH presence (`command -v` / local which for sim).
pub async fn scan_remote_agents(
    registry: &RemoteRegistry,
    session_id: &str,
) -> Result<RemoteAgentScanResponse, AppError> {
    let session = registry.get(session_id).await?;
    let destination = session_destination(&session);
    let mut entries = Vec::new();

    for tmpl in catalog_templates() {
        let detect = tmpl
            .detect_command
            .as_deref()
            .unwrap_or(tmpl.command.as_str());
        let detect_path = remote_or_local_which(&session, &destination, detect).await?;
        let acp_path = if tmpl.command == detect {
            detect_path.clone()
        } else {
            remote_or_local_which(&session, &destination, &tmpl.command).await?
        };

        let binary_available = detect_path.is_some();
        let acp_command_available = acp_path.is_some();
        let adapter_distinct = tmpl
            .detect_command
            .as_ref()
            .is_some_and(|d| d != &tmpl.command);
        // Remote has no silent lifecycle; can_install only reflects local capability.
        let can_install = tool_lifecycle::supports_lifecycle(&tmpl.id);
        let offer_install = binary_available
            && !acp_command_available
            && tmpl.install_command.as_ref().is_some_and(|c| !c.is_empty());

        let acp_status = if !acp_command_available {
            CatalogAcpStatus::Missing
        } else {
            CatalogAcpStatus::NotProbed
        };

        entries.push(CatalogEntry {
            template_id: tmpl.id.clone(),
            name: tmpl.name,
            description: tmpl.description,
            command: tmpl.command,
            args: tmpl.args,
            install_hint: tmpl.install_hint,
            install_command: tmpl.install_command,
            offer_install,
            can_install,
            adapter_distinct,
            binary_available,
            resolved_path: detect_path.or(acp_path),
            acp_command_available,
            acp_status,
            registered_id: None,
            is_default: false,
            acp_agent_name: None,
            last_probe_error: None,
            last_probed_at: None,
        });
    }

    Ok(RemoteAgentScanResponse {
        session_id: session_id.to_string(),
        destination,
        entries,
    })
}

/// ACP initialize probe for one catalog template on the remote host.
///
/// `proxy_url` is injected as remote `HTTP(S)_PROXY` when `proxy_enabled` (same
/// Settings → General → Network proxy as local; the proxy must be reachable
/// **from the server**).
pub async fn probe_remote_template(
    registry: &RemoteRegistry,
    session_id: &str,
    template_id: &str,
    proxy_enabled: bool,
    proxy_url: &str,
) -> Result<ProbeResult, AppError> {
    let info = template_info(template_id)
        .ok_or_else(|| AppError::message(format!("unknown catalog template: {template_id}")))?;

    let handle = format!("remote:{session_id}");
    let remote = resolve_remote_target(registry, Some(&handle))
        .await?
        .ok_or_else(|| AppError::message("remote session not found"))?;

    let mut desc = descriptor_from_template(&info.id, &info.name, &info.command, &info.args);
    apply_proxy_env(&mut desc, proxy_enabled, proxy_url);

    // Ensure binaries exist before full ACP handshake (faster fail + clearer errors).
    let detect_bin = info
        .detect_command
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(info.command.as_str());
    let acp_bin = info.command.as_str();
    let destination = if remote.is_ssh() {
        remote.destination.clone()
    } else {
        String::new()
    };
    if remote.is_ssh() {
        let detect_ok = agent_exec::remote_which(&destination, detect_bin)
            .await?
            .is_some();
        let acp_ok = if acp_bin == detect_bin {
            detect_ok
        } else {
            agent_exec::remote_which(&destination, acp_bin)
                .await?
                .is_some()
        };
        if !detect_ok && !acp_ok {
            return Ok(ProbeResult {
                agent_id: desc.id,
                available: false,
                agent_name: None,
                protocol_version: None,
                error: Some(format!("`{detect_bin}` not found on remote PATH")),
                session_capabilities: None,
            });
        }
        if detect_ok && !acp_ok {
            let hint = info
                .install_command
                .as_deref()
                .filter(|c| !c.is_empty())
                .map(|c| {
                    format!(" Install ACP adapter on the server (Settings → Install ACP): {c}")
                })
                .unwrap_or_default();
            return Ok(ProbeResult {
                agent_id: desc.id,
                available: false,
                agent_name: None,
                protocol_version: None,
                error: Some(format!(
                    "ACP entrypoint `{acp_bin}` not found on remote PATH (host CLI `{detect_bin}` is present).{hint}"
                )),
                session_capabilities: None,
            });
        }
    } else if which::which(detect_bin).is_err() && which::which(acp_bin).is_err() {
        return Ok(ProbeResult {
            agent_id: desc.id,
            available: false,
            agent_name: None,
            protocol_version: None,
            error: Some(format!("`{detect_bin}` not found on PATH")),
            session_capabilities: None,
        });
    }

    Ok(probe_agent(&desc, Some(&remote)).await)
}

fn apply_proxy_env(desc: &mut AgentDescriptor, proxy_enabled: bool, proxy_url: &str) {
    for key in agent_exec::REMOTE_PROXY_ENV_KEYS {
        desc.env.remove(*key);
    }
    if !proxy_enabled {
        return;
    }
    let url = proxy_url.trim();
    if url.is_empty() {
        return;
    }
    for key in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] {
        desc.env.insert(key.to_string(), url.to_string());
    }
}

fn descriptor_from_template(
    template_id: &str,
    name: &str,
    command: &str,
    args: &[String],
) -> AgentDescriptor {
    AgentDescriptor {
        id: format!("remote-catalog-{template_id}"),
        name: name.to_string(),
        template: template_from_id(template_id),
        command: command.to_string(),
        args: args.to_vec(),
        env: HashMap::new(),
        available: true,
        last_error: None,
        last_probe_ok: None,
        last_probe_agent_name: None,
        last_probe_error: None,
        last_probed_at: None,
    }
}

fn session_destination(session: &RemoteSession) -> String {
    if session.kind == "local-sim" || session.host == LOCAL_SIM_HOST {
        "local-sim".into()
    } else {
        session.host.clone()
    }
}

async fn remote_or_local_which(
    session: &Arc<RemoteSession>,
    destination: &str,
    bin: &str,
) -> Result<Option<String>, AppError> {
    if session.kind == "local-sim" || session.host == LOCAL_SIM_HOST {
        return Ok(which::which(bin).ok().map(|p| p.display().to_string()));
    }
    agent_exec::remote_which(destination, bin).await
}
