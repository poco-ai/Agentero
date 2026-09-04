use super::{BridgeClientController, BridgeClientStatus};
use crate::core::error::{map_err, ApiResult, AppError};
use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, State};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeConnectArgs {
    pub offer_url: String,
    pub device_name: String,
}

#[tauri::command]
pub fn bridge_connect(
    app: AppHandle,
    controller: State<'_, BridgeClientController>,
    args: BridgeConnectArgs,
) -> ApiResult<BridgeClientStatus> {
    match controller.connect(app, args.offer_url, args.device_name) {
        Ok(status) => ApiResult::ok(status),
        Err(error) => map_err(error),
    }
}

#[tauri::command]
#[cfg(target_os = "ios")]
pub fn bridge_resume(
    app: AppHandle,
    controller: State<'_, BridgeClientController>,
) -> ApiResult<BridgeClientStatus> {
    match controller.resume(app) {
        Ok(status) => ApiResult::ok(status),
        Err(error) => map_err(error),
    }
}

#[tauri::command]
pub fn bridge_disconnect(controller: State<'_, BridgeClientController>) -> ApiResult<()> {
    match controller.disconnect() {
        Ok(()) => ApiResult::ok(()),
        Err(error) => map_err(error),
    }
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub fn bridge_status(
    controller: State<'_, BridgeClientController>,
) -> ApiResult<BridgeClientStatus> {
    match controller.status() {
        Ok(status) => ApiResult::ok(status),
        Err(error) => map_err(error),
    }
}

#[tauri::command]
pub async fn bridge_rpc(
    controller: State<'_, BridgeClientController>,
    method: String,
    params: Value,
) -> Result<ApiResult<Value>, String> {
    if method.trim().is_empty() {
        return Ok(map_err(AppError::message("Bridge RPC method is required")));
    }
    match controller.rpc(method, params).await {
        Ok(data) => Ok(ApiResult::ok(data)),
        Err(error) => Ok(map_err(error)),
    }
}
