//! Deep-link / second-instance vault open requests (desktop Host side).
//!
//! The tauri-free parsing / validation / CLI request-file helpers live in
//! `agentero_core::features::open_request` and are re-exported here so the
//! historical `crate::features::open_request::X` paths stay stable. This file
//! keeps the Tauri-coupled handlers: fs-scope extension, pending-path cache,
//! event emit, window focus, and the CLI request-file watcher.

pub use agentero_core::features::open_request::*;

#[cfg(feature = "desktop")]
pub mod commands;

#[cfg(feature = "desktop")]
use crate::core::error::AppError;
#[cfg(feature = "desktop")]
use std::path::Path;
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Emitter, Manager, Runtime};
#[cfg(feature = "desktop")]
use tauri_plugin_fs::FsExt;

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

/// Validate a paper request, allow fs scope, store pending, emit + focus.
#[cfg(feature = "desktop")]
pub fn handle_paper_open_path<R: Runtime>(
    app: &AppHandle<R>,
    vault: &Path,
    paper_rel: &str,
) -> Result<PaperOpenPayload, AppError> {
    let canonical = validate_open_dir(vault)?;
    let paper_path = normalize_paper_rel(paper_rel)?;
    let vault_path = canonical.to_string_lossy().to_string();

    if let Err(e) = app.fs_scope().allow_directory(&canonical, true) {
        log::warn!(
            target: "agentero::op",
            "paper open allow_directory failed vault={} error={e}",
            trunc(&vault_path)
        );
    }

    let payload = PaperOpenPayload {
        vault_path: vault_path.clone(),
        paper_path: paper_path.clone(),
    };
    if let Some(state) = app.try_state::<PendingPaperOpen>() {
        state.set(payload.clone());
    }

    let _ = app.emit(EVENT_PAPER_OPEN_REQUEST, &payload);
    focus_main_window(app);
    log::info!(
        target: "agentero::op",
        "op end paper_open_request ok=true vault={} paper={}",
        trunc(&vault_path),
        trunc(&paper_path)
    );
    Ok(payload)
}

/// Emit the shared `vault:open-error` toast payload.
#[cfg(feature = "desktop")]
fn emit_open_error<R: Runtime>(app: &AppHandle<R>, message: &str) {
    let _ = app.emit(
        "vault:open-error",
        serde_json::json!({ "message": message }),
    );
}

/// Handle one or more deep-link URLs; non-open URLs are ignored with a warning.
#[cfg(feature = "desktop")]
pub fn handle_deep_link_urls<R: Runtime>(app: &AppHandle<R>, urls: &[String]) {
    for raw in urls {
        if raw.contains("://pair") || raw.contains(":pair") {
            // Mobile pairing — leave to the mobile UI / other handlers.
            continue;
        }
        // `agentero://paper?vault=…&path=…` — open one paper.
        if let Ok((vault, paper)) = parse_paper_open_url(raw) {
            if let Err(e) = handle_paper_open_path(app, &vault, &paper) {
                log::warn!(
                    target: "agentero::op",
                    "op end paper_open_request ok=false url={} error={e}",
                    trunc(raw)
                );
                emit_open_error(app, &e.to_string());
            }
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
                    emit_open_error(app, &e.to_string());
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
            emit_open_error(app, &e.to_string());
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

/// Poll the CLI open-request files and forward into the normal open pipeline.
#[cfg(feature = "desktop")]
pub fn spawn_cli_open_request_watcher<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let mut last_handled: Option<String> = None;
        let mut last_paper: Option<String> = None;
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
            if let Some(path) = take_cli_open_request_file() {
                let key = path.to_string_lossy().into_owned();
                if last_handled.as_deref() != Some(key.as_str()) {
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
                            emit_open_error(&app, &e.to_string());
                        }
                    }
                }
            }
            if let Some(payload) = take_cli_paper_open_request_file() {
                let key = format!("{}::{}", payload.vault_path, payload.paper_path);
                if last_paper.as_deref() != Some(key.as_str()) {
                    match handle_paper_open_path(
                        &app,
                        Path::new(&payload.vault_path),
                        &payload.paper_path,
                    ) {
                        Ok(p) => {
                            last_paper = Some(format!("{}::{}", p.vault_path, p.paper_path));
                        }
                        Err(e) => {
                            log::warn!(
                                target: "agentero::op",
                                "cli paper open request file failed key={} error={e}",
                                trunc(&key)
                            );
                            emit_open_error(&app, &e.to_string());
                        }
                    }
                }
            }
        }
    });
}
