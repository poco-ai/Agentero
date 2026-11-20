//! Headless CLI discovery, optional GitHub download, PATH install, and uninstall.
//!
//! The desktop bundle carries an offline CLI for agent turns.
//! Settings → About installs the **same app version** CLI from GitHub Releases
//! when no local or bundled binary is available. PATH entry is a user-bin
//! shim; shell rc files are never edited.
//!
//! Dev note: the cargo bin is named `agentero-cli` so it never collides with
//! the GUI binary `agentero` in `target/{debug,release}/`.

mod download;
#[cfg(windows)]
pub(crate) mod windows_path;

use crate::core::error::AppError;
use crate::core::paths::agentero_config_dir;
use download::{
    download_and_extract, host_triple, managed_binary_name, release_download_url,
    release_tag_page_url, versions_equal,
};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(not(target_os = "macos"))]
use tauri::Manager;
use tauri::{AppHandle, Runtime};

pub mod commands;

// Windows: shim is `agentero-cli.cmd` so the installed command matches the
// actual binary name on PATH (`agentero-cli`); POSIX keeps the bare `agentero`
// symlink for muscle memory and Homebrew-style usage.
const SHIM_NAME: &str = if cfg!(windows) {
    "agentero-cli.cmd"
} else {
    "agentero"
};

/// The command a user types after install (platform-consistent with the shim).
pub(crate) fn cli_command_name() -> &'static str {
    if cfg!(windows) {
        "agentero-cli"
    } else {
        "agentero"
    }
}

const BUNDLED_CLI_NAME: &str = if cfg!(windows) {
    "agentero-cli.exe"
} else {
    "agentero-cli"
};

/// Reject placeholder files: empty stubs, and on Windows anything that is not
/// a real PE image. The historical externalBin stub was a batch script renamed
/// to `.exe`; executing it made Windows pop the scary "unsupported 16-bit
/// application" dialog on end-user machines, so probing must never run it.
const MIN_CLI_BYTES: u64 = 1;

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CliInstallStatus {
    /// App package version (from Cargo / Tauri).
    pub app_version: String,
    /// Version reported by the resolved CLI binary, if present.
    pub bundled_version: Option<String>,
    /// Absolute path to a runnable CLI (bundled, managed cache, or dev), if any.
    pub bundled_path: Option<String>,
    /// Where the binary came from: `bundled` | `managed` | `dev`.
    pub source: Option<String>,
    /// Version reported by the CLI we would / did install (alias clarity for UI).
    pub cli_version: Option<String>,
    /// Expected GitHub Release asset URL for this app version + host triple.
    pub download_url: Option<String>,
    /// Tag page for manual download / troubleshooting.
    pub release_page_url: String,
    /// Host can install (local binary available or download supported on this OS).
    pub can_install: bool,
    /// Whether a user-level shim/link we manage is installed.
    pub installed: bool,
    /// Whether startup may install the CLI; explicit uninstall disables it.
    pub auto_install_enabled: bool,
    /// Where the managed shim lives.
    pub install_path: Option<String>,
    /// Shim points at our CLI and CLI version matches the app.
    pub shim_current: bool,
    /// Preferred install directory for new installs.
    pub preferred_bin_dir: String,
    /// Whether the preferred bin dir is currently on PATH.
    pub preferred_bin_on_path: bool,
    /// Whether a `brew` executable is available (PATH or standard Homebrew roots).
    pub brew_available: bool,
    /// Command users type after install (`agentero-cli` on Windows, `agentero` elsewhere).
    pub command_name: &'static str,
    /// Human-readable note (e.g. PATH hint).
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CliInstallResult {
    pub status: CliInstallStatus,
    pub action: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedCli {
    path: PathBuf,
    source: &'static str,
    version: Option<String>,
}

fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

fn is_plausible_cli_file(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    // Size alone is not enough (dev shell scripts are small); empty stubs are.
    if !meta.is_file() || meta.len() < MIN_CLI_BYTES {
        return false;
    }
    // Windows: require a genuine PE (MZ magic) before `--version` probing ever
    // execs the file — batch/shell text renamed to `.exe` would otherwise raise
    // the system 16-bit-incompatibility dialog.
    if cfg!(windows) {
        return has_pe_magic(path);
    }
    true
}

/// True when the file starts with the DOS/PE `MZ` magic bytes.
fn has_pe_magic(path: &Path) -> bool {
    use std::io::Read;
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut magic = [0u8; 2];
    file.read_exact(&mut magic).is_ok() && magic == *b"MZ"
}

/// True when the file looks real and can report a version.
#[cfg(test)]
fn is_runnable_cli(path: &Path) -> bool {
    is_plausible_cli_file(path) && read_cli_version(path).is_some()
}

/// `is_runnable_cli` in one spawn: About status reads probe every About open,
/// so probing the version twice per candidate doubles the block.
fn probe_cli_version(path: &Path) -> Option<String> {
    if !is_plausible_cli_file(path) {
        return None;
    }
    read_cli_version(path)
}

/// Directory for the downloaded/managed CLI binary (outside the App bundle).
pub(crate) fn managed_cli_dir() -> PathBuf {
    if let Some(base) = dirs::data_local_dir() {
        return base.join("Agentero").join("cli");
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".local")
        .join("share")
        .join("Agentero")
        .join("cli")
}

pub(crate) fn managed_cli_binary() -> PathBuf {
    managed_cli_dir()
        .join(format!("v-{}", app_version()))
        .join(managed_binary_name())
}

/// Written when the user uninstalls the CLI, so startup does not install it
/// again. Cleared by a manual install from Settings.
pub(crate) fn auto_install_opt_out_path() -> PathBuf {
    agentero_config_dir().join("cli.removed")
}

pub(crate) fn auto_install_opted_out() -> bool {
    auto_install_opt_out_path().exists()
}

pub(crate) fn set_auto_install_enabled(enabled: bool) -> Result<(), AppError> {
    set_auto_install_enabled_at(&auto_install_opt_out_path(), enabled)
}

fn set_auto_install_enabled_at(marker: &Path, enabled: bool) -> Result<(), AppError> {
    if enabled {
        match fs::remove_file(marker) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    } else {
        if let Some(parent) = marker.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(marker, "")?;
        Ok(())
    }
}

/// Delete only our known pair of cached files. A running Windows CLI can keep
/// an older version open; another install or uninstall can clean it up later.
pub(crate) fn clean_managed_cache(keep: Option<&Path>) {
    let root = managed_cli_dir();
    let library = agentero_core::features::paper::analyze::parse::pdfium_library_file_name();
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if Some(path.as_path()) == keep
                || !entry.file_name().to_string_lossy().starts_with("v-")
                || !entry.file_type().is_ok_and(|t| t.is_dir())
            {
                continue;
            }
            let _ = fs::remove_file(path.join(managed_binary_name()));
            let _ = fs::remove_file(path.join(library));
            let _ = fs::remove_dir(path);
        }
    }
    // Previous versions kept their cached pair directly in this directory.
    let _ = fs::remove_file(root.join(managed_binary_name()));
    let _ = fs::remove_file(root.join(library));
    let _ = fs::remove_dir(root);
}

fn shipped_cli<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    let path = {
        let _ = app;
        std::env::current_exe()
            .ok()?
            .parent()?
            .join("agentero-turn")
    };
    #[cfg(not(target_os = "macos"))]
    let path = app
        .path()
        .resource_dir()
        .ok()?
        .join("cli")
        .join(BUNDLED_CLI_NAME);
    is_plausible_cli_file(&path).then_some(path)
}

pub(crate) fn turn_cli(app: &AppHandle) -> Option<PathBuf> {
    agentero_core::features::open_request::desktop::active_endpoint()?;
    shipped_cli(app).or_else(|| {
        resolve_local_cli(app)
            .filter(|cli| {
                cli.version
                    .as_deref()
                    .is_some_and(|v| versions_equal(v, &app_version()))
            })
            .map(|cli| cli.path)
    })
}

pub(crate) fn resolve_local_cli<R: Runtime>(app: &AppHandle<R>) -> Option<ResolvedCli> {
    let mut candidates = vec![(managed_cli_binary(), "managed")];
    if let Some(path) = shipped_cli(app) {
        candidates.push((path, "bundled"));
    }
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.join(BUNDLED_CLI_NAME)))
    {
        candidates.push((path, "dev"));
    }
    candidates.into_iter().find_map(|(path, source)| {
        let version = probe_cli_version(&path)?;
        versions_equal(&version, &app_version()).then(|| ResolvedCli {
            path: crate::core::fs::canonicalize_best_effort(&path),
            source,
            version: Some(version),
        })
    })
}

fn read_cli_version(bin: &Path) -> Option<String> {
    let mut command = Command::new(bin);
    agentero_core::process::hide_console_window(&mut command);
    let output = command.arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    // clap: `agentero-cli 0.5.1` or `agentero 0.5.1`
    let line = text.lines().next()?.trim();
    if line.is_empty() {
        return None;
    }
    // Prefer the last whitespace-separated token that looks like a version.
    let ver = line
        .split_whitespace()
        .rev()
        .find(|t| t.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .unwrap_or_else(|| line.split_whitespace().last().unwrap_or(line))
        .trim()
        .to_string();
    if ver.is_empty() {
        None
    } else {
        Some(ver)
    }
}

#[cfg(windows)]
fn windows_shim_binary_path(binary: &Path) -> String {
    let text = binary.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else {
        text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned()
    }
}

fn preferred_bin_dir() -> PathBuf {
    if let Some(home) = dirs::home_dir() {
        let local = home.join(".local").join("bin");
        if local.is_dir() || !cfg!(windows) {
            return local;
        }
    }
    #[cfg(windows)]
    {
        if let Some(base) = dirs::data_local_dir() {
            return base.join("Agentero").join("bin");
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".local")
        .join("bin")
}

pub(crate) fn managed_shim_path() -> PathBuf {
    preferred_bin_dir().join(SHIM_NAME)
}

/// Windows: add the shim dir to the user PATH (HKCU\Environment) so a fresh
/// terminal can run `agentero-cli`. POSIX: no-op — the symlink shim lives in a
/// bin dir the user normally already has on PATH (e.g. `~/.local/bin`).
#[cfg(windows)]
pub(crate) fn add_shim_dir_to_user_path() -> Result<(), AppError> {
    windows_path::add_to_user_path(&preferred_bin_dir())
}

#[cfg(not(windows))]
pub(crate) fn add_shim_dir_to_user_path() -> Result<(), AppError> {
    Ok(())
}

/// Windows: drop the shim dir from the user PATH (best-effort cleanup).
/// POSIX: no-op.
#[cfg(windows)]
pub(crate) fn remove_shim_dir_from_user_path() -> Result<bool, AppError> {
    windows_path::remove_from_user_path(&preferred_bin_dir())
}

#[cfg(not(windows))]
pub(crate) fn remove_shim_dir_from_user_path() -> Result<bool, AppError> {
    Ok(false)
}

fn path_env_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(path) = std::env::var("PATH") {
        for part in std::env::split_paths(&path) {
            dirs.push(part);
        }
    }
    dirs
}

/// Detect a usable `brew` executable (PATH dirs or standard Homebrew roots).
fn brew_available() -> bool {
    let name = if cfg!(windows) { "brew.exe" } else { "brew" };
    let mut candidates: Vec<PathBuf> = path_env_dirs()
        .into_iter()
        .map(|dir| dir.join(name))
        .collect();
    candidates.push(PathBuf::from("/opt/homebrew/bin/brew"));
    candidates.push(PathBuf::from("/usr/local/bin/brew"));
    candidates.iter().any(|p| is_plausible_cli_file(p))
}

fn is_on_path(dir: &Path) -> bool {
    let dir_canon = crate::core::fs::canonicalize_best_effort(dir);
    path_env_dirs().iter().any(|p| {
        p.canonicalize()
            .map(|c| c == dir_canon)
            .unwrap_or_else(|_| p == dir)
    })
}

/// Whether `shim` is a managed Agentero CLI entry pointing at `target` (or same file).
fn shim_points_to(shim: &Path, target: Option<&Path>) -> bool {
    let Some(link) = shim_target(shim) else {
        return false;
    };
    let Some(target) = target else {
        return known_install_target(&link);
    };
    let a = crate::core::fs::canonicalize_best_effort(&link);
    let b = crate::core::fs::canonicalize_best_effort(target);
    a == b
}

/// Recognise the exact Windows wrapper emitted by install_shim. A user script
/// which merely contains the name Agentero must not be removed or replaced.
fn shim_target(shim: &Path) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let contents = fs::read_to_string(shim).ok()?;
        let mut lines = contents.lines();
        if lines.next()? != "@echo off" {
            return None;
        }
        let target = lines.next()?.strip_prefix('"')?.strip_suffix("\" %*")?;
        (lines.next().is_none()).then(|| PathBuf::from(target.replace("%%", "%")))
    }
    #[cfg(not(windows))]
    {
        let target = fs::read_link(shim).ok()?;
        Some(shim.parent()?.join(target))
    }
}

fn known_install_target(path: &Path) -> bool {
    let root = managed_cli_dir();
    let cached = path.file_name().is_some_and(|n| n == managed_binary_name())
        && path.parent().is_some_and(|dir| {
            dir == root
                || (dir.parent() == Some(&root)
                    && dir
                        .file_name()
                        .is_some_and(|n| n.to_string_lossy().starts_with("v-")))
        });
    // An existing installation can still point into an older application which
    // was moved or uninstalled. Recognise its directory layout lexically.
    cached
        || path.ends_with(Path::new("Contents/Resources/cli").join(BUNDLED_CLI_NAME))
        || path.ends_with("Contents/MacOS/agentero-turn")
        || path.ends_with(Path::new("Contents/MacOS").join(BUNDLED_CLI_NAME))
        || path.ends_with(Path::new("Agentero/cli").join(BUNDLED_CLI_NAME))
        || path.ends_with(Path::new("agentero/cli").join(BUNDLED_CLI_NAME))
        || (cfg!(debug_assertions)
            && ["target/debug", "target/release"]
                .iter()
                .any(|dir| path.ends_with(Path::new(dir).join(BUNDLED_CLI_NAME))))
}

fn is_agentero_shim(shim: &Path) -> bool {
    shim_target(shim).is_some_and(|path| known_install_target(&path))
}

fn download_supported() -> bool {
    host_triple().is_some()
}

pub fn collect_status<R: Runtime>(app: &AppHandle<R>) -> CliInstallStatus {
    let app_ver = app_version();
    let local = resolve_local_cli(app);
    let cli_version = local.as_ref().and_then(|r| r.version.clone());
    let source = local.as_ref().map(|r| r.source.to_string());
    let cli_path = local.as_ref().map(|r| r.path.clone());
    let shim = managed_shim_path();
    let installed =
        shim.exists() && (is_agentero_shim(&shim) || shim_points_to(&shim, cli_path.as_deref()));
    let version_matches = cli_version
        .as_deref()
        .map(|v| versions_equal(v, &app_ver))
        .unwrap_or(false);
    let managed = managed_cli_binary();
    let shim_current = installed
        && source.as_deref() == Some("managed")
        && version_matches
        && managed
            .with_file_name(
                agentero_core::features::paper::analyze::parse::pdfium_library_file_name(),
            )
            .is_file()
        && shim_points_to(&shim, Some(&managed));
    let bin_dir = preferred_bin_dir();
    let preferred_bin_on_path = is_on_path(&bin_dir);
    let can_install = local.is_some() || download_supported();
    let download_url = host_triple().map(|t| release_download_url(&app_ver, t));
    let release_page_url = release_tag_page_url(&app_ver);

    let mut message = None;
    if !can_install {
        message = Some(
            "CLI install is not available on this platform (no matching Release triple).".into(),
        );
    } else if installed && !version_matches {
        message = Some(format!(
            "Installed CLI {} does not match app {}. Reinstall to update.",
            cli_version.as_deref().unwrap_or("?"),
            app_ver
        ));
    } else if installed && !preferred_bin_on_path {
        message = Some(if cfg!(windows) {
            format!(
                "CLI installed at {} but that directory is not on the user PATH. Add it to the PATH environment variable and open a new terminal.",
                bin_dir.display()
            )
        } else {
            format!(
                "CLI installed at {} but that directory is not on PATH. Add it to your shell PATH (do not edit rc from Agentero).",
                bin_dir.display()
            )
        });
    }

    CliInstallStatus {
        app_version: app_ver,
        bundled_version: cli_version.clone(),
        bundled_path: cli_path.map(|p| p.to_string_lossy().into_owned()),
        source,
        cli_version,
        download_url,
        release_page_url,
        can_install,
        installed,
        auto_install_enabled: !auto_install_opted_out(),
        install_path: if installed {
            Some(shim.to_string_lossy().into_owned())
        } else {
            None
        },
        shim_current,
        preferred_bin_dir: bin_dir.to_string_lossy().into_owned(),
        preferred_bin_on_path,
        brew_available: brew_available(),
        command_name: cli_command_name(),
        message,
    }
}

pub(crate) fn foreign_shim_blocks(shim: &Path, binary: &Path) -> bool {
    shim.symlink_metadata().is_ok()
        && !is_agentero_shim(shim)
        && !shim_points_to(shim, Some(binary))
}

pub(crate) fn install_shim(binary: &Path, shim: &Path) -> Result<(), AppError> {
    if !is_plausible_cli_file(binary) {
        return Err(AppError::message(format!(
            "CLI binary is missing or empty: {}",
            binary.display()
        )));
    }
    if read_cli_version(binary).is_none() {
        return Err(AppError::message(format!(
            "CLI binary does not run (`--version` failed): {}",
            binary.display()
        )));
    }
    if let Some(parent) = shim.parent() {
        fs::create_dir_all(parent)?;
    }
    if foreign_shim_blocks(shim, binary) {
        return Err(AppError::message(format!(
            "refusing to overwrite {}: not an Agentero-managed CLI entry",
            shim.display()
        )));
    }
    let dir = shim
        .parent()
        .ok_or_else(|| AppError::message("missing shim directory"))?;
    #[cfg(unix)]
    {
        let scratch = tempfile::tempdir_in(dir)?;
        let link = scratch.path().join("link");
        std::os::unix::fs::symlink(binary, &link)?;
        fs::rename(link, shim)?;
    }
    #[cfg(windows)]
    {
        use std::io::Write;
        let mut temp = tempfile::NamedTempFile::new_in(dir)?;
        write!(
            temp,
            "@echo off\r\n\"{}\" %*\r\n",
            windows_shim_binary_path(binary).replace('%', "%%")
        )?;
        temp.persist(shim).map_err(|e| e.error)?;
    }
    Ok(())
}

pub(crate) fn uninstall_shim(shim: &Path, binary: Option<&Path>) -> Result<bool, AppError> {
    if shim.symlink_metadata().is_err() {
        return Ok(false);
    }
    if !shim_points_to(shim, binary) && !is_agentero_shim(shim) {
        return Err(AppError::message(format!(
            "refusing to remove {}: not an Agentero-managed shim",
            shim.display()
        )));
    }
    fs::remove_file(shim)?;
    Ok(true)
}

/// Replace a cache file only after its complete contents are on disk.
fn copy_cached_file(source: &Path, dest: &Path) -> Result<(), AppError> {
    let dir = dest
        .parent()
        .ok_or_else(|| AppError::message("missing CLI cache directory"))?;
    fs::create_dir_all(dir)?;
    let temp = tempfile::NamedTempFile::new_in(dir)?;
    fs::copy(source, temp.path())?;
    temp.persist(dest).map_err(|e| e.error)?;
    Ok(())
}

/// A terminal entry always points to the user's cache. Set up both files
/// before switching the shim, leaving the previous version usable on failure.
pub(crate) async fn ensure_cli_binary<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<(PathBuf, &'static str), AppError> {
    use agentero_core::features::paper::analyze::parse::{
        bundled_pdfium_dir_for, pdfium_library_file_name,
    };
    let dest = managed_cli_binary();
    let dir = dest.parent().expect("managed CLI has a parent");
    let lib = dir.join(pdfium_library_file_name());

    if let Some(local) = resolve_local_cli(app) {
        if local.source == "managed" && lib.is_file() {
            return Ok((dest, "install"));
        }
        let library = bundled_pdfium_dir_for(&local.path).or_else(|| {
            std::env::current_exe()
                .ok()
                .and_then(|exe| bundled_pdfium_dir_for(&exe))
        });
        if let Some(library) = library {
            let source = library.join(pdfium_library_file_name());
            if source != lib {
                copy_cached_file(&source, &lib)?;
            }
            if local.source != "managed" {
                copy_cached_file(&local.path, &dest)?;
            }
            return Ok((dest, "install"));
        }
    }
    if !download_supported() {
        return Err(AppError::message(
            "no same-version CLI and PDFium are available for this platform",
        ));
    }
    fs::create_dir_all(dir)?;
    let staging = tempfile::tempdir_in(dir)?;
    let download = staging.path().join(managed_binary_name());
    let library = staging.path().join(pdfium_library_file_name());
    download_and_extract(&app_version(), &download).await?;
    if !probe_cli_version(&download).is_some_and(|v| versions_equal(&v, &app_version()))
        || !library.is_file()
    {
        return Err(AppError::message(
            "downloaded CLI or PDFium is missing or does not match this app version",
        ));
    }
    copy_cached_file(&library, &lib)?;
    copy_cached_file(&download, &dest)?;
    Ok((dest, "download-install"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("agentero-cli-install-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn explicit_uninstall_persists_until_manual_reinstall() {
        let dir = test_dir("auto-install");
        let marker = dir.join("config").join("cli.removed");
        assert!(!marker.exists());
        set_auto_install_enabled_at(&marker, false).unwrap();
        assert!(marker.is_file());
        set_auto_install_enabled_at(&marker, false).unwrap();
        set_auto_install_enabled_at(&marker, true).unwrap();
        assert!(!marker.exists());
        set_auto_install_enabled_at(&marker, true).unwrap();
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn foreign_file_blocks_a_replacement_shim() {
        let dir = test_dir("foreign-shim");
        let foreign = dir.join(SHIM_NAME);
        let binary = dir.join(BUNDLED_CLI_NAME);
        fs::write(&foreign, b"someone-elses-cli").unwrap();
        fs::write(&binary, b"agentero-cli").unwrap();
        assert!(foreign_shim_blocks(&foreign, &binary));
        assert_eq!(fs::read(&foreign).unwrap(), b"someone-elses-cli");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_empty_files_as_cli() {
        let dir = test_dir("tiny");
        let tiny = dir.join(BUNDLED_CLI_NAME);
        fs::write(&tiny, b"").unwrap();
        assert!(!is_plausible_cli_file(&tiny));
        assert!(!is_runnable_cli(&tiny));
        fs::write(&tiny, b"x").unwrap();
        if cfg!(windows) {
            // `x` is not a PE image, so Windows rejects it pre-exec.
            assert!(!is_plausible_cli_file(&tiny));
        } else {
            assert!(is_plausible_cli_file(&tiny));
        }
        // Still not runnable without a working --version.
        assert!(!is_runnable_cli(&tiny));
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn rejects_batch_stub_exe_on_windows() {
        let dir = test_dir("stub");
        let stub = dir.join(BUNDLED_CLI_NAME);
        // The historical externalBin stub body: batch text with an .exe name.
        fs::write(
            &stub,
            b"@echo off\r\necho agentero-cli stub\r\nexit /b 1\r\n",
        )
        .unwrap();
        assert!(!is_plausible_cli_file(&stub));
        assert!(!is_runnable_cli(&stub));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_refuses_non_managed_file() {
        let dir = test_dir("refuse");
        let foreign = dir.join(SHIM_NAME);
        let bundled = dir.join(BUNDLED_CLI_NAME);
        fs::write(&foreign, b"not-agentero").unwrap();
        // Passes size check but --version fails → install_shim errors first
        // (on Windows the non-PE body trips the plausibility check instead).
        fs::write(&bundled, b"not-a-real-binary").unwrap();
        let err = install_shim(&bundled, &foreign).unwrap_err();
        assert!(
            err.to_string().contains("does not run")
                || err.to_string().contains("refusing")
                || err.to_string().contains("missing or empty"),
            "{err}"
        );
        assert_eq!(fs::read(&foreign).unwrap(), b"not-agentero");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn windows_shim_strips_verbatim_path_prefix() {
        let path = Path::new(r"\\?\C:\Users\me\AppData\Local\Agentero\cli\agentero.exe");
        assert_eq!(
            windows_shim_binary_path(path),
            r"C:\Users\me\AppData\Local\Agentero\cli\agentero.exe"
        );
    }

    #[cfg(unix)]
    #[test]
    fn install_replaces_managed_symlink_when_version_ok() {
        let dir = test_dir("replace");
        let bundled_old = dir
            .join("Agentero.app/Contents/Resources/cli")
            .join(BUNDLED_CLI_NAME);
        fs::create_dir_all(bundled_old.parent().unwrap()).unwrap();
        let bundled_new = dir.join(BUNDLED_CLI_NAME);
        let shim = dir.join(SHIM_NAME);
        // Shell scripts that implement --version.
        let script = "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'agentero-cli 9.9.9'; exit 0; fi\nexit 0\n";
        fs::write(&bundled_old, script).unwrap();
        fs::write(&bundled_new, script).unwrap();
        use std::os::unix::fs::PermissionsExt;
        for p in [&bundled_old, &bundled_new] {
            let mut perms = fs::metadata(p).unwrap().permissions();
            perms.set_mode(0o755);
            fs::set_permissions(p, perms).unwrap();
        }
        std::os::unix::fs::symlink(&bundled_old, &shim).unwrap();
        install_shim(&bundled_new, &shim).unwrap();
        let target = fs::read_link(&shim).unwrap();
        assert_eq!(target, bundled_new);
        let _ = fs::remove_dir_all(&dir);
    }
}
