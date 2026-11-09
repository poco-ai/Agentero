//! Translation backends.
//! Free web MT plus commercial BYOK providers called directly by the Host.
//! Unofficial / best-effort; may break or rate-limit.

use crate::error::AppError;
use crate::http;
use serde::Serialize;
use std::time::Duration;

mod sources;

pub use sources::openai_compatible::strip_unknown_translate_placeholders;

/// Soft cap for a single translation request (characters).
pub const MAX_TEXT_CHARS: usize = 5000;

/// Built-in provider id. Credentials are compiled into the Host, so this id is
/// deliberately absent from both lists below: `FREE_PROVIDERS` gates the CLI's
/// `--provider` (which cannot authenticate it) and `COMMERCIAL_PROVIDERS` drives
/// the WebView credential cards (which it must not render).
pub const BUILTIN_PROVIDER_ID: &str = "agentero";

/// Wire marker returned when this build carries no built-in key.
pub const ERR_NO_BUILTIN_KEY: &str = "translate.no_builtin_key";

/// Known free MT provider ids.
pub const FREE_PROVIDERS: &[&str] = &[
    "google",
    "googleapi",
    "deeplx",
    "cnki",
    "huoshanweb",
    "tencenttransmart",
];

/// Commercial BYOK provider ids configured in Settings → Translate.
pub const COMMERCIAL_PROVIDERS: &[&str] = &["deepl", "azure", "googleCloud", "openaiCompatible"];

/// Default free engines raced in parallel for best-effort zh-CN (NOTES abstract).
/// First non-empty success wins; remaining in-flight requests are dropped.
/// Prefer engines that work better from CN networks.
pub const ZH_RACE_PROVIDERS: &[&str] = &["tencenttransmart", "huoshanweb", "deeplx"];

/// Per-engine HTTP timeout for [`free_mt_to_zh`] (import NOTES abstract, etc.).
///
/// Bench (2026-08, 5 arXiv abstracts ≈0.9–1.8k chars, Host-equivalent endpoints):
/// success p50 ≈0.5–0.9s, max ≈1.3s. Engines run **in parallel**, so wall time is
/// ~min(successes) rather than sum of failures. 5s ≈4× headroom on a slow success;
/// worst-case wall time is one timeout (5s), not 3×.
pub const FREE_MT_ZH_TIMEOUT_MS: u32 = 5_000;

/// zh-CN via parallel free-MT race; `None` when every engine fails or returns empty.
///
/// Spawns one request per [`ZH_RACE_PROVIDERS`] entry and returns the **first**
/// non-empty translation. Dropping unfinished tasks cancels their HTTP work.
pub async fn free_mt_to_zh(text: &str) -> Option<String> {
    free_mt_to_zh_with(text, translate_text).await
}

async fn free_mt_to_zh_with<Fut>(
    text: &str,
    translate: impl Fn(TranslateTextArgs) -> Fut,
) -> Option<String>
where
    Fut: std::future::Future<Output = Result<TranslateTextResult, AppError>>,
{
    use futures_util::stream::{FuturesUnordered, StreamExt};

    let slice: String = text.chars().take(MAX_TEXT_CHARS).collect();
    if slice.trim().is_empty() {
        return None;
    }

    let mut tasks = FuturesUnordered::new();
    for provider in ZH_RACE_PROVIDERS {
        let text = slice.clone();
        let provider = (*provider).to_string();
        let translate = &translate;
        tasks.push(async move {
            let r = translate(TranslateTextArgs {
                text,
                source_lang: "auto".into(),
                target_lang: "zh-CN".into(),
                provider,
                api_key: None,
                base_url: None,
                region: None,
                model: None,
                extra_request_body: None,
                custom_prompt: None,
                custom_system: None,
                custom_user: None,
                timeout_ms: Some(FREE_MT_ZH_TIMEOUT_MS),
            })
            .await
            .ok()?;
            let t = r.text.trim().to_string();
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        });
    }

    while let Some(result) = tasks.next().await {
        if let Some(translated) = result {
            // Drop `tasks` → cancel remaining engine futures / HTTP clients.
            return Some(translated);
        }
    }
    None
}

/// Heuristic: already mostly CJK → skip MT (e.g. Chinese papers).
pub fn looks_mostly_cjk(s: &str) -> bool {
    let mut cjk = 0usize;
    let mut letters = 0usize;
    for c in s.chars() {
        if ('\u{4e00}'..='\u{9fff}').contains(&c) {
            cjk += 1;
        } else if c.is_ascii_alphabetic() {
            letters += 1;
        }
    }
    cjk > 0 && cjk >= letters
}

#[derive(Debug, Clone, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TranslateTextArgs {
    pub text: String,
    #[serde(default = "default_source")]
    pub source_lang: String,
    pub target_lang: String,
    /// Provider id: free MT, commercial BYOK, or `agent`.
    #[serde(default = "default_provider")]
    pub provider: String,
    /// Commercial BYOK API key.
    #[serde(default)]
    pub api_key: Option<String>,
    /// Commercial BYOK base URL / endpoint override.
    #[serde(default)]
    pub base_url: Option<String>,
    /// Azure subscription region.
    #[serde(default)]
    pub region: Option<String>,
    /// OpenAI-compatible model id.
    #[serde(default)]
    pub model: Option<String>,
    /// OpenAI-compatible JSON object replacing automatic sampling/thinking
    /// parameters. Blank uses model defaults; an empty object disables them.
    #[serde(default)]
    pub extra_request_body: Option<String>,
    /// Legacy single template (settings `translate.customPrompt`). A short line
    /// is a preference; a longer value replaces the academic style block only.
    /// Ignored when `custom_system` is non-empty.
    #[serde(default)]
    pub custom_prompt: Option<String>,
    /// Settings `translate.customSystem`. Wins over `custom_prompt`.
    #[serde(default)]
    pub custom_system: Option<String>,
    /// Settings `translate.customUser`. Replaces the quoted source when it
    /// contains `{{text}}`.
    #[serde(default)]
    pub custom_user: Option<String>,
    /// Optional request timeout in milliseconds (clamped 1s–30s). Default 30s.
    /// Settings probe uses a shorter value for snappy parallel checks.
    #[serde(default)]
    pub timeout_ms: Option<u32>,
}

fn default_source() -> String {
    "auto".to_string()
}

fn default_provider() -> String {
    "tencenttransmart".to_string()
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TranslateTextResult {
    pub text: String,
    pub provider: String,
}

pub async fn translate_text(args: TranslateTextArgs) -> Result<TranslateTextResult, AppError> {
    let text = args.text.trim();
    if text.is_empty() {
        return Err(AppError::message("Empty text"));
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err(AppError::message(format!(
            "Text too long for translation (max {MAX_TEXT_CHARS} characters)"
        )));
    }

    let mut provider = args.provider.trim().to_ascii_lowercase();
    if provider.is_empty() {
        provider = default_provider();
    }

    let source = normalize_lang(&args.source_lang, true);
    let target = normalize_lang(&args.target_lang, false);
    if target.is_empty() {
        return Err(AppError::message("Missing target language"));
    }

    let timeout = resolve_timeout(args.timeout_ms);

    let translated = match provider.as_str() {
        "google" => {
            sources::google::translate_google(
                "https://translate.google.com",
                text,
                &source,
                &target,
                timeout,
            )
            .await?
        }
        "googleapi" => {
            sources::google::translate_google(
                "https://translate.googleapis.com",
                text,
                &source,
                &target,
                timeout,
            )
            .await?
        }
        "deeplx" => sources::deeplx::translate_deeplx(text, &source, &target, timeout).await?,
        "cnki" => sources::cnki::translate_cnki(text, &source, &target, timeout).await?,
        "huoshanweb" => {
            sources::huoshanweb::translate_huoshan_web(text, &source, &target, timeout).await?
        }
        "tencenttransmart" => {
            sources::tencent_transmart::translate_tencent_transmart(text, &source, &target, timeout)
                .await?
        }
        "deepl" => {
            sources::deepl::translate_deepl(
                text,
                &source,
                &target,
                timeout,
                args.api_key.as_deref(),
                args.base_url.as_deref(),
            )
            .await?
        }
        "azure" => {
            sources::azure::translate_azure(
                text,
                &source,
                &target,
                timeout,
                args.api_key.as_deref(),
                args.base_url.as_deref(),
                args.region.as_deref(),
            )
            .await?
        }
        "googlecloud" => {
            sources::google_cloud::translate_google_cloud(
                text,
                &source,
                &target,
                timeout,
                args.api_key.as_deref(),
                args.base_url.as_deref(),
            )
            .await?
        }
        "openaicompatible" => {
            sources::openai_compatible::translate_openai_compatible(
                text,
                &source,
                &target,
                timeout,
                args.api_key.as_deref(),
                args.base_url.as_deref(),
                args.model.as_deref(),
                args.custom_prompt.as_deref(),
                args.custom_system.as_deref(),
                args.custom_user.as_deref(),
                args.extra_request_body.as_deref(),
            )
            .await?
        }
        BUILTIN_PROVIDER_ID => {
            sources::hunyuan_mt::translate_hunyuan_mt(
                text,
                &target,
                timeout,
                args.api_key.as_deref(),
                args.base_url.as_deref(),
                args.model.as_deref(),
            )
            .await?
        }
        other => {
            return Err(AppError::message(format!(
                "Unknown translation provider: {other}"
            )));
        }
    };

    let out = translated.trim().to_string();
    if out.is_empty() {
        return Err(AppError::message("Empty translation result"));
    }
    Ok(TranslateTextResult {
        text: out,
        provider,
    })
}

pub(crate) fn required_api_key<'a>(
    provider: &str,
    api_key: Option<&'a str>,
) -> Result<&'a str, AppError> {
    let Some(key) = api_key.map(str::trim).filter(|s| !s.is_empty()) else {
        return Err(AppError::message(format!(
            "{provider} requires apiKey (Settings → Translate)"
        )));
    };
    Ok(key)
}

pub(crate) fn optional_endpoint(
    base_url: Option<&str>,
    default_root: &str,
    suffix: &str,
) -> String {
    let base = base_url
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(default_root)
        .trim_end_matches('/');
    if base.ends_with(suffix) {
        base.to_string()
    } else {
        format!("{base}{suffix}")
    }
}

pub(crate) fn normalize_lang(raw: &str, allow_auto: bool) -> String {
    let s = raw.trim();
    if s.is_empty() {
        return if allow_auto {
            "auto".to_string()
        } else {
            String::new()
        };
    }
    let lower = s.to_ascii_lowercase();
    if allow_auto && (lower == "auto" || lower == "detect") {
        return "auto".to_string();
    }
    if lower == "zh" || lower == "zh-cn" || lower == "zh-hans" || lower == "chinese" {
        return "zh-CN".to_string();
    }
    if lower == "en" || lower == "english" {
        return "en".to_string();
    }
    s.to_string()
}

pub(crate) fn lang_base(code: &str) -> &str {
    code.split('-').next().unwrap_or(code)
}

/// Clamp optional timeout_ms to 1s–30s; default 30s.
pub(crate) fn resolve_timeout(timeout_ms: Option<u32>) -> Duration {
    match timeout_ms {
        Some(ms) => Duration::from_millis(u64::from(ms.clamp(1_000, 30_000))),
        None => Duration::from_secs(30),
    }
}

pub(crate) async fn read_body(
    resp: reqwest::Response,
) -> Result<(reqwest::StatusCode, String), AppError> {
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| AppError::message(format!("translate read body: {e}")))?;
    Ok((status, body))
}

pub(crate) fn http_err(status: reqwest::StatusCode, body: &str, label: &str) -> AppError {
    let snippet = http::http_err_snippet(body);
    AppError::message(format!("{label} failed (HTTP {status}): {snippet}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_zh() {
        assert_eq!(normalize_lang("zh-CN", false), "zh-CN");
        assert_eq!(normalize_lang("Chinese", false), "zh-CN");
        assert_eq!(normalize_lang("auto", true), "auto");
    }

    #[test]
    fn free_providers_listed() {
        assert!(FREE_PROVIDERS.contains(&"deeplx"));
        assert!(FREE_PROVIDERS.contains(&"cnki"));
        // CNKI stays out of the zh race: slow (chunked + pauses) and
        // captcha-prone, racing it would only trip the rate limit.
        assert!(!ZH_RACE_PROVIDERS.contains(&"cnki"));
        assert!(FREE_PROVIDERS.contains(&"huoshanweb"));
        assert!(FREE_PROVIDERS.contains(&"tencenttransmart"));
        assert!(FREE_PROVIDERS.contains(&"googleapi"));
        assert!(FREE_PROVIDERS.contains(&"google"));
        for p in COMMERCIAL_PROVIDERS {
            assert!(
                !FREE_PROVIDERS.contains(p),
                "{p} should stay out of FREE_PROVIDERS"
            );
        }
        for p in ZH_RACE_PROVIDERS {
            assert!(
                FREE_PROVIDERS.contains(p),
                "{p} missing from FREE_PROVIDERS"
            );
        }
        assert_eq!(
            ZH_RACE_PROVIDERS,
            &["tencenttransmart", "huoshanweb", "deeplx"]
        );
        // Keep abstract-MT snappy: enough for slow success (~1.3s bench max);
        // parallel race → wall ≈ one timeout, not 3×.
        assert!((3_000..=8_000).contains(&FREE_MT_ZH_TIMEOUT_MS));
    }

    #[test]
    fn looks_mostly_cjk_detects_chinese() {
        assert!(looks_mostly_cjk("本文提出了一种新的注意力机制。"));
        assert!(!looks_mostly_cjk(
            "We propose a new attention mechanism for sequence transduction."
        ));
        assert!(!looks_mostly_cjk(""));
    }
}
