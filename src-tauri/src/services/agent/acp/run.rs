//! One-shot ACP prompt run: spawn → initialize → session → prompt → stream.

use super::*;

/// One-shot prompt: spawn → initialize → session → prompt → stream events → completed/failed.
#[allow(clippy::too_many_arguments)]
pub async fn run_once(
    app: AgentEventEmitter,
    desc: AgentDescriptor,
    session_id: String,
    message_id: String,
    prompt: String,
    images: Vec<PromptImage>,
    workflow: Option<String>,
    target: Option<String>,
    vault_path: Option<String>,
    preferred_model_id: Option<String>,
    preferred_reasoning_effort: Option<String>,
    fast_mode: Option<bool>,
    skill_ids: Vec<String>,
    permission_policy: PermissionPolicy,
    permission_gate: PermissionGate,
    response_language: Option<String>,
    personal_prompt: Option<String>,
    mut cancellation: watch::Receiver<bool>,
    remote: Option<crate::services::remote::RemoteAgentTarget>,
    resume_session_id: Option<String>,
) -> Result<AgentResultPayload, AppError> {
    let skill_style = skill_mention_style(&desc.template);
    // Skills: local vault path, or remote work_root after materializing SKILL.md from SFTP.
    let skill_vault = if let Some(ref r) = remote {
        if let Err(e) = crate::services::remote::materialize_skills_to_work(&r.session).await {
            log::warn!(target: "agentero::agent", "materialize remote skills: {e}");
        }
        Some(r.work_root.to_string_lossy().into_owned())
    } else {
        vault_path.clone()
    };
    let skill_instructions =
        match load_skill_instructions(&skill_ids, skill_vault.as_deref(), skill_style) {
            Ok(instructions) => instructions,
            Err(error) => {
                let _ = app.emit(
                    "agent:failed",
                    AgentFailedEvent {
                        session_id,
                        error: error.to_string(),
                    },
                );
                return Err(error);
            }
        };
    let user_prompt = if prompt.trim().is_empty() && !images.is_empty() {
        "Please analyze the attached image crop from the research paper PDF.".to_string()
    } else {
        prompt
    };
    // Prefix native skill triggers (e.g. Codex `$id`) so the CLI can activate them.
    let activation = skill_activation_prefix(&skill_ids, skill_style);
    let user_prompt = format!("{activation}{user_prompt}");
    let full_prompt = format!(
        "{}{}",
        build_prompt(
            workflow.as_deref(),
            &user_prompt,
            target.as_deref(),
            skill_style,
            &skill_ids,
            response_language.as_deref(),
            personal_prompt.as_deref(),
        ),
        skill_instructions
    );
    let prompt_images = images;
    let cwd = if let Some(ref r) = remote {
        r.agent_cwd()
    } else {
        vault_path
            .as_ref()
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    };

    let acp = match to_acp_agent(&desc, remote.as_ref()) {
        Ok(agent) => agent,
        Err(error) => {
            let _ = app.emit(
                "agent:failed",
                AgentFailedEvent {
                    session_id,
                    error: error.to_string(),
                },
            );
            return Err(error);
        }
    };
    let content_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let thought_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let content_for_notif = content_buf.clone();
    let thought_for_notif = thought_buf.clone();
    let app_for_notif = app.clone();
    let session_for_notif = session_id.clone();
    let agent_id_for_notif = desc.id.clone();

    let stop_reason: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let stop_for_conn = stop_reason.clone();
    let content_for_conn = content_buf.clone();
    let thought_for_conn = thought_buf.clone();
    let session_for_conn = session_id.clone();
    let message_for_conn = message_id.clone();
    let app_for_conn = app.clone();
    let app_for_perm = app.clone();
    let session_for_perm = session_id.clone();

    let run_result = agent_client_protocol::Client
        .builder()
        .name("agentero")
        .on_receive_notification(
            async move |notification: SessionNotification, _cx| {
                if let Some((chunk, kind)) = stream_from_update(&notification.update) {
                    match kind {
                        AgentStreamKind::Message => {
                            if let Ok(mut buf) = content_for_notif.lock() {
                                buf.push_str(&chunk);
                            }
                        }
                        AgentStreamKind::Thought => {
                            if let Ok(mut buf) = thought_for_notif.lock() {
                                buf.push_str(&chunk);
                            }
                        }
                    }
                    let _ = app_for_notif.emit(
                        "agent:stream",
                        AgentStreamEvent {
                            session_id: session_for_notif.clone(),
                            chunk,
                            kind,
                        },
                    );
                }
                emit_rich_session_update(
                    &app_for_notif,
                    &session_for_notif,
                    &agent_id_for_notif,
                    &notification.update,
                );
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _cx| {
                let response = match permission_policy {
                    PermissionPolicy::Restricted => permission_response(&request, false),
                    PermissionPolicy::Auto => permission_response(&request, true),
                    PermissionPolicy::Ask => {
                        await_user_permission(
                            &app_for_perm,
                            &permission_gate,
                            &session_for_perm,
                            &request,
                        )
                        .await
                    }
                };
                let _ = responder.respond(response);
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(acp, {
            let full_prompt = full_prompt.clone();
            let prompt_images = prompt_images.clone();
            let preferred_model = preferred_model_id.clone();
            let preferred_effort = preferred_reasoning_effort.clone();
            let app_for_models = app_for_conn.clone();
            let session_for_models = session_for_conn.clone();
            let agent_id_for_models = desc.id.clone();
            let resume_id = resume_session_id.clone();
            move |connection: ConnectionTo<Agent>| async move {
                tokio::select! {
                    result = timed_acp_request(
                        "initialize",
                        connection
                            .send_request(InitializeRequest::new(ProtocolVersion::V1))
                            .block_task(),
                    ) => { result?; }
                    () = wait_for_cancellation(&mut cancellation) => {
                        let payload = cancelled_payload(
                            session_for_conn.clone(),
                            message_for_conn.clone(),
                            &content_for_conn,
                            &thought_for_conn,
                        );
                        let _ = app_for_conn.emit("agent:completed", payload.clone());
                        return Ok(payload);
                    }
                }

                let (acp_session_id, mut config_options) = if let Some(ref rid) = resume_id {
                    let resp = tokio::select! {
                        result = timed_acp_request(
                            "resume_session",
                            connection
                                .send_request(ResumeSessionRequest::new(
                                    SessionId::new(rid.as_str()),
                                    cwd.clone(),
                                ))
                                .block_task(),
                        ) => result?,
                        () = wait_for_cancellation(&mut cancellation) => {
                            let payload = cancelled_payload(
                                session_for_conn.clone(),
                                message_for_conn.clone(),
                                &content_for_conn,
                                &thought_for_conn,
                            );
                            let _ = app_for_conn.emit("agent:completed", payload.clone());
                            return Ok(payload);
                        }
                    };
                    (
                        SessionId::new(rid.as_str()),
                        resp.config_options.unwrap_or_default(),
                    )
                } else {
                    let new_session = tokio::select! {
                        result = timed_acp_request(
                            "new_session",
                            connection.send_request(NewSessionRequest::new(cwd)).block_task(),
                        ) => result?,
                        () = wait_for_cancellation(&mut cancellation) => {
                            let payload = cancelled_payload(
                                session_for_conn.clone(),
                                message_for_conn.clone(),
                                &content_for_conn,
                                &thought_for_conn,
                            );
                            let _ = app_for_conn.emit("agent:completed", payload.clone());
                            return Ok(payload);
                        }
                    };
                    (
                        new_session.session_id,
                        new_session.config_options.unwrap_or_default(),
                    )
                };
                macro_rules! return_cancelled {
                    () => {{
                        let payload = cancelled_payload(
                            session_for_conn.clone(),
                            message_for_conn.clone(),
                            &content_for_conn,
                            &thought_for_conn,
                        );
                        let _ = app_for_conn.emit("agent:completed", payload.clone());
                        return Ok(payload);
                    }};
                }
                if let Some(ev) = models_from_config_options(
                    &session_for_models,
                    &agent_id_for_models,
                    &config_options,
                ) {
                    // Model changes can affect supported effort and service tiers, so retain the
                    // complete response before resolving the remaining preferences.
                    if let Some(pref) = preferred_model.clone() {
                        if pref != ev.current_id && ev.models.iter().any(|m| m.id == pref) {
                            let response = tokio::select! {
                                result = timed_acp_request(
                                    "set model",
                                    connection
                                        .send_request(SetSessionConfigOptionRequest::new(
                                            acp_session_id.clone(),
                                            SessionConfigId::new(ev.config_id.as_str()),
                                            SessionConfigOptionValue::value_id(pref),
                                        ))
                                        .block_task(),
                                ) => result.ok(),
                                () = wait_for_cancellation(&mut cancellation) => return_cancelled!(),
                            };
                            if let Some(response) = response {
                                config_options = response.config_options;
                            }
                        }
                    }
                }
                if let Some(pref) = preferred_effort.clone() {
                    if let Some(ev) = effort_from_config_options(
                        &session_for_models,
                        &agent_id_for_models,
                        &config_options,
                    ) {
                        if pref != ev.current_id
                            && ev.efforts.iter().any(|effort| effort.id == pref)
                        {
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
                                () = wait_for_cancellation(&mut cancellation) => return_cancelled!(),
                            };
                            if let Some(response) = response {
                                config_options = response.config_options;
                            }
                        }
                    }
                }
                if let Some(enabled) = fast_mode {
                    if let Some(opt) = config_options.iter().find(|opt| is_fast_option(opt)) {
                        let value = match &opt.kind {
                            SessionConfigKind::Boolean(_) => {
                                Some(SessionConfigOptionValue::boolean(enabled))
                            }
                            SessionConfigKind::Select(_) => {
                                Some(SessionConfigOptionValue::value_id(if enabled {
                                    "on"
                                } else {
                                    "off"
                                }))
                            }
                            _ => None,
                        };
                        if let Some(value) = value {
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
                                () = wait_for_cancellation(&mut cancellation) => return_cancelled!(),
                            };
                            if let Some(response) = response {
                                config_options = response.config_options;
                            }
                        }
                    }
                }
                emit_session_config_options(
                    &app_for_models,
                    &session_for_models,
                    &agent_id_for_models,
                    &config_options,
                );

                if *cancellation.borrow() {
                    let _ = connection
                        .send_notification(CancelNotification::new(acp_session_id.clone()));
                    let payload = cancelled_payload(
                        session_for_conn.clone(),
                        message_for_conn.clone(),
                        &content_for_conn,
                        &thought_for_conn,
                    );
                    let _ = app_for_conn.emit("agent:completed", payload.clone());
                    return Ok(payload);
                }

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
                            acp_session_id.clone(),
                            content_blocks,
                        ))
                        .block_task() => response.map_err(|e| acp_err(format!("prompt: {e}")))?,
                    () = wait_for_cancellation(&mut cancellation) => {
                        let _ = connection
                            .send_notification(CancelNotification::new(acp_session_id));
                        let payload = cancelled_payload(
                            session_for_conn.clone(),
                            message_for_conn.clone(),
                            &content_for_conn,
                            &thought_for_conn,
                        );
                        let _ = app_for_conn.emit("agent:completed", payload.clone());
                        return Ok(payload);
                    }
                };

                if let Ok(mut s) = stop_for_conn.lock() {
                    *s = Some(format!("{:?}", prompt_response.stop_reason));
                }

                let content = content_for_conn
                    .lock()
                    .map(|g| g.clone())
                    .unwrap_or_default();
                let reasoning = thought_for_conn
                    .lock()
                    .map(|g| g.clone())
                    .unwrap_or_default();
                let sources = extract_sources(&content);
                let payload = AgentResultPayload {
                    session_id: session_for_conn.clone(),
                    message_id: message_for_conn.clone(),
                    content,
                    reasoning: if reasoning.is_empty() {
                        None
                    } else {
                        Some(reasoning)
                    },
                    sources,
                    stop_reason: stop_for_conn.lock().ok().and_then(|g| g.clone()),
                    provider_session_id: Some(acp_session_id.to_string()),
                };
                let _ = app_for_conn.emit("agent:completed", payload.clone());
                Ok(payload)
            }
        })
        .await;

    match run_result {
        Ok(payload) => Ok(payload),
        Err(e) => {
            let msg = e.to_string();
            let _ = app.emit(
                "agent:failed",
                AgentFailedEvent {
                    session_id: session_id.clone(),
                    error: msg.clone(),
                },
            );
            Err(AppError::Acp(msg))
        }
    }
}
