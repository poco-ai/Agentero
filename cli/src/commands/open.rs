//! Open a local directory as a Vault in the desktop App.
//!
//! Reliability order (any one success is enough for the Host; we always write
//! the request file first so a running App with the watcher picks it up even
//! when deep-link / second-instance fails):
//!
//! 1. Write `cli-open-request.json` (Host polls every ~400ms)
//! 2. Notify single-instance socket if a desktop process is listening
//! 3. OS deep-link `agentero://open?path=…`
//! 4. Spawn / activate the GUI binary with the URL on argv

use crate::error::CliError;
use crate::resolve::GlobalOpts;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Build the desktop deep-link URL for `agentero open <path>`.
pub fn open_deep_link_url(absolute_path: &Path) -> String {
    let encoded = urlencoding_encode(&absolute_path.to_string_lossy());
    format!("agentero://open?path={encoded}")
}

fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char);
            }
            _ => {
                out.push('%');
                out.push(char::from(b"0123456789ABCDEF"[(b >> 4) as usize]));
                out.push(char::from(b"0123456789ABCDEF"[(b & 0xf) as usize]));
            }
        }
    }
    out
}

/// Resolve and validate a directory path for open.
pub fn resolve_open_dir(path: &Path) -> Result<PathBuf, CliError> {
    let expanded = expand_user(path);
    if !expanded.exists() {
        return Err(CliError::usage(format!(
            "path does not exist: {}",
            expanded.display()
        )));
    }
    if !expanded.is_dir() {
        return Err(CliError::usage(format!(
            "path is not a directory: {}",
            expanded.display()
        )));
    }
    expanded.canonicalize().map_err(|e| {
        CliError::message(format!(
            "failed to resolve path {}: {e}",
            expanded.display()
        ))
    })
}

fn expand_user(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if s == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    }
    if let Some(rest) = s.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    path.to_path_buf()
}

/// Open the desktop app at `path` (or dry-run when `AGENTERO_OPEN_DRY_RUN=1`).
pub fn run(path: &Path, globals: &GlobalOpts) -> Result<Value, CliError> {
    let abs = resolve_open_dir(path)?;
    let url = open_deep_link_url(&abs);
    let dry = is_dry_run();

    let mut methods: Vec<&'static str> = Vec::new();
    let mut request_file: Option<String> = None;
    let mut gui_launched: Option<String> = None;

    if !dry {
        // 1) Always leave a request file for the running Host watcher.
        match agentero_core::features::open_request::write_cli_open_request(&abs) {
            Ok(p) => {
                methods.push("request-file");
                request_file = Some(p.to_string_lossy().into_owned());
            }
            Err(e) => {
                return Err(CliError::message(format!(
                    "failed to write open request file: {e}"
                )));
            }
        }

        let delivery = deliver_deep_link(&url);
        methods.extend(delivery.methods);
        gui_launched = delivery.gui_launched;
    } else {
        methods.push("dry-run");
    }

    let method = methods.first().copied().unwrap_or("none");
    Ok(json!({
        "path": abs.to_string_lossy(),
        "url": url,
        "method": method,
        "methods": methods,
        "requestFile": request_file,
        "guiLaunched": gui_launched,
        "dryRun": dry,
        "lines": [if dry {
            format!("would open {}", globals.style.path(&abs.to_string_lossy()))
        } else {
            format!(
                "opening {} ({})",
                globals.style.path(&abs.to_string_lossy()),
                methods.join("+")
            )
        }],
    }))
}

/// Ask the running desktop App to open `paper_rel` inside `vault`.
pub fn open_paper_in_app(
    vault: &Path,
    paper_rel: &str,
    globals: &GlobalOpts,
) -> Result<Value, CliError> {
    let abs = canonical_vault(vault)?;
    let path = normalize_rel(paper_rel)?;
    deliver_ui_request(
        agentero_core::features::open_request::UiRequestPayload::open_paper(abs, path),
        globals,
    )
}

/// Ask the App to open (or focus) a Vault-relative document / folder / paper.
pub fn open_path_in_app(vault: &Path, rel: &str, globals: &GlobalOpts) -> Result<Value, CliError> {
    let abs = canonical_vault(vault)?;
    let path = normalize_rel(rel)?;
    deliver_ui_request(
        agentero_core::features::open_request::UiRequestPayload::open_path(abs, path),
        globals,
    )
}

/// Ask the App to close the panel(s) for a Vault-relative path.
pub fn close_path_in_app(vault: &Path, rel: &str, globals: &GlobalOpts) -> Result<Value, CliError> {
    let abs = canonical_vault(vault)?;
    let path = normalize_rel(rel)?;
    deliver_ui_request(
        agentero_core::features::open_request::UiRequestPayload::close_path(abs, path),
        globals,
    )
}

/// Ask the App to open (or focus) a native child window (`settings` or a
/// right-rail feature view).
pub fn open_window_in_app(
    window: &str,
    section: Option<String>,
    globals: &GlobalOpts,
) -> Result<Value, CliError> {
    deliver_ui_request(
        agentero_core::features::open_request::UiRequestPayload::open_window(
            window.trim().to_string(),
            section,
        ),
        globals,
    )
}

fn canonical_vault(vault: &Path) -> Result<String, CliError> {
    vault
        .canonicalize()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| CliError::message(format!("failed to resolve vault {}: {e}", vault.display())))
}

fn normalize_rel(rel: &str) -> Result<String, CliError> {
    agentero_core::features::open_request::normalize_vault_rel(rel)
        .map_err(|e| CliError::usage(e.to_string()))
}

/// Write the CLI UI request file + deliver the `agentero://ui` deep link.
fn deliver_ui_request(
    req: agentero_core::features::open_request::UiRequestPayload,
    globals: &GlobalOpts,
) -> Result<Value, CliError> {
    // Validate even for dry-run so bad input fails fast (and the URL/file carry
    // canonical values).
    let req = agentero_core::features::open_request::validate_ui_request(req)
        .map_err(|e| CliError::usage(e.to_string()))?;
    let url = agentero_core::features::open_request::ui_deep_link_url(&req);
    let dry = is_dry_run();

    let mut methods: Vec<&'static str> = Vec::new();
    let mut request_file: Option<String> = None;
    let mut gui_launched: Option<String> = None;

    if !dry {
        match agentero_core::features::open_request::write_cli_ui_request(&req) {
            Ok(p) => {
                methods.push("request-file");
                request_file = Some(p.to_string_lossy().into_owned());
            }
            Err(e) => {
                return Err(CliError::message(format!(
                    "failed to write ui request file: {e}"
                )));
            }
        }
        let delivery = deliver_deep_link(&url);
        methods.extend(delivery.methods);
        gui_launched = delivery.gui_launched;
    } else {
        methods.push("dry-run");
    }

    let target = req.path.as_deref().or(req.window.as_deref()).unwrap_or("");
    let styled = globals.style.path(target);
    let method = methods.first().copied().unwrap_or("none");
    Ok(json!({
        "action": req.action,
        "vaultPath": req.vault_path,
        "path": req.path,
        "window": req.window,
        "section": req.section,
        "url": url,
        "method": method,
        "methods": methods,
        "requestFile": request_file,
        "guiLaunched": gui_launched,
        "dryRun": dry,
        "lines": [if dry {
            format!("would open {styled} in desktop")
        } else {
            format!("opening {styled} ({})", methods.join("+"))
        }],
    }))
}

fn is_dry_run() -> bool {
    matches!(
        std::env::var("AGENTERO_OPEN_DRY_RUN").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE")
    )
}

struct Delivery {
    methods: Vec<&'static str>,
    gui_launched: Option<String>,
}

/// Steps 2–4 of the delivery chain: single-instance socket → OS deep link →
/// spawn/activate the GUI with the URL on argv.
fn deliver_deep_link(url: &str) -> Delivery {
    let mut methods: Vec<&'static str> = Vec::new();
    let mut gui_launched = None;

    if notify_single_instance(url) {
        methods.push("single-instance");
    }
    if open_system_url(url).is_ok() {
        methods.push("deep-link");
    }
    if !methods.contains(&"single-instance") {
        match launch_gui_with_url(url) {
            Ok(gui) => {
                methods.push("gui-argv");
                gui_launched = Some(gui.to_string_lossy().into_owned());
            }
            Err(e) => {
                log::warn!(target: "agentero::op", "gui launch skipped: {e}");
            }
        }
    } else {
        activate_agentero_frontmost();
    }

    Delivery {
        methods,
        gui_launched,
    }
}

/// Speak the same Unix socket protocol as `tauri-plugin-single-instance` (macOS/Linux).
fn notify_single_instance(url: &str) -> bool {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        use std::io::Write;
        use std::os::unix::net::UnixStream;

        // Must match tauri-plugin-single-instance socket_path():
        // identifier "com.poco-ai.agentero" → /tmp/com_poco_ai_agentero_si.sock
        let socket = PathBuf::from("/tmp/com_poco_ai_agentero_si.sock");
        let Ok(stream) = UnixStream::connect(&socket) else {
            return false;
        };
        let cwd = std::env::current_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        // Args: fake argv0 + deep-link URL (Host scans argv for agentero://).
        let args = ["agentero-cli-notify", url].join("\0");
        let mut payload = Vec::new();
        payload.extend_from_slice(cwd.as_bytes());
        payload.extend_from_slice(b"\0\0");
        payload.extend_from_slice(args.as_bytes());
        let mut stream = stream;
        if stream.write_all(&payload).is_err() {
            return false;
        }
        let _ = stream.flush();
        true
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = url;
        false
    }
}

fn activate_agentero_frontmost() {
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("osascript")
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

fn open_system_url(url: &str) -> Result<(), CliError> {
    #[cfg(target_os = "macos")]
    let (program, args): (&str, Vec<&str>) = ("open", vec![url]);
    #[cfg(target_os = "linux")]
    let (program, args): (&str, Vec<&str>) = ("xdg-open", vec![url]);
    #[cfg(target_os = "windows")]
    let (program, args): (&str, Vec<&str>) = ("cmd", vec!["/C", "start", "", url]);
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = url;
        return Err(CliError::message(
            "agentero open is not supported on this platform",
        ));
    }
    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    {
        let status = Command::new(program)
            .args(&args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|e| CliError::message(format!("failed to invoke {program}: {e}")))?;
        if !status.success() {
            return Err(CliError::message(format!(
                "{program} failed ({status}); scheme agentero:// not registered"
            )));
        }
        Ok(())
    }
}

fn launch_gui_with_url(url: &str) -> Result<PathBuf, CliError> {
    let gui = find_gui_binary().ok_or_else(|| {
        CliError::message(
            "desktop binary not found (looked for Agentero.app and target/{debug,release}/agentero)",
        )
    })?;

    #[cfg(target_os = "macos")]
    {
        if gui.extension().is_some_and(|e| e == "app")
            || gui
                .file_name()
                .is_some_and(|n| n.to_string_lossy().ends_with(".app"))
        {
            let status = Command::new("open")
                .args(["-a", &gui.to_string_lossy(), "--args", url])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map_err(|e| CliError::message(format!("open -a failed: {e}")))?;
            if status.success() {
                return Ok(gui);
            }
        }
        if let Some(app) = gui
            .ancestors()
            .find(|p| p.extension().is_some_and(|e| e == "app"))
        {
            let status = Command::new("open")
                .args(["-a", &app.to_string_lossy(), "--args", url])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map_err(|e| CliError::message(format!("open -a failed: {e}")))?;
            if status.success() {
                return Ok(app.to_path_buf());
            }
        }
    }

    let child = Command::new(&gui)
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| {
            CliError::message(format!(
                "failed to spawn desktop binary {}: {e}",
                gui.display()
            ))
        })?;
    let _ = child.id();
    Ok(gui)
}

fn find_gui_binary() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // Prefer workspace GUI next to this CLI (dev).
            candidates.push(dir.join("agentero"));
            #[cfg(windows)]
            candidates.push(dir.join("agentero.exe"));
            candidates.push(dir.join("Agentero"));
            for ancestor in dir.ancestors().take(6) {
                candidates.push(ancestor.join("target/debug/agentero"));
                candidates.push(ancestor.join("target/release/agentero"));
                #[cfg(target_os = "macos")]
                {
                    candidates
                        .push(ancestor.join("src-tauri/target/release/bundle/macos/Agentero.app"));
                    candidates.push(ancestor.join("target/release/bundle/macos/Agentero.app"));
                }
            }
        }
    }

    // Prefer Applications last so dev CLI does not wake an *old* DMG that
    // lacks open handlers while a new binary is available.
    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/Applications/Agentero.app"));
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join("Applications/Agentero.app"));
        }
    }

    candidates.into_iter().find(|p| p.exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deep_link_encodes_path() {
        let url = open_deep_link_url(Path::new("/tmp/my vault"));
        assert!(url.starts_with("agentero://open?path="));
        assert!(url.contains("%20") || url.contains("my%20vault") || url.contains("%2F"));
        assert!(!url.contains(" "));
    }
}
