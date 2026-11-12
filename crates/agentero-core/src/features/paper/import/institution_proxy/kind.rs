//! Gateway kinds, the process-wide active configuration, and the shared
//! `settings.json` slice used by the desktop Host and headless CLI.

use std::sync::Mutex;

/// Gateway flavour of the configured institution proxy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstitutionProxyKind {
    /// No gateway: direct connection. On campus networks the institution IP
    /// itself carries the subscription, so this needs zero configuration.
    Direct,
    /// Standard EZProxy query passthrough (`/login?url={encoded target}`).
    EzProxy,
    /// wengine WebVPN path rewriting (`/https/{encrypted-host}/{path}`), used
    /// by several CN universities (ZJU etc.). Hosts are AES-128-CTR encrypted
    /// with the fixed public `wrdvpnisthebest!` key and prefixed with the IV.
    Wengine,
    /// Astraeus-style subdomain mapping: the target host and port become a
    /// dedicated gateway subdomain (`{host with dots as dashes}-{port}`).
    /// The first hop normally redirects through the gateway to mint a
    /// per-subdomain token, so the saved gateway cookie must ride along on
    /// redirects as well.
    Subdomain,
    /// Classify the entered prefix first (gateway fingerprint + rewrite
    /// probe), then use the detected kind. Lets custom gateways work without
    /// the user knowing the vendor.
    Auto,
}

impl InstitutionProxyKind {
    pub fn from_setting(s: &str) -> Self {
        if s.eq_ignore_ascii_case("wengine") {
            Self::Wengine
        } else if s.eq_ignore_ascii_case("subdomain") {
            Self::Subdomain
        } else if s.eq_ignore_ascii_case("ezproxy") {
            Self::EzProxy
        } else {
            Self::Auto
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::EzProxy => "ezproxy",
            Self::Wengine => "wengine",
            Self::Subdomain => "subdomain",
            Self::Auto => "auto",
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct InstitutionProxyConf {
    pub(crate) kind: InstitutionProxyKind,
    pub(crate) prefix: String,
    pub(crate) cookie: String,
}

impl InstitutionProxyConf {
    pub(crate) fn direct() -> Self {
        Self {
            kind: InstitutionProxyKind::Direct,
            prefix: String::new(),
            cookie: String::new(),
        }
    }
}

/// Active institution proxy credentials for paywalled PDF fallback.
///
/// Set by the host when settings load or change (`set_institution_proxy`);
/// read per request by the download fallback chain. An empty prefix disables
/// the layer — the unauthenticated behaviour stays the default.
static INSTITUTION_PROXY: Mutex<Option<InstitutionProxyConf>> = Mutex::new(None);

/// Update the process-wide institution proxy (kind + prefix + session cookie).
/// An empty prefix disables the fallback layer. For EZProxy a bare origin
/// (no query part) gets the `/login?url=` convention appended; the other kinds
/// keep the bare gateway origin.
pub fn set_institution_proxy(kind: InstitutionProxyKind, prefix: &str, cookie: &str) {
    let mut prefix = prefix.trim().trim_end_matches('/').to_string();
    if kind == InstitutionProxyKind::EzProxy && !prefix.is_empty() && !prefix.contains('?') {
        prefix.push_str("/login?url=");
    }
    // Header values reject control characters; pasted cookies often carry
    // stray CR/LF/TAB from terminals or chat windows.
    let cookie: String = cookie
        .trim()
        .chars()
        .filter(|c| !matches!(c, '\r' | '\n' | '\t'))
        .collect();
    let value = if prefix.is_empty() {
        None
    } else {
        Some(InstitutionProxyConf {
            kind,
            prefix,
            cookie,
        })
    };
    if let Ok(mut guard) = INSTITUTION_PROXY.lock() {
        *guard = value;
    }
}

pub(crate) fn institution_proxy() -> Option<InstitutionProxyConf> {
    INSTITUTION_PROXY.lock().ok().and_then(|g| g.clone())
}

/// Institution-proxy fields as stored in the shared
/// `$XDG_CONFIG_HOME/agentero/settings.json` (camelCase). Defined here so the
/// headless CLI reads the very same keys the GUI store writes, instead of a
/// parallel copy that could drift out of sync.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstitutionProxySettings {
    #[serde(default)]
    institution_proxy_prefix: String,
    #[serde(default)]
    institution_proxy_cookie: String,
    #[serde(default)]
    institution_proxy_type: String,
}

/// Extract `(kind, prefix, cookie)` from a `settings.json` body. Pure so it can
/// be unit-tested without touching the process-wide proxy.
fn parse_institution_proxy_settings(raw: &str) -> Option<(InstitutionProxyKind, String, String)> {
    let s: InstitutionProxySettings = serde_json::from_str(raw).ok()?;
    let kind = InstitutionProxyKind::from_setting(&s.institution_proxy_type);
    Some((kind, s.institution_proxy_prefix, s.institution_proxy_cookie))
}

/// Install the institution-proxy slice of a `settings.json` body into this
/// process. An absent/empty prefix keeps the unauthenticated default (direct,
/// no cookie). Returns true when a gateway was activated.
fn apply_institution_proxy_settings(raw: &str) -> bool {
    let Some((kind, prefix, cookie)) = parse_institution_proxy_settings(raw) else {
        return false;
    };
    set_institution_proxy(kind, &prefix, &cookie);
    institution_proxy().is_some()
}

/// Load the institution proxy (EZProxy/WebVPN) from the shared `settings.json`
/// into this process. The desktop Host does this through its settings store;
/// the headless CLI has no store, so it reads the same file here before
/// downloading. Missing, unreadable, or malformed settings leave the default
/// (direct, no cookie).
pub fn load_institution_proxy_from_settings() -> bool {
    std::fs::read_to_string(crate::paths::settings_path())
        .map(|raw| apply_institution_proxy_settings(&raw))
        .unwrap_or(false)
}
