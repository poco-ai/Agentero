use serde::{Deserialize, Serialize};
#[cfg(any(test, target_os = "macos"))]
use tauri::Url;
use tauri::WebviewWindow;

#[derive(Deserialize, specta::Type)]
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

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SidebarBrowserState {
    url: String,
    title: String,
    loading: bool,
    can_go_back: bool,
    can_go_forward: bool,
}

#[cfg(any(test, target_os = "macos"))]
fn web_url(raw: &str) -> Option<Url> {
    let url = Url::parse(raw).ok()?;
    (matches!(url.scheme(), "http" | "https")
        && url.has_host()
        && url.username().is_empty()
        && url.password().is_none())
    .then_some(url)
}

#[tauri::command]
#[specta::specta]
pub async fn sidebar_browser_command(
    window: WebviewWindow,
    view_id: String,
    command: SidebarBrowserCommand,
) -> Result<Option<SidebarBrowserState>, String> {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let parent = window.clone();
        window
            .run_on_main_thread(move || {
                let _ = tx.send(native::apply(&parent, view_id, command));
            })
            .map_err(|error| error.to_string())?;
        rx.await.map_err(|error| error.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, view_id, command);
        Err("Embedded browsing is available on macOS".into())
    }
}

pub fn is_focused(window: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        native::is_focused(window)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        false
    }
}

pub fn close_window(window: &str) {
    #[cfg(target_os = "macos")]
    native::close_window(window);
    #[cfg(not(target_os = "macos"))]
    let _ = window;
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use objc2_app_kit::NSView;
    use std::{cell::RefCell, collections::HashMap};
    use wry::{
        dpi::{LogicalPosition, LogicalSize},
        NewWindowResponse, PermissionResponse, Rect, WebView, WebViewBuilder, WebViewExtMacOS,
    };

    thread_local! {
        static VIEWS: RefCell<HashMap<String, HashMap<String, WebView>>> = RefCell::default();
    }

    fn bounds(rect: SidebarBrowserBounds) -> Result<Rect, String> {
        let values = [rect.x, rect.y, rect.width, rect.height];
        if !values
            .iter()
            .all(|value| value.is_finite() && (0.0..=32768.0).contains(value))
            || rect.width < 1.0
            || rect.height < 1.0
        {
            return Err("Invalid browser bounds".into());
        }
        Ok(Rect {
            position: LogicalPosition::new(rect.x, rect.y).into(),
            size: LogicalSize::new(rect.width, rect.height).into(),
        })
    }

    fn create(window: &WebviewWindow, id: &str, url: &Url, rect: Rect) -> wry::Result<WebView> {
        let parent = window.clone();
        let window_label = window.label().to_owned();
        let view_id = id.to_owned();
        WebViewBuilder::new()
            .with_url(url.as_str())
            .with_bounds(rect)
            .with_incognito(true)
            .with_visible(false)
            .with_focused(false)
            .with_devtools(false)
            .with_back_forward_navigation_gestures(true)
            .with_navigation_handler(|target| web_url(&target).is_some())
            .with_new_window_req_handler(move |target, _| {
                if let Some(url) = web_url(&target) {
                    let window_label = window_label.clone();
                    let view_id = view_id.clone();
                    let parent = parent.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = parent.run_on_main_thread(move || {
                            VIEWS.with(|state| {
                                let state = state.borrow();
                                if let Some(view) = state
                                    .get(&window_label)
                                    .and_then(|views| views.get(&view_id))
                                {
                                    let _ = view.load_url(url.as_str());
                                }
                            });
                        });
                    });
                }
                NewWindowResponse::Deny
            })
            .with_permission_handler(|_| PermissionResponse::Deny)
            .with_download_started_handler(|_, _| false)
            .build_as_child(window)
    }

    fn snapshot(view: &WebView) -> SidebarBrowserState {
        let wk = view.webview();
        SidebarBrowserState {
            url: view
                .url()
                .ok()
                .filter(|url| web_url(url).is_some())
                .unwrap_or_default(),
            title: unsafe { wk.title() }
                .map(|title| title.to_string().chars().take(256).collect())
                .unwrap_or_default(),
            loading: unsafe { wk.isLoading() },
            can_go_back: unsafe { wk.canGoBack() },
            can_go_forward: unsafe { wk.canGoForward() },
        }
    }

    pub fn apply(
        window: &WebviewWindow,
        id: String,
        command: SidebarBrowserCommand,
    ) -> Result<Option<SidebarBrowserState>, String> {
        VIEWS.with(|state| {
            let mut state = state.borrow_mut();
            let views = state.entry(window.label().to_owned()).or_default();
            let explain = |error: wry::Error| error.to_string();
            match command {
                SidebarBrowserCommand::Show { url, bounds: rect } => {
                    let url = web_url(&url).ok_or("Invalid web address")?;
                    let rect = bounds(rect)?;
                    for (other, view) in views.iter() {
                        if *other != id {
                            view.set_visible(false).map_err(explain)?;
                        }
                    }
                    if !views.contains_key(&id) {
                        views.insert(
                            id.clone(),
                            create(window, &id, &url, rect).map_err(explain)?,
                        );
                    }
                    let view = &views[&id];
                    view.set_bounds(rect).map_err(explain)?;
                    view.set_visible(true).map_err(explain)?;
                    Ok(Some(snapshot(view)))
                }
                SidebarBrowserCommand::Close => {
                    views.remove(&id);
                    Ok(None)
                }
                other => {
                    let Some(view) = views.get(&id) else {
                        return Ok(None);
                    };
                    match other {
                        SidebarBrowserCommand::Hide => {
                            view.set_visible(false).map_err(explain)?;
                            return Ok(None);
                        }
                        SidebarBrowserCommand::Navigate { url } => view
                            .load_url(web_url(&url).ok_or("Invalid web address")?.as_str())
                            .map_err(explain)?,
                        SidebarBrowserCommand::Back => {
                            unsafe { view.webview().goBack() };
                        }
                        SidebarBrowserCommand::Forward => {
                            unsafe { view.webview().goForward() };
                        }
                        SidebarBrowserCommand::Reload => view.reload().map_err(explain)?,
                        SidebarBrowserCommand::Read => {}
                        _ => unreachable!(),
                    }
                    Ok(Some(snapshot(view)))
                }
            }
        })
    }

    pub fn is_focused(window: &str) -> bool {
        VIEWS.with(|state| {
            state.borrow().get(window).is_some_and(|views| {
                views.values().any(|view| {
                    let wk = view.webview();
                    if wk.isHiddenOrHasHiddenAncestor() {
                        return false;
                    }
                    let Some(responder) = wk.window().and_then(|window| window.firstResponder())
                    else {
                        return false;
                    };
                    responder
                        .downcast::<NSView>()
                        .is_ok_and(|view| view.isDescendantOf(&wk))
                })
            })
        })
    }

    pub fn close_window(window: &str) {
        VIEWS.with(|state| {
            state.borrow_mut().remove(window);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::web_url;

    #[test]
    fn rejects_privileged_schemes_and_embedded_credentials() {
        for raw in [
            "file:///tmp/paper",
            "agentero://localhost/",
            "javascript:alert(1)",
            "https://user:pass@example.org/",
        ] {
            assert!(web_url(raw).is_none(), "{raw}");
        }
        assert!(web_url("https://example.org/paper").is_some());
    }
}
