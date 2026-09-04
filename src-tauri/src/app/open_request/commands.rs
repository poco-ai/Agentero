use crate::core::error::ApiResult;

use super::PendingVaultOpen;

/// Take the pending open path (startup race: frontend ready after Host queued).
#[tauri::command]
pub fn vault_open_take_pending(
    state: tauri::State<'_, PendingVaultOpen>,
) -> ApiResult<Option<String>> {
    ApiResult::ok(state.take())
}
