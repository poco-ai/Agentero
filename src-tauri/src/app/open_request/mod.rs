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

/// Validate a workspace UI action, allow fs scope, store pending, emit + focus.
#[cfg(feature = "desktop")]
pub fn handle_ui_request<R: Runtime>(
    app: &AppHandle<R>,
    req: UiRequestPayload,
) -> Result<UiRequestPayload, AppError> {
    let payload = validate_ui_request(req)?;

    if payload.action == UI_ACTION_OPEN_WINDOW {
        let window = payload.window.as_deref().unwrap_or("");
        if !crate::app::window::commands::is_known_window(window) {
            return Err(AppError::message(format!("unknown window: {window}")));
        }
    } else if let Some(vault) = payload.vault_path.as_deref() {
        if let Err(e) = app
            .fs_scope()
            .allow_directory(std::path::Path::new(vault), true)
        {
            log::warn!(
                target: "agentero::op",
                "ui request allow_directory failed vault={} error={e}",
                trunc(vault)
            );
        }
    }

    if let Some(state) = app.try_state::<PendingUiRequest>() {
        state.set(payload.clone());
    }

    let _ = app.emit(EVENT_UI_REQUEST, &payload);
    focus_main_window(app);
    log::info!(
        target: "agentero::op",
        "op end ui_request ok=true action={} vault={} path={} window={}",
        payload.action,
        trunc(payload.vault_path.as_deref().unwrap_or("")),
        trunc(payload.path.as_deref().unwrap_or("")),
        trunc(payload.window.as_deref().unwrap_or(""))
    );
    Ok(payload)
}

/// Stable dedupe key for a UI request (watcher double-write guard).
#[cfg(feature = "desktop")]
fn ui_request_key(req: &UiRequestPayload) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}|{}",
        req.action,
        req.vault_path.as_deref().unwrap_or(""),
        req.path.as_deref().unwrap_or(""),
        req.window.as_deref().unwrap_or(""),
        req.section.as_deref().unwrap_or(""),
        req.direction.as_deref().unwrap_or(""),
        req.reference.as_deref().unwrap_or("")
    )
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
        // `agentero://ui?action=…` — workspace UI action (open paper/path/window).
        if let Ok(req) = parse_ui_url(raw) {
            if let Err(e) = handle_ui_request(app, req) {
                log::warn!(
                    target: "agentero::op",
                    "op end ui_request ok=false url={} error={e}",
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
        let mut last_ui: Option<String> = None;
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
            if let Some(req) = take_cli_ui_request_file() {
                let key = ui_request_key(&req);
                if last_ui.as_deref() != Some(key.as_str()) {
                    match handle_ui_request(&app, req) {
                        Ok(p) => {
                            last_ui = Some(ui_request_key(&p));
                        }
                        Err(e) => {
                            log::warn!(
                                target: "agentero::op",
                                "cli ui request file failed key={} error={e}",
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
