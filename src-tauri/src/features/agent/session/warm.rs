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
    timed_acp_request, to_acp_agent,
};
use crate::features::agent::acp::updates::{
    emit_session_config_options, models_from_config_options,
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
use agent_client_protocol::{Agent, ConnectionTo};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;
use uuid::Uuid;

/// Upper bound for the setup half of warm-up (initialize + session/new can be
/// slow on cold disks / first login). Timeout cancels the connection task.
const WARM_SETUP_TIMEOUT: Duration = Duration::from_secs(60);
pub(crate) const WARM_CANCELLED_ERROR: &str = "warm setup cancelled";

type SetupOutcome = Result<
    Result<Result<(), String>, tokio::sync::oneshot::error::RecvError>,
    tokio::time::error::Elapsed,
>;

/// Cancellation covers both the setup deadline and a dropped command future.
/// Failed setup does not return until its background connection has ended.
async fn await_setup<T>(
    receiver: tokio::sync::oneshot::Receiver<Result<(), String>>,
    cancellation: tokio_util::sync::CancellationToken,
    background: impl std::future::Future<Output = T>,
) -> (SetupOutcome, bool) {
    let guard = cancellation.clone().drop_guard();
    let setup = tokio::time::timeout(WARM_SETUP_TIMEOUT, receiver).await;
    let cancelled = cancellation.is_cancelled();
    if matches!(&setup, Ok(Ok(Ok(())))) {
        guard.disarm();
    } else {
        drop(guard);
        background.await;
    }
    (setup, cancelled)
}

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
    pool.retire_idle(&key);

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
    let task = pool.start_warm(&key);
    let cancellation = task.cancellation.clone();

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
        task_id: task.id,
        cancellation: cancellation.clone(),
    };

    let task_cancellation = cancellation.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let _task = task;
        if task_cancellation.is_cancelled() {
            return;
        }
        let connection = agentero_turn_builder!(terminals, registry, Some(idle)).connect_with(
            acp,
            move |connection: ConnectionTo<Agent>| {
                closure_ctx.setup_and_keepalive(connection, setup_tx)
            },
        );
        tokio::pin!(connection);
        let result = tokio::select! {
            result = &mut connection => result,
            _ = task_cancellation.cancelled() => {
                // Allow bounded session/delete, then drop the connect future
                // and its process-tree guard even if the adapter hangs.
                tokio::time::timeout(Duration::from_secs(1), &mut connection)
                    .await.unwrap_or(Ok(()))
            }
        };
        if let Err(e) = result {
            log::debug!(target: "agentero::agent", "warm connection ended: {e}");
        }
    });

    let (setup, cancelled) = await_setup(setup_rx, cancellation, handle).await;
    if cancelled {
        return WarmResult {
            agent_id,
            ok: false,
            models: None,
            usage_used: None,
            usage_size: None,
            error: Some(WARM_CANCELLED_ERROR.to_string()),
        };
    }
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
        Err(_elapsed) => WarmResult {
            agent_id,
            ok: false,
            models: None,
            usage_used: None,
            usage_size: None,
            error: Some(format!(
                "warm setup timed out after {}s",
                WARM_SETUP_TIMEOUT.as_secs()
            )),
        },
    }
}

/// Setup + keepalive halves of the pooled warm connection, extracted so the
/// closure passed to `connect_with` stays a thin move wrapper.
struct WarmSetupCtx {
    task_id: Uuid,
    cancellation: tokio_util::sync::CancellationToken,
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

        let new_session = timed_acp_request(
            "new_session",
            connection
                .send_request(NewSessionRequest::new(self.cwd.clone()))
                .block_task(),
        )
        .await?;

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
        if let Some(ev) =
            models_from_config_options(&self.session_id, &self.agent_id, &config_options)
        {
            if let Ok(mut g) = self.models_out.lock() {
                *g = Some(ev);
            }
        }

        // Brief settle so agents can push usage/config updates after session create.
        tokio::time::sleep(Duration::from_millis(400)).await;
        if self.cancellation.is_cancelled() {
            return Err(agent_client_protocol::util::internal_error(
                WARM_CANCELLED_ERROR,
            ));
        }

        let (end_tx, end_rx) = watch::channel(false);
        let (activity_tx, activity_rx) = watch::channel(0u64);
        let used = Arc::new(std::sync::atomic::AtomicBool::new(false));
        self.pool.publish(PooledSlot {
            task_id: self.task_id,
            cancellation: self.cancellation.clone(),
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

#[cfg(test)]
mod tests {
    use super::await_setup;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use tokio_util::sync::CancellationToken;

    #[tokio::test(start_paused = true)]
    async fn setup_timeout_cancels_and_joins_background_connection() {
        let token = CancellationToken::new();
        let ended = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let cancelled = token.clone();
        let end = ended.clone();
        let background = tokio::spawn(async move {
            let _sender = sender;
            cancelled.cancelled().await;
            end.store(true, Ordering::SeqCst);
        });
        let (result, superseded) = await_setup(receiver, token.clone(), background).await;
        assert!(result.is_err());
        assert!(!superseded);
        assert!(token.is_cancelled());
        assert!(ended.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn dropping_setup_waiter_cancels_background_connection() {
        let token = CancellationToken::new();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (ended_tx, ended_rx) = tokio::sync::oneshot::channel();
        let cancelled = token.clone();
        let background = tokio::spawn(async move {
            let _sender = sender;
            let _ = started_tx.send(());
            cancelled.cancelled().await;
            let _ = ended_tx.send(());
        });
        let waiter = tokio::spawn(await_setup(receiver, token.clone(), background));
        started_rx.await.unwrap();
        // Poll the waiter before aborting, so its DropGuard is installed.
        tokio::task::yield_now().await;
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        tokio::time::timeout(std::time::Duration::from_secs(1), ended_rx)
            .await
            .unwrap()
            .unwrap();
        assert!(token.is_cancelled());
    }
}
