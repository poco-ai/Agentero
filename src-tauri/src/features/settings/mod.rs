//! Application UI settings — XDG config file `settings.json`.
//!
//! Frontend `AppSettings` (camelCase JSON) is the source of shape; Host owns
//! the durable file under [`crate::core::paths::settings_path`].
//!
//! Coupling contract: settings provides read/write/persist/broadcast only and
//! never calls into domain features. Domains that must react to changes
//! (connector port, agent proxy, import parser, jobs layout cap) register
//! [`AppSettingsStore::subscribe`] listeners at app assembly; domain defaults
//! needed at deserialize time (e.g. [`DEFAULT_CONNECTOR_PORT`]) live here and
//! are re-exported by the owning domain.

use crate::core::error::AppError;
use crate::core::paths::{self, settings_path};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const DEFAULT_TRANSLATOR_BASE_URL: &str = "https://translator.philfan.cn";
pub const DEFAULT_NETWORK_PROXY_URL: &str = "http://127.0.0.1:7890";
/// Default Zotero Connector port (must match the official extension default).
/// Owned here because the persisted `connectorPort` default must exist at
/// deserialize time; `features::connector` re-exports it.
pub const DEFAULT_CONNECTOR_PORT: u16 = 23119;
/// Default loopback port for the optional MCP HTTP server.
pub const DEFAULT_MCP_PORT: u16 = 8765;

/// True when `key` is a UI mask of only `*` (length mirrors the real secret).
/// Real secrets stay in the Host process / settings file; `settings_set` treats
/// an all-asterisk value as “keep previous key”.
pub fn is_translate_api_key_mask(key: &str) -> bool {
    let t = key.trim();
    !t.is_empty() && t.chars().all(|c| c == '*')
}

/// Replace a non-empty secret with the same number of `*` characters.
pub fn mask_translate_api_key(key: &str) -> String {
    let n = key.trim().chars().count();
    if n == 0 {
        String::new()
    } else {
        "*".repeat(n)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default = "default_translator_base_url")]
    pub translator_base_url: String,
    #[serde(default)]
    pub network_proxy_enabled: bool,
    #[serde(default = "default_network_proxy_url")]
    pub network_proxy_url: String,
    #[serde(default = "default_paper_tree_label_mode")]
    pub paper_tree_label_mode: String,
    #[serde(default = "default_paper_tree_sort_mode")]
    pub paper_tree_sort_mode: String,
    /// NOTES.md shell generated on paper import:
    /// `standard` | `title-only` | `blank` | `custom` (vault template).
    #[serde(default = "default_paper_note_mode")]
    pub paper_note_mode: String,
    /// Open a paper's NOTES.md in the reading split when a paper is opened.
    /// Default on; off opens only the PDF/HTML body.
    #[serde(default = "default_true")]
    pub auto_open_paper_notes: bool,
    #[serde(default = "default_auto_update_internal_links")]
    pub auto_update_internal_links: String,
    #[serde(default = "default_library_columns")]
    pub library_columns: Vec<LibraryColumnPref>,
    #[serde(default)]
    pub connector_enabled: bool,
    #[serde(default = "default_connector_port")]
    pub connector_port: u16,
    /// Loopback Streamable HTTP MCP server. Default off.
    #[serde(default)]
    pub mcp_enabled: bool,
    #[serde(default = "default_mcp_port")]
    pub mcp_port: u16,
    /// OpenAI Secure MCP Tunnel id (`tunnel_` + 32 hex) for the built-in
    /// `tunnel-client` supervisor. Empty = never configured.
    #[serde(default)]
    pub mcp_tunnel_id: String,
    /// Runtime (Restricted) control-plane API key. Masked on read like the
    /// other commercial keys; the WebView never sees the plaintext.
    #[serde(default)]
    pub mcp_tunnel_api_key: String,
    #[serde(default = "default_batch_import_concurrency")]
    pub batch_import_concurrency: u32,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_ui_theme")]
    pub ui_theme: String,
    #[serde(default = "default_locale")]
    pub locale: String,
    #[serde(default = "default_editor_font_size")]
    pub editor_font_size: u32,
    /// UI chrome font. Empty = app default. Built-ins: system/serif/mono, else family name.
    #[serde(default)]
    pub interface_font_family: String,
    /// Markdown body font. Empty = inherit interface/default. Same vocabulary as interface.
    #[serde(default)]
    pub text_font_family: String,
    /// Monospace font for code / font-mono. Empty = app default mono stack.
    #[serde(default)]
    pub mono_font_family: String,
    /// Deprecated single editor font preset; migrated into `text_font_family` once.
    #[serde(default, skip_serializing)]
    pub editor_font_family: String,
    /// Markdown editor body line-height (unitless), typical range 1.4–2.0.
    #[serde(default = "default_editor_line_height")]
    pub editor_line_height: f64,
    #[serde(default = "default_ui_scale")]
    pub ui_scale: f64,
    #[serde(default = "default_true")]
    pub show_editor_toolbar: bool,
    #[serde(default = "default_permission_mode")]
    pub agent_permission_mode: String,
    #[serde(default)]
    pub auto_paper_reader: bool,
    #[serde(default = "default_ai_response_language")]
    pub ai_response_language: String,
    #[serde(default)]
    pub agent_personal_prompt: String,
    #[serde(default)]
    pub pdf_ask: PdfAskSettings,
    #[serde(default)]
    pub embedding: EmbeddingSettings,
    #[serde(default)]
    pub translate: TranslateSettings,
    #[serde(default)]
    pub layout: LayoutSettings,
    /// Prefill Markdown export dialog watermark checkbox (default off).
    #[serde(default)]
    pub export_watermark_enabled: bool,
    /// PostHog product analytics opt-out (applies from the next launch).
    #[serde(default = "default_true")]
    pub telemetry_enabled: bool,
    /// Plaza discovery sources in the sidebar. Default on.
    #[serde(default = "default_true")]
    pub plaza_enabled: bool,
    /// Plaza source ids hidden from the sidebar / Plaza home (right-click toggle).
    #[serde(default)]
    pub plaza_hidden_sources: Vec<String>,
    /// First-run setup wizard completed. Default false → auto-show on fresh installs.
    #[serde(default)]
    pub onboarding_done: bool,
    /// Post-vault feature tour completed or skipped. Default false → auto-start once.
    #[serde(default)]
    pub feature_tour_done: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PdfAskSettings {
    #[serde(default)]
    pub agent_id: String,
    #[serde(default)]
    pub model_id: String,
}

/// OpenAI-compatible embedding endpoint (BYOK). All-empty = feature disabled.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingSettings {
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
}

/// One column in the papers Library table: array order = display order.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryColumnPref {
    pub key: String,
    pub visible: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranslateSettings {
    #[serde(default = "default_translate_provider")]
    pub provider: String,
    #[serde(default = "default_translate_target")]
    pub target_lang: String,
    #[serde(default = "default_translate_source")]
    pub source_lang: String,
    #[serde(default)]
    pub provider_configs: HashMap<String, TranslateProviderConfig>,
    #[serde(default)]
    pub auto_translate_selection: bool,
    #[serde(default)]
    pub agent_id: String,
    #[serde(default)]
    pub model_id: String,
}

impl Default for TranslateSettings {
    fn default() -> Self {
        Self {
            provider: default_translate_provider(),
            target_lang: default_translate_target(),
            source_lang: default_translate_source(),
            provider_configs: HashMap::new(),
            auto_translate_selection: false,
            agent_id: String::new(),
            model_id: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TranslateProviderConfig {
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub region: String,
    #[serde(default)]
    pub model: String,
}

/// PDF layout-analysis backend selection.
/// - `local`: on-device PP-DocLayoutV3 (ONNX in the renderer).
/// - `paddle`: remote PP-StructureV3 async job API (`POST {base}/api/v2/ocr/jobs`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LayoutSettings {
    #[serde(default = "default_layout_backend")]
    pub backend: String,
    /// PAPER.md body-parse engine: `local` | `paddle` | `mineru` | `openaiCompatible`.
    #[serde(default = "default_parser_backend")]
    pub parser_backend: String,
    #[serde(default)]
    pub provider_configs: HashMap<String, LayoutProviderConfig>,
}

impl Default for LayoutSettings {
    fn default() -> Self {
        Self {
            backend: default_layout_backend(),
            parser_backend: default_parser_backend(),
            provider_configs: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct LayoutProviderConfig {
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    /// OCR prompt override; empty → the engine derives one from the model id.
    #[serde(default)]
    pub prompt: String,
    /// MinerU document language (OCR language pack); normalize() enforces the
    /// MinerU vocabulary and falls back to `ch`.
    #[serde(default)]
    pub language: String,
    /// MinerU force-OCR: run OCR on every page regardless of the PDF text layer.
    #[serde(default)]
    pub is_ocr: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            translator_base_url: DEFAULT_TRANSLATOR_BASE_URL.to_string(),
            network_proxy_enabled: false,
            network_proxy_url: default_network_proxy_url(),
            paper_tree_label_mode: default_paper_tree_label_mode(),
            paper_tree_sort_mode: default_paper_tree_sort_mode(),
            paper_note_mode: default_paper_note_mode(),
            auto_open_paper_notes: default_true(),
            auto_update_internal_links: default_auto_update_internal_links(),
            library_columns: default_library_columns(),
            connector_enabled: false,
            connector_port: default_connector_port(),
            mcp_enabled: false,
            mcp_port: default_mcp_port(),
            mcp_tunnel_id: String::new(),
            mcp_tunnel_api_key: String::new(),
            batch_import_concurrency: default_batch_import_concurrency(),
            theme: default_theme(),
            ui_theme: default_ui_theme(),
            locale: default_locale(),
            editor_font_size: default_editor_font_size(),
            interface_font_family: String::new(),
            text_font_family: String::new(),
            mono_font_family: String::new(),
            editor_font_family: String::new(),
            editor_line_height: default_editor_line_height(),
            ui_scale: default_ui_scale(),
            show_editor_toolbar: true,
            agent_permission_mode: default_permission_mode(),
            auto_paper_reader: false,
            ai_response_language: default_ai_response_language(),
            agent_personal_prompt: String::new(),
            pdf_ask: PdfAskSettings::default(),
            embedding: EmbeddingSettings::default(),
            translate: TranslateSettings::default(),
            layout: LayoutSettings::default(),
            export_watermark_enabled: false,
            telemetry_enabled: default_true(),
            plaza_enabled: default_true(),
            plaza_hidden_sources: Vec::new(),
            onboarding_done: false,
            feature_tour_done: false,
        }
    }
}

fn default_true() -> bool {
    true
}
fn default_translator_base_url() -> String {
    DEFAULT_TRANSLATOR_BASE_URL.to_string()
}
fn default_network_proxy_url() -> String {
    DEFAULT_NETWORK_PROXY_URL.to_string()
}
fn default_paper_tree_label_mode() -> String {
    "title-author".into()
}
fn default_paper_tree_sort_mode() -> String {
    "folder".into()
}
fn default_paper_note_mode() -> String {
    "standard".into()
}
fn default_auto_update_internal_links() -> String {
    "ask".into()
}
/// Canonical papers-Library column keys, in default order.
const LIBRARY_COLUMN_KEYS: &[&str] = &["title", "authors", "year", "tags", "type", "id"];
fn default_library_columns() -> Vec<LibraryColumnPref> {
    LIBRARY_COLUMN_KEYS
        .iter()
        .map(|&key| LibraryColumnPref {
            key: key.to_string(),
            visible: true,
        })
        .collect()
}
fn default_theme() -> String {
    "system".into()
}
/// tweakcn preset name; the theme list lives in the frontend bundle, so the
/// Host only guarantees a non-empty value.
fn default_ui_theme() -> String {
    "default".into()
}
fn default_locale() -> String {
    "system".into()
}
fn default_editor_font_size() -> u32 {
    14
}
fn default_editor_line_height() -> f64 {
    1.6
}

fn normalize_font_family_value(raw: &str) -> String {
    let v = raw.trim();
    if v.is_empty() || v == "default" {
        return String::new();
    }
    v.chars().take(120).collect()
}
fn default_ui_scale() -> f64 {
    1.0
}
fn default_permission_mode() -> String {
    "restricted".into()
}
fn default_ai_response_language() -> String {
    "auto".into()
}
fn default_translate_provider() -> String {
    "tencenttransmart".into()
}
fn default_connector_port() -> u16 {
    DEFAULT_CONNECTOR_PORT
}
fn default_mcp_port() -> u16 {
    DEFAULT_MCP_PORT
}
fn default_batch_import_concurrency() -> u32 {
    5
}
fn default_translate_target() -> String {
    "ui".into()
}
fn default_translate_source() -> String {
    "auto".into()
}
fn default_layout_backend() -> String {
    "local".into()
}
fn default_parser_backend() -> String {
    "local".into()
}

/// Domain reaction fired after settings are persisted. Receives the same
/// redacted snapshot that `settings_set` returns and broadcasts.
pub type SettingsListener = Arc<dyn Fn(&AppSettings) + Send + Sync>;

/// In-memory + file-backed settings store.
pub struct AppSettingsStore {
    inner: Mutex<AppSettings>,
    path: PathBuf,
    /// Domain reactions registered by the app assembly; fired after every
    /// successful [`set`](Self::set). Registering from the assembly (instead
    /// of calling domains from here) keeps settings schema-agnostic.
    listeners: Mutex<Vec<SettingsListener>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsGetResult {
    pub settings: AppSettings,
    /// Absolute path to the settings file.
    pub path: String,
    /// Whether the file already existed before this read (false → first run / defaults).
    pub existed: bool,
}

impl AppSettingsStore {
    pub fn load() -> Self {
        let path = settings_path();
        paths::migrate_legacy_file("settings.json", &path);
        let (settings, _existed) = read_file(&path);
        Self {
            inner: Mutex::new(settings),
            path,
            listeners: Mutex::new(Vec::new()),
        }
    }

    /// Register a domain reaction fired after every successful `set`.
    /// Called by the app assembly on behalf of domains (connector port,
    /// agent proxy, import parser, jobs layout cap), so settings keeps no
    /// edges into domain features.
    pub fn subscribe(&self, listener: impl Fn(&AppSettings) + Send + Sync + 'static) {
        if let Ok(mut guard) = self.listeners.lock() {
            guard.push(Arc::new(listener));
        }
    }

    fn notify(&self, settings: &AppSettings) {
        let Ok(listeners) = self.listeners.lock().map(|guard| guard.clone()) else {
            return;
        };
        for listener in listeners.iter() {
            listener(settings);
        }
    }

    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    pub fn get(&self) -> Result<SettingsGetResult, AppError> {
        let settings = self
            .inner
            .lock()
            .map_err(|_| AppError::message("settings lock poisoned"))?
            .clone();
        let existed = self.path.is_file();
        Ok(SettingsGetResult {
            settings: redact_secrets(settings),
            path: self.path.to_string_lossy().into_owned(),
            existed,
        })
    }

    pub fn set(&self, mut settings: AppSettings) -> Result<AppSettings, AppError> {
        {
            let previous = self
                .inner
                .lock()
                .map_err(|_| AppError::message("settings lock poisoned"))?;
            merge_secrets(&mut settings, &previous);
        }
        normalize(&mut settings);
        persist(&self.path, &settings)?;
        // Never echo raw API keys back to the WebView / settings:changed.
        let redacted = {
            let mut guard = self
                .inner
                .lock()
                .map_err(|_| AppError::message("settings lock poisoned"))?;
            *guard = settings.clone();
            redact_secrets(settings)
        };
        // Fire domain reactions with the store lock released: listeners read
        // back into the store (e.g. import::refresh_parser_config).
        self.notify(&redacted);
        Ok(redacted)
    }

    /// Resolve a commercial MT API key by provider id (case-insensitive).
    /// Used by `translate_text` so the WebView never needs the plaintext key.
    pub fn translate_api_key(&self, provider: &str) -> Option<String> {
        let key = commercial_provider_settings_key(provider)?;
        let guard = self.inner.lock().ok()?;
        let cfg = guard.translate.provider_configs.get(key)?;
        let api_key = cfg.api_key.trim();
        if api_key.is_empty() || is_translate_api_key_mask(api_key) {
            None
        } else {
            Some(api_key.to_string())
        }
    }

    pub fn layout_backend(&self) -> String {
        self.inner
            .lock()
            .ok()
            .map(|guard| guard.layout.backend.clone())
            .filter(|backend| !backend.trim().is_empty())
            .unwrap_or_else(default_layout_backend)
    }

    /// PAPER.md body-parse engine backend (`local` when unset).
    pub fn parser_backend(&self) -> String {
        self.inner
            .lock()
            .ok()
            .map(|guard| guard.layout.parser_backend.clone())
            .filter(|backend| !backend.trim().is_empty())
            .unwrap_or_else(default_parser_backend)
    }

    /// Resolve a layout-provider API key by provider id (e.g. `paddle`).
    /// Used by the layout_remote commands so the WebView never needs the key.
    pub fn layout_api_key(&self, provider: &str) -> Option<String> {
        let key = layout_provider_settings_key(provider)?;
        let guard = self.inner.lock().ok()?;
        let cfg = guard.layout.provider_configs.get(key)?;
        let api_key = cfg.api_key.trim();
        if api_key.is_empty() || is_translate_api_key_mask(api_key) {
            None
        } else {
            Some(api_key.to_string())
        }
    }

    /// Resolve a layout-provider base URL by provider id (empty → None).
    pub fn layout_base_url(&self, provider: &str) -> Option<String> {
        let key = layout_provider_settings_key(provider)?;
        let guard = self.inner.lock().ok()?;
        let cfg = guard.layout.provider_configs.get(key)?;
        let base_url = cfg.base_url.trim();
        if base_url.is_empty() {
            None
        } else {
            Some(base_url.to_string())
        }
    }

    /// Resolve a layout-provider model id by provider id (empty → None).
    pub fn layout_model(&self, provider: &str) -> Option<String> {
        let key = layout_provider_settings_key(provider)?;
        let guard = self.inner.lock().ok()?;
        let cfg = guard.layout.provider_configs.get(key)?;
        let model = cfg.model.trim();
        if model.is_empty() {
            None
        } else {
            Some(model.to_string())
        }
    }

    /// Resolve a layout-provider OCR prompt override (empty → None).
    pub fn layout_prompt(&self, provider: &str) -> Option<String> {
        let key = layout_provider_settings_key(provider)?;
        let guard = self.inner.lock().ok()?;
        let cfg = guard.layout.provider_configs.get(key)?;
        let prompt = cfg.prompt.trim();
        if prompt.is_empty() {
            None
        } else {
            Some(prompt.to_string())
        }
    }

    /// Resolve a layout-provider document language (empty → None; the MinerU
    /// engine falls back to `ch`).
    pub fn layout_language(&self, provider: &str) -> Option<String> {
        let key = layout_provider_settings_key(provider)?;
        let guard = self.inner.lock().ok()?;
        let cfg = guard.layout.provider_configs.get(key)?;
        let language = cfg.language.trim();
        if language.is_empty() {
            None
        } else {
            Some(language.to_string())
        }
    }

    /// Resolve a layout-provider force-OCR flag (default false).
    pub fn layout_is_ocr(&self, provider: &str) -> bool {
        layout_provider_settings_key(provider)
            .and_then(|key| {
                self.inner.lock().ok().map(|guard| {
                    guard
                        .layout
                        .provider_configs
                        .get(key)
                        .is_some_and(|cfg| cfg.is_ocr)
                })
            })
            .unwrap_or(false)
    }

    /// Resolve the configured embedding endpoint (base URL, API key, model).
    /// Returns None unless base URL and model are both set.
    pub fn embedding_config(&self) -> Option<(String, Option<String>, String)> {
        let guard = self.inner.lock().ok()?;
        let base_url = guard.embedding.base_url.trim();
        let model = guard.embedding.model.trim();
        if base_url.is_empty() || model.is_empty() {
            return None;
        }
        let api_key = guard.embedding.api_key.trim();
        let key = if api_key.is_empty() || is_translate_api_key_mask(api_key) {
            None
        } else {
            Some(api_key.to_string())
        };
        Some((base_url.to_string(), key, model.to_string()))
    }

    /// Raw `(tunnel_id, api_key)` for the built-in ChatGPT tunnel supervisor.
    /// Returns None unless both are set; a UI mask counts as unset so a
    /// `settings_get` → `settings_set` round-trip never leaks or wipes the key.
    pub fn mcp_tunnel_config(&self) -> Option<(String, String)> {
        let guard = self.inner.lock().ok()?;
        let id = guard.mcp_tunnel_id.trim().to_string();
        let key = guard.mcp_tunnel_api_key.trim();
        if id.is_empty() || key.is_empty() || is_translate_api_key_mask(key) {
            return None;
        }
        Some((id, key.to_string()))
    }
}

fn read_file(path: &PathBuf) -> (AppSettings, bool) {
    if !path.is_file() {
        return (AppSettings::default(), false);
    }
    match fs::read_to_string(path) {
        Ok(raw) => match serde_json::from_str::<AppSettings>(&raw) {
            Ok(mut s) => {
                normalize(&mut s);
                (s, true)
            }
            Err(e) => {
                log::warn!(
                    target: "agentero::settings",
                    "invalid settings.json ({}): {e}; using defaults",
                    path.display()
                );
                (AppSettings::default(), true)
            }
        },
        Err(e) => {
            log::warn!(
                target: "agentero::settings",
                "failed to read settings.json: {e}"
            );
            (AppSettings::default(), false)
        }
    }
}

fn persist(path: &Path, settings: &AppSettings) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    // Owner-only (0o600 on Unix) when secrets (BYOK keys) may live in this JSON.
    crate::core::fs::json_store_with(path, settings, &crate::core::fs::AtomicOpts::OWNER_ONLY)
}

/// Map Host translate provider id (any case) → settings `providerConfigs` key.
pub fn commercial_provider_settings_key(provider: &str) -> Option<&'static str> {
    match provider.trim().to_ascii_lowercase().as_str() {
        "deepl" => Some("deepl"),
        "azure" => Some("azure"),
        "googlecloud" => Some("googleCloud"),
        "openaicompatible" => Some("openaiCompatible"),
        _ => None,
    }
}

/// Map layout provider id (any case) → settings `layout.providerConfigs` key.
pub fn layout_provider_settings_key(provider: &str) -> Option<&'static str> {
    match provider.trim().to_ascii_lowercase().as_str() {
        "paddle" => Some("paddle"),
        "mineru" => Some("mineru"),
        "openaicompatible" => Some("openaiCompatible"),
        _ => None,
    }
}

/// Replace non-empty secrets with same-length `*` masks.
fn redact_secrets(mut settings: AppSettings) -> AppSettings {
    for cfg in settings.translate.provider_configs.values_mut() {
        if !cfg.api_key.trim().is_empty() {
            cfg.api_key = mask_translate_api_key(&cfg.api_key);
        }
    }
    for cfg in settings.layout.provider_configs.values_mut() {
        if !cfg.api_key.trim().is_empty() {
            cfg.api_key = mask_translate_api_key(&cfg.api_key);
        }
    }
    if !settings.embedding.api_key.trim().is_empty() {
        settings.embedding.api_key = mask_translate_api_key(&settings.embedding.api_key);
    }
    if !settings.mcp_tunnel_api_key.trim().is_empty() {
        settings.mcp_tunnel_api_key = mask_translate_api_key(&settings.mcp_tunnel_api_key);
    }
    settings
}

/// Apply incoming configs while preserving secrets when the UI sends the mask.
fn merge_secrets(incoming: &mut AppSettings, previous: &AppSettings) {
    for (id, cfg) in incoming.translate.provider_configs.iter_mut() {
        if is_translate_api_key_mask(&cfg.api_key) {
            if let Some(prev) = previous.translate.provider_configs.get(id) {
                cfg.api_key = prev.api_key.clone();
            } else {
                // Mask with no prior secret → treat as unset.
                cfg.api_key.clear();
            }
        }
    }
    for (id, cfg) in incoming.layout.provider_configs.iter_mut() {
        if is_translate_api_key_mask(&cfg.api_key) {
            if let Some(prev) = previous.layout.provider_configs.get(id) {
                cfg.api_key = prev.api_key.clone();
            } else {
                cfg.api_key.clear();
            }
        }
    }
    if is_translate_api_key_mask(&incoming.embedding.api_key) {
        incoming.embedding.api_key = previous.embedding.api_key.clone();
    }
    if is_translate_api_key_mask(&incoming.mcp_tunnel_api_key) {
        incoming.mcp_tunnel_api_key = previous.mcp_tunnel_api_key.clone();
    }
}

fn normalize(s: &mut AppSettings) {
    if s.connector_port == 0 {
        s.connector_port = default_connector_port();
    }
    if s.mcp_port == 0 {
        s.mcp_port = default_mcp_port();
    }
    s.mcp_tunnel_id = s
        .mcp_tunnel_id
        .split_whitespace()
        .collect::<String>()
        .to_ascii_lowercase();
    s.mcp_tunnel_api_key = s.mcp_tunnel_api_key.trim().to_string();
    if s.batch_import_concurrency < 1 || s.batch_import_concurrency > 10 {
        s.batch_import_concurrency = default_batch_import_concurrency();
    }
    let url = s.translator_base_url.trim().trim_end_matches('/');
    s.translator_base_url = if url.is_empty() {
        DEFAULT_TRANSLATOR_BASE_URL.to_string()
    } else {
        url.to_string()
    };
    s.network_proxy_url = s.network_proxy_url.trim().to_string();
    if s.network_proxy_url.is_empty() {
        s.network_proxy_url = default_network_proxy_url();
    }

    const LABEL_MODES: &[&str] = &["title-author", "title", "author-year-title", "folder"];
    if !LABEL_MODES.contains(&s.paper_tree_label_mode.as_str()) {
        s.paper_tree_label_mode = default_paper_tree_label_mode();
    }
    const SORT_MODES: &[&str] = &[
        "folder",
        "title",
        "author",
        "year-desc",
        "year-asc",
        "added-desc",
    ];
    if !SORT_MODES.contains(&s.paper_tree_sort_mode.as_str()) {
        s.paper_tree_sort_mode = default_paper_tree_sort_mode();
    }
    const NOTE_MODES: &[&str] = &["standard", "title-only", "blank", "custom"];
    if !NOTE_MODES.contains(&s.paper_note_mode.as_str()) {
        s.paper_note_mode = default_paper_note_mode();
    }
    const AUTO_UPDATE_INTERNAL_LINKS: &[&str] = &["ask", "always"];
    if !AUTO_UPDATE_INTERNAL_LINKS.contains(&s.auto_update_internal_links.as_str()) {
        s.auto_update_internal_links = default_auto_update_internal_links();
    }

    // Library columns: drop unknown/duplicate keys, append missing ones
    // (visible), and keep `title` visible so rows stay identifiable.
    let mut seen: Vec<String> = Vec::new();
    let mut cols: Vec<LibraryColumnPref> = Vec::new();
    for col in s.library_columns.drain(..) {
        if !LIBRARY_COLUMN_KEYS.contains(&col.key.as_str()) {
            continue;
        }
        if seen.iter().any(|k| k == &col.key) {
            continue;
        }
        seen.push(col.key.clone());
        cols.push(col);
    }
    for &key in LIBRARY_COLUMN_KEYS {
        if !seen.iter().any(|k| k == key) {
            cols.push(LibraryColumnPref {
                key: key.to_string(),
                visible: true,
            });
        }
    }
    for col in cols.iter_mut() {
        if col.key == "title" {
            col.visible = true;
        }
    }
    s.library_columns = cols;

    const THEMES: &[&str] = &["system", "light", "dark"];
    if !THEMES.contains(&s.theme.as_str()) {
        s.theme = default_theme();
    }
    s.ui_theme = s.ui_theme.trim().to_string();
    if s.ui_theme.is_empty() {
        s.ui_theme = default_ui_theme();
    }
    const LOCALES: &[&str] = &["system", "en", "zh-CN"];
    if !LOCALES.contains(&s.locale.as_str()) {
        s.locale = default_locale();
    }
    if s.editor_font_size < 10 || s.editor_font_size > 32 {
        s.editor_font_size = default_editor_font_size();
    }
    s.interface_font_family = normalize_font_family_value(&s.interface_font_family);
    s.text_font_family = normalize_font_family_value(&s.text_font_family);
    s.mono_font_family = normalize_font_family_value(&s.mono_font_family);
    // Migrate deprecated editorFontFamily preset into textFontFamily once.
    let legacy = normalize_font_family_value(&s.editor_font_family);
    if s.text_font_family.is_empty() && !legacy.is_empty() {
        s.text_font_family = legacy;
    }
    s.editor_font_family.clear();
    if !s.editor_line_height.is_finite() || s.editor_line_height < 1.4 || s.editor_line_height > 2.0
    {
        s.editor_line_height = default_editor_line_height();
    } else {
        // Snap to 0.1 steps to match the frontend slider.
        s.editor_line_height = (s.editor_line_height * 10.0).round() / 10.0;
    }
    const UI_SCALE_PRESETS: &[f64] = &[0.8, 0.9, 1.0, 1.25, 1.5];
    if !s.ui_scale.is_finite() {
        s.ui_scale = default_ui_scale();
    } else {
        let mut closest = UI_SCALE_PRESETS[0];
        let mut best = f64::INFINITY;
        for &preset in UI_SCALE_PRESETS {
            let d = (preset - s.ui_scale).abs();
            if d < best {
                best = d;
                closest = preset;
            }
        }
        s.ui_scale = closest;
    }
    const PERMS: &[&str] = &["restricted", "ask", "auto"];
    if !PERMS.contains(&s.agent_permission_mode.as_str()) {
        s.agent_permission_mode = default_permission_mode();
    }
    const AI_LANGS: &[&str] = &["auto", "en", "zh-CN"];
    if !AI_LANGS.contains(&s.ai_response_language.as_str()) {
        s.ai_response_language = default_ai_response_language();
    }

    s.pdf_ask.agent_id = s.pdf_ask.agent_id.trim().to_string();
    s.pdf_ask.model_id = s.pdf_ask.model_id.trim().to_string();

    // Keep trailing slashes on base_url (same reason as translate/layout configs):
    // normalize runs on every save and echoes back into the settings UI.
    s.embedding.base_url = s.embedding.base_url.trim().to_string();
    s.embedding.api_key = s.embedding.api_key.trim().to_string();
    s.embedding.model = s.embedding.model.trim().to_string();

    normalize_translate_provider_configs(&mut s.translate.provider_configs);
    s.translate.agent_id = s.translate.agent_id.trim().to_string();
    s.translate.model_id = s.translate.model_id.trim().to_string();
    const TR_TARGETS: &[&str] = &["ui", "en", "zh-CN"];
    if !TR_TARGETS.contains(&s.translate.target_lang.as_str()) {
        s.translate.target_lang = default_translate_target();
    }
    if s.translate.source_lang != "auto" {
        s.translate.source_lang = default_translate_source();
    }

    const LAYOUT_BACKENDS: &[&str] = &["local", "paddle", "mineru"];
    if !LAYOUT_BACKENDS.contains(&s.layout.backend.as_str()) {
        s.layout.backend = default_layout_backend();
    }
    const PARSER_BACKENDS: &[&str] = &["local", "paddle", "mineru", "openaiCompatible"];
    if !PARSER_BACKENDS.contains(&s.layout.parser_backend.as_str()) {
        s.layout.parser_backend = default_parser_backend();
    }
    normalize_layout_provider_configs(&mut s.layout.provider_configs);
}

fn normalize_layout_provider_configs(configs: &mut HashMap<String, LayoutProviderConfig>) {
    const PROVIDERS: &[&str] = &["paddle", "mineru", "openaiCompatible"];
    // MinerU `language` vocabulary (API v4); anything else resets to the
    // Chinese-English default so the request never carries an unknown pack id.
    const MINERU_LANGUAGES: &[&str] = &[
        "ch",
        "ch_server",
        "en",
        "japan",
        "korean",
        "chinese_cht",
        "ta",
        "te",
        "ka",
        "el",
        "th",
        "latin",
        "arabic",
        "cyrillic",
        "east_slavic",
        "devanagari",
    ];
    configs.retain(|k, _| PROVIDERS.contains(&k.as_str()));
    for cfg in configs.values_mut() {
        cfg.api_key = cfg.api_key.trim().to_string();
        // Keep trailing slashes (same reason as translate configs): normalize
        // runs on every save and echoes back into the settings UI.
        cfg.base_url = cfg.base_url.trim().to_string();
        cfg.model = cfg.model.trim().to_string();
        cfg.prompt = cfg.prompt.trim().to_string();
        cfg.language = cfg.language.trim().to_string();
        if !MINERU_LANGUAGES.contains(&cfg.language.as_str()) {
            cfg.language = "ch".to_string();
        }
    }
}

fn normalize_translate_provider_configs(configs: &mut HashMap<String, TranslateProviderConfig>) {
    const COMMERCIAL: &[&str] = &["deepl", "azure", "googleCloud", "openaiCompatible"];
    configs.retain(|k, _| COMMERCIAL.contains(&k.as_str()));
    for cfg in configs.values_mut() {
        cfg.api_key = cfg.api_key.trim().to_string();
        // Keep trailing slashes: this runs on every save and the result is
        // echoed back into the settings UI, so stripping "/" would make it
        // impossible to type paths like ".../v1". Endpoints trim on use.
        cfg.base_url = cfg.base_url.trim().to_string();
        cfg.region = cfg.region.trim().to_string();
        cfg.model = cfg.model.trim().to_string();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn roundtrip_defaults() {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("agentero-settings-test-{n}"));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("settings.json");
        let s = AppSettings::default();
        persist(&path, &s).expect("write");
        let (loaded, existed) = read_file(&path);
        assert!(existed);
        assert_eq!(loaded.theme, "system");
        assert_eq!(loaded.translator_base_url, DEFAULT_TRANSLATOR_BASE_URL);
        assert_eq!(loaded.auto_update_internal_links, "ask");
        assert_eq!(loaded.paper_note_mode, "standard");
        assert!(!loaded.onboarding_done);
        assert!(!loaded.feature_tour_done);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn onboarding_flags_roundtrip() {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("agentero-settings-onboarding-{n}"));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("settings.json");
        let s = AppSettings {
            onboarding_done: true,
            feature_tour_done: true,
            ..AppSettings::default()
        };
        persist(&path, &s).expect("write");
        let raw = fs::read_to_string(&path).expect("read json");
        let json: serde_json::Value = serde_json::from_str(&raw).expect("parse json");
        assert_eq!(json["onboardingDone"], true);
        assert_eq!(json["featureTourDone"], true);
        let (loaded, existed) = read_file(&path);
        assert!(existed);
        assert!(loaded.onboarding_done);
        assert!(loaded.feature_tour_done);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_onboarding_flags_default_false() {
        let json = r#"{"theme":"dark"}"#;
        let s: AppSettings = serde_json::from_str(json).expect("deserialize");
        assert!(!s.onboarding_done);
        assert!(!s.feature_tour_done);
        assert_eq!(s.theme, "dark");
    }

    #[test]
    fn normalize_empty_translator_url() {
        let mut s = AppSettings {
            translator_base_url: "  ".into(),
            ..AppSettings::default()
        };
        normalize(&mut s);
        assert_eq!(s.translator_base_url, DEFAULT_TRANSLATOR_BASE_URL);
    }

    #[test]
    fn redact_and_merge_api_keys() {
        let mut previous = AppSettings::default();
        previous.translate.provider_configs.insert(
            "deepl".into(),
            TranslateProviderConfig {
                api_key: "sk-secret".into(),
                ..Default::default()
            },
        );

        let redacted = redact_secrets(previous.clone());
        assert_eq!(
            redacted
                .translate
                .provider_configs
                .get("deepl")
                .map(|c| c.api_key.as_str()),
            Some("*********") // "sk-secret".chars().count()
        );
        assert!(is_translate_api_key_mask("*********"));
        assert!(!is_translate_api_key_mask("sk-secret"));

        let mut incoming = redacted;
        merge_secrets(&mut incoming, &previous);
        assert_eq!(
            incoming
                .translate
                .provider_configs
                .get("deepl")
                .map(|c| c.api_key.as_str()),
            Some("sk-secret")
        );

        // Explicit empty clears the secret.
        incoming
            .translate
            .provider_configs
            .get_mut("deepl")
            .unwrap()
            .api_key
            .clear();
        merge_secrets(&mut incoming, &previous);
        assert_eq!(
            incoming
                .translate
                .provider_configs
                .get("deepl")
                .map(|c| c.api_key.as_str()),
            Some("")
        );

        // MCP tunnel runtime key follows the same mask round-trip.
        let mut with_tunnel = AppSettings {
            mcp_tunnel_id: " Tunnel_ABC ".into(),
            mcp_tunnel_api_key: "  sk-tunnel-secret ".into(),
            ..AppSettings::default()
        };
        normalize(&mut with_tunnel);
        assert_eq!(with_tunnel.mcp_tunnel_id, "tunnel_abc");
        assert_eq!(with_tunnel.mcp_tunnel_api_key, "sk-tunnel-secret");

        let redacted_tunnel = redact_secrets(with_tunnel.clone());
        assert!(is_translate_api_key_mask(
            &redacted_tunnel.mcp_tunnel_api_key
        ));
        let mut echoed = redacted_tunnel;
        merge_secrets(&mut echoed, &with_tunnel);
        assert_eq!(echoed.mcp_tunnel_api_key, "sk-tunnel-secret");
    }

    #[test]
    fn commercial_provider_key_mapping() {
        assert_eq!(
            commercial_provider_settings_key("googleCloud"),
            Some("googleCloud")
        );
        assert_eq!(
            commercial_provider_settings_key("GOOGLECLOUD"),
            Some("googleCloud")
        );
        assert_eq!(
            commercial_provider_settings_key("openaiCompatible"),
            Some("openaiCompatible")
        );
        assert_eq!(commercial_provider_settings_key("deeplx"), None);
    }

    #[test]
    fn normalize_parser_backend_and_openai_compatible_config() {
        let mut s = AppSettings::default();
        s.layout.parser_backend = "bogus".into();
        s.layout.provider_configs.insert(
            "openaiCompatible".into(),
            LayoutProviderConfig {
                api_key: "  sk-x  ".into(),
                base_url: " https://api.siliconflow.cn/v1 ".into(),
                model: "  deepseek-ai/DeepSeek-OCR  ".into(),
                prompt: "  Convert to markdown.  ".into(),
                ..Default::default()
            },
        );
        s.layout
            .provider_configs
            .insert("unknown".into(), LayoutProviderConfig::default());
        normalize(&mut s);
        assert_eq!(s.layout.parser_backend, "local");
        assert!(!s.layout.provider_configs.contains_key("unknown"));
        let cfg = s.layout.provider_configs.get("openaiCompatible").unwrap();
        assert_eq!(cfg.api_key, "sk-x");
        assert_eq!(cfg.base_url, "https://api.siliconflow.cn/v1");
        assert_eq!(cfg.model, "deepseek-ai/DeepSeek-OCR");
        assert_eq!(cfg.prompt, "Convert to markdown.");

        let mut ok = AppSettings::default();
        ok.layout.parser_backend = "openaiCompatible".into();
        normalize(&mut ok);
        assert_eq!(ok.layout.parser_backend, "openaiCompatible");
    }

    #[test]
    fn layout_provider_key_accepts_openai_compatible() {
        assert_eq!(
            layout_provider_settings_key("OPENAICOMPATIBLE"),
            Some("openaiCompatible")
        );
    }

    #[test]
    fn normalize_layout_language_whitelist() {
        let mut s = AppSettings::default();
        s.layout.provider_configs.insert(
            "mineru".into(),
            LayoutProviderConfig {
                language: " japan ".into(),
                ..Default::default()
            },
        );
        normalize(&mut s);
        assert_eq!(
            s.layout.provider_configs.get("mineru").unwrap().language,
            "japan"
        );

        // Unknown / legacy value resets to the Chinese-English default.
        let mut s = AppSettings::default();
        s.layout.provider_configs.insert(
            "mineru".into(),
            LayoutProviderConfig {
                language: "auto".into(),
                ..Default::default()
            },
        );
        normalize(&mut s);
        assert_eq!(
            s.layout.provider_configs.get("mineru").unwrap().language,
            "ch"
        );
    }

    #[test]
    fn normalize_rejects_unknown_internal_link_rename_policy() {
        let mut s = AppSettings {
            auto_update_internal_links: "unsafe".into(),
            ..AppSettings::default()
        };
        normalize(&mut s);
        assert_eq!(s.auto_update_internal_links, "ask");
    }

    #[test]
    fn normalize_rejects_unknown_paper_note_mode() {
        let mut s = AppSettings {
            paper_note_mode: "fancy".into(),
            ..AppSettings::default()
        };
        normalize(&mut s);
        assert_eq!(s.paper_note_mode, "standard");
    }

    #[test]
    fn set_fires_subscribers_with_redacted_snapshot() {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("agentero-settings-sub-test-{n}"));
        let _ = fs::create_dir_all(&dir);
        let store = AppSettingsStore {
            inner: Mutex::new(AppSettings::default()),
            path: dir.join("settings.json"),
            listeners: Mutex::new(Vec::new()),
        };
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        {
            let seen = Arc::clone(&seen);
            store.subscribe(move |s| {
                seen.lock().unwrap().push(
                    s.translate
                        .provider_configs
                        .get("deepl")
                        .map_or(String::new(), |c| c.api_key.clone()),
                );
            });
        }

        let mut incoming = AppSettings::default();
        incoming.translate.provider_configs.insert(
            "deepl".into(),
            TranslateProviderConfig {
                api_key: "sk-secret".into(),
                ..Default::default()
            },
        );
        let out = store.set(incoming).expect("set");

        // Listener fired exactly once with the redacted snapshot.
        assert_eq!(*seen.lock().unwrap(), vec!["*********".to_string()]);
        assert_eq!(
            out.translate
                .provider_configs
                .get("deepl")
                .map(|c| c.api_key.as_str()),
            Some("*********")
        );
        // The plaintext secret is what lands on disk.
        let (loaded, _) = read_file(&store.path);
        assert_eq!(
            loaded
                .translate
                .provider_configs
                .get("deepl")
                .map(|c| c.api_key.as_str()),
            Some("sk-secret")
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn normalize_reconciles_library_columns() {
        let mut s = AppSettings {
            library_columns: vec![
                LibraryColumnPref {
                    key: "bogus".into(),
                    visible: true,
                },
                LibraryColumnPref {
                    key: "title".into(),
                    visible: false,
                },
                LibraryColumnPref {
                    key: "year".into(),
                    visible: false,
                },
            ],
            ..AppSettings::default()
        };
        normalize(&mut s);
        let keys: Vec<&str> = s.library_columns.iter().map(|c| c.key.as_str()).collect();
        // Unknown dropped; kept order first, then missing canonical columns appended.
        assert_eq!(keys, vec!["title", "year", "authors", "tags", "type", "id"]);
        // Title forced visible even though stored hidden.
        let title = s.library_columns.iter().find(|c| c.key == "title").unwrap();
        assert!(title.visible);
        // Non-title hidden preference preserved.
        let year = s.library_columns.iter().find(|c| c.key == "year").unwrap();
        assert!(!year.visible);
        // Appended column defaults to visible.
        let authors = s
            .library_columns
            .iter()
            .find(|c| c.key == "authors")
            .unwrap();
        assert!(authors.visible);
    }
}

/// Tauri command shells for this feature.
pub mod commands;
