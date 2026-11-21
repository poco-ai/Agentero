use crate::error::AppError;
use crate::http;
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

#[derive(Serialize)]
struct AzureRequestItem<'a> {
    #[serde(rename = "Text")]
    text: &'a str,
}

pub async fn translate_azure(
    text: &str,
    source: &str,
    target: &str,
    timeout: Duration,
    api_key: Option<&str>,
    base_url: Option<&str>,
    region: Option<&str>,
) -> Result<String, AppError> {
    let key = super::required_api_key("Azure Translator", api_key)?;
    let region = region
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            AppError::message("Azure Translator requires region (Settings → Translate)")
        })?;
    let url = super::optional_endpoint(
        base_url,
        "https://api.cognitive.microsofttranslator.com",
        "/translate",
    );
    let mut req = vec![("api-version", "3.0"), ("to", azure_lang(target))];
    if source != "auto" {
        req.push(("from", azure_lang(source)));
    }
    let client = http::client(timeout)?;
    let resp = client
        .post(&url)
        .query(&req)
        .header("Ocp-Apim-Subscription-Key", key)
        .header("Ocp-Apim-Subscription-Region", region)
        .header("Content-Type", "application/json")
        .json(&[AzureRequestItem { text }])
        .send()
        .await
        .map_err(|e| super::map_request_error("Azure Translator", e))?;
    let (status, body) = super::read_body(resp).await?;
    if !status.is_success() {
        return Err(super::http_err(status, &body, "Azure Translator"));
    }
    let v: Value = serde_json::from_str(&body)
        .map_err(|e| AppError::message(format!("Azure Translator parse: {e}")))?;
    v.get(0)
        .and_then(|x| x.get("translations"))
        .and_then(|x| x.get(0))
        .and_then(|x| x.get("text"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| AppError::message("Unexpected Azure Translator response"))
}

fn azure_lang(code: &str) -> &str {
    match code {
        "zh-CN" | "zh-Hans" => "zh-Hans",
        "zh-TW" | "zh-Hant" => "zh-Hant",
        "en" => "en",
        _ => super::lang_base(code),
    }
}
