//! Discover and ACP-probe agents on a remote vault host (SSH).

use crate::core::error::AppError;
use crate::core::remote::REMOTE_PROXY_ENV_KEYS;
use crate::features::agent::models::{
    AgentDescriptor, CatalogAcpStatus, CatalogEntry, ProbeResult,
};
use crate::features::agent::probe_agent;
use crate::features::agent::registry::lifecycle as tool_lifecycle;
use crate::features::agent::registry::templates::{
    catalog_templates, template_from_id, template_info,
};
use crate::features::agent::remote_host::{RemoteAgentHosts, RemoteAgentLaunch};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAgentScanResponse {
    pub session_id: String,
    pub destination: String,
    pub entries: Vec<CatalogEntry>,
}

/// List catalog templates with remote PATH presence (`command -v` / local which for sim).
pub async fn scan_remote_agents(
    registry: &dyn RemoteAgentHosts,
    session_id: &str,
) -> Result<RemoteAgentScanResponse, AppError> {
    let session = registry.get_session(session_id).await?;
    let destination = session_destination(session.as_ref());
    let mut entries = Vec::new();

    // Antigravity's command and arguments vary by platform. This catalog uses
    // local templates without detecting the remote OS; use a custom agent there.
    for tmpl in catalog_templates()
        .into_iter()
        .filter(|tmpl| tmpl.id != "antigravity-acp")
    {
        let detect = tmpl
            .detect_command
            .as_deref()
            .unwrap_or(tmpl.command.as_str());
        let detect_path = session.which(detect).await?;
        let acp_path = if tmpl.command == detect {
            detect_path.clone()
        } else {
            session.which(&tmpl.command).await?
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
            login_command: tmpl.login_command,
            // Remote rows do not expose the "open in terminal" action.
            cli_command: None,
            offer_install,
            can_install,
            adapter_distinct,
            binary_available,
            resolved_path: detect_path.or(acp_path),
            acp_command_available,
            // The bundled tier is local-only; remote hosts resolve their own.
            acp_bundled: false,
            acp_bundled_version: None,
            acp_status,
            registered_id: None,
            is_default: false,
            acp_agent_name: None,
            last_probe_error: None,
            last_probed_at: None,
            // Remote has no silent update check; Upgrade stays hidden.
            installed_version: None,
            latest_version: None,
            update_available: None,
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
    registry: &dyn RemoteAgentHosts,
    session_id: &str,
    template_id: &str,
    proxy_enabled: bool,
    proxy_url: &str,
) -> Result<ProbeResult, AppError> {
    let info = template_info(template_id)
        .ok_or_else(|| AppError::message(format!("unknown catalog template: {template_id}")))?;

    let remote = registry.get_session(session_id).await?;

    let mut desc = descriptor_from_template(&info.id, &info.name, &info.command, &info.args);
    apply_proxy_env(&mut desc, proxy_enabled, proxy_url);

    // Ensure binaries exist before full ACP handshake (faster fail + clearer errors).
    let detect_bin = info
        .detect_command
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(info.command.as_str());
    let acp_bin = info.command.as_str();
    if remote.is_ssh() {
        let detect_ok = remote.which(detect_bin).await?.is_some();
        let acp_ok = if acp_bin == detect_bin {
            detect_ok
        } else {
            remote.which(acp_bin).await?.is_some()
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

    Ok(probe_agent(&desc, Some(remote.as_ref())).await)
}

fn apply_proxy_env(desc: &mut AgentDescriptor, proxy_enabled: bool, proxy_url: &str) {
    for key in REMOTE_PROXY_ENV_KEYS {
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
    // Same loopback bypass as local agents: OpenCode on the remote host also
    // reaches its own serve child over 127.0.0.1, and the mirrored proxy env
    // would hijack that loopback traffic.
    desc.env.insert(
        "NO_PROXY".to_string(),
        crate::features::agent::models::merge_no_proxy(desc.env.get("NO_PROXY")),
    );
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

fn session_destination(session: &dyn RemoteAgentLaunch) -> String {
    if session.is_local_sim() {
        "local-sim".into()
    } else {
        session.host().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::apply_proxy_env;
    use crate::features::agent::models::AgentTemplate;

    fn descriptor() -> crate::features::agent::models::AgentDescriptor {
        crate::features::agent::models::AgentDescriptor {
            id: "remote-catalog-opencode".into(),
            name: "OpenCode".into(),
            template: AgentTemplate::Opencode,
            command: "opencode".into(),
            args: vec!["acp".into()],
            env: std::collections::HashMap::new(),
            available: true,
            last_error: None,
            last_probe_ok: None,
            last_probe_agent_name: None,
            last_probe_error: None,
            last_probed_at: None,
        }
    }

    /// Remote probes inject the same loopback bypass as local agents: OpenCode
    /// on the server reaches its own serve child over 127.0.0.1, which must
    /// not be routed through the mirrored proxy.
    #[test]
    fn proxy_env_adds_loopback_no_proxy() {
        let mut desc = descriptor();
        apply_proxy_env(&mut desc, true, "http://10.0.0.2:7890");
        assert_eq!(
            desc.env.get("HTTP_PROXY").map(String::as_str),
            Some("http://10.0.0.2:7890")
        );
        assert_eq!(
            desc.env.get("NO_PROXY").map(String::as_str),
            Some("127.0.0.1,localhost,::1")
        );
    }

    #[test]
    fn proxy_env_disabled_clears_injected_keys() {
        let mut desc = descriptor();
        apply_proxy_env(&mut desc, true, "http://10.0.0.2:7890");
        apply_proxy_env(&mut desc, false, "http://10.0.0.2:7890");
        assert!(desc.env.is_empty());
    }
}
