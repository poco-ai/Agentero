//! Process-wide HTTP plumbing shared by Host features and the headless CLI:
//! proxy configuration, client factories, the product User-Agent, and
//! error-body truncation.

use crate::core::error::AppError;
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant};

/// Product User-Agent sent by Host HTTP clients by default.
///
/// The repo + mailto contacts keep Crossref / Semantic Scholar requests in
/// their polite pools.
pub const USER_AGENT: &str = concat!(
    "Agentero/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/poco-ai/agentero; mailto:agentero@users.noreply.github.com)"
);

/// Browser-like UA for endpoints that reject non-browser agents with HTTP 403
/// (PLOS / IEEE / Springer publisher PDFs, free web-MT endpoints). Use only
/// where a browser is deliberately impersonated; prefer [`USER_AGENT`]
/// everywhere else.
pub const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/// Redirect cap applied by [`client`] (reqwest's own default is 10).
pub const DEFAULT_REDIRECT_LIMIT: usize = 5;

/// How many chars of an HTTP error body [`http_err_snippet`] keeps.
const ERROR_SNIPPET_CHARS: usize = 180;

static PROXY_URL: OnceLock<RwLock<Option<String>>> = OnceLock::new();
static SHARED_CLIENT: OnceLock<RwLock<Option<CachedClient>>> = OnceLock::new();
/// (last detected OS system proxy, when it was checked). `None` timestamp =
/// never checked.
static SYSTEM_PROXY: OnceLock<RwLock<(Option<String>, Option<Instant>)>> = OnceLock::new();

/// The OS-level proxy can be toggled at runtime (Clash / V2RayN "system
/// proxy" mode); re-read it at most this often.
const SYSTEM_PROXY_TTL: Duration = Duration::from_secs(30);

struct CachedClient {
    proxy: Option<String>,
    client: reqwest::Client,
}

fn proxy_slot() -> &'static RwLock<Option<String>> {
    PROXY_URL.get_or_init(|| RwLock::new(None))
}

/// Configure the proxy used by every Host-created reqwest client.
pub fn configure_proxy(enabled: bool, url: &str) -> Result<(), AppError> {
    let normalized = url.trim().to_string();
    let next = if enabled {
        if normalized.is_empty() {
            return Err(AppError::message("network proxy URL is required"));
        }
        reqwest::Proxy::all(&normalized)
            .map_err(|e| AppError::message(format!("invalid network proxy URL: {e}")))?;
        Some(normalized)
    } else {
        None
    };

    let mut guard = proxy_slot()
        .write()
        .map_err(|_| AppError::message("network proxy lock poisoned"))?;
    *guard = next;
    drop(guard);
    if let Some(slot) = SHARED_CLIENT.get() {
        if let Ok(mut cached) = slot.write() {
            *cached = None;
        }
    }
    Ok(())
}

fn cached_slot() -> &'static RwLock<Option<CachedClient>> {
    SHARED_CLIENT.get_or_init(|| RwLock::new(None))
}

/// The OS-wide ("system") proxy, if one is configured. reqwest only honors
/// `HTTP_PROXY`-style env vars, so without this every Host request would
/// bypass the system proxy that browsers and WebView2 use — the classic
/// "browser works, app pages fail" split on Windows proxy clients.
pub fn system_proxy_url() -> Option<String> {
    #[cfg(windows)]
    {
        use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let key = hkcu
            .open_subkey_with_flags(
                r"Software\Microsoft\Windows\CurrentVersion\Internet Settings",
                KEY_READ,
            )
            .ok()?;
        let enabled: u32 = key.get_value("ProxyEnable").ok()?;
        if enabled == 0 {
            return None;
        }
        let server: String = key.get_value("ProxyServer").ok()?;
        parse_windows_proxy_server(&server)
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Parse the Windows `ProxyServer` registry value: either a bare `host:port`
/// or `http=host:port;https=host:port;socks=host:port`.
// Only called from the Windows branch + unit tests; keep it compiled (and
// tested) on every platform.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn parse_windows_proxy_server(server: &str) -> Option<String> {
    let trimmed = server.trim();
    if trimmed.is_empty() {
        return None;
    }
    if !trimmed.contains('=') {
        return Some(with_proxy_scheme(trimmed, "http"));
    }
    let mut http = None;
    let mut https = None;
    let mut socks = None;
    for part in trimmed.split(';') {
        let Some((kind, value)) = part.split_once('=') else {
            continue;
        };
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        match kind.trim().to_ascii_lowercase().as_str() {
            "http" => http = Some(value),
            "https" => https = Some(value),
            "socks" => socks = Some(value),
            _ => {}
        }
    }
    // The `http=`/`https=` keys name which traffic a proxy serves, not how the
    // proxy itself is reached — the proxy is contacted over plain HTTP (HTTPS
    // targets tunnel via CONNECT). So both map to an `http://` proxy URL;
    // returning `https://` would make reqwest TLS-handshake with a plain HTTP
    // proxy and fail. Prefer the `http=` entry, then `https=`.
    http.or(https)
        .map(|v| with_proxy_scheme(v, "http"))
        .or_else(|| socks.map(|v| with_proxy_scheme(v, "socks5h")))
}

#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn with_proxy_scheme(value: &str, default_scheme: &str) -> String {
    if value.contains("://") {
        value.to_string()
    } else {
        format!("{default_scheme}://{value}")
    }
}

/// TTL-cached [`system_proxy_url`] so request paths only touch the registry
/// every [`SYSTEM_PROXY_TTL`].
fn system_proxy_cached() -> Option<String> {
    let slot = SYSTEM_PROXY.get_or_init(|| RwLock::new((None, None)));
    if let Ok(guard) = slot.read() {
        if guard.1.is_some_and(|t| t.elapsed() < SYSTEM_PROXY_TTL) {
            return guard.0.clone();
        }
    }
    let detected = system_proxy_url();
    if let Ok(mut guard) = slot.write() {
        *guard = (detected.clone(), Some(Instant::now()));
    }
    detected
}

/// The proxy every Host-created client should use: the explicit setting when
/// enabled, otherwise the detected system proxy. Also the value forwarded to
/// Host-spawned subprocesses so in-app and CLI network behavior match.
pub fn effective_proxy_url() -> Option<String> {
    if let Ok(guard) = proxy_slot().read() {
        if guard.is_some() {
            return guard.clone();
        }
    }
    system_proxy_cached()
}

/// A process-wide reqwest client so TLS sessions and HTTP keep-alive survive
/// across plaza / Cool Papers requests. Rebuilt when the effective proxy
/// changes (explicit setting or detected system proxy).
pub fn shared_client() -> Result<reqwest::Client, AppError> {
    let proxy = effective_proxy_url();
    {
        let guard = cached_slot()
            .read()
            .map_err(|_| AppError::message("network client lock poisoned"))?;
        if let Some(cached) = guard.as_ref() {
            if cached.proxy == proxy {
                return Ok(cached.client.clone());
            }
        }
    }
    let client = client_builder()
        .pool_idle_timeout(Duration::from_secs(90))
        .pool_max_idle_per_host(8)
        .redirect(reqwest::redirect::Policy::limited(DEFAULT_REDIRECT_LIMIT))
        .build()
        .map_err(|e| AppError::message(format!("http client: {e}")))?;
    let mut guard = cached_slot()
        .write()
        .map_err(|_| AppError::message("network client lock poisoned"))?;
    if let Some(cached) = guard.as_ref() {
        if cached.proxy == proxy {
            return Ok(cached.client.clone());
        }
    }
    *guard = Some(CachedClient {
        proxy,
        client: client.clone(),
    });
    Ok(client)
}

/// Build a reqwest client builder with the current process-wide proxy.
///
/// Prefer [`client`] / [`client_with`]; reach for this directly only when a
/// flow must deviate from their defaults (e.g. no timeout at all).
pub fn client_builder() -> reqwest::ClientBuilder {
    let proxy = effective_proxy_url();
    let builder = reqwest::Client::builder();
    match proxy {
        Some(url) => match reqwest::Proxy::all(&url) {
            Ok(proxy) => builder.proxy(proxy),
            Err(error) => {
                log::error!(target: "agentero::network", "invalid configured proxy: {error}");
                builder
            }
        },
        None => builder,
    }
}

/// Standard Host HTTP client: [`USER_AGENT`], the configured proxy, `timeout`,
/// and at most [`DEFAULT_REDIRECT_LIMIT`] redirects.
pub fn client(timeout: Duration) -> Result<reqwest::Client, AppError> {
    client_with(timeout, DEFAULT_REDIRECT_LIMIT, USER_AGENT)
}

/// [`client`] with an explicit redirect cap and User-Agent — for deeper
/// redirect chains (model / asset downloads) or browser impersonation
/// ([`BROWSER_USER_AGENT`]).
pub fn client_with(
    timeout: Duration,
    redirect_limit: usize,
    user_agent: &str,
) -> Result<reqwest::Client, AppError> {
    client_builder()
        .timeout(timeout)
        .user_agent(user_agent)
        .redirect(reqwest::redirect::Policy::limited(redirect_limit))
        .build()
        .map_err(|e| AppError::message(format!("http client: {e}")))
}

/// First [`ERROR_SNIPPET_CHARS`] chars of an HTTP response body, for embedding
/// in error messages.
pub fn http_err_snippet(text: &str) -> String {
    text.chars().take(ERROR_SNIPPET_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_supported_proxy_urls() {
        for url in [
            "http://127.0.0.1:7890",
            "https://proxy.example.test:8443",
            "socks5h://127.0.0.1:1080",
        ] {
            configure_proxy(true, url).expect("proxy URL should be accepted");
        }
        configure_proxy(false, "").expect("proxy should be disabled");
    }

    #[test]
    fn rejects_enabled_empty_proxy() {
        let error = configure_proxy(true, " ").expect_err("empty proxy should fail");
        assert!(error.to_string().contains("proxy URL is required"));
    }

    #[test]
    fn parses_windows_proxy_server_forms() {
        assert_eq!(
            parse_windows_proxy_server("127.0.0.1:7890").as_deref(),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(
            parse_windows_proxy_server(
                "http=127.0.0.1:10809;https=127.0.0.1:10809;socks=127.0.0.1:10808"
            )
            .as_deref(),
            Some("http://127.0.0.1:10809")
        );
        assert_eq!(
            parse_windows_proxy_server("socks=127.0.0.1:10808").as_deref(),
            Some("socks5h://127.0.0.1:10808")
        );
        assert_eq!(
            parse_windows_proxy_server("https=proxy.local:8443").as_deref(),
            // https= still yields an http:// proxy URL (see fn comment).
            Some("http://proxy.local:8443")
        );
        assert_eq!(parse_windows_proxy_server("  ").as_deref(), None);
    }

    #[test]
    fn snippet_truncates_long_bodies() {
        let body = "x".repeat(ERROR_SNIPPET_CHARS + 40);
        assert_eq!(http_err_snippet(&body).len(), ERROR_SNIPPET_CHARS);
        assert_eq!(http_err_snippet("short body"), "short body");
    }
}
