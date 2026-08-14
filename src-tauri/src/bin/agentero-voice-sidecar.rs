//! Minimal single-user ChatGPT Web Voice signaling sidecar.
//!
//! It accepts one bootstrap JSON line on stdin, binds an ephemeral loopback
//! port, and prints one redacted readiness JSON line on stdout. The ChatGPT
//! token never appears in argv, environment variables, URLs, logs, or HTTP
//! responses. Closing stdin shuts the sidecar down.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{delete, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashSet,
    io::{BufRead, Read, Write},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{net::TcpListener, sync::mpsc};
use uuid::Uuid;

const UPSTREAM_URL: &str = "https://chatgpt.com/realtime/wm?dcid=0";
const DEFAULT_VOICE: &str = "cove";
const DEFAULT_VOICE_MODE: &str = "wingman";
const DEFAULT_LANGUAGE: &str = "auto";
const IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";
const SEC_CH_UA: &str = r#""Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24""#;

#[derive(Debug, Deserialize)]
struct Bootstrap {
    access_token: String,
    session_secret: String,
    #[serde(default)]
    proxy_url: String,
}

#[derive(Debug, Serialize)]
struct Ready {
    version: &'static str,
    port: u16,
}

#[derive(Clone)]
struct AppState {
    access_token: Arc<str>,
    session_secret: Arc<str>,
    client: reqwest::Client,
    sessions: Arc<Mutex<HashSet<String>>>,
    last_activity: Arc<Mutex<Instant>>,
    device_id: Arc<str>,
    session_id: Arc<str>,
}

#[derive(Debug, Deserialize)]
struct CreateSessionRequest {
    offer_sdp: String,
    #[serde(default)]
    voice: String,
    #[serde(default)]
    voice_mode: String,
    #[serde(default)]
    language_code: String,
}

#[derive(Debug, Serialize)]
struct CreateSessionResponse {
    answer_sdp: String,
    voice_session_id: String,
    voice: String,
    voice_mode: String,
    language_code: String,
}

#[tokio::main]
async fn main() {
    if let Err(message) = run().await {
        let safe = json!({ "error": message }).to_string();
        let _ = writeln!(std::io::stdout(), "{safe}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let mut stdin = std::io::BufReader::new(std::io::stdin());
    let mut line = String::new();
    stdin
        .read_line(&mut line)
        .map_err(|_| "could not read bootstrap".to_string())?;
    if line.len() > 64 * 1024 {
        return Err("bootstrap is too large".into());
    }
    let bootstrap: Bootstrap =
        serde_json::from_str(&line).map_err(|_| "invalid bootstrap".to_string())?;
    if bootstrap.access_token.trim().len() < 20 || bootstrap.session_secret.trim().len() < 32 {
        return Err("invalid bootstrap credentials".into());
    }

    let mut client_builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .redirect(reqwest::redirect::Policy::none());
    if !bootstrap.proxy_url.trim().is_empty() {
        let proxy = reqwest::Proxy::all(bootstrap.proxy_url.trim())
            .map_err(|_| "invalid network proxy".to_string())?;
        client_builder = client_builder.proxy(proxy);
    }
    let state = AppState {
        access_token: Arc::from(bootstrap.access_token.trim()),
        session_secret: Arc::from(bootstrap.session_secret.trim()),
        client: client_builder
            .build()
            .map_err(|_| "could not create HTTP client".to_string())?,
        sessions: Arc::new(Mutex::new(HashSet::new())),
        last_activity: Arc::new(Mutex::new(Instant::now())),
        device_id: Arc::from(Uuid::new_v4().to_string()),
        session_id: Arc::from(Uuid::new_v4().to_string()),
    };

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| "could not bind loopback listener".to_string())?;
    let port = listener
        .local_addr()
        .map_err(|_| "could not read loopback port".to_string())?
        .port();

    let app = Router::new()
        .route("/v1/voice/sessions", post(create_session))
        .route("/v1/voice/sessions/{id}", delete(release_session))
        .with_state(state.clone());

    writeln!(
        std::io::stdout(),
        "{}",
        serde_json::to_string(&Ready {
            version: "v1",
            port
        })
        .map_err(|_| "could not encode readiness".to_string())?
    )
    .map_err(|_| "could not report readiness".to_string())?;
    std::io::stdout()
        .flush()
        .map_err(|_| "could not flush readiness".to_string())?;

    let (shutdown_tx, mut shutdown_rx) = mpsc::unbounded_channel::<()>();
    let parent_shutdown = shutdown_tx.clone();
    tokio::task::spawn_blocking(move || {
        let mut remainder = Vec::new();
        let _ = stdin.read_to_end(&mut remainder);
        let _ = parent_shutdown.send(());
    });

    let idle_state = state;
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(15));
        loop {
            interval.tick().await;
            let elapsed = idle_state
                .last_activity
                .lock()
                .map(|value| value.elapsed())
                .unwrap_or(IDLE_TIMEOUT);
            if elapsed >= IDLE_TIMEOUT {
                let _ = shutdown_tx.send(());
                break;
            }
        }
    });

    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx.recv().await;
        })
        .await
        .map_err(|_| "voice sidecar server stopped unexpectedly".to_string())
}

async fn create_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreateSessionRequest>,
) -> impl IntoResponse {
    touch(&state);
    if !authorized(&state, &headers) {
        return error(
            StatusCode::UNAUTHORIZED,
            "invalid_session",
            "Voice session is unauthorized",
        );
    }
    let offer_sdp = match normalize_sdp(&request.offer_sdp) {
        Ok(value) => value,
        Err(message) => return error(StatusCode::BAD_REQUEST, "invalid_request", message),
    };
    let voice = normalize_voice(&request.voice);
    let requested_voice_mode = request.voice_mode.trim();
    let voice_mode = if requested_voice_mode.is_empty()
        || requested_voice_mode.eq_ignore_ascii_case(DEFAULT_VOICE_MODE)
    {
        DEFAULT_VOICE_MODE.to_string()
    } else {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Unsupported voice mode",
        );
    };
    let language_code = normalize_language(&request.language_code);
    let upstream_session_id = Uuid::new_v4().to_string().to_uppercase();
    let session_json =
        build_session_json(&voice, &voice_mode, &language_code, &upstream_session_id);
    let (body, content_type) = multipart_body(&offer_sdp, &session_json);

    let upstream = state
        .client
        .post(UPSTREAM_URL)
        .headers(upstream_headers(&state, &content_type))
        .body(body)
        .send()
        .await;
    let response = match upstream {
        Ok(value) => value,
        Err(_) => {
            return error(
                StatusCode::BAD_GATEWAY,
                "upstream_unavailable",
                "ChatGPT Voice is temporarily unavailable",
            )
        }
    };
    let status = response.status();
    let answer = response.text().await.unwrap_or_default();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return error(
            StatusCode::UNAUTHORIZED,
            "session_expired",
            "ChatGPT login has expired; connect your account again",
        );
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return error(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "ChatGPT Voice is rate limited; try again later",
        );
    }
    if !(status == reqwest::StatusCode::OK || status == reqwest::StatusCode::CREATED)
        || !answer.trim_start().starts_with("v=0")
    {
        return error(
            StatusCode::BAD_GATEWAY,
            "upstream_rejected",
            "ChatGPT Voice rejected the realtime session",
        );
    }

    let voice_session_id = format!("vs_{}", Uuid::new_v4().simple());
    if let Ok(mut sessions) = state.sessions.lock() {
        sessions.insert(voice_session_id.clone());
    }
    (
        StatusCode::OK,
        Json(json!(CreateSessionResponse {
            answer_sdp: answer,
            voice_session_id,
            voice,
            voice_mode,
            language_code,
        })),
    )
        .into_response()
}

async fn release_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    touch(&state);
    if !authorized(&state, &headers) {
        return error(
            StatusCode::UNAUTHORIZED,
            "invalid_session",
            "Voice session is unauthorized",
        );
    }
    let released = state
        .sessions
        .lock()
        .map(|mut sessions| sessions.remove(session_id.trim()))
        .unwrap_or(false);
    if !released {
        return error(
            StatusCode::NOT_FOUND,
            "voice_session_not_found",
            "Voice session was already released",
        );
    }
    (StatusCode::OK, Json(json!({ "released": true }))).into_response()
}

fn authorized(state: &AppState, headers: &HeaderMap) -> bool {
    headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|value| value == state.session_secret.as_ref())
}

fn touch(state: &AppState) {
    if let Ok(mut value) = state.last_activity.lock() {
        *value = Instant::now();
    }
}

fn error(
    status: StatusCode,
    code: &'static str,
    message: impl Into<String>,
) -> axum::response::Response {
    (
        status,
        Json(json!({
            "error": { "code": code, "message": message.into() }
        })),
    )
        .into_response()
}

fn normalize_sdp(raw: &str) -> Result<String, &'static str> {
    let trimmed = raw.trim();
    if !trimmed.starts_with("v=0") {
        return Err("A valid WebRTC offer is required");
    }
    let mut normalized = trimmed.replace("\r\n", "\n").replace('\r', "\n");
    normalized = normalized.replace('\n', "\r\n");
    if !normalized.ends_with("\r\n") {
        normalized.push_str("\r\n");
    }
    Ok(normalized)
}

fn normalize_voice(raw: &str) -> String {
    let voice = raw.trim().to_ascii_lowercase();
    match voice.as_str() {
        "breeze" | "cove" | "ember" | "fathom" | "glimmer" | "juniper" | "maple" | "orbit"
        | "vale" => voice,
        "arbor" => "fathom".into(),
        "sol" => "glimmer".into(),
        "spruce" => "orbit".into(),
        _ => DEFAULT_VOICE.into(),
    }
}

fn normalize_language(raw: &str) -> String {
    let language = raw.trim().to_ascii_lowercase();
    if language.is_empty()
        || language.len() > 16
        || !language
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        DEFAULT_LANGUAGE.into()
    } else {
        language
    }
}

fn build_session_json(voice: &str, voice_mode: &str, language: &str, session_id: &str) -> String {
    json!({
        "backend_reasoning_effort": "instant",
        "language_code": language,
        "requested_default_model": "",
        "voice": voice,
        "voice_session_id": session_id,
        "voice_status_request_id": session_id,
        "timezone_offset_min": -480,
        "timezone": "Etc/GMT-8",
        "voice_mode": voice_mode,
        "model_slug": "",
        "model_slug_advanced": "",
        "client_tools": [],
        "history_and_training_disabled": false,
        "conversation_mode": { "kind": "primary_assistant" },
        "enable_message_streaming": true
    })
    .to_string()
}

fn multipart_body(sdp: &str, session_json: &str) -> (Vec<u8>, String) {
    let boundary = format!(
        "----WebKitFormBoundary{}",
        &Uuid::new_v4().simple().to_string()[..16]
    );
    let mut body = Vec::new();
    for (name, value) in [("sdp", sdp), ("session", session_json)] {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        body.extend_from_slice(
            format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes(),
        );
        body.extend_from_slice(value.as_bytes());
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (body, format!("multipart/form-data; boundary={boundary}"))
}

fn upstream_headers(state: &AppState, content_type: &str) -> reqwest::header::HeaderMap {
    use reqwest::header::{HeaderMap, HeaderValue};
    let mut headers = HeaderMap::new();
    let values = [
        ("accept", "*/*"),
        ("accept-language", "zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7"),
        ("cache-control", "no-cache"),
        ("pragma", "no-cache"),
        ("priority", "u=1, i"),
        ("origin", "https://chatgpt.com"),
        ("referer", "https://chatgpt.com/"),
        ("user-agent", USER_AGENT),
        ("sec-ch-ua", SEC_CH_UA),
        ("sec-ch-ua-arch", r#""x86""#),
        ("sec-ch-ua-bitness", r#""64""#),
        ("sec-ch-ua-mobile", "?0"),
        ("sec-ch-ua-model", r#""""#),
        ("sec-ch-ua-platform", r#""Windows""#),
        ("sec-fetch-dest", "empty"),
        ("sec-fetch-mode", "cors"),
        ("sec-fetch-site", "same-origin"),
        ("oai-language", "zh-CN"),
    ];
    for (name, value) in values {
        if let Ok(value) = HeaderValue::from_str(value) {
            headers.insert(name, value);
        }
    }
    if let Ok(value) = HeaderValue::from_str(content_type) {
        headers.insert("content-type", value);
    }
    if let Ok(value) = HeaderValue::from_str(&format!("Bearer {}", state.access_token)) {
        headers.insert("authorization", value);
    }
    if let Ok(value) = HeaderValue::from_str(&state.device_id) {
        headers.insert("oai-device-id", value);
    }
    if let Ok(value) = HeaderValue::from_str(&state.session_id) {
        headers.insert("oai-session-id", value);
    }
    headers
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_offer_and_rejects_non_sdp() {
        assert_eq!(normalize_sdp("v=0\no=- 1\n").unwrap(), "v=0\r\no=- 1\r\n");
        assert!(normalize_sdp("not an offer").is_err());
    }

    #[test]
    fn session_payload_contains_only_single_user_voice_fields() {
        let payload: serde_json::Value =
            serde_json::from_str(&build_session_json("cove", "wingman", "zh-cn", "VOICE-ID"))
                .unwrap();
        assert_eq!(payload["voice_session_id"], "VOICE-ID");
        assert_eq!(payload["voice"], "cove");
        assert!(payload.get("access_token").is_none());
        assert!(payload.get("account_id").is_none());
    }

    #[test]
    fn multipart_contains_sdp_and_session_without_token() {
        let (body, content_type) = multipart_body("v=0\r\n", "{\"voice\":\"cove\"}");
        let text = String::from_utf8(body).unwrap();
        assert!(content_type.starts_with("multipart/form-data; boundary="));
        assert!(text.contains("name=\"sdp\""));
        assert!(text.contains("name=\"session\""));
        assert!(!text.contains("access_token"));
    }
}
