use serde::{Deserialize, Serialize};
#[cfg(any(test, target_os = "macos", target_os = "windows", target_os = "linux"))]
use tauri::Url;
use tauri::WebviewWindow;

#[derive(Debug, Clone, Copy, Deserialize, specta::Type)]
pub struct SidebarBrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SidebarBrowserCommand {
    Show {
        url: String,
        bounds: SidebarBrowserBounds,
    },
    Hide,
    Close,
    Navigate {
        url: String,
    },
    Back,
    Forward,
    Reload,
    Read,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SidebarBrowserState {
    url: String,
    title: String,
    loading: bool,
    can_go_back: bool,
    can_go_forward: bool,
}

#[cfg(any(test, target_os = "macos", target_os = "windows", target_os = "linux"))]
const MAX_BOUND_COORD: f64 = 32768.0;
#[cfg(any(test, target_os = "macos", target_os = "windows", target_os = "linux"))]
const MAX_TITLE_CHARS: usize = 256;

#[cfg(any(test, target_os = "macos", target_os = "windows", target_os = "linux"))]
#[derive(Debug, Clone, Copy, PartialEq)]
struct ValidatedBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[cfg(any(test, target_os = "macos", target_os = "windows", target_os = "linux"))]
fn web_url(raw: &str) -> Option<Url> {
    let url = Url::parse(raw).ok()?;
    (matches!(url.scheme(), "http" | "https")
        && url.has_host()
        && url.username().is_empty()
        && url.password().is_none())
    .then_some(url)
}

#[cfg(any(test, target_os = "macos", target_os = "windows", target_os = "linux"))]
fn validate_bounds(rect: SidebarBrowserBounds) -> Result<ValidatedBounds, String> {
    let values = [rect.x, rect.y, rect.width, rect.height];
    if !values
        .iter()
        .all(|value| value.is_finite() && (0.0..=MAX_BOUND_COORD).contains(value))
        || rect.width < 1.0
        || rect.height < 1.0
    {
        return Err("Invalid browser bounds".into());
    }
    Ok(ValidatedBounds {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
    })
}

#[cfg(any(test, target_os = "macos", target_os = "windows", target_os = "linux"))]
fn normalize_title(raw: &str) -> String {
    raw.chars().take(MAX_TITLE_CHARS).collect()
}

#[cfg(any(test, target_os = "macos", target_os = "windows", target_os = "linux"))]
fn normalize_snapshot(
    raw_url: Option<String>,
    raw_title: &str,
    loading: bool,
    can_go_back: bool,
    can_go_forward: bool,
) -> SidebarBrowserState {
    SidebarBrowserState {
        url: raw_url
            .filter(|url| web_url(url).is_some())
            .unwrap_or_default(),
        title: normalize_title(raw_title),
        loading,
        can_go_back,
        can_go_forward,
    }
}

#[cfg(any(test, target_os = "macos", target_os = "windows", target_os = "linux"))]
#[derive(Debug, Default)]
struct PageStatus {
    title: String,
    loading: bool,
}

#[cfg(any(test, target_os = "macos", target_os = "windows", target_os = "linux"))]
trait BrowserSurface {
    fn load_url(&self, url: &str) -> Result<(), String>;
    fn reload(&self) -> Result<(), String>;
    fn go_back(&self) -> Result<(), String>;
    fn go_forward(&self) -> Result<(), String>;
    fn set_bounds(&self, rect: ValidatedBounds) -> Result<(), String>;
    fn set_visible(&self, visible: bool) -> Result<(), String>;
    fn snapshot(&self) -> SidebarBrowserState;
}

#[cfg(any(test, target_os = "macos", target_os = "windows", target_os = "linux"))]
struct BrowserRegistry<V> {
    windows: std::collections::HashMap<String, std::collections::HashMap<String, V>>,
}

#[cfg(any(test, target_os = "macos", target_os = "windows", target_os = "linux"))]
impl<V> Default for BrowserRegistry<V> {
    fn default() -> Self {
        Self {
            windows: std::collections::HashMap::new(),
        }
    }
}

#[cfg(any(test, target_os = "macos", target_os = "windows", target_os = "linux"))]
impl<V: BrowserSurface> BrowserRegistry<V> {
    fn apply<F>(
        &mut self,
        window_label: &str,
        id: String,
        command: SidebarBrowserCommand,
        create: F,
    ) -> Result<Option<SidebarBrowserState>, String>
    where
        F: FnOnce(&str, &Url, ValidatedBounds) -> Result<V, String>,
    {
        match command {
            SidebarBrowserCommand::Show { url, bounds } => {
                let url = web_url(&url).ok_or("Invalid web address")?;
                let rect = validate_bounds(bounds)?;
                let views = self.windows.entry(window_label.to_owned()).or_default();
                for (other, view) in views.iter() {
                    if *other != id {
                        view.set_visible(false)?;
                    }
                }
                if !views.contains_key(&id) {
                    let created = create(&id, &url, rect)?;
                    views.insert(id.clone(), created);
                }
                let view = &views[&id];
                view.set_bounds(rect)?;
                view.set_visible(true)?;
                Ok(Some(view.snapshot()))
            }
            SidebarBrowserCommand::Close => {
                if let Some(views) = self.windows.get_mut(window_label) {
                    views.remove(&id);
                    if views.is_empty() {
                        self.windows.remove(window_label);
                    }
                }
                Ok(None)
            }
            other => {
                let Some(view) = self
                    .windows
                    .get(window_label)
                    .and_then(|views| views.get(&id))
                else {
                    return Ok(None);
                };
                match other {
                    SidebarBrowserCommand::Hide => {
                        view.set_visible(false)?;
                        return Ok(None);
                    }
                    SidebarBrowserCommand::Navigate { url } => {
                        let url = web_url(&url).ok_or("Invalid web address")?;
                        view.load_url(url.as_str())?;
                    }
                    SidebarBrowserCommand::Back => view.go_back()?,
                    SidebarBrowserCommand::Forward => view.go_forward()?,
                    SidebarBrowserCommand::Reload => view.reload()?,
                    SidebarBrowserCommand::Read => {}
                    SidebarBrowserCommand::Show { .. } | SidebarBrowserCommand::Close => {
                        unreachable!()
                    }
                }
                Ok(Some(view.snapshot()))
            }
        }
    }

    fn get(&self, window_label: &str, id: &str) -> Option<&V> {
        self.windows
            .get(window_label)
            .and_then(|views| views.get(id))
    }

    fn views_for(&self, window_label: &str) -> Option<impl Iterator<Item = &V>> {
        self.windows.get(window_label).map(|views| views.values())
    }

    fn remove_window(&mut self, window_label: &str) {
        self.windows.remove(window_label);
    }
}

#[tauri::command]
#[specta::specta]
pub async fn sidebar_browser_command(
    window: WebviewWindow,
    view_id: String,
    command: SidebarBrowserCommand,
) -> Result<Option<SidebarBrowserState>, String> {
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        #[cfg(target_os = "windows")]
        if matches!(command, SidebarBrowserCommand::Show { .. }) {
            let (tx, rx) = tokio::sync::oneshot::channel();
            let parent = window.clone();
            // `with_webview` runs synchronously on the main/UI thread in Tauri's
            // Wry runtime, giving us direct access to the host WebView2 environment
            // before constructing a child WebView.
            window
                .with_webview(move |host| {
                    let environment = host.environment();
                    let _ = tx.send(native::apply_with_env(
                        &parent,
                        view_id,
                        command,
                        Some(environment),
                    ));
                })
                .map_err(|error| error.to_string())?;
            return rx.await.map_err(|error| error.to_string())?;
        }

        let (tx, rx) = tokio::sync::oneshot::channel();
        let parent = window.clone();
        window
            .run_on_main_thread(move || {
                let _ = tx.send(native::apply(&parent, view_id, command));
            })
            .map_err(|error| error.to_string())?;
        rx.await.map_err(|error| error.to_string())?
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = (window, view_id, command);
        Err("Embedded browsing is available on desktop".into())
    }
}

pub fn is_focused(window: &str) -> bool {
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        native::is_focused(window)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = window;
        false
    }
}

pub fn close_window(window: &str) {
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    native::close_window(window);
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    let _ = window;
}

/// Prepare a freshly created desktop window to host sidebar WebViews before it
/// is shown. On Linux/GTK, wrapping `default_vbox` inside a `gtk::Overlay`
/// while the window is still unrealized avoids detaching a live main
/// `WebKitWebView` later when the first sidebar browser tab opens.
#[cfg(target_os = "linux")]
pub fn prepare_window(window: &WebviewWindow) {
    let win = window.clone();
    let _ = window.run_on_main_thread(move || {
        let _ = native::prepare_window(&win);
    });
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
mod native {
    use super::*;
    use std::{
        cell::{Cell, RefCell},
        sync::{Arc, Mutex},
    };
    use wry::{
        dpi::{LogicalPosition, LogicalSize},
        NewWindowResponse, PageLoadEvent, PermissionResponse, Rect, WebView, WebViewBuilder,
    };

    struct BrowserView {
        webview: WebView,
        status: Arc<Mutex<PageStatus>>,
        visible: Cell<bool>,
    }

    thread_local! {
        static REGISTRY: RefCell<BrowserRegistry<BrowserView>> = RefCell::default();
    }

    fn to_wry_rect(rect: ValidatedBounds) -> Rect {
        Rect {
            position: LogicalPosition::new(rect.x, rect.y).into(),
            size: LogicalSize::new(rect.width, rect.height).into(),
        }
    }

    fn explain(error: wry::Error) -> String {
        platform::format_error(error)
    }

    impl BrowserSurface for BrowserView {
        fn load_url(&self, url: &str) -> Result<(), String> {
            self.webview.load_url(url).map_err(explain)
        }

        fn reload(&self) -> Result<(), String> {
            self.webview.reload().map_err(explain)
        }

        fn go_back(&self) -> Result<(), String> {
            self.webview.go_back().map_err(explain)
        }

        fn go_forward(&self) -> Result<(), String> {
            self.webview.go_forward().map_err(explain)
        }

        fn set_bounds(&self, rect: ValidatedBounds) -> Result<(), String> {
            platform::set_bounds(&self.webview, rect)
        }

        fn set_visible(&self, visible: bool) -> Result<(), String> {
            if self.visible.get() == visible {
                return Ok(());
            }
            platform::set_visible(&self.webview, visible)?;
            self.visible.set(visible);
            Ok(())
        }

        fn snapshot(&self) -> SidebarBrowserState {
            let (title, loading) = match self.status.lock() {
                Ok(status) => (status.title.clone(), status.loading),
                Err(poisoned) => {
                    let status = poisoned.into_inner();
                    (status.title.clone(), status.loading)
                }
            };
            normalize_snapshot(
                self.webview.url().ok(),
                &title,
                loading,
                self.webview.can_go_back().unwrap_or(false),
                self.webview.can_go_forward().unwrap_or(false),
            )
        }
    }

    #[cfg(target_os = "windows")]
    type HostContext =
        Option<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment>;
    #[cfg(not(target_os = "windows"))]
    type HostContext = ();

    fn create(
        window: &WebviewWindow,
        id: &str,
        url: &Url,
        rect: ValidatedBounds,
        #[allow(unused_variables)] host_ctx: HostContext,
    ) -> Result<BrowserView, String> {
        let parent = window.clone();
        let window_label = window.label().to_owned();
        let view_id = id.to_owned();
        let status = Arc::new(Mutex::new(PageStatus::default()));
        let title_status = Arc::clone(&status);
        let load_status = Arc::clone(&status);

        let builder = WebViewBuilder::new()
            .with_url(url.as_str())
            .with_bounds(to_wry_rect(rect))
            .with_incognito(true)
            .with_visible(false)
            .with_focused(false)
            .with_devtools(false)
            .with_back_forward_navigation_gestures(true)
            .with_document_title_changed_handler(move |title| {
                if let Ok(mut guard) = title_status.lock() {
                    guard.title = normalize_title(&title);
                }
            })
            .with_on_page_load_handler(move |event, _| {
                if let Ok(mut guard) = load_status.lock() {
                    guard.loading = matches!(event, PageLoadEvent::Started);
                }
            })
            .with_navigation_handler(|target| web_url(&target).is_some())
            .with_new_window_req_handler(move |target, _| {
                if let Some(url) = web_url(&target) {
                    let window_label = window_label.clone();
                    let view_id = view_id.clone();
                    let parent = parent.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = parent.run_on_main_thread(move || {
                            REGISTRY.with(|registry| {
                                let registry = registry.borrow();
                                if let Some(view) = registry.get(&window_label, &view_id) {
                                    let _ = view.load_url(url.as_str());
                                }
                            });
                        });
                    });
                }
                NewWindowResponse::Deny
            })
            .with_permission_handler(|_| PermissionResponse::Deny)
            .with_download_started_handler(|_, _| false);

        #[cfg(target_os = "windows")]
        let webview = platform::build_webview(window, builder, host_ctx)?;
        #[cfg(not(target_os = "windows"))]
        let webview = platform::build_webview(window, builder)?;
        Ok(BrowserView {
            webview,
            status,
            visible: Cell::new(false),
        })
    }

    pub fn apply(
        window: &WebviewWindow,
        id: String,
        command: SidebarBrowserCommand,
    ) -> Result<Option<SidebarBrowserState>, String> {
        #[cfg(target_os = "windows")]
        {
            apply_with_env(window, id, command, None)
        }
        #[cfg(not(target_os = "windows"))]
        {
            REGISTRY.with(|registry| {
                registry
                    .borrow_mut()
                    .apply(window.label(), id, command, |view_id, url, rect| {
                        create(window, view_id, url, rect, ())
                    })
            })
        }
    }

    #[cfg(target_os = "windows")]
    pub fn apply_with_env(
        window: &WebviewWindow,
        id: String,
        command: SidebarBrowserCommand,
        environment: HostContext,
    ) -> Result<Option<SidebarBrowserState>, String> {
        let mut environment = environment;
        REGISTRY.with(|registry| {
            registry
                .borrow_mut()
                .apply(window.label(), id, command, |view_id, url, rect| {
                    create(window, view_id, url, rect, environment.take())
                })
        })
    }

    pub fn is_focused(window: &str) -> bool {
        REGISTRY.with(|registry| {
            registry
                .borrow()
                .views_for(window)
                .is_some_and(|mut views| views.any(|view| platform::is_view_focused(&view.webview)))
        })
    }

    pub fn close_window(window: &str) {
        REGISTRY.with(|registry| {
            registry.borrow_mut().remove_window(window);
        });
        platform::cleanup_window(window);
    }

    #[cfg(target_os = "linux")]
    pub fn prepare_window(window: &WebviewWindow) -> Result<(), String> {
        platform::prepare_window(window)
    }

    #[cfg(target_os = "macos")]
    mod platform {
        use super::{to_wry_rect, ValidatedBounds};
        use objc2_app_kit::NSView;
        use tauri::WebviewWindow;
        use wry::{WebView, WebViewBuilder, WebViewExtMacOS};

        pub fn format_error(error: wry::Error) -> String {
            error.to_string()
        }

        pub fn build_webview(
            window: &WebviewWindow,
            builder: WebViewBuilder<'_>,
        ) -> Result<WebView, String> {
            builder.build_as_child(window).map_err(format_error)
        }

        pub fn set_bounds(view: &WebView, rect: ValidatedBounds) -> Result<(), String> {
            view.set_bounds(to_wry_rect(rect)).map_err(format_error)
        }

        pub fn set_visible(view: &WebView, visible: bool) -> Result<(), String> {
            view.set_visible(visible).map_err(format_error)
        }

        pub fn is_view_focused(view: &WebView) -> bool {
            let wk = view.webview();
            if wk.isHiddenOrHasHiddenAncestor() {
                return false;
            }
            let Some(responder) = wk.window().and_then(|window| window.firstResponder()) else {
                return false;
            };
            responder
                .downcast::<NSView>()
                .is_ok_and(|responder| responder.isDescendantOf(&wk))
        }

        pub fn cleanup_window(_window: &str) {}
    }

    #[cfg(target_os = "windows")]
    mod platform {
        use super::{to_wry_rect, ValidatedBounds};
        use tauri::WebviewWindow;
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment;
        use windows::Win32::UI::{
            Input::KeyboardAndMouse::GetFocus,
            WindowsAndMessaging::{IsChild, IsWindowVisible},
        };
        use wry::{WebView, WebViewBuilder, WebViewBuilderExtWindows, WebViewExtWindows};

        pub fn format_error(error: wry::Error) -> String {
            match error {
                wry::Error::WebView2Error(inner) => {
                    format!("WebView2 runtime error: {inner}")
                }
                other => other.to_string(),
            }
        }

        pub fn build_webview(
            window: &WebviewWindow,
            mut builder: WebViewBuilder<'_>,
            environment: Option<ICoreWebView2Environment>,
        ) -> Result<WebView, String> {
            // Reuse the host window's WebView2 environment so child views share the
            // app's writable data directory instead of initializing beside the
            // executable (which can fail under Program Files), while keeping site
            // state isolated via `with_incognito(true)`.
            if let Some(environment) = environment {
                builder = builder.with_environment(environment);
            }
            builder.build_as_child(window).map_err(format_error)
        }

        pub fn set_bounds(view: &WebView, rect: ValidatedBounds) -> Result<(), String> {
            view.set_bounds(to_wry_rect(rect)).map_err(format_error)
        }

        pub fn set_visible(view: &WebView, visible: bool) -> Result<(), String> {
            view.set_visible(visible).map_err(format_error)
        }

        pub fn is_view_focused(view: &WebView) -> bool {
            let hwnd = view.hwnd();
            unsafe {
                if !IsWindowVisible(hwnd).as_bool() {
                    return false;
                }
                let focused = GetFocus();
                !focused.is_invalid() && (focused == hwnd || IsChild(hwnd, focused).as_bool())
            }
        }

        pub fn cleanup_window(_window: &str) {}
    }

    #[cfg(target_os = "linux")]
    mod platform {
        use super::ValidatedBounds;
        use gtk::{prelude::*, OverlaySignals, Rectangle};
        use std::{cell::RefCell, collections::HashMap, rc::Rc};
        use tauri::WebviewWindow;
        use wry::{WebView, WebViewBuilder, WebViewBuilderExtUnix, WebViewExtUnix};

        struct OverlayHost {
            overlay: gtk::Overlay,
            /// Logical rectangles keyed by each child `GtkWidget` pointer so
            /// `get-child-position` allocates overlay children directly without
            /// inflating `GtkOverlay`'s minimum window size via margins.
            rects: Rc<RefCell<HashMap<usize, Rectangle>>>,
        }

        thread_local! {
            static OVERLAY_HOSTS: RefCell<HashMap<String, OverlayHost>> = RefCell::default();
        }

        pub fn format_error(error: wry::Error) -> String {
            error.to_string()
        }

        fn widget_key(widget: &impl IsA<gtk::Widget>) -> usize {
            widget.as_ref().as_ptr() as usize
        }

        fn to_gtk_rect(rect: ValidatedBounds) -> Rectangle {
            Rectangle::new(
                rect.x.round() as i32,
                rect.y.round() as i32,
                rect.width.round().max(1.0) as i32,
                rect.height.round().max(1.0) as i32,
            )
        }

        /// Ensure the Tauri window has a `gtk::Overlay` wrapping its existing
        /// `default_vbox`, so each sidebar WebView can be mounted as its own
        /// positioned overlay child on both X11 and Wayland without creating a
        /// second top-level window, calling X11-only child-window APIs, or
        /// covering the workspace with a full-window input surface.
        fn ensure_overlay_host(
            window: &WebviewWindow,
        ) -> Result<(gtk::Overlay, Rc<RefCell<HashMap<usize, Rectangle>>>), String> {
            let label = window.label().to_owned();
            if let Some(existing) = OVERLAY_HOSTS.with(|hosts| {
                hosts
                    .borrow()
                    .get(&label)
                    .map(|host| (host.overlay.clone(), Rc::clone(&host.rects)))
            }) {
                return Ok(existing);
            }

            let gtk_window = window
                .gtk_window()
                .map_err(|error| format!("GTK host window unavailable: {error}"))?;
            let vbox = window
                .default_vbox()
                .map_err(|error| format!("GTK default container unavailable: {error}"))?;

            // Wrap the existing `default_vbox` inside a `gtk::Overlay` once so
            // Tauri's main WebView keeps its container while sidebar WebViews
            // float only over the right-sidebar rect in logical GTK coordinates.
            let overlay = if let Some(existing_overlay) = vbox
                .parent()
                .and_then(|parent| parent.downcast::<gtk::Overlay>().ok())
            {
                existing_overlay
            } else {
                // Keep a strong GObject reference to `vbox` while detaching it
                // from `gtk_window` and reattaching it as the overlay base child.
                let overlay = gtk::Overlay::new();
                overlay.set_hexpand(true);
                overlay.set_vexpand(true);
                gtk_window.remove(&vbox);
                overlay.add(&vbox);
                gtk_window.add(&overlay);
                overlay.show();
                vbox.show();
                overlay
            };

            let rects: Rc<RefCell<HashMap<usize, Rectangle>>> =
                Rc::new(RefCell::new(HashMap::new()));
            let rects_for_signal = Rc::clone(&rects);
            overlay.connect_get_child_position(move |_overlay, widget| {
                rects_for_signal.borrow().get(&widget_key(widget)).cloned()
            });

            OVERLAY_HOSTS.with(|hosts| {
                hosts.borrow_mut().insert(
                    label,
                    OverlayHost {
                        overlay: overlay.clone(),
                        rects: Rc::clone(&rects),
                    },
                );
            });
            Ok((overlay, rects))
        }

        pub fn prepare_window(window: &WebviewWindow) -> Result<(), String> {
            ensure_overlay_host(window).map(|_| ())
        }

        pub fn build_webview(
            window: &WebviewWindow,
            builder: WebViewBuilder<'_>,
        ) -> Result<WebView, String> {
            let (overlay, rects) = ensure_overlay_host(window)?;
            // Build inside a transient `gtk::Box` (not `gtk::Fixed`, so wry
            // does not leave `is_in_fixed_parent` set for a removed parent),
            // then mount the resulting `WebKitWebView` directly onto
            // `gtk::Overlay` via `add_overlay` so it floats above `default_vbox`
            // with input restricted strictly to its allocated sidebar rectangle
            // on both X11 and Wayland.
            let staging = gtk::Box::new(gtk::Orientation::Vertical, 0);
            let webview = builder.build_gtk(&staging).map_err(format_error)?;
            let webkit_view = webview.webview();
            staging.remove(&webkit_view);
            // `no_show_all` prevents any parent `show_all()` from revealing a
            // hidden sidebar tab behind the registry's back.
            webkit_view.set_no_show_all(true);
            webkit_view.set_size_request(0, 0);
            let key = widget_key(&webkit_view);
            let rects_for_destroy = Rc::clone(&rects);
            webkit_view.connect_destroy(move |_| {
                rects_for_destroy.borrow_mut().remove(&key);
            });
            overlay.add_overlay(&webkit_view);
            webkit_view.hide();
            Ok(webview)
        }

        pub fn set_bounds(view: &WebView, rect: ValidatedBounds) -> Result<(), String> {
            let gtk_rect = to_gtk_rect(rect);
            let webkit_view = view.webview();
            let key = widget_key(&webkit_view);

            // Store exact `(x, y, width, height)` for `GtkOverlay`'s
            // `get-child-position` signal instead of using margins +
            // `set_size_request`, which would inflate the window's minimum size
            // and block shrinking the window narrower than `x + width`.
            if let Some(overlay) = webkit_view
                .parent()
                .and_then(|parent| parent.downcast::<gtk::Overlay>().ok())
            {
                OVERLAY_HOSTS.with(|hosts| {
                    for host in hosts.borrow().values() {
                        if host.overlay == overlay {
                            host.rects.borrow_mut().insert(key, gtk_rect);
                            break;
                        }
                    }
                });
                overlay.queue_allocate();
            }
            webkit_view.queue_allocate();
            Ok(())
        }

        pub fn set_visible(view: &WebView, visible: bool) -> Result<(), String> {
            let webkit_view = view.webview();
            if visible {
                webkit_view.show();
                if let Some(overlay) = webkit_view
                    .parent()
                    .and_then(|parent| parent.downcast::<gtk::Overlay>().ok())
                {
                    overlay.queue_allocate();
                }
            } else {
                webkit_view.hide();
            }
            Ok(())
        }

        pub fn is_view_focused(view: &WebView) -> bool {
            let webkit_view = view.webview();
            webkit_view.is_visible() && webkit_view.has_focus()
        }

        pub fn cleanup_window(window: &str) {
            OVERLAY_HOSTS.with(|hosts| {
                hosts.borrow_mut().remove(window);
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Debug, Default)]
    struct MockViewState {
        url: String,
        title: String,
        loading: bool,
        can_go_back: bool,
        can_go_forward: bool,
        visible: bool,
        bounds: Option<ValidatedBounds>,
        ops: Vec<String>,
    }

    struct MockSurface {
        state: RefCell<MockViewState>,
    }

    impl MockSurface {
        fn new(url: &str, rect: ValidatedBounds) -> Self {
            Self {
                state: RefCell::new(MockViewState {
                    url: url.to_owned(),
                    title: "Example".to_owned(),
                    loading: false,
                    can_go_back: false,
                    can_go_forward: false,
                    visible: false,
                    bounds: Some(rect),
                    ops: Vec::new(),
                }),
            }
        }
    }

    impl BrowserSurface for MockSurface {
        fn load_url(&self, url: &str) -> Result<(), String> {
            let mut state = self.state.borrow_mut();
            state.url = url.to_owned();
            state.can_go_back = true;
            state.ops.push(format!("load:{url}"));
            Ok(())
        }

        fn reload(&self) -> Result<(), String> {
            self.state.borrow_mut().ops.push("reload".into());
            Ok(())
        }

        fn go_back(&self) -> Result<(), String> {
            let mut state = self.state.borrow_mut();
            state.can_go_back = false;
            state.can_go_forward = true;
            state.ops.push("back".into());
            Ok(())
        }

        fn go_forward(&self) -> Result<(), String> {
            let mut state = self.state.borrow_mut();
            state.can_go_back = true;
            state.can_go_forward = false;
            state.ops.push("forward".into());
            Ok(())
        }

        fn set_bounds(&self, rect: ValidatedBounds) -> Result<(), String> {
            self.state.borrow_mut().bounds = Some(rect);
            Ok(())
        }

        fn set_visible(&self, visible: bool) -> Result<(), String> {
            self.state.borrow_mut().visible = visible;
            Ok(())
        }

        fn snapshot(&self) -> SidebarBrowserState {
            let state = self.state.borrow();
            normalize_snapshot(
                Some(state.url.clone()),
                &state.title,
                state.loading,
                state.can_go_back,
                state.can_go_forward,
            )
        }
    }

    fn sample_bounds() -> SidebarBrowserBounds {
        SidebarBrowserBounds {
            x: 120.0,
            y: 40.0,
            width: 480.0,
            height: 720.0,
        }
    }

    #[test]
    fn rejects_privileged_schemes_and_embedded_credentials() {
        for raw in [
            "file:///tmp/paper",
            "agentero://localhost/",
            "javascript:alert(1)",
            "data:text/html,hi",
            "about:blank",
            "https://user:pass@example.org/",
            "https://user@example.org/",
            "http://:pass@example.org/",
            "https://",
        ] {
            assert!(web_url(raw).is_none(), "{raw}");
        }
        assert!(web_url("https://example.org/paper").is_some());
        assert!(web_url("http://localhost:8080/docs").is_some());
    }

    #[test]
    fn validates_bounds_rejecting_invalid_or_empty_rects() {
        assert!(validate_bounds(sample_bounds()).is_ok());
        for invalid in [
            SidebarBrowserBounds {
                x: -1.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
            SidebarBrowserBounds {
                x: 0.0,
                y: f64::NAN,
                width: 100.0,
                height: 100.0,
            },
            SidebarBrowserBounds {
                x: 0.0,
                y: 0.0,
                width: 0.5,
                height: 100.0,
            },
            SidebarBrowserBounds {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 32769.0,
            },
        ] {
            assert_eq!(
                validate_bounds(invalid).unwrap_err(),
                "Invalid browser bounds"
            );
        }
    }

    #[test]
    fn normalizes_snapshot_url_and_truncates_long_title() {
        let long_title = "a".repeat(300);
        let state = normalize_snapshot(
            Some("file:///etc/passwd".into()),
            &long_title,
            true,
            true,
            false,
        );
        assert_eq!(state.url, "");
        assert_eq!(state.title.chars().count(), MAX_TITLE_CHARS);
        assert!(state.loading);
        assert!(state.can_go_back);
        assert!(!state.can_go_forward);
    }

    #[test]
    fn registry_lifecycle_hides_siblings_and_handles_missing_views_idempotently() {
        let mut registry = BrowserRegistry::<MockSurface>::default();

        // Commands on an unknown view are no-ops.
        assert_eq!(
            registry
                .apply(
                    "main",
                    "missing".into(),
                    SidebarBrowserCommand::Read,
                    |_, _, _| { unreachable!() }
                )
                .unwrap(),
            None
        );
        assert_eq!(
            registry
                .apply(
                    "main",
                    "missing".into(),
                    SidebarBrowserCommand::Close,
                    |_, _, _| { unreachable!() }
                )
                .unwrap(),
            None
        );

        // Showing first view creates and reveals it.
        let first = registry
            .apply(
                "main",
                "v1".into(),
                SidebarBrowserCommand::Show {
                    url: "https://example.org".into(),
                    bounds: sample_bounds(),
                },
                |_, url, rect| Ok(MockSurface::new(url.as_str(), rect)),
            )
            .unwrap()
            .expect("show returns state");
        assert_eq!(first.url, "https://example.org/");
        assert!(registry.get("main", "v1").unwrap().state.borrow().visible);

        // Showing second view hides the first.
        registry
            .apply(
                "main",
                "v2".into(),
                SidebarBrowserCommand::Show {
                    url: "https://example.com".into(),
                    bounds: sample_bounds(),
                },
                |_, url, rect| Ok(MockSurface::new(url.as_str(), rect)),
            )
            .unwrap();
        assert!(!registry.get("main", "v1").unwrap().state.borrow().visible);
        assert!(registry.get("main", "v2").unwrap().state.borrow().visible);

        // Navigate rejects non-HTTP(S) URLs without mutating the view.
        assert_eq!(
            registry
                .apply(
                    "main",
                    "v2".into(),
                    SidebarBrowserCommand::Navigate {
                        url: "javascript:alert(1)".into(),
                    },
                    |_, _, _| unreachable!(),
                )
                .unwrap_err(),
            "Invalid web address"
        );

        // Valid navigate, back, forward, reload update view state.
        let nav = registry
            .apply(
                "main",
                "v2".into(),
                SidebarBrowserCommand::Navigate {
                    url: "https://example.org/docs".into(),
                },
                |_, _, _| unreachable!(),
            )
            .unwrap()
            .unwrap();
        assert_eq!(nav.url, "https://example.org/docs");
        assert!(nav.can_go_back);

        let back = registry
            .apply(
                "main",
                "v2".into(),
                SidebarBrowserCommand::Back,
                |_, _, _| unreachable!(),
            )
            .unwrap()
            .unwrap();
        assert!(!back.can_go_back);
        assert!(back.can_go_forward);

        let fwd = registry
            .apply(
                "main",
                "v2".into(),
                SidebarBrowserCommand::Forward,
                |_, _, _| unreachable!(),
            )
            .unwrap()
            .unwrap();
        assert!(fwd.can_go_back);
        assert!(!fwd.can_go_forward);

        registry
            .apply(
                "main",
                "v2".into(),
                SidebarBrowserCommand::Reload,
                |_, _, _| unreachable!(),
            )
            .unwrap();
        assert_eq!(
            registry.get("main", "v2").unwrap().state.borrow().ops,
            vec!["load:https://example.org/docs", "back", "forward", "reload"]
        );

        // Hide hides view and returns None.
        assert_eq!(
            registry
                .apply(
                    "main",
                    "v2".into(),
                    SidebarBrowserCommand::Hide,
                    |_, _, _| { unreachable!() }
                )
                .unwrap(),
            None
        );
        assert!(!registry.get("main", "v2").unwrap().state.borrow().visible);

        // Close and window teardown clean up entries idempotently.
        registry
            .apply(
                "main",
                "v2".into(),
                SidebarBrowserCommand::Close,
                |_, _, _| unreachable!(),
            )
            .unwrap();
        assert!(registry.get("main", "v2").is_none());
        registry.remove_window("main");
        assert!(registry.get("main", "v1").is_none());
    }

    #[test]
    fn registry_propagates_creation_and_show_validation_errors() {
        let mut registry = BrowserRegistry::<MockSurface>::default();

        assert_eq!(
            registry
                .apply(
                    "main",
                    "v1".into(),
                    SidebarBrowserCommand::Show {
                        url: "file:///tmp/x".into(),
                        bounds: sample_bounds(),
                    },
                    |_, _, _| unreachable!(),
                )
                .unwrap_err(),
            "Invalid web address"
        );

        assert_eq!(
            registry
                .apply(
                    "main",
                    "v1".into(),
                    SidebarBrowserCommand::Show {
                        url: "https://example.org".into(),
                        bounds: sample_bounds(),
                    },
                    |_, _, _| Err("WebView2 runtime unavailable".into()),
                )
                .unwrap_err(),
            "WebView2 runtime unavailable"
        );
        assert!(registry.get("main", "v1").is_none());
    }
}
