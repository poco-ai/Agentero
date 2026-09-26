//! Background ACP warm-up whose connection stays pooled for the next turn.
//!
//! Setup (spawn → initialize → session/new → preferences → settle) runs inside
//! the connect future; the resulting connection + fresh session are published
//! to the [`AgentWarmPool`] and kept alive by a keepalive loop until
//! evicted, closed (EOF) or idle past [`POOL_IDLE_TTL`]. A slot that never
//! served a turn has its empty session `session/delete`d at teardown so warm
//! starts do not pile up empty threads in agent history.

use crate::features::agent::acp::client::{
    acp_terminals, agent_spawn_cwd, client_initialize_request, timed_acp_initialize,
    timed_acp_new_session, timed_acp_request, to_acp_agent,
};
use crate::features::agent::acp::updates::{
    emit_session_config_options, models_from_config_options, models_from_session_models_value,
    richer_models_event,
};
use crate::features::agent::models::{AgentDescriptor, WarmResult};
use crate::features::agent::runtime::events::AgentEventEmitter;
use crate::features::agent::session::config::apply_model_and_collaboration_prefs;
use crate::features::agent::session::handlers::{
    agentero_turn_builder, new_registry, WarmIdleHooks,
};
use crate::features::agent::session::pool::{
    pool_key, AgentWarmPool, PoolKey, PooledSlot, POOL_IDLE_TTL,
};
use agent_client_protocol::schema::v1::{DeleteSessionRequest, NewSessionRequest};
use agent_client_protocol::{Agent, ConnectionTo, UntypedMessage};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;
use uuid::Uuid;

/// Upper bound for the setup half of warm-up (initialize + session/new can be
/// slow on cold disks / first login); the keepalive keeps running regardless.
const WARM_SETUP_TIMEOUT: Duration = Duration::from_secs(60);

/// Background warm-up: spawn ACP → initialize → new_session → publish the
/// live connection to the pool → emit models/usage (no prompt). Used when Chat
/// opens so the model selector and context meter are ready before first send,
/// and so the first (and later) prompts skip the cold spawn chain.
pub async fn warm_agent(
    app: AgentEventEmitter,
    desc: AgentDescriptor,
    vault_path: Option<String>,
    preferred_model_id: Option<String>,
    preferred_collaboration_mode_id: Option<String>,
    remote: Option<Arc<dyn crate::features::agent::remote_host::RemoteAgentLaunch>>,
    pool: Arc<AgentWarmPool>,
) -> WarmResult {
    let agent_id = desc.id.clone();
    let session_id = Uuid::new_v4().to_string();
    let cwd = match agent_spawn_cwd(remote.as_deref(), vault_path.as_deref()) {
        Ok(cwd) => cwd,
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
    let key: PoolKey = pool_key(&agent_id, cwd.clone(), remote.as_ref());

    // Healthy pooled slot from an earlier warm: reuse its cached models /
    // usage instead of spawning a second agent process.
    if let Some((models, usage)) = pool.snapshot_warm_result(&key) {
        log::debug!(
            target: "agentero::agent",
            "agent={} warm reused pooled slot cwd={}",
            agent_id,
            cwd.display()
        );
        return WarmResult {
            agent_id,
            ok: true,
            models,
            usage_used: usage.map(|(u, _)| u),
            usage_size: usage.map(|(_, s)| s),
            error: None,
        };
    }

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

    let models_out: Arc<Mutex<Option<crate::features::agent::models::AgentModelsEvent>>> =
        Arc::new(Mutex::new(None));
    let usage_out: Arc<Mutex<Option<(u64, u64)>>> = Arc::new(Mutex::new(None));
    let idle = WarmIdleHooks {
        app: app.clone(),
        session_id: session_id.clone(),
        agent_id: agent_id.clone(),
        usage: usage_out.clone(),
    };
    let registry = new_registry();
    let terminals = acp_terminals(Some(cwd.clone()));
    let (setup_tx, setup_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();

    // Everything the connect closure needs; the spawned task below holds the
    // connect future (and with it the agent process) for the pool's lifetime.
    let closure_ctx = WarmSetupCtx {
        app: app.clone(),
        key: key.clone(),
        cwd,
        pool: pool.clone(),
        session_id: session_id.clone(),
        agent_id: agent_id.clone(),
        preferred_model_id,
        preferred_collaboration_mode_id,
        models_out: models_out.clone(),
        usage_out: usage_out.clone(),
        terminals: terminals.clone(),
        registry: registry.clone(),
    };

    tauri::async_runtime::spawn(async move {
        let result = agentero_turn_builder!(terminals, registry, Some(idle))
            .connect_with(acp, move |connection: ConnectionTo<Agent>| {
                closure_ctx.setup_and_keepalive(connection, setup_tx)
            })
            .await;
        if let Err(e) = result {
            log::debug!(target: "agentero::agent", "warm connection ended: {e}");
        }
    });

    let setup = tokio::time::timeout(WARM_SETUP_TIMEOUT, setup_rx).await;
    match setup {
        // Setup published a slot (or the sender dropped after a failed send).
        Ok(Ok(setup)) => match setup {
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
            Err(error) => WarmResult {
                agent_id,
                ok: false,
                models: None,
                usage_used: None,
                usage_size: None,
                error: Some(error),
            },
        },
        Ok(Err(_dropped)) => WarmResult {
            agent_id,
            ok: false,
            models: None,
            usage_used: None,
            usage_size: None,
            error: Some("warm connection closed before setup finished".to_string()),
        },
        Err(_elapsed) => {
            // The background task keeps running; a late publish still benefits
            // the next run (take does not consult the warm gate).
            WarmResult {
                agent_id,
                ok: false,
                models: None,
                usage_used: None,
                usage_size: None,
                error: Some(format!(
                    "warm setup timed out after {}s",
                    WARM_SETUP_TIMEOUT.as_secs()
                )),
            }
        }
    }
}

/// Setup + keepalive halves of the pooled warm connection, extracted so the
/// closure passed to `connect_with` stays a thin move wrapper.
struct WarmSetupCtx {
    app: AgentEventEmitter,
    key: PoolKey,
    cwd: PathBuf,
    pool: Arc<AgentWarmPool>,
    session_id: String,
    agent_id: String,
    preferred_model_id: Option<String>,
    preferred_collaboration_mode_id: Option<String>,
    models_out: Arc<Mutex<Option<crate::features::agent::models::AgentModelsEvent>>>,
    usage_out: Arc<Mutex<Option<(u64, u64)>>>,
    terminals: Arc<tokio::sync::Mutex<crate::features::agent::acp::terminal::AcpTerminalManager>>,
    registry: crate::features::agent::session::handlers::TurnRegistry,
}

/// Teardown state returned by setup and consumed by the keepalive loop.
struct KeepaliveCtx {
    end_rx: watch::Receiver<bool>,
    activity_rx: watch::Receiver<u64>,
    used: Arc<std::sync::atomic::AtomicBool>,
    supports_delete: bool,
    acp_session_id: agent_client_protocol::schema::v1::SessionId,
    agent_id: String,
}

impl WarmSetupCtx {
    async fn setup_and_keepalive(
        self,
        connection: ConnectionTo<Agent>,
        setup_tx: tokio::sync::oneshot::Sender<Result<(), String>>,
    ) -> Result<(), agent_client_protocol::Error> {
        match self.setup(&connection).await {
            Ok(keepalive) => {
                let _ = setup_tx.send(Ok(()));
                self.keepalive(&connection, keepalive).await;
                Ok(())
            }
            Err(error) => {
                let _ = setup_tx.send(Err(error.to_string()));
                Err(error)
            }
        }
    }

    /// initialize → session/new → preferences → settle → publish the slot.
    async fn setup(
        &self,
        connection: &ConnectionTo<Agent>,
    ) -> Result<KeepaliveCtx, agent_client_protocol::Error> {
        let init = timed_acp_initialize(
            connection
                .send_request(client_initialize_request())
                .block_task(),
        )
        .await?;
        let session_caps = &init.agent_capabilities.session_capabilities;
        let can_resume = session_caps.resume.is_some();
        let can_load = init.agent_capabilities.load_session;

        // Send session/new untyped so the raw response survives: the schema drops
        // hermes-agent's pre-stabilization top-level `models` field on deserialize,
        // and the typed NewSessionResponse would lose it before we can look.
        let raw_new_session = timed_acp_new_session(
            connection
                .send_request(
                    UntypedMessage::new("session/new", NewSessionRequest::new(self.cwd.clone()))
                        .map_err(|e| {
                            agent_client_protocol::Error::internal_error().data(e.to_string())
                        })?,
                )
                .block_task(),
        )
        .await?;
        let new_session: agent_client_protocol::schema::v1::NewSessionResponse =
            agent_client_protocol::JsonRpcResponse::from_value(
                "session/new",
                raw_new_session.clone(),
            )?;

        let acp_session_id = new_session.session_id;
        let config_options = apply_model_and_collaboration_prefs(
            connection,
            &self.session_id,
            &self.agent_id,
            &acp_session_id,
            new_session.config_options.unwrap_or_default(),
            self.preferred_model_id.clone(),
            self.preferred_collaboration_mode_id.clone(),
        )
        .await;
        emit_session_config_options(&self.app, &self.session_id, &self.agent_id, &config_options);
        let models_event = richer_models_event(
            models_from_config_options(&self.session_id, &self.agent_id, &config_options),
            models_from_session_models_value(&self.session_id, &self.agent_id, &raw_new_session),
        );
        if let Some(ev) = models_event {
            if let Ok(mut g) = self.models_out.lock() {
                *g = Some(ev);
            }
        }

        // Brief settle so agents can push usage/config updates after session create.
        tokio::time::sleep(Duration::from_millis(400)).await;

        let (end_tx, end_rx) = watch::channel(false);
        let (activity_tx, activity_rx) = watch::channel(0u64);
        let used = Arc::new(std::sync::atomic::AtomicBool::new(false));
        self.pool.publish(PooledSlot {
            key: self.key.clone(),
            connection: connection.clone(),
            acp_session_id: acp_session_id.clone(),
            config_options,
            can_resume,
            can_load,
            terminals: self.terminals.clone(),
            registry: self.registry.clone(),
            end: end_tx,
            activity: activity_tx,
            used: used.clone(),
            models: self.models_out.lock().ok().and_then(|g| g.clone()),
            usage: self.usage_out.lock().ok().and_then(|g| *g),
        });
        log::debug!(
            target: "agentero::agent",
            "agent={} warm slot published session={}",
            self.agent_id,
            acp_session_id
        );

        Ok(KeepaliveCtx {
            end_rx,
            activity_rx,
            used,
            supports_delete: session_caps.delete.is_some(),
            acp_session_id,
            agent_id: self.agent_id.clone(),
        })
    }

    /// Hold the connection open until evicted, closed (EOF) or idle past the
    /// TTL, then delete the empty session when the slot never served a turn
    /// (agents without `sessionCapabilities.delete` keep today's debug log).
    async fn keepalive(&self, connection: &ConnectionTo<Agent>, mut slot: KeepaliveCtx) {
        let mut idle_deadline = tokio::time::Instant::now() + POOL_IDLE_TTL;
        let reason = loop {
            tokio::select! {
                changed = slot.end_rx.changed() => {
                    if changed.is_err() || *slot.end_rx.borrow() {
                        break "evicted";
                    }
                }
                _ = connection.incoming_closed() => { break "closed"; }
                changed = slot.activity_rx.changed() => {
                    if changed.is_ok() {
                        // A turn took/released/routed traffic on this slot.
                        idle_deadline = tokio::time::Instant::now() + POOL_IDLE_TTL;
                    } else {
                        break "activity-source-dropped";
                    }
                }
                _ = tokio::time::sleep_until(idle_deadline) => { break "idle-timeout"; }
            }
        };
        log::debug!(
            target: "agentero::agent",
            "agent={} warm slot exiting ({reason})",
            slot.agent_id
        );

        if !slot.used.load(Ordering::SeqCst) {
            if slot.supports_delete {
                match timed_acp_request(
                    "delete_session",
                    connection
                        .send_request(DeleteSessionRequest::new(slot.acp_session_id.clone()))
                        .block_task(),
                )
                .await
                {
                    Ok(_) => log::debug!(
                        target: "agentero::agent",
                        "agent={} warm deleted unused session {}",
                        slot.agent_id,
                        slot.acp_session_id
                    ),
                    Err(e) => log::debug!(
                        target: "agentero::agent",
                        "agent={} warm session/delete failed for {}: {e}",
                        slot.agent_id,
                        slot.acp_session_id
                    ),
                }
            } else {
                log::debug!(
                    target: "agentero::agent",
                    "agent={} warm left unused session {} (no sessionCapabilities.delete)",
                    slot.agent_id,
                    slot.acp_session_id
                );
            }
        }
    }
}
