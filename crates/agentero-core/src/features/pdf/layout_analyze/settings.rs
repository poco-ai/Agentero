//! Provider selection + credentials for headless layout analysis.
//!
//! The desktop app stores provider cards in `~/.config/agentero/settings.json`
//! (`layout.backend` + `layout.providerConfigs.<key>`). The CLI reads the same
//! file — unlike `agentero translate` (free engines only), layout analysis
//! inherits the desktop's keys so a headless vault needs no second config.
//!
//! This module is read-only and never logs secrets.

use crate::error::AppError;
use serde_json::Value;
use std::path::Path;

/// Backend id when `settings.json` has no (or an empty) `layout.backend`.
const DEFAULT_LAYOUT_BACKEND: &str = "local";

/// Resolved provider configuration for one analyze run.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LayoutProviderSettings {
    /// Provider id (`paddle` | `mineru`).
    pub provider: String,
    /// Sidecar `source.mode` for this provider.
    pub sidecar_mode: String,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    /// MinerU OCR language pack (`ch`, `en`, …).
    pub language: Option<String>,
    /// MinerU force-OCR.
    pub is_ocr: bool,
    /// MinerU self-hosted deployment.
    pub self_hosted: bool,
}

/// `layout.backend` from `settings.json` (`local` | `paddle` | `mineru`).
/// Defaults to `local` when the file or field is missing (desktop default).
pub fn default_layout_backend() -> String {
    default_layout_backend_from(&read_settings_json())
}

fn default_layout_backend_from(settings: &Value) -> String {
    backend_of(settings)
        .filter(|backend| !backend.trim().is_empty())
        .unwrap_or(DEFAULT_LAYOUT_BACKEND)
        .to_string()
}

fn backend_of(settings: &Value) -> Option<&str> {
    settings.pointer("/layout/backend").and_then(Value::as_str)
}

/// Resolve provider settings from `settings.json`, applying CLI overrides.
///
/// * `provider = None` → `layout.backend`; a `local` backend is an error that
///   tells the caller to pass `--provider` (ONNX runs in the WebView).
/// * `api_key` / `base_url` overrides win over stored values.
/// * `self_hosted = Some(_)` overrides the stored MinerU `selfHosted` switch
///   (headless servers usually point `base_url` at their own MinerU).
/// * A stored `*`-masked key counts as absent.
pub fn resolve_provider_settings(
    provider: Option<&str>,
    api_key: Option<&str>,
    base_url: Option<&str>,
    self_hosted: Option<bool>,
) -> Result<LayoutProviderSettings, AppError> {
    resolve_from_settings(
        &read_settings_json(),
        provider,
        api_key,
        base_url,
        self_hosted,
    )
}

fn resolve_from_settings(
    settings: &Value,
    provider: Option<&str>,
    api_key: Option<&str>,
    base_url: Option<&str>,
    self_hosted_override: Option<bool>,
) -> Result<LayoutProviderSettings, AppError> {
    let requested = provider
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| backend_of(settings).map(str::trim))
        .unwrap_or(DEFAULT_LAYOUT_BACKEND);
    if requested.eq_ignore_ascii_case("local") {
        return Err(AppError::domain(
            "layout_provider_local",
            "layout analysis backend is 'local' (PP-DocLayoutV3 ONNX runs in the desktop renderer); pass --provider paddle|mineru",
        ));
    }
    let (provider_id, settings_key, sidecar_mode) = match requested.to_ascii_lowercase().as_str() {
        "paddle" => ("paddle", "paddle", "paddle-layout"),
        "mineru" => ("mineru", "mineru", "mineru-layout"),
        // `openaiCompatible` is a PAPER.md body parser, never a layout provider.
        _ => {
            return Err(AppError::domain(
                "layout_provider_unknown",
                format!("unknown layout provider: {requested} (expected paddle|mineru)"),
            ))
        }
    };

    let config = settings.pointer(&format!("/layout/providerConfigs/{settings_key}"));
    let stored_key = config
        .and_then(|config| config.get("apiKey"))
        .and_then(Value::as_str);
    let resolved_key = clean_secret(api_key)
        .or_else(|| clean_secret(stored_key))
        .ok_or_else(|| {
            AppError::domain(
                "layout_provider_unconfigured",
                format!(
                    "layout provider {provider_id} has no API key; set it in Settings → Layout or pass --api-key"
                ),
            )
        })?;

    let stored_base_url = config
        .and_then(|config| config.get("baseUrl"))
        .and_then(Value::as_str);
    let resolved_base_url = clean_secret(base_url).or_else(|| clean_secret(stored_base_url));
    let language = config
        .and_then(|config| config.get("language"))
        .and_then(Value::as_str)
        .and_then(clean_non_empty);
    let is_ocr = config
        .and_then(|config| config.get("isOcr"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let self_hosted = self_hosted_override
        .or_else(|| {
            config
                .and_then(|config| config.get("selfHosted"))
                .and_then(Value::as_bool)
        })
        .unwrap_or(false);

    Ok(LayoutProviderSettings {
        provider: provider_id.to_string(),
        sidecar_mode: sidecar_mode.to_string(),
        api_key: Some(resolved_key),
        base_url: resolved_base_url,
        language,
        is_ocr,
        self_hosted,
    })
}

/// Trimmed value when non-empty.
fn clean_non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Trimmed value when non-empty and not a `*` mask.
fn clean_secret(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() || is_api_key_mask(trimmed) {
        return None;
    }
    Some(trimmed.to_string())
}

/// Read `settings.json` into a JSON value (empty object when absent/unreadable).
pub fn read_settings_json() -> serde_json::Value {
    settings_json_from(&crate::paths::settings_path())
}

/// Parse one settings file; any IO/JSON failure is an empty object.
fn settings_json_from(path: &Path) -> serde_json::Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .unwrap_or_else(|| Value::Object(serde_json::Map::new()))
}

/// True when `value` is the `*`-masked placeholder sent by renderers.
pub fn is_api_key_mask(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty() && trimmed.chars().all(|c| c == '*')
}
