use crate::error::AppError;
use crate::http;
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

#[derive(Serialize)]
struct GoogleCloudRequest<'a> {
    q: &'a str,
    target: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<&'a str>,
    format: &'a str,
}

pub async fn translate_google_cloud(
    text: &str,
    source: &str,
    target: &str,
    timeout: Duration,
    api_key: Option<&str>,
    base_url: Option<&str>,
) -> Result<String, AppError> {
    let key = super::required_api_key("Google Cloud Translate", api_key)?;
    let url = super::optional_endpoint(
        base_url,
        "https://translation.googleapis.com",
        "/language/translate/v2",
    );
    let client = http::client(timeout)?;
    let resp = client
        .post(&url)
        .query(&[("key", key)])
        .header("Content-Type", "application/json")
        .json(&GoogleCloudRequest {
            q: text,
            target: google_cloud_target(target),
            source: if source == "auto" {
                None
            } else {
                Some(google_cloud_source(source))
            },
            format: "text",
        })
        .send()
        .await
        .map_err(|e| super::map_request_error("Google Cloud Translate", e))?;
    let (status, body) = super::read_body(resp).await?;
    if !status.is_success() {
        return Err(super::http_err(status, &body, "Google Cloud Translate"));
    }
    let v: Value = serde_json::from_str(&body)
        .map_err(|e| AppError::message(format!("Google Cloud Translate parse: {e}")))?;
    v.get("data")
        .and_then(|x| x.get("translations"))
        .and_then(|x| x.get(0))
        .and_then(|x| x.get("translatedText"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| AppError::message("Unexpected Google Cloud Translate response"))
}

fn google_cloud_source(code: &str) -> &str {
    match code {
        "zh-CN" | "zh-Hans" => "zh",
        _ => super::lang_base(code),
    }
}

fn google_cloud_target(code: &str) -> &str {
    match code {
        "zh-CN" | "zh-Hans" => "zh-CN",
        _ => super::lang_base(code),
    }
}
