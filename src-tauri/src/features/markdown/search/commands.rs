//! Vault-wide full-text Markdown search (command palette "contents" tier).

use crate::core::blocking::run_blocking;
use crate::core::error::{map_err, ApiResult};
use crate::features::search::{self, VaultSearchArgs, VaultSearchResult};

/// Full-text search over the Vault's Markdown files. See `services::search`.
///
/// Async + `run_blocking`: the walk reads every Markdown file, which must not
/// run on the main thread (Windows UI message pump).
#[tauri::command]
pub async fn vault_search(args: VaultSearchArgs) -> ApiResult<VaultSearchResult> {
    run_blocking(move || match search::vault_search(args) {
        Ok(r) => ApiResult::ok(r),
        Err(e) => map_err(e),
    })
    .await
}
