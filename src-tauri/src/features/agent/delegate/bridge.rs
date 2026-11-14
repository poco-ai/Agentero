//! Unix socket the `agentero-delegate` MCP worker calls back into.
//!
//! The worker is a child of the local CLI agent, so it cannot see
//! [`RemoteAgentHosts`]. It presents the token from its grant file. The desktop
//! process owns the SSH session and the remote ACP connection.

use agent_client_protocol::schema::v1::McpServer;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[cfg(any(unix, test))]
use super::policy;
#[cfg(unix)]
use super::policy::{AgentChoice, TargetChoice};
#[cfg(unix)]
use super::protocol::{
    AgentInfo, DelegateGrant, RunBody, TargetInfo, TargetsBody, WireRequest, WireResponse,
    WORKER_ARG,
};
#[cfg(unix)]
use crate::features::agent::acp::interaction::PermissionPolicy;
#[cfg(unix)]
use crate::features::agent::models::{is_builtin_template, AgentResultPayload};
#[cfg(unix)]
use crate::features::agent::remote_host::RemoteAgentHosts;
#[cfg(unix)]
use crate::features::agent::runtime::events::AgentEventEmitter;
#[cfg(unix)]
use crate::features::agent::runtime::gates::{AskUserGate, ElicitationGate, PermissionGate};
#[cfg(unix)]
use crate::features::agent::session::{
    serve_delegate_prompts, DelegatePrompt, DelegateUserWait, RunOnceParams,
};
#[cfg(unix)]
use crate::features::agent::AgentRegistry;
#[cfg(unix)]
use agent_client_protocol::schema::v1::McpServerStdio;
#[cfg(any(unix, test))]
use std::collections::HashMap;
#[cfg(unix)]
use std::sync::atomic::Ordering;
#[cfg(unix)]
use std::sync::Mutex as StdMutex;
#[cfg(unix)]
use tauri::Manager;
#[cfg(unix)]
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
#[cfg(unix)]
use tokio::net::{UnixListener, UnixStream};
#[cfg(unix)]
use tokio::sync::{mpsc, oneshot, watch, Mutex};

#[cfg(unix)]
const MAX_LINE: usize = 2_000_000;

#[cfg(unix)]
struct RunRecord {
    target: String,
    agent_id: String,
    destination: String,
    status: Mutex<String>,
    text: Arc<std::sync::Mutex<String>>,
    error: Mutex<Option<String>>,
    cancel: watch::Sender<bool>,
    user_wait: Arc<DelegateUserWait>,
}

#[cfg(unix)]
struct Slot {
    tx: Option<mpsc::Sender<DelegatePrompt>>,
    in_flight: Option<String>,
}

#[cfg(unix)]
enum Claim {
    Busy(String),
    Enqueue(mpsc::Sender<DelegatePrompt>),
    Start,
}

#[cfg(unix)]
struct ClaimLaunch<'a> {
    key: &'a (String, String),
    target: &'a TargetChoice,
    agent: &'a AgentChoice,
    window: &'a str,
    user_wait: Arc<DelegateUserWait>,
}

#[cfg(unix)]
struct Hub {
    app: tauri::AppHandle,
    runs: Mutex<HashMap<String, Arc<RunRecord>>>,
    slots: Mutex<HashMap<(String, String), Slot>>,
}

#[cfg(unix)]
impl Hub {
    fn new(app: tauri::AppHandle) -> Arc<Self> {
        Arc::new(Self {
            app,
            runs: Mutex::new(HashMap::new()),
            slots: Mutex::new(HashMap::new()),
        })
    }

    async fn targets(&self) -> Result<TargetsBody, String> {
        let targets = connected_targets(&self.app).await?;
        let agents = agent_choices(&self.app).await?;
        let listed = agents
            .iter()
            .map(|agent| AgentInfo {
                id: agent.id.clone(),
                name: agent.name.clone(),
            })
            .collect::<Vec<_>>();
        Ok(TargetsBody {
            targets: targets
                .into_iter()
                .map(|target| TargetInfo {
                    target: target.handle.clone(),
                    destination: policy::target_host(&target),
                    remote_path: target.remote_path,
                    local_sim: target.local_sim,
                    agents: listed.clone(),
                })
                .collect(),
        })
    }

    async fn delegate(
        self: &Arc<Self>,
        window: &str,
        target: Option<String>,
        agent_id: Option<String>,
        prompt: String,
        wait_ms: Option<u64>,
        caller_gone: CancellationToken,
    ) -> Result<RunBody, String> {
        let prompt = prompt.trim().to_string();
        if prompt.is_empty() {
            return Err("prompt is required".into());
        }
        let targets = connected_targets(&self.app).await?;
        let target = policy::resolve_target(target.as_deref(), &targets)?.clone();
        let agents = agent_choices(&self.app).await?;
        let agent = policy::resolve_agent(agent_id.as_deref(), &agents)?.clone();
        let wait = policy::clamp_wait(wait_ms);
        let key = (target.session_id.clone(), agent.id.clone());
        let run_id = uuid::Uuid::new_v4().to_string();
        let claim = self.claim(&key, &run_id).await;
        let Claim::Busy(existing) = &claim else {
            let text = Arc::new(std::sync::Mutex::new(String::new()));
            let (cancel_tx, cancel_rx) = watch::channel(false);
            let user_wait = Arc::new(DelegateUserWait {
                waiting: std::sync::atomic::AtomicBool::new(false),
                request_id: std::sync::Mutex::new(None),
            });
            let record = Arc::new(RunRecord {
                target: target.handle.clone(),
                agent_id: agent.id.clone(),
                destination: policy::target_host(&target),
                status: Mutex::new("running".into()),
                text: text.clone(),
                error: Mutex::new(None),
                cancel: cancel_tx,
                user_wait: user_wait.clone(),
            });
            self.runs
                .lock()
                .await
                .insert(run_id.clone(), record.clone());
            let (reply_tx, reply_rx) = oneshot::channel();
            let turn = DelegatePrompt {
                run_id: run_id.clone(),
                prompt: policy::remote_task_prompt(
                    &policy::target_host(&target),
                    &target.remote_path,
                    &prompt,
                ),
                cancellation: cancel_rx,
                progress: text,
                reply: reply_tx,
            };
            if let Err(error) = self
                .dispatch_claim(
                    claim,
                    ClaimLaunch {
                        key: &key,
                        target: &target,
                        agent: &agent,
                        window,
                        user_wait,
                    },
                    turn,
                )
                .await
            {
                finish_record(&record, Err(error.clone())).await;
                self.release(&key, &run_id).await;
                return Err(error);
            }
            let hub = Arc::clone(self);
            let run_for_wait = run_id.clone();
            let key_for_wait = key.clone();
            let record_for_wait = record.clone();
            let (done_tx, done_rx) = oneshot::channel();
            tokio::spawn(async move {
                let outcome = reply_rx
                    .await
                    .unwrap_or_else(|_| Err("remote agent connection closed".into()));
                finish_record(&record_for_wait, outcome).await;
                hub.clear_in_flight(&key_for_wait, &run_for_wait).await;
                let _ = done_tx.send(());
            });
            return tokio::select! {
                _ = done_rx => self.view(&run_id).await,
                _ = tokio::time::sleep(wait) => {
                    self.fail_if_waiting_for_permission(&record).await;
                    self.view(&run_id).await
                }
                _ = caller_gone.cancelled() => {
                    let _ = record.cancel.send(true);
                    if record.status.lock().await.as_str() == "running" {
                        *record.status.lock().await = "cancelled".to_string();
                    }
                    self.view(&run_id).await
                }
            };
        };
        let mut view = self.view(existing).await?;
        view.note = Some("already running".into());
        Ok(view)
    }

    async fn result(&self, run_id: &str) -> Result<RunBody, String> {
        self.view(run_id).await
    }

    async fn cancel(&self, run_id: &str) -> Result<RunBody, String> {
        let record = self
            .runs
            .lock()
            .await
            .get(run_id)
            .cloned()
            .ok_or_else(|| format!("unknown delegate run: {run_id}"))?;
        let _ = record.cancel.send(true);
        if record.status.lock().await.as_str() == "running" {
            *record.status.lock().await = "cancelled".to_string();
        }
        self.view(run_id).await
    }

    fn shutdown(&self) {
        if let Ok(runs) = self.runs.try_lock() {
            for record in runs.values() {
                let _ = record.cancel.send(true);
            }
        }
        if let Ok(mut slots) = self.slots.try_lock() {
            slots.clear();
        }
    }

    async fn claim(&self, key: &(String, String), run_id: &str) -> Claim {
        let mut slots = self.slots.lock().await;
        if let Some(slot) = slots.get_mut(key) {
            if let Some(existing) = slot.in_flight.clone() {
                return Claim::Busy(existing);
            }
            slot.in_flight = Some(run_id.to_string());
            if let Some(tx) = slot.tx.clone() {
                return Claim::Enqueue(tx);
            }
            return Claim::Start;
        }
        slots.insert(
            key.clone(),
            Slot {
                tx: None,
                in_flight: Some(run_id.to_string()),
            },
        );
        Claim::Start
    }

    async fn dispatch_claim(
        self: &Arc<Self>,
        claim: Claim,
        launch: ClaimLaunch<'_>,
        turn: DelegatePrompt,
    ) -> Result<(), String> {
        match claim {
            Claim::Busy(_) => {
                Err("a delegated turn is already running on this remote agent".into())
            }
            Claim::Enqueue(tx) => match tx.try_send(turn) {
                Ok(()) => Ok(()),
                Err(mpsc::error::TrySendError::Full(_)) => {
                    Err("a delegated turn is already running on this remote agent".into())
                }
                Err(mpsc::error::TrySendError::Closed(turn)) => {
                    self.slots.lock().await.remove(launch.key);
                    self.slots.lock().await.insert(
                        launch.key.clone(),
                        Slot {
                            tx: None,
                            in_flight: Some(turn.run_id.clone()),
                        },
                    );
                    self.open_connection(launch, turn).await
                }
            },
            Claim::Start => self.open_connection(launch, turn).await,
        }
    }

    async fn open_connection(
        self: &Arc<Self>,
        launch: ClaimLaunch<'_>,
        turn: DelegatePrompt,
    ) -> Result<(), String> {
        let run_id = turn.run_id.clone();
        let params = base_params(
            &self.app,
            launch.target,
            launch.agent,
            launch.window,
            launch.user_wait,
        )
        .await?;
        let (tx, rx) = mpsc::channel(1);
        tx.try_send(turn)
            .map_err(|_| "delegate connection did not accept the task".to_string())?;
        tokio::spawn(serve_delegate_prompts(params, rx));
        let mut slots = self.slots.lock().await;
        if let Some(slot) = slots.get_mut(launch.key) {
            slot.tx = Some(tx);
            slot.in_flight = Some(run_id);
        } else {
            slots.insert(
                launch.key.clone(),
                Slot {
                    tx: Some(tx),
                    in_flight: Some(run_id),
                },
            );
        }
        Ok(())
    }

    async fn release(&self, key: &(String, String), run_id: &str) {
        let mut slots = self.slots.lock().await;
        let Some(slot) = slots.get_mut(key) else {
            return;
        };
        if slot.in_flight.as_deref() != Some(run_id) {
            return;
        }
        if slot.tx.is_none() {
            slots.remove(key);
        } else {
            slot.in_flight = None;
        }
    }

    async fn fail_if_waiting_for_permission(&self, record: &RunRecord) {
        if !record.user_wait.waiting.load(Ordering::SeqCst) {
            return;
        }
        let request_id = record
            .user_wait
            .request_id
            .lock()
            .ok()
            .and_then(|mut id| id.take());
        if let Some(request_id) = request_id {
            let _ = self
                .app
                .state::<PermissionGate>()
                .resolve(&request_id, None);
        }
        let _ = record.cancel.send(true);
        *record.error.lock().await =
            Some("the remote agent is waiting for permission and the wait limit elapsed".into());
        let mut status = record.status.lock().await;
        if status.as_str() == "running" {
            *status = "failed".to_string();
        }
    }

    async fn clear_in_flight(&self, key: &(String, String), run_id: &str) {
        if let Some(slot) = self.slots.lock().await.get_mut(key) {
            if slot.in_flight.as_deref() == Some(run_id) {
                slot.in_flight = None;
            }
        }
    }

    async fn view(&self, run_id: &str) -> Result<RunBody, String> {
        let record = self
            .runs
            .lock()
            .await
            .get(run_id)
            .cloned()
            .ok_or_else(|| format!("unknown delegate run: {run_id}"))?;
        let status = record.status.lock().await.clone();
        let text = record
            .text
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone();
        let error = record.error.lock().await.clone();
        Ok(RunBody {
            run_id: run_id.to_string(),
            target: record.target.clone(),
            agent_id: record.agent_id.clone(),
            destination: record.destination.clone(),
            status,
            text,
            error,
            note: None,
        })
    }
}

#[cfg(unix)]
async fn finish_record(record: &RunRecord, outcome: Result<AgentResultPayload, String>) {
    match outcome {
        Ok(payload) => {
            if !payload.content.is_empty() {
                *record.text.lock().unwrap_or_else(|err| err.into_inner()) = payload.content;
            }
            let status = if payload.stop_reason.as_deref() == Some("cancelled") {
                "cancelled"
            } else {
                "completed"
            };
            // A caller that already marked the run cancelled wins over a late completed.
            let mut current = record.status.lock().await;
            if current.as_str() != "cancelled" && current.as_str() != "failed" {
                *current = status.to_string();
            }
        }
        Err(error) => {
            *record.error.lock().await = Some(error);
            let mut current = record.status.lock().await;
            if current.as_str() == "running" {
                *current = "failed".to_string();
            }
        }
    }
}

#[cfg(unix)]
async fn connected_targets(app: &tauri::AppHandle) -> Result<Vec<TargetChoice>, String> {
    let hosts = app.state::<Arc<dyn RemoteAgentHosts>>();
    let listed = hosts
        .list_targets()
        .await
        .map_err(|error| error.to_string())?;
    Ok(listed
        .into_iter()
        .map(|target| TargetChoice {
            handle: format!("remote:{}", target.session_id),
            session_id: target.session_id,
            destination: target.destination,
            remote_path: target.remote_path,
            local_sim: target.local_sim,
        })
        .collect())
}

#[cfg(unix)]
async fn agent_choices(app: &tauri::AppHandle) -> Result<Vec<AgentChoice>, String> {
    let registry = app.state::<AgentRegistry>();
    let state = registry.snapshot().map_err(|error| error.to_string())?;
    let mut agents: Vec<AgentChoice> = state
        .agents
        .into_iter()
        .filter(|agent| !is_builtin_template(&agent.template) && !agent.command.trim().is_empty())
        .map(|agent| AgentChoice {
            id: agent.id,
            name: agent.name,
        })
        .collect();
    agents.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(agents)
}

#[cfg(unix)]
async fn base_params(
    app: &tauri::AppHandle,
    target: &TargetChoice,
    agent: &AgentChoice,
    window: &str,
    user_wait: Arc<DelegateUserWait>,
) -> Result<RunOnceParams, String> {
    let registry = app.state::<AgentRegistry>();
    let desc = registry.get(&agent.id).map_err(|error| error.to_string())?;
    if is_builtin_template(&desc.template) {
        return Err("built-in agents cannot run on a remote host".into());
    }
    let hosts = app.state::<Arc<dyn RemoteAgentHosts>>();
    let remote = hosts
        .get_session(&target.session_id)
        .await
        .map_err(|error| error.to_string())?;
    let (_, cancel_rx) = watch::channel(false);
    Ok(RunOnceParams {
        app: AgentEventEmitter::new(app.clone(), window),
        desc,
        session_id: String::new(),
        message_id: String::new(),
        prompt: String::new(),
        is_acp_command: true,
        images: Vec::new(),
        workflow: None,
        target: None,
        vault_path: Some(format!("remote:{}", target.session_id)),
        preferred_model_id: None,
        force_model: false,
        preferred_collaboration_mode_id: None,
        preferred_reasoning_effort: None,
        prefer_highest_reasoning_effort: false,
        fast_mode: None,
        skill_ids: Vec::new(),
        permission_policy: PermissionPolicy::Ask,
        permission_gate: app.state::<PermissionGate>().inner().clone(),
        elicitation_gate: app.state::<ElicitationGate>().inner().clone(),
        ask_user_gate: app.state::<AskUserGate>().inner().clone(),
        response_language: None,
        personal_prompt: None,
        cancellation: cancel_rx,
        remote: Some(remote),
        resume_session_id: None,
        warm_pool: None,
        context: None,
        resume_transcript: None,
        delegate_mcp: Vec::new(),
        delegate_hint: None,
        suppress_transcript: true,
        permission_host: Some(policy::target_host(target)),
        progress: None,
        user_wait: Some(user_wait),
    })
}

/// Desktop side of the delegate socket.
pub struct DelegateBridge {
    path: std::path::PathBuf,
    #[cfg(unix)]
    tokens: StdMutex<HashMap<String, String>>,
    #[cfg(unix)]
    hub: StdMutex<Option<Arc<Hub>>>,
    shutdown: CancellationToken,
}

impl DelegateBridge {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            path: socket_path(),
            #[cfg(unix)]
            tokens: StdMutex::new(HashMap::new()),
            #[cfg(unix)]
            hub: StdMutex::new(None),
            shutdown: CancellationToken::new(),
        })
    }

    pub fn start(self: &Arc<Self>, app: tauri::AppHandle) {
        #[cfg(unix)]
        {
            let hub = Hub::new(app);
            if let Ok(mut slot) = self.hub.lock() {
                *slot = Some(hub.clone());
            }
            let bridge = Arc::clone(self);
            tauri::async_runtime::spawn(async move {
                if let Err(error) = bridge.listen(hub).await {
                    log::warn!(target: "agentero::agent", "delegate socket stopped: {error}");
                }
            });
        }
        #[cfg(not(unix))]
        {
            let _ = app;
        }
    }

    pub fn shutdown(&self) {
        self.shutdown.cancel();
        #[cfg(unix)]
        {
            if let Ok(hub) = self.hub.lock() {
                if let Some(hub) = hub.as_ref() {
                    hub.shutdown();
                }
            }
        }
        let _ = std::fs::remove_file(&self.path);
    }

    /// Grant a local ACP session the delegate tools. `None` when the socket
    /// is not running (Windows, or start failed).
    pub fn mcp_server(&self, session_id: &str, window_label: &str) -> Option<McpServer> {
        #[cfg(not(unix))]
        {
            let _ = (session_id, window_label);
            None
        }
        #[cfg(unix)]
        {
            let ready = self
                .hub
                .lock()
                .ok()
                .and_then(|guard| guard.as_ref().map(|_| ()))
                .is_some();
            if !ready {
                return None;
            }
            let token = uuid::Uuid::new_v4().to_string();
            let Ok(mut tokens) = self.tokens.lock() else {
                return None;
            };
            tokens.insert(token.clone(), window_label.to_string());
            let grant = DelegateGrant {
                socket: self.path.display().to_string(),
                token,
            };
            let path = std::env::temp_dir().join(format!(
                "agentero-delegate-{}-{session_id}.json",
                std::process::id()
            ));
            let body = serde_json::to_vec(&grant).ok()?;
            std::fs::write(&path, body).ok()?;
            let exe = std::env::current_exe().ok()?;
            let stdio = McpServerStdio::new("agentero-delegate", exe)
                .args(vec![WORKER_ARG.to_string(), path.display().to_string()]);
            Some(McpServer::Stdio(stdio))
        }
    }

    #[cfg(unix)]
    async fn listen(self: Arc<Self>, hub: Arc<Hub>) -> Result<(), String> {
        if self.path.exists() {
            let _ = std::fs::remove_file(&self.path);
        }
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let listener = UnixListener::bind(&self.path).map_err(|error| error.to_string())?;
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600));
        }
        log::info!(
            target: "agentero::agent",
            "delegate socket {}",
            self.path.display()
        );
        loop {
            tokio::select! {
                _ = self.shutdown.cancelled() => return Ok(()),
                accepted = listener.accept() => {
                    let (stream, _) = accepted.map_err(|error| error.to_string())?;
                    let bridge = Arc::clone(&self);
                    let hub = Arc::clone(&hub);
                    tokio::spawn(async move {
                        if let Err(error) = handle_stream(stream, bridge, hub).await {
                            log::debug!(target: "agentero::agent", "delegate call failed: {error}");
                        }
                    });
                }
            }
        }
    }
}

#[cfg(unix)]
async fn handle_stream(
    stream: UnixStream,
    bridge: Arc<DelegateBridge>,
    hub: Arc<Hub>,
) -> Result<(), String> {
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read);
    let mut buf = Vec::new();
    lines
        .read_until(b'\n', &mut buf)
        .await
        .map_err(|error| error.to_string())?;
    if buf.len() > MAX_LINE {
        return Err("delegate request is too large".into());
    }
    let raw: serde_json::Value =
        serde_json::from_slice(trim_line(&buf)).map_err(|error| error.to_string())?;
    policy::reject_privilege_escalation(&raw)?;
    let request: WireRequest = serde_json::from_value(raw).map_err(|error| error.to_string())?;
    let window = {
        let tokens = bridge
            .tokens
            .lock()
            .map_err(|_| "delegate token table is unavailable".to_string())?;
        window_for_token(&tokens, &request.token)
            .ok_or_else(|| "delegate token was rejected".to_string())?
    };
    let gone = CancellationToken::new();
    let gone_for_read = gone.clone();
    tokio::spawn(async move {
        let mut rest = lines;
        let mut extra = Vec::new();
        let _ = rest.read_until(b'\n', &mut extra).await;
        gone_for_read.cancel();
    });
    let id = request.id.clone();
    let result = dispatch(&hub, &window, request, gone).await;
    let response = match result {
        Ok(value) => WireResponse {
            id,
            ok: true,
            result: Some(value),
            error: None,
        },
        Err(error) => WireResponse {
            id,
            ok: false,
            result: None,
            error: Some(error),
        },
    };
    let mut bytes = serde_json::to_vec(&response).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    write
        .write_all(&bytes)
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(unix)]
async fn dispatch(
    hub: &Arc<Hub>,
    window: &str,
    request: WireRequest,
    gone: CancellationToken,
) -> Result<serde_json::Value, String> {
    let value = match request.op.as_str() {
        "targets" => {
            serde_json::to_value(hub.targets().await?).map_err(|error| error.to_string())?
        }
        "delegate" => serde_json::to_value(
            hub.delegate(
                window,
                request.target,
                request.agent_id,
                request.prompt.unwrap_or_default(),
                request.wait_ms,
                gone,
            )
            .await?,
        )
        .map_err(|error| error.to_string())?,
        "result" => {
            let run_id = request
                .run_id
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| "runId is required".to_string())?;
            serde_json::to_value(hub.result(&run_id).await?).map_err(|error| error.to_string())?
        }
        "cancel" => {
            let run_id = request
                .run_id
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| "runId is required".to_string())?;
            serde_json::to_value(hub.cancel(&run_id).await?).map_err(|error| error.to_string())?
        }
        other => return Err(format!("unknown delegate op: {other}")),
    };
    Ok(value)
}

#[cfg(any(unix, test))]
fn window_for_token(tokens: &HashMap<String, String>, presented: &str) -> Option<String> {
    tokens
        .iter()
        .find(|(token, _)| policy::tokens_match(presented, token))
        .map(|(_, window)| window.clone())
}

#[cfg(unix)]
fn trim_line(buf: &[u8]) -> &[u8] {
    let end = buf
        .iter()
        .rposition(|byte| !byte.is_ascii_whitespace())
        .map(|index| index + 1)
        .unwrap_or(0);
    &buf[..end]
}

fn socket_path() -> std::path::PathBuf {
    #[cfg(unix)]
    {
        std::path::PathBuf::from(format!(
            "/tmp/agdel-{}-{}.sock",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ))
    }
    #[cfg(not(unix))]
    {
        std::path::PathBuf::new()
    }
}

#[cfg(test)]
mod tests {
    use super::window_for_token;
    use std::collections::HashMap;

    #[test]
    fn wrong_token_is_rejected() {
        let mut tokens = HashMap::new();
        tokens.insert("expected-token".to_string(), "main".to_string());
        assert_eq!(
            window_for_token(&tokens, "expected-token").as_deref(),
            Some("main")
        );
        assert!(window_for_token(&tokens, "other-token").is_none());
        assert!(window_for_token(&tokens, "expected-token-extra").is_none());
    }
}
