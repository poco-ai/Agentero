use crate::error::AppError;
use crate::http;
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

#[derive(Serialize)]
struct DeepLRequest<'a> {
    text: &'a str,
    target_lang: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_lang: Option<&'a str>,
}

pub async fn translate_deepl(
    text: &str,
    source: &str,
    target: &str,
    timeout: Duration,
    api_key: Option<&str>,
    base_url: Option<&str>,
) -> Result<String, AppError> {
    let key = super::required_api_key("DeepL", api_key)?;
    let url = super::optional_endpoint(base_url, "https://api-free.deepl.com", "/v2/translate");
    let client = http::client(timeout)?;
    let target_lang = deepl_target(target);
    let source_lang = if source == "auto" {
        None
    } else {
        Some(deepl_source(source))
    };
    let resp = client
        .post(&url)
        .header("Authorization", format!("DeepL-Auth-Key {key}"))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&DeepLRequest {
            text,
            target_lang: &target_lang,
            source_lang: source_lang.as_deref(),
        })
        .send()
        .await
        .map_err(|e| super::map_request_error("DeepL", e))?;
    let (status, body) = super::read_body(resp).await?;
    if !status.is_success() {
        return Err(super::http_err(status, &body, "DeepL"));
    }
    let v: Value =
        serde_json::from_str(&body).map_err(|e| AppError::message(format!("DeepL parse: {e}")))?;
    v.get("translations")
        .and_then(|x| x.as_array())
        .and_then(|x| x.first())
        .and_then(|x| x.get("text"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| AppError::message("Unexpected DeepL translation response"))
}

fn deepl_source(code: &str) -> String {
    match code {
        "zh-CN" | "zh-Hans" => "ZH".to_string(),
        "en" => "EN".to_string(),
        _ => super::lang_base(code).to_ascii_uppercase(),
    }
}

fn deepl_target(code: &str) -> String {
    match code {
        "zh-CN" | "zh-Hans" => "ZH-HANS".to_string(),
        "en" => "EN-US".to_string(),
        _ => super::lang_base(code).to_ascii_uppercase(),
    }
}
