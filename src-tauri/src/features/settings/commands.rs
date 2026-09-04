//! App settings commands — durable XDG config file.
//!
//! `settings_set` is schema-agnostic: validate proxy → persist → broadcast.
//! Domain reactions (connector port rebind, agent proxy, import parser
//! refresh, jobs layout cap) subscribe via [`AppSettingsStore::subscribe`]
//! at app assembly, so this feature imports no other domain.

use crate::core::error::{map_err, ApiResult, AppError};
use crate::features::settings::{AppSettings, AppSettingsStore, SettingsGetResult};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
pub fn settings_get(store: State<'_, AppSettingsStore>) -> ApiResult<SettingsGetResult> {
    match store.get() {
        Ok(r) => ApiResult::ok(r),
        Err(e) => map_err(e),
    }
}

/// Detected OS system proxy (Windows "Internet Settings"). Host requests
/// already fall back to it when the app proxy is off; the updater plugin and
/// the settings UI query it here.
#[tauri::command]
pub fn network_system_proxy() -> ApiResult<Option<String>> {
    ApiResult::ok(crate::core::http::system_proxy_url())
}

/// Return unique system font family names (sorted). Empty on mobile / failure.
///
/// Scanning system fonts is slow (disk walk on Windows), so it runs in
/// `run_blocking` and the result is cached for the process lifetime — the
/// installed-font set does not change while the app is running.
#[tauri::command]
pub async fn list_system_fonts() -> ApiResult<Vec<String>> {
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        ApiResult::ok(Vec::new())
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        use crate::core::blocking::run_blocking;
        use std::sync::OnceLock;

        static FONTS: OnceLock<Vec<String>> = OnceLock::new();
        if let Some(names) = FONTS.get() {
            return ApiResult::ok(names.clone());
        }
        run_blocking(move || {
            let names = FONTS.get_or_init(|| {
                use std::collections::BTreeSet;
                let mut db = fontdb::Database::new();
                db.load_system_fonts();
                let mut names = BTreeSet::new();
                for face in db.faces() {
                    for (family, _) in &face.families {
                        let t = family.trim();
                        if !t.is_empty() {
                            names.insert(t.to_string());
                        }
                    }
                }
                names.into_iter().collect()
            });
            ApiResult::ok(names.clone())
        })
        .await
    }
}

/// Persist the full settings snapshot and broadcast `settings:changed`.
///
/// Domain side effects are not wired here: they run as
/// [`AppSettingsStore::subscribe`] listeners registered by the app assembly
/// (see `app/mod.rs`), fired inside `store.set` with the redacted snapshot.
#[tauri::command]
pub fn settings_set(
    app: AppHandle,
    store: State<'_, AppSettingsStore>,
    settings: AppSettings,
) -> ApiResult<AppSettings> {
    if let Err(e) = crate::core::http::configure_proxy(
        settings.network_proxy_enabled,
        &settings.network_proxy_url,
    ) {
        return map_err(e);
    }
    match store.set(settings) {
        Ok(s) => {
            // Keep every window's settings cache fresh (settings window, main windows).
            let _ = app.emit("settings:changed", &s);
            ApiResult::ok(s)
        }
        Err(e) => map_err(e),
    }
}

/// Probe the configured EasyScholar key by querying a stable journal.
/// Returns false when no key is configured, the request fails, or the API
/// rejects the key (non-200 / non-200 code).
#[tauri::command]
pub async fn easy_scholar_probe(app: AppHandle) -> ApiResult<bool> {
    use crate::scholar_api::sources::easy_scholar::EasyScholarApi;

    let store = app.state::<AppSettingsStore>();
    let Some(key) = store.easy_scholar_key() else {
        return ApiResult::ok(false);
    };
    let source = EasyScholarApi::new(key);
    let ok = match source.fetch_raw("Nature").await {
        Ok(json) => json
            .get("code")
            .and_then(|v| v.as_i64())
            .is_some_and(|code| code == 200),
        Err(_) => false,
    };
    ApiResult::ok(ok)
}

/// Query EasyScholar for a publication's rank data.
/// Returns the full API response so the WebView can extract `officialRank.all`
/// and build namespaced tags.
#[tauri::command]
pub async fn easy_scholar_get_rank(app: AppHandle, publication_name: String) -> ApiResult<Value> {
    use crate::scholar_api::sources::easy_scholar::EasyScholarApi;

    let store = app.state::<AppSettingsStore>();
    let Some(key) = store.easy_scholar_key() else {
        return map_err(AppError::domain(
            "easyScholarKeyMissing",
            "EasyScholar key is not configured.",
        ));
    };
    if publication_name.trim().is_empty() {
        return map_err(AppError::domain(
            "easyScholarEmptyPublication",
            "Publication name is empty.",
        ));
    }

    let source = EasyScholarApi::new(key);
    match source.fetch_raw(&publication_name).await {
        Ok(json) => {
            if json
                .get("code")
                .and_then(|v| v.as_i64())
                .is_some_and(|code| code == 200)
            {
                ApiResult::ok(json)
            } else {
                map_err(AppError::domain(
                    "easyScholarApiError",
                    "EasyScholar API returned an error response.",
                ))
            }
        }
        Err(e) => map_err(e.into()),
    }
}
