//! Tauri commands for the Zotero Connector–compatible local server.

use crate::error::AppError;
use crate::services::connector::{ConnectorController, ConnectorStatus};
use serde::Deserialize;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn connector_get_status(
    ctrl: State<'_, Arc<ConnectorController>>,
) -> Result<ConnectorStatus, AppError> {
    Ok(ctrl.status())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorSetEnabledArgs {
    pub enabled: bool,
}

#[tauri::command]
pub fn connector_set_enabled(
    ctrl: State<'_, Arc<ConnectorController>>,
    args: ConnectorSetEnabledArgs,
) -> Result<ConnectorStatus, AppError> {
    use crate::log_util::OpTimer;

    let op = OpTimer::start_with("connector_set_enabled", format!("enabled={}", args.enabled));
    let status = ctrl.set_enabled(args.enabled);
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
    Ok(status)
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
) -> Result<(), AppError> {
    ctrl.set_vault(args.vault_path);
    Ok(())
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
) -> Result<(), AppError> {
    ctrl.set_parent_dir(args.parent_dir);
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorSetPortArgs {
    pub port: u16,
}

#[tauri::command]
pub fn connector_set_port(
    ctrl: State<'_, Arc<ConnectorController>>,
    args: ConnectorSetPortArgs,
) -> Result<ConnectorStatus, AppError> {
    Ok(ctrl.set_port(args.port))
}
