//! `agentero translate` — free machine translation for scripts and Agents.
//!
//! Deliberately free-MT only: the CLI config (`~/.config/agentero/config.toml`)
//! is isolated from GUI settings, so commercial BYOK keys are not available here.
//!
//! @see docs/backend/cli.md

use crate::error::CliError;
use crate::resolve::GlobalOpts;
use agentero_core::features::translate::{
    free_mt_to_zh, translate_text, TranslateTextArgs, FREE_PROVIDERS,
};
use serde_json::{json, Value};

/// zh targets go through the parallel free-engine race; everything else uses a
/// single provider.
fn is_zh(target: &str) -> bool {
    let t = target.trim().to_ascii_lowercase();
    t == "zh" || t.starts_with("zh-") || t.starts_with("zh_")
}

pub async fn run_raw(
    text: &str,
    target: &str,
    source: &str,
    provider: Option<&str>,
) -> Result<String, CliError> {
    let text = text.trim();
    if text.is_empty() {
        return Err(CliError::usage("nothing to translate"));
    }
    if let Some(id) = provider {
        if !FREE_PROVIDERS.contains(&id) {
            return Err(CliError::usage(format!(
                "--provider must be a free engine ({}); commercial keys live in the desktop app",
                FREE_PROVIDERS.join("|")
            )));
        }
    }

    match (provider, is_zh(target)) {
        (None, true) => free_mt_to_zh(text)
            .await
            .ok_or_else(|| CliError::message("all free translation engines failed")),
        (chosen, _) => {
            let result = translate_text(TranslateTextArgs {
                text: text.to_string(),
                source_lang: source.to_string(),
                target_lang: target.to_string(),
                provider: chosen.unwrap_or("tencenttransmart").to_string(),
                api_key: None,
                base_url: None,
                region: None,
                model: None,
                extra_request_body: None,
                custom_prompt: None,
                custom_system: None,
                custom_user: None,
                timeout_ms: None,
            })
            .await
            .map_err(|e| CliError::message(e.to_string()))?;
            Ok(result.text)
        }
    }
}

pub async fn run(
    text: &str,
    target: &str,
    source: &str,
    provider: Option<&str>,
    _globals: &GlobalOpts,
) -> Result<Value, CliError> {
    let translated = run_raw(text, target, source, provider).await?;
    Ok(json!({
        "text": translated,
        "sourceLang": source,
        "targetLang": target,
        "lines": [translated.clone()],
    }))
}
