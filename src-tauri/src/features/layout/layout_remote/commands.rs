//! Tauri command shell for remote layout providers: resolves credentials
//! from settings and dispatches to the engine registry.

use crate::core::error::{map_err, ApiResult, AppError};
use crate::features::layout_remote::engine::{engine_for, AnalyzeCtx, ProviderCredentials};
use crate::features::layout_remote::{
    LayoutRemoteAnalyzePdfArgs, LayoutRemoteAnalyzePdfResult, LayoutRemoteProbeArgs,
    LayoutRemoteProbeResult,
};
use crate::features::settings::{is_translate_api_key_mask, AppSettingsStore};
use tauri::{AppHandle, Manager};

const DEFAULT_REMOTE_PROVIDER: &str = "paddle";

/// Inject the stored provider access token before any `.await`
/// (managed state must not be held across await).
fn inject_provider_credentials(
    app: &AppHandle,
    provider: &str,
    api_key: &mut Option<String>,
) -> ProviderCredentials {
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
    ProviderCredentials {
        api_key: api_key.take(),
        base_url: store.layout_base_url(provider),
        language: store.layout_language(provider),
        is_ocr: store.layout_is_ocr(provider),
    }
}

fn unknown_provider(provider: &str) -> AppError {
    AppError::message(format!("layout_remote: unknown provider: {provider}"))
}

#[tauri::command]
pub async fn layout_remote_analyze_pdf(
    app: AppHandle,
    mut args: LayoutRemoteAnalyzePdfArgs,
) -> ApiResult<LayoutRemoteAnalyzePdfResult> {
    use crate::core::log_util::OpTimer;

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
        format!("pdf_chars={}", args.pdf_base64.len()),
    );
    let ctx = AnalyzeCtx {
        app: app.clone(),
        credentials,
        args,
    };
    match engine.analyze_pdf(ctx).await {
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

#[tauri::command]
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
