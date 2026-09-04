//! Opt-out product analytics via PostHog (desktop only).
//!
//! The project API key is baked in at build time via the
//! `AGENTERO_POSTHOG_KEY` environment variable; when unset (or in debug
//! builds) every entry point is a no-op, so local and OSS builds report
//! nothing. Users can additionally opt out via
//! `AppSettings::telemetry_enabled` (applies from the next launch).
//!
//! Payloads are limited to app-version and device-level facts. Vault paths,
//! file names, and document content are never sent. The `distinct_id` is a
//! random UUID persisted in the config directory.

use crate::core::paths;
use crate::core::usage::ActivityProjection;
use crate::features::agent::AgentTelemetrySummary;
use crate::features::settings::AppSettings;
use serde_json::json;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Build-time PostHog project API key; `None` disables telemetry entirely.
pub fn posthog_key() -> Option<&'static str> {
    option_env!("AGENTERO_POSTHOG_KEY")
        .map(str::trim)
        .filter(|key| !key.is_empty())
}

/// True when a key is compiled in, this is a release build, and the user
/// has not opted out.
pub fn enabled(settings: &AppSettings) -> bool {
    posthog_key().is_some() && !cfg!(debug_assertions) && settings.telemetry_enabled
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Stable anonymous install id (UUID v4 persisted in the config dir).
pub fn install_id() -> String {
    let path = paths::agentero_config_dir().join("telemetry_id");
    if let Ok(raw) = std::fs::read_to_string(&path) {
        let id = raw.trim();
        if !id.is_empty() {
            return id.to_string();
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let _ = std::fs::create_dir_all(paths::agentero_config_dir());
    let _ = std::fs::write(&path, &id);
    id
}

#[derive(Debug, Clone)]
pub struct DeviceInfo {
    pub os_name: String,
    pub os_version: String,
    pub arch: String,
    pub device_model: Option<String>,
}

pub fn collect_device_info() -> DeviceInfo {
    let info = os_info::get();
    DeviceInfo {
        os_name: info.os_type().to_string(),
        os_version: info.version().to_string(),
        arch: std::env::consts::ARCH.to_string(),
        device_model: device_model(),
    }
}

/// Best-effort hardware model (e.g. `Mac15,7`); never fails the report.
fn device_model() -> Option<String> {
    let model = raw_device_model()?.trim().to_string();
    (!model.is_empty()).then_some(model)
}

fn raw_device_model() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("sysctl")
            .args(["-n", "hw.model"])
            .output()
            .ok()?;
        Some(String::from_utf8_lossy(&out.stdout).into_owned())
    }
    #[cfg(target_os = "linux")]
    {
        std::fs::read_to_string("/sys/devices/virtual/dmi/id/product_name").ok()
    }
    #[cfg(target_os = "windows")]
    {
        let out = std::process::Command::new("reg")
            .args([
                "query",
                r"HKLM\HARDWARE\DESCRIPTION\System\BIOS",
                "/v",
                "SystemProductName",
            ])
            .output()
            .ok()?;
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .find_map(|line| line.split("REG_SZ").nth(1))
            .map(str::trim)
            .map(str::to_string)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        None
    }
}

/// Local UTC offset like `+08:00`.
fn timezone_offset() -> String {
    chrono::Local::now().offset().to_string()
}

struct Inner {
    client: Option<posthog_rs::Client>,
    distinct_id: String,
    session_id: String,
    started_at_ms: u64,
}

/// Managed app state. `inner` is `None` until [`Telemetry::start`] decides
/// reporting is enabled; all methods are no-ops in that case.
#[derive(Default)]
pub struct Telemetry {
    inner: Mutex<Option<Inner>>,
}

impl Telemetry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record local `app.started` and capture PostHog `app started` when
    /// product analytics is enabled. Local activity recording is always on;
    /// only the PostHog leg is gated by [`enabled`].
    /// Never fails the launch: every error is only logged.
    pub fn start(&self, settings: &AppSettings, agents: AgentTelemetrySummary) {
        let posthog_enabled = enabled(settings);

        let distinct_id = install_id();
        let session_id = uuid::Uuid::new_v4().to_string();
        let device = collect_device_info();
        let installed_agents = agents.templates;
        let custom_agent_count = agents.custom_count;
        let extra = json!({
            "app_version": APP_VERSION,
            "os_name": device.os_name,
            "os_version": device.os_version,
            "arch": device.arch,
            "device_model": device.device_model,
            "locale": settings.locale,
            "timezone": timezone_offset(),
            "tauri_version": tauri::VERSION,
            "session_id": session_id,
            "installed_agents": installed_agents.clone(),
            "custom_agent_count": custom_agent_count,
        });

        record_usage("app.started", None, extra.clone());

        let client = if posthog_enabled {
            posthog_key().map(posthog_rs::client)
        } else {
            None
        };
        if let Some(ref client) = client {
            let mut event = posthog_rs::Event::new("app started", distinct_id.as_str());
            let mut props = extra;
            if let Some(obj) = props.as_object_mut() {
                if let Some(sid) = obj.remove("session_id") {
                    obj.insert("$session_id".into(), sid);
                }
                obj.insert(
                    "$set".into(),
                    json!({
                        "app_version": APP_VERSION,
                        "os_name": device.os_name,
                        "os_version": device.os_version,
                        "arch": device.arch,
                        "device_model": device.device_model,
                        "installed_agents": installed_agents,
                        "custom_agent_count": custom_agent_count,
                    }),
                );
                obj.insert(
                    "$set_once".into(),
                    json!({ "first_app_version": APP_VERSION }),
                );
            }
            for (key, value) in props.as_object().expect("literal is an object") {
                if let Err(e) = event.insert_prop(key.clone(), value.clone()) {
                    log::warn!(target: "agentero::op", "telemetry prop {key} failed: {e}");
                }
            }
            client.capture(event);
            log::info!(target: "agentero::op", "op start telemetry enabled=true");
        }

        *self.inner.lock().unwrap() = Some(Inner {
            client,
            distinct_id,
            session_id,
            started_at_ms: now_ms(),
        });
    }

    /// Forward sanitized activity events to PostHog. No-op unless product
    /// analytics is enabled (i.e. the inner client is present). Each projection
    /// carries only bucketed/whitelisted fields — never paths, vault, or raw
    /// query/skill content.
    pub fn capture_activity(&self, projections: &[ActivityProjection]) {
        if projections.is_empty() {
            return;
        }
        let guard = self.inner.lock().unwrap();
        let Some(inner) = guard.as_ref() else {
            return;
        };
        let Some(client) = inner.client.as_ref() else {
            return;
        };
        for proj in projections {
            let mut event = posthog_rs::Event::new(proj.name, inner.distinct_id.as_str());
            let _ = event.insert_prop("$session_id", inner.session_id.clone());
            let _ = event.insert_prop("app_version", APP_VERSION);
            if let Some(facet) = &proj.facet {
                let _ = event.insert_prop("facet", facet.clone());
            }
            if let Some(status) = &proj.status {
                let _ = event.insert_prop("status", status.clone());
            }
            if let Some(qty) = proj.qty {
                let _ = event.insert_prop("qty", qty);
            }
            if let Some(bucket) = proj.dur_bucket {
                let _ = event.insert_prop("dur_bucket", bucket);
            }
            client.capture(event);
        }
    }

    /// Record local `app.exited`, then capture PostHog `app exited` and flush.
    /// Called from the synchronous `RunEvent::Exit` callback.
    pub fn shutdown(&self) {
        let Some(inner) = self.inner.lock().unwrap().take() else {
            return;
        };
        let duration_ms = now_ms().saturating_sub(inner.started_at_ms);
        record_usage(
            "app.exited",
            Some(duration_ms as i64),
            json!({
                "app_version": APP_VERSION,
                "session_id": inner.session_id,
            }),
        );
        let Some(client) = inner.client else {
            return;
        };
        let mut event = posthog_rs::Event::new("app exited", inner.distinct_id.as_str());
        let _ = event.insert_prop("$session_id", inner.session_id.clone());
        let _ = event.insert_prop("session_duration_ms", duration_ms);
        let _ = event.insert_prop("app_version", APP_VERSION);
        client.capture(event);
        client.flush();
    }
}

fn record_usage(kind: &str, dur_ms: Option<i64>, extra: serde_json::Value) {
    use crate::core::usage::{record_events, usage_db_path, UsageRecord};
    if let Err(e) = record_events(
        &usage_db_path(),
        &[UsageRecord {
            ts: None,
            vault: None,
            kind: kind.to_string(),
            path: None,
            mode: None,
            dur_ms,
            extra: Some(extra),
        }],
    ) {
        log::warn!(target: "agentero::usage", "record {kind} failed: {e}");
    }
}
