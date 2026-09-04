use super::{
    connect_relay, next_frame, send_binary, send_text, BridgeClientIdentity,
    BridgeClientIdentityStore, BridgeClientProfile, BridgeClientProfileStore, BridgeMessage,
    BridgeOffer, E2eeHandshake, RelayEndpoint, RelayFrame, SessionCipher,
};
use crate::core::error::AppError;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use crypto_box::{PublicKey, SecretKey};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot, watch};

const RECONNECT_DELAY: Duration = Duration::from_secs(2);
const FRAME_POLL_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeClientStatus {
    pub connected: bool,
    pub paired: bool,
    pub server_id: Option<String>,
    pub host_name: Option<String>,
    pub relay_endpoint: Option<String>,
    pub vault_name: Option<String>,
    pub last_error: Option<String>,
}

impl BridgeClientStatus {
    fn disconnected() -> Self {
        Self {
            connected: false,
            paired: false,
            server_id: None,
            host_name: None,
            relay_endpoint: None,
            vault_name: None,
            last_error: None,
        }
    }
}

pub struct BridgeClientController {
    runtime: Mutex<Option<ClientRuntime>>,
}

struct ClientRuntime {
    status: Arc<Mutex<BridgeClientStatus>>,
    commands: mpsc::Sender<ClientCommand>,
    stop: watch::Sender<bool>,
}

enum ClientCommand {
    Rpc {
        id: String,
        method: String,
        params: Value,
        response: oneshot::Sender<Result<Value, AppError>>,
    },
}

impl BridgeClientController {
    pub fn new() -> Self {
        Self {
            runtime: Mutex::new(None),
        }
    }

    pub fn connect(
        &self,
        app: AppHandle,
        offer_url: String,
        device_name: String,
    ) -> Result<BridgeClientStatus, AppError> {
        let device_name = device_name.trim().to_string();
        if device_name.is_empty() {
            return Err(AppError::message("device name is required"));
        }
        let profile = BridgeClientProfile {
            offer_url,
            device_name,
            paired: false,
        };
        BridgeClientProfileStore::at_default_path().save(&profile)?;
        self.start_profile(app, profile)
    }

    pub fn resume(&self, app: AppHandle) -> Result<BridgeClientStatus, AppError> {
        let Some(profile) = BridgeClientProfileStore::at_default_path().load()? else {
            return Ok(BridgeClientStatus::disconnected());
        };
        if !profile.paired {
            return Ok(BridgeClientStatus::disconnected());
        }
        self.start_profile(app, profile)
    }

    fn start_profile(
        &self,
        app: AppHandle,
        profile: BridgeClientProfile,
    ) -> Result<BridgeClientStatus, AppError> {
        let offer = BridgeOffer::from_pair_url(&profile.offer_url)?;
        let identity = BridgeClientIdentityStore::at_default_path().load_or_create()?;
        self.disconnect()?;

        let status = Arc::new(Mutex::new(BridgeClientStatus {
            connected: false,
            paired: profile.paired,
            server_id: Some(offer.server_id.clone()),
            host_name: Some(offer.host_name.clone()),
            relay_endpoint: Some(offer.relay.endpoint.clone()),
            vault_name: None,
            last_error: None,
        }));
        let (command_tx, command_rx) = mpsc::channel(64);
        let (stop, stop_rx) = watch::channel(false);
        *self
            .runtime
            .lock()
            .map_err(|_| AppError::message("Bridge client lock poisoned"))? = Some(ClientRuntime {
            status: Arc::clone(&status),
            commands: command_tx,
            stop,
        });
        tauri::async_runtime::spawn(run_client_loop(
            app,
            offer,
            identity,
            profile.device_name,
            Arc::clone(&status),
            command_rx,
            stop_rx,
        ));
        status_snapshot(&status)
    }

    pub fn disconnect(&self) -> Result<(), AppError> {
        let runtime = self
            .runtime
            .lock()
            .map_err(|_| AppError::message("Bridge client lock poisoned"))?
            .take();
        if let Some(runtime) = runtime {
            let _ = runtime.stop.send(true);
        }
        Ok(())
    }

    pub fn status(&self) -> Result<BridgeClientStatus, AppError> {
        let guard = self
            .runtime
            .lock()
            .map_err(|_| AppError::message("Bridge client lock poisoned"))?;
        guard
            .as_ref()
            .map(|runtime| status_snapshot(&runtime.status))
            .transpose()?
            .map_or_else(|| Ok(BridgeClientStatus::disconnected()), Ok)
    }

    pub async fn rpc(&self, method: String, params: Value) -> Result<Value, AppError> {
        let commands = self
            .runtime
            .lock()
            .map_err(|_| AppError::message("Bridge client lock poisoned"))?
            .as_ref()
            .map(|runtime| runtime.commands.clone())
            .ok_or_else(|| AppError::message("No desktop connection"))?;
        let (sender, receiver) = oneshot::channel();
        commands
            .send(ClientCommand::Rpc {
                id: format!("req_{}", uuid::Uuid::new_v4().simple()),
                method,
                params,
                response: sender,
            })
            .await
            .map_err(|_| AppError::message("Bridge connection is offline"))?;
        receiver
            .await
            .map_err(|_| AppError::message("Bridge request was cancelled"))?
    }
}

impl Default for BridgeClientController {
    fn default() -> Self {
        Self::new()
    }
}

async fn run_client_loop(
    app: AppHandle,
    offer: BridgeOffer,
    identity: BridgeClientIdentity,
    device_name: String,
    status: Arc<Mutex<BridgeClientStatus>>,
    mut commands: mpsc::Receiver<ClientCommand>,
    mut stop: watch::Receiver<bool>,
) {
    let endpoint = match RelayEndpoint::parse(&offer.relay.endpoint) {
        Ok(endpoint) => endpoint,
        Err(error) => {
            set_error(&app, &status, error.to_string());
            return;
        }
    };
    loop {
        if *stop.borrow() {
            return;
        }
        let url = match endpoint.connection_url(&offer.server_id, "client", None) {
            Ok(url) => url,
            Err(error) => {
                set_error(&app, &status, error.to_string());
                return;
            }
        };
        emit_progress(&app, "relayConnecting");
        match connect_relay(url).await {
            Ok(mut socket) => {
                emit_progress(&app, "e2eeHandshake");
                if let Err(error) = run_client_session(
                    &app,
                    &mut socket,
                    &offer,
                    &identity,
                    &device_name,
                    &status,
                    &BridgeClientProfileStore::at_default_path(),
                    &mut commands,
                    &mut stop,
                )
                .await
                {
                    set_error(&app, &status, error.to_string());
                }
            }
            Err(error) => set_error(&app, &status, error.to_string()),
        }
        set_connected(&app, &status, false);
        tokio::select! {
            _ = tokio::time::sleep(RECONNECT_DELAY) => {}
            changed = stop.changed() => if changed.is_err() || *stop.borrow() { return; },
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_client_session(
    app: &AppHandle,
    socket: &mut super::RelaySocket,
    offer: &BridgeOffer,
    identity: &BridgeClientIdentity,
    device_name: &str,
    status: &Arc<Mutex<BridgeClientStatus>>,
    profile_store: &BridgeClientProfileStore,
    commands: &mut mpsc::Receiver<ClientCommand>,
    stop: &mut watch::Receiver<bool>,
) -> Result<(), AppError> {
    let host_public = decode_public_key(&offer.host_public_key_b64)?;
    let ephemeral = SecretKey::generate(&mut crypto_box::aead::OsRng);
    send_text(
        socket,
        serde_json::to_string(&E2eeHandshake::E2eeHello {
            key: URL_SAFE_NO_PAD.encode(ephemeral.public_key().as_bytes()),
        })?,
    )
    .await?;
    let RelayFrame::Text(payload) = next_frame(socket).await? else {
        return Err(AppError::message("Relay closed during E2EE handshake"));
    };
    if serde_json::from_str::<E2eeHandshake>(&payload)? != E2eeHandshake::E2eeReady {
        return Err(AppError::message("Desktop rejected E2EE handshake"));
    }
    let cipher = SessionCipher::from_keys(&ephemeral, &host_public);
    let initial = if status_snapshot(status)?.paired {
        emit_progress(app, "authenticating");
        BridgeMessage::Hello {
            device_id: identity.device_id.clone(),
            protocol_version: 1,
            app_version: env!("CARGO_PKG_VERSION").to_string(),
        }
    } else {
        emit_progress(app, "pairing");
        BridgeMessage::PairRequest {
            request_id: format!("pair_{}", uuid::Uuid::new_v4().simple()),
            device_id: identity.device_id.clone(),
            device_name: device_name.to_string(),
            device_public_key_b64: identity.public_key_b64.clone(),
        }
    };
    send_encrypted(socket, &cipher, &initial).await?;
    set_connected(app, status, true);
    emit_progress(app, "connected");
    let mut pending = HashMap::new();

    loop {
        if *stop.borrow() {
            fail_pending(&mut pending, "Bridge connection was closed");
            return Ok(());
        }
        while let Ok(command) = commands.try_recv() {
            let ClientCommand::Rpc {
                id,
                method,
                params,
                response,
            } = command;
            if !status_snapshot(status)?.paired {
                let _ = response.send(Err(AppError::message(
                    "Pair this device before using remote access",
                )));
                continue;
            }
            if let Err(error) = send_encrypted(
                socket,
                &cipher,
                &BridgeMessage::Rpc {
                    id: id.clone(),
                    method,
                    params,
                },
            )
            .await
            {
                let _ = response.send(Err(error));
                continue;
            }
            pending.insert(id, response);
        }
        match tokio::time::timeout(FRAME_POLL_INTERVAL, next_frame(socket)).await {
            Err(_) => continue,
            Ok(Err(error)) => {
                fail_pending(&mut pending, &error.to_string());
                return Err(error);
            }
            Ok(Ok(RelayFrame::Close)) => {
                fail_pending(&mut pending, "Desktop connection was closed");
                return Ok(());
            }
            Ok(Ok(RelayFrame::Text(_))) => continue,
            Ok(Ok(RelayFrame::Binary(frame))) => {
                let message = serde_json::from_slice(&cipher.decrypt(&frame)?)?;
                if let BridgeMessage::DeviceChallenge { nonce_b64 } = message {
                    let nonce = URL_SAFE_NO_PAD.decode(nonce_b64).map_err(|_| {
                        AppError::message("Bridge challenge is not valid base64url")
                    })?;
                    send_encrypted(
                        socket,
                        &cipher,
                        &BridgeMessage::DeviceProof {
                            signature_b64: identity.sign_challenge(&nonce)?,
                        },
                    )
                    .await?;
                } else {
                    handle_message(app, status, &mut pending, profile_store, message)?;
                }
            }
        }
    }
}

fn handle_message(
    app: &AppHandle,
    status: &Arc<Mutex<BridgeClientStatus>>,
    pending: &mut HashMap<String, oneshot::Sender<Result<Value, AppError>>>,
    profile_store: &BridgeClientProfileStore,
    message: BridgeMessage,
) -> Result<(), AppError> {
    match message {
        BridgeMessage::PairPending {
            request_id,
            verification_code,
        } => {
            let _ = app.emit(
                "bridge:pair-pending",
                serde_json::json!({"requestId": request_id, "verificationCode": verification_code}),
            );
        }
        BridgeMessage::PairOk { .. } => {
            profile_store.mark_paired()?;
            let mut current = status
                .lock()
                .map_err(|_| AppError::message("Bridge client status lock poisoned"))?;
            current.paired = true;
            current.last_error = None;
            let _ = app.emit("bridge:status", current.clone());
        }
        BridgeMessage::PairDenied { reason, .. } => set_error(app, status, reason),
        BridgeMessage::ServerInfo { vault_name, .. } => {
            let mut current = status
                .lock()
                .map_err(|_| AppError::message("Bridge client status lock poisoned"))?;
            current.vault_name = vault_name;
            let _ = app.emit("bridge:status", current.clone());
        }
        BridgeMessage::RpcResult {
            id,
            ok,
            data,
            error,
        } => {
            if let Some(sender) = pending.remove(&id) {
                let result = if ok {
                    Ok(data.unwrap_or(Value::Null))
                } else {
                    Err(AppError::message(
                        error
                            .map(|error| error.message)
                            .unwrap_or_else(|| "Bridge RPC failed".to_string()),
                    ))
                };
                let _ = sender.send(result);
            }
        }
        BridgeMessage::Event { name, payload } => {
            let event = format!("bridge:event:{name}");
            let _ = app.emit(&event, payload);
        }
        _ => {}
    }
    Ok(())
}

async fn send_encrypted(
    socket: &mut super::RelaySocket,
    cipher: &SessionCipher,
    message: &BridgeMessage,
) -> Result<(), AppError> {
    send_binary(socket, cipher.encrypt(&serde_json::to_vec(message)?)?).await
}

fn decode_public_key(value: &str) -> Result<PublicKey, AppError> {
    let bytes: [u8; 32] = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| AppError::message("E2EE public key is not valid base64url"))?
        .try_into()
        .map_err(|_| AppError::message("E2EE public key must contain 32 bytes"))?;
    Ok(PublicKey::from(bytes))
}

fn status_snapshot(
    status: &Arc<Mutex<BridgeClientStatus>>,
) -> Result<BridgeClientStatus, AppError> {
    status
        .lock()
        .map(|status| status.clone())
        .map_err(|_| AppError::message("Bridge client status lock poisoned"))
}

fn set_connected(app: &AppHandle, status: &Arc<Mutex<BridgeClientStatus>>, connected: bool) {
    if let Ok(mut current) = status.lock() {
        current.connected = connected;
        if connected {
            current.last_error = None;
        }
        let _ = app.emit("bridge:status", current.clone());
    }
}

fn emit_progress(app: &AppHandle, phase: &str) {
    let _ = app.emit("bridge:progress", phase);
}

fn set_error(app: &AppHandle, status: &Arc<Mutex<BridgeClientStatus>>, error: String) {
    if let Ok(mut current) = status.lock() {
        current.connected = false;
        current.last_error = Some(error);
        let _ = app.emit("bridge:status", current.clone());
    }
}

fn fail_pending(
    pending: &mut HashMap<String, oneshot::Sender<Result<Value, AppError>>>,
    message: &str,
) {
    for (_, sender) in pending.drain() {
        let _ = sender.send(Err(AppError::message(message)));
    }
}
