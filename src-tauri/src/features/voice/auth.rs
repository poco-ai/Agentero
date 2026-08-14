//! Temporary native ChatGPT login window for the single-user Voice prototype.
//!
//! The remote page never receives Agentero IPC capabilities. Once ChatGPT has
//! established a session, Host reads `/api/auth/session` in the page origin,
//! stores only the access token in the OS credential store, and destroys the
//! login webview.

use crate::core::error::{ApiResult, AppError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[cfg(any(target_os = "linux", target_os = "windows"))]
use keyring::{Entry, Error as KeyringError};
#[cfg(target_os = "macos")]
use security_framework::passwords::{
    delete_generic_password, get_generic_password, set_generic_password,
};
#[cfg(target_os = "macos")]
use security_framework_sys::base::errSecItemNotFound;

pub const VOICE_AUTH_WINDOW_LABEL: &str = "voice-auth";
pub const VOICE_AUTH_CHANGED_EVENT: &str = "voice-auth:changed";

const CREDENTIAL_SERVICE: &str = "com.agentero.desktop.voice";
const CREDENTIAL_ACCOUNT: &str = "chatgpt-access-token";
const CHATGPT_URL: &str = "https://chatgpt.com/";

#[derive(Debug, Default)]
struct VoiceAuthInner {
    connecting: bool,
    capturing: bool,
    last_error: Option<String>,
}

#[derive(Debug, Default)]
pub struct VoiceAuthController {
    inner: Mutex<VoiceAuthInner>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceAuthStatus {
    pub connected: bool,
    pub connecting: bool,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionCapture {
    status: u16,
    #[serde(default)]
    body: String,
    #[serde(default)]
    error: String,
}

impl VoiceAuthController {
    pub fn new() -> Self {
        Self::default()
    }

    fn begin_connect(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        inner.connecting = true;
        inner.capturing = false;
        inner.last_error = None;
    }

    fn begin_capture(&self) -> bool {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if !inner.connecting || inner.capturing {
            return false;
        }
        inner.capturing = true;
        true
    }

    fn finish_capture(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        inner.capturing = false;
    }

    fn finish_connect(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        inner.connecting = false;
        inner.capturing = false;
        inner.last_error = None;
    }

    fn fail_connect(&self, message: impl Into<String>) {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        inner.connecting = false;
        inner.capturing = false;
        inner.last_error = Some(message.into());
    }

    fn cancel_connect(&self) -> bool {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let changed = inner.connecting || inner.capturing;
        inner.connecting = false;
        inner.capturing = false;
        changed
    }

    fn snapshot(&self, connected: bool) -> VoiceAuthStatus {
        let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        VoiceAuthStatus {
            connected,
            connecting: inner.connecting,
            error: inner.last_error.clone(),
        }
    }
}

#[cfg(target_os = "macos")]
fn credential_connected() -> Result<bool, AppError> {
    match get_generic_password(CREDENTIAL_SERVICE, CREDENTIAL_ACCOUNT) {
        Ok(token) => Ok(!token.is_empty()),
        Err(error) if error.code() == errSecItemNotFound => Ok(false),
        Err(error) => Err(AppError::message(format!(
            "could not read the ChatGPT credential: {error}"
        ))),
    }
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn credential_entry() -> Result<Entry, AppError> {
    Entry::new(CREDENTIAL_SERVICE, CREDENTIAL_ACCOUNT).map_err(|error| {
        AppError::message(format!(
            "could not access the system credential store: {error}"
        ))
    })
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn credential_connected() -> Result<bool, AppError> {
    match credential_entry()?.get_password() {
        Ok(token) => Ok(!token.trim().is_empty()),
        Err(KeyringError::NoEntry) => Ok(false),
        Err(error) => Err(AppError::message(format!(
            "could not read the ChatGPT credential: {error}"
        ))),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn credential_connected() -> Result<bool, AppError> {
    Err(AppError::message("embedded ChatGPT login is desktop-only"))
}

#[cfg(target_os = "macos")]
pub(crate) fn access_token() -> Result<String, AppError> {
    let bytes = get_generic_password(CREDENTIAL_SERVICE, CREDENTIAL_ACCOUNT).map_err(|error| {
        AppError::message(format!("could not read the ChatGPT credential: {error}"))
    })?;
    let token = String::from_utf8(bytes)
        .map_err(|_| AppError::message("stored ChatGPT credential is invalid"))?;
    if token.trim().is_empty() {
        return Err(AppError::message("ChatGPT is not connected"));
    }
    Ok(token)
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
pub(crate) fn access_token() -> Result<String, AppError> {
    let token = credential_entry()?.get_password().map_err(|error| {
        AppError::message(format!("could not read the ChatGPT credential: {error}"))
    })?;
    if token.trim().is_empty() {
        return Err(AppError::message("ChatGPT is not connected"));
    }
    Ok(token)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
pub(crate) fn access_token() -> Result<String, AppError> {
    Err(AppError::message("embedded ChatGPT login is desktop-only"))
}

#[cfg(target_os = "macos")]
fn store_access_token(token: &str) -> Result<(), AppError> {
    set_generic_password(CREDENTIAL_SERVICE, CREDENTIAL_ACCOUNT, token.as_bytes()).map_err(
        |error| AppError::message(format!("could not save the ChatGPT credential: {error}")),
    )
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn store_access_token(token: &str) -> Result<(), AppError> {
    credential_entry()?.set_password(token).map_err(|error| {
        AppError::message(format!("could not save the ChatGPT credential: {error}"))
    })
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn store_access_token(_token: &str) -> Result<(), AppError> {
    Err(AppError::message("embedded ChatGPT login is desktop-only"))
}

#[cfg(target_os = "macos")]
fn delete_access_token() -> Result<(), AppError> {
    match delete_generic_password(CREDENTIAL_SERVICE, CREDENTIAL_ACCOUNT) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == errSecItemNotFound => Ok(()),
        Err(error) => Err(AppError::message(format!(
            "could not remove the ChatGPT credential: {error}"
        ))),
    }
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn delete_access_token() -> Result<(), AppError> {
    match credential_entry()?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(AppError::message(format!(
            "could not remove the ChatGPT credential: {error}"
        ))),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn delete_access_token() -> Result<(), AppError> {
    Err(AppError::message("embedded ChatGPT login is desktop-only"))
}

fn status(controller: &VoiceAuthController) -> Result<VoiceAuthStatus, AppError> {
    Ok(controller.snapshot(credential_connected()?))
}

fn emit_status(app: &AppHandle, controller: &VoiceAuthController) {
    let payload = status(controller).unwrap_or_else(|error| VoiceAuthStatus {
        connected: false,
        connecting: false,
        error: Some(error.to_string()),
    });
    let _ = app.emit(VOICE_AUTH_CHANGED_EVENT, payload);
}

/// Removes an upstream credential that ChatGPT has rejected and notifies every
/// open Voice surface so the next action is an explicit reconnect.
pub(crate) fn invalidate_access_token(app: &AppHandle) -> Result<(), AppError> {
    let controller = app.state::<VoiceAuthController>();
    let result = delete_access_token();
    match &result {
        Ok(()) => controller.finish_connect(),
        Err(error) => controller.fail_connect(error.to_string()),
    }
    emit_status(app, &controller);
    result
}

fn is_chatgpt_page(url: &url::Url) -> bool {
    url.scheme() == "https"
        && matches!(
            url.host_str(),
            Some("chatgpt.com") | Some("www.chatgpt.com")
        )
}

fn extract_access_token(capture: &SessionCapture) -> Result<Option<String>, AppError> {
    if capture.status == 0 {
        return Err(AppError::message(if capture.error.trim().is_empty() {
            "ChatGPT session capture was blocked by the embedded browser".to_string()
        } else {
            format!("ChatGPT session capture failed: {}", capture.error.trim())
        }));
    }
    if capture.status == 401 || capture.status == 403 || capture.body.trim().is_empty() {
        return Ok(None);
    }
    if !(200..300).contains(&capture.status) {
        return Err(AppError::message(format!(
            "ChatGPT session endpoint returned HTTP {}",
            capture.status
        )));
    }
    let session: Value = serde_json::from_str(&capture.body)
        .map_err(|_| AppError::message("ChatGPT returned an invalid session response"))?;
    let token = session
        .get("accessToken")
        .or_else(|| session.get("access_token"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|token| token.len() >= 20)
        .map(str::to_string);
    Ok(token)
}

fn capture_session(window: &WebviewWindow) {
    let app = window.app_handle().clone();
    let controller = app.state::<VoiceAuthController>();
    if !controller.begin_capture() {
        return;
    }

    // Synchronous same-origin XHR is intentional here: Tauri/Wry's callback
    // serializes the immediate JS return value and does not await a Promise on
    // every desktop engine. It runs only after a finished chatgpt.com load.
    const SCRIPT: &str = r#"(() => {
      try {
        const request = new XMLHttpRequest();
        request.open('GET', '/api/auth/session', false);
        request.setRequestHeader('Accept', 'application/json');
        request.send(null);
        return { status: request.status, body: request.responseText || '', error: '' };
      } catch (error) {
        return { status: 0, body: '', error: String(error) };
      }
    })()"#;

    let capture_window = window.clone();
    let callback_app = app.clone();
    if let Err(error) = window.eval_with_callback(SCRIPT, move |raw| {
        let parsed = serde_json::from_str::<SessionCapture>(&raw)
            .map_err(|_| AppError::message("embedded browser did not return a session result"))
            .and_then(|capture| extract_access_token(&capture));

        match parsed {
            Ok(Some(token)) => {
                let store_app = callback_app.clone();
                let store_window = capture_window.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let controller = store_app.state::<VoiceAuthController>();
                    match store_access_token(&token) {
                        Ok(()) => {
                            controller.finish_connect();
                            emit_status(&store_app, &controller);
                            let _ = store_window.destroy();
                        }
                        Err(error) => {
                            controller.fail_connect(error.to_string());
                            emit_status(&store_app, &controller);
                        }
                    }
                });
            }
            Ok(None) => {
                callback_app.state::<VoiceAuthController>().finish_capture();
            }
            Err(error) => {
                let controller = callback_app.state::<VoiceAuthController>();
                controller.fail_connect(error.to_string());
                emit_status(&callback_app, &controller);
            }
        }
    }) {
        controller.fail_connect(format!("could not inspect the ChatGPT session: {error}"));
        emit_status(&app, &controller);
    }
}

#[tauri::command]
pub async fn voice_auth_status(
    controller: State<'_, VoiceAuthController>,
) -> Result<ApiResult<VoiceAuthStatus>, String> {
    let result = status(&controller);
    Ok(result.map(ApiResult::ok).unwrap_or_else(ApiResult::err))
}

#[tauri::command]
pub async fn voice_auth_connect(
    app: AppHandle,
    controller: State<'_, VoiceAuthController>,
    title: String,
) -> Result<ApiResult<VoiceAuthStatus>, String> {
    let result = (|| -> Result<VoiceAuthStatus, AppError> {
        if let Some(window) = app.get_webview_window(VOICE_AUTH_WINDOW_LABEL) {
            let _ = window.show();
            let _ = window.set_focus();
            controller.begin_connect();
            if window
                .url()
                .map(|url| is_chatgpt_page(&url))
                .unwrap_or(false)
            {
                capture_session(&window);
            }
            emit_status(&app, &controller);
            return status(&controller);
        }

        controller.begin_connect();
        let auth_url = CHATGPT_URL
            .parse()
            .map_err(|error| AppError::message(format!("invalid ChatGPT URL: {error}")))?;
        let window_title = if title.trim().is_empty() {
            "Connect ChatGPT"
        } else {
            title.trim()
        };
        let window = WebviewWindowBuilder::new(
            &app,
            VOICE_AUTH_WINDOW_LABEL,
            WebviewUrl::External(auth_url),
        )
        .title(window_title)
        .inner_size(960.0, 760.0)
        .min_inner_size(680.0, 560.0)
        .center()
        .resizable(true)
        .content_protected(true)
        .on_navigation(|url| url.scheme() == "https" || url.scheme() == "about")
        .on_page_load(|window, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
                && is_chatgpt_page(payload.url())
            {
                capture_session(&window);
            }
        })
        .build()
        .map_err(|error| AppError::message(format!("could not open ChatGPT login: {error}")))?;
        let _ = window.set_focus();
        emit_status(&app, &controller);
        status(&controller)
    })();

    if let Err(error) = &result {
        controller.fail_connect(error.to_string());
        emit_status(&app, &controller);
    }
    Ok(result.map(ApiResult::ok).unwrap_or_else(ApiResult::err))
}

#[tauri::command]
pub async fn voice_auth_cancel(
    app: AppHandle,
    controller: State<'_, VoiceAuthController>,
) -> Result<ApiResult<VoiceAuthStatus>, String> {
    if let Some(window) = app.get_webview_window(VOICE_AUTH_WINDOW_LABEL) {
        let _ = window.destroy();
    }
    controller.cancel_connect();
    emit_status(&app, &controller);
    let result = status(&controller);
    Ok(result.map(ApiResult::ok).unwrap_or_else(ApiResult::err))
}

#[tauri::command]
pub async fn voice_auth_disconnect(
    app: AppHandle,
    controller: State<'_, VoiceAuthController>,
) -> Result<ApiResult<VoiceAuthStatus>, String> {
    let result = delete_access_token().map(|()| {
        controller.finish_connect();
        controller.snapshot(false)
    });
    emit_status(&app, &controller);
    Ok(result.map(ApiResult::ok).unwrap_or_else(ApiResult::err))
}

pub fn handle_window_destroyed(app: &AppHandle, label: &str) {
    if label != VOICE_AUTH_WINDOW_LABEL {
        return;
    }
    let controller = app.state::<VoiceAuthController>();
    if controller.cancel_connect() {
        emit_status(app, &controller);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_chatgpt_https_pages_for_capture() {
        assert!(is_chatgpt_page(&"https://chatgpt.com/".parse().unwrap()));
        assert!(!is_chatgpt_page(
            &"https://accounts.google.com/".parse().unwrap()
        ));
        assert!(!is_chatgpt_page(&"http://chatgpt.com/".parse().unwrap()));
    }

    #[test]
    fn extracts_token_without_exposing_other_session_fields() {
        let capture = SessionCapture {
            status: 200,
            body:
                r#"{"accessToken":"abcdefghijklmnopqrstuvwxyz","user":{"email":"a@example.test"}}"#
                    .into(),
            error: String::new(),
        };
        assert_eq!(
            extract_access_token(&capture).unwrap().as_deref(),
            Some("abcdefghijklmnopqrstuvwxyz")
        );
    }
}
