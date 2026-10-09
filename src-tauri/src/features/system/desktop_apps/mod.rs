//! Detect locally installed desktop apps that Agentero cannot drive over ACP.
//!
//! Vendors like OpenAI (ChatGPT), Alibaba (QwenWork / 千问办公) and Tencent
//! (WorkBuddy) ship GUI desktop apps that do not speak the Agent Client
//! Protocol. They therefore never show up in the ACP agent catalog; the Agent
//! settings pane lists them read-only so a user who has one installed
//! understands why and can still launch it.
//!
//! Detection is best-effort and local-only: app bundles / Spotlight on macOS,
//! registered installations and executable files on Windows. No account/cache
//! directories are used. Other platforms await their own installation probes.

pub mod commands;
#[cfg(windows)]
mod windows;

use crate::core::error::AppError;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Stable id the frontend keys rows and brand logos on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum DesktopAppId {
    Chatgpt,
    Qwenwork,
    Workbuddy,
    DshDesktop,
}

/// Detection result: macOS bundle or Windows executable path when known.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAppStatus {
    pub id: DesktopAppId,
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

struct AppSpec {
    id: DesktopAppId,
    /// macOS `.app` base names (no extension), in probe order.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    names: &'static [&'static str],
    /// Known macOS bundle identifiers, for apps moved out of `/Applications`.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    bundle_ids: &'static [&'static str],
    #[cfg(windows)]
    windows: windows::WinSpec,
}

/// Probe order is the display order in Settings.
const APPS: &[AppSpec] = &[
    AppSpec {
        id: DesktopAppId::Chatgpt,
        // The 2026 unified app is `ChatGPT.app` (com.openai.codex); the older
        // build ships as `ChatGPT Classic.app` (com.openai.chat).
        names: &["ChatGPT", "ChatGPT Classic"],
        bundle_ids: &["com.openai.codex", "com.openai.chat"],
        #[cfg(windows)]
        windows: windows::WinSpec {
            uninstall_names: &["ChatGPT", "ChatGPT Classic"],
            package_names: &["OpenAI.ChatGPT-Desktop", "OpenAI.ChatGPT", "OpenAI.Codex"],
            exe_names: &["ChatGPT.exe"],
            install_names: &["ChatGPT"],
            protocols: &[],
        },
    },
    AppSpec {
        id: DesktopAppId::Qwenwork,
        // Vendor bundle id is not published; match by bundle name.
        names: &["QwenWork", "千问办公"],
        bundle_ids: &[],
        #[cfg(windows)]
        windows: windows::WinSpec {
            uninstall_names: &["千问办公", "QwenWork", "QwenWorkCN"],
            package_names: &[],
            exe_names: &["QwenWork.exe", "QwenWorkCN.exe", "千问办公.exe"],
            install_names: &["QwenWork", "QwenWorkCN", "千问办公"],
            protocols: &[],
        },
    },
    AppSpec {
        id: DesktopAppId::Workbuddy,
        names: &["WorkBuddy AI", "WorkBuddy"],
        bundle_ids: &[],
        #[cfg(windows)]
        windows: windows::WinSpec {
            uninstall_names: &["WorkBuddy", "WorkBuddy AI"],
            package_names: &[],
            exe_names: &["WorkBuddy.exe"],
            install_names: &["WorkBuddy"],
            protocols: &["workbuddy"],
        },
    },
    AppSpec {
        id: DesktopAppId::DshDesktop,
        // Official Electron product name. The desktop shell is distinct from
        // the CLI's native ACP profile (`dsh --profile acp`).
        names: &["DeepSeek Harness"],
        bundle_ids: &[],
        #[cfg(windows)]
        windows: windows::WinSpec {
            uninstall_names: &["DeepSeek Harness"],
            package_names: &[],
            exe_names: &["DeepSeek Harness.exe"],
            install_names: &["DeepSeek Harness"],
            protocols: &["dsh"],
        },
    },
];

/// Probe every known desktop app. Cheap enough for the settings pane; still
/// call it off the UI thread because Spotlight lookups spawn `mdfind`.
pub fn probe_desktop_apps() -> Vec<DesktopAppStatus> {
    APPS.iter()
        .map(|spec| {
            let path = detect_app(spec);
            DesktopAppStatus {
                id: spec.id,
                installed: path.is_some(),
                path: path.map(|p| p.to_string_lossy().into_owned()),
            }
        })
        .collect()
}

/// Launch an installed app. Errors when the platform/open call fails; callers
/// gate on `installed` so a missing app should not normally reach here.
pub fn open_desktop_app(id: DesktopAppId) -> Result<(), AppError> {
    let spec = APPS
        .iter()
        .find(|spec| spec.id == id)
        .ok_or_else(|| AppError::message("unknown desktop app"))?;
    open_resolved(spec)
}

#[cfg(target_os = "macos")]
fn detect_app(spec: &AppSpec) -> Option<PathBuf> {
    for dir in app_search_dirs() {
        for name in spec.names {
            let candidate = dir.join(format!("{name}.app"));
            if candidate.is_dir() {
                return Some(candidate);
            }
        }
    }
    // Spotlight catches apps the user moved out of the standard folders. Bundle
    // id first (robust to renames), then the bundle file name.
    for id in spec.bundle_ids {
        if let Some(path) = spotlight_find(&format!("kMDItemCFBundleIdentifier == '{id}'")) {
            return Some(path);
        }
    }
    for name in spec.names {
        if let Some(path) = spotlight_find(&format!("kMDItemFSName == '{name}.app'")) {
            return Some(path);
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn app_search_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![PathBuf::from("/Applications")];
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join("Applications"));
    }
    dirs
}

#[cfg(target_os = "macos")]
fn spotlight_find(query: &str) -> Option<PathBuf> {
    let output = std::process::Command::new("mdfind")
        .arg(query)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .map(str::trim)
        .filter(|line| line.ends_with(".app"))
        .map(PathBuf::from)
        .find(|path| path.is_dir())
}

#[cfg(target_os = "macos")]
fn open_resolved(spec: &AppSpec) -> Result<(), AppError> {
    let mut command = std::process::Command::new("open");
    match detect_app(spec) {
        Some(path) => {
            command.arg(path);
        }
        None => {
            command.args(["-a", spec.names[0]]);
        }
    }
    let status = command
        .status()
        .map_err(|e| AppError::message(format!("failed to open {}: {e}", spec.names[0])))?;
    if !status.success() {
        return Err(AppError::message(format!(
            "failed to open {} (exit {status})",
            spec.names[0]
        )));
    }
    Ok(())
}

#[cfg(windows)]
fn detect_app(spec: &AppSpec) -> Option<PathBuf> {
    windows::detect(spec).map(|app| app.path)
}

#[cfg(windows)]
fn open_resolved(spec: &AppSpec) -> Result<(), AppError> {
    windows::open(spec)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn detect_app(_spec: &AppSpec) -> Option<PathBuf> {
    None
}

#[cfg(not(any(target_os = "macos", windows)))]
fn open_resolved(_spec: &AppSpec) -> Result<(), AppError> {
    Err(AppError::message(
        "desktop app detection is only available on macOS and Windows for now",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apps_are_unique_and_ordered() {
        assert_eq!(APPS.len(), 4);
        let mut seen = std::collections::HashSet::new();
        for spec in APPS {
            assert!(seen.insert(spec.id), "duplicate desktop app id");
            assert!(!spec.names.is_empty(), "app spec needs at least one name");
        }
        assert_eq!(APPS[0].id, DesktopAppId::Chatgpt);
        assert_eq!(APPS[1].id, DesktopAppId::Qwenwork);
        assert_eq!(APPS[2].id, DesktopAppId::Workbuddy);
        assert_eq!(APPS[3].id, DesktopAppId::DshDesktop);
    }

    #[test]
    fn ids_serialize_to_kebab_case() {
        let value = serde_json::to_value(DesktopAppId::Qwenwork).expect("serializes");
        assert_eq!(value, serde_json::json!("qwenwork"));
        assert_eq!(
            serde_json::to_value(DesktopAppId::DshDesktop).unwrap(),
            serde_json::json!("dsh-desktop")
        );
    }
}
