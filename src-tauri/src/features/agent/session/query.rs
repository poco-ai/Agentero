//! Long-lived ACP connections for read-only history RPCs.
//!
//! `session/list`, `session/load` and `session/delete` used to spawn a fresh
//! agent process per call (spawn → initialize → request → teardown). Listing
//! history for several harnesses and then opening a session therefore paid the
//! cold-start chain repeatedly, which is what made the Zen rail and history
//! loads feel slow.
//!
//! [`AgentQueryPool`] keeps one initialized connection per
//! `(agent, cwd, remote, startup variant)` and reuses it for those requests.
//! `session/load` replays the transcript as `SessionNotification`s, so the
//! connection routes notifications by session id into the [`ReplayBuilder`](crate::features::agent::session::history::ReplayBuilder)
//! registered by the caller. Idle connections are cancelled after
//! [`QUERY_IDLE_TTL`], the oldest one is evicted past [`QUERY_MAX_CONNECTIONS`],
//! and dropping the connect future reaps the agent process.

use crate::core::error::AppError;
use crate::features::agent::acp::client::{
    acp_terminals, agentero_acp_builder, client_initialize_request, timed_acp_initialize,
    to_acp_agent, ACP_INITIALIZE_TIMEOUT,
};
use crate::features::agent::acp::interaction::permission_response;
use crate::features::agent::models::AgentDescriptor;
use crate::features::agent::remote_host::RemoteAgentLaunch;
use crate::features::agent::session::history::{apply_replay_update, ReplayBuilder};
use crate::features::agent::session::pool::{pool_key, PoolKey};
use agent_client_protocol::schema::v1::{RequestPermissionRequest, SessionNotification};
use agent_client_protocol::{Agent, ConnectionTo};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

/// Idle time before a query connection is torn down. History browsing is
/// bursty (open Zen → click a session), so a few minutes of warmth is enough.
pub(crate) const QUERY_IDLE_TTL: Duration = Duration::from_secs(300);
const QUERY_KEEPALIVE_TICK: Duration = Duration::from_secs(15);
/// Upper bound on warm query processes, oldest-idle evicted first.
const QUERY_MAX_CONNECTIONS: usize = 4;
/// Extra slack on top of the initialize budget for publishing the connection.
const QUERY_READY_SLACK: Duration = Duration::from_secs(5);

/// Agent capabilities the history RPCs need, captured from `initialize`.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct QueryCaps {
    pub list: bool,
    pub load: bool,
    pub delete: bool,
}

pub(crate) type ReplaySink = Arc<Mutex<ReplayBuilder>>;
type SinkMap = Arc<Mutex<HashMap<String, Vec<ReplaySink>>>>;

/// One initialized, reusable connection to an agent process.
pub(crate) struct QueryConnection {
    id: Uuid,
    key: PoolKey,
    pub connection: ConnectionTo<Agent>,
    pub caps: QueryCaps,
    /// In-flight `session/load` collectors, keyed by session id.
    sinks: SinkMap,
    end: CancellationToken,
    last_used: Arc<Mutex<Instant>>,
}

impl QueryConnection {
    fn is_usable(&self) -> bool {
        !self.end.is_cancelled()
            && !self.connection.is_incoming_closed()
            && self
                .last_used
                .lock()
                .map(|t| t.elapsed() < QUERY_IDLE_TTL)
                .unwrap_or(false)
    }

    pub(crate) fn touch(&self) {
        if let Ok(mut last) = self.last_used.lock() {
            *last = Instant::now();
        }
    }

    fn stop(&self) {
        self.end.cancel();
    }
}

/// Registry of reusable history connections (at most one per agent id, plus a
/// global cap).
pub struct AgentQueryPool {
    conns: Mutex<HashMap<String, Arc<QueryConnection>>>,
    closed: AtomicBool,
}

impl AgentQueryPool {
    pub fn new() -> Self {
        Self {
            conns: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
        }
    }

    pub fn shutdown(&self) {
        self.closed.store(true, Ordering::SeqCst);
        let drained: Vec<Arc<QueryConnection>> = {
            let mut conns = self.lock();
            conns.drain().map(|(_, conn)| conn).collect()
        };
        for conn in drained {
            conn.stop();
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<QueryConnection>>> {
        self.conns.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Reuse an initialized connection when one matches the full key, otherwise
    /// spawn (and initialize) a fresh agent process.
    pub(crate) async fn acquire(
        self: &Arc<Self>,
        desc: &AgentDescriptor,
        cwd: PathBuf,
        remote: Option<&Arc<dyn RemoteAgentLaunch>>,
    ) -> Result<Arc<QueryConnection>, AppError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(AppError::message("agent query pool is closed"));
        }
        // Pi reads project trust only at process start; keep its variant in the
        // key so a trust change never reuses a stale process.
        let variant = if remote.is_none() {
            crate::features::agent::pi_trust::pool_variant(desc, &cwd)
        } else {
            None
        };
        let key = pool_key(&desc.id, cwd.clone(), remote, variant);
        if let Some(existing) = self.reusable(&key) {
            return Ok(existing);
        }

        let acp = to_acp_agent(desc, Some(&cwd), remote.map(|host| host.as_ref()))?;
        let terminals = acp_terminals(Some(cwd));
        let sinks: SinkMap = Arc::new(Mutex::new(HashMap::new()));
        let (ready_tx, ready_rx) =
            tokio::sync::oneshot::channel::<Result<(ConnectionTo<Agent>, QueryCaps), String>>();
        let end = CancellationToken::new();
        let last_used = Arc::new(Mutex::new(Instant::now()));
        let id = Uuid::new_v4();

        let builder = agentero_acp_builder!(terminals)
            .on_receive_notification(
                {
                    let sinks = sinks.clone();
                    async move |notification: SessionNotification, _cx| {
                        let sink = {
                            let map = sinks.lock().unwrap_or_else(|e| e.into_inner());
                            map.get(&notification.session_id.to_string()).cloned()
                        };
                        if let Some(handles) = sink {
                            for handle in handles {
                                if let Ok(mut replay) = handle.lock() {
                                    apply_replay_update(&mut replay, &notification.update);
                                }
                            }
                        }
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_request(
                async move |request: RequestPermissionRequest, responder, _cx| {
                    let _ = responder.respond(permission_response(&request, false));
                    Ok(())
                },
                agent_client_protocol::on_receive_request!(),
            );

        let pool = Arc::clone(self);
        let keepalive_end = end.clone();
        let keepalive_used = last_used.clone();
        let log_agent_id = desc.id.clone();
        tauri::async_runtime::spawn(async move {
            let result = builder
                .connect_with(acp, move |connection: ConnectionTo<Agent>| async move {
                    let init = timed_acp_initialize(
                        connection
                            .send_request(client_initialize_request())
                            .block_task(),
                    )
                    .await;
                    let init = match init {
                        Ok(init) => init,
                        Err(error) => {
                            let _ = ready_tx.send(Err(error.to_string()));
                            return Err(error);
                        }
                    };
                    let caps = QueryCaps {
                        list: init.agent_capabilities.session_capabilities.list.is_some(),
                        load: init.agent_capabilities.load_session,
                        delete: init
                            .agent_capabilities
                            .session_capabilities
                            .delete
                            .is_some(),
                    };
                    let _ = ready_tx.send(Ok((connection.clone(), caps)));
                    loop {
                        tokio::select! {
                            _ = keepalive_end.cancelled() => break,
                            _ = tokio::time::sleep(QUERY_KEEPALIVE_TICK) => {}
                        }
                        if connection.is_incoming_closed() {
                            break;
                        }
                        let idle = keepalive_used
                            .lock()
                            .map(|t| t.elapsed())
                            .unwrap_or_default();
                        if idle > QUERY_IDLE_TTL {
                            break;
                        }
                    }
                    Ok(())
                })
                .await;
            if let Err(error) = result {
                log::debug!(
                    target: "agentero::agent",
                    "agent={log_agent_id} query connection ended: {error}"
                );
            }
            pool.drop_connection(id);
        });

        let ready =
            tokio::time::timeout(ACP_INITIALIZE_TIMEOUT + QUERY_READY_SLACK, ready_rx).await;
        let (connection, caps) = match ready {
            Ok(Ok(Ok(pair))) => pair,
            Ok(Ok(Err(error))) => {
                end.cancel();
                return Err(AppError::domain("acp", format!("acp: initialize: {error}")));
            }
            Ok(Err(_closed)) => {
                end.cancel();
                return Err(AppError::domain(
                    "acp",
                    "acp: query connection closed before initialize finished",
                ));
            }
            Err(_elapsed) => {
                end.cancel();
                return Err(AppError::domain(
                    "acp",
                    "acp: query connection timed out during initialize",
                ));
            }
        };

        let conn = Arc::new(QueryConnection {
            id,
            key: key.clone(),
            connection,
            caps,
            sinks,
            end,
            last_used,
        });
        if self.closed.load(Ordering::SeqCst) {
            conn.stop();
            return Err(AppError::message("agent query pool is closed"));
        }
        // Another caller may have published the same key while we initialized;
        // reuse theirs and let this process go.
        if let Some(existing) = self.reusable(&key) {
            conn.stop();
            return Ok(existing);
        }
        self.insert(Arc::clone(&conn));
        Ok(conn)
    }

    fn reusable(&self, key: &PoolKey) -> Option<Arc<QueryConnection>> {
        let mut conns = self.lock();
        let existing = conns.get(&key.agent_id)?.clone();
        if &existing.key != key || !existing.is_usable() {
            if let Some(removed) = conns.remove(&key.agent_id) {
                removed.stop();
            }
            return None;
        }
        existing.touch();
        Some(existing)
    }

    fn insert(&self, conn: Arc<QueryConnection>) {
        let displaced = {
            let mut conns = self.lock();
            let previous = conns.insert(conn.key.agent_id.clone(), Arc::clone(&conn));
            while conns.len() > QUERY_MAX_CONNECTIONS {
                let oldest = conns
                    .iter()
                    .filter(|(agent_id, _)| **agent_id != conn.key.agent_id)
                    .min_by_key(|(_, candidate)| {
                        candidate
                            .last_used
                            .lock()
                            .map(|t| *t)
                            .unwrap_or_else(|e| *e.into_inner())
                    })
                    .map(|(agent_id, _)| agent_id.clone());
                match oldest {
                    Some(agent_id) => {
                        if let Some(removed) = conns.remove(&agent_id) {
                            removed.stop();
                        }
                    }
                    None => break,
                }
            }
            previous
        };
        if let Some(old) = displaced {
            old.stop();
        }
        log::debug!(
            target: "agentero::agent",
            "agent={} query connection ready cwd={} list={} load={} delete={}",
            conn.key.agent_id,
            conn.key.cwd.display(),
            conn.caps.list,
            conn.caps.load,
            conn.caps.delete
        );
    }

    /// Drop every cached query connection for one agent so the next history
    /// request cold-starts with the new startup state (e.g. Pi project trust).
    pub(crate) fn discard_agent(&self, agent_id: &str) {
        let removed = {
            let mut conns = self.lock();
            conns.remove(agent_id)
        };
        if let Some(conn) = removed {
            conn.stop();
        }
    }

    fn drop_connection(&self, id: Uuid) {
        let mut conns = self.lock();
        conns.retain(|_, conn| conn.id != id);
    }
}

impl Default for AgentQueryPool {
    fn default() -> Self {
        Self::new()
    }
}

impl QueryConnection {
    /// Register a collector for one in-flight `session/load`.
    pub(crate) fn register_load(&self, session_id: &str, sink: ReplaySink) {
        let mut map = self.sinks.lock().unwrap_or_else(|e| e.into_inner());
        map.entry(session_id.to_string()).or_default().push(sink);
    }

    /// Drop the collector once the load response arrived (or failed).
    pub(crate) fn unregister_load(&self, session_id: &str, sink: &ReplaySink) {
        let mut map = self.sinks.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(handles) = map.get_mut(session_id) {
            handles.retain(|handle| !Arc::ptr_eq(handle, sink));
            if handles.is_empty() {
                map.remove(session_id);
            }
        }
    }
}
