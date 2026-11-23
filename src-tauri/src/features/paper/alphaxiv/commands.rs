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

#[cfg(not(any(target_os = "ios", target_os = "android")))]
#[tauri::command]
#[specta::specta]
pub async fn alphaxiv_prepare_notes(
    app: AppHandle,
    vault_path: String,
    path: String,
    paper_group_id: String,
    arxiv_id: String,
) -> ApiResult<Vec<alphaxiv::notes::import::ImportedReadingRecord>> {
    use agentero_core::features::paper::{capabilities, catalog::papers};
    use agentero_core::features::scholar_api::identifiers::extract_arxiv_id;
    use agentero_core::fs::{resolve_paper_dir, resolve_vault};

    let result = async {
        let key = app
            .state::<AppSettingsStore>()
            .alphaxiv_api_key()
            .ok_or_else(|| {
                AppError::domain("alphaxiv_key_missing", "AlphaXiv API key is not set")
            })?;
        let group = uuid::Uuid::parse_str(&paper_group_id)
            .map_err(|_| AppError::domain("alphaxiv_parse", "Missing AlphaXiv paper group ID"))?;
        let arxiv_id =
            extract_arxiv_id(&arxiv_id).ok_or_else(|| AppError::message("Invalid arXiv ID"))?;
        let vault = resolve_vault(&vault_path)?;
        let (dir, rel) = resolve_paper_dir(&vault, &path)?;
        let paper = papers::get_by_path(&vault, &rel)?
            .ok_or_else(|| AppError::message("Paper not found in the library"))?;
        let matches = paper
            .arxiv_id
            .as_deref()
            .and_then(extract_arxiv_id)
            .is_some_and(|id| id.eq_ignore_ascii_case(&arxiv_id));
        if !matches {
            return Err(AppError::message(
                "The library paper does not match the AlphaXiv paper",
            ));
        }
        let notes = alphaxiv::notes::fetch_paper_notes(&key, group).await?;
        tauri::async_runtime::spawn_blocking(move || {
            let pdf = if notes
                .highlights
                .iter()
                .any(|item| matches!(item.anchor, alphaxiv::notes::HighlightAnchor::Pdf { .. }))
            {
                capabilities::find_local_pdf(&dir)
                    .map(std::fs::read)
                    .transpose()?
            } else {
                None
            };
            Ok(alphaxiv::notes::import::prepare_import(
                notes,
                group,
                &arxiv_id,
                pdf.as_deref(),
            ))
        })
        .await
        .map_err(|_| AppError::message("AlphaXiv annotation conversion failed"))?
    }
    .await;
    match result {
        Ok(records) => ApiResult::ok(records),
        Err(error) => ApiResult::err(error),
    }
}
