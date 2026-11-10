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
        // Two builds install under different bundle names and ids: the
        // international app is `QwenWork.app` (com.qwenwork.desktop.mac),
        // 千问办公 (China) is `QwenWorkCN.app` (cn.qwenwork.desktop.mac).
        names: &["QwenWork", "QwenWorkCN", "千问办公"],
        bundle_ids: &["com.qwenwork.desktop.mac", "cn.qwenwork.desktop.mac"],
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

/// Windows Dsh ships a CLI launcher beside its runtime. Reuse the native
/// installation probe so custom install locations work without scanning caches.
#[cfg(windows)]
pub(crate) fn dsh_cli_dir() -> Option<PathBuf> {
    let spec = APPS
        .iter()
        .find(|spec| spec.id == DesktopAppId::DshDesktop)?;
    let executable = detect_app(spec)?;
    dsh_cli_dir_for_executable(&executable)
}

#[cfg(any(windows, test))]
fn dsh_cli_dir_for_executable(executable: &std::path::Path) -> Option<PathBuf> {
    if !executable.is_file() {
        return None;
    }
    let resources = executable.parent()?.join("resources");
    let directory = resources.join("runtime/cli/bin");
    // The launcher invokes the installed Electron executable in run-as-node
    // mode and loads its CLI from app.asar. Never substitute the GUI executable.
    (resources.join("app.asar").is_file() && directory.join("dsh.cmd").is_file())
        .then_some(directory)
}

/// CLI engine a known desktop app ships inside its own bundle.
///
/// Agentero never drives these GUIs over ACP; it reuses the CLI the installer
/// already put on disk, so a user who only installed the desktop app still gets
/// the matching Agent. A PATH install always wins.
///
/// - QwenWork / 千问办公 ship `qoderclicn` in `Contents/Resources/bin`; the
///   `qoder-cn` template falls back to it. Verified 2026-11-10 by mounting both
///   official DMGs: `QwenWork.app` 1.4.0 and `QwenWorkCN.app` 2.0.0 both ship
///   `qoderclicn` 1.1.71, whose `--acp` initialize reports "Qoder CLI CN" (the
///   international bundle even updates from `static.qoder.com.cn`), so
///   `qodercli` must not fall back to it — that would switch account region.
/// - WorkBuddy ships Tencent's CodeBuddy CLI under
///   `Resources/app.asar.unpacked/cli/bin/codebuddy` (package `@genie/agent-cli`
///   advertises `codebuddy`, `codebuddy-code` and `cbc` with `--acp`).
///
/// Returns `None` for commands no known desktop app bundles.
pub(crate) fn bundled_cli(command: &str) -> Option<PathBuf> {
    let (app, directory, candidates) = bundled_cli_spec(command)?;
    let detected = detect_app(APPS.iter().find(|spec| spec.id == app)?)?;
    let resources = app_resources_dir(&detected)?;
    bundled_cli_in(&resources.join(directory), candidates)
}

/// `(app id, bin directory under Resources, candidate binary names)`.
///
/// `qodercn` is the CN template's dispatcher name (what the official installer
/// puts on PATH) while the engine inside the app keeps the product binary name
/// `qoderclicn`; accepting both keeps a future bundle rename from silently
/// disabling the fallback.
fn bundled_cli_spec(
    command: &str,
) -> Option<(DesktopAppId, &'static str, &'static [&'static str])> {
    match command {
        "qodercn" | "qoderclicn" => {
            Some((DesktopAppId::Qwenwork, "bin", &["qoderclicn", "qodercn"]))
        }
        "qodercli" | "qoder" => Some((DesktopAppId::Qwenwork, "bin", &["qodercli", "qoder"])),
        "codebuddy" | "codebuddy-code" | "cbc" => Some((
            DesktopAppId::Workbuddy,
            "app.asar.unpacked/cli/bin",
            &["codebuddy", "cbc"],
        )),
        _ => None,
    }
}

/// Resolve one of `candidates` inside the app's resources `bin/` directory.
///
/// Reuses the shared executable validation (`resolve_command_in_paths`) so a
/// leftover data file with the right name cannot report a usable engine, and
/// Windows picks up its PATHEXT/shim rules (`qoderclicn.exe`, …) for free.
fn bundled_cli_in(directory: &std::path::Path, candidates: &[&str]) -> Option<PathBuf> {
    let directory = std::path::PathBuf::from(directory);
    candidates.iter().find_map(|name| {
        crate::core::process::discover::resolve_command_in_paths(
            name,
            std::slice::from_ref(&directory),
        )
    })
}

/// macOS detects the `.app` bundle; Windows detects the GUI executable.
fn app_resources_dir(detected: &std::path::Path) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        Some(detected.join("Contents/Resources"))
    }
    #[cfg(windows)]
    {
        Some(detected.parent()?.join("resources"))
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = detected;
        None
    }
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
    detect_macos_app(spec.names, spec.bundle_ids)
}

/// Locate a macOS `.app` by base name or bundle id.
///
/// Shared with other native-app probes (for example the terminal picker), so
/// they use the same `/Applications` → Spotlight fallback order.
#[cfg(target_os = "macos")]
pub(crate) fn detect_macos_app(names: &[&str], bundle_ids: &[&str]) -> Option<PathBuf> {
    for dir in app_search_dirs() {
        for name in names {
            let candidate = dir.join(format!("{name}.app"));
            if candidate.is_dir() {
                return Some(candidate);
            }
        }
    }
    // Spotlight catches apps the user moved out of the standard folders. Bundle
    // id first (robust to renames), then the bundle file name.
    for id in bundle_ids {
        if let Some(path) = spotlight_find(&format!("kMDItemCFBundleIdentifier == '{id}'")) {
            return Some(path);
        }
    }
    for name in names {
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
    fn dsh_cli_requires_a_complete_desktop_installation() {
        let fixture = tempfile::tempdir().unwrap();
        let executable = fixture
            .path()
            .join("安装目录 with spaces/DeepSeek Harness.exe");
        let resources = executable.parent().unwrap().join("resources");
        let directory = resources.join("runtime/cli/bin");
        std::fs::create_dir_all(&directory).unwrap();
        assert!(dsh_cli_dir_for_executable(&executable).is_none());
        std::fs::write(&executable, b"MZ fixture").unwrap();
        std::fs::write(resources.join("app.asar"), b"fixture").unwrap();
        assert!(dsh_cli_dir_for_executable(&executable).is_none());
        std::fs::write(directory.join("dsh.cmd"), b"@echo off").unwrap();
        assert_eq!(dsh_cli_dir_for_executable(&executable), Some(directory));
    }

    #[test]
    fn qwenwork_probe_matches_both_macos_builds() {
        let spec = APPS
            .iter()
            .find(|spec| spec.id == DesktopAppId::Qwenwork)
            .expect("qwenwork spec");
        assert!(spec.names.contains(&"QwenWork"));
        assert!(spec.names.contains(&"QwenWorkCN"));
        assert!(spec.bundle_ids.contains(&"cn.qwenwork.desktop.mac"));
    }

    #[test]
    fn bundled_cli_spec_maps_only_known_desktop_apps() {
        let (app, dir, names) = bundled_cli_spec("qodercn").expect("CN qoder");
        assert_eq!(app, DesktopAppId::Qwenwork);
        assert_eq!(dir, "bin");
        assert!(names.contains(&"qoderclicn"));

        let (app, dir, names) = bundled_cli_spec("codebuddy").expect("codebuddy");
        assert_eq!(app, DesktopAppId::Workbuddy);
        assert_eq!(dir, "app.asar.unpacked/cli/bin");
        assert!(names.contains(&"codebuddy"));

        // The CN template must never be pointed at the international engine.
        let (_, _, cn_names) = bundled_cli_spec("qodercn").unwrap();
        let (_, _, intl_names) = bundled_cli_spec("qodercli").unwrap();
        assert!(!cn_names.contains(&"qodercli"));
        assert!(!intl_names.contains(&"qoderclicn"));
        assert!(bundled_cli_spec("codex").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn bundled_cli_requires_an_executable() {
        use std::os::unix::fs::PermissionsExt;

        fn write_executable(path: &std::path::Path) {
            std::fs::write(path, b"fixture").unwrap();
            let mut permissions = std::fs::metadata(path).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(path, permissions).unwrap();
        }

        let fixture = tempfile::tempdir().unwrap();
        let cn = &["qoderclicn", "qodercn"];
        assert!(bundled_cli_in(fixture.path(), cn).is_none());

        let path = fixture.path().join("qoderclicn");
        std::fs::write(&path, b"fixture").unwrap();
        // Plain data files are not runnable engines.
        assert!(bundled_cli_in(fixture.path(), cn).is_none());

        write_executable(&path);
        assert_eq!(bundled_cli_in(fixture.path(), cn), Some(path));
    }

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
