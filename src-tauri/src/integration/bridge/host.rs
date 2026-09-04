use super::{
    connect_relay, next_frame, send_binary, send_text, validate_device_public_key,
    verify_device_challenge, BridgeDevice, BridgeDeviceStore, BridgeIdentity, BridgeIdentityStore,
    BridgeMessage, BridgeOffer, E2eeHandshake, RelayControlMessage, RelayEndpoint, RelayFrame,
    RelayOffer, RpcError, SessionCipher, DEFAULT_RELAY_ENDPOINT,
};
#[cfg(not(target_os = "ios"))]
use crate::core::error::ApiResult;
use crate::core::error::AppError;
#[cfg(not(target_os = "ios"))]
use crate::features::agent::commands::PermissionResponseRequest;
#[cfg(not(target_os = "ios"))]
use crate::features::agent::models::RunOnceRequest;
#[cfg(not(target_os = "ios"))]
use crate::features::agent::{AgentRegistry, AgentRunController, PermissionGate};
use crate::features::catalog::papers;
use crate::features::search::{self, VaultSearchArgs};
use crate::features::vault::tree;
#[cfg(not(target_os = "ios"))]
use crate::integration::remote::RemoteRegistry;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::Utc;
use crypto_box::aead::rand_core::RngCore;
use crypto_box::PublicKey;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Digest;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, EventId, Listener, Manager};
use tokio::sync::{mpsc, oneshot, watch};

const PAIRING_TIMEOUT: Duration = Duration::from_secs(300);
const RECONNECT_DELAY: Duration = Duration::from_secs(2);
const MAX_BRIDGE_READ_BYTES: usize = 256 * 1024;
const FORWARDED_AGENT_EVENTS: [&str; 7] = [
    "agent:stream",
    "agent:completed",
    "agent:failed",
    "agent:tool",
    "agent:plan",
    "agent:usage",
    "agent:permission-request",
];

struct ForwardedAgentEvent {
    name: String,
    payload: Value,
}

struct AgentEventForwarder {
    app: AppHandle,
    listeners: Vec<EventId>,
    receiver: mpsc::UnboundedReceiver<ForwardedAgentEvent>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeFileInfo {
    path: String,
    size: u64,
    modified_at: u64,
    sha256: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeReadBytesResult {
    file: BridgeFileInfo,
    offset: u64,
    bytes_b64: String,
}

impl AgentEventForwarder {
    fn new(app: &AppHandle) -> Self {
        let (sender, receiver) = mpsc::unbounded_channel();
        let listeners = FORWARDED_AGENT_EVENTS
            .iter()
            .map(|event_name| {
                let sender = sender.clone();
                let event_name = (*event_name).to_string();
                app.listen_any(event_name.clone(), move |event| {
                    let Ok(payload) = serde_json::from_str(event.payload()) else {
                        return;
                    };
                    let _ = sender.send(ForwardedAgentEvent {
                        name: event_name.clone(),
                        payload,
                    });
                })
            })
            .collect();
        Self {
            app: app.clone(),
            listeners,
            receiver,
        }
    }
}

impl Drop for AgentEventForwarder {
    fn drop(&mut self) {
        for listener in self.listeners.drain(..) {
            self.app.unlisten(listener);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingRequest {
    pub request_id: String,
    pub device_id: String,
    pub device_name: String,
    pub verification_code: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    pub enabled: bool,
    pub online: bool,
    pub server_id: Option<String>,
    pub relay_endpoint: String,
    pub host_name: Option<String>,
    pub vault_path: Option<String>,
    pub active_connections: usize,
    pub pending_pairings: Vec<PairingRequest>,
    pub last_error: Option<String>,
}

impl BridgeStatus {
    fn disabled() -> Self {
        Self {
            enabled: false,
            online: false,
            server_id: None,
            relay_endpoint: DEFAULT_RELAY_ENDPOINT.to_string(),
            host_name: None,
            vault_path: None,
            active_connections: 0,
            pending_pairings: Vec::new(),
            last_error: None,
        }
    }
}

pub struct BridgeController {
    runtime: Mutex<Option<HostRuntime>>,
}

struct HostRuntime {
    shared: Arc<HostShared>,
    stop: watch::Sender<bool>,
}

struct HostShared {
    identity: BridgeIdentity,
    endpoint: RelayEndpoint,
    host_name: String,
    vault_root: PathBuf,
    devices: BridgeDeviceStore,
    state: Mutex<HostState>,
    active_data: Mutex<HashSet<String>>,
    pending: Mutex<HashMap<String, PendingPairing>>,
}

struct HostState {
    online: bool,
    last_error: Option<String>,
}

struct PendingPairing {
    summary: PairingRequest,
    response: oneshot::Sender<bool>,
}

impl BridgeController {
    pub fn new() -> Self {
        Self {
            runtime: Mutex::new(None),
        }
    }

    pub fn start(
        &self,
        app: AppHandle,
        vault_path: String,
        host_name: String,
        relay_endpoint: Option<String>,
    ) -> Result<BridgeStatus, AppError> {
        let vault_root = crate::core::fs::resolve_vault(&vault_path)?;
        let host_name = host_name.trim().to_string();
        if host_name.is_empty() {
            return Err(AppError::message("Bridge host name is required"));
        }
        let endpoint = RelayEndpoint::parse(
            relay_endpoint
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(DEFAULT_RELAY_ENDPOINT),
        )?;
        let identity = BridgeIdentityStore::at_default_path().load_or_create()?;
        let shared = Arc::new(HostShared {
            identity,
            endpoint,
            host_name,
            vault_root,
            devices: BridgeDeviceStore::at_default_path(),
            state: Mutex::new(HostState {
                online: false,
                last_error: None,
            }),
            active_data: Mutex::new(HashSet::new()),
            pending: Mutex::new(HashMap::new()),
        });
        let (stop, receiver) = watch::channel(false);
        let runtime = HostRuntime {
            shared: Arc::clone(&shared),
            stop,
        };

        self.stop()?;
        let mut guard = self
            .runtime
            .lock()
            .map_err(|_| AppError::message("Bridge runtime lock poisoned"))?;
        *guard = Some(runtime);
        drop(guard);

        tauri::async_runtime::spawn(run_control_loop(app, shared, receiver));
        self.status()
    }

    pub fn stop(&self) -> Result<(), AppError> {
        let runtime = self
            .runtime
            .lock()
            .map_err(|_| AppError::message("Bridge runtime lock poisoned"))?
            .take();
        if let Some(runtime) = runtime {
            let _ = runtime.stop.send(true);
        }
        Ok(())
    }

    pub fn status(&self) -> Result<BridgeStatus, AppError> {
        let guard = self
            .runtime
            .lock()
            .map_err(|_| AppError::message("Bridge runtime lock poisoned"))?;
        let Some(runtime) = guard.as_ref() else {
            return Ok(BridgeStatus::disabled());
        };
        let state = runtime
            .shared
            .state
            .lock()
            .map_err(|_| AppError::message("Bridge state lock poisoned"))?;
        let active_connections = runtime
            .shared
            .active_data
            .lock()
            .map_err(|_| AppError::message("Bridge data lock poisoned"))?
            .len();
        let pending_pairings = runtime
            .shared
            .pending
            .lock()
            .map_err(|_| AppError::message("Bridge pairing lock poisoned"))?
            .values()
            .map(|pairing| pairing.summary.clone())
            .collect();
        Ok(BridgeStatus {
            enabled: true,
            online: state.online,
            server_id: Some(runtime.shared.identity.server_id.clone()),
            relay_endpoint: runtime.shared.endpoint.websocket_url().to_string(),
            host_name: Some(runtime.shared.host_name.clone()),
            vault_path: Some(runtime.shared.vault_root.to_string_lossy().into_owned()),
            active_connections,
            pending_pairings,
            last_error: state.last_error.clone(),
        })
    }

    pub fn offer(&self) -> Result<BridgeOffer, AppError> {
        let guard = self
            .runtime
            .lock()
            .map_err(|_| AppError::message("Bridge runtime lock poisoned"))?;
        let runtime = guard
            .as_ref()
            .ok_or_else(|| AppError::message("Remote access is not enabled"))?;
        Ok(BridgeOffer {
            v: 1,
            server_id: runtime.shared.identity.server_id.clone(),
            host_public_key_b64: runtime.shared.identity.public_key_b64.clone(),
            relay: RelayOffer {
                endpoint: relay_endpoint_for_offer(&runtime.shared.endpoint),
            },
            host_name: runtime.shared.host_name.clone(),
            pin: true,
        })
    }

    pub fn respond_to_pairing(&self, request_id: &str, allowed: bool) -> Result<bool, AppError> {
        let guard = self
            .runtime
            .lock()
            .map_err(|_| AppError::message("Bridge runtime lock poisoned"))?;
        let Some(runtime) = guard.as_ref() else {
            return Ok(false);
        };
        let pending = runtime
            .shared
            .pending
            .lock()
            .map_err(|_| AppError::message("Bridge pairing lock poisoned"))?
            .remove(request_id);
        let Some(pending) = pending else {
            return Ok(false);
        };
        let _ = pending.response.send(allowed);
        Ok(true)
    }

    pub fn devices(&self) -> Result<Vec<BridgeDevice>, AppError> {
        BridgeDeviceStore::at_default_path().list()
    }

    pub fn revoke_device(&self, device_id: &str) -> Result<bool, AppError> {
        BridgeDeviceStore::at_default_path().revoke(device_id)
    }
}

impl Default for BridgeController {
    fn default() -> Self {
        Self::new()
    }
}

async fn run_control_loop(
    app: AppHandle,
    shared: Arc<HostShared>,
    mut stop: watch::Receiver<bool>,
) {
    loop {
        if *stop.borrow() {
            return;
        }
        let url = match shared
            .endpoint
            .connection_url(&shared.identity.server_id, "server", None)
        {
            Ok(url) => url,
            Err(error) => {
                set_error(&app, &shared, error.to_string());
                return;
            }
        };
        match connect_relay(url).await {
            Ok(mut socket) => {
                set_online(&app, &shared, true);
                loop {
                    tokio::select! {
                        changed = stop.changed() => {
                            if changed.is_err() || *stop.borrow() {
                                return;
                            }
                        }
                        frame = next_frame(&mut socket) => match frame {
                            Ok(RelayFrame::Text(payload)) => {
                                match serde_json::from_str::<RelayControlMessage>(&payload) {
                                    Ok(RelayControlMessage::Connected { connection_id }) => {
                                        spawn_data_channel(app.clone(), Arc::clone(&shared), connection_id, stop.clone());
                                    }
                                    Ok(RelayControlMessage::Sync { connection_ids }) => {
                                        for connection_id in connection_ids {
                                            spawn_data_channel(app.clone(), Arc::clone(&shared), connection_id, stop.clone());
                                        }
                                    }
                                    Ok(RelayControlMessage::Disconnected { connection_id }) => {
                                        if let Ok(mut active) = shared.active_data.lock() {
                                            active.remove(&connection_id);
                                        }
                                    }
                                    Ok(RelayControlMessage::Pong { .. }) => {}
                                    Err(error) => log::warn!(target: "agentero::bridge", "invalid Relay control message: {error}"),
                                }
                            }
                            Ok(RelayFrame::Close) => break,
                            Ok(RelayFrame::Binary(_)) => log::warn!(target: "agentero::bridge", "unexpected binary Relay control frame"),
                            Err(error) => {
                                set_error(&app, &shared, error.to_string());
                                break;
                            }
                        }
                    }
                }
            }
            Err(error) => set_error(&app, &shared, error.to_string()),
        }
        set_online(&app, &shared, false);
        tokio::select! {
            _ = tokio::time::sleep(RECONNECT_DELAY) => {}
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    return;
                }
            }
        }
    }
}

fn spawn_data_channel(
    app: AppHandle,
    shared: Arc<HostShared>,
    connection_id: String,
    stop: watch::Receiver<bool>,
) {
    let inserted = shared
        .active_data
        .lock()
        .map(|mut active| active.insert(connection_id.clone()))
        .unwrap_or(false);
    if !inserted {
        return;
    }
    tauri::async_runtime::spawn(async move {
        run_data_channel(app, Arc::clone(&shared), connection_id.clone(), stop).await;
        if let Ok(mut active) = shared.active_data.lock() {
            active.remove(&connection_id);
        }
    });
}

async fn run_data_channel(
    app: AppHandle,
    shared: Arc<HostShared>,
    connection_id: String,
    mut stop: watch::Receiver<bool>,
) {
    let url = match shared.endpoint.connection_url(
        &shared.identity.server_id,
        "server",
        Some(&connection_id),
    ) {
        Ok(url) => url,
        Err(error) => {
            set_error(&app, &shared, error.to_string());
            return;
        }
    };
    let Ok(mut socket) = connect_relay(url).await else {
        return;
    };
    let Ok(RelayFrame::Text(payload)) = next_frame(&mut socket).await else {
        return;
    };
    let Ok(E2eeHandshake::E2eeHello { key }) = serde_json::from_str(&payload) else {
        return;
    };
    let Ok(client_public) = decode_crypto_box_public_key(&key) else {
        return;
    };
    let Ok(host_secret) = shared.identity.secret_key() else {
        return;
    };
    let cipher = SessionCipher::from_keys(&host_secret, &client_public);
    if send_text(
        &mut socket,
        serde_json::to_string(&E2eeHandshake::E2eeReady).unwrap_or_default(),
    )
    .await
    .is_err()
    {
        return;
    }

    let mut authenticated = false;
    let mut challenge: Option<(BridgeDevice, Vec<u8>)> = None;
    let mut agent_sessions = HashSet::new();
    let mut agent_events = AgentEventForwarder::new(&app);
    loop {
        tokio::select! {
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    return;
                }
            }
            frame = next_frame(&mut socket) => {
                let Ok(frame) = frame else { return; };
                let RelayFrame::Binary(frame) = frame else { return; };
                let Ok(plaintext) = cipher.decrypt(&frame) else { return; };
                let Ok(message) = serde_json::from_slice::<BridgeMessage>(&plaintext) else { return; };
                match message {
                    BridgeMessage::Ping { ts }
                        if send_encrypted(&mut socket, &cipher, &BridgeMessage::Pong { ts })
                            .await
                            .is_err() =>
                    {
                        return;
                    }
                    BridgeMessage::PairRequest { request_id, device_id, device_name, device_public_key_b64 } => {
                        if authenticated {
                            continue;
                        }
                        if validate_device_public_key(&device_public_key_b64).is_err() {
                            let _ = send_encrypted(&mut socket, &cipher, &BridgeMessage::PairDenied { request_id, reason: "Invalid pairing request".to_string() }).await;
                            continue;
                        }
                        let pairing = begin_pairing(
                            &app,
                            &shared,
                            request_id.clone(),
                            device_id.clone(),
                            device_name.clone(),
                        );
                        let Ok((summary, receiver)) = pairing else {
                            let _ = send_encrypted(&mut socket, &cipher, &BridgeMessage::PairDenied { request_id, reason: "Invalid pairing request".to_string() }).await;
                            continue;
                        };
                        if send_encrypted(&mut socket, &cipher, &BridgeMessage::PairPending {
                            request_id: summary.request_id.clone(),
                            verification_code: summary.verification_code.clone(),
                        }).await.is_err() {
                            return;
                        }
                        let approved = wait_for_pairing(&shared, &summary.request_id, receiver).await;
                        match approved {
                            Ok(true) => {
                                let device = BridgeDevice {
                                    device_id,
                                    name: device_name,
                                    public_key_b64: device_public_key_b64,
                                    paired_at: Utc::now(),
                                    last_seen_at: Some(Utc::now()),
                                    revoked: false,
                                };
                                if shared.devices.upsert(device).is_err() {
                                    let _ = send_encrypted(&mut socket, &cipher, &BridgeMessage::PairDenied { request_id, reason: "Failed to store device".to_string() }).await;
                                    return;
                                }
                                authenticated = true;
                                if send_encrypted(&mut socket, &cipher, &BridgeMessage::PairOk { request_id }).await.is_err() {
                                    return;
                                }
                                if send_server_info(&mut socket, &cipher, &shared).await.is_err() {
                                    return;
                                }
                            }
                            Ok(false) => {
                                let _ = send_encrypted(&mut socket, &cipher, &BridgeMessage::PairDenied { request_id, reason: "Pairing was not approved".to_string() }).await;
                            }
                            Err(error) => {
                                let _ = send_encrypted(&mut socket, &cipher, &BridgeMessage::PairDenied { request_id, reason: error.to_string() }).await;
                            }
                        }
                    }
                    BridgeMessage::Hello { device_id, .. } => {
                        let device = shared.devices.list().ok().and_then(|devices| {
                            devices.into_iter().find(|device| device.device_id == device_id && !device.revoked)
                        });
                        if let Some(device) = device {
                            let mut nonce = vec![0_u8; 32];
                            crypto_box::aead::OsRng.fill_bytes(&mut nonce);
                            let nonce_b64 = URL_SAFE_NO_PAD.encode(&nonce);
                            challenge = Some((device, nonce));
                            if send_encrypted(&mut socket, &cipher, &BridgeMessage::DeviceChallenge { nonce_b64 }).await.is_err() {
                                return;
                            }
                        }
                    }
                    BridgeMessage::DeviceProof { signature_b64 } => {
                        let Some((device, nonce)) = challenge.take() else {
                            continue;
                        };
                        if verify_device_challenge(&device.public_key_b64, &nonce, &signature_b64).is_err() {
                            continue;
                        }
                        authenticated = true;
                        if shared.devices.mark_seen(&device.device_id).is_err()
                            || send_server_info(&mut socket, &cipher, &shared).await.is_err()
                        {
                            return;
                        }
                    }
                    BridgeMessage::Rpc { id, method, params } => {
                        if !authenticated {
                            let _ = send_rpc_error(&mut socket, &cipher, id, "unauthorized", "Pair this device before using remote access").await;
                            continue;
                        }
                        let result = dispatch_rpc(&app, &shared.vault_root, &method, params).await;
                        if matches!(method.as_str(), "agent_run_once" | "agent_load_session") {
                            if let Ok(data) = &result {
                                if let Some(session_id) =
                                    data.get("sessionId").and_then(Value::as_str)
                                {
                                    agent_sessions.insert(session_id.to_string());
                                }
                            }
                        }
                        let response = match result {
                            Ok(data) => BridgeMessage::RpcResult { id, ok: true, data: Some(data), error: None },
                            Err(error) => BridgeMessage::RpcResult {
                                id,
                                ok: false,
                                data: None,
                                error: Some(RpcError { code: error.code().to_string(), message: error.to_string() }),
                            },
                        };
                        if send_encrypted(&mut socket, &cipher, &response).await.is_err() {
                            return;
                        }
                    }
                    _ => {}
                }
            }
            event = agent_events.receiver.recv() => {
                let Some(event) = event else { return; };
                if !agent_event_belongs_to_session(&event.payload, &agent_sessions) {
                    continue;
                }
                if send_encrypted(
                    &mut socket,
                    &cipher,
                    &BridgeMessage::Event {
                        name: event.name,
                        payload: event.payload,
                    },
                )
                .await
                .is_err()
                {
                    return;
                }
            }
        }
    }
}

fn agent_event_belongs_to_session(payload: &Value, sessions: &HashSet<String>) -> bool {
    payload
        .get("sessionId")
        .and_then(Value::as_str)
        .is_some_and(|session_id| sessions.contains(session_id))
}

fn begin_pairing(
    app: &AppHandle,
    shared: &Arc<HostShared>,
    request_id: String,
    device_id: String,
    device_name: String,
) -> Result<(PairingRequest, oneshot::Receiver<bool>), AppError> {
    if request_id.trim().is_empty() || device_id.trim().is_empty() || device_name.trim().is_empty()
    {
        return Err(AppError::message("Pairing request is incomplete"));
    }
    let verification_code = format!(
        "{:03}-{:03}",
        uuid::Uuid::new_v4().as_u128() % 1_000,
        (uuid::Uuid::new_v4().as_u128() / 1_000) % 1_000
    );
    let summary = PairingRequest {
        request_id: request_id.clone(),
        device_id,
        device_name,
        verification_code,
    };
    let (sender, receiver) = oneshot::channel();
    shared
        .pending
        .lock()
        .map_err(|_| AppError::message("Bridge pairing lock poisoned"))?
        .insert(
            request_id.clone(),
            PendingPairing {
                summary: summary.clone(),
                response: sender,
            },
        );
    let _ = app.emit("bridge:pair-request", summary.clone());
    Ok((summary, receiver))
}

async fn wait_for_pairing(
    shared: &Arc<HostShared>,
    request_id: &str,
    receiver: oneshot::Receiver<bool>,
) -> Result<bool, AppError> {
    match tokio::time::timeout(PAIRING_TIMEOUT, receiver).await {
        Ok(Ok(allowed)) => Ok(allowed),
        Ok(Err(_)) => Err(AppError::message("Pairing request was cancelled")),
        Err(_) => {
            let _ = shared
                .pending
                .lock()
                .map(|mut pending| pending.remove(request_id));
            Ok(false)
        }
    }
}

async fn send_server_info(
    socket: &mut super::RelaySocket,
    cipher: &SessionCipher,
    shared: &HostShared,
) -> Result<(), AppError> {
    let vault_name = shared
        .vault_root
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string);
    send_encrypted(
        socket,
        cipher,
        &BridgeMessage::ServerInfo {
            server_id: shared.identity.server_id.clone(),
            host_name: shared.host_name.clone(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            vault_name,
        },
    )
    .await
}

async fn send_rpc_error(
    socket: &mut super::RelaySocket,
    cipher: &SessionCipher,
    id: String,
    code: &str,
    message: &str,
) -> Result<(), AppError> {
    send_encrypted(
        socket,
        cipher,
        &BridgeMessage::RpcResult {
            id,
            ok: false,
            data: None,
            error: Some(RpcError {
                code: code.to_string(),
                message: message.to_string(),
            }),
        },
    )
    .await
}

async fn send_encrypted(
    socket: &mut super::RelaySocket,
    cipher: &SessionCipher,
    message: &BridgeMessage,
) -> Result<(), AppError> {
    let raw = serde_json::to_vec(message)?;
    send_binary(socket, cipher.encrypt(&raw)?).await
}

async fn dispatch_rpc(
    app: &AppHandle,
    vault_root: &Path,
    method: &str,
    params: Value,
) -> Result<Value, AppError> {
    if method.starts_with("agent_") {
        return dispatch_agent_rpc(app, vault_root, method, params).await;
    }
    match method {
        "vault_tree_build" => to_value(tree::build_tree(
            vault_root,
            &app.state::<crate::features::catalog::CapsCache>(),
        )),
        "paper_list" => to_value(papers::list_all(vault_root)?),
        "vault_search" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct SearchParams {
                query: String,
                #[serde(default)]
                limit: Option<usize>,
            }
            let args: SearchParams = serde_json::from_value(params)?;
            to_value(search::vault_search(VaultSearchArgs {
                vault_path: vault_root.to_string_lossy().into_owned(),
                query: args.query,
                limit: args.limit,
            })?)
        }
        "vault_read_text" => {
            let path = params
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::message("path is required"))?;
            let file = vault_relative_path(vault_root, path, false)?;
            to_value(fs::read_to_string(file)?)
        }
        "vault_write_text" => {
            let path = params
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::message("path is required"))?;
            let content = params
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::message("content is required"))?;
            let file = vault_relative_path(vault_root, path, true)?;
            fs::write(file, content)?;
            Ok(Value::Null)
        }
        "bridge_file_info" => {
            let path = required_bridge_path(&params)?;
            to_value(bridge_file_info(vault_root, path)?)
        }
        "bridge_paper_pdf_info" => {
            let paper_path = params
                .get("paperPath")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::message("paperPath is required"))?;
            to_value(bridge_paper_pdf_info(vault_root, paper_path)?)
        }
        "bridge_read_bytes" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Params {
                path: String,
                offset: u64,
                #[serde(default)]
                len: Option<usize>,
            }
            let args: Params = serde_json::from_value(params)?;
            let len = args.len.unwrap_or(MAX_BRIDGE_READ_BYTES);
            to_value(bridge_read_bytes(vault_root, &args.path, args.offset, len)?)
        }
        "paper_get" => {
            let path = params.get("path").and_then(Value::as_str);
            let id = params.get("id").and_then(Value::as_str);
            let record = match (path, id) {
                (Some(path), _) if !path.trim().is_empty() => {
                    papers::get_by_path(vault_root, path)?
                }
                (_, Some(id)) if !id.trim().is_empty() => papers::get_by_id(vault_root, id)?,
                _ => return Err(AppError::message("path or id is required")),
            }
            .ok_or_else(|| AppError::message("paper not found in catalog"))?;
            to_value(record)
        }
        "paper_set_is_read" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Params {
                path: String,
                is_read: bool,
            }
            let args: Params = serde_json::from_value(params)?;
            to_value(papers::set_is_read(vault_root, &args.path, args.is_read)?)
        }
        "paper_set_tags" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Params {
                path: String,
                tags: Vec<papers::PaperTag>,
            }
            let args: Params = serde_json::from_value(params)?;
            to_value(papers::set_tags(vault_root, &args.path, &args.tags)?)
        }
        _ => Err(AppError::message("Bridge RPC method is not allowed")),
    }
}

#[cfg(not(target_os = "ios"))]
async fn dispatch_agent_rpc(
    app: &AppHandle,
    vault_root: &Path,
    method: &str,
    params: Value,
) -> Result<Value, AppError> {
    let vault_path = Some(vault_root.to_string_lossy().into_owned());
    match method {
        "agent_list_agents" => api_result_data(
            crate::features::agent::commands::agent_list_agents(app.state::<AgentRegistry>()),
        ),
        "agent_scan_catalog" => api_result_data(
            crate::features::agent::commands::agent_scan_catalog(app.state::<AgentRegistry>()),
        ),
        "agent_ensure_catalog" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Params {
                template_id: String,
                #[serde(default)]
                set_default: bool,
            }
            let args: Params = serde_json::from_value(params)?;
            api_result_data(crate::features::agent::commands::agent_ensure_catalog(
                app.clone(),
                app.state::<AgentRegistry>(),
                args.template_id,
                args.set_default,
            ))
        }
        "agent_probe_catalog" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Params {
                template_id: String,
            }
            let args: Params = serde_json::from_value(params)?;
            let result = crate::features::agent::commands::agent_probe_catalog(
                app.clone(),
                app.state::<AgentRegistry>(),
                args.template_id,
            )
            .await
            .map_err(AppError::message)?;
            api_result_data(result)
        }
        "agent_run_once" => {
            let mut request: RunOnceRequest = serde_json::from_value(params)?;
            request.vault_path = vault_path;
            request.hide_from_chat_history = false;
            let window = app
                .get_webview_window("main")
                .or_else(|| app.webview_windows().into_values().next())
                .ok_or_else(|| AppError::message("No desktop window is available for Agent"))?;
            let result = crate::features::agent::commands::agent_run_once(
                window,
                app.state::<AgentRegistry>(),
                app.state::<AgentRunController>(),
                app.state::<PermissionGate>(),
                app.state::<crate::features::agent::ElicitationGate>(),
                app.state::<crate::features::agent::AskUserGate>(),
                app.state::<std::sync::Arc<RemoteRegistry>>(),
                request,
            )
            .await
            .map_err(AppError::message)?;
            api_result_data(result)
        }
        "agent_cancel_run" => {
            let session_id = required_string(&params, "sessionId")?;
            api_result_data(crate::features::agent::commands::agent_cancel_run(
                app.state::<AgentRunController>(),
                session_id,
            ))
        }
        "agent_respond_permission" => {
            let request: PermissionResponseRequest = serde_json::from_value(params)?;
            api_result_data(crate::features::agent::commands::agent_respond_permission(
                app.state::<PermissionGate>(),
                request,
            ))
        }
        "agent_respond_elicitation" => {
            let request: crate::features::agent::commands::ElicitationResponseRequest =
                serde_json::from_value(params)?;
            api_result_data(crate::features::agent::commands::agent_respond_elicitation(
                app.state::<crate::features::agent::ElicitationGate>(),
                request,
            ))
        }
        "agent_respond_ask_user" => {
            let request: crate::features::agent::commands::AskUserResponseRequest =
                serde_json::from_value(params)?;
            api_result_data(crate::features::agent::commands::agent_respond_ask_user(
                app.state::<crate::features::agent::AskUserGate>(),
                request,
            ))
        }
        "agent_list_sessions" => {
            let result = crate::features::agent::commands::agent_list_sessions(
                app.state::<AgentRegistry>(),
                app.state::<std::sync::Arc<RemoteRegistry>>(),
                app.state::<crate::features::agent::AgentWarmGate>(),
                optional_string(&params, "agentId"),
                vault_path,
                optional_string(&params, "cursor"),
            )
            .await
            .map_err(AppError::message)?;
            api_result_data(result)
        }
        "agent_load_session" => {
            let session_id = required_string(&params, "sessionId")?;
            let result = crate::features::agent::commands::agent_load_session(
                app.state::<AgentRegistry>(),
                app.state::<std::sync::Arc<RemoteRegistry>>(),
                optional_string(&params, "agentId"),
                session_id,
                vault_path,
            )
            .await
            .map_err(AppError::message)?;
            api_result_data(result)
        }
        _ => Err(AppError::message("Bridge Agent RPC method is not allowed")),
    }
}

#[cfg(target_os = "ios")]
async fn dispatch_agent_rpc(
    _app: &AppHandle,
    _vault_root: &Path,
    _method: &str,
    _params: Value,
) -> Result<Value, AppError> {
    Err(AppError::message(
        "Agent runs are available only from the paired desktop Host",
    ))
}

#[cfg(not(target_os = "ios"))]
fn api_result_data<T: Serialize>(result: ApiResult<T>) -> Result<Value, AppError> {
    if result.ok {
        return result
            .data
            .map(to_value)
            .transpose()?
            .ok_or_else(|| AppError::message("Agent RPC returned no data"));
    }
    Err(AppError::message(
        result
            .error
            .map(|error| error.message)
            .unwrap_or_else(|| "Agent RPC failed".to_string()),
    ))
}

#[cfg(not(target_os = "ios"))]
fn required_string(params: &Value, field: &str) -> Result<String, AppError> {
    params
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| AppError::message(format!("{field} is required")))
}

#[cfg(not(target_os = "ios"))]
fn optional_string(params: &Value, field: &str) -> Option<String> {
    params
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

fn to_value<T: Serialize>(value: T) -> Result<Value, AppError> {
    serde_json::to_value(value).map_err(AppError::from)
}

fn required_bridge_path(params: &Value) -> Result<&str, AppError> {
    params
        .get("path")
        .and_then(Value::as_str)
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| AppError::message("path is required"))
}

fn bridge_file_info(vault_root: &Path, path: &str) -> Result<BridgeFileInfo, AppError> {
    let file = vault_relative_path(vault_root, path, false)?;
    file_info(vault_root, &file)
}

fn bridge_paper_pdf_info(vault_root: &Path, paper_path: &str) -> Result<BridgeFileInfo, AppError> {
    let paper_dir = vault_relative_path(vault_root, paper_path, false)?;
    if !paper_dir.is_dir() {
        return Err(AppError::message(
            "paperPath must identify a paper directory",
        ));
    }
    let mut candidates = fs::read_dir(&paper_dir)?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
        })
        .collect::<Vec<_>>();
    candidates.sort();
    let file = candidates
        .into_iter()
        .next()
        .ok_or_else(|| AppError::message("paper has no local PDF"))?;
    file_info(vault_root, &file)
}

fn bridge_read_bytes(
    vault_root: &Path,
    path: &str,
    offset: u64,
    len: usize,
) -> Result<BridgeReadBytesResult, AppError> {
    if !(1..=MAX_BRIDGE_READ_BYTES).contains(&len) {
        return Err(AppError::message(format!(
            "len must be between 1 and {MAX_BRIDGE_READ_BYTES} bytes"
        )));
    }
    let file = vault_relative_path(vault_root, path, false)?;
    let info = file_info(vault_root, &file)?;
    if offset > info.size {
        return Err(AppError::message("offset exceeds file size"));
    }
    let remaining = info.size.saturating_sub(offset);
    let to_read = remaining.min(len as u64) as usize;
    let mut bytes = vec![0; to_read];
    let mut source = fs::File::open(file)?;
    source.seek(SeekFrom::Start(offset))?;
    source.read_exact(&mut bytes)?;
    Ok(BridgeReadBytesResult {
        file: info,
        offset,
        bytes_b64: URL_SAFE_NO_PAD.encode(bytes),
    })
}

fn file_info(vault_root: &Path, file: &Path) -> Result<BridgeFileInfo, AppError> {
    if !file.is_file() {
        return Err(AppError::message("Bridge path must identify a file"));
    }
    let root = vault_root.canonicalize()?;
    let rel = file
        .strip_prefix(root)
        .map_err(|_| AppError::message("Bridge path escapes the Vault"))?
        .to_string_lossy()
        .replace('\\', "/");
    let metadata = fs::metadata(file)?;
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default();
    let mut source = fs::File::open(file)?;
    let mut hasher = sha2::Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = source.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        sha2::Digest::update(&mut hasher, &buffer[..count]);
    }
    Ok(BridgeFileInfo {
        path: rel,
        size: metadata.len(),
        modified_at,
        sha256: hex::encode(sha2::Digest::finalize(hasher)),
    })
}

fn vault_relative_path(vault_root: &Path, value: &str, writing: bool) -> Result<PathBuf, AppError> {
    let relative = Path::new(value.trim());
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return Err(AppError::message("Bridge paths must be Vault-relative"));
    }
    let root = vault_root.canonicalize()?;
    let candidate = root.join(relative);
    let resolved = if writing {
        let parent = candidate
            .parent()
            .ok_or_else(|| AppError::message("Bridge path has no parent"))?;
        parent.canonicalize()?.join(
            candidate
                .file_name()
                .ok_or_else(|| AppError::message("Bridge path has no file name"))?,
        )
    } else {
        candidate.canonicalize()?
    };
    if !resolved.starts_with(&root) {
        return Err(AppError::message("Bridge path escapes the Vault"));
    }
    Ok(resolved)
}

fn decode_crypto_box_public_key(value: &str) -> Result<PublicKey, AppError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| AppError::message("E2EE public key is not valid base64url"))?;
    let bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|_| AppError::message("E2EE public key must contain 32 bytes"))?;
    Ok(PublicKey::from(bytes))
}

fn relay_endpoint_for_offer(endpoint: &RelayEndpoint) -> String {
    let url = endpoint.websocket_url();
    let host = url.host_str().unwrap_or_default();
    match url.port_or_known_default() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    }
}

fn set_online(app: &AppHandle, shared: &HostShared, online: bool) {
    if let Ok(mut state) = shared.state.lock() {
        state.online = online;
        if online {
            state.last_error = None;
        }
    }
    let _ = app.emit("bridge:host-status", online);
}

fn set_error(app: &AppHandle, shared: &HostShared, error: String) {
    if let Ok(mut state) = shared.state.lock() {
        state.online = false;
        state.last_error = Some(error);
    }
    let _ = app.emit("bridge:host-status", false);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rpc_path_rejects_parent_directory_escape() {
        let vault =
            std::env::temp_dir().join(format!("agentero-bridge-rpc-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&vault).expect("create vault");
        assert!(vault_relative_path(&vault, "../secrets.txt", false).is_err());
        fs::remove_dir_all(vault).expect("clean vault");
    }

    #[test]
    fn relay_offer_keeps_the_explicit_secure_port() {
        let endpoint = RelayEndpoint::parse("relay.philfan.cn:443").expect("parse endpoint");
        assert_eq!(relay_endpoint_for_offer(&endpoint), "relay.philfan.cn:443");
    }

    #[test]
    fn bridge_pdf_reads_vault_relative_chunks_with_metadata() {
        let vault =
            std::env::temp_dir().join(format!("agentero-bridge-pdf-{}", uuid::Uuid::new_v4()));
        let paper_dir = vault.join("papers/example");
        fs::create_dir_all(&paper_dir).expect("create paper dir");
        fs::write(paper_dir.join("source.pdf"), b"%PDF-1.7 bridge test")
            .expect("write fixture PDF");

        let info = bridge_paper_pdf_info(&vault, "papers/example").expect("discover PDF");
        assert_eq!(info.path, "papers/example/source.pdf");
        assert_eq!(info.size, 20);
        assert!(!info.sha256.is_empty());

        let chunk = bridge_read_bytes(&vault, &info.path, 5, 4).expect("read PDF chunk");
        assert_eq!(chunk.file.path, info.path);
        assert_eq!(chunk.offset, 5);
        assert_eq!(
            URL_SAFE_NO_PAD
                .decode(chunk.bytes_b64)
                .expect("decode chunk"),
            b"1.7 "
        );
        assert!(bridge_read_bytes(&vault, "../source.pdf", 0, 1).is_err());
        assert!(bridge_read_bytes(&vault, &info.path, 0, MAX_BRIDGE_READ_BYTES + 1).is_err());

        fs::remove_dir_all(vault).expect("clean vault");
    }

    #[test]
    fn agent_events_only_forward_for_the_requesting_session() {
        let sessions = HashSet::from(["session_remote".to_string()]);
        assert!(agent_event_belongs_to_session(
            &serde_json::json!({"sessionId": "session_remote"}),
            &sessions,
        ));
        assert!(!agent_event_belongs_to_session(
            &serde_json::json!({"sessionId": "session_other"}),
            &sessions,
        ));
        assert!(!agent_event_belongs_to_session(
            &serde_json::json!({}),
            &sessions
        ));
    }
}
