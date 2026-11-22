//! Detect locally installed desktop apps that Agentero cannot drive over ACP.
//!
//! Vendors like OpenAI (ChatGPT), Alibaba (QwenWork / 千问办公) and Tencent
//! (WorkBuddy) ship GUI desktop apps that do not speak the Agent Client
//! Protocol. They therefore never show up in the ACP agent catalog; the Agent
//! settings pane lists them read-only so a user who has one installed
//! understands why and can still launch it.
//!
//! Detection is best-effort and local-only: app bundles / Spotlight on macOS,
//! registered installations and executable files on Windows, and desktop
//! entries / Flatpak / Snap / scheme handlers on Linux. No account/cache
//! directories are used.

pub mod commands;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(windows)]
mod windows;

use crate::core::error::AppError;
#[cfg(target_os = "macos")]
use crate::core::process::SpawnInAgentScratchDir;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Stable id the frontend keys rows and brand logos on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum DesktopAppId {
    Chatgpt,
    Qwenwork,
    Workbuddy,
    DshDesktop,
}

/// Detection result: the installed executable (or macOS bundle) path when known.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAppStatus {
    pub id: DesktopAppId,
    pub installed: bool,
    /// True when the vendor ships no build for this platform, so the row can
    /// never become installed here.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unsupported: bool,
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
    /// `None` when the vendor ships no Linux build, so the row can never
    /// report an installation there.
    #[cfg(target_os = "linux")]
    linux: Option<linux::LinuxSpec>,
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
        // The official `.deb` registers `chatgpt.desktop` (`Exec=chatgpt`, a
        // `codex-launcher` shim) with the payload in `/usr/lib/chatgpt`, and
        // ships `resources/codex` (verified 2026-11-22: 26.1117.41037,
        // `codex-cli 0.171.0-alpha.13` on aarch64). Community Flatpak / Snap
        // registrations share the ids and names below.
        #[cfg(target_os = "linux")]
        linux: Some(linux::LinuxSpec {
            desktop_names: &["ChatGPT", "chatgpt"],
            display_name: "ChatGPT",
            app_ids: &["com.openai.chatgpt", "com.openai.codex"],
            snap_names: &["chatgpt"],
            protocols: &[],
            // `resources/codex`, resolved by `linux::bundled_cli`.
            bundled_cli: Some(("", &["codex"])),
        }),
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
        // Verified 2026-11-22 against `qwenworkcn-linux-arm64.deb` 1.3.1: the
        // payload is `/opt/apps/QwenWorkCN`, the desktop entry is
        // `qwen-work-cn.desktop` (`Name=千问办公`), and the CN engine ships as
        // `resources/bin/qoderclicn` 1.1.59 (`--acp` initialize reports
        // "Qoder CLI CN").
        #[cfg(target_os = "linux")]
        linux: Some(linux::LinuxSpec {
            desktop_names: &["qwen-work-cn", "qwenwork-cn", "QwenWorkCN"],
            display_name: "千问办公",
            app_ids: &["cn.qwenwork.desktop", "com.qwenwork.desktop"],
            snap_names: &["qwenwork"],
            protocols: &["qwenwork-cn"],
            bundled_cli: Some(("bin", &["qoderclicn", "qodercli", "qodercn"])),
        }),
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
        // Verified 2026-11-22 against `workbuddy` 5.6.2 (arm64 deb): installed
        // in `/opt/WorkBuddy`, entry `workbuddy.desktop`, engine
        // `resources/app.asar.unpacked/cli/bin/codebuddy` (a Node launcher; it
        // boots with `resources/runtime/node/bin/node`, which
        // `linux::bundled_cli_dirs` adds to the child PATH). `--acp`
        // initialize answers with its auth methods.
        #[cfg(target_os = "linux")]
        linux: Some(linux::LinuxSpec {
            desktop_names: &["workbuddy", "WorkBuddy"],
            display_name: "WorkBuddy",
            app_ids: &["com.tencent.workbuddy"],
            snap_names: &["workbuddy"],
            protocols: &["workbuddy"],
            bundled_cli: Some((
                "app.asar.unpacked/cli/bin",
                &["codebuddy", "codebuddy-code", "cbc"],
            )),
        }),
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
        // Dsh Desktop has no Linux build (deepseek.com/download ships only
        // .dmg and .exe), so Linux reports the row as unsupported. Run the CLI
        // instead: `npm i -g @deepseek-ai/dsh` gives the Agent its native ACP
        // profile (`dsh --profile acp`).
        #[cfg(target_os = "linux")]
        linux: None,
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

/// Detection results are cached briefly: Spotlight lookups spawn `mdfind` and
/// the agent catalog re-probes every template on each scan. A short TTL keeps
/// repeated scans cheap while still noticing an app installed mid-session; an
/// installer also calls [`invalidate_detect_cache`].
const DETECT_TTL: Duration = Duration::from_secs(60);

type DetectCache = HashMap<DesktopAppId, (Instant, Option<PathBuf>)>;
static DETECT_CACHE: OnceLock<Mutex<DetectCache>> = OnceLock::new();

fn detect_cache() -> &'static Mutex<DetectCache> {
    DETECT_CACHE.get_or_init(Default::default)
}

/// Forget cached detections (call after installing or removing an app).
pub fn invalidate_detect_cache() {
    if let Some(cache) = DETECT_CACHE.get() {
        cache
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
    }
}

/// Cached [`detect_app_uncached`]. Negative results matter most: a missing app
/// costs two `mdfind` spawns per lookup, and the catalog asks several times
/// per scan.
fn detect_app(spec: &AppSpec) -> Option<PathBuf> {
    if let Some((probed_at, path)) = detect_cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(&spec.id)
    {
        if probed_at.elapsed() < DETECT_TTL {
            return path.clone();
        }
    }
    detect_app_fresh(spec)
}

/// Detect one app now and refresh its cache entry. Settings probes with this so
/// a user who just installed an app sees it immediately; catalog scans use the
/// cached [`detect_app`] and stay cheap.
fn detect_app_fresh(spec: &AppSpec) -> Option<PathBuf> {
    let path = detect_app_uncached(spec);
    detect_cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(spec.id, (Instant::now(), path.clone()));
    path
}

/// Probe every known desktop app from scratch. Settings owns this surface, so
/// it must not serve a stale TTL entry; the call still spawns `mdfind`, hence
/// the command keeps it on the blocking pool.
pub fn probe_desktop_apps() -> Vec<DesktopAppStatus> {
    APPS.iter()
        .map(|spec| {
            let path = detect_app_fresh(spec);
            DesktopAppStatus {
                id: spec.id,
                installed: path.is_some(),
                unsupported: !supported_on_this_platform(spec),
                path: path.map(|p| p.to_string_lossy().into_owned()),
            }
        })
        .collect()
}

/// Whether the vendor ships a desktop build for this Host's platform.
#[cfg(target_os = "linux")]
fn supported_on_this_platform(spec: &AppSpec) -> bool {
    spec.linux.is_some()
}

#[cfg(not(target_os = "linux"))]
fn supported_on_this_platform(_spec: &AppSpec) -> bool {
    true
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

#[cfg(windows)]
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

/// Standalone runtimes only: never run a GUI executable as a Node substitute.
#[cfg(windows)]
fn windows_node_dirs() -> Vec<PathBuf> {
    [
        (DesktopAppId::Chatgpt, "cua_node/bin"),
        (
            DesktopAppId::DshDesktop,
            "runtime/primary-runtime/dependencies/node/bin",
        ),
    ]
    .into_iter()
    .filter_map(|(id, directory)| {
        let executable = detect_app(APPS.iter().find(|spec| spec.id == id)?)?;
        Some(app_resources_dir(&executable)?.join(directory))
    })
    .collect()
}

/// Append desktop CLI/runtime directories after user-owned PATH installations.
#[cfg(windows)]
pub(crate) fn windows_cli_dirs() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for command in ["codex", "qodercn", "qodercli", "codebuddy", "node"] {
        if let Some(binary) = bundled_cli(command) {
            if let Some(parent) = binary.parent() {
                let dir = parent.to_path_buf();
                if !paths.contains(&dir) {
                    paths.push(dir);
                }
            }
        }
    }
    if let Some(directory) = dsh_cli_dir() {
        if !paths.contains(&directory) {
            paths.push(directory);
        }
    }
    paths
}

#[cfg(target_os = "linux")]
pub(crate) fn linux_cli_dirs() -> Vec<PathBuf> {
    APPS.iter()
        .flat_map(|spec| {
            linux::bundled_cli_dirs(spec, &["codex", "qodercn", "qodercli", "codebuddy", "cbc"])
        })
        .fold(Vec::new(), |mut dirs, dir| {
            if !dirs.contains(&dir) {
                dirs.push(dir);
            }
            dirs
        })
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
    // Standalone runtimes only: never run a GUI executable as a Node
    // substitute.
    #[cfg(windows)]
    if command == "node" {
        return windows_node_dirs()
            .into_iter()
            .find_map(|dir| bundled_cli_in(&dir, &["node"]));
    }
    let (app, directory, candidates) = bundled_cli_spec(command)?;
    let spec = APPS.iter().find(|spec| spec.id == app)?;
    #[cfg(target_os = "linux")]
    {
        // The Linux payload sits in a per-install tree (`/opt`, Flatpak, Snap),
        // not next to a known bundle name, so resolve it through the install
        // probe instead of the Windows/macOS resources layout.
        let _ = (directory, candidates);
        linux::bundled_cli(spec, command)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let resources = app_resources_dir(&detect_app(spec)?)?;
        bundled_cli_in(&resources.join(directory), candidates)
    }
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
        // The Windows installer keeps `codex` at the payload root; the Linux
        // `.deb` puts it at `resources/codex`, which `linux::bundled_cli`
        // resolves through the install probe.
        #[cfg(any(windows, target_os = "linux"))]
        "codex" => Some((DesktopAppId::Chatgpt, "", &["codex"])),
        "qodercn" | "qoderclicn" => {
            Some((DesktopAppId::Qwenwork, "bin", &["qoderclicn", "qodercn"]))
        }
        "qodercli" | "qoder" => Some((DesktopAppId::Qwenwork, "bin", &["qodercli", "qoder"])),
        "codebuddy" | "codebuddy-code" | "cbc" => Some((
            DesktopAppId::Workbuddy,
            "app.asar.unpacked/cli/bin",
            &["codebuddy", "cbc"],
        )),
        // Dsh Desktop's launcher lives beside its runtime; the launcher itself
        // loads the ASAR payload, so the GUI binary is never handed to ACP.
        #[cfg(any(windows, target_os = "macos"))]
        "dsh" => Some((DesktopAppId::DshDesktop, "runtime/cli/bin", &["dsh"])),
        _ => None,
    }
}

/// Resolve one of `candidates` inside the app's resources `bin/` directory.
///
/// Reuses the shared executable validation (`resolve_command_in_paths`) so a
/// leftover data file with the right name cannot report a usable engine, and
/// Windows picks up its PATHEXT/shim rules (`qoderclicn.exe`, …) for free.
#[cfg_attr(target_os = "linux", allow(dead_code))]
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
#[cfg_attr(target_os = "linux", allow(dead_code))]
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
fn detect_app_uncached(spec: &AppSpec) -> Option<PathBuf> {
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
    let mut command = std::process::Command::new("mdfind");
    command.arg(query).spawn_in_agent_scratch_dir();
    let output = command.output().ok()?;
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
    command.spawn_in_agent_scratch_dir();
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
fn detect_app_uncached(spec: &AppSpec) -> Option<PathBuf> {
    windows::detect(spec).map(|app| app.path)
}

#[cfg(windows)]
fn open_resolved(spec: &AppSpec) -> Result<(), AppError> {
    windows::open(spec)
}

#[cfg(target_os = "linux")]
fn detect_app_uncached(spec: &AppSpec) -> Option<PathBuf> {
    linux::detect(spec).map(|app| app.executable)
}

#[cfg(target_os = "linux")]
fn open_resolved(spec: &AppSpec) -> Result<(), AppError> {
    linux::open(spec)
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
fn detect_app_uncached(_spec: &AppSpec) -> Option<PathBuf> {
    None
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
fn open_resolved(_spec: &AppSpec) -> Result<(), AppError> {
    Err(AppError::message(
        "desktop app detection is only available on macOS, Windows and Linux",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Dsh Desktop ships only on macOS and Windows. Linux must report it as
    /// unsupported and must never reuse a desktop CLI for it.
    #[test]
    fn dsh_desktop_is_unsupported_on_linux_only() {
        assert_eq!(
            bundled_cli_spec("dsh").is_some(),
            cfg!(any(windows, target_os = "macos"))
        );
        let dsh = APPS
            .iter()
            .find(|spec| spec.id == DesktopAppId::DshDesktop)
            .expect("dsh spec");
        assert_eq!(supported_on_this_platform(dsh), !cfg!(target_os = "linux"));
        #[cfg(target_os = "linux")]
        assert!(dsh.linux.is_none(), "no Linux build to probe");
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
        assert_eq!(
            bundled_cli_spec("codex").is_some(),
            cfg!(any(windows, target_os = "linux"))
        );

        #[cfg(target_os = "linux")]
        {
            let qwen = APPS
                .iter()
                .find(|spec| spec.id == DesktopAppId::Qwenwork)
                .unwrap();
            assert!(qwen
                .linux
                .as_ref()
                .unwrap()
                .bundled_cli
                .unwrap()
                .1
                .contains(&"qoderclicn"));
            assert!(supported_on_this_platform(qwen));
        }
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
