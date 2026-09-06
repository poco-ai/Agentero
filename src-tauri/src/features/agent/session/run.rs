//! Single-turn ACP run orchestration (prompt → session → stream → complete).

use crate::core::error::AppError;
use crate::features::agent::acp::ask_user::GrokAskUserRequest;
use crate::features::agent::acp::client::{
    acp_err, cancelled_payload, client_initialize_request, simplified_agent_cwd,
    timed_acp_initialize, timed_acp_request, to_acp_agent, wait_for_cancellation,
};
use crate::features::agent::acp::interaction::{
    await_grok_ask_user, await_user_elicitation, await_user_permission, permission_response,
    PermissionPolicy,
};
use crate::features::agent::acp::terminal::{AcpTerminalHandler, AcpTerminalManager};
use crate::features::agent::acp::updates::{
    collaboration_from_config_options, effort_from_config_options, emit_rich_session_update,
    emit_session_config_options, fast_mode_value_to_set, is_fast_option, is_pi_startup_banner,
    models_from_config_options, stream_from_update,
};
use crate::features::agent::models::{
    AgentDescriptor, AgentFailedEvent, AgentResultPayload, AgentStreamEvent, AgentStreamKind,
    AgentTemplate, PromptImage,
};
use crate::features::agent::prompt::envelope::{build_prompt, extract_sources};
use crate::features::agent::prompt::skills::{
    load_skill_instructions, skill_activation_prefix, skill_mention_style,
};
use crate::features::agent::runtime::events::AgentEventEmitter;
use crate::features::agent::runtime::gates::{AskUserGate, ElicitationGate, PermissionGate};
use crate::features::agent::runtime::stream::{StreamCoalescer, STREAM_COALESCE_WINDOW};
use crate::features::agent::session::config::RunPreferences;
use agent_client_protocol::schema::v1::{
    CancelNotification, ContentBlock, CreateElicitationRequest, ImageContent, LoadSessionRequest,
    NewSessionRequest, PromptRequest, RequestPermissionRequest, ResumeSessionRequest,
    SessionConfigId, SessionConfigOptionValue, SessionId, SessionNotification, SessionUpdate,
    SetSessionConfigOptionRequest, TextContent,
};
use agent_client_protocol::{Agent, ConnectionTo};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::watch;
use uuid::Uuid;

/// Input for one `run_once` turn. Collapses the previous 24 positional params.
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
    pub preferred_collaboration_mode_id: Option<String>,
    pub preferred_reasoning_effort: Option<String>,
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
}

/// Prompt/cwd prepared before any ACP I/O.
struct RunTurnPrep {
    full_prompt: String,
    prompt_images: Vec<PromptImage>,
    cwd: PathBuf,
}

/// Everything the connection turn needs beyond the shared state.
struct RunTurnInput {
    full_prompt: String,
    prompt_images: Vec<PromptImage>,
    cwd: PathBuf,
    /// Provider session id to continue (resume/load) instead of `session/new`.
    resume_session_id: Option<String>,
    preferences: RunPreferences,
}

/// Session established by the connect phase of a turn.
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
/// local skill cannot be loaded.
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
                emit_run_failed(&params.app, &params.session_id, &error);
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
    let prompt_images = params.images.clone();
    let cwd = simplified_agent_cwd(&if let Some(ref r) = params.remote {
        r.agent_cwd()
    } else {
        params
            .vault_path
            .as_ref()
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    });
    Ok(RunTurnPrep {
        full_prompt,
        prompt_images,
        cwd,
    })
}

/// Shared state for one `run_once` turn, cloned into the ACP notification /
/// permission / elicitation handlers and the connection turn future.
#[derive(Clone)]
struct RunOnceContext {
    app: AgentEventEmitter,
    session_id: String,
    message_id: String,
    agent_id: String,
    /// pi-acp forwards a CLI startup banner that must be dropped from the stream.
    is_pi: bool,
    /// dsh keeps sessions in-process and never advertises resume/load, so a
    /// requested continue degrades to a fresh session — always stream live.
    dsh_fresh_sessions: bool,
    content_buf: Arc<Mutex<String>>,
    thought_buf: Arc<Mutex<String>>,
    coalescer: StreamCoalescer,
    /// session/load (and some resume paths) replay history as SessionNotification.
    /// Until we open the gate, drop stream/tool/plan so turn N does not re-paint
    /// turn N-1 into the new streaming bubble (Grok multi-turn).
    live_stream: Arc<AtomicBool>,
    stop_reason: Arc<Mutex<Option<String>>>,
    /// Terminal capability: headless command execution on behalf of the agent.
    terminals: Arc<tokio::sync::Mutex<AcpTerminalManager>>,
}

impl RunOnceContext {
    fn new(params: &RunOnceParams, cwd: std::path::PathBuf) -> Self {
        let dsh_fresh_sessions = matches!(params.desc.template, AgentTemplate::Dsh);
        // Merge token-storm chunks into ~25 emits/s (Windows webview jank source).
        // Payload shape is unchanged: same event, longer `chunk`, lower rate.
        let coalescer = StreamCoalescer::new(STREAM_COALESCE_WINDOW, {
            let app = params.app.clone();
            let session_id = params.session_id.clone();
            move |chunk, kind| {
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
            dsh_fresh_sessions,
            content_buf: Arc::new(Mutex::new(String::new())),
            thought_buf: Arc::new(Mutex::new(String::new())),
            coalescer,
            live_stream: Arc::new(AtomicBool::new(
                params.resume_session_id.is_none() || dsh_fresh_sessions,
            )),
            stop_reason: Arc::new(Mutex::new(None)),
            terminals: Arc::new(tokio::sync::Mutex::new(AcpTerminalManager::with_cwd(cwd))),
        }
    }

    /// Relay one `SessionNotification`: buffer + coalesce stream chunks, and
    /// forward rich updates (tool/plan/usage/config/commands) to the webview.
    fn relay_session_notification(&self, notification: &SessionNotification) {
        if !self.live_stream.load(Ordering::SeqCst) {
            // Still allow usage / command / config during load settle.
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
                    }
                    AgentStreamKind::Thought => {
                        if let Ok(mut buf) = self.thought_buf.lock() {
                            buf.push_str(&chunk);
                        }
                    }
                }
                self.coalescer.push(&chunk, kind);
            }
        } else {
            // Non-chunk update (tool/plan/…): flush buffered text first
            // so the transcript order stays text → tool/plan.
            self.coalescer.flush();
        }
        emit_rich_session_update(&self.app, &self.session_id, &self.agent_id, notification);
    }

    /// Flush buffered stream text, then emit `agent:completed` (ordered after text).
    fn emit_completed(&self, payload: AgentResultPayload) -> AgentResultPayload {
        self.coalescer.flush();
        let _ = self.app.emit("agent:completed", payload.clone());
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
            resume_session_id,
            preferred_model_id,
            preferred_collaboration_mode_id,
            preferred_reasoning_effort,
            fast_mode,
            ..
        } = params;
        let turn = RunTurnInput {
            full_prompt: prep.full_prompt,
            prompt_images: prep.prompt_images,
            cwd: prep.cwd,
            resume_session_id,
            preferences: RunPreferences {
                model_id: preferred_model_id,
                collaboration_mode_id: preferred_collaboration_mode_id,
                reasoning_effort: preferred_reasoning_effort,
                fast_mode,
            },
        };

        agent_client_protocol::Client
            .builder()
            .name("agentero")
            .with_handler(AcpTerminalHandler::new(self.terminals.clone()))
            .on_receive_notification(
                {
                    let state = self.clone();
                    async move |notification: SessionNotification, _cx| {
                        state.relay_session_notification(&notification);
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_request(
                {
                    let state = self.clone();
                    async move |request: RequestPermissionRequest, responder, _cx| {
                        let response = match permission_policy {
                            PermissionPolicy::Restricted => permission_response(&request, false),
                            PermissionPolicy::Auto => permission_response(&request, true),
                            PermissionPolicy::Ask => {
                                await_user_permission(
                                    &state.app,
                                    &permission_gate,
                                    &state.session_id,
                                    &request,
                                )
                                .await
                            }
                        };
                        let _ = responder.respond(response);
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let state = self.clone();
                    async move |request: CreateElicitationRequest, responder, _cx| {
                        let response = await_user_elicitation(
                            &state.app,
                            &elicitation_gate,
                            &state.session_id,
                            &request,
                        )
                        .await;
                        let _ = responder.respond(response);
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let state = self.clone();
                    async move |request: GrokAskUserRequest, responder, _cx| {
                        let response = await_grok_ask_user(
                            &state.app,
                            &ask_user_gate,
                            &state.session_id,
                            &request,
                        )
                        .await;
                        let _ = responder.respond(response);
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
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
            preferences,
        } = turn;

        let session = match self
            .connect_session(&connection, &mut cancellation, resume_session_id, &cwd)
            .await?
        {
            TurnPhase::Ready(session) => session,
            TurnPhase::Cancelled(payload) => return Ok(payload),
        };
        let config_options = match self
            .apply_session_preferences(
                &connection,
                &mut cancellation,
                &session.acp_session_id,
                session.config_options,
                &preferences,
            )
            .await?
        {
            TurnPhase::Ready(options) => options,
            TurnPhase::Cancelled(payload) => return Ok(payload),
        };
        emit_session_config_options(&self.app, &self.session_id, &self.agent_id, &config_options);

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

        let prompt_response = tokio::select! {
            response = connection
                .send_request(PromptRequest::new(
                    session.acp_session_id.clone(),
                    content_blocks,
                ))
                .block_task() => response.map_err(|e| acp_err(format!("prompt: {e}")))?,
            () = wait_for_cancellation(&mut cancellation) => {
                let _ = connection
                    .send_notification(CancelNotification::new(session.acp_session_id.clone()));
                return Ok(self.cancel_completed(Some(session.acp_session_id.to_string())));
            }
        };

        if let Ok(mut s) = self.stop_reason.lock() {
            *s = Some(format!("{:?}", prompt_response.stop_reason));
        }

        Ok(self.finalize(&session.acp_session_id))
    }

    /// Connect phase: `initialize`, then open a session via `session/resume`,
    /// `session/load`, or `session/new` (capability-aware).
    async fn connect_session(
        &self,
        connection: &ConnectionTo<Agent>,
        cancellation: &mut watch::Receiver<bool>,
        resume_session_id: Option<String>,
        cwd: &Path,
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

        // dsh never advertises session/resume or session/load (sessions
        // die with the process), so continue degrades to a fresh session
        // instead of erroring out.
        let resume_id = if let Some(rid) = &resume_session_id {
            if can_resume || can_load {
                resume_session_id
            } else if self.dsh_fresh_sessions {
                log::debug!(
                    target: "agentero::agent",
                    "dsh cannot resume {rid}: starting a fresh session"
                );
                None
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
            if can_resume {
                let resp = tokio::select! {
                    result = timed_acp_request(
                        "session/resume",
                        connection
                            .send_request(ResumeSessionRequest::new(
                                SessionId::new(rid.as_str()),
                                cwd.to_path_buf(),
                            ))
                            .block_task(),
                    ) => result?,
                    () = wait_for_cancellation(&mut *cancellation) => {
                        return Ok(TurnPhase::Cancelled(self.cancel_completed(Some(rid.clone()))));
                    }
                };
                (
                    SessionId::new(rid.as_str()),
                    resp.config_options.unwrap_or_default(),
                )
            } else {
                // resume_id is Some only when can_resume || can_load.
                // Grok and similar: continue across process restarts via
                // session/load (requires mcpServers; schema defaults to []).
                let resp = tokio::select! {
                    result = timed_acp_request(
                        "session/load",
                        connection
                            .send_request(
                                LoadSessionRequest::new(
                                    SessionId::new(rid.as_str()),
                                    cwd.to_path_buf(),
                                )
                                .mcp_servers(vec![]),
                            )
                            .block_task(),
                    ) => result?,
                    () = wait_for_cancellation(&mut *cancellation) => {
                        return Ok(TurnPhase::Cancelled(self.cancel_completed(Some(rid.clone()))));
                    }
                };
                (
                    SessionId::new(rid.as_str()),
                    resp.config_options.unwrap_or_default(),
                )
            }
        } else {
            let new_session = tokio::select! {
                result = timed_acp_request(
                    "new_session",
                    connection
                        .send_request(NewSessionRequest::new(cwd.to_path_buf()))
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
        if let Some(ev) =
            models_from_config_options(&self.session_id, &self.agent_id, &config_options)
        {
            // Model changes can affect supported effort and service tiers, so retain the
            // complete response before resolving the remaining preferences.
            // Also attempt custom / third-party model ids not in the advertised catalog
            // (gateway models, cc-switch, free-form provider ids).
            if let Some(pref) = prefs.model_id.clone() {
                if pref != ev.current_id {
                    let listed = ev.models.iter().any(|m| m.id == pref);
                    let response = tokio::select! {
                        result = timed_acp_request(
                            "set model",
                            connection
                                .send_request(SetSessionConfigOptionRequest::new(
                                    acp_session_id.clone(),
                                    SessionConfigId::new(ev.config_id.as_str()),
                                    SessionConfigOptionValue::value_id(pref.clone()),
                                ))
                                .block_task(),
                        ) => result,
                        () = wait_for_cancellation(&mut *cancellation) => return_cancelled!(),
                    };
                    match response {
                        Ok(response) => {
                            config_options = response.config_options;
                        }
                        Err(e) => {
                            log::debug!(
                                target: "agentero::agent",
                                "agent={} set model failed (listed={}): pref={} err={}",
                                self.agent_id,
                                listed,
                                pref,
                                e
                            );
                        }
                    }
                }
            }
        }
        if let Some(pref) = prefs.collaboration_mode_id.clone() {
            if let Some(ev) =
                collaboration_from_config_options(&self.session_id, &self.agent_id, &config_options)
            {
                if pref != ev.current_id && ev.modes.iter().any(|mode| mode.id == pref) {
                    let response = tokio::select! {
                        result = timed_acp_request(
                            "set collaboration mode",
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
        if let Some(pref) = prefs.reasoning_effort.clone() {
            if let Some(ev) =
                effort_from_config_options(&self.session_id, &self.agent_id, &config_options)
            {
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
        let sources = extract_sources(&content);
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

/// One-shot prompt: spawn → initialize → session → prompt → stream events → completed/failed.
pub async fn run_once(params: RunOnceParams) -> Result<AgentResultPayload, AppError> {
    // Phase 1 — prompt: skill instructions + template envelope + cwd.
    let prep = prepare_run_turn(&params).await?;

    // Phase 2 — spawn the ACP agent process (local, or SSH wrapper for remote).
    let acp = match to_acp_agent(&params.desc, Some(&prep.cwd), params.remote.as_deref()) {
        Ok(agent) => agent,
        Err(error) => {
            emit_run_failed(&params.app, &params.session_id, &error);
            return Err(error);
        }
    };

    // Phase 3 — connect, stream one turn, and finalize.
    let state = RunOnceContext::new(&params, prep.cwd.clone());
    let run_result = state.run(acp, params, prep).await;

    match run_result {
        Ok(payload) => Ok(payload),
        Err(e) => {
            let msg = e.to_string();
            state.coalescer.flush();
            emit_run_failed(&state.app, &state.session_id, &msg);
            Err(AppError::domain("acp", format!("acp: {msg}")))
        }
    }
}

pub fn new_ids() -> (String, String) {
    (Uuid::new_v4().to_string(), Uuid::new_v4().to_string())
}

#[cfg(test)]
mod cancelled_payload_tests {
    use crate::features::agent::acp::client::cancelled_payload;
    use std::sync::{Arc, Mutex};

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
