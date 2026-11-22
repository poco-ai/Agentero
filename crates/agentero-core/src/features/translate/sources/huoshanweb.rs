use crate::error::AppError;
use crate::http;
use serde_json::Value;
use std::time::Duration;

/// The public CRX endpoint randomly answers valid requests with a bare HTTP 500
/// (~5% observed in bursts); the same payload succeeds on retry.
const MAX_ATTEMPTS: u32 = 3;
const RETRY_BASE_DELAY: Duration = Duration::from_millis(400);

pub async fn translate_huoshan_web(
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
        "source_language": from,
        "target_language": to,
        "text": text,
    });

    let mut last_error = None;
    for attempt in 0..MAX_ATTEMPTS {
        if attempt > 0 {
            tokio::time::sleep(RETRY_BASE_DELAY * attempt).await;
        }
        match request_once(&client, &body).await {
            Ok(translated) => return Ok(translated),
            Err(AttemptError::Fatal(error)) => return Err(error),
            Err(AttemptError::Retryable(error)) => last_error = Some(error),
        }
    }
    Err(last_error.expect("at least one attempt ran"))
}

enum AttemptError {
    Retryable(AppError),
    Fatal(AppError),
}

async fn request_once(client: &reqwest::Client, body: &Value) -> Result<String, AttemptError> {
    let resp = client
        .post("https://translate.volcengine.com/crx/translate/v1")
        .header("Content-Type", "application/json")
        .header("User-Agent", http::BROWSER_USER_AGENT)
        .json(body)
        .send()
        .await
        .map_err(|e| AttemptError::Fatal(super::map_request_error("Volcengine", e)))?;
    let (status, body) = super::read_body(resp).await.map_err(AttemptError::Fatal)?;
    if !status.is_success() {
        let error = super::http_err(status, &body, "Volcengine Web");
        return Err(if is_retryable_status(status) {
            AttemptError::Retryable(error)
        } else {
            AttemptError::Fatal(error)
        });
    }
    let v: Value = serde_json::from_str(&body)
        .map_err(|e| AttemptError::Fatal(AppError::message(format!("Volcengine parse: {e}"))))?;
    v.get("translation")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| {
            AttemptError::Fatal(AppError::message(
                "Unexpected Volcengine translation response",
            ))
        })
}

fn is_retryable_status(status: reqwest::StatusCode) -> bool {
    status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retries_only_transient_statuses() {
        assert!(is_retryable_status(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR
        ));
        assert!(is_retryable_status(reqwest::StatusCode::TOO_MANY_REQUESTS));
        assert!(!is_retryable_status(reqwest::StatusCode::BAD_REQUEST));
        assert!(!is_retryable_status(reqwest::StatusCode::UNAUTHORIZED));
    }
}
