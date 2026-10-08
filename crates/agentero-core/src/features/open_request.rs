//! Deep-link / second-instance vault open requests (tauri-free core).
//!
//! Paths to open arrive via:
//! 1. `agentero://open?path=…` deep link / second-instance argv
//! 2. **CLI request file** (`…/agentero/cli-open-request.json`) — reliable when
//!    deep-link is unregistered (dev) or a second GUI process would miss the
//!    window the user is looking at
//! 3. **Bare directory argv** — OS shell integrations (Finder Quick Action,
//!    Explorer context menu) pass the folder path directly
//!
//! The desktop Host (`agentero_lib::features::open_request`) adds the Tauri
//! side: fs-scope extension, pending-path caching, event emit, and window
//! focus on top of these pure parsing/validation/request-file helpers.

use crate::error::AppError;
use crate::paths::agentero_config_dir;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use url::Url;

pub const EVENT_VAULT_OPEN_REQUEST: &str = "vault:open-request";
pub const EVENT_PAPER_OPEN_REQUEST: &str = "paper:open-request";

/// Written by headless CLI; consumed by the running desktop Host.
const CLI_OPEN_REQUEST_FILE: &str = "cli-open-request.json";
/// Paper variant of the CLI request file (`agentero paper open <ref>`).
const CLI_PAPER_OPEN_REQUEST_FILE: &str = "cli-paper-open-request.json";
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

#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultOpenPayload {
    pub path: String,
}

/// Last validated paper-open request waiting for the frontend to consume.
#[derive(Default)]
pub struct PendingPaperOpen {
    pending: Mutex<Option<PaperOpenPayload>>,
}

impl PendingPaperOpen {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(&self, payload: PaperOpenPayload) {
        if let Ok(mut guard) = self.pending.lock() {
            *guard = Some(payload);
        }
    }

    pub fn take(&self) -> Option<PaperOpenPayload> {
        self.pending.lock().ok().and_then(|mut g| g.take())
    }
}

/// Request to open one paper (`papers/…`) in the desktop App.
///
/// `vault_path` is the absolute Vault root; `paper_path` is the Vault-relative
/// paper folder (always `/`-separated). Together they address a Dockview panel
/// without the Host needing to know the frontend's tab registry.
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperOpenPayload {
    pub vault_path: String,
    pub paper_path: String,
}

/// Parse `agentero://paper?vault=<abs>&path=<vault-relative>`.
pub fn parse_paper_open_url(raw: &str) -> Result<(PathBuf, String), AppError> {
    let url = Url::parse(raw).map_err(|e| AppError::message(format!("invalid open URL: {e}")))?;
    if url.scheme() != "agentero" {
        return Err(AppError::message(format!(
            "unsupported URL scheme: {}",
            url.scheme()
        )));
    }
    let host = url.host_str().unwrap_or("");
    let path_seg = url.path().trim_matches('/');
    let is_paper = host.eq_ignore_ascii_case("paper") || path_seg.eq_ignore_ascii_case("paper");
    if !is_paper {
        return Err(AppError::message(format!(
            "unsupported agentero URL action: {}",
            if host.is_empty() { path_seg } else { host }
        )));
    }
    let param = |key: &str| {
        url.query_pairs()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.into_owned())
            .filter(|s| !s.trim().is_empty())
    };
    let vault = param("vault").ok_or_else(|| AppError::message("open URL missing vault query"))?;
    let paper = param("path").ok_or_else(|| AppError::message("open URL missing path query"))?;
    Ok((PathBuf::from(vault), paper))
}

/// Normalize a Vault-relative paper folder, rejecting absolute paths and any
/// `..` escape. Returns `/`-separated segments joined without a leading slash.
pub fn normalize_paper_rel(paper_rel: &str) -> Result<String, AppError> {
    let raw = paper_rel.trim().replace('\\', "/");
    if raw.trim_matches('/').is_empty() {
        return Err(AppError::message("paper path is required"));
    }
    if Path::new(&raw).is_absolute() {
        return Err(AppError::message(format!(
            "paper path must be vault-relative: {paper_rel}"
        )));
    }
    let trimmed = raw.trim_matches('/');
    let mut parts = Vec::new();
    for seg in trimmed.split('/') {
        match seg {
            "" | "." => continue,
            ".." => {
                return Err(AppError::message("paper path must not escape the vault"));
            }
            other => parts.push(other),
        }
    }
    if parts.is_empty() {
        return Err(AppError::message("paper path is required"));
    }
    Ok(parts.join("/"))
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
    crate::fs::atomic_write(&file, json.as_bytes())?;
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

// --- CLI ↔ Host request file: paper variant --------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliPaperOpenRequestFile {
    vault_path: String,
    paper_path: String,
    /// Unix epoch seconds when the CLI wrote the request.
    ts: u64,
}

/// Absolute path of the CLI paper open-request file.
pub fn cli_paper_open_request_path() -> PathBuf {
    agentero_config_dir().join(CLI_PAPER_OPEN_REQUEST_FILE)
}

/// CLI (and tests): ask any running desktop Host to open `paper_rel` in `vault`.
pub fn write_cli_paper_open_request(vault: &Path, paper_rel: &str) -> Result<PathBuf, AppError> {
    let canonical = validate_open_dir(vault)?;
    let paper = normalize_paper_rel(paper_rel)?;
    let dir = agentero_config_dir();
    std::fs::create_dir_all(&dir)?;
    let file = cli_paper_open_request_path();
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let body = CliPaperOpenRequestFile {
        vault_path: canonical.to_string_lossy().into_owned(),
        paper_path: paper,
        ts,
    };
    let json = serde_json::to_string_pretty(&body)
        .map_err(|e| AppError::message(format!("serialize paper open request: {e}")))?;
    crate::fs::atomic_write(&file, json.as_bytes())?;
    Ok(file)
}

/// Read + delete a fresh CLI paper open request, if any.
pub fn take_cli_paper_open_request_file() -> Option<PaperOpenPayload> {
    let file = cli_paper_open_request_path();
    let raw = std::fs::read_to_string(&file).ok()?;
    let _ = std::fs::remove_file(&file);
    let req: CliPaperOpenRequestFile = serde_json::from_str(&raw).ok()?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if now.saturating_sub(req.ts) > CLI_OPEN_REQUEST_MAX_AGE_SECS {
        log::info!(
            target: "agentero::op",
            "ignore stale cli paper open request age_s={}",
            now.saturating_sub(req.ts)
        );
        return None;
    }
    let vault = PathBuf::from(&req.vault_path);
    if !(vault.is_absolute() && vault.is_dir()) {
        return None;
    }
    let paper_path = normalize_paper_rel(&req.paper_path).ok()?;
    Some(PaperOpenPayload {
        vault_path: vault.to_string_lossy().into_owned(),
        paper_path,
    })
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
    fn parses_paper_open_url() {
        let (vault, paper) =
            parse_paper_open_url("agentero://paper?vault=%2Ftmp%2Fvault&path=papers%2Fdemo")
                .unwrap();
        assert_eq!(vault, PathBuf::from("/tmp/vault"));
        assert_eq!(paper, "papers/demo");
    }

    #[test]
    fn paper_open_url_requires_vault_and_path() {
        assert!(parse_paper_open_url("agentero://paper?path=papers/demo").is_err());
        assert!(parse_paper_open_url("agentero://paper?vault=/tmp/vault").is_err());
    }

    #[test]
    fn paper_open_url_rejects_other_action() {
        assert!(parse_paper_open_url("agentero://open?path=%2Ftmp%2Fvault").is_err());
    }

    #[test]
    fn normalize_paper_rel_rejects_escape_and_absolute() {
        assert!(normalize_paper_rel("../etc").is_err());
        assert!(normalize_paper_rel("papers/../../etc").is_err());
        assert!(normalize_paper_rel("/abs/paper").is_err());
        assert!(normalize_paper_rel("   ").is_err());
    }

    #[test]
    fn normalize_paper_rel_collapses_separators() {
        assert_eq!(
            normalize_paper_rel("papers\\\\demo\\").unwrap(),
            "papers/demo"
        );
        assert_eq!(normalize_paper_rel("./papers/demo").unwrap(), "papers/demo");
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
