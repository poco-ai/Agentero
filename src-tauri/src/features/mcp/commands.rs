//! Tauri commands for the loopback MCP server and its ChatGPT tunnel.

use super::tunnel::{McpTunnelController, McpTunnelStatus};
use super::{McpController, McpStatus};
use crate::core::error::ApiResult;
use crate::core::error::AppError;
use crate::features::settings::AppSettingsStore;
use serde::Deserialize;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn mcp_get_status(ctrl: State<'_, Arc<McpController>>) -> ApiResult<McpStatus> {
    ApiResult::ok(ctrl.status())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSetEnabledArgs {
    pub enabled: bool,
}

#[tauri::command]
pub async fn mcp_set_enabled(
    ctrl: State<'_, Arc<McpController>>,
    tunnel: State<'_, Arc<McpTunnelController>>,
    args: McpSetEnabledArgs,
) -> Result<ApiResult<McpStatus>, String> {
    use crate::core::log_util::OpTimer;
    let op = OpTimer::start_with("mcp_set_enabled", format!("enabled={}", args.enabled));
    let ctrl = Arc::clone(&ctrl);
    let status = ctrl.set_enabled(args.enabled).await;
    if !args.enabled {
        // MCP off ⇒ tunnel has nothing to serve and must not keep running.
        tunnel.stop();
    }
    if let Some(err) = status.last_error.as_deref() {
        if !err.is_empty() && args.enabled {
            op.finish_err_msg("mcp", err);
        } else {
            op.finish_ok_extra(format!(
                "listening={} port={}",
                status.listening, status.port
            ));
        }
    } else {
        op.finish_ok_extra(format!(
            "listening={} port={}",
            status.listening, status.port
        ));
    }
    Ok(ApiResult::ok(status))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSetPortArgs {
    pub port: u16,
}

#[tauri::command]
pub async fn mcp_set_port(
    ctrl: State<'_, Arc<McpController>>,
    args: McpSetPortArgs,
) -> Result<ApiResult<McpStatus>, String> {
    let ctrl = Arc::clone(&ctrl);
    Ok(ApiResult::ok(ctrl.set_port(args.port).await))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSetVaultArgs {
    pub vault_path: Option<String>,
}

#[tauri::command]
pub fn mcp_set_vault(ctrl: State<'_, Arc<McpController>>, args: McpSetVaultArgs) -> ApiResult<()> {
    ctrl.set_vault(args.vault_path);
    ApiResult::ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSetParentDirArgs {
    pub parent_dir: String,
}

#[tauri::command]
pub fn mcp_set_parent_dir(
    ctrl: State<'_, Arc<McpController>>,
    args: McpSetParentDirArgs,
) -> ApiResult<()> {
    let dir = args
        .parent_dir
        .trim()
        .replace('\\', "/")
        .trim_matches('/')
        .to_string();
    if !dir.is_empty() {
        ctrl.set_parent_dir(dir);
    }
    ApiResult::ok(())
}

#[tauri::command]
pub fn mcp_tunnel_status(
    tunnel: State<'_, Arc<McpTunnelController>>,
) -> ApiResult<McpTunnelStatus> {
    ApiResult::ok(tunnel.status())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTunnelStartArgs {
    pub mcp_url: String,
}

#[tauri::command]
pub async fn mcp_tunnel_start(
    tunnel: State<'_, Arc<McpTunnelController>>,
    mcp: State<'_, Arc<McpController>>,
    store: State<'_, AppSettingsStore>,
    args: McpTunnelStartArgs,
) -> Result<ApiResult<McpTunnelStatus>, String> {
    use crate::core::log_util::OpTimer;
    let op = OpTimer::start_with("mcp_tunnel_start", "");

    let Some((tunnel_id, api_key)) = store.mcp_tunnel_config() else {
        let err = AppError::message("Configure Tunnel ID and Runtime API key first.");
        op.finish_err_msg(
            "mcp_tunnel",
            "Configure Tunnel ID and Runtime API key first.",
        );
        return Ok(ApiResult::err(err));
    };

    let mcp_status = mcp.status();
    if !mcp_status.listening {
        let err = AppError::message("MCP server is not listening.");
        op.finish_err_msg("mcp_tunnel", "MCP server is not listening.");
        return Ok(ApiResult::err(err));
    }

    let tunnel = Arc::clone(&tunnel);
    let status = tunnel.start(args.mcp_url, tunnel_id, api_key).await;
    if let Some(err) = status.last_error.as_deref() {
        if !err.is_empty() {
            op.finish_err_msg("mcp_tunnel", err);
        } else {
            op.finish_ok_extra(format!("phase={:?}", status.phase));
        }
    } else {
        op.finish_ok_extra(format!("phase={:?}", status.phase));
    }
    Ok(ApiResult::ok(status))
}

#[tauri::command]
pub fn mcp_tunnel_stop(tunnel: State<'_, Arc<McpTunnelController>>) -> ApiResult<McpTunnelStatus> {
    tunnel.stop();
    ApiResult::ok(tunnel.status())
}
