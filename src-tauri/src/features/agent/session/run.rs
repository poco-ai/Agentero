//! Single-turn ACP run orchestration (prompt → session → stream → complete).

use crate::core::error::AppError;
use crate::features::agent::acp::client::{
    acp_err, acp_terminals, agent_spawn_cwd, cancelled_payload, client_initialize_request,
    timed_acp_initialize, timed_acp_load_session, timed_acp_request, to_acp_agent,
    wait_for_cancellation,
};
use crate::features::agent::acp::interaction::PermissionPolicy;
use crate::features::agent::acp::terminal::AcpTerminalManager;
use crate::features::agent::acp::updates::{
    effort_from_config_options, emit_rich_session_update, emit_session_config_options,
    fast_mode_value_to_set, is_fast_option, is_pi_startup_banner, stream_from_update,
};
use crate::features::agent::context_turn::{
    insert_context_block, insert_resume_transcript, prepare_context,
};
use crate::features::agent::models::{
    AgentDescriptor, AgentFailedEvent, AgentResultPayload, AgentStatusEvent, AgentStreamEvent,
    AgentStreamKind, AgentTemplate, PromptImage,
};
use crate::features::agent::prompt::envelope::build_prompt;
use crate::features::agent::prompt::skills::{
    load_skill_instructions, skill_activation_prefix, skill_mention_style,
};
use crate::features::agent::runtime::events::AgentEventEmitter;
use crate::features::agent::runtime::gates::{AskUserGate, ElicitationGate, PermissionGate};
use crate::features::agent::runtime::stream::{StreamCoalescer, STREAM_COALESCE_WINDOW};
use crate::features::agent::session::config::{
    apply_model_and_collaboration_prefs, RunPreferences,
};
use crate::features::agent::session::handlers::{
    agentero_turn_builder, clear_turn, install_turn, new_registry, ActiveTurn, TurnRegistry,
};
use crate::features::agent::session::pool::{pool_key, AgentWarmPool, PooledSlot};
use crate::features::agent::session::warm::discard_unprompted_session;
use agent_client_protocol::schema::v1::{
    CancelNotification, ContentBlock, ImageContent, LoadSessionRequest, NewSessionRequest,
    PromptRequest, ResumeSessionRequest, SessionConfigId, SessionConfigOptionValue, SessionId,
    SessionNotification, SessionUpdate, SetSessionConfigOptionRequest, TextContent,
};
use agent_client_protocol::{Agent, ConnectionTo};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::watch;
use uuid::Uuid;

/// Input for one `run_once` turn. Collapses the previous 24 positional params.
/// Clone so a failed pooled attempt can fall back to the cold path unchanged.
#[derive(Clone)]
pub struct RunOnceParams {
    pub app: AgentEventEmitter,
    pub desc: AgentDescriptor,
    pub session_id: String,
    pub message_id: String,
    pub prompt: String,
    pub is_acp_command: bool,
    pub images: Vec<PromptImage>,
    pub workflow: Option<String>,
    pub target: Option<String>,
    pub vault_path: Option<String>,
    pub preferred_model_id: Option<String>,
    pub force_model: bool,
    pub preferred_collaboration_mode_id: Option<String>,
    pub preferred_reasoning_effort: Option<String>,
    pub prefer_highest_reasoning_effort: bool,
    pub fast_mode: Option<bool>,
    pub skill_ids: Vec<String>,
    pub permission_policy: PermissionPolicy,
    pub permission_gate: PermissionGate,
    pub elicitation_gate: ElicitationGate,
    pub ask_user_gate: AskUserGate,
    pub response_language: Option<String>,
    pub personal_prompt: Option<String>,
    pub cancellation: watch::Receiver<bool>,
    pub remote: Option<Arc<dyn crate::features::agent::remote_host::RemoteAgentLaunch>>,
    pub resume_session_id: Option<String>,
    /// Pool of warm connections consulted before the cold spawn chain.
    pub warm_pool: Option<Arc<AgentWarmPool>>,
    /// Vault anchors for this turn. Empty means the historical prompt path.
    pub context: Option<agentero_core::features::context::ContextRequest>,
    /// Earlier chat turns. Used only when the context fingerprint refuses to
    /// resume `resume_session_id`, so the new session still sees the conversation.
    pub resume_transcript: Option<String>,
    /// Stdio MCP servers attached on a local session, besides research context.
    pub delegate_mcp: Vec<agent_client_protocol::schema::v1::McpServer>,
    /// Remote-target hint inserted before the user request. Empty when none are connected.
    pub delegate_hint: Option<String>,
    /// Keep the answer in `progress` and do not emit chat transcript events.
    pub suppress_transcript: bool,
    /// Remote host shown on permission dialogs for a delegated run.
    pub permission_host: Option<String>,
    /// Live copy of the answer text for a delegated run.
    pub progress: Option<Arc<Mutex<String>>>,
    /// Set while a delegated run is blocked on a permission dialog.
    pub user_wait: Option<Arc<DelegateUserWait>>,
}

/// Shared with the delegate hub so an unanswered permission fails at the wait limit.
pub struct DelegateUserWait {
    pub waiting: AtomicBool,
    pub request_id: Mutex<Option<String>>,
}

/// Prompt/cwd prepared before any ACP I/O.
#[derive(Clone)]
struct RunTurnPrep {
    full_prompt: String,
    prompt_images: Vec<PromptImage>,
    cwd: PathBuf,
    mcp_servers: Vec<agent_client_protocol::schema::v1::McpServer>,
    /// Provider session to continue after the context fingerprint check.
    resume_session_id: Option<String>,
    context_fingerprint: Option<String>,
    context_usage: Option<PathBuf>,
    context_vault: Option<PathBuf>,
    skip_warm_pool: bool,
}

/// Everything the connection turn needs beyond the shared state.
struct RunTurnInput {
    full_prompt: String,
    prompt_images: Vec<PromptImage>,
    cwd: PathBuf,
    /// Provider session id to continue (resume/load) instead of `session/new`.
    resume_session_id: Option<String>,
    mcp_servers: Vec<agent_client_protocol::schema::v1::McpServer>,
    preferences: RunPreferences,
}

/// Session established by the connect phase of a turn.
#[derive(Clone)]
struct ConnectedSession {
    acp_session_id: SessionId,
    config_options: Vec<agent_client_protocol::schema::v1::SessionConfigOption>,
    /// Resolved provider resume id when continuing an earlier session
    /// (drives the history-replay buffer clear before the prompt).
    resume_id: Option<String>,
}

/// Outcome of a cancellable phase of the run turn.
enum TurnPhase<T> {
    /// The phase completed; the turn continues with this value.
    Ready(T),
    /// The run was cancelled; `agent:completed` was already emitted.
    Cancelled(AgentResultPayload),
}

/// True when `session/prompt` never left the process. The pooled connection
/// is dead; the turn must be retried on a fresh process via `session/load`
/// instead of failing and dropping the conversation.
pub(crate) fn prompt_was_not_delivered(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("connection is no longer running")
        || lower.contains("failed to send outgoing request")
}

/// Error from the prompt phase tagged by whether the `PromptRequest` was
/// already dispatched: only pre-prompt failures let the pooled path hand off
/// to the cold retry; post-prompt failures are terminal.
struct PromptPhaseError {
    pre_prompt: bool,
    error: agent_client_protocol::Error,
}

impl PromptPhaseError {
    fn pre_prompt(error: agent_client_protocol::Error) -> Self {
        Self {
            pre_prompt: true,
            error,
        }
    }

    fn post_prompt(error: agent_client_protocol::Error) -> Self {
        Self {
            pre_prompt: false,
            error,
        }
    }
}

/// Emit `agent:failed` for a run that could not start or complete.
fn emit_run_failed(app: &AgentEventEmitter, session_id: &str, error: &impl std::fmt::Display) {
    let _ = app.emit(
        "agent:failed",
        AgentFailedEvent {
            session_id: session_id.to_string(),
            error: error.to_string(),
        },
    );
}

/// Prompt-assembly phase: resolve skill instructions, template the prompt, and
/// pick the working directory. Emits `agent:failed` and errors when a selected
/// local skill cannot be loaded or the spawn cwd cannot be resolved.
async fn prepare_run_turn(params: &RunOnceParams) -> Result<RunTurnPrep, AppError> {
    let skill_style = skill_mention_style(&params.desc.template);
    let skill_instructions = if params.is_acp_command {
        String::new()
    } else {
        // Skills: local vault path, or remote work_root after materializing SKILL.md from SFTP.
        let skill_vault = if let Some(ref r) = params.remote {
            if let Err(e) = r.materialize_skills().await {
                log::warn!(target: "agentero::agent", "materialize remote skills: {e}");
            }
            Some(r.work_root().to_string_lossy().into_owned())
        } else {
            params.vault_path.clone()
        };
        match load_skill_instructions(&params.skill_ids, skill_vault.as_deref(), skill_style) {
            Ok(instructions) => instructions,
            Err(error) => {
                if !params.suppress_transcript {
                    emit_run_failed(&params.app, &params.session_id, &error);
                }
                return Err(error);
            }
        }
    };
    let full_prompt = if params.is_acp_command {
        params.prompt.clone()
    } else {
        let user_prompt = if params.prompt.trim().is_empty() && !params.images.is_empty() {
            // Shared fallback for visual crops and general composer attachments.
            "Please analyze the attached image(s).".to_string()
        } else {
            params.prompt.clone()
        };
        // Prefix native skill triggers (e.g. Codex `$id`) so the CLI can activate them.
        let activation = skill_activation_prefix(&params.skill_ids, skill_style);
        let user_prompt = format!("{activation}{user_prompt}");
        format!(
            "{}{}",
            build_prompt(
                params.workflow.as_deref(),
                &user_prompt,
                params.target.as_deref(),
                skill_style,
                &params.skill_ids,
                params.response_language.as_deref(),
                params.personal_prompt.as_deref(),
            ),
            skill_instructions
        )
    };
    let prepared = if params.is_acp_command {
        prepare_context(
            &params.session_id,
            None,
            true,
            None,
            params.resume_session_id.clone(),
        )
    } else {
        prepare_context(
            &params.session_id,
            params.vault_path.as_deref(),
            params.remote.is_some(),
            params.context.as_ref(),
            params.resume_session_id.clone(),
        )
    };
    let mut full_prompt = insert_context_block(&full_prompt, &prepared.block);
    if let Some(hint) = params
        .delegate_hint
        .as_deref()
        .filter(|hint| !hint.trim().is_empty())
    {
        full_prompt = insert_context_block(&full_prompt, hint);
    }
    if params.resume_session_id.is_some() && prepared.resume_session_id.is_none() {
        if let Some(transcript) = params
            .resume_transcript
            .as_deref()
            .filter(|text| !text.trim().is_empty())
        {
            full_prompt = insert_resume_transcript(&full_prompt, transcript);
        }
    }
    let prompt_images = params.images.clone();
    let cwd = match agent_spawn_cwd(params.remote.as_deref(), params.vault_path.as_deref()) {
        Ok(cwd) => cwd,
        Err(error) => {
            if !params.suppress_transcript {
                emit_run_failed(&params.app, &params.session_id, &error);
            }
            return Err(error);
        }
    };
    let mut mcp_servers = prepared.mcp_servers;
    mcp_servers.extend(params.delegate_mcp.clone());
    Ok(RunTurnPrep {
        full_prompt,
        prompt_images,
        cwd,
        mcp_servers,
        resume_session_id: prepared.resume_session_id,
        context_fingerprint: prepared.fingerprint,
        context_usage: prepared.usage_path,
        context_vault: prepared.vault,
        skip_warm_pool: prepared.skip_warm_pool,
    })
}

/// Shared state for one `run_once` turn, cloned into the ACP notification /
/// permission / elicitation handlers and the connection turn future.
#[derive(Clone)]
pub(crate) struct RunOnceContext {
    pub(crate) app: AgentEventEmitter,
    pub(crate) session_id: String,
    message_id: String,
    agent_id: String,
    /// pi-acp forwards a CLI startup banner that must be dropped from the stream.
    is_pi: bool,
    content_buf: Arc<Mutex<String>>,
    thought_buf: Arc<Mutex<String>>,
    coalescer: StreamCoalescer,
    /// session/load (and some resume paths) replay history as SessionNotification.
    /// Until we open the gate, drop stream/tool/plan so turn N does not re-paint
    /// turn N-1 into the new streaming bubble (Grok multi-turn).
    live_stream: Arc<AtomicBool>,
    /// Set immediately before `session/prompt` is sent. Cancel-before-send
    /// leaves this false so an unused warm session stays hidden.
    prompt_sent: Arc<AtomicBool>,
    stop_reason: Arc<Mutex<Option<String>>>,
    /// Terminal capability: headless command execution on behalf of the agent.
    terminals: Arc<tokio::sync::Mutex<AcpTerminalManager>>,
    context_fingerprint: Option<String>,
    context_usage: Option<PathBuf>,
    context_vault: Option<PathBuf>,
    suppress_transcript: bool,
    pub(crate) permission_host: Option<String>,
    progress: Option<Arc<Mutex<String>>>,
    pub(crate) user_wait: Option<Arc<DelegateUserWait>>,
}

impl RunOnceContext {
    fn new(params: &RunOnceParams, cwd: std::path::PathBuf) -> Self {
        // Merge token-storm chunks into ~25 emits/s (Windows webview jank source).
        // Payload shape is unchanged: same event, longer `chunk`, lower rate.
        let coalescer = StreamCoalescer::new(STREAM_COALESCE_WINDOW, {
            let app = params.app.clone();
            let session_id = params.session_id.clone();
            let suppress = params.suppress_transcript;
            move |chunk, kind| {
                if suppress {
                    return;
                }
                let _ = app.emit(
                    "agent:stream",
                    AgentStreamEvent {
                        session_id: session_id.clone(),
                        chunk,
                        kind,
                    },
                );
            }
        });
        Self {
            app: params.app.clone(),
            session_id: params.session_id.clone(),
            message_id: params.message_id.clone(),
            agent_id: params.desc.id.clone(),
            is_pi: matches!(params.desc.template, AgentTemplate::Pi),
            content_buf: Arc::new(Mutex::new(String::new())),
            thought_buf: Arc::new(Mutex::new(String::new())),
            coalescer,
            live_stream: Arc::new(AtomicBool::new(params.resume_session_id.is_none())),
            prompt_sent: Arc::new(AtomicBool::new(false)),
            stop_reason: Arc::new(Mutex::new(None)),
            terminals: acp_terminals(Some(cwd)),
            context_fingerprint: None,
            context_usage: None,
            context_vault: None,
            suppress_transcript: params.suppress_transcript,
            permission_host: params.permission_host.clone(),
            progress: params.progress.clone(),
            user_wait: params.user_wait.clone(),
        }
    }

    fn bind_context(&mut self, prep: &RunTurnPrep) {
        self.context_fingerprint = prep.context_fingerprint.clone();
        self.context_usage = prep.context_usage.clone();
        self.context_vault = prep.context_vault.clone();
        if prep.resume_session_id.is_none() {
            self.live_stream.store(true, Ordering::SeqCst);
        }
    }

    /// Pooled-path constructor: share the terminal manager (and cwd default)
    /// of the warm connection the run is about to reuse, so terminal requests
    /// from the agent route to the manager this run's UI can observe.
    pub(crate) fn with_terminals(
        params: &RunOnceParams,
        cwd: std::path::PathBuf,
        terminals: Arc<tokio::sync::Mutex<AcpTerminalManager>>,
    ) -> Self {
        let mut ctx = Self::new(params, cwd);
        ctx.terminals = terminals;
        ctx
    }

    /// Relay one `SessionNotification`: buffer + coalesce stream chunks, and
    /// forward rich updates (tool/plan/usage/config/commands) to the webview.
    pub(crate) fn relay_session_notification(&self, notification: &SessionNotification) {
        if !self.live_stream.load(Ordering::SeqCst) {
            // Still allow usage / command / config during load settle.
            if !self.suppress_transcript {
                match &notification.update {
                    SessionUpdate::AvailableCommandsUpdate(_)
                    | SessionUpdate::ConfigOptionUpdate(_)
                    | SessionUpdate::UsageUpdate(_)
                    | SessionUpdate::SessionInfoUpdate(_) => {
                        emit_rich_session_update(
                            &self.app,
                            &self.session_id,
                            &self.agent_id,
                            notification,
                        );
                    }
                    _ => {}
                }
            }
            return;
        }
        if let Some((chunk, kind)) = stream_from_update(&notification.update) {
            let drop_banner = self.is_pi
                && matches!(kind, AgentStreamKind::Message)
                && is_pi_startup_banner(&chunk)
                && self
                    .content_buf
                    .lock()
                    .is_ok_and(|buffer| buffer.is_empty());
            if !drop_banner {
                match kind {
                    AgentStreamKind::Message => {
                        if let Ok(mut buf) = self.content_buf.lock() {
                            buf.push_str(&chunk);
                        }
                        if let Some(progress) = &self.progress {
                            if let Ok(mut progress) = progress.lock() {
                                progress.push_str(&chunk);
                            }
                        }
                    }
                    AgentStreamKind::Thought => {
                        if let Ok(mut buf) = self.thought_buf.lock() {
                            buf.push_str(&chunk);
                        }
                    }
                }
                if !self.suppress_transcript {
                    self.coalescer.push(&chunk, kind);
                }
            }
        } else if !self.suppress_transcript {
            // Non-chunk update (tool/plan/…): flush buffered text first
            // so the transcript order stays text → tool/plan.
            self.coalescer.flush();
        }
        if !self.suppress_transcript {
            emit_rich_session_update(&self.app, &self.session_id, &self.agent_id, notification);
        }
    }

    /// Grok Build's vendor model-catalog push (`_x.ai/models/update`): forward
    /// the refreshed list so a live picker stops showing the stale snapshot
    /// `session/new` returned.
    pub(crate) fn relay_grok_models_update(
        &self,
        params: &crate::features::agent::acp::grok_models::GrokModelsUpdateParams,
    ) {
        if let Some(event) = crate::features::agent::acp::updates::models_from_grok_update(
            &self.session_id,
            &self.agent_id,
            params,
        ) {
            if !self.suppress_transcript {
                let _ = self.app.emit("agent:models", event);
            }
        }
    }

    /// Flush buffered stream text, then emit `agent:completed` (ordered after text).
    fn emit_completed(&self, payload: AgentResultPayload) -> AgentResultPayload {
        self.coalescer.flush();
        if !self.suppress_transcript {
            let _ = self.app.emit("agent:completed", payload.clone());
        }
        payload
    }

    /// Build the cancelled payload, flush, and emit `agent:completed`.
    fn cancel_completed(&self, provider_session_id: Option<String>) -> AgentResultPayload {
        let payload = cancelled_payload(
            self.session_id.clone(),
            self.message_id.clone(),
            provider_session_id,
            &self.content_buf,
            &self.thought_buf,
        );
        self.emit_completed(payload)
    }

    /// Build the ACP client (stream + permission/elicitation/ask-user handlers),
    /// connect to the agent process, and run one prompt turn on the connection.
    async fn run(
        &self,
        acp: agent_client_protocol::AcpAgent,
        params: RunOnceParams,
        prep: RunTurnPrep,
    ) -> Result<AgentResultPayload, agent_client_protocol::Error> {
        let RunOnceParams {
            permission_policy,
            permission_gate,
            elicitation_gate,
            ask_user_gate,
            cancellation,
            preferred_model_id,
            force_model,
            preferred_collaboration_mode_id,
            preferred_reasoning_effort,
            prefer_highest_reasoning_effort,
            fast_mode,
            workflow,
            ..
        } = params;
        let mut turn = RunTurnInput {
            full_prompt: prep.full_prompt,
            prompt_images: prep.prompt_images,
            cwd: prep.cwd.clone(),
            resume_session_id: prep.resume_session_id.clone(),
            mcp_servers: prep.mcp_servers.clone(),
            preferences: RunPreferences::for_workflow(
                workflow.as_deref(),
                preferred_model_id,
                preferred_collaboration_mode_id,
                preferred_reasoning_effort,
                prefer_highest_reasoning_effort,
                fast_mode,
            ),
        };

        turn.preferences.force_model = force_model;

        // Cold path: the turn registry is pre-filled for the whole connection
        // lifetime, so the shared handlers behave exactly like the previous
        // inline closures. Idle hooks are unused (no pool owns this socket).
        let registry = new_registry();
        let _replaced = install_turn(
            &registry,
            ActiveTurn {
                ctx: self.clone(),
                permission_policy,
                permission_gate,
                elicitation_gate,
                ask_user_gate,
                activity: None,
            },
        );
        agentero_turn_builder!(self.terminals.clone(), registry, None)
            .connect_with(acp, {
                let state = self.clone();
                move |connection: ConnectionTo<Agent>| async move {
                    state.run_turn(connection, cancellation, turn).await
                }
            })
            .await
    }

    /// Run one prompt turn on an established connection:
    /// initialize → open/resume session → apply preferences → prompt → finalize.
    async fn run_turn(
        &self,
        connection: ConnectionTo<Agent>,
        mut cancellation: watch::Receiver<bool>,
        turn: RunTurnInput,
    ) -> Result<AgentResultPayload, agent_client_protocol::Error> {
        let RunTurnInput {
            full_prompt,
            prompt_images,
            cwd,
            resume_session_id,
            mcp_servers,
            preferences,
        } = turn;

        let session = match self
            .connect_session(
                &connection,
                &mut cancellation,
                resume_session_id,
                &cwd,
                mcp_servers,
            )
            .await?
        {
            TurnPhase::Ready(session) => session,
            TurnPhase::Cancelled(payload) => return Ok(payload),
        };
        self.prompt_phase(
            &connection,
            &mut cancellation,
            session,
            &preferences,
            full_prompt,
            prompt_images,
        )
        .await
        .map_err(|e| e.error)
    }

    /// Prompt phase shared by the cold and pooled paths: apply preferences,
    /// emit `agent:status` (waiting-model), dispatch the prompt, finalize.
    /// Errors carry a pre/post-prompt marker so the pooled path can choose
    /// between a cold handoff and a terminal `agent:failed`.
    #[allow(clippy::too_many_arguments)]
    async fn prompt_phase(
        &self,
        connection: &ConnectionTo<Agent>,
        cancellation: &mut watch::Receiver<bool>,
        session: ConnectedSession,
        preferences: &RunPreferences,
        full_prompt: String,
        prompt_images: Vec<PromptImage>,
    ) -> Result<AgentResultPayload, PromptPhaseError> {
        let config_options = match self
            .apply_session_preferences(
                connection,
                cancellation,
                &session.acp_session_id,
                session.config_options,
                preferences,
            )
            .await
        {
            Ok(TurnPhase::Ready(options)) => options,
            Ok(TurnPhase::Cancelled(payload)) => return Ok(payload),
            Err(error) => return Err(PromptPhaseError::pre_prompt(error)),
        };
        if !self.suppress_transcript {
            emit_session_config_options(
                &self.app,
                &self.session_id,
                &self.agent_id,
                &config_options,
            );
        }

        if *cancellation.borrow() {
            let _ = connection
                .send_notification(CancelNotification::new(session.acp_session_id.clone()));
            return Ok(self.cancel_completed(Some(session.acp_session_id.to_string())));
        }

        // After session/load|resume, drop any history-replay chunks that
        // arrived before this turn's prompt so completed.content and the
        // UI stream only reflect the new answer.
        if session.resume_id.is_some() {
            if let Ok(mut buf) = self.content_buf.lock() {
                buf.clear();
            }
            if let Ok(mut buf) = self.thought_buf.lock() {
                buf.clear();
            }
        }
        self.live_stream.store(true, Ordering::SeqCst);
        self.prompt_sent.store(true, Ordering::SeqCst);

        let mut content_blocks: Vec<ContentBlock> =
            vec![ContentBlock::Text(TextContent::new(full_prompt))];
        for img in &prompt_images {
            if img.data.trim().is_empty() || img.mime_type.trim().is_empty() {
                continue;
            }
            content_blocks.push(ContentBlock::Image(ImageContent::new(
                img.data.clone(),
                img.mime_type.clone(),
            )));
        }

        let session_id = session.acp_session_id.clone();
        // Status: the prompt is on the wire; the next signal is model output.
        if !self.suppress_transcript {
            let _ = self.app.emit(
                "agent:status",
                AgentStatusEvent::waiting_model(self.session_id.as_str()),
            );
        }
        let prompt_response = tokio::select! {
            response = connection
                .send_request(PromptRequest::new(session_id.clone(), content_blocks.clone()))
                .block_task() => response.map_err(|e| {
                    let wrapped = format!("prompt: {e}");
                    // Send failed before the agent saw the turn. Hand off so a
                    // new process can session/load and deliver the same prompt.
                    if prompt_was_not_delivered(&wrapped) {
                        PromptPhaseError::pre_prompt(acp_err(wrapped))
                    } else {
                        PromptPhaseError::post_prompt(acp_err(wrapped))
                    }
                }),
            () = wait_for_cancellation(cancellation) => {
                let _ = connection
                    .send_notification(CancelNotification::new(session_id.clone()));
                return Ok(self.cancel_completed(Some(session_id.to_string())));
            }
        }?;

        if let Ok(mut s) = self.stop_reason.lock() {
            *s = Some(format!("{:?}", prompt_response.stop_reason));
        }

        Ok(self.finalize(&session_id))
    }

    /// Connect phase: `initialize`, then open a session via `session/resume`,
    /// `session/load`, or `session/new` (capability-aware).
    async fn connect_session(
        &self,
        connection: &ConnectionTo<Agent>,
        cancellation: &mut watch::Receiver<bool>,
        resume_session_id: Option<String>,
        cwd: &Path,
        mcp_servers: Vec<agent_client_protocol::schema::v1::McpServer>,
    ) -> Result<TurnPhase<ConnectedSession>, agent_client_protocol::Error> {
        let init = tokio::select! {
            result = timed_acp_initialize(
                connection
                    .send_request(client_initialize_request())
                    .block_task(),
            ) => result?,
            () = wait_for_cancellation(&mut *cancellation) => {
                return Ok(TurnPhase::Cancelled(self.cancel_completed(None)));
            }
        };

        // Capability-aware continue (Grok advertises loadSession but not
        // session/resume — calling resume yields Method not found).
        let can_resume = init
            .agent_capabilities
            .session_capabilities
            .resume
            .is_some();
        let can_load = init.agent_capabilities.load_session;

        let resume_id = if let Some(rid) = &resume_session_id {
            if can_resume || can_load {
                resume_session_id
            } else {
                return Err(acp_err(format!(
                    "Agent does not support continuing session {rid} \
                     (no session/resume or session/load capability)"
                )));
            }
        } else {
            None
        };

        let (acp_session_id, config_options) = if let Some(ref rid) = resume_id {
            let session = match self
                .open_resume_on(
                    connection,
                    cancellation,
                    rid,
                    cwd,
                    can_resume,
                    mcp_servers.clone(),
                )
                .await?
            {
                TurnPhase::Ready(session) => session,
                TurnPhase::Cancelled(payload) => return Ok(TurnPhase::Cancelled(payload)),
            };
            (session.acp_session_id, session.config_options)
        } else {
            let new_session = tokio::select! {
                result = timed_acp_request(
                    "new_session",
                    connection
                        .send_request(
                            NewSessionRequest::new(cwd.to_path_buf()).mcp_servers(mcp_servers),
                        )
                        .block_task(),
                ) => result?,
                () = wait_for_cancellation(&mut *cancellation) => {
                    return Ok(TurnPhase::Cancelled(self.cancel_completed(None)));
                }
            };
            (
                new_session.session_id,
                new_session.config_options.unwrap_or_default(),
            )
        };

        Ok(TurnPhase::Ready(ConnectedSession {
            acp_session_id,
            config_options,
            resume_id,
        }))
    }

    /// Continue `rid` on an established connection: `session/resume` when
    /// advertised, else `session/load` (Grok-style agents). Shared by the
    /// cold connect phase and the pooled run path.
    async fn open_resume_on(
        &self,
        connection: &ConnectionTo<Agent>,
        cancellation: &mut watch::Receiver<bool>,
        rid: &str,
        cwd: &Path,
        can_resume: bool,
        mcp_servers: Vec<agent_client_protocol::schema::v1::McpServer>,
    ) -> Result<TurnPhase<ConnectedSession>, agent_client_protocol::Error> {
        if can_resume {
            let resp = tokio::select! {
                result = timed_acp_request(
                    "session/resume",
                    connection
                        .send_request(
                            ResumeSessionRequest::new(SessionId::new(rid), cwd.to_path_buf())
                                .mcp_servers(mcp_servers.clone()),
                        )
                        .block_task(),
                ) => result?,
                () = wait_for_cancellation(&mut *cancellation) => {
                    return Ok(TurnPhase::Cancelled(self.cancel_completed(Some(rid.to_string()))));
                }
            };
            Ok(TurnPhase::Ready(ConnectedSession {
                acp_session_id: SessionId::new(rid),
                config_options: resp.config_options.unwrap_or_default(),
                resume_id: Some(rid.to_string()),
            }))
        } else {
            // Called only when can_resume || can_load. Grok and similar:
            // continue across process restarts via session/load (requires
            // mcpServers; schema defaults to []).
            let resp = tokio::select! {
                result = timed_acp_load_session(
                    &self.agent_id,
                    rid,
                    connection
                        .send_request(
                            LoadSessionRequest::new(SessionId::new(rid), cwd.to_path_buf())
                                .mcp_servers(mcp_servers),
                        )
                        .block_task(),
                ) => result?,
                () = wait_for_cancellation(&mut *cancellation) => {
                    return Ok(TurnPhase::Cancelled(self.cancel_completed(Some(rid.to_string()))));
                }
            };
            Ok(TurnPhase::Ready(ConnectedSession {
                acp_session_id: SessionId::new(rid),
                config_options: resp.config_options.unwrap_or_default(),
                resume_id: Some(rid.to_string()),
            }))
        }
    }

    /// Apply the user's model / collaboration / effort / fast-mode preferences
    /// via `set_config_option`, refreshing `config_options` after each write.
    async fn apply_session_preferences(
        &self,
        connection: &ConnectionTo<Agent>,
        cancellation: &mut watch::Receiver<bool>,
        acp_session_id: &SessionId,
        mut config_options: Vec<agent_client_protocol::schema::v1::SessionConfigOption>,
        prefs: &RunPreferences,
    ) -> Result<
        TurnPhase<Vec<agent_client_protocol::schema::v1::SessionConfigOption>>,
        agent_client_protocol::Error,
    > {
        macro_rules! return_cancelled {
            () => {
                return Ok(TurnPhase::Cancelled(
                    self.cancel_completed(Some(acp_session_id.to_string())),
                ))
            };
        }
        config_options = tokio::select! {
            options = apply_model_and_collaboration_prefs(
                connection,
                &self.session_id,
                &self.agent_id,
                acp_session_id,
                config_options,
                prefs,
            ) => options,
            () = wait_for_cancellation(&mut *cancellation) => return_cancelled!(),
        };
        if let Some(ev) =
            effort_from_config_options(&self.session_id, &self.agent_id, &config_options)
        {
            if let Some(pref) = prefs.resolve_reasoning_effort(&ev.efforts) {
                if pref != ev.current_id && ev.efforts.iter().any(|effort| effort.id == pref) {
                    let response = tokio::select! {
                        result = timed_acp_request(
                            "set effort",
                            connection
                                .send_request(SetSessionConfigOptionRequest::new(
                                    acp_session_id.clone(),
                                    SessionConfigId::new(ev.config_id.as_str()),
                                    SessionConfigOptionValue::value_id(pref),
                                ))
                                .block_task(),
                        ) => result.ok(),
                        () = wait_for_cancellation(&mut *cancellation) => return_cancelled!(),
                    };
                    if let Some(response) = response {
                        config_options = response.config_options;
                    }
                }
            }
        }
        if let Some(enabled) = prefs.fast_mode {
            if let Some(opt) = config_options.iter().find(|opt| is_fast_option(opt)) {
                if let Some(value) = fast_mode_value_to_set(opt, enabled) {
                    let response = tokio::select! {
                        result = timed_acp_request(
                            "set fast mode",
                            connection
                                .send_request(SetSessionConfigOptionRequest::new(
                                    acp_session_id.clone(),
                                    opt.id.clone(),
                                    value,
                                ))
                                .block_task(),
                        ) => result.ok(),
                        () = wait_for_cancellation(&mut *cancellation) => return_cancelled!(),
                    };
                    if let Some(response) = response {
                        config_options = response.config_options;
                    }
                }
            }
        }
        Ok(TurnPhase::Ready(config_options))
    }

    /// Finalize phase: snapshot the streamed buffers into the result payload and
    /// emit `agent:completed`.
    fn finalize(&self, acp_session_id: &SessionId) -> AgentResultPayload {
        let content = self
            .content_buf
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default();
        let reasoning = self
            .thought_buf
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default();
        if let (Some(vault), Some(fingerprint)) = (
            self.context_vault.as_deref(),
            self.context_fingerprint.as_deref(),
        ) {
            if let Err(error) = agentero_core::features::context::remember_session_fingerprint(
                vault,
                &acp_session_id.to_string(),
                fingerprint,
            ) {
                log::warn!(target: "agentero::agent", "remember context fingerprint: {error}");
            }
        }
        let sources = self
            .context_usage
            .as_deref()
            .map(agentero_core::features::context::read_usage_uris)
            .unwrap_or_default();
        let payload = AgentResultPayload {
            session_id: self.session_id.clone(),
            message_id: self.message_id.clone(),
            content,
            reasoning: if reasoning.is_empty() {
                None
            } else {
                Some(reasoning)
            },
            sources,
            stop_reason: self.stop_reason.lock().ok().and_then(|g| g.clone()),
            provider_session_id: Some(acp_session_id.to_string()),
        };
        self.emit_completed(payload)
    }
}

/// Terminal outcome of a pooled run: `Done` finishes the run (result or
/// post-prompt error → `agent:failed` upstream); `Handoff` marks a pre-prompt
/// failure that should fall back to the cold path.
enum PooledOutcome {
    Done(Result<AgentResultPayload, agent_client_protocol::Error>),
    Handoff,
}

/// Run one turn on a pooled warm connection: install the turn into the slot's
/// registry, resolve the session (slot's own, or resume/load on the same
/// connection), then reuse the shared prompt phase. Every exit path clears
/// the registry — a stale turn would route later notifications to a dead
/// emitter. Ok/cancel release the slot back to the pool (the connection
/// survives to serve the next turn); errors evict it.
async fn run_on_pooled(
    pool: &Arc<AgentWarmPool>,
    mut slot: PooledSlot,
    params: &RunOnceParams,
    prep: &RunTurnPrep,
) -> PooledOutcome {
    let registry = slot.registry.clone();
    let mut cancellation = params.cancellation.clone();
    let mut state =
        RunOnceContext::with_terminals(params, prep.cwd.clone(), slot.terminals.clone());
    state.bind_context(prep);

    let prev = install_turn(
        &registry,
        ActiveTurn {
            ctx: state.clone(),
            permission_policy: params.permission_policy,
            permission_gate: params.permission_gate.clone(),
            elicitation_gate: params.elicitation_gate.clone(),
            ask_user_gate: params.ask_user_gate.clone(),
            activity: Some(slot.activity.clone()),
        },
    );
    if prev.is_some() {
        log::warn!(
            target: "agentero::agent",
            "agent={} pooled turn registry was not empty; replacing",
            params.desc.id
        );
    }
    slot.bump();

    let warm_id = slot.acp_session_id.clone();
    let warm_unused = !slot.used.load(Ordering::SeqCst);

    // Resolve the session: no resume id (or one matching the warm session)
    // prompts directly on the pooled session; a different id continues it via
    // session/resume|load on the same connection.
    let session = match prep.resume_session_id.as_deref() {
        Some(rid) if rid != slot.acp_session_id.to_string() => {
            if !slot.can_resume && !slot.can_load {
                // Neither continue capability: hand off so the cold path raises
                // the user-facing "agent does not support continuing" error.
                // The connection itself is healthy — release, don't evict.
                clear_turn(&registry);
                pool.release(slot);
                return PooledOutcome::Handoff;
            }
            match state
                .open_resume_on(
                    &slot.connection,
                    &mut cancellation,
                    rid,
                    &prep.cwd,
                    slot.can_resume,
                    prep.mcp_servers.clone(),
                )
                .await
            {
                Ok(TurnPhase::Ready(session)) => {
                    // The warm session never received this turn. Drop it before
                    // the slot adopts the resumed id, so teardown cannot delete
                    // the conversation the user is continuing.
                    if warm_unused {
                        discard_unprompted_session(
                            &slot.connection,
                            &warm_id,
                            slot.supports_delete,
                            pool,
                        )
                        .await;
                    }
                    slot.mark_used();
                    slot.acp_session_id = session.acp_session_id.clone();
                    session
                }
                Ok(TurnPhase::Cancelled(payload)) => {
                    // Resume never finished. Keep the unused warm session.
                    clear_turn(&registry);
                    pool.release(slot);
                    return PooledOutcome::Done(Ok(payload));
                }
                Err(error) => {
                    // Pre-prompt failure on a warm socket: the connection is
                    // suspect — evict and let the cold path retry cleanly.
                    log::debug!(
                        target: "agentero::agent",
                        "agent={} pooled session/load failed: {error}",
                        params.desc.id
                    );
                    clear_turn(&registry);
                    pool.evict(&slot);
                    return PooledOutcome::Handoff;
                }
            }
        }
        _ => ConnectedSession {
            acp_session_id: slot.acp_session_id.clone(),
            config_options: slot.config_options.clone(),
            resume_id: None,
        },
    };
    let used_session_id = session.acp_session_id.clone();

    let mut preferences = RunPreferences::for_workflow(
        params.workflow.as_deref(),
        params.preferred_model_id.clone(),
        params.preferred_collaboration_mode_id.clone(),
        params.preferred_reasoning_effort.clone(),
        params.prefer_highest_reasoning_effort,
        params.fast_mode,
    );
    preferences.force_model = params.force_model;
    let result = state
        .prompt_phase(
            &slot.connection,
            &mut cancellation,
            session,
            &preferences,
            prep.full_prompt.clone(),
            prep.prompt_images.clone(),
        )
        .await;

    clear_turn(&registry);
    let prompted = state.prompt_sent.load(Ordering::SeqCst);
    match result {
        Ok(payload) => {
            // The client may resume this id even when send was cancelled
            // first. Keep the session, but only show it once a prompt was sent.
            slot.mark_used();
            if prompted {
                pool.forget_unprompted(&used_session_id.to_string());
            }
            slot.acp_session_id = used_session_id;
            pool.release(slot);
            PooledOutcome::Done(Ok(payload))
        }
        Err(e) => {
            if !e.pre_prompt {
                slot.mark_used();
                pool.forget_unprompted(&used_session_id.to_string());
                slot.acp_session_id = used_session_id;
            }
            pool.evict(&slot);
            if e.pre_prompt {
                PooledOutcome::Handoff
            } else {
                // Flush any buffered stream text before the failure lands.
                state.coalescer.flush();
                PooledOutcome::Done(Err(e.error))
            }
        }
    }
}

/// One-shot prompt: spawn → initialize → session → prompt → stream events → completed/failed.
/// A healthy pooled warm connection short-circuits the spawn chain.
pub async fn run_once(params: RunOnceParams) -> Result<AgentResultPayload, AppError> {
    // Phase 1 — prompt: skill instructions + template envelope + cwd.
    let prep = prepare_run_turn(&params).await?;

    // Phase 1.5 — pooled warm connection: skip spawn → initialize →
    // session/new entirely when a healthy slot matches this run.
    if reuse_warm_pool(
        prep.skip_warm_pool,
        params.resume_session_id.as_deref(),
        prep.resume_session_id.as_deref(),
    ) {
        if let Some(pool) = params.warm_pool.clone() {
            // Pi only reads its project-trust decision while starting up; a
            // slot created under another decision must not serve this turn.
            let variant = if params.remote.is_none() {
                crate::features::agent::pi_trust::pool_variant(&params.desc, &prep.cwd)
            } else {
                None
            };
            let key = pool_key(
                &params.desc.id,
                prep.cwd.clone(),
                params.remote.as_ref(),
                variant,
            );
            if let Some(slot) = pool.take(&key).await {
                match run_on_pooled(&pool, slot, &params, &prep).await {
                    PooledOutcome::Done(result) => {
                        return match result {
                            Ok(payload) => Ok(payload),
                            Err(e) => {
                                let msg = e.to_string();
                                emit_run_failed(&params.app, &params.session_id, &msg);
                                Err(AppError::domain("acp", format!("acp: {msg}")))
                            }
                        };
                    }
                    PooledOutcome::Handoff => {
                        log::warn!(
                            target: "agentero::agent",
                            "agent={} pooled connection failed pre-prompt; retrying cold",
                            params.desc.id
                        );
                    }
                }
            }
        }
    }

    // Phase 2 — spawn the ACP agent process (local, or SSH wrapper for remote).
    let acp = match to_acp_agent(&params.desc, Some(&prep.cwd), params.remote.as_deref()) {
        Ok(agent) => agent,
        Err(error) => {
            emit_run_failed(&params.app, &params.session_id, &error);
            return Err(error);
        }
    };

    // Phase 3 — connect, stream one turn, and finalize.
    let warm_pool = params.warm_pool.clone();
    let mut state = RunOnceContext::new(&params, prep.cwd.clone());
    state.bind_context(&prep);
    let run_result = state.run(acp, params, prep).await;

    match run_result {
        Ok(payload) => {
            // A cold resume can deliver the first prompt on a session that
            // warm created and then lost. Show it once that prompt landed.
            if payload.stop_reason.as_deref() != Some("cancelled") {
                if let Some(id) = payload.provider_session_id.as_deref() {
                    if let Some(pool) = warm_pool.as_ref() {
                        pool.forget_unprompted(id);
                    }
                }
            }
            Ok(payload)
        }
        Err(e) => {
            let msg = e.to_string();
            state.coalescer.flush();
            emit_run_failed(&state.app, &state.session_id, &msg);
            Err(AppError::domain("acp", format!("acp: {msg}")))
        }
    }
}

/// One prompt for a delegated remote ACP connection.
pub struct DelegatePrompt {
    pub run_id: String,
    pub prompt: String,
    pub cancellation: watch::Receiver<bool>,
    pub progress: Arc<Mutex<String>>,
    pub reply: tokio::sync::oneshot::Sender<Result<AgentResultPayload, String>>,
}

/// Keep one remote ACP process and run each queued prompt on it.
///
/// The first prompt opens the session. Later prompts reuse it. Cancel and
/// errors drop the process so the next delegate call starts a new one.
pub async fn serve_delegate_prompts(
    base: RunOnceParams,
    mut incoming: tokio::sync::mpsc::Receiver<DelegatePrompt>,
) {
    let Some(first) = incoming.recv().await else {
        return;
    };
    if let Err(error) = serve_delegate_connection(base, first, incoming).await {
        log::warn!(target: "agentero::agent", "delegate connection ended: {error}");
    }
}

async fn serve_delegate_connection(
    mut base: RunOnceParams,
    first: DelegatePrompt,
    mut incoming: tokio::sync::mpsc::Receiver<DelegatePrompt>,
) -> Result<(), String> {
    apply_delegate_prompt(&mut base, &first);
    let prep = match prepare_run_turn(&base).await {
        Ok(prep) => prep,
        Err(error) => {
            let message = error.to_string();
            let _ = first.reply.send(Err(message.clone()));
            return Err(message);
        }
    };
    let acp = match to_acp_agent(&base.desc, Some(&prep.cwd), base.remote.as_deref()) {
        Ok(acp) => acp,
        Err(error) => {
            let message = error.to_string();
            let _ = first.reply.send(Err(message.clone()));
            return Err(message);
        }
    };
    let state = RunOnceContext::new(&base, prep.cwd.clone());
    let registry = new_registry();
    let preferences = RunPreferences::for_workflow(None, None, None, None, false, None);
    let params = base.clone();
    let result = agentero_turn_builder!(state.terminals.clone(), registry.clone(), None)
        .connect_with(acp, {
            let registry = registry.clone();
            move |connection: ConnectionTo<Agent>| async move {
                let mut state = state;
                let mut turn = Some(first);
                let mut session: Option<ConnectedSession> = None;
                loop {
                    let Some(current) = turn.take() else {
                        match incoming.recv().await {
                            Some(next) => turn = Some(next),
                            None => break,
                        }
                        continue;
                    };
                    begin_delegate_turn(&mut state, &current);
                    install_delegate_turn(&registry, &state, &params);
                    let mut cancellation = current.cancellation.clone();
                    if session.is_none() {
                        match state
                            .connect_session(
                                &connection,
                                &mut cancellation,
                                None,
                                &prep.cwd,
                                prep.mcp_servers.clone(),
                            )
                            .await
                        {
                            Ok(TurnPhase::Ready(connected)) => session = Some(connected),
                            Ok(TurnPhase::Cancelled(payload)) => {
                                let _ = current.reply.send(Ok(payload));
                                break;
                            }
                            Err(error) => {
                                let _ = current.reply.send(Err(error.to_string()));
                                break;
                            }
                        }
                    }
                    let Some(connected) = session.clone() else {
                        let _ = current
                            .reply
                            .send(Err("remote session was not opened".into()));
                        break;
                    };
                    match state
                        .prompt_phase(
                            &connection,
                            &mut cancellation,
                            connected,
                            &preferences,
                            current.prompt.clone(),
                            Vec::new(),
                        )
                        .await
                    {
                        Ok(payload) => {
                            let cancelled = payload.stop_reason.as_deref() == Some("cancelled");
                            let _ = current.reply.send(Ok(payload));
                            if cancelled {
                                break;
                            }
                        }
                        Err(error) => {
                            let _ = current.reply.send(Err(error.error.to_string()));
                            break;
                        }
                    }
                }
                clear_turn(&registry);
                Ok(AgentResultPayload {
                    session_id: state.session_id,
                    message_id: state.message_id,
                    content: String::new(),
                    reasoning: None,
                    sources: Vec::new(),
                    stop_reason: None,
                    provider_session_id: None,
                })
            }
        })
        .await;
    result.map(|_| ()).map_err(|error| error.to_string())
}

fn apply_delegate_prompt(base: &mut RunOnceParams, turn: &DelegatePrompt) {
    base.session_id = turn.run_id.clone();
    base.message_id = turn.run_id.clone();
    base.prompt = turn.prompt.clone();
    base.progress = Some(turn.progress.clone());
    base.cancellation = turn.cancellation.clone();
    base.suppress_transcript = true;
    base.permission_policy = PermissionPolicy::Ask;
    base.is_acp_command = true;
    base.warm_pool = None;
    base.delegate_mcp.clear();
    base.delegate_hint = None;
}

fn begin_delegate_turn(state: &mut RunOnceContext, turn: &DelegatePrompt) {
    state.session_id = turn.run_id.clone();
    state.message_id = turn.run_id.clone();
    state.progress = Some(turn.progress.clone());
    if let Ok(mut buf) = state.content_buf.lock() {
        buf.clear();
    }
    if let Ok(mut buf) = state.thought_buf.lock() {
        buf.clear();
    }
    if let Ok(mut buf) = turn.progress.lock() {
        buf.clear();
    }
    if let Ok(mut stop) = state.stop_reason.lock() {
        *stop = None;
    }
    state.live_stream.store(true, Ordering::SeqCst);
    state.prompt_sent.store(false, Ordering::SeqCst);
}

fn install_delegate_turn(registry: &TurnRegistry, state: &RunOnceContext, params: &RunOnceParams) {
    install_turn(
        registry,
        ActiveTurn {
            ctx: state.clone(),
            permission_policy: PermissionPolicy::Ask,
            permission_gate: params.permission_gate.clone(),
            elicitation_gate: params.elicitation_gate.clone(),
            ask_user_gate: params.ask_user_gate.clone(),
            activity: None,
        },
    );
}

/// A warm socket already belongs to one ACP session. Reuse it for a fresh
/// turn or for a resume the context fingerprint still allows. A resume the
/// fingerprint refused must not keep talking on that socket.
pub(crate) fn reuse_warm_pool(
    skip_warm_pool: bool,
    requested_resume: Option<&str>,
    granted_resume: Option<&str>,
) -> bool {
    if skip_warm_pool {
        return false;
    }
    !(requested_resume.is_some() && granted_resume.is_none())
}

pub fn new_ids() -> (String, String) {
    (Uuid::new_v4().to_string(), Uuid::new_v4().to_string())
}

#[cfg(test)]
mod cancelled_payload_tests {
    use crate::features::agent::acp::client::cancelled_payload;
    use std::sync::{Arc, Mutex};

    #[test]
    fn refused_resume_does_not_reuse_the_warm_socket() {
        assert!(!super::reuse_warm_pool(false, Some("old"), None));
        assert!(!super::reuse_warm_pool(true, None, None));
        assert!(super::reuse_warm_pool(false, Some("same"), Some("same")));
        assert!(super::reuse_warm_pool(false, None, None));
    }

    #[test]
    fn undelivered_prompt_is_retryable() {
        assert!(super::prompt_was_not_delivered(
            "prompt: Internal error: \"failed to send outgoing request session/prompt: connection is no longer running\""
        ));
        assert!(!super::prompt_was_not_delivered(
            "prompt: model rejected the request"
        ));
    }

    #[test]
    fn preserves_provider_session_id_after_cancel() {
        let content = Arc::new(Mutex::new("partial answer".to_string()));
        let thought = Arc::new(Mutex::new(String::new()));
        let payload = cancelled_payload(
            "runtime-session".to_string(),
            "message".to_string(),
            Some("provider-session".to_string()),
            &content,
            &thought,
        );

        assert_eq!(payload.stop_reason.as_deref(), Some("cancelled"));
        assert_eq!(
            payload.provider_session_id.as_deref(),
            Some("provider-session")
        );
        assert_eq!(payload.content, "partial answer");
    }
}
