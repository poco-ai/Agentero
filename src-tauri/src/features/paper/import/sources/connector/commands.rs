//! Tauri commands for the Zotero Connector–compatible local server.

use crate::core::error::ApiResult;
use crate::features::connector::{ConnectorController, ConnectorStatus};
use serde::Deserialize;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn connector_get_status(
    ctrl: State<'_, Arc<ConnectorController>>,
) -> ApiResult<ConnectorStatus> {
    ApiResult::ok(ctrl.status())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorSetEnabledArgs {
    pub enabled: bool,
}

#[tauri::command]
pub async fn connector_set_enabled(
    ctrl: State<'_, Arc<ConnectorController>>,
    args: ConnectorSetEnabledArgs,
) -> Result<ApiResult<ConnectorStatus>, String> {
    use crate::core::log_util::OpTimer;

    let op = OpTimer::start_with("connector_set_enabled", format!("enabled={}", args.enabled));
    let ctrl = Arc::clone(&ctrl);
    let status = ctrl.set_enabled(args.enabled).await;
    if let Some(err) = status.last_error.as_deref() {
        if !err.is_empty() && args.enabled {
            op.finish_err_msg("connector", err);
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
pub struct ConnectorSetVaultArgs {
    pub vault_path: Option<String>,
}

#[tauri::command]
pub fn connector_set_vault(
    ctrl: State<'_, Arc<ConnectorController>>,
    args: ConnectorSetVaultArgs,
) -> ApiResult<()> {
    ctrl.set_vault(args.vault_path);
    ApiResult::ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorSetParentDirArgs {
    /// Vault-relative parent, e.g. `papers` or `papers/nlp`.
    pub parent_dir: String,
}

/// Remember the default save location (also exposed as selected collection).
#[tauri::command]
pub fn connector_set_parent_dir(
    ctrl: State<'_, Arc<ConnectorController>>,
    args: ConnectorSetParentDirArgs,
) -> ApiResult<()> {
    ctrl.set_parent_dir(args.parent_dir);
    ApiResult::ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorSetPortArgs {
    pub port: u16,
}

#[tauri::command]
pub async fn connector_set_port(
    ctrl: State<'_, Arc<ConnectorController>>,
    args: ConnectorSetPortArgs,
) -> Result<ApiResult<ConnectorStatus>, String> {
    let ctrl = Arc::clone(&ctrl);
    Ok(ApiResult::ok(ctrl.set_port(args.port).await))
}
