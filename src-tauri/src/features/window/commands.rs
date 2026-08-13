//! Multi-window helpers.

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::core::log_util::OpTimer;

// Settings store is only used for macOS traffic-light y scaling.
#[cfg(target_os = "macos")]
use crate::features::settings::AppSettingsStore;

/// Default traffic-light y position at 100% UI scale. Matches tauri.conf.json.
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_Y_DEFAULT: f64 = 18.0;
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_X: f64 = 14.0;

/// Top-left y for the macOS traffic-light buttons in the 32px Settings header.
/// 9 + 14 (button height) = 23, leaving 9px above and 9px below for vertical centering.
#[cfg(target_os = "macos")]
const SETTINGS_TRAFFIC_LIGHT_Y: f64 = 16.0;

pub const SETTINGS_WINDOW_LABEL: &str = "settings";

/// Open a fresh Agentero window without restoring the last vault (`?fresh=1`).
///
/// `async` is load-bearing: sync command handlers run on the main thread inside
/// the calling webview's IPC callback, and building a webview from there hangs
/// on Windows — wry waits in a nested message loop for the WebView2 controller
/// callback, which WebView2 only runs once the current handler returns, so
/// `build()` never comes back and the new window stays blank. Async handlers run
/// off the main thread, so window creation is queued onto the event loop
/// instead of nested inside another handler.
#[tauri::command]
pub async fn window_new(app: AppHandle) -> Result<(), String> {
    let op = OpTimer::start("window_new");
    let label = format!("agentero-{}", uuid::Uuid::new_v4().simple());

    // Main window uses tauri.conf.json `dragDropEnabled: false` so HTML5
    // DnD works (vault moves, tab reorder, Library/composer file drops).
    // On Windows, Tauri native drag-drop swallows HTML5 dragover/drop.
    // Frontend preventDefaults leftover file drops so the webview never
    // navigates to a dropped PDF.
    // WebviewWindowBuilder in this Tauri version has no drag_drop_enabled();
    // secondary windows inherit platform defaults — frontend still preventDefaults.
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut builder =
        WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html?fresh=1".into()))
            .title("Agentero")
            .inner_size(1280.0, 800.0)
            .min_inner_size(800.0, 520.0)
            .visible(false)
            .resizable(true);

    #[cfg(target_os = "macos")]
    {
        let scale = app
            .state::<AppSettingsStore>()
            .get()
            .map(|r| r.settings.ui_scale)
            .unwrap_or(1.0);
        let y = if scale.is_finite() && (0.8..=1.5).contains(&scale) {
            TRAFFIC_LIGHT_Y_DEFAULT * scale
        } else {
            TRAFFIC_LIGHT_Y_DEFAULT
        };
        builder = builder
            .hidden_title(true)
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .traffic_light_position(tauri::LogicalPosition::new(TRAFFIC_LIGHT_X, y));
    }

    let window = match builder.build() {
        Ok(w) => w,
        Err(e) => {
            op.finish_err_msg("window", &e);
            return Err(e.to_string());
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

/// Open a singleton native Settings window, or focus it if already open.
///
/// See [`window_new`] for why this must stay `async`.
#[tauri::command]
pub async fn settings_window_open(
    app: AppHandle,
    section: String,
    vault_path: Option<String>,
) -> Result<(), String> {
    let op = OpTimer::start("settings_window_open");

    if let Some(win) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        let _ = win.set_focus();
        op.finish_ok_extra("existing");
        return Ok(());
    }

    let mut url = format!(
        "index.html?window=settings&section={}",
        urlencoding::encode(&section)
    );
    if let Some(path) = vault_path {
        url.push_str(&format!("&vault_path={}", urlencoding::encode(&path)));
    }

    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut builder =
        WebviewWindowBuilder::new(&app, SETTINGS_WINDOW_LABEL, WebviewUrl::App(url.into()))
            .title("Settings")
            .inner_size(720.0, 560.0)
            .min_inner_size(640.0, 480.0)
            .visible(false)
            .resizable(true);

    #[cfg(target_os = "macos")]
    {
        // The 32px header (Tailwind h-8) does not scale with `ui_scale`, so the
        // y position stays at the constant that vertically centers the buttons.
        builder = builder
            .hidden_title(true)
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .traffic_light_position(tauri::LogicalPosition::new(
                TRAFFIC_LIGHT_X,
                SETTINGS_TRAFFIC_LIGHT_Y,
            ));
    }

    let window = match builder.build() {
        Ok(w) => w,
        Err(e) => {
            op.finish_err_msg("settings", &e);
            // Keep the main window's `⌘,` toggle out of a stuck "open" state.
            let _ = app.emit("settings_window_closed", ());
            return Err(e.to_string());
        }
    };
    let _ = window.set_focus();

    op.finish_ok_extra("new");
    Ok(())
}

/// Valid right-rail feature views that may open as a singleton native window.
const FEATURE_VIEWS: &[&str] = &["agent", "backlinks", "annotations", "references", "figures"];

pub fn feature_window_label(view: &str) -> String {
    format!("feature-{view}")
}

/// Parse `feature-{view}` labels; used when emitting close events.
pub fn feature_view_from_label(label: &str) -> Option<&str> {
    label
        .strip_prefix("feature-")
        .filter(|v| FEATURE_VIEWS.contains(v))
}

fn validate_feature_view(view: &str) -> Result<(), String> {
    if FEATURE_VIEWS.contains(&view) {
        Ok(())
    } else {
        Err(format!("unknown feature view: {view}"))
    }
}

/// Stable Webview label for a document path (`doc-` + short sha256 hex).
pub fn doc_window_label(path: &str) -> String {
    let hash = Sha256::digest(path.as_bytes());
    let hex = hex::encode(hash);
    // 16 hex chars is enough to avoid collisions for open doc windows.
    format!("doc-{}", &hex[..16])
}

/// Open (or focus) a singleton feature window for a right-rail view.
///
/// See [`window_new`] for why this must stay `async`.
#[tauri::command]
pub async fn feature_window_open(
    app: AppHandle,
    view: String,
    vault_path: Option<String>,
    active_path: Option<String>,
    paper_title: Option<String>,
    // Localized caption from the frontend (`t()`); English fallbacks below.
    title: Option<String>,
) -> Result<(), String> {
    let op = OpTimer::start("feature_window_open");
    validate_feature_view(&view)?;
    let label = feature_window_label(&view);

    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.set_focus();
        op.finish_ok_extra(format!("existing view={view}"));
        return Ok(());
    }

    let mut url = format!(
        "index.html?window=feature&view={}",
        urlencoding::encode(&view)
    );
    if let Some(path) = vault_path {
        url.push_str(&format!("&vault_path={}", urlencoding::encode(&path)));
    }
    if let Some(path) = active_path.filter(|s| !s.is_empty()) {
        url.push_str(&format!("&active_path={}", urlencoding::encode(&path)));
    }
    if let Some(pt) = paper_title.filter(|s| !s.is_empty()) {
        url.push_str(&format!("&paper_title={}", urlencoding::encode(&pt)));
    }

    let window_title =
        title
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| match view.as_str() {
                "agent" => "Agent".into(),
                "backlinks" => "Backlinks".into(),
                "annotations" => "Annotations".into(),
                "references" => "References".into(),
                "figures" => "Figures".into(),
                other => other.to_string(),
            });

    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title(window_title)
        .inner_size(420.0, 720.0)
        .min_inner_size(320.0, 400.0)
        .visible(false)
        .resizable(true);

    #[cfg(target_os = "macos")]
    {
        let scale = app
            .state::<AppSettingsStore>()
            .get()
            .map(|r| r.settings.ui_scale)
            .unwrap_or(1.0);
        let y = if scale.is_finite() && (0.8..=1.5).contains(&scale) {
            TRAFFIC_LIGHT_Y_DEFAULT * scale
        } else {
            TRAFFIC_LIGHT_Y_DEFAULT
        };
        builder = builder
            .hidden_title(true)
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .traffic_light_position(tauri::LogicalPosition::new(TRAFFIC_LIGHT_X, y));
    }

    let window = match builder.build() {
        Ok(w) => w,
        Err(e) => {
            op.finish_err_msg("feature", &e);
            let _ = app.emit("feature_window_closed", serde_json::json!({ "view": view }));
            return Err(e.to_string());
        }
    };
    let _ = window.set_focus();

    op.finish_ok_extra(format!("new view={view}"));
    Ok(())
}

/// Close a singleton feature window if open.
#[tauri::command]
pub async fn feature_window_close(app: AppHandle, view: String) -> Result<(), String> {
    let op = OpTimer::start("feature_window_close");
    validate_feature_view(&view)?;
    let label = feature_window_label(&view);
    if let Some(win) = app.get_webview_window(&label) {
        win.close().map_err(|e| e.to_string())?;
        op.finish_ok_extra(format!("closed view={view}"));
    } else {
        op.finish_ok_extra(format!("missing view={view}"));
    }
    Ok(())
}

/// Open (or focus) a per-path document window.
///
/// See [`window_new`] for why this must stay `async`.
#[tauri::command]
pub async fn doc_window_open(
    app: AppHandle,
    path: String,
    mode: Option<String>,
    vault_path: Option<String>,
    // Localized caption from the frontend when available.
    title: Option<String>,
) -> Result<(), String> {
    let op = OpTimer::start("doc_window_open");
    if path.trim().is_empty() {
        return Err("path is required".into());
    }
    let label = doc_window_label(&path);

    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.set_focus();
        op.finish_ok_extra(format!("existing label={label}"));
        return Ok(());
    }

    let mut url = format!("index.html?window=doc&path={}", urlencoding::encode(&path));
    if let Some(m) = mode.as_ref().filter(|s| !s.is_empty()) {
        url.push_str(&format!("&mode={}", urlencoding::encode(m)));
    }
    if let Some(vp) = vault_path {
        url.push_str(&format!("&vault_path={}", urlencoding::encode(&vp)));
    }

    let window_title = title.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| {
        std::path::Path::new(&path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("Document")
            .to_string()
    });

    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title(window_title)
        .inner_size(960.0, 720.0)
        .min_inner_size(480.0, 360.0)
        .visible(false)
        .resizable(true);

    #[cfg(target_os = "macos")]
    {
        let scale = app
            .state::<AppSettingsStore>()
            .get()
            .map(|r| r.settings.ui_scale)
            .unwrap_or(1.0);
        let y = if scale.is_finite() && (0.8..=1.5).contains(&scale) {
            TRAFFIC_LIGHT_Y_DEFAULT * scale
        } else {
            TRAFFIC_LIGHT_Y_DEFAULT
        };
        builder = builder
            .hidden_title(true)
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .traffic_light_position(tauri::LogicalPosition::new(TRAFFIC_LIGHT_X, y));
    }

    let window = match builder.build() {
        Ok(w) => w,
        Err(e) => {
            op.finish_err_msg("doc", &e);
            return Err(e.to_string());
        }
    };
    let _ = window.set_focus();

    op.finish_ok_extra(format!("new label={label}"));
    Ok(())
}
