//! Deep-link / second-instance vault open requests.
//!
//! Paths to open arrive via:
//! 1. `agentero://open?path=…` deep link / second-instance argv
//! 2. **CLI request file** (`…/agentero/cli-open-request.json`) — reliable when
//!    deep-link is unregistered (dev) or a second GUI process would miss the
//!    window the user is looking at
//! 3. **Bare directory argv** — OS shell integrations (Finder Quick Action,
//!    Explorer context menu) pass the folder path directly
//!
//! Host validates the directory, extends fs scope, caches a pending path for
//! startup races, and emits `vault:open-request` for the renderer.

use crate::core::error::AppError;
use crate::core::paths::agentero_config_dir;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Emitter, Manager, Runtime};
#[cfg(feature = "desktop")]
use tauri_plugin_fs::FsExt;
use url::Url;

#[cfg(feature = "desktop")]
pub mod commands;

pub const EVENT_VAULT_OPEN_REQUEST: &str = "vault:open-request";

/// Written by headless CLI; consumed by the running desktop Host.
const CLI_OPEN_REQUEST_FILE: &str = "cli-open-request.json";
/// Ignore stale requests older than this (seconds).
const CLI_OPEN_REQUEST_MAX_AGE_SECS: u64 = 120;

/// Last validated open path waiting for the frontend to consume.
#[derive(Default)]
pub struct PendingVaultOpen {
    path: Mutex<Option<String>>,
}

impl PendingVaultOpen {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(&self, path: String) {
        if let Ok(mut guard) = self.path.lock() {
            *guard = Some(path);
        }
    }

    pub fn take(&self) -> Option<String> {
        self.path.lock().ok().and_then(|mut g| g.take())
    }

    pub fn peek(&self) -> Option<String> {
        self.path.lock().ok().and_then(|g| g.clone())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultOpenPayload {
    pub path: String,
}

/// Parse `agentero://open?path=` (or `agentero:open?path=` variants).
pub fn parse_open_url(raw: &str) -> Result<PathBuf, AppError> {
    let url = Url::parse(raw).map_err(|e| AppError::message(format!("invalid open URL: {e}")))?;
    let scheme = url.scheme();
    if scheme != "agentero" {
        return Err(AppError::message(format!(
            "unsupported URL scheme: {scheme}"
        )));
    }
    // `agentero://open?path=` → host "open"
    let host = url.host_str().unwrap_or("");
    let path_seg = url.path().trim_matches('/');
    let is_open = host.eq_ignore_ascii_case("open") || path_seg.eq_ignore_ascii_case("open");
    if !is_open {
        return Err(AppError::message(format!(
            "unsupported agentero URL action: {}",
            if host.is_empty() { path_seg } else { host }
        )));
    }
    let path = url
        .query_pairs()
        .find(|(k, _)| k == "path")
        .map(|(_, v)| v.into_owned())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| AppError::message("open URL missing path query"))?;
    Ok(PathBuf::from(path))
}

/// Validate a local absolute directory for vault open (no AppHandle required).
///
/// Deep-link / second-instance paths must be absolute so resolution does not
/// depend on the App process CWD. Relative paths are rejected even if they
/// would resolve under the current working directory.
pub fn validate_open_dir(path: &Path) -> Result<PathBuf, AppError> {
    let trimmed = path.to_string_lossy();
    if trimmed.trim().is_empty() {
        return Err(AppError::message("path is required"));
    }
    if !path.is_absolute() {
        return Err(AppError::message(format!(
            "path must be absolute: {}",
            path.display()
        )));
    }
    if !path.exists() {
        return Err(AppError::message(format!(
            "path does not exist: {}",
            path.display()
        )));
    }
    if !path.is_dir() {
        return Err(AppError::message(format!(
            "path is not a directory: {}",
            path.display()
        )));
    }
    path.canonicalize()
        .map_err(|e| AppError::message(format!("failed to resolve path: {e}")))
}

/// Validate local directory, allow fs scope, store pending, emit + focus window.
#[cfg(feature = "desktop")]
pub fn handle_open_path<R: Runtime>(app: &AppHandle<R>, path: &Path) -> Result<String, AppError> {
    let canonical = validate_open_dir(path)?;
    let path_str = canonical.to_string_lossy().to_string();

    if let Err(e) = app.fs_scope().allow_directory(&canonical, true) {
        log::warn!(
            target: "agentero::op",
            "vault open allow_directory failed path={} error={e}",
            trunc(&path_str)
        );
    }

    if let Some(state) = app.try_state::<PendingVaultOpen>() {
        state.set(path_str.clone());
    }

    let payload = VaultOpenPayload {
        path: path_str.clone(),
    };
    let _ = app.emit(EVENT_VAULT_OPEN_REQUEST, &payload);

    focus_main_window(app);
    log::info!(
        target: "agentero::op",
        "op end vault_open_request ok=true path={}",
        trunc(&path_str)
    );
    Ok(path_str)
}

/// Handle one or more deep-link URLs; non-open URLs are ignored with a warning.
#[cfg(feature = "desktop")]
pub fn handle_deep_link_urls<R: Runtime>(app: &AppHandle<R>, urls: &[String]) {
    for raw in urls {
        if raw.contains("://pair") || raw.contains(":pair") {
            // Mobile pairing — leave to the mobile UI / other handlers.
            continue;
        }
        match parse_open_url(raw) {
            Ok(path) => {
                if let Err(e) = handle_open_path(app, &path) {
                    log::warn!(
                        target: "agentero::op",
                        "op end vault_open_request ok=false url={} error={e}",
                        trunc(raw)
                    );
                    let _ = app.emit(
                        "vault:open-error",
                        serde_json::json!({ "message": e.to_string() }),
                    );
                }
            }
            Err(e) => {
                log::debug!(
                    target: "agentero::op",
                    "skip deep link url={} error={e}",
                    trunc(raw)
                );
            }
        }
    }
}

/// Collect open requests from argv: `agentero://` URLs plus at most one bare
/// directory path. Skips argv[0] and flag-like args (`-` prefix, e.g. WebView2
/// switches); a directory candidate must be an absolute existing directory, so
/// stray args (e.g. the forwarded exe path on Windows) are ignored.
pub fn collect_open_args(argv: &[String]) -> (Vec<String>, Option<PathBuf>) {
    let mut urls = Vec::new();
    let mut dir = None;
    for (idx, arg) in argv.iter().enumerate() {
        if idx == 0 {
            continue;
        }
        if arg.starts_with("agentero://") || arg.starts_with("agentero:") {
            urls.push(arg.clone());
            continue;
        }
        if dir.is_none() && !arg.starts_with('-') {
            let candidate = PathBuf::from(arg);
            if candidate.is_absolute() && candidate.is_dir() {
                dir = Some(candidate);
            }
        }
    }
    (urls, dir)
}

/// Handle CLI argv: `agentero://` URLs (second instance / Windows / Linux) and
/// bare directory paths (shell integrations such as the Finder Quick Action or
/// Explorer context menu pass the folder directly).
#[cfg(feature = "desktop")]
pub fn handle_argv_urls<R: Runtime>(app: &AppHandle<R>, argv: &[String]) {
    let (urls, dir) = collect_open_args(argv);
    if !urls.is_empty() {
        handle_deep_link_urls(app, &urls);
    }
    if let Some(path) = dir {
        if let Err(e) = handle_open_path(app, &path) {
            log::warn!(
                target: "agentero::op",
                "op end vault_open_request ok=false argv_dir={} error={e}",
                trunc(&path.to_string_lossy())
            );
            let _ = app.emit(
                "vault:open-error",
                serde_json::json!({ "message": e.to_string() }),
            );
        }
    }
}

#[cfg(feature = "desktop")]
fn focus_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        // unminimize is desktop-only in Tauri (no window manager chrome on mobile).
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
    // macOS often ignores set_focus from non-frontmost processes (CLI wake-up).
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("osascript")
            .args([
                "-e",
                r#"tell application "System Events" to set frontmost of first process whose name is "agentero" to true"#,
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

#[cfg(feature = "desktop")]
fn trunc(s: &str) -> String {
    const MAX: usize = 200;
    if s.len() <= MAX {
        s.to_string()
    } else {
        format!("{}…", &s[..MAX])
    }
}

// --- CLI ↔ Host request file (primary reliability path) --------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliOpenRequestFile {
    path: String,
    /// Unix epoch seconds when the CLI wrote the request.
    ts: u64,
}

/// Absolute path of the CLI open-request file.
pub fn cli_open_request_path() -> PathBuf {
    agentero_config_dir().join(CLI_OPEN_REQUEST_FILE)
}

/// CLI (and tests): ask any running desktop Host to open `absolute_path`.
pub fn write_cli_open_request(absolute_path: &Path) -> Result<PathBuf, AppError> {
    let canonical = validate_open_dir(absolute_path)?;
    let dir = agentero_config_dir();
    std::fs::create_dir_all(&dir)?;
    let file = cli_open_request_path();
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let body = CliOpenRequestFile {
        path: canonical.to_string_lossy().into_owned(),
        ts,
    };
    let json = serde_json::to_string_pretty(&body)
        .map_err(|e| AppError::message(format!("serialize open request: {e}")))?;
    // Atomic write: temp then rename (with the Windows replace fallback).
    crate::core::fs::atomic_write(&file, json.as_bytes())?;
    Ok(file)
}

/// Read + delete a fresh CLI open request, if any.
pub fn take_cli_open_request_file() -> Option<PathBuf> {
    let file = cli_open_request_path();
    let raw = std::fs::read_to_string(&file).ok()?;
    let _ = std::fs::remove_file(&file);
    let req: CliOpenRequestFile = serde_json::from_str(&raw).ok()?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if now.saturating_sub(req.ts) > CLI_OPEN_REQUEST_MAX_AGE_SECS {
        log::info!(
            target: "agentero::op",
            "ignore stale cli open request age_s={}",
            now.saturating_sub(req.ts)
        );
        return None;
    }
    let path = PathBuf::from(req.path);
    if path.is_absolute() && path.is_dir() {
        Some(path)
    } else {
        None
    }
}

/// Poll the CLI open-request file and forward into the normal open pipeline.
#[cfg(feature = "desktop")]
pub fn spawn_cli_open_request_watcher<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let mut last_handled: Option<String> = None;
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
            let Some(path) = take_cli_open_request_file() else {
                continue;
            };
            let key = path.to_string_lossy().into_owned();
            if last_handled.as_deref() == Some(key.as_str()) {
                continue;
            }
            match handle_open_path(&app, &path) {
                Ok(p) => {
                    last_handled = Some(p);
                }
                Err(e) => {
                    log::warn!(
                        target: "agentero::op",
                        "cli open request file failed path={} error={e}",
                        trunc(&key)
                    );
                    let _ = app.emit(
                        "vault:open-error",
                        serde_json::json!({ "message": e.to_string() }),
                    );
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn test_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("agentero-open-req-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parses_open_query() {
        let p = parse_open_url("agentero://open?path=%2Ftmp%2Fresearch").unwrap();
        assert_eq!(p, PathBuf::from("/tmp/research"));
    }

    #[test]
    fn parses_open_path_form() {
        let p = parse_open_url("agentero:open?path=%2Ftmp%2Fresearch").unwrap();
        assert_eq!(p, PathBuf::from("/tmp/research"));
    }

    #[test]
    fn rejects_missing_path() {
        assert!(parse_open_url("agentero://open").is_err());
    }

    #[test]
    fn rejects_other_scheme() {
        assert!(parse_open_url("https://example.com/open?path=/tmp").is_err());
    }

    #[test]
    fn rejects_relative_open_dir() {
        let err = validate_open_dir(Path::new("relative/vault")).unwrap_err();
        assert!(err.to_string().contains("absolute"));
    }

    #[test]
    fn accepts_absolute_existing_dir() {
        let dir = test_dir("ok");
        let canonical = validate_open_dir(&dir).unwrap();
        assert!(canonical.is_absolute());
        assert!(canonical.is_dir());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_absolute_file() {
        let dir = test_dir("file");
        let file = dir.join("note.md");
        fs::write(&file, "x").unwrap();
        let err = validate_open_dir(&file).unwrap_err();
        assert!(err.to_string().contains("not a directory"));
        let _ = fs::remove_dir_all(&dir);
    }

    fn argv(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn collect_args_skips_argv0_even_if_dir() {
        let dir = test_dir("argv0");
        let (urls, picked) = collect_open_args(&argv(&[dir.to_str().unwrap()]));
        assert!(urls.is_empty());
        assert_eq!(picked, None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn collect_args_skips_flags_and_missing_paths() {
        let (urls, picked) = collect_open_args(&argv(&[
            "/path/to/agentero",
            "--some-flag",
            "/nonexistent/vault/dir",
        ]));
        assert!(urls.is_empty());
        assert_eq!(picked, None);
    }

    #[test]
    fn collect_args_skips_file_path() {
        let dir = test_dir("argfile");
        let file = dir.join("paper.pdf");
        fs::write(&file, "x").unwrap();
        let (urls, picked) = collect_open_args(&argv(&["/bin/agentero", file.to_str().unwrap()]));
        assert!(urls.is_empty());
        assert_eq!(picked, None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn collect_args_accepts_absolute_dir() {
        let dir = test_dir("argdir");
        let (urls, picked) = collect_open_args(&argv(&["/bin/agentero", dir.to_str().unwrap()]));
        assert!(urls.is_empty());
        assert_eq!(picked, Some(dir.clone()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn collect_args_mixes_urls_and_dir_and_takes_first_dir() {
        let dir_a = test_dir("mixa");
        let dir_b = test_dir("mixb");
        let (urls, picked) = collect_open_args(&argv(&[
            "/bin/agentero",
            "agentero://open?path=%2Ftmp%2Fresearch",
            dir_a.to_str().unwrap(),
            dir_b.to_str().unwrap(),
        ]));
        assert_eq!(
            urls,
            vec!["agentero://open?path=%2Ftmp%2Fresearch".to_string()]
        );
        assert_eq!(picked, Some(dir_a.clone()));
        let _ = fs::remove_dir_all(&dir_a);
        let _ = fs::remove_dir_all(&dir_b);
    }
}
