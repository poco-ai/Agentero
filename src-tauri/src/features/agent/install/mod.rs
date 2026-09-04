//! Headless CLI discovery, optional GitHub download, PATH install, and uninstall.
//!
//! Desktop packages intentionally do **not** ship a multi-MB CLI binary (#285).
//! Settings → About installs the **same app version** CLI from GitHub Releases
//! (or uses a local/dev runnable binary when present). PATH entry is a user-bin
//! shim; shell rc files are never edited.
//!
//! Dev note: the cargo bin is named `agentero-cli` so it never collides with
//! the GUI binary `agentero` in `target/{debug,release}/`.

mod download;
#[cfg(windows)]
pub(crate) mod windows_path;

use crate::core::error::AppError;
use download::{
    download_and_extract, host_triple, managed_binary_name, release_download_url,
    release_tag_page_url, versions_equal,
};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager, Runtime};

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

#[derive(Debug, Clone, Serialize)]
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

#[derive(Debug, Clone, Serialize)]
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
fn is_runnable_cli(path: &Path) -> bool {
    is_plausible_cli_file(path) && read_cli_version(path).is_some()
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
    managed_cli_dir().join(managed_binary_name())
}

/// Locate a real, version-reporting CLI next to the app / in the workspace (never stubs).
pub fn resolve_bundled_cli<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    resolve_local_cli(app).map(|r| r.path)
}

pub(crate) fn resolve_local_cli<R: Runtime>(app: &AppHandle<R>) -> Option<ResolvedCli> {
    // 1) Managed download cache (product path after Install).
    let managed = managed_cli_binary();
    if is_runnable_cli(&managed) {
        let version = read_cli_version(&managed);
        return Some(ResolvedCli {
            path: managed.canonicalize().unwrap_or(managed),
            source: "managed",
            version,
        });
    }

    // 2) App bundle / resource / dev target discovery.
    let mut candidates: Vec<(PathBuf, &'static str)> = Vec::new();

    // `executable_dir` is desktop-only (PathResolver). Mobile never ships the CLI.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if let Ok(exe_dir) = app.path().executable_dir() {
        candidates.push((exe_dir.join(BUNDLED_CLI_NAME), "bundled"));
        candidates.push((exe_dir.join("binaries").join(BUNDLED_CLI_NAME), "bundled"));
    }
    if let Ok(res) = app.path().resource_dir() {
        candidates.push((res.join(BUNDLED_CLI_NAME), "bundled"));
        candidates.push((res.join("binaries").join(BUNDLED_CLI_NAME), "bundled"));
        if let Some(parent) = res.parent() {
            candidates.push((parent.join("MacOS").join(BUNDLED_CLI_NAME), "bundled"));
        }
    }

    // Runtime discovery from the running GUI binary (dev + release).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push((dir.join(BUNDLED_CLI_NAME), "dev"));
            for ancestor in dir.ancestors().take(6) {
                candidates.push((ancestor.join("target/debug").join(BUNDLED_CLI_NAME), "dev"));
                candidates.push((
                    ancestor.join("target/release").join(BUNDLED_CLI_NAME),
                    "dev",
                ));
                if ancestor.ends_with("debug") || ancestor.ends_with("release") {
                    candidates.push((ancestor.join(BUNDLED_CLI_NAME), "dev"));
                }
            }
        }
    }

    // src-tauri/binaries/agentero-cli-$TRIPLE from prepare-bundled-cli.mjs
    if let Ok(cwd) = std::env::current_dir() {
        for ancestor in cwd.ancestors().take(6) {
            let bin_dir = ancestor.join("src-tauri/binaries");
            if let Ok(rd) = fs::read_dir(&bin_dir) {
                for entry in rd.flatten() {
                    let name = entry.file_name();
                    let s = name.to_string_lossy();
                    if s.starts_with("agentero-cli-") {
                        candidates.push((entry.path(), "dev"));
                    }
                }
            }
        }
    }

    for (path, source) in candidates {
        if is_runnable_cli(&path) {
            let version = read_cli_version(&path);
            return Some(ResolvedCli {
                path: path.canonicalize().unwrap_or(path),
                source,
                version,
            });
        }
    }
    None
}

fn read_cli_version(bin: &Path) -> Option<String> {
    let output = Command::new(bin).arg("--version").output().ok()?;
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
    let dir_canon = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    path_env_dirs().iter().any(|p| {
        p.canonicalize()
            .map(|c| c == dir_canon)
            .unwrap_or_else(|_| p == dir)
    })
}

/// Whether `shim` is a managed Agentero CLI entry pointing at `target` (or same file).
fn shim_points_to(shim: &Path, target: Option<&Path>) -> bool {
    if !shim.exists() {
        return false;
    }
    let Some(target) = target else {
        return is_agentero_shim(shim);
    };
    #[cfg(unix)]
    {
        if let Ok(link) = fs::read_link(shim) {
            let resolved = if link.is_absolute() {
                link
            } else {
                shim.parent().unwrap_or_else(|| Path::new(".")).join(link)
            };
            let a = resolved.canonicalize().unwrap_or(resolved);
            let b = target
                .canonicalize()
                .unwrap_or_else(|_| target.to_path_buf());
            return a == b;
        }
    }
    if let (Ok(a), Ok(b)) = (shim.canonicalize(), target.canonicalize()) {
        if a == b {
            return true;
        }
    }
    is_agentero_shim(shim)
}

fn is_agentero_shim(shim: &Path) -> bool {
    #[cfg(unix)]
    {
        if let Ok(target) = fs::read_link(shim) {
            let s = target.to_string_lossy();
            return s.contains("agentero-cli")
                || s.contains("Agentero")
                || s.ends_with("agentero")
                || s.contains("/cli/agentero");
        }
    }
    #[cfg(windows)]
    {
        if let Ok(text) = fs::read_to_string(shim) {
            return text.contains("agentero-cli")
                || text.contains("Agentero")
                || text.contains("agentero.exe");
        }
    }
    false
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
    let shim_current = installed && shim_points_to(&shim, cli_path.as_deref()) && version_matches;
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
    // Never clobber a user-owned binary/symlink that we did not create.
    if shim.exists() {
        if !is_agentero_shim(shim) && !shim_points_to(shim, Some(binary)) {
            return Err(AppError::message(format!(
                "refusing to overwrite {}: not an Agentero-managed CLI entry",
                shim.display()
            )));
        }
        fs::remove_file(shim)?;
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(binary, shim).map_err(|e| {
            AppError::message(format!(
                "failed to create symlink {} → {}: {e}",
                shim.display(),
                binary.display()
            ))
        })?;
        #[allow(clippy::permissions_set_readonly_false)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = fs::metadata(binary) {
                let mut perms = meta.permissions();
                let mode = perms.mode();
                if mode & 0o111 == 0 {
                    perms.set_mode(mode | 0o755);
                    let _ = fs::set_permissions(binary, perms);
                }
            }
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        let body = format!(
            "@echo off\r\n\"{}\" %*\r\n",
            binary.display().to_string().replace('"', "")
        );
        fs::write(shim, body)?;
        Ok(())
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (binary, shim);
        Err(AppError::message(
            "CLI install not supported on this platform",
        ))
    }
}

pub(crate) fn uninstall_shim(shim: &Path, binary: Option<&Path>) -> Result<bool, AppError> {
    if !shim.exists() {
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

/// Ensure a same-version CLI binary is available (local or download), return its path.
pub(crate) async fn ensure_cli_binary<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<(PathBuf, &'static str), AppError> {
    let app_ver = app_version();

    // Prefer a local runnable that already matches the app version.
    if let Some(local) = resolve_local_cli(app) {
        if local
            .version
            .as_deref()
            .map(|v| versions_equal(v, &app_ver))
            .unwrap_or(false)
        {
            return Ok((local.path, "install"));
        }
    }

    // Download (or re-download) into the managed cache.
    if !download_supported() {
        // Fall back: if we only have a mismatched local binary, still allow shim install
        // so devs without a published release can use `pnpm cli:bundle`.
        if let Some(local) = resolve_local_cli(app) {
            return Ok((local.path, "install"));
        }
        return Err(AppError::message(
            "CLI download is not supported on this platform and no local CLI was found. In dev run `pnpm cli:bundle`.",
        ));
    }

    let dest = managed_cli_binary();
    download_and_extract(&app_ver, &dest).await?;
    if !is_runnable_cli(&dest) {
        let _ = fs::remove_file(&dest);
        return Err(AppError::message(format!(
            "downloaded CLI does not run (`--version` failed): {}",
            dest.display()
        )));
    }
    let got = read_cli_version(&dest).unwrap_or_default();
    if !versions_equal(&got, &app_ver) {
        return Err(AppError::message(format!(
            "downloaded CLI version {got} does not match app {app_ver}"
        )));
    }
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

    #[cfg(unix)]
    #[test]
    fn install_replaces_managed_symlink_when_version_ok() {
        let dir = test_dir("replace");
        let bundled_old = dir.join("agentero-cli-old");
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
