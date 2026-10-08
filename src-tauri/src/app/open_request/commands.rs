use crate::core::error::ApiResult;

use super::{PaperOpenPayload, PendingPaperOpen, PendingVaultOpen};

/// Take the pending open path (startup race: frontend ready after Host queued).
#[tauri::command]
#[specta::specta]
pub fn vault_open_take_pending(
    state: tauri::State<'_, PendingVaultOpen>,
) -> ApiResult<Option<String>> {
    ApiResult::ok(state.take())
}

/// Take the pending paper-open request (startup race for `paper:open-request`).
#[tauri::command]
#[specta::specta]
pub fn paper_open_take_pending(
    state: tauri::State<'_, PendingPaperOpen>,
) -> ApiResult<Option<PaperOpenPayload>> {
    ApiResult::ok(state.take())
}
