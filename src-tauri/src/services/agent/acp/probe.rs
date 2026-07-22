//! ACP capability probe and background warm-up (no user prompt).

use super::*;

/// Spawn agent, initialize ACP, report agent info. Does not send a user prompt.
/// When `remote` is set, the agent process is launched on the remote host (SSH).
pub async fn probe_agent(
    desc: &AgentDescriptor,
    remote: Option<&crate::services::remote::RemoteAgentTarget>,
) -> ProbeResult {
    let agent_id = desc.id.clone();
    let acp = match to_acp_agent(desc, remote) {
        Ok(a) => a,
        Err(e) => {
            return ProbeResult {
                agent_id,
                available: false,
                agent_name: None,
                protocol_version: None,
                error: Some(e.to_string()),
                session_capabilities: None,
            };
        }
    };

    let captured: Arc<Mutex<Option<(String, String, AcpSessionCapabilities)>>> =
        Arc::new(Mutex::new(None));
    let captured_clone = captured.clone();

    let connect = agent_client_protocol::Client
        .builder()
        .name("agentero")
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _cx| {
                let _ = responder.respond(permission_response(&request, false));
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(acp, {
            let captured = captured_clone;
            move |connection: ConnectionTo<Agent>| async move {
                let init = connection
                    .send_request(InitializeRequest::new(ProtocolVersion::V1))
                    .block_task()
                    .await
                    .map_err(|e| acp_err(format!("initialize failed: {e}")))?;

                let name = init
                    .agent_info
                    .as_ref()
                    .map(|i| i.name.clone())
                    .unwrap_or_else(|| "unknown".into());
                let version = format!("{:?}", init.protocol_version);
                let session_caps = {
                    let sc = &init.agent_capabilities.session_capabilities;
                    AcpSessionCapabilities {
                        list: sc.list.is_some(),
                        resume: sc.resume.is_some(),
                        load: init.agent_capabilities.load_session,
                        delete: sc.delete.is_some(),
                    }
                };
                if let Ok(mut g) = captured.lock() {
                    *g = Some((name, version, session_caps));
                }
                Ok(())
            }
        });

    let result = match tokio::time::timeout(ACP_TIMEOUT, connect).await {
        Ok(r) => r,
        Err(_) => {
            return ProbeResult {
                agent_id,
                available: false,
                agent_name: None,
                protocol_version: None,
                error: Some(format!(
                    "probe timed out after {}s (check Agent proxy / network)",
                    ACP_TIMEOUT.as_secs()
                )),
                session_capabilities: None,
            };
        }
    };

    match result {
        Ok(()) => {
            let info = captured.lock().ok().and_then(|g| g.clone());
            match info {
                Some((name, version, session_caps)) => ProbeResult {
                    agent_id,
                    available: true,
                    agent_name: Some(name),
                    protocol_version: Some(version),
                    error: None,
                    session_capabilities: Some(session_caps),
                },
                None => ProbeResult {
                    agent_id,
                    available: false,
                    agent_name: None,
                    protocol_version: None,
                    error: Some("no initialize response".into()),
                    session_capabilities: None,
                },
            }
        }
        Err(e) => ProbeResult {
            agent_id,
            available: false,
            agent_name: None,
            protocol_version: None,
            error: Some(e.to_string()),
            session_capabilities: None,
        },
    }
}

/// Background warm-up: spawn ACP → initialize → new_session → emit models/usage (no prompt).
/// Used when Chat opens so the model selector and context meter are ready before first send.
pub async fn warm_agent(
    app: AgentEventEmitter,
    desc: AgentDescriptor,
    vault_path: Option<String>,
    preferred_model_id: Option<String>,
    remote: Option<crate::services::remote::RemoteAgentTarget>,
) -> WarmResult {
    let agent_id = desc.id.clone();
    let session_id = Uuid::new_v4().to_string();
    let cwd = if let Some(ref r) = remote {
        r.agent_cwd()
    } else {
        vault_path
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    };

    let acp = match to_acp_agent(&desc, remote.as_ref()) {
        Ok(a) => a,
        Err(e) => {
            return WarmResult {
                agent_id,
                ok: false,
                models: None,
                usage_used: None,
                usage_size: None,
                error: Some(e.to_string()),
            };
        }
    };

    let models_out: Arc<Mutex<Option<AgentModelsEvent>>> = Arc::new(Mutex::new(None));
    let usage_out: Arc<Mutex<Option<(u64, u64)>>> = Arc::new(Mutex::new(None));
    let models_for_conn = models_out.clone();
    let usage_for_notif = usage_out.clone();
    let app_for_notif = app.clone();
    let session_for_notif = session_id.clone();
    let agent_for_notif = agent_id.clone();

    let preferred = preferred_model_id.clone();
    let app_for_conn = app.clone();
    let session_for_conn = session_id.clone();
    let agent_for_conn = agent_id.clone();

    let result = agent_client_protocol::Client
        .builder()
        .name("agentero")
        .on_receive_notification(
            async move |notification: SessionNotification, _cx| {
                if let SessionUpdate::UsageUpdate(u) = &notification.update {
                    if let Ok(mut g) = usage_for_notif.lock() {
                        *g = Some((u.used, u.size));
                    }
                    let _ = app_for_notif.emit(
                        "agent:usage",
                        AgentUsageEvent {
                            session_id: session_for_notif.clone(),
                            used: u.used,
                            size: u.size,
                        },
                    );
                }
                if let SessionUpdate::ConfigOptionUpdate(upd) = &notification.update {
                    emit_session_config_options(
                        &app_for_notif,
                        &session_for_notif,
                        &agent_for_notif,
                        &upd.config_options,
                    );
                }
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _cx| {
                let _ = responder.respond(permission_response(&request, false));
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(acp, {
            let preferred = preferred.clone();
            let models_for_conn = models_for_conn.clone();
            move |connection: ConnectionTo<Agent>| async move {
                timed_acp_request(
                    "initialize",
                    connection
                        .send_request(InitializeRequest::new(ProtocolVersion::V1))
                        .block_task(),
                )
                .await?;

                let new_session = timed_acp_request(
                    "new_session",
                    connection
                        .send_request(NewSessionRequest::new(cwd))
                        .block_task(),
                )
                .await?;

                let acp_session_id = new_session.session_id;
                let mut config_options = new_session.config_options.unwrap_or_default();
                if let Some(ev) =
                    models_from_config_options(&session_for_conn, &agent_for_conn, &config_options)
                {
                    if let Some(pref) = preferred.clone() {
                        if pref != ev.current_id && ev.models.iter().any(|m| m.id == pref) {
                            if let Ok(response) = timed_acp_request(
                                "set model",
                                connection
                                    .send_request(SetSessionConfigOptionRequest::new(
                                        acp_session_id.clone(),
                                        SessionConfigId::new(ev.config_id.as_str()),
                                        SessionConfigOptionValue::value_id(pref),
                                    ))
                                    .block_task(),
                            )
                            .await
                            {
                                config_options = response.config_options;
                            }
                        }
                    }
                }
                emit_session_config_options(
                    &app_for_conn,
                    &session_for_conn,
                    &agent_for_conn,
                    &config_options,
                );
                if let Some(ev) =
                    models_from_config_options(&session_for_conn, &agent_for_conn, &config_options)
                {
                    if let Ok(mut g) = models_for_conn.lock() {
                        *g = Some(ev);
                    }
                }

                // Brief settle so agents can push usage/config updates after session create.
                tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                Ok(())
            }
        })
        .await;

    match result {
        Ok(()) => {
            let models = models_out.lock().ok().and_then(|g| g.clone());
            let usage = usage_out.lock().ok().and_then(|g| *g);
            WarmResult {
                agent_id,
                ok: true,
                models,
                usage_used: usage.map(|(u, _)| u),
                usage_size: usage.map(|(_, s)| s),
                error: None,
            }
        }
        Err(e) => WarmResult {
            agent_id,
            ok: false,
            models: None,
            usage_used: None,
            usage_size: None,
            error: Some(e.to_string()),
        },
    }
}
