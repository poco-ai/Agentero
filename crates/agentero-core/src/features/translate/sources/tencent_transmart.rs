use crate::error::AppError;
use crate::http;
use serde_json::Value;
use std::time::Duration;

pub async fn translate_tencent_transmart(
    text: &str,
    source: &str,
    target: &str,
    timeout: Duration,
) -> Result<String, AppError> {
    let client = http::client(timeout)?;
    let from = if source == "auto" {
        "auto".to_string()
    } else {
        super::lang_base(source).to_string()
    };
    let to = super::lang_base(target).to_string();
    let body = serde_json::json!({
        "header": {
            "fn": "auto_translation",
            "client_key": "browser-chrome-110.0.0-Mac OS-df4bd4c5-a65d-44b2-a40f-42f34f3535f2-1677486696487"
        },
        "type": "plain",
        "model_category": "normal",
        "source": {
            "lang": from,
            "text_list": [text],
        },
        "target": {
            "lang": to,
        },
    });
    let resp = client
        .post("https://transmart.qq.com/api/imt")
        .header("Content-Type", "application/json")
        .header("User-Agent", http::BROWSER_USER_AGENT)
        .header("Referer", "https://transmart.qq.com/zh-CN/index")
        .json(&body)
        .send()
        .await
        .map_err(|e| super::map_request_error("Tencent Transmart", e))?;
    let (status, body) = super::read_body(resp).await?;
    if !status.is_success() {
        return Err(super::http_err(status, &body, "Tencent Transmart"));
    }
    let v: Value = serde_json::from_str(&body)
        .map_err(|e| AppError::message(format!("Tencent Transmart parse: {e}")))?;
    if let Some(arr) = v.get("auto_translation").and_then(|x| x.as_array()) {
        let parts: Vec<&str> = arr.iter().filter_map(|x| x.as_str()).collect();
        if !parts.is_empty() {
            return Ok(parts.join("\n").trim().to_string());
        }
    }
    Err(AppError::message(
        "Unexpected Tencent Transmart translation response",
    ))
}
