//! App settings commands — durable XDG config file.
//!
//! `settings_set` is schema-agnostic: validate proxy → persist → broadcast.
//! Domain reactions (connector port rebind, agent proxy, import parser
//! refresh, jobs layout cap) subscribe via [`AppSettingsStore::subscribe`]
//! at app assembly, so this feature imports no other domain.

use crate::core::error::{map_err, ApiResult};
use crate::features::system::settings::{AppSettings, AppSettingsStore, SettingsGetResult};
use agentero_core::features::paper::import::institution_proxy::InstitutionProxyPreset;
use agentero_core::features::paper::import::openreview;
use futures_util::future::BoxFuture;
use tauri::{AppHandle, Emitter, Manager, State, Url, WebviewUrl, WebviewWindowBuilder};

const PROXY_LOGIN_WINDOW: &str = "institution-proxy-login";
const OPENREVIEW_LOGIN_WINDOW: &str = "openreview-login";
const OPENREVIEW_ORIGIN: &str = "https://openreview.net/";
/// How often the verification window's cookie jar is polled.
const OPENREVIEW_POLL: std::time::Duration = std::time::Duration::from_secs(2);
/// Budget for a verification window opened by a download that hit the bot
/// challenge: a background import must not hang on an ignored window for the
/// whole asset-download budget.
const OPENREVIEW_AUTO_VERIFY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

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

/// Challenge URL that covers both ways past OpenReview's bot check: anonymous
/// visitors solve the Turnstile widget, signed-in users take the "Sign in"
/// link. Verification lands on the challenged paper's forum page.
fn openreview_challenge_url(target: Option<&str>) -> Url {
    let redirect = target
        .and_then(openreview_forum_page)
        .unwrap_or_else(|| OPENREVIEW_ORIGIN.to_string());
    let challenge = format!(
        "https://openreview.net/challenge?redirect={}",
        urlencoding::encode(&redirect)
    );
    Url::parse(&challenge).unwrap_or_else(|_| Url::parse(OPENREVIEW_ORIGIN).expect("origin parses"))
}

/// Readable OpenReview page for a challenged request: the paper's forum page
/// for `/pdf?id=…` / `/attachment?id=…`, the page itself for a forum URL, or
/// the site root when the target is not a page the window can show.
fn openreview_forum_page(target: &str) -> Option<String> {
    let url = Url::parse(target).ok()?;
    if !url.host_str().is_some_and(openreview::is_openreview_host) {
        return None;
    }
    if url.path().starts_with("/forum") {
        return Some(url.to_string());
    }
    let id = url
        .query_pairs()
        .find(|(key, _)| key == "id")
        .map(|(_, value)| value.into_owned())?;
    Some(format!(
        "https://openreview.net/forum?id={}",
        urlencoding::encode(&id)
    ))
}

/// Sendable `Cookie` header from the verification window's jar: OpenReview
/// cookies only (the window also visits Cloudflare and analytics hosts),
/// without expired entries. Analytics ids are dropped instead of persisting
/// tracking state in `settings.json`.
fn openreview_cookie_header(cookies: &[tauri::webview::Cookie<'static>]) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or_default();
    cookies
        .iter()
        .filter(|cookie| {
            let domain = cookie.domain().unwrap_or_default().trim_start_matches('.');
            if !openreview::is_openreview_host(domain) {
                return false;
            }
            let name = cookie.name();
            if ["_ga", "_gid", "_fb", "_hj", "__utm"]
                .iter()
                .any(|prefix| name.starts_with(prefix))
            {
                return false;
            }
            cookie
                .expires_datetime()
                .is_none_or(|expiry| expiry.unix_timestamp() > now)
        })
        .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
        .collect::<Vec<_>>()
        .join("; ")
}

/// Open (or focus) the OpenReview verification window and wait until a
/// captured cookie passes the challenge probe. Resolves when the window closes
/// or a working credential was saved; `true` when it was saved. Async is
/// required when creating a window from WebView2 on Windows.
#[tauri::command]
#[specta::specta]
pub async fn openreview_auth_login_open(app: AppHandle) -> Result<bool, String> {
    Ok(openreview_verify_window(app, None, None).await)
}

/// Shared entry for the Settings button and the download challenge hook.
/// `timeout` bounds the wait for the automatic (background-import) case; the
/// manual command waits until the user closes the window.
async fn openreview_verify_window(
    app: AppHandle,
    target: Option<String>,
    timeout: Option<std::time::Duration>,
) -> bool {
    let login_url = openreview_challenge_url(target.as_deref());
    if let Some(window) = app.get_webview_window(OPENREVIEW_LOGIN_WINDOW) {
        // Never reload a window the user is already working in: concurrent
        // challenged downloads share one verification flow, and navigation
        // mid-challenge would restart the Turnstile widget.
        let _ = window.set_focus();
    } else {
        let created = WebviewWindowBuilder::new(
            &app,
            OPENREVIEW_LOGIN_WINDOW,
            WebviewUrl::External(login_url),
        )
        .title("OpenReview")
        .inner_size(1000.0, 750.0)
        .build();
        // A concurrent caller may have created the label first; that window
        // is still usable.
        if created.is_err() && app.get_webview_window(OPENREVIEW_LOGIN_WINDOW).is_none() {
            return false;
        }
    }
    monitor_openreview_login(app, timeout).await
}

async fn monitor_openreview_login(app: AppHandle, timeout: Option<std::time::Duration>) -> bool {
    use std::time::Instant;

    let started = Instant::now();
    let mut last_probe: Option<String> = None;
    let mut interval = tokio::time::interval(OPENREVIEW_POLL);
    loop {
        interval.tick().await;
        if timeout.is_some_and(|limit| started.elapsed() > limit) {
            if let Some(window) = app.get_webview_window(OPENREVIEW_LOGIN_WINDOW) {
                let _ = window.close();
            }
            return false;
        }
        let Some(window) = app.get_webview_window(OPENREVIEW_LOGIN_WINDOW) else {
            return false;
        };
        let cookies = match tauri::async_runtime::spawn_blocking(move || window.cookies()).await {
            Ok(Ok(cookies)) => cookies,
            _ => continue,
        };
        let cookie = openreview_cookie_header(&cookies);
        if cookie.is_empty() || last_probe.as_deref() == Some(cookie.as_str()) {
            continue;
        }
        last_probe = Some(cookie.clone());
        // The challenge page itself sets unrelated cookies; only a probe that
        // reaches OpenReview without the Turnstile page proves the credential.
        if openreview::probe_openreview_auth(&cookie).await.is_err() {
            continue;
        }
        let expires_at = openreview::credential_expiry(&cookie).unwrap_or(0);
        let store = app.state::<AppSettingsStore>();
        let Ok(Some(settings)) = store.update_openreview_auth(cookie, expires_at) else {
            continue;
        };
        let _ = app.emit("settings:changed", settings);
        if let Some(window) = app.get_webview_window(OPENREVIEW_LOGIN_WINDOW) {
            let _ = window.close();
        }
        return true;
    }
}

/// Install the core download hook: a PDF request that hits OpenReview's bot
/// challenge opens this verification window (bounded by
/// [`OPENREVIEW_AUTO_VERIFY_TIMEOUT`]), then the request retries once with the
/// captured cookie. Without this hook (headless CLI) the download fails with a
/// readable "verification required" reason.
pub fn install_openreview_auth_hook(app: AppHandle) {
    openreview::install_auth_requester(move |target| -> BoxFuture<'static, Option<String>> {
        let app = app.clone();
        Box::pin(async move {
            let _ =
                openreview_verify_window(app, target, Some(OPENREVIEW_AUTO_VERIFY_TIMEOUT)).await;
            // A concurrent waiter may have completed the same window; the
            // stored credential is the shared outcome either way.
            openreview::openreview_cookie()
        })
    });
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
///
/// `async` is deliberate. A synchronous `#[tauri::command]` runs inside the
/// WebView2 interface-thread IPC callback, and this path rewrites
/// `settings.json` and fans out to every subscriber on each edit. Keep the
/// `AppHandle` argument rather than `State<'_, _>`: an async command cannot
/// borrow the invoke context.
#[tauri::command]
#[specta::specta]
pub async fn settings_set(app: AppHandle, settings: AppSettings) -> ApiResult<AppSettings> {
    let store = app.state::<AppSettingsStore>();
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
