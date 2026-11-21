use std::sync::Arc;

use super::policy;
use super::policy::{AgentChoice, TargetChoice};
use super::protocol::{AgentInfo, RunBody, TargetInfo, TargetsBody};
use crate::features::agent::acp::interaction::PermissionPolicy;
use crate::features::agent::models::{is_builtin_template, AgentResultPayload};
use crate::features::agent::remote_host::RemoteAgentHosts;
use crate::features::agent::runtime::events::AgentEventEmitter;
use crate::features::agent::runtime::gates::{AskUserGate, ElicitationGate, PermissionGate};
use crate::features::agent::session::{
    serve_delegate_prompts, DelegatePrompt, DelegateUserWait, RunOnceParams,
};
use crate::features::agent::AgentRegistry;
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Mutex as StdMutex;
use tauri::Manager;
use tokio::sync::{mpsc, oneshot, watch, Mutex};

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

struct Slot {
    tx: Option<mpsc::Sender<DelegatePrompt>>,
    in_flight: Option<String>,
}

enum Claim {
    Busy(String),
    Enqueue(mpsc::Sender<DelegatePrompt>),
    Start,
}

struct ClaimLaunch<'a> {
    key: &'a (String, String),
    target: &'a TargetChoice,
    agent: &'a AgentChoice,
    window: &'a str,
    user_wait: Arc<DelegateUserWait>,
}

struct Hub {
    app: tauri::AppHandle,
    runs: Mutex<HashMap<String, Arc<RunRecord>>>,
    slots: Mutex<HashMap<(String, String), Slot>>,
}

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
    ) -> Result<RunBody, String> {
        let prompt = prompt.trim().to_string();
        if prompt.is_empty() {
            return Err("prompt is required".into());
        }
        let targets = connected_targets(&self.app).await?;
        let target = policy::resolve_target(target.as_deref(), &targets)?.clone();
        let agents = agent_choices(&self.app).await?;
        let agent = policy::resolve_agent(agent_id.as_deref(), &agents)?.clone();
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
            let (reply_tx, mut reply_rx) = oneshot::channel();
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

            tokio::spawn(async move {
                let response = loop {
                    tokio::select! {
                        response = &mut reply_rx => break response,
                        _ = tokio::time::sleep(policy::PERMISSION_WAIT) => {
                            hub.fail_if_waiting_for_permission(&record_for_wait).await;
                        }
                    }
                };
                let outcome =
                    response.unwrap_or_else(|_| Err("remote agent connection closed".into()));
                finish_record(&record_for_wait, outcome).await;
                hub.clear_in_flight(&key_for_wait, &run_for_wait).await;
            });
            return self.view(&run_id).await;
        };
        Err(format!("target is already running job {existing}"))
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
        delegate_hint: None,
        suppress_transcript: true,
        permission_host: Some(policy::target_host(target)),
        progress: None,
        user_wait: Some(user_wait),
    })
}

struct SubmittedJob {
    target: String,
    agent: Option<String>,
    prompt: String,
    job: String,
}

/// The desktop owns SSH, credentials and permissions for delegated tasks.
pub struct DelegateBridge {
    hub: StdMutex<Option<Arc<Hub>>>,
    requests: Mutex<HashMap<String, SubmittedJob>>,
}

impl DelegateBridge {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            hub: StdMutex::new(None),
            requests: Mutex::new(HashMap::new()),
        })
    }

    pub fn start(&self, app: tauri::AppHandle) {
        if let Ok(mut slot) = self.hub.lock() {
            *slot = Some(Hub::new(app));
        }
    }

    pub fn shutdown(&self) {
        if let Ok(slot) = self.hub.lock() {
            if let Some(hub) = slot.as_ref() {
                hub.shutdown();
            }
        }
    }

    pub async fn call(
        &self,
        window: &str,
        route: &str,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        {
            use serde_json::json;
            policy::reject_privilege_escalation(args)?;
            let hub = self
                .hub
                .lock()
                .ok()
                .and_then(|h| h.clone())
                .ok_or("desktop is unavailable")?;
            let arg = |key: &str| {
                args[key]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| format!("missing {key}"))
            };
            let job = match route {
                "delegate targets" => {
                    let items = hub.targets().await?.targets.into_iter().map(|target| json!({
                        "id":target.target, "name":target.destination, "path":target.remote_path,
                        "local_sim":target.local_sim, "available":!target.agents.is_empty(), "agents":target.agents,
                    })).collect::<Vec<_>>();
                    return Ok(json!({"items":items}));
                }
                "delegate run" => {
                    let target = arg("target")?;
                    let prompt = arg("prompt")?;
                    let request_id = args["request_id"].as_str().unwrap_or("").to_owned();
                    let mut requests = self.requests.lock().await;
                    let explicit = args["agent"].as_str();
                    if let Some(previous) = requests.get(&request_id) {
                        if previous.target != target
                            || previous.prompt != prompt
                            || previous.agent.as_deref() != explicit
                        {
                            return Err("idempotency_conflict".into());
                        }
                        hub.result(&previous.job).await?
                    } else {
                        let default = hub
                            .app
                            .state::<AgentRegistry>()
                            .resolve_default(None)
                            .ok()
                            .filter(|d| {
                                !is_builtin_template(&d.template) && !d.command.trim().is_empty()
                            });
                        let choice = explicit.or_else(|| default.as_ref().map(|d| d.id.as_str()));
                        let job = hub
                            .delegate(
                                window,
                                Some(target.to_string()),
                                choice.map(str::to_owned),
                                prompt.to_string(),
                            )
                            .await?;
                        if !request_id.is_empty() {
                            requests.insert(
                                request_id,
                                SubmittedJob {
                                    target: target.to_owned(),
                                    agent: explicit.map(str::to_owned),
                                    prompt: prompt.to_owned(),
                                    job: job.run_id.clone(),
                                },
                            );
                        }
                        job
                    }
                }
                "delegate result" => {
                    let id = arg("job")?;
                    let deadline = tokio::time::Instant::now()
                        + std::time::Duration::from_secs(
                            args["wait"].as_u64().unwrap_or(0).min(300),
                        );
                    loop {
                        let status = hub.result(id).await?;
                        if status.status != "running" || tokio::time::Instant::now() >= deadline {
                            break status;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    }
                }
                "delegate cancel" => hub.cancel(arg("job")?).await?,
                _ => return Err("unknown delegation operation".into()),
            };
            let result = job
                .error
                .as_deref()
                .or_else(|| (!job.text.is_empty()).then_some(job.text.as_str()));
            Ok(json!({"id":job.run_id,"state":job.status,"result":result}))
        }
    }
}
