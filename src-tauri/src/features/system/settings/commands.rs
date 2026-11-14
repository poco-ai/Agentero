//! App settings commands — durable XDG config file.
//!
//! `settings_set` is schema-agnostic: validate proxy → persist → broadcast.
//! Domain reactions (connector port rebind, agent proxy, import parser
//! refresh, jobs layout cap) subscribe via [`AppSettingsStore::subscribe`]
//! at app assembly, so this feature imports no other domain.

use crate::core::error::{map_err, ApiResult};
use crate::features::system::settings::{AppSettings, AppSettingsStore, SettingsGetResult};
use agentero_core::features::paper::import::institution_proxy::InstitutionProxyPreset;
use tauri::{AppHandle, Emitter, Manager, State, Url, WebviewUrl, WebviewWindowBuilder};

const PROXY_LOGIN_WINDOW: &str = "institution-proxy-login";

fn proxy_gateway_url(prefix: &str) -> Result<Url, String> {
    let url = Url::parse(prefix.trim()).map_err(|e| e.to_string())?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("institution proxy must be an HTTPS gateway URL".into());
    }
    Ok(url)
}

/// Open the configured gateway in a dedicated webview for interactive SSO.
/// Async is required when creating a window from WebView2 on Windows.
/// Resolves once the login window closes; `true` when a cookie was captured.
#[tauri::command]
#[specta::specta]
pub async fn institution_proxy_login_open(app: AppHandle, prefix: String) -> Result<bool, String> {
    let url = proxy_gateway_url(&prefix)?;
    let login_url = if prefix.trim_end().ends_with('=') {
        proxy_gateway_url(&format!(
            "{}{}",
            prefix.trim(),
            urlencoding::encode("https://doi.org/10.1038/nature12373")
        ))?
    } else {
        url
    };
    let title = login_url.host_str().unwrap_or_default().to_string();
    if let Some(window) = app.get_webview_window(PROXY_LOGIN_WINDOW) {
        window.navigate(login_url).map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    } else {
        WebviewWindowBuilder::new(&app, PROXY_LOGIN_WINDOW, WebviewUrl::External(login_url))
            .title(title)
            .inner_size(1000.0, 750.0)
            .build()
            .map_err(|e| e.to_string())?;
    }
    Ok(monitor_institution_login(app, prefix.trim().to_string()).await)
}

async fn monitor_institution_login(app: AppHandle, prefix: String) -> bool {
    use agentero_core::features::paper::import::institution_proxy::probe_institution_proxy;
    use std::time::Duration;

    let gateway_url = match proxy_gateway_url(&prefix) {
        Ok(url) => url,
        Err(_) => return false,
    };
    let mut last_cookie = app
        .state::<AppSettingsStore>()
        .institution_proxy()
        .map(|(_, _, cookie)| cookie)
        .unwrap_or_default();
    let mut interval = tokio::time::interval(Duration::from_secs(2));
    loop {
        interval.tick().await;
        let Some(window) = app.get_webview_window(PROXY_LOGIN_WINDOW) else {
            return false;
        };
        let url = gateway_url.clone();
        let cookie =
            match tauri::async_runtime::spawn_blocking(move || window.cookies_for_url(url)).await {
                Ok(Ok(cookies)) => cookies
                    .into_iter()
                    .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
                    .collect::<Vec<_>>()
                    .join("; "),
                _ => continue,
            };
        if cookie.is_empty() || cookie == last_cookie {
            continue;
        }
        let store = app.state::<AppSettingsStore>();
        let Some((kind, saved_prefix, _)) = store.institution_proxy() else {
            continue;
        };
        if saved_prefix != prefix {
            continue;
        }
        last_cookie = cookie.clone();
        if probe_institution_proxy(kind, &prefix, &cookie)
            .await
            .is_err()
        {
            continue;
        }
        let Ok(Some(settings)) = store.update_institution_proxy_cookie(&prefix, cookie) else {
            continue;
        };
        let _ = app.emit("settings:changed", settings);
        if let Some(window) = app.get_webview_window(PROXY_LOGIN_WINDOW) {
            let _ = window.close();
        }
        return true;
    }
}

#[tauri::command]
#[specta::specta]
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
#[specta::specta]
pub fn network_system_proxy() -> ApiResult<Option<String>> {
    ApiResult::ok(crate::core::http::system_proxy_url())
}

/// Return unique system font family names (sorted). Empty on mobile / failure.
///
/// Scanning system fonts is slow (disk walk on Windows), so it runs in
/// `run_blocking` and the result is cached for the process lifetime — the
/// installed-font set does not change while the app is running.
#[tauri::command]
#[specta::specta]
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
#[specta::specta]
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

/// Built-in institution gateway presets for the settings quick-fill menu.
/// The registry lives in `agentero-core/.../institution_proxy/presets.json`;
/// exposing it here keeps the UI free of a duplicated address list.
#[tauri::command]
#[specta::specta]
pub fn institution_proxy_presets() -> ApiResult<Vec<InstitutionProxyPreset>> {
    ApiResult::ok(agentero_core::features::paper::import::institution_proxy::presets())
}

/// Probe the configured institution proxy (EZProxy/WebVPN) by fetching a
/// known paywalled DOI through the rewrite and checking the response is a
/// PDF. Returns a short human-readable result for the settings UI.
#[tauri::command]
#[specta::specta]
pub async fn institution_proxy_probe(app: AppHandle) -> ApiResult<String> {
    let store = app.state::<AppSettingsStore>();
    let Some((kind, prefix, cookie)) = store.institution_proxy() else {
        return ApiResult::err(agentero_core::error::AppError::message(
            "prefix not configured",
        ));
    };
    match agentero_core::features::paper::import::institution_proxy::probe_institution_proxy(
        kind, &prefix, &cookie,
    )
    .await
    {
        Ok((kind, n)) => ApiResult::ok(format!("ok ({n} bytes, {})", kind.as_str())),
        Err(e) => ApiResult::err(agentero_core::error::AppError::domain(
            if e.contains("authentication required") || e.contains("HTTP 401") {
                "institution_proxy_auth_required"
            } else {
                "institution_proxy_probe_failed"
            },
            e,
        )),
    }
}

/// Probe the configured EasyScholar key by querying a stable journal.
/// Returns false when no key is configured, the request fails, or the API
/// rejects the key (non-200 / non-200 code).
#[tauri::command]
#[specta::specta]
pub async fn easy_scholar_probe(app: AppHandle) -> ApiResult<bool> {
    use crate::features::paper::scholar_api::sources::easy_scholar::EasyScholarApi;

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
