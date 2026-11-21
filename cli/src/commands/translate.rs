//! Translate a text using a local provider profile.
use crate::{
    config,
    error::{CliError, ExitCode},
};
use agentero_core::features::translate::{free_mt_to_zh, translate_text, TranslateTextArgs};
use serde_json::json;

pub async fn run_raw(
    text: &str,
    target: &str,
    source: &str,
    profile: Option<&str>,
) -> Result<String, CliError> {
    if text.trim().is_empty() {
        return Err(CliError::usage("nothing to translate"));
    }
    let mut args = json!({"text":text,"sourceLang":source,"targetLang":target});
    if let Some(name) = profile {
        let cfg = config::load()?;
        let profile = cfg
            .extra
            .get("translation_profiles")
            .and_then(|profiles| profiles.get(name))
            .ok_or_else(|| CliError::usage(format!("unknown translation profile {name}")))?;
        for (field, wire) in [
            ("provider", "provider"),
            ("base_url", "baseUrl"),
            ("model", "model"),
            ("api_key", "apiKey"),
            ("region", "region"),
        ] {
            if let Some(value) = profile.get(field).and_then(toml::Value::as_str) {
                args[wire] = json!(value);
            }
        }
        if args["provider"].is_null() {
            return Err(CliError::usage("translation profile requires provider"));
        }
    } else if source == "auto"
        && matches!(
            target.to_ascii_lowercase().as_str(),
            "zh" | "zh-cn" | "zh-hans"
        )
    {
        return free_mt_to_zh(text).await.ok_or_else(|| {
            CliError::new(
                "provider_unavailable",
                "translation providers are unavailable",
                ExitCode::Unavailable,
            )
        });
    } else {
        args["provider"] = json!("tencenttransmart");
    }
    let request: TranslateTextArgs = serde_json::from_value(args)?;
    Ok(translate_text(request).await?.text)
}
