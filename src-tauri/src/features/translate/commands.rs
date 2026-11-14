//! Application translation commands (free MT; Agent path stays on the frontend ACP).

use crate::core::error::{map_err, ApiResult, AppError};
use crate::features::system::builtin;
use crate::features::system::settings::{is_translate_api_key_mask, AppSettingsStore};
use crate::features::translate::{self, TranslateTextArgs, TranslateTextResult};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

/// Streaming translate: pushes each increment through `on_delta`, then returns
/// the final text. Providers without a streaming path fall back to one-shot
/// translation (no deltas, final text only).
#[tauri::command]
#[specta::specta]
pub async fn translate_text_stream(
    app: AppHandle,
    args: TranslateTextArgs,
    on_delta: Channel<String>,
) -> ApiResult<TranslateTextResult> {
    let sent = args.clone();
    match translate::translate_text_stream(&sent, |d| {
        let _ = on_delta.send(d.to_string());
    })
    .await
    {
        Ok(Some(r)) => ApiResult::ok(r),
        Ok(None) => translate_text(app, args).await,
        Err(e) => map_err(e),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn translate_text(
    app: AppHandle,
    mut args: TranslateTextArgs,
) -> ApiResult<TranslateTextResult> {
    use crate::core::log_util::OpTimer;

    // Credentials resolve before any `.await` so we never hold managed state across await.
    if args
        .provider
        .trim()
        .eq_ignore_ascii_case(translate::BUILTIN_PROVIDER_ID)
    {
        let Some(key) = builtin::api_key() else {
            return map_err(AppError::domain(
                translate::ERR_NO_BUILTIN_KEY,
                "Built-in translation is not available in this build.",
            ));
        };
        let status = builtin::status();
        args.api_key = Some(key.to_string());
        args.base_url = Some(status.base_url);
        args.model = Some(status.translate_model);
    } else {
        // Commercial BYOK: Host keeps the real key. Frontend may send a `*`-mask or omit.
        let needs_stored_key = args
            .api_key
            .as_deref()
            .map(|k| {
                let t = k.trim();
                t.is_empty() || is_translate_api_key_mask(t)
            })
            .unwrap_or(true);
        if needs_stored_key {
            let store = app.state::<AppSettingsStore>();
            if let Some(key) = store.translate_api_key(&args.provider) {
                args.api_key = Some(key);
            } else if args
                .api_key
                .as_deref()
                .is_some_and(is_translate_api_key_mask)
            {
                // Mask without a stored secret → clear so required_api_key errors cleanly.
                args.api_key = None;
            }
        }
    }

    // Custom templates: the WebView never sends them; the Host injects the
    // durable settings for the only prompt-driven MT provider (the Agent path
    // builds its prompt on the frontend). Free MT / built-in ignore prompts.
    if args
        .provider
        .trim()
        .eq_ignore_ascii_case("openaicompatible")
    {
        let (prompt, system, user) = app.state::<AppSettingsStore>().translate_custom_templates();
        if args
            .custom_prompt
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
            && !prompt.is_empty()
        {
            args.custom_prompt = Some(prompt);
        }
        if args
            .custom_system
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
            && !system.is_empty()
        {
            args.custom_system = Some(system);
        }
        if args
            .custom_user
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
            && !user.is_empty()
        {
            args.custom_user = Some(user);
        }
    }

    let text_len = args.text.chars().count();
    let op = OpTimer::start_with(
        "translate_text",
        format!(
            "provider={} src={} tgt={} text_len={text_len}",
            args.provider, args.source_lang, args.target_lang
        ),
    );
    match translate::translate_text(args).await {
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
