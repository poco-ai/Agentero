//! Local dictionary: no network, provider credentials, or Vault dependency.
use crate::core::error::{map_err, ApiResult, AppError};
use agentero_core::features::translate::lexicon::{self, DictionaryEntry};
use tauri::{AppHandle, Manager};

#[tauri::command]
#[specta::specta]
pub async fn dictionary_lookup(
    app: AppHandle,
    text: String,
    target_lang: String,
) -> ApiResult<Vec<DictionaryEntry>> {
    let path = match app.path().resource_dir() {
        Ok(dir) => dir.join("dictionary/lexicon.sqlite"),
        Err(e) => return map_err(AppError::message(e.to_string())),
    };
    let path = if cfg!(debug_assertions) && !path.exists() {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("dictionary/lexicon.sqlite")
    } else {
        path
    };
    match tauri::async_runtime::spawn_blocking(move || lexicon::lookup(&path, &text, &target_lang))
        .await
    {
        Ok(Ok(entries)) => ApiResult::ok(entries),
        Ok(Err(e)) => map_err(e),
        Err(e) => map_err(AppError::message(e.to_string())),
    }
}
