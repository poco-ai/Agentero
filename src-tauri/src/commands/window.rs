//! Multi-window helpers.

use crate::error::AppError;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const SETTINGS_WINDOW_LABEL: &str = "agentero-settings";

/// Open a fresh Agentero window without restoring the last vault (`?fresh=1`).
#[tauri::command]
pub fn window_new(app: AppHandle) -> Result<(), AppError> {
    use crate::log_util::OpTimer;

    let op = OpTimer::start("window_new");
    let label = format!("agentero-{}", uuid::Uuid::new_v4().simple());

    // Main window uses tauri.conf.json `dragDropEnabled: false` so HTML5 DnD
    // works (vault moves / agent chips). OS file drops are cancelled in the
    // frontend so the webview never navigates to a dropped PDF.
    // WebviewWindowBuilder in this Tauri version has no drag_drop_enabled();
    // secondary windows inherit platform defaults — frontend still preventDefaults.
    let mut builder =
        WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html?fresh=1".into()))
            .title("Agentero")
            .inner_size(1280.0, 800.0)
            .min_inner_size(800.0, 520.0)
            .resizable(true)
            .focused(true);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .hidden_title(true)
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .traffic_light_position(tauri::LogicalPosition::new(14.0, 18.0));
    }

    // Non-macOS: frameless window; caption buttons are drawn in the React title
    // bar (see WindowControls) so the chrome matches the macOS Overlay look.
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.decorations(false);
    }

    let window = match builder.build() {
        Ok(w) => w,
        Err(e) => {
            op.finish_err_msg("window", &e);
            return Err(AppError::internal(e.to_string()));
        }
    };
    let _ = window.set_focus();

    // Native menu is macOS-only; other platforms drive actions from the React
    // title bar + keyboard shortcuts, so no window menu is attached.
    #[cfg(target_os = "macos")]
    if let Some(menu) = app.menu() {
        let _ = window.set_menu(menu);
    }

    op.finish_ok_extra(format!("label={label}"));
    Ok(())
}

/// Open (or focus) the singleton native Settings window.
///
/// `section` deep-links a settings section; `vault` carries the opener
/// window's vault path so remote-vault context renders correctly.
#[tauri::command]
pub fn settings_window_open(
    app: AppHandle,
    section: Option<String>,
    vault: Option<String>,
) -> Result<(), AppError> {
    use crate::log_util::OpTimer;

    let op = OpTimer::start("settings_window_open");

    if let Some(existing) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        let _ = existing.set_focus();
        let _ = existing.emit(
            "settings:navigate",
            serde_json::json!({ "section": section }),
        );
        op.finish_ok_extra("focused=existing");
        return Ok(());
    }

    let mut url = String::from("index.html?window=settings");
    if let Some(section) = section.as_deref().filter(|s| !s.is_empty()) {
        url.push_str("&section=");
        url.push_str(&urlencoding::encode(section));
    }
    if let Some(vault) = vault.as_deref().filter(|v| !v.is_empty()) {
        url.push_str("&vault=");
        url.push_str(&urlencoding::encode(vault));
    }

    // Native title bar on every platform: settings is a utility window, so it
    // follows OS conventions instead of the frameless main-window chrome.
    let builder =
        WebviewWindowBuilder::new(&app, SETTINGS_WINDOW_LABEL, WebviewUrl::App(url.into()))
            .title("Settings")
            .inner_size(760.0, 600.0)
            .min_inner_size(640.0, 480.0)
            .resizable(true)
            .maximizable(false)
            .focused(true);

    let window = match builder.build() {
        Ok(w) => w,
        Err(e) => {
            op.finish_err_msg("window", &e);
            return Err(AppError::internal(e.to_string()));
        }
    };
    let _ = window.set_focus();

    #[cfg(target_os = "macos")]
    if let Some(menu) = app.menu() {
        let _ = window.set_menu(menu);
    }

    op.finish_ok();
    Ok(())
}
