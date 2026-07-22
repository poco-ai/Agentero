//! Application translation commands (free MT; Agent path stays on the frontend ACP).

use crate::error::AppError;
use crate::services::translate::{self, TranslateTextArgs, TranslateTextResult};

#[tauri::command]
pub async fn translate_text(args: TranslateTextArgs) -> Result<TranslateTextResult, AppError> {
    use crate::log_util::OpTimer;

    let text_len = args.text.chars().count();
    let op = OpTimer::start_with(
        "translate_text",
        format!(
            "provider={} src={} tgt={} text_len={text_len}",
            args.provider, args.source_lang, args.target_lang
        ),
    );
    op.finish(translate::translate_text(args).await)
}
