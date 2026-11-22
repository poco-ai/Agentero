//! AlphaXiv key and folder commands. The key is never logged.

use agentero_core::error::AppError;
use agentero_core::features::paper::alphaxiv::{self, AlphaXivAccount, AlphaXivFolder};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::core::error::ApiResult;
use crate::features::system::settings::{is_translate_api_key_mask, AppSettings, AppSettingsStore};

/// Settings snapshot after a successful key save. `settings.alphaxiv.apiKey`
/// is masked. `account` has no profile: API keys cannot read `GET /users/v3`.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AlphaXivSaveResult {
    pub settings: AppSettings,
    pub account: AlphaXivAccount,
}

fn resolve_probe_key(store: &AppSettingsStore, api_key: &str) -> Result<String, AppError> {
    let trimmed = api_key.trim();
    if trimmed.is_empty() || is_translate_api_key_mask(trimmed) {
        return store.alphaxiv_api_key().ok_or_else(|| {
            AppError::domain("alphaxiv_key_missing", "AlphaXiv API key is not set")
        });
    }
    alphaxiv::normalize_api_key(trimmed)
}

fn emit_settings(app: &AppHandle, settings: &AppSettings) {
    let _ = app.emit("settings:changed", settings);
}

/// Check an AlphaXiv API key with `GET /folders/v3` without saving it.
/// An empty value or a mask rechecks the key already stored in Host settings.
#[tauri::command]
#[specta::specta]
pub async fn alphaxiv_test_key(app: AppHandle, api_key: String) -> ApiResult<AlphaXivAccount> {
    let store = app.state::<AppSettingsStore>();
    let key = match resolve_probe_key(&store, &api_key) {
        Ok(key) => key,
        Err(err) => return ApiResult::err(err),
    };
    match alphaxiv::fetch_account(&key).await {
        Ok(account) => ApiResult::ok(account),
        Err(err) => ApiResult::err(err),
    }
}

/// Validate a pasted AlphaXiv API key with `GET /folders/v3`, then store it.
/// The returned settings snapshot masks the key. A failed check stores nothing.
#[tauri::command]
#[specta::specta]
pub async fn alphaxiv_save_key(app: AppHandle, api_key: String) -> ApiResult<AlphaXivSaveResult> {
    let key = match alphaxiv::normalize_api_key(&api_key) {
        Ok(key) => key,
        Err(err) => return ApiResult::err(err),
    };
    let account = match alphaxiv::fetch_account(&key).await {
        Ok(account) => account,
        Err(err) => return ApiResult::err(err),
    };
    let store = app.state::<AppSettingsStore>();
    match store.update_alphaxiv_auth(
        key,
        account.username.clone(),
        account.email.clone(),
        account.real_name.clone(),
    ) {
        Ok(settings) => {
            emit_settings(&app, &settings);
            ApiResult::ok(AlphaXivSaveResult { settings, account })
        }
        Err(err) => ApiResult::err(err),
    }
}

/// Remove the stored AlphaXiv API key and the saved profile.
#[tauri::command]
#[specta::specta]
pub async fn alphaxiv_clear_key(app: AppHandle) -> ApiResult<AppSettings> {
    let store = app.state::<AppSettingsStore>();
    match store.clear_alphaxiv_auth() {
        Ok(settings) => {
            emit_settings(&app, &settings);
            ApiResult::ok(settings)
        }
        Err(err) => ApiResult::err(err),
    }
}

/// List the signed-in user's AlphaXiv folders. Each folder already includes
/// its papers. Uses the stored key only.
#[tauri::command]
#[specta::specta]
pub async fn alphaxiv_list_folders(app: AppHandle) -> ApiResult<Vec<AlphaXivFolder>> {
    let store = app.state::<AppSettingsStore>();
    let Some(key) = store.alphaxiv_api_key() else {
        return ApiResult::err(AppError::domain(
            "alphaxiv_key_missing",
            "AlphaXiv API key is not set",
        ));
    };
    match alphaxiv::fetch_folders(&key).await {
        Ok(folders) => ApiResult::ok(folders),
        Err(err) => ApiResult::err(err),
    }
}
