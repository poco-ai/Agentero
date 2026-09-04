use super::{BridgeController, BridgeDevice, BridgeOffer, BridgeStatus};
use crate::core::error::{map_err, ApiResult, AppError};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStartArgs {
    pub vault_path: String,
    pub host_name: String,
    #[serde(default)]
    pub relay_endpoint: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeOfferResult {
    pub offer: BridgeOffer,
    pub url: String,
}

#[tauri::command]
pub fn bridge_start(
    app: AppHandle,
    controller: State<'_, BridgeController>,
    args: BridgeStartArgs,
) -> ApiResult<BridgeStatus> {
    match controller.start(app, args.vault_path, args.host_name, args.relay_endpoint) {
        Ok(status) => ApiResult::ok(status),
        Err(error) => map_err(error),
    }
}

#[tauri::command]
pub fn bridge_stop(controller: State<'_, BridgeController>) -> ApiResult<()> {
    match controller.stop() {
        Ok(()) => ApiResult::ok(()),
        Err(error) => map_err(error),
    }
}

#[cfg(not(target_os = "ios"))]
#[tauri::command]
pub fn bridge_status(controller: State<'_, BridgeController>) -> ApiResult<BridgeStatus> {
    match controller.status() {
        Ok(status) => ApiResult::ok(status),
        Err(error) => map_err(error),
    }
}

#[tauri::command]
pub fn bridge_offer(controller: State<'_, BridgeController>) -> ApiResult<BridgeOfferResult> {
    let offer = match controller.offer() {
        Ok(offer) => offer,
        Err(error) => return map_err(error),
    };
    match offer.to_pair_url() {
        Ok(url) => ApiResult::ok(BridgeOfferResult {
            offer,
            url: url.to_string(),
        }),
        Err(error) => map_err(error),
    }
}

#[tauri::command]
pub fn bridge_pair_respond(
    controller: State<'_, BridgeController>,
    request_id: String,
    allowed: bool,
) -> ApiResult<bool> {
    match controller.respond_to_pairing(&request_id, allowed) {
        Ok(found) => ApiResult::ok(found),
        Err(error) => map_err(error),
    }
}

#[tauri::command]
pub fn bridge_devices(controller: State<'_, BridgeController>) -> ApiResult<Vec<BridgeDevice>> {
    match controller.devices() {
        Ok(devices) => ApiResult::ok(devices),
        Err(error) => map_err(error),
    }
}

#[tauri::command]
pub fn bridge_revoke_device(
    controller: State<'_, BridgeController>,
    device_id: String,
) -> ApiResult<bool> {
    if device_id.trim().is_empty() {
        return map_err(AppError::message("device ID is required"));
    }
    match controller.revoke_device(&device_id) {
        Ok(revoked) => ApiResult::ok(revoked),
        Err(error) => map_err(error),
    }
}
