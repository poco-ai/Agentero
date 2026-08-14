use crate::core::error::{ApiResult, AppError};
use crate::features::settings::AppSettingsStore;
use reqwest::{Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tauri::{AppHandle, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;
use uuid::Uuid;

const SIDECAR_NAME: &str = "agentero-voice-sidecar";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSessionRequest {
    pub offer_sdp: String,
    pub voice: String,
    pub voice_mode: String,
    pub language_code: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSessionResponse {
    pub answer_sdp: String,
    pub voice_session_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSessionReleaseResponse {
    pub released: bool,
}

#[derive(Debug, Serialize)]
struct SidecarBootstrap<'a> {
    access_token: &'a str,
    session_secret: &'a str,
    proxy_url: &'a str,
}

#[derive(Debug, Deserialize)]
struct SidecarReady {
    #[serde(default)]
    port: u16,
    #[serde(default)]
    error: String,
}

struct SidecarProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    base_url: String,
    session_secret: String,
}

/// Owns the one process used by the current Voice call. The child receives the
/// ChatGPT token only through stdin, is loopback-only, and is killed on drop.
pub struct VoiceSidecarController {
    process: Mutex<Option<SidecarProcess>>,
}

impl VoiceSidecarController {
    pub fn new() -> Self {
        Self {
            process: Mutex::new(None),
        }
    }

    async fn connection(&self, settings: &AppSettingsStore) -> Result<(String, String), AppError> {
        let mut guard = self.process.lock().await;
        if let Some(process) = guard.as_mut() {
            match process.child.try_wait() {
                Ok(None) => {
                    return Ok((process.base_url.clone(), process.session_secret.clone()));
                }
                Ok(Some(_)) | Err(_) => {
                    *guard = None;
                }
            }
        }

        let token = super::auth::access_token()?;
        let current = settings.get()?.settings;
        let proxy_url = if current.network_proxy_enabled {
            current.network_proxy_url.trim()
        } else {
            ""
        };
        let process = start_sidecar(&token, proxy_url).await?;
        let connection = (process.base_url.clone(), process.session_secret.clone());
        *guard = Some(process);
        Ok(connection)
    }

    async fn stop(&self) {
        let process = self.process.lock().await.take();
        if let Some(mut process) = process {
            // stdin EOF is the graceful parent-death signal. A direct kill is
            // the bounded fallback so closing a call never leaves a process.
            process.stdin.take();
            let _ = process.child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(2), process.child.wait()).await;
        }
    }
}

impl Default for VoiceSidecarController {
    fn default() -> Self {
        Self::new()
    }
}

async fn start_sidecar(token: &str, proxy_url: &str) -> Result<SidecarProcess, AppError> {
    let executable = sidecar_executable()?;
    let session_secret = Uuid::new_v4().simple().to_string();
    let mut child = Command::new(&executable)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            AppError::message(format!(
                "could not start the built-in Voice service: {error}"
            ))
        })?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::message("built-in Voice service has no stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::message("built-in Voice service has no stdout"))?;
    let bootstrap = serde_json::to_vec(&SidecarBootstrap {
        access_token: token,
        session_secret: &session_secret,
        proxy_url,
    })?;
    stdin
        .write_all(&bootstrap)
        .await
        .map_err(|_| AppError::message("could not initialize the built-in Voice service"))?;
    stdin
        .write_all(b"\n")
        .await
        .map_err(|_| AppError::message("could not initialize the built-in Voice service"))?;
    stdin
        .flush()
        .await
        .map_err(|_| AppError::message("could not initialize the built-in Voice service"))?;

    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    let bytes = tokio::time::timeout(Duration::from_secs(10), reader.read_line(&mut line))
        .await
        .map_err(|_| AppError::message("built-in Voice service startup timed out"))?
        .map_err(|_| AppError::message("could not read built-in Voice service status"))?;
    if bytes == 0 || line.len() > 16 * 1024 {
        return Err(AppError::message(
            "built-in Voice service exited during startup",
        ));
    }
    let ready: SidecarReady = serde_json::from_str(&line)
        .map_err(|_| AppError::message("built-in Voice service returned invalid status"))?;
    if !ready.error.trim().is_empty() || ready.port == 0 {
        return Err(AppError::message(if ready.error.trim().is_empty() {
            "built-in Voice service failed to start".to_string()
        } else {
            ready.error
        }));
    }
    Ok(SidecarProcess {
        child,
        stdin: Some(stdin),
        base_url: format!("http://127.0.0.1:{}", ready.port),
        session_secret,
    })
}

fn sidecar_executable() -> Result<PathBuf, AppError> {
    let current = std::env::current_exe()
        .map_err(|error| AppError::message(format!("could not locate Agentero: {error}")))?;
    let directory = current
        .parent()
        .ok_or_else(|| AppError::message("could not locate Agentero application directory"))?;
    #[cfg(windows)]
    let file_name = format!("{SIDECAR_NAME}.exe");
    #[cfg(not(windows))]
    let file_name = SIDECAR_NAME.to_string();
    let path = directory.join(file_name);
    if !path.is_file() {
        return Err(AppError::message(
            "the built-in Voice service is missing; reinstall Agentero",
        ));
    }
    Ok(path)
}

fn sidecar_client() -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(50))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| AppError::message(format!("Voice service HTTP client: {error}")))
}

async fn sidecar_request(
    method: Method,
    url: &str,
    session_secret: &str,
    body: Option<Value>,
) -> Result<reqwest::Response, AppError> {
    let mut request = sidecar_client()?
        .request(method, url)
        .bearer_auth(session_secret);
    if let Some(body) = body {
        request = request.json(&body);
    }
    request
        .send()
        .await
        .map_err(|_| AppError::message("built-in Voice service is unavailable"))
}

async fn response_error(response: reqwest::Response) -> AppError {
    let status = response.status();
    let parsed = response.json::<Value>().await.ok();
    let message = parsed
        .as_ref()
        .and_then(|value| value.pointer("/error/message"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("Voice session failed (HTTP {status})"));
    AppError::message(message)
}

/// WebKit's SDP parser is stricter than Chromium about mixed line endings and
/// the terminating CRLF. Normalize the upstream answer before it crosses IPC.
fn normalize_answer_sdp(raw: &str) -> Result<String, AppError> {
    let trimmed = raw.trim();
    if !trimmed.starts_with("v=0") {
        return Err(AppError::message(
            "built-in Voice service returned an invalid SDP answer",
        ));
    }

    let unix = trimmed.replace("\r\n", "\n").replace('\r', "\n");
    if unix.lines().any(|line| {
        let bytes = line.as_bytes();
        bytes.len() < 2 || !bytes[0].is_ascii_lowercase() || bytes[1] != b'='
    }) {
        return Err(AppError::message(
            "built-in Voice service returned an invalid SDP line",
        ));
    }

    let mut normalized = unix.replace('\n', "\r\n");
    normalized.push_str("\r\n");
    Ok(normalized)
}

fn parse_session_response(parsed: &Value) -> Result<VoiceSessionResponse, AppError> {
    let raw_answer_sdp = parsed
        .get("answer_sdp")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let voice_session_id = parsed
        .get("voice_session_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if raw_answer_sdp.trim().is_empty() || voice_session_id.is_empty() {
        return Err(AppError::message(
            "built-in Voice service response is missing SDP or session id",
        ));
    }
    let answer_sdp = normalize_answer_sdp(raw_answer_sdp)?;
    Ok(VoiceSessionResponse {
        answer_sdp,
        voice_session_id,
    })
}

fn public_config() -> Value {
    json!({
        "defaults": {
            "voice": "cove",
            "voice_mode": "wingman",
            "language_code": "auto"
        },
        "webrtc": {
            "data_channel": {
                "label": "oai-events",
                "negotiated": true,
                "id": 0
            },
            "ice_servers": [],
            "receive_audio": true,
            "receive_video": false
        }
    })
}

#[tauri::command]
pub async fn voice_config() -> Result<ApiResult<Value>, String> {
    Ok(ApiResult::ok(public_config()))
}

#[tauri::command]
pub async fn voice_session_create(
    app: AppHandle,
    request: VoiceSessionRequest,
    controller: State<'_, VoiceSidecarController>,
    settings: State<'_, AppSettingsStore>,
) -> Result<ApiResult<VoiceSessionResponse>, String> {
    let result = async {
        if request.offer_sdp.trim().is_empty() {
            return Err(AppError::message("Voice WebRTC offer SDP is required"));
        }
        let (base_url, secret) = controller.connection(&settings).await?;
        let response = sidecar_request(
            Method::POST,
            &format!("{base_url}/v1/voice/sessions"),
            &secret,
            Some(json!({
                "offer_sdp": request.offer_sdp.trim(),
                "voice": request.voice.trim(),
                "voice_mode": request.voice_mode.trim(),
                "language_code": request.language_code.trim(),
            })),
        )
        .await?;
        if response.status() == StatusCode::UNAUTHORIZED {
            let _ = super::auth::invalidate_access_token(&app);
        }
        if !response.status().is_success() {
            return Err(response_error(response).await);
        }
        let parsed = response
            .json::<Value>()
            .await
            .map_err(|_| AppError::message("built-in Voice service returned invalid SDP"))?;
        parse_session_response(&parsed)
    }
    .await;
    if result.is_err() {
        controller.stop().await;
    }
    Ok(result.map(ApiResult::ok).unwrap_or_else(ApiResult::err))
}

#[tauri::command]
pub async fn voice_session_release(
    voice_session_id: String,
    controller: State<'_, VoiceSidecarController>,
) -> Result<ApiResult<VoiceSessionReleaseResponse>, String> {
    let result = async {
        let session_id = voice_session_id.trim();
        if session_id.is_empty() {
            return Err(AppError::message("Voice session id is required"));
        }
        let connection = {
            let mut guard = controller.process.lock().await;
            let Some(process) = guard.as_mut() else {
                return Ok(VoiceSessionReleaseResponse { released: true });
            };
            match process.child.try_wait() {
                Ok(None) => Some((process.base_url.clone(), process.session_secret.clone())),
                Ok(Some(_)) | Err(_) => None,
            }
        };
        let Some((base_url, secret)) = connection else {
            return Ok(VoiceSessionReleaseResponse { released: true });
        };
        let response = sidecar_request(
            Method::DELETE,
            &format!("{base_url}/v1/voice/sessions/{session_id}"),
            &secret,
            None,
        )
        .await?;
        if response.status().is_success() || response.status() == StatusCode::NOT_FOUND {
            return Ok(VoiceSessionReleaseResponse { released: true });
        }
        Err(response_error(response).await)
    }
    .await;
    controller.stop().await;
    Ok(result.map(ApiResult::ok).unwrap_or_else(ApiResult::err))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_config_matches_negotiated_data_channel() {
        let config = public_config();
        assert_eq!(config.pointer("/defaults/voice"), Some(&json!("cove")));
        assert_eq!(
            config.pointer("/webrtc/data_channel/label"),
            Some(&json!("oai-events"))
        );
        assert_eq!(
            config.pointer("/webrtc/data_channel/negotiated"),
            Some(&json!(true))
        );
    }

    #[test]
    fn bundled_sidecar_name_is_not_configurable() {
        assert_eq!(SIDECAR_NAME, "agentero-voice-sidecar");
        assert!(!SIDECAR_NAME.contains("gateway"));
    }

    #[test]
    fn session_answer_is_normalized_for_strict_webkit_sdp_parser() {
        let response = parse_session_response(&json!({
            "answer_sdp": "\nv=0\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\n",
            "voice_session_id": " vs_test "
        }))
        .unwrap();

        assert_eq!(
            response.answer_sdp,
            "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n"
        );
        assert_eq!(response.voice_session_id, "vs_test");
    }

    #[test]
    fn session_answer_rejects_non_sdp_and_malformed_lines() {
        assert!(normalize_answer_sdp("not an SDP response").is_err());
        assert!(normalize_answer_sdp("v=0\r\ninvalid-line\r\n").is_err());
    }
}
