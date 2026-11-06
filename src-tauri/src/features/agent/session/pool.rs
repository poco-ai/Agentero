//! Pool of warm ACP connections reused across chat turns (TTFT optimization).
//!
//! `warm_agent` publishes its live connection + fresh session here instead of
//! tearing it down; `run_once` takes a matching slot to skip the
//! `spawn → initialize → session/new` cold chain (measured at 3.5s+ per turn,
//! see #536). Idle slots are recycled after [`POOL_IDLE_TTL`] (or EOF /
//! eviction). A warm session that never received a user prompt stays out of
//! history: teardown calls `session/delete` when the agent allows it, and the
//! id stays hidden when it does not.

use crate::features::agent::acp::terminal::AcpTerminalManager;
use crate::features::agent::models::AgentModelsEvent;
use crate::features::agent::remote_host::RemoteAgentLaunch;
use crate::features::agent::session::handlers::TurnRegistry;
use agent_client_protocol::schema::v1::{SessionConfigOption, SessionId};
use agent_client_protocol::{Agent, ConnectionTo};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{watch, Notify};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

/// Idle time before a pooled connection is torn down (and its empty session
/// deleted when never used). Long-lived agent processes can grow memory and
/// drift, so the pool trades a little warmth for bounded resource use.
pub(crate) const POOL_IDLE_TTL: Duration = Duration::from_secs(600);

/// How long `take` waits for an in-flight warm setup before falling back to
/// the cold path (session/new alone measured 1–10s, so the wait is capped).
const POOL_TAKE_WAIT: Duration = Duration::from_secs(5);

/// Cached chat-UI payload a healthy slot can answer `agent_warm` with.
pub(crate) type WarmSnapshot = (Option<AgentModelsEvent>, Option<(u64, u64)>);

/// Identity of a pooled connection: same agent, working directory, remote
/// host and startup variant are interchangeable for reuse purposes.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct PoolKey {
    pub agent_id: String,
    pub cwd: PathBuf,
    pub remote_tag: Option<String>,
    /// State an agent only reads when its process starts, such as the Pi
    /// project-trust decision. A connection created under another variant
    /// must never be reused: its process would keep the old startup state.
    pub variant: Option<String>,
}

/// Build the pool key for a run / warm request.
pub(crate) fn pool_key(
    agent_id: &str,
    cwd: PathBuf,
    remote: Option<&Arc<dyn RemoteAgentLaunch>>,
    variant: Option<String>,
) -> PoolKey {
    PoolKey {
        agent_id: agent_id.to_string(),
        cwd,
        remote_tag: remote
            .map(|r| format!("{}{}", if r.is_local_sim() { "sim:" } else { "" }, r.host())),
        variant,
    }
}

/// One live warm connection available for the next turn.
pub(crate) struct PooledSlot {
    pub task_id: Uuid,
    pub cancellation: CancellationToken,
    pub key: PoolKey,
    pub connection: ConnectionTo<Agent>,
    /// Fresh session created during warm setup; a turn without a resume id
    /// prompts directly on it.
    pub acp_session_id: SessionId,
    pub config_options: Vec<SessionConfigOption>,
    pub can_resume: bool,
    pub can_load: bool,
    /// Shared with the connection's terminal handler and the run context.
    pub terminals: Arc<tokio::sync::Mutex<AcpTerminalManager>>,
    pub registry: TurnRegistry,
    /// Kill switch: sending `true` makes the keepalive loop exit, which ends
    /// the connect future and reaps the agent process.
    pub end: watch::Sender<bool>,
    /// Heartbeat counter; every bump restarts the idle TTL.
    pub activity: watch::Sender<u64>,
    /// When false, teardown may delete this session. Set once a turn bound
    /// the slot to a session the user is continuing.
    pub used: Arc<AtomicBool>,
    /// `initialize` advertised `sessionCapabilities.delete`.
    pub supports_delete: bool,
    /// Cached setup results for `snapshot_warm_result`.
    pub models: Option<AgentModelsEvent>,
    pub usage: Option<(u64, u64)>,
}

impl PooledSlot {
    fn stop(&self) {
        let _ = self.end.send(true);
        self.cancellation.cancel();
    }
    /// Liveness probe: the agent process closed its stdin-to-us stream (EOF).
    pub fn is_alive(&self) -> bool {
        !self.connection.is_incoming_closed()
    }

    /// Mark that a real turn ran on this slot (teardown keeps its session).
    pub fn mark_used(&self) {
        self.used.store(true, Ordering::SeqCst);
    }

    /// Heartbeat: restart the keepalive idle TTL.
    pub fn bump(&self) {
        let _ = self.activity.send_if_modified(|v| {
            *v += 1;
            true
        });
    }
}

/// Map-level bookkeeping shared by publish / take / release, generic over the
/// payload so unit tests can drive it without a live `ConnectionTo`.
struct SlotMap<T> {
    entries: HashMap<String, (PoolKey, T)>,
}

// Manual impl: the derived one would require `T: Default`.
impl<T> Default for SlotMap<T> {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }
}

impl<T> SlotMap<T> {
    /// Insert a slot for its agent, displacing any previous one.
    fn insert(&mut self, key: PoolKey, payload: T) -> Option<(PoolKey, T)> {
        self.entries.insert(key.agent_id.clone(), (key, payload))
    }

    /// Remove the slot for `key.agent_id` only when the full key matches;
    /// a mismatched slot (different cwd / remote) stays pooled.
    fn remove_matching(&mut self, key: &PoolKey) -> Option<(PoolKey, T)> {
        let entry = self.entries.remove(&key.agent_id)?;
        if entry.0 != *key {
            self.entries.insert(entry.0.agent_id.clone(), entry);
            return None;
        }
        Some(entry)
    }

    /// Borrow the payload for `key` when present and matching.
    fn get_matching(&self, key: &PoolKey) -> Option<&T> {
        self.entries
            .get(&key.agent_id)
            .and_then(|(slot_key, payload)| (slot_key == key).then_some(payload))
    }
}

const UNPROMPTED_SESSION_CAP: usize = 2000;

/// Warm `session/new` ids that have not had a user prompt delivered.
/// History listing skips them. The file survives restart so an agent that
/// cannot `session/delete` does not show the empty thread again.
struct UnpromptedSessions {
    ids: Mutex<Vec<String>>,
    path: PathBuf,
}

fn unprompted_sessions_path() -> PathBuf {
    crate::core::paths::agentero_data_dir().join("unprompted-acp-sessions.json")
}

fn read_unprompted_ids(path: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(ids) = serde_json::from_str::<Vec<String>>(&text) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for id in ids {
        let id = id.trim().to_string();
        if id.is_empty() || out.iter().any(|existing| existing == &id) {
            continue;
        }
        out.push(id);
    }
    if out.len() > UNPROMPTED_SESSION_CAP {
        let overflow = out.len() - UNPROMPTED_SESSION_CAP;
        out.drain(0..overflow);
    }
    out
}

impl UnpromptedSessions {
    fn open(path: PathBuf) -> Self {
        let ids = read_unprompted_ids(&path);
        Self {
            ids: Mutex::new(ids),
            path,
        }
    }

    fn persist(&self, ids: &[String]) {
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(body) = serde_json::to_vec(ids) {
            let _ = std::fs::write(&self.path, body);
        }
    }

    fn track(&self, session_id: &str) {
        let session_id = session_id.trim();
        if session_id.is_empty() {
            return;
        }
        let Ok(mut ids) = self.ids.lock() else {
            return;
        };
        if ids.iter().any(|id| id == session_id) {
            return;
        }
        ids.push(session_id.to_string());
        if ids.len() > UNPROMPTED_SESSION_CAP {
            let overflow = ids.len() - UNPROMPTED_SESSION_CAP;
            ids.drain(0..overflow);
        }
        self.persist(&ids);
    }

    fn forget(&self, session_id: &str) {
        let Ok(mut ids) = self.ids.lock() else {
            return;
        };
        let before = ids.len();
        ids.retain(|id| id != session_id);
        if ids.len() != before {
            self.persist(&ids);
        }
    }

    fn snapshot(&self) -> HashSet<String> {
        self.ids
            .lock()
            .map(|ids| ids.iter().cloned().collect())
            .unwrap_or_default()
    }
}

/// Registry of pooled warm connections (at most one per agent).
pub struct AgentWarmPool {
    slots: Mutex<SlotMap<PooledSlot>>,
    tasks: Mutex<HashMap<Uuid, WarmState>>,
    closed: AtomicBool,
    changed: Notify,
    unprompted: UnpromptedSessions,
}

enum TakeState {
    Ready(Box<PooledSlot>),
    Pending(CancellationToken),
    Unavailable,
}

struct WarmState {
    key: PoolKey,
    cancellation: CancellationToken,
    published: bool,
}

/// Dropping a cancelled/finished warm task unregisters it even before setup.
pub(crate) struct WarmTask {
    pub id: Uuid,
    pub cancellation: CancellationToken,
    pool: Arc<AgentWarmPool>,
}

impl Drop for WarmTask {
    fn drop(&mut self) {
        let mut tasks = self.pool.tasks.lock().unwrap_or_else(|e| e.into_inner());
        tasks.remove(&self.id);
        let mut slots = self.pool.slots.lock().unwrap_or_else(|e| e.into_inner());
        slots.entries.retain(|_, (_, slot)| slot.task_id != self.id);
        self.pool.changed.notify_waiters();
    }
}

impl AgentWarmPool {
    pub(crate) fn new() -> Self {
        Self {
            slots: Mutex::new(SlotMap::default()),
            tasks: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
            changed: Notify::new(),
            unprompted: UnpromptedSessions::open(unprompted_sessions_path()),
        }
    }

    /// Hide a warm session until a user prompt is delivered on it.
    pub(crate) fn track_unprompted(&self, session_id: &str) {
        self.unprompted.track(session_id);
    }

    /// The session received a prompt, or `session/delete` removed it.
    pub(crate) fn forget_unprompted(&self, session_id: &str) {
        self.unprompted.forget(session_id);
    }

    pub(crate) fn unprompted_ids(&self) -> HashSet<String> {
        self.unprompted.snapshot()
    }

    pub(crate) fn start_warm(self: &Arc<Self>, key: &PoolKey) -> WarmTask {
        let mut tasks = self.tasks.lock().unwrap_or_else(|e| e.into_inner());
        let mut slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
        // Retire idle connections for the previous selection. Taken slots may
        // still serve a prompt, so leave them alone until released/idle.
        slots.entries.retain(|_, (old_key, slot)| {
            if old_key == key {
                return true;
            }
            slot.stop();
            false
        });
        for task in tasks.values() {
            if !task.published {
                task.cancellation.cancel();
            }
        }
        let cancellation = CancellationToken::new();
        if self.closed.load(Ordering::SeqCst) {
            cancellation.cancel();
        }
        let id = Uuid::new_v4();
        tasks.insert(
            id,
            WarmState {
                key: key.clone(),
                cancellation: cancellation.clone(),
                published: false,
            },
        );
        self.changed.notify_waiters();
        WarmTask {
            id,
            cancellation,
            pool: self.clone(),
        }
    }

    pub(crate) fn retire_idle(&self, key: &PoolKey) {
        let tasks = self.tasks.lock().unwrap_or_else(|e| e.into_inner());
        for task in tasks.values() {
            if !task.published && task.key != *key {
                task.cancellation.cancel();
            }
        }
        let mut slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
        slots.entries.retain(|_, (old_key, slot)| {
            if old_key == key {
                return true;
            }
            slot.stop();
            false
        });
        self.changed.notify_waiters();
    }

    /// Drop every warm connection for one agent (queued setups and idle
    /// slots). The next turn cold-starts a fresh process, so changes that only
    /// apply at agent startup — such as granting project trust — take effect.
    /// Slots currently borrowed by a running turn are not in the map; they
    /// still finish that turn.
    pub(crate) fn discard_agent(&self, agent_id: &str) {
        let tasks = self.tasks.lock().unwrap_or_else(|e| e.into_inner());
        let mut cancelled = 0;
        for task in tasks.values() {
            if task.key.agent_id == agent_id {
                task.cancellation.cancel();
                cancelled += 1;
            }
        }
        let mut slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
        let mut dropped = 0;
        slots.entries.retain(|_, (key, slot)| {
            if key.agent_id == agent_id {
                slot.stop();
                dropped += 1;
                false
            } else {
                true
            }
        });
        drop(slots);
        drop(tasks);
        if dropped > 0 || cancelled > 0 {
            log::debug!(
                target: "agentero::agent",
                "agent={agent_id} discarded warm connections slots={dropped} pending={cancelled}"
            );
        }
        self.changed.notify_waiters();
    }

    pub fn shutdown(&self) {
        let tasks = self.tasks.lock().unwrap_or_else(|e| e.into_inner());
        self.closed.store(true, Ordering::SeqCst);
        for task in tasks.values() {
            task.cancellation.cancel();
        }
        let mut slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
        for (_, (_, slot)) in slots.entries.drain() {
            slot.stop();
        }
        self.changed.notify_waiters();
    }

    /// Insert a freshly set-up slot, tearing down any previous slot for the
    /// same agent, and log the replacement.
    pub(crate) fn publish(&self, slot: PooledSlot) {
        let mut tasks = self.tasks.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(task) = tasks.get_mut(&slot.task_id) {
            task.published = true;
        }
        let displaced = self.slots.lock().ok().and_then(|mut slots| {
            if self.closed.load(Ordering::SeqCst) || slot.cancellation.is_cancelled() {
                slot.stop();
                return None;
            }
            slots.insert(slot.key.clone(), slot)
        });
        self.changed.notify_waiters();
        if let Some((key, old)) = displaced {
            log::debug!(
                target: "agentero::agent",
                "agent={} warm pool replaced slot cwd={} remote={:?}",
                key.agent_id,
                key.cwd.display(),
                key.remote_tag
            );
            old.stop();
        }
    }

    /// Take a matching slot, waiting only while a matching setup can publish.
    /// Subscribe before inspecting state so publication cannot lose a wakeup.
    pub(crate) async fn take(&self, key: &PoolKey) -> Option<PooledSlot> {
        let deadline = tokio::time::Instant::now() + POOL_TAKE_WAIT;
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            match self.take_state(key) {
                TakeState::Ready(slot) => return Some(*slot),
                TakeState::Unavailable => return None,
                TakeState::Pending(cancellation) => {
                    tokio::select! {
                        _ = &mut changed => {},
                        _ = cancellation.cancelled() => {},
                        _ = tokio::time::sleep_until(deadline) => return None,
                    }
                }
            }
        }
    }

    fn take_state(&self, key: &PoolKey) -> TakeState {
        // Match publish's lock order. Checking the ready slot and pending task
        // together prevents a publication between those checks looking absent.
        let tasks = self.tasks.lock().unwrap_or_else(|e| e.into_inner());
        if self.closed.load(Ordering::SeqCst) {
            return TakeState::Unavailable;
        }
        let mut slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((slot_key, slot)) = slots.remove_matching(key) {
            if slot.is_alive() && !slot.cancellation.is_cancelled() {
                return TakeState::Ready(Box::new(slot));
            }
            log::debug!(
                target: "agentero::agent",
                "agent={} warm slot dead (EOF); cold fallback",
                slot_key.agent_id
            );
            slot.stop();
        }
        tasks
            .values()
            .find(|task| task.key == *key && !task.published && !task.cancellation.is_cancelled())
            .map(|task| TakeState::Pending(task.cancellation.clone()))
            .unwrap_or(TakeState::Unavailable)
    }

    /// Return a slot after a finished turn; a dead or displaced connection is
    /// torn down instead of pooled again.
    pub(crate) fn release(&self, slot: PooledSlot) {
        slot.activity.send_if_modified(|v| {
            *v += 1;
            true
        });
        if !slot.is_alive()
            || self.closed.load(Ordering::SeqCst)
            || slot.cancellation.is_cancelled()
        {
            slot.stop();
            return;
        }
        self.publish(slot);
    }

    /// Tear a slot's process down (run error paths). The slot is already out
    /// of the map (it was taken), so this only signals the keepalive loop.
    pub(crate) fn evict(&self, slot: &PooledSlot) {
        slot.stop();
    }

    /// Cached `(models, usage)` from a healthy matching slot — lets a Chat
    /// reopen skip a fresh warm spawn entirely.
    pub(crate) fn snapshot_warm_result(&self, key: &PoolKey) -> Option<WarmSnapshot> {
        let slots = self.slots.lock().ok()?;
        let slot = slots.get_matching(key)?;
        if !slot.is_alive() {
            return None;
        }
        Some((slot.models.clone(), slot.usage))
    }
}

#[cfg(test)]
mod slot_map_tests {
    use super::{pool_key, SlotMap};
    use std::path::PathBuf;

    fn key(agent: &str, cwd: &str) -> super::PoolKey {
        super::PoolKey {
            agent_id: agent.to_string(),
            cwd: PathBuf::from(cwd),
            remote_tag: None,
            variant: None,
        }
    }

    #[test]
    fn take_requires_full_key_match() {
        let mut map: SlotMap<u8> = SlotMap::default();
        map.insert(key("codex", "/vault-a"), 1);
        // Same agent, different cwd → miss, and the slot stays pooled.
        assert!(map.remove_matching(&key("codex", "/vault-b")).is_none());
        // Exact key → hit.
        assert_eq!(
            map.remove_matching(&key("codex", "/vault-a")),
            Some((key("codex", "/vault-a"), 1))
        );
        // Pooled slot survived the mismatched take attempt.
        assert!(map.remove_matching(&key("codex", "/vault-b")).is_none());
    }

    #[test]
    fn startup_variant_distinguishes_keys() {
        let mut map: SlotMap<u8> = SlotMap::default();
        let mut untrusted = key("pi", "/vault");
        untrusted.variant = Some("pi-trust:untrusted".to_string());
        map.insert(untrusted.clone(), 1);

        // Trust changed since the warm connection was created: miss, but keep
        // the old slot available (it is still a valid process for its state).
        let mut trusted = key("pi", "/vault");
        trusted.variant = Some("pi-trust:trusted".to_string());
        assert!(map.remove_matching(&trusted).is_none());
        assert_eq!(map.get_matching(&untrusted), Some(&1));
        // The matching variant is still reusable.
        assert_eq!(map.remove_matching(&untrusted), Some((untrusted, 1)));
    }

    #[test]
    fn insert_displaces_previous_slot() {
        let mut map: SlotMap<u8> = SlotMap::default();
        assert!(map.insert(key("codex", "/vault"), 1).is_none());
        assert_eq!(
            map.insert(key("codex", "/vault"), 2),
            Some((key("codex", "/vault"), 1))
        );
        assert_eq!(map.get_matching(&key("codex", "/vault")), Some(&2));
    }

    #[test]
    fn snapshot_misses_on_missing_or_mismatched_key() {
        let mut map: SlotMap<u8> = SlotMap::default();
        assert_eq!(map.get_matching(&key("codex", "/vault")), None);
        map.insert(key("codex", "/vault"), 7);
        assert_eq!(map.get_matching(&key("codex", "/vault")), Some(&7));
        assert_eq!(map.get_matching(&key("grok", "/vault")), None);
    }

    #[test]
    fn remote_tag_distinguishes_keys() {
        let mut local = pool_key("codex", PathBuf::from("/vault"), None, None);
        assert!(local.remote_tag.is_none());
        local.remote_tag = Some("sim:host".to_string());
        let mut other = pool_key("codex", PathBuf::from("/vault"), None, None);
        other.remote_tag = Some("host".to_string());
        assert_ne!(local, other);
    }

    #[test]
    fn replacing_pending_warm_cancels_previous_setup() {
        let pool = std::sync::Arc::new(super::AgentWarmPool::new());
        let first = pool.start_warm(&key("codex", "/vault-a"));
        let second = pool.start_warm(&key("grok", "/vault-b"));
        assert!(first.cancellation.is_cancelled());
        assert!(!second.cancellation.is_cancelled());
        drop(first);
        assert_eq!(pool.tasks.lock().unwrap().len(), 1);
    }

    #[test]
    fn switching_selection_preserves_taken_connection() {
        let pool = std::sync::Arc::new(super::AgentWarmPool::new());
        let active = pool.start_warm(&key("codex", "/vault-a"));
        // Published + absent from the idle map represents a taken connection.
        pool.tasks
            .lock()
            .unwrap()
            .get_mut(&active.id)
            .unwrap()
            .published = true;
        let next = pool.start_warm(&key("grok", "/vault-b"));
        assert!(!active.cancellation.is_cancelled());
        pool.shutdown();
        assert!(active.cancellation.is_cancelled());
        assert!(next.cancellation.is_cancelled());
    }

    #[test]
    fn shutdown_cancels_pending_and_rejects_late_setups() {
        let pool = std::sync::Arc::new(super::AgentWarmPool::new());
        let pending = pool.start_warm(&key("codex", "/vault-a"));
        pool.shutdown();
        pool.shutdown();
        assert!(pending.cancellation.is_cancelled());
        let late = pool.start_warm(&key("codex", "/vault-b"));
        assert!(late.cancellation.is_cancelled());
    }

    #[tokio::test(start_paused = true)]
    async fn absent_mismatched_and_taken_setups_do_not_delay_cold_start() {
        let pool = std::sync::Arc::new(super::AgentWarmPool::new());
        let wanted = key("codex", "/vault-a");
        let start = tokio::time::Instant::now();
        assert!(pool.take(&wanted).await.is_none());
        let other = pool.start_warm(&key("codex", "/vault-b"));
        assert!(pool.take(&wanted).await.is_none());
        drop(other);
        let taken = pool.start_warm(&wanted);
        pool.tasks
            .lock()
            .unwrap()
            .get_mut(&taken.id)
            .unwrap()
            .published = true;
        assert!(pool.take(&wanted).await.is_none());
        assert_eq!(tokio::time::Instant::now(), start);
    }

    #[tokio::test(start_paused = true)]
    async fn failed_cancelled_and_closed_setups_wake_waiters_immediately() {
        for outcome in ["drop", "cancel", "close"] {
            let pool = std::sync::Arc::new(super::AgentWarmPool::new());
            let wanted = key("codex", "/vault-a");
            let warm = pool.start_warm(&wanted);
            let start = tokio::time::Instant::now();
            let waiter_pool = pool.clone();
            let waiter = tokio::spawn(async move { waiter_pool.take(&wanted).await });
            tokio::task::yield_now().await;
            assert!(!waiter.is_finished());
            match outcome {
                "drop" => drop(warm),
                "cancel" => warm.cancellation.cancel(),
                _ => pool.shutdown(),
            }
            assert!(waiter.await.unwrap().is_none());
            assert_eq!(tokio::time::Instant::now(), start, "{outcome}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn only_live_matching_setups_use_the_wait_budget() {
        let pool = std::sync::Arc::new(super::AgentWarmPool::new());
        let wanted = key("codex", "/vault-a");
        let _warm = pool.start_warm(&wanted);
        let start = tokio::time::Instant::now();
        assert!(pool.take(&wanted).await.is_none());
        assert_eq!(start.elapsed(), super::POOL_TAKE_WAIT);
    }

    #[tokio::test(start_paused = true)]
    async fn publication_wakes_all_waiters_but_only_one_can_claim_the_slot() {
        agent_client_protocol::Client
            .connect_with(agent_client_protocol::Agent.builder(), async |connection| {
                let pool = std::sync::Arc::new(super::AgentWarmPool::new());
                let wanted = key("codex", "/vault-a");
                let warm = pool.start_warm(&wanted);
                let start = tokio::time::Instant::now();
                let mut waiters = Vec::new();
                for _ in 0..8 {
                    let pool = pool.clone();
                    let wanted = wanted.clone();
                    waiters.push(tokio::spawn(async move { pool.take(&wanted).await }));
                }
                tokio::task::yield_now().await;
                let (end, _end_rx) = tokio::sync::watch::channel(false);
                let (activity, _activity_rx) = tokio::sync::watch::channel(0);
                pool.publish(super::PooledSlot {
                    task_id: warm.id,
                    cancellation: warm.cancellation.clone(),
                    key: wanted,
                    connection,
                    acp_session_id: "warm-session".into(),
                    config_options: Vec::new(),
                    can_resume: false,
                    can_load: false,
                    terminals: std::sync::Arc::new(tokio::sync::Mutex::new(
                        super::AcpTerminalManager::new(),
                    )),
                    registry: crate::features::agent::session::handlers::new_registry(),
                    end,
                    activity,
                    used: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                    supports_delete: false,
                    models: None,
                    usage: None,
                });
                let mut claims = 0;
                for waiter in waiters {
                    claims += usize::from(waiter.await.unwrap().is_some());
                }
                assert_eq!(claims, 1);
                assert_eq!(tokio::time::Instant::now(), start);
                Ok(())
            })
            .await
            .unwrap();
    }

    #[test]
    fn unprompted_ids_persist_until_forgotten() {
        let path = std::env::temp_dir().join(format!(
            "agentero-unprompted-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let store = super::UnpromptedSessions::open(path.clone());
        store.track("warm-1");
        store.track("warm-1");
        store.track("warm-2");
        let reloaded = super::UnpromptedSessions::open(path.clone());
        assert!(reloaded.snapshot().contains("warm-1"));
        assert!(reloaded.snapshot().contains("warm-2"));
        reloaded.forget("warm-1");
        let again = super::UnpromptedSessions::open(path.clone());
        assert!(!again.snapshot().contains("warm-1"));
        assert!(again.snapshot().contains("warm-2"));
        let _ = std::fs::remove_file(path);
    }
}
