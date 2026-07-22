//! Vault-wide full-text Markdown search (command palette "contents" tier).

use crate::error::AppError;
use crate::services::search::{self, VaultSearchArgs, VaultSearchResult};

/// Full-text search over the Vault's Markdown files. See `services::search`.
#[tauri::command]
pub fn vault_search(args: VaultSearchArgs) -> Result<VaultSearchResult, AppError> {
    search::vault_search(args)
}
