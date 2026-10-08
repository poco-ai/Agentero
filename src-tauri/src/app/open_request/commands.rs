use crate::core::error::ApiResult;

use super::{PendingUiRequest, PendingVaultOpen, UiRequestPayload};

/// Take the pending open path (startup race: frontend ready after Host queued).
#[tauri::command]
#[specta::specta]
pub fn vault_open_take_pending(
    state: tauri::State<'_, PendingVaultOpen>,
) -> ApiResult<Option<String>> {
    ApiResult::ok(state.take())
}

/// Take the pending UI action request (startup race for `ui:request`).
#[tauri::command]
#[specta::specta]
pub fn ui_request_take_pending(
    state: tauri::State<'_, PendingUiRequest>,
) -> ApiResult<Option<UiRequestPayload>> {
    ApiResult::ok(state.take())
}
