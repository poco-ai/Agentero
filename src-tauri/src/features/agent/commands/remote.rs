//! Tauri commands for the remote agent catalog (`registry::remote`).
//!
//! Async commands return `Result<ApiResult<T>, String>` so `State` borrows are valid
//! (same pattern as `agent_probe`).

use crate::core::error::{map_err, ApiResult, AppError};
use crate::core::log_util::{trunc, OpTimer};
use crate::features::agent::models::ProbeResult;
use crate::features::agent::registry::remote::{self as remote_catalog, RemoteAgentScanResponse};
use crate::features::agent::remote_host::RemoteAgentHosts;
use crate::features::agent::AgentRegistry;
use serde::Deserialize;
use std::sync::Arc;
use tauri::State;

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAgentScanArgs {
    pub session_id: String,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAgentProbeArgs {
    pub session_id: String,
    pub template_id: String,
}

/// Catalog-style scan of common agents on the remote host (`command -v`).
#[tauri::command]
#[specta::specta]
pub async fn remote_agent_scan(
    registry: State<'_, Arc<dyn RemoteAgentHosts>>,
    args: RemoteAgentScanArgs,
) -> Result<ApiResult<RemoteAgentScanResponse>, String> {
    let op = OpTimer::start_with(
        "remote_agent_scan",
        format!("session={}", trunc(&args.session_id, 40)),
    );
    match remote_catalog::scan_remote_agents(registry.inner().as_ref(), &args.session_id).await {
        Ok(r) => {
            op.finish_ok_extra(format!("entries={}", r.entries.len()));
            Ok(ApiResult::ok(r))
        }
        Err(e) => {
            op.finish_err(&e);
            Ok(map_err(e))
        }
    }
}

/// ACP initialize probe for one catalog template on the remote vault host.
#[tauri::command]
#[specta::specta]
pub async fn remote_agent_probe(
    registry: State<'_, Arc<dyn RemoteAgentHosts>>,
    agent_registry: State<'_, AgentRegistry>,
    args: RemoteAgentProbeArgs,
) -> Result<ApiResult<ProbeResult>, String> {
    let op = OpTimer::start_with(
        "remote_agent_probe",
        format!(
            "session={} template={}",
            trunc(&args.session_id, 40),
            trunc(&args.template_id, 40)
        ),
    );
    let (proxy_enabled, proxy_url) = agent_registry.proxy_settings().unwrap_or_default();
    match remote_catalog::probe_remote_template(
        registry.inner().as_ref(),
        &args.session_id,
        &args.template_id,
        proxy_enabled,
        &proxy_url,
    )
    .await
    {
        Ok(r) => {
            if r.available {
                op.finish_ok();
            } else {
                op.finish_ok_extra(format!(
                    "fail={}",
                    trunc(r.error.as_deref().unwrap_or("?"), 80)
                ));
            }
            Ok(ApiResult::ok(r))
        }
        Err(e) => {
            op.finish_err(&e);
            Ok(map_err(e))
        }
    }
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAgentInstallArgs {
    pub session_id: String,
    pub template_id: String,
}

/// Open a local terminal that SSHes into the remote host and runs the template's
/// install command after the user presses Enter (same confirm UX as local install).
#[cfg(not(target_os = "ios"))]
#[tauri::command]
#[specta::specta]
pub async fn remote_agent_open_install_terminal(
    registry: State<'_, Arc<dyn RemoteAgentHosts>>,
    args: RemoteAgentInstallArgs,
) -> Result<ApiResult<crate::core::json::JsonValue>, String> {
    use crate::app::terminal;
    use crate::features::agent::registry::templates::template_info;

    let info = match template_info(&args.template_id) {
        Some(t) => t,
        None => {
            return Ok(map_err(AppError::message(format!(
                "unknown catalog template: {}",
                args.template_id
            ))));
        }
    };
    let install = match info.install_command {
        Some(c) if !c.trim().is_empty() => c.trim().to_string(),
        _ => {
            return Ok(map_err(AppError::message(format!(
                "no install command for template: {}",
                args.template_id
            ))));
        }
    };
    let session = match registry.get_session(&args.session_id).await {
        Ok(s) => s,
        Err(e) => return Ok(map_err(e)),
    };
    if session.is_local_sim() {
        return Ok(match terminal::open_terminal_confirm_command(&install) {
            Ok(()) => ApiResult::ok(crate::core::json::JsonValue::null()),
            Err(e) => map_err(e),
        });
    }
    let destination = session.host().to_string();
    match terminal::open_terminal_confirm_remote_install(&destination, &install) {
        Ok(()) => Ok(ApiResult::ok(crate::core::json::JsonValue::null())),
        Err(e) => Ok(map_err(e)),
    }
}
