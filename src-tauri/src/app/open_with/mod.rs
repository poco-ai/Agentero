//! "Open with" targets for the paper-folder button in the path bar.
//!
//! Mirrors the DSH `open-in-app` design: a fixed catalog (file manager,
//! editors, terminal) resolved against verified launchers, plus the **real**
//! application icon extracted from the installed `.app` bundle (`plutil` +
//! `sips`, as DSH does) so the menu never ships hand-drawn brand marks. A
//! platform or bundle without an extractable icon falls back to a generic
//! glyph in the UI. There is no Launch Services query and no disk scan: macOS
//! detection checks the known application folders only.

use crate::core::error::AppError;
use crate::core::process::SanitizeAppImageEnv;
#[cfg(target_os = "macos")]
use base64::engine::general_purpose::STANDARD as BASE64;
#[cfg(target_os = "macos")]
use base64::Engine as _;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

pub mod commands;

/// Stable id of the default file manager entry (Finder / Explorer / Files).
pub const FILE_MANAGER_ID: &str = "finder";
/// Stable id of the terminal entry; launches the Settings-preferred terminal.
pub const TERMINAL_ID: &str = "terminal";

/// Menu grouping/fallback-glyph hint for one entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum OpenWithKind {
    FileManager,
    Editor,
    Terminal,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenWithApp {
    /// Stable id used by `path_open_with`.
    pub id: String,
    /// Brand name shown verbatim.
    pub name: String,
    /// Grouping/fallback-glyph hint for the menu.
    pub kind: OpenWithKind,
    /// Real application icon as a PNG data URL; `None` when this platform has
    /// no extractable icon and the menu renders a generic glyph instead.
    pub icon: Option<String>,
}

struct EditorSpec {
    id: &'static str,
    name: &'static str,
    /// macOS `.app` base names (no extension), in probe order.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    mac_names: &'static [&'static str],
    /// CLI commands on PATH (Windows/Linux; macOS fallback for CLI installs).
    cli: &'static [&'static str],
}

/// Curated editor order. Xcode is deliberately absent: this menu is for
/// opening a paper folder, and the list stays to editors people actually use.
const EDITORS: &[EditorSpec] = &[
    EditorSpec {
        id: "cursor",
        name: "Cursor",
        mac_names: &["Cursor"],
        cli: &["cursor"],
    },
    EditorSpec {
        id: "vscode",
        name: "VS Code",
        mac_names: &["Visual Studio Code"],
        cli: &["code"],
    },
    EditorSpec {
        id: "zed",
        name: "Zed",
        mac_names: &["Zed"],
        cli: &["zed"],
    },
    EditorSpec {
        id: "sublime",
        name: "Sublime Text",
        mac_names: &["Sublime Text"],
        cli: &["subl"],
    },
];

/// Where an editor id resolves to on this machine.
struct Target {
    path: PathBuf,
    kind: LaunchKind,
}

enum LaunchKind {
    /// A macOS `.app` bundle; launching goes through Launch Services.
    #[cfg(target_os = "macos")]
    MacApp,
    /// A CLI launcher found on `PATH`.
    Cli,
}

/// Menu entries in display order: file manager, installed editors, terminal.
/// `terminal_preference` is the Settings `terminalApp` id (empty = system
/// default) and only names/illustrates the terminal row.
pub fn probe(terminal_preference: &str) -> Vec<OpenWithApp> {
    let mut apps = vec![file_manager_entry()];
    apps.extend(EDITORS.iter().filter_map(editor_entry));
    apps.push(terminal_entry(terminal_preference));
    apps
}

/// Open `path` with `app_id`: the file manager, the terminal, or a probed
/// editor. Directories open as themselves; files open their parent directory.
pub fn open(app_id: &str, path: &Path, terminal_preference: &str) -> Result<(), AppError> {
    let dir = folder_for_path(path)?;
    let app_id = app_id.trim();
    if app_id == FILE_MANAGER_ID {
        return open_in_file_manager(&dir);
    }
    if app_id == TERMINAL_ID {
        crate::app::terminal::open_in_terminal(&dir, terminal_preference)?;
        return Ok(());
    }
    let spec = EDITORS
        .iter()
        .find(|spec| spec.id == app_id)
        .ok_or_else(|| AppError::message(format!("unknown open-with app: {app_id}")))?;
    let target = resolve(spec)
        .ok_or_else(|| AppError::message(format!("{} is not installed", spec.name)))?;
    log::debug!(
        target: "agentero::open_with",
        "opening {} with {} ({})",
        dir.display(),
        spec.name,
        target.path.display()
    );
    match target.kind {
        #[cfg(target_os = "macos")]
        LaunchKind::MacApp => launch_mac_app(&target.path, &dir),
        LaunchKind::Cli => launch_cli(&target.path, &dir),
    }
}

fn file_manager_entry() -> OpenWithApp {
    #[cfg(target_os = "macos")]
    let (name, icon) = (
        "Finder",
        bundle_icon_data_url(Path::new("/System/Library/CoreServices/Finder.app")),
    );
    #[cfg(windows)]
    let (name, icon) = ("File Explorer", None);
    #[cfg(all(unix, not(target_os = "macos")))]
    let (name, icon) = ("File Manager", None);
    OpenWithApp {
        id: FILE_MANAGER_ID.to_string(),
        name: name.to_string(),
        kind: OpenWithKind::FileManager,
        icon,
    }
}

/// The terminal row follows the Settings preference so its name and icon match
/// the app that `path_open_with` actually launches.
fn terminal_entry(terminal_preference: &str) -> OpenWithApp {
    // The preference picker is macOS-only, so the row is generic elsewhere.
    #[cfg(not(target_os = "macos"))]
    let _ = terminal_preference;
    #[cfg(target_os = "macos")]
    let (name, icon) = {
        let preferred = match terminal_preference.trim() {
            "iterm" => mac_bundle(&["iTerm2", "iTerm"]).map(|bundle| ("iTerm2", bundle)),
            "otty" => mac_bundle(&["Otty"]).map(|bundle| ("Otty", bundle)),
            _ => None,
        };
        let (name, bundle) = preferred
            .or_else(|| terminal_bundle().map(|bundle| ("Terminal", bundle)))
            .unwrap_or_else(|| ("Terminal", PathBuf::new()));
        let icon = if bundle.as_os_str().is_empty() {
            None
        } else {
            bundle_icon_data_url(&bundle)
        };
        (name, icon)
    };
    #[cfg(not(target_os = "macos"))]
    let (name, icon) = ("Terminal", None);
    OpenWithApp {
        id: TERMINAL_ID.to_string(),
        name: name.to_string(),
        kind: OpenWithKind::Terminal,
        icon,
    }
}

fn editor_entry(spec: &EditorSpec) -> Option<OpenWithApp> {
    let target = resolve(spec)?;
    let icon = match target.kind {
        #[cfg(target_os = "macos")]
        LaunchKind::MacApp => bundle_icon_data_url(&target.path),
        LaunchKind::Cli => None,
    };
    Some(OpenWithApp {
        id: spec.id.to_string(),
        name: spec.name.to_string(),
        kind: OpenWithKind::Editor,
        icon,
    })
}

/// Validate the target and return the directory to open.
fn folder_for_path(path: &Path) -> Result<PathBuf, AppError> {
    if path.as_os_str().is_empty() {
        return Err(AppError::message("path is required"));
    }
    let meta = std::fs::metadata(path)
        .map_err(|e| AppError::message(format!("path not found ({}): {e}", path.display())))?;
    if meta.is_dir() {
        return Ok(path.to_path_buf());
    }
    path.parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .ok_or_else(|| AppError::message("cannot resolve parent directory"))
}

fn resolve(spec: &EditorSpec) -> Option<Target> {
    #[cfg(target_os = "macos")]
    if let Some(app) = mac_bundle(spec.mac_names) {
        return Some(Target {
            path: app,
            kind: LaunchKind::MacApp,
        });
    }
    for bin in spec.cli {
        if let Ok(path) = which::which(bin) {
            return Some(Target {
                path,
                kind: LaunchKind::Cli,
            });
        }
    }
    None
}

/// Locate a macOS `.app` in the standard application folders.
///
/// Known paths only, deliberately: DSH's catalog does the same and avoids
/// Spotlight/Launch Services work on every probe. A bundle moved outside these
/// folders simply does not appear; reinstalling brings it back.
#[cfg(target_os = "macos")]
fn mac_bundle(names: &[&str]) -> Option<PathBuf> {
    let mut dirs = vec![PathBuf::from("/Applications")];
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join("Applications"));
    }
    for dir in dirs {
        for name in names {
            let candidate = dir.join(format!("{name}.app"));
            if candidate.is_dir() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn terminal_bundle() -> Option<PathBuf> {
    [
        "/System/Applications/Utilities/Terminal.app",
        "/Applications/Utilities/Terminal.app",
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|path| path.is_dir())
}

/// Real application icon as a PNG data URL, extracted like DSH does it:
/// `plutil` reads `CFBundleIconFile` from the bundle, then `sips` converts the
/// `.icns` to a 128px PNG. Any failure yields `None` and the UI draws a
/// generic glyph.
#[cfg(target_os = "macos")]
fn bundle_icon_data_url(bundle: &Path) -> Option<String> {
    let resources = bundle.join("Contents").join("Resources");
    // A plist may name an icon that is not on disk; only then scan Resources.
    let icon_file = plist_icon_file(bundle)
        .filter(|name| resources.join(name).is_file())
        .or_else(|| first_icns(&resources))?;
    let icns = resources.join(icon_file);
    let work = tempfile::tempdir().ok()?;
    let out = work.path().join("icon.png");
    let status = command("sips")
        .args(["-s", "format", "png", "-Z", "128"])
        .arg(&icns)
        .arg("--out")
        .arg(&out)
        .status()
        .ok()?;
    if !status.success() {
        log::debug!(target: "agentero::open_with", "sips failed for {}", icns.display());
        return None;
    }
    let bytes = std::fs::read(&out).ok()?;
    Some(format!("data:image/png;base64,{}", BASE64.encode(bytes)))
}

/// `CFBundleIconFile` may omit the `.icns` extension.
#[cfg(target_os = "macos")]
fn plist_icon_file(bundle: &Path) -> Option<String> {
    let info = bundle.join("Contents").join("Info.plist");
    let output = command("plutil")
        .args(["-convert", "json", "-o", "-"])
        .arg(info)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    let declared = value.get("CFBundleIconFile")?.as_str()?.trim();
    if declared.is_empty() {
        return None;
    }
    Some(if declared.ends_with(".icns") {
        declared.to_string()
    } else {
        format!("{declared}.icns")
    })
}

#[cfg(target_os = "macos")]
fn first_icns(resources: &Path) -> Option<String> {
    let mut names: Vec<String> = std::fs::read_dir(resources)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.ends_with(".icns"))
        .collect();
    names.sort();
    names.into_iter().next()
}

fn open_in_file_manager(dir: &Path) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    let mut command = command("open");
    #[cfg(windows)]
    let mut command = command("explorer");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = command("xdg-open");
    command.arg(dir);
    spawn(command)
}

/// Launch a `.app` bundle so macOS resolves it exactly like Finder's Open With.
#[cfg(target_os = "macos")]
fn launch_mac_app(app: &Path, dir: &Path) -> Result<(), AppError> {
    let status = command("open")
        .arg("-a")
        .arg(app)
        .arg(dir)
        .status()
        .map_err(|e| AppError::message(format!("failed to open {}: {e}", app.display())))?;
    if !status.success() {
        return Err(AppError::message(format!(
            "failed to open {} (exit {status})",
            app.display()
        )));
    }
    Ok(())
}

/// Run an editor's CLI launcher with the folder as its argument.
fn launch_cli(bin: &Path, dir: &Path) -> Result<(), AppError> {
    #[cfg(windows)]
    let mut command = {
        let wrapper = bin
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"));
        if wrapper {
            // `.cmd`/`.bat` installers cannot be spawned directly on Windows.
            let mut command = command("cmd.exe");
            command.args(["/D", "/C"]).arg(bin);
            command
        } else {
            command(bin)
        }
    };
    #[cfg(not(windows))]
    let mut command = command(bin);
    command.arg(dir);
    #[cfg(windows)]
    crate::core::process::hide_console_window(&mut command);
    spawn(command)
}

fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    command.sanitize_appimage_env();
    command
}

/// Detach the child; the in-app action only needs the launch to be accepted.
fn spawn(mut command: Command) -> Result<(), AppError> {
    command
        .spawn()
        .map(|_| ())
        .map_err(|e| AppError::message(format!("failed to launch: {e}")))
}
