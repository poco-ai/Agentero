//! App settings commands — durable XDG config file.
//!
//! `settings_set` is schema-agnostic: validate proxy → persist → broadcast.
//! Domain reactions (connector port rebind, agent proxy, import parser
//! refresh, jobs layout cap) subscribe via [`AppSettingsStore::subscribe`]
//! at app assembly, so this feature imports no other domain.

use super::openreview_account;
use crate::core::error::{map_err, ApiResult};
use crate::features::system::settings::{AppSettings, AppSettingsStore, SettingsGetResult};
use agentero_core::features::paper::import::institution_proxy::{
    probe_institution_proxy, InstitutionProxyKind, InstitutionProxyPreset, InstitutionProxyProbe,
};
use agentero_core::features::paper::import::{openreview, web_verify};
use futures_util::future::BoxFuture;
use tauri::{AppHandle, Emitter, Manager, State, Url, WebviewUrl, WebviewWindowBuilder};

const OPENREVIEW_ACCOUNT_WINDOW: &str = "openreview-account-login";
const OPENREVIEW_LOGIN_URL: &str = "https://openreview.net/login";
/// One window serves every site's verification wall: it is re-navigated when a
/// different site asks for verification while it is open.
const VERIFICATION_WINDOW: &str = "site-verification";
/// OpenReview challenge gate. It covers both paths past the check: anonymous
/// visitors solve the Turnstile widget, account holders take "Sign in".
const OPENREVIEW_CHALLENGE_URL: &str = "https://openreview.net/challenge?redirect=%2F";
/// How often the verification window's cookie jar is polled.
const VERIFICATION_POLL: std::time::Duration = std::time::Duration::from_secs(2);
/// Budget for a verification window opened by a download that hit the bot
/// challenge: a background import must not hang on an ignored window for the
/// whole asset-download budget.
const VERIFICATION_AUTO_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

fn proxy_login_window_label(kind: InstitutionProxyKind, prefix: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    format!("{kind:?}:{prefix}").hash(&mut hash);
    format!("institution-proxy-login-{:x}", hash.finish())
}

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
    let prefix = prefix.trim().trim_end_matches('/').to_string();
    let url = proxy_gateway_url(&prefix)?;
    let Some((kind, saved_prefix, _)) = app.state::<AppSettingsStore>().institution_proxy() else {
        return Err("institution proxy is not configured".into());
    };
    if saved_prefix != prefix {
        return Err("institution proxy setting changed; reopen the login window".into());
    }
    let login_url = if prefix.ends_with('=') {
        proxy_gateway_url(&format!(
            "{}{}",
            prefix,
            urlencoding::encode("https://doi.org/10.1038/nature12373")
        ))?
    } else {
        url.clone()
    };
    let title = login_url.host_str().unwrap_or_default().to_string();
    let label = proxy_login_window_label(kind, &prefix);
    if let Some(window) = app.get_webview_window(&label) {
        #[cfg(desktop)]
        window.unminimize().map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(false);
    }
    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(login_url))
        .title(title)
        .inner_size(1000.0, 750.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(monitor_institution_login(app, window, kind, prefix, url).await)
}

async fn monitor_institution_login(
    app: AppHandle,
    window: tauri::WebviewWindow,
    kind: InstitutionProxyKind,
    prefix: String,
    cookie_url: Url,
) -> bool {
    use std::time::{Duration, Instant};

    let mut last_cookie = String::new();
    let mut last_attempt = None;
    let mut interval = tokio::time::interval(Duration::from_secs(2));
    loop {
        interval.tick().await;
        let store = app.state::<AppSettingsStore>();
        if !store
            .institution_proxy()
            .is_some_and(|(saved_kind, saved_prefix, _)| {
                saved_kind == kind && saved_prefix == prefix
            })
        {
            let _ = window.close();
            return false;
        }
        let url = cookie_url.clone();
        let login_window = window.clone();
        let captured = tauri::async_runtime::spawn_blocking(move || {
            login_window.url().ok()?;
            Some(
                login_window
                    .cookies_for_url(url)
                    .ok()?
                    .into_iter()
                    .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
                    .collect::<Vec<_>>()
                    .join("; "),
            )
        })
        .await;
        let Ok(Some(cookie)) = captured else {
            return false;
        };
        if cookie.is_empty()
            || cookie == last_cookie
                && last_attempt.is_some_and(|at: Instant| at.elapsed() < Duration::from_secs(10))
        {
            continue;
        }
        last_cookie = cookie.clone();
        last_attempt = Some(Instant::now());
        if probe_institution_proxy(kind, &prefix, &cookie)
            .await
            .is_err()
        {
            continue;
        }
        let Ok(Some(settings)) = store.update_institution_proxy_cookie(kind, &prefix, cookie)
        else {
            continue;
        };
        let _ = app.emit("settings:changed", settings);
        let _ = window.close();
        return true;
    }
}

/// URL to show in the verification window. An automatic request shows the very
/// page that was blocked — the wall is answered on that page, and the user sees
/// what they are waiting for. With no target, open OpenReview's challenge gate.
fn verification_url(target: Option<&str>) -> Url {
    if let Some(url) = target.and_then(|value| Url::parse(value).ok()) {
        if matches!(url.scheme(), "http" | "https") && url.host_str().is_some() {
            return url;
        }
    }
    Url::parse(OPENREVIEW_CHALLENGE_URL).expect("constant challenge URL parses")
}

fn is_openreview_url(url: &Url) -> bool {
    url.host_str().is_some_and(openreview::is_openreview_host)
}

/// Captured cookies that belong to the verified `host` (subdomains included);
/// expired entries and analytics ids are dropped.
fn site_cookie_header(cookies: &[tauri::webview::Cookie<'static>], host: &str) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or_default();
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    cookies
        .iter()
        .filter(|cookie| {
            let domain = cookie
                .domain()
                .unwrap_or_default()
                .trim_matches('.')
                .to_ascii_lowercase();
            if domain.is_empty()
                || !(domain == host
                    || host.ends_with(&format!(".{domain}"))
                    || domain.ends_with(&format!(".{host}")))
            {
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

/// Probe the blocked URL with a bounded response prefix. OpenReview's
/// challenge page uses a public forum probe when there is no target PDF.
async fn verify_cookie(url: &Url, cookie: &str, require_pdf: bool) -> bool {
    if require_pdf {
        return web_verify::probe_pdf_cookie(url.as_str(), cookie).await;
    }
    if is_openreview_url(url) && url.path() == "/challenge" {
        return openreview::probe_openreview_auth(cookie).await.is_ok();
    }
    web_verify::probe_cookie(url.as_str(), cookie).await
}

/// Use the official sign-in page, including any MFA required by the account.
#[tauri::command]
#[specta::specta]
pub async fn openreview_auth_login_open(app: AppHandle) -> Result<bool, String> {
    let url = Url::parse(OPENREVIEW_LOGIN_URL).expect("constant login URL");
    if !open_verification_window(&app, OPENREVIEW_ACCOUNT_WINDOW, &url) {
        return Err("Could not open the OpenReview login window".into());
    }
    let mut interval = tokio::time::interval(VERIFICATION_POLL);
    loop {
        interval.tick().await;
        let Some(window) = app.get_webview_window(OPENREVIEW_ACCOUNT_WINDOW) else {
            return Ok(false);
        };
        let cookies = match tauri::async_runtime::spawn_blocking(move || window.cookies()).await {
            Ok(Ok(cookies)) => cookies,
            _ => continue,
        };
        let result = openreview_account::capture(&cookies).await;
        if result != Ok(false) {
            if let Some(window) = app.get_webview_window(OPENREVIEW_ACCOUNT_WINDOW) {
                let _ = window.close();
            }
            return result;
        }
    }
}

/// Return the expiry of the account session for the Settings indicator.
#[tauri::command]
#[specta::specta]
pub async fn openreview_account_expiry() -> Option<i64> {
    openreview_account::session_expiry().await
}

/// Verify a download URL selected from the paper catalog.
pub(crate) async fn verify_openreview_pdf(app: AppHandle, url: Url) -> bool {
    static INTERACTIVE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = INTERACTIVE.lock().await;
    if openreview::probe_account_pdf(url.as_str()).await {
        return true;
    }
    if let Some(cookie) = openreview::cookie_header_for(url.as_str()) {
        if verify_cookie(&url, &cookie, true).await {
            return true;
        }
    }
    verify_window(app, Some(url.into()), Some(VERIFICATION_AUTO_TIMEOUT), true).await
}

/// Shared entry for the Settings button and the challenge hook. `target` is
/// the blocked URL (automatic case); `timeout` bounds the automatic wait so a
/// background import never hangs on an ignored window. Async is required when
/// creating a window from WebView2 on Windows.
async fn verify_window(
    app: AppHandle,
    target: Option<String>,
    timeout: Option<std::time::Duration>,
    require_pdf: bool,
) -> bool {
    let target = verification_url(target.as_deref());
    // API attachment endpoints return JSON when challenged. The verification
    // window must navigate to the site's HTML challenge page in that case.
    let window_url = if require_pdf {
        verification_url(None)
    } else {
        target.clone()
    };
    if !open_verification_window(&app, VERIFICATION_WINDOW, &window_url) {
        return false;
    }
    monitor_verification(app, target, timeout, require_pdf).await
}

fn open_verification_window(app: &AppHandle, label: &str, url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    if let Some(window) = app.get_webview_window(label) {
        // Do not reload another request's verification on the same site.
        let same_site = window
            .url()
            .is_ok_and(|current| current.host_str() == Some(host));
        if !same_site {
            let _ = window.navigate(url.clone());
        }
        let _ = window.set_focus();
        return true;
    }
    WebviewWindowBuilder::new(app, label, WebviewUrl::External(url.clone()))
        .title(host)
        .inner_size(1000.0, 750.0)
        .build()
        .is_ok()
        || app.get_webview_window(label).is_some()
}

async fn monitor_verification(
    app: AppHandle,
    target: Url,
    timeout: Option<std::time::Duration>,
    require_pdf: bool,
) -> bool {
    use std::time::Instant;

    let Some(host) = target.host_str().map(str::to_string) else {
        return false;
    };
    let started = Instant::now();
    let mut last_probe: Option<String> = None;
    let mut last_account: Option<String> = None;
    let mut interval = tokio::time::interval(VERIFICATION_POLL);
    loop {
        interval.tick().await;
        if timeout.is_some_and(|limit| started.elapsed() > limit) {
            if let Some(window) = app.get_webview_window(VERIFICATION_WINDOW) {
                let _ = window.close();
            }
            return false;
        }
        let Some(window) = app.get_webview_window(VERIFICATION_WINDOW) else {
            return false;
        };
        let cookies = match tauri::async_runtime::spawn_blocking(move || window.cookies()).await {
            Ok(Ok(cookies)) => cookies,
            _ => continue,
        };
        let is_openreview = is_openreview_url(&target);
        if is_openreview && require_pdf {
            if let Some(access) = openreview_account::access_cookie(&cookies) {
                if last_account.as_deref() != Some(access) {
                    last_account = Some(access.to_owned());
                    if openreview_account::capture(&cookies).await == Ok(true)
                        && openreview::probe_account_pdf(target.as_str()).await
                    {
                        if let Some(window) = app.get_webview_window(VERIFICATION_WINDOW) {
                            let _ = window.close();
                        }
                        return true;
                    }
                }
            }
        }
        let mut cookie = site_cookie_header(&cookies, &host);
        if is_openreview {
            cookie = openreview::verification_cookies(&cookie);
        }
        if cookie.is_empty() || last_probe.as_deref() == Some(cookie.as_str()) {
            continue;
        }
        last_probe = Some(cookie.clone());
        // Interstitials set unrelated cookies of their own; only a probe that
        // reaches the site's content proves the credential.
        if !verify_cookie(&target, &cookie, require_pdf).await {
            continue;
        }
        // The same captured cookie has to be visible to the download and
        // page-snapshot layers, and every opened window: the session map holds
        // it for any site, and OpenReview keeps its durable Settings row.
        web_verify::set_site_cookie(target.as_str(), &cookie);
        if is_openreview {
            let expires_at = openreview::credential_expiry(&cookie).unwrap_or(0);
            let store = app.state::<AppSettingsStore>();
            let Ok(Some(settings)) = store.update_openreview_auth(cookie, expires_at) else {
                continue;
            };
            let _ = app.emit("settings:changed", settings);
        }
        if let Some(window) = app.get_webview_window(VERIFICATION_WINDOW) {
            let _ = window.close();
        }
        return true;
    }
}

/// Install the core verification hook: a download or page fetch that hits an
/// interactive wall opens the verification window on that URL (bounded by
/// [`VERIFICATION_AUTO_TIMEOUT`]), and the request retries once with the
/// captured cookie. Without a Host (headless CLI) the operation fails with a
/// readable "verification required" reason instead.
pub fn install_web_verification_hook(app: AppHandle) {
    openreview::install_access_token_provider(openreview_account::access_token);
    web_verify::install_auth_requester(move |url| -> BoxFuture<'static, Option<String>> {
        let app = app.clone();
        Box::pin(async move {
            let target = Some(url.clone());
            let _ = verify_window(app, target, Some(VERIFICATION_AUTO_TIMEOUT), false).await;
            // A concurrent waiter may have completed the same window; the
            // stored credential is the shared outcome either way.
            openreview::cookie_header_for(&url).or_else(|| web_verify::cookie_header_for(&url))
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

/// Verify access to the preset's campus page or the default publisher PDF.
#[tauri::command]
#[specta::specta]
pub async fn institution_proxy_probe(app: AppHandle) -> ApiResult<InstitutionProxyProbe> {
    let store = app.state::<AppSettingsStore>();
    let Some((kind, prefix, cookie)) = store.institution_proxy() else {
        return ApiResult::err(agentero_core::error::AppError::message(
            "prefix not configured",
        ));
    };
    match probe_institution_proxy(kind, &prefix, &cookie).await {
        Ok(probe) => ApiResult::ok(probe),
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
