//! Tauri command shell for remote layout providers: resolves credentials
//! from settings and dispatches to the engine registry.

use crate::core::error::{map_err, ApiResult, AppError};
use crate::features::paper::analyze::layout::hosted::engine::{
    engine_for, HostedProviderCredentials, LayoutAnalyzeContext,
};
use crate::features::paper::analyze::layout::hosted::{
    LayoutRemoteAnalyzePdfArgs, LayoutRemoteAnalyzePdfResult, LayoutRemoteProbeArgs,
    LayoutRemoteProbeResult,
};
use crate::features::system::settings::{is_translate_api_key_mask, AppSettingsStore};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use tauri::{AppHandle, Manager};
use tokio_util::sync::CancellationToken;

const DEFAULT_REMOTE_PROVIDER: &str = "paddle";
const REMOTE_LAYOUT_CANCELLED: &str = "layout analysis cancelled";

static ACTIVE_REMOTE_LAYOUT_RUNS: LazyLock<Mutex<HashMap<String, Arc<CancellationToken>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

struct RemoteLayoutRun {
    request_id: String,
    cancellation: Arc<CancellationToken>,
}

impl RemoteLayoutRun {
    fn register(request_id: String) -> Self {
        let cancellation = Arc::new(CancellationToken::new());
        if let Ok(mut runs) = ACTIVE_REMOTE_LAYOUT_RUNS.lock() {
            runs.insert(request_id.clone(), cancellation.clone());
        }
        Self {
            request_id,
            cancellation,
        }
    }
}

impl Drop for RemoteLayoutRun {
    fn drop(&mut self) {
        if let Ok(mut runs) = ACTIVE_REMOTE_LAYOUT_RUNS.lock() {
            if runs
                .get(&self.request_id)
                .is_some_and(|token| Arc::ptr_eq(token, &self.cancellation))
            {
                runs.remove(&self.request_id);
            }
        }
    }
}

/// Inject the stored provider access token before any `.await`
/// (managed state must not be held across await).
fn inject_provider_credentials(
    app: &AppHandle,
    provider: &str,
    api_key: &mut Option<String>,
) -> HostedProviderCredentials {
    let store = app.state::<AppSettingsStore>();
    let needs_stored_key = api_key
        .as_deref()
        .map(|k| {
            let t = k.trim();
            t.is_empty() || is_translate_api_key_mask(t)
        })
        .unwrap_or(true);
    if needs_stored_key {
        if let Some(key) = store.layout_api_key(provider) {
            *api_key = Some(key);
        } else if api_key.as_deref().is_some_and(is_translate_api_key_mask) {
            *api_key = None;
        }
    }
    // Move the key out of args so the plaintext never lingers in the
    // Debug-derivable args struct; engines read credentials only.
    HostedProviderCredentials {
        api_key: api_key.take(),
        base_url: store.layout_base_url(provider),
        language: store.layout_language(provider),
        is_ocr: store.layout_is_ocr(provider),
        self_hosted: store.layout_self_hosted(provider),
    }
}

fn unknown_provider(provider: &str) -> AppError {
    AppError::message(format!("layout_remote: unknown provider: {provider}"))
}

#[tauri::command]
#[specta::specta]
pub async fn layout_remote_analyze_pdf(
    app: AppHandle,
    mut args: LayoutRemoteAnalyzePdfArgs,
) -> ApiResult<LayoutRemoteAnalyzePdfResult> {
    use crate::core::log_util::OpTimer;

    let request_id = args
        .request_id
        .take()
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    args.request_id = Some(request_id.clone());
    let run = RemoteLayoutRun::register(request_id);

    let provider = args
        .provider
        .clone()
        .unwrap_or_else(|| DEFAULT_REMOTE_PROVIDER.to_string());
    let Some(engine) = engine_for(&provider) else {
        return map_err(unknown_provider(&provider));
    };

    // Host keeps the real access token; the WebView sends a `*`-mask or nothing.
    let credentials = inject_provider_credentials(&app, engine.id(), &mut args.api_key);

    let op = OpTimer::start_with(
        "layout_remote_analyze_pdf",
        format!(
            "provider={provider} request_id={} pdf_chars={}",
            run.request_id,
            args.pdf_base64.len()
        ),
    );
    let ctx = LayoutAnalyzeContext {
        app: app.clone(),
        credentials,
        args,
    };
    let result = tokio::select! {
        result = engine.analyze_pdf(ctx) => result,
        _ = run.cancellation.cancelled() => Err(AppError::message(REMOTE_LAYOUT_CANCELLED)),
    };
    match result {
        Ok(r) => {
            op.finish_ok();
            ApiResult::ok(r)
        }
        Err(e) => {
            op.finish_err(&e);
            map_err(e)
        }
    }
}

/// Cancel one in-flight remote layout analyze command. Unknown or already
/// settled request ids are a no-op so unmount cleanup can fire unconditionally.
#[tauri::command]
#[specta::specta]
pub fn layout_remote_cancel(request_id: String) -> ApiResult<bool> {
    let cancellation = ACTIVE_REMOTE_LAYOUT_RUNS
        .lock()
        .ok()
        .and_then(|runs| runs.get(&request_id).cloned());
    if let Some(cancellation) = cancellation {
        cancellation.cancel();
        ApiResult::ok(true)
    } else {
        ApiResult::ok(false)
    }
}

#[tauri::command]
#[specta::specta]
pub async fn layout_remote_probe(
    app: AppHandle,
    mut args: LayoutRemoteProbeArgs,
) -> ApiResult<LayoutRemoteProbeResult> {
    use crate::core::log_util::OpTimer;

    let provider = args
        .provider
        .clone()
        .unwrap_or_else(|| DEFAULT_REMOTE_PROVIDER.to_string());
    let Some(engine) = engine_for(&provider) else {
        return map_err(unknown_provider(&provider));
    };

    let credentials = inject_provider_credentials(&app, engine.id(), &mut args.api_key);

    let op = OpTimer::start("layout_remote_probe");
    match engine.probe(&credentials, args).await {
        Ok(r) => {
            op.finish_ok();
            ApiResult::ok(r)
        }
        Err(e) => {
            op.finish_err(&e);
            map_err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_reaches_the_registered_run_and_registration_is_removed_on_drop() {
        let first = RemoteLayoutRun::register("layout-remote-test-a".into());
        let token = first.cancellation.clone();
        let cancelled = layout_remote_cancel("layout-remote-test-a".into());
        assert!(cancelled.ok);
        assert_eq!(cancelled.data, Some(true));
        assert!(token.is_cancelled());
        drop(first);
        let settled = layout_remote_cancel("layout-remote-test-a".into());
        assert!(settled.ok);
        assert_eq!(settled.data, Some(false));
    }

    #[test]
    fn stale_registration_drop_keeps_a_reused_request_id_active() {
        let stale = RemoteLayoutRun::register("layout-remote-test-b".into());
        let active = RemoteLayoutRun::register("layout-remote-test-b".into());
        drop(stale);
        let cancelled = layout_remote_cancel("layout-remote-test-b".into());
        assert!(cancelled.ok);
        assert_eq!(cancelled.data, Some(true));
        assert!(active.cancellation.is_cancelled());
    }
}
