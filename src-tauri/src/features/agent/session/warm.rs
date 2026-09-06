//! Background ACP warm-up (initialize + new_session, no prompt).

use crate::features::agent::acp::client::{
    client_initialize_request, simplified_agent_cwd, timed_acp_initialize, timed_acp_request,
    to_acp_agent,
};
use crate::features::agent::acp::interaction::permission_response;
use crate::features::agent::acp::terminal::{AcpTerminalHandler, AcpTerminalManager};
use crate::features::agent::acp::updates::{
    collaboration_from_config_options, emit_rich_session_update, emit_session_config_options,
    models_from_config_options,
};
use crate::features::agent::models::{
    AgentDescriptor, AgentModelsEvent, AgentUsageEvent, WarmResult,
};
use crate::features::agent::runtime::events::AgentEventEmitter;
use agent_client_protocol::schema::v1::{
    NewSessionRequest, RequestPermissionRequest, SessionConfigId, SessionConfigOptionValue,
    SessionNotification, SessionUpdate, SetSessionConfigOptionRequest,
};
use agent_client_protocol::{Agent, ConnectionTo};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

/// Background warm-up: spawn ACP → initialize → new_session → emit models/usage (no prompt).
/// Used when Chat opens so the model selector and context meter are ready before first send.
pub async fn warm_agent(
    app: AgentEventEmitter,
    desc: AgentDescriptor,
    vault_path: Option<String>,
    preferred_model_id: Option<String>,
    preferred_collaboration_mode_id: Option<String>,
    remote: Option<Arc<dyn crate::features::agent::remote_host::RemoteAgentLaunch>>,
) -> WarmResult {
    let agent_id = desc.id.clone();
    let session_id = Uuid::new_v4().to_string();
    let cwd = simplified_agent_cwd(&if let Some(ref r) = remote {
        r.agent_cwd()
    } else {
        vault_path
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    });

    let acp = match to_acp_agent(&desc, Some(&cwd), remote.as_deref()) {
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
    let preferred_collaboration = preferred_collaboration_mode_id.clone();
    let app_for_conn = app.clone();
    let session_for_conn = session_id.clone();
    let agent_for_conn = agent_id.clone();
    let terminals = Arc::new(tokio::sync::Mutex::new(AcpTerminalManager::with_cwd(
        cwd.clone(),
    )));

    let result = agent_client_protocol::Client
        .builder()
        .name("agentero")
        .with_handler(AcpTerminalHandler::new(terminals))
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
                if let SessionUpdate::AvailableCommandsUpdate(_) = &notification.update {
                    emit_rich_session_update(
                        &app_for_notif,
                        &session_for_notif,
                        &agent_for_notif,
                        &notification,
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
            let preferred_collaboration = preferred_collaboration.clone();
            let models_for_conn = models_for_conn.clone();
            move |connection: ConnectionTo<Agent>| async move {
                timed_acp_initialize(
                    connection
                        .send_request(client_initialize_request())
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
                    // Attempt preferred model even when not in the advertised catalog
                    // (third-party / gateway free-form ids).
                    if let Some(pref) = preferred.clone() {
                        if pref != ev.current_id {
                            let listed = ev.models.iter().any(|m| m.id == pref);
                            match timed_acp_request(
                                "set model",
                                connection
                                    .send_request(SetSessionConfigOptionRequest::new(
                                        acp_session_id.clone(),
                                        SessionConfigId::new(ev.config_id.as_str()),
                                        SessionConfigOptionValue::value_id(pref.clone()),
                                    ))
                                    .block_task(),
                            )
                            .await
                            {
                                Ok(response) => {
                                    config_options = response.config_options;
                                }
                                Err(e) => {
                                    log::debug!(
                                        target: "agentero::agent",
                                        "agent={} warm set model failed (listed={}): pref={} err={}",
                                        agent_for_conn,
                                        listed,
                                        pref,
                                        e
                                    );
                                }
                            }
                        }
                    }
                }
                if let Some(pref) = preferred_collaboration.clone() {
                    if let Some(ev) = collaboration_from_config_options(
                        &session_for_conn,
                        &agent_for_conn,
                        &config_options,
                    ) {
                        if pref != ev.current_id && ev.modes.iter().any(|mode| mode.id == pref) {
                            match timed_acp_request(
                                "set collaboration mode",
                                connection
                                    .send_request(SetSessionConfigOptionRequest::new(
                                        acp_session_id.clone(),
                                        SessionConfigId::new(ev.config_id.as_str()),
                                        SessionConfigOptionValue::value_id(pref.clone()),
                                    ))
                                    .block_task(),
                            )
                            .await
                            {
                                Ok(response) => {
                                    config_options = response.config_options;
                                }
                                Err(e) => {
                                    log::debug!(
                                        target: "agentero::agent",
                                        "agent={} warm set collaboration mode failed: pref={} err={}",
                                        agent_for_conn,
                                        pref,
                                        e
                                    );
                                }
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
