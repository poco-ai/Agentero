//! Application translation commands (free MT; Agent path stays on the frontend ACP).

use crate::core::error::{map_err, ApiResult};
use crate::features::settings::{is_translate_api_key_mask, AppSettingsStore};
use crate::features::translate::{self, TranslateTextArgs, TranslateTextResult};
use tauri::{AppHandle, Manager};

#[tauri::command]
#[specta::specta]
pub async fn translate_text(
    app: AppHandle,
    mut args: TranslateTextArgs,
) -> ApiResult<TranslateTextResult> {
    use crate::core::log_util::OpTimer;

    // Commercial BYOK: Host keeps the real key. Frontend may send a `*`-mask or omit.
    // Resolve before any `.await` so we never hold managed state across await.
    {
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
