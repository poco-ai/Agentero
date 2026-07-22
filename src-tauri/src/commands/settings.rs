//! App settings commands — durable XDG config file.

use crate::error::AppError;
use crate::services::app_settings::{AppSettings, AppSettingsStore, SettingsGetResult};
use crate::services::connector::ConnectorController;
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub fn settings_get(store: State<'_, AppSettingsStore>) -> Result<SettingsGetResult, AppError> {
    store.get()
}

#[tauri::command]
pub fn settings_set(
    app: AppHandle,
    store: State<'_, AppSettingsStore>,
    connector: State<'_, Arc<ConnectorController>>,
    settings: AppSettings,
) -> Result<AppSettings, AppError> {
    let s = store.set(settings)?;
    let _ = connector.set_port(s.connector_port);
    // Keep every window's settings cache fresh (settings window, main windows).
    let _ = app.emit("settings:changed", &s);
    Ok(s)
}

/// Absolute path to the settings file (for About / diagnostics).
#[tauri::command]
pub fn settings_path(store: State<'_, AppSettingsStore>) -> Result<String, AppError> {
    Ok(store.path().to_string_lossy().into_owned())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostIdentity {
    /// Local machine hostname (best-effort).
    pub hostname: String,
    /// Short label for Settings host chip (hostname or "This computer").
    pub label: String,
    /// Guest OS family for brand icon: `macos` | `windows` | `linux` | `other`.
    pub os: String,
}

/// Local host identity for the Settings host badge.
#[tauri::command]
pub fn host_identity() -> Result<HostIdentity, AppError> {
    let hostname = local_hostname();
    let label = if hostname.is_empty() || hostname == "localhost" {
        "This computer".into()
    } else {
        hostname.clone()
    };
    Ok(HostIdentity {
        hostname,
        label,
        os: compile_os().into(),
    })
}

fn compile_os() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    }
}

fn local_hostname() -> String {
    std::process::Command::new("hostname")
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
            } else {
                None
            }
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "This computer".into())
}
