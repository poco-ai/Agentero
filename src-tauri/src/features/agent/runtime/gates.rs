//! Interactive ACP gates: permission approval and form elicitation.
//!
//! In `ask` mode the Host does not auto-decide ACP permission requests. Instead
//! it forwards the request to the frontend (`agent:permission-request`), awaits
//! the user's choice via `agent_respond_permission`, and only then replies to the
//! agent. A timeout falls back to cancelling the request.
//!
//! Codex Plan-mode `request_user_input` is bridged by codex-acp as form
//! elicitation. The Host must advertise `clientCapabilities.elicitation.form`
//! and answer `elicitation/create` or the adapter returns empty answers.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

/// Frontend → Host answer for a pending permission request.
/// `Some(option_id)` selects that option; `None` cancels the request.
pub type PermissionAnswer = Option<String>;

/// Process-wide table of permission requests awaiting a user decision.
/// Cheap to clone — all clones share the same underlying table.
#[derive(Clone, Default)]
pub struct PermissionGate {
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<PermissionAnswer>>>>,
}

impl PermissionGate {
    pub fn new() -> Self {
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Register a pending request; returns a receiver that resolves when the
    /// frontend answers (or the sender is dropped on cleanup).
    pub fn register(&self, request_id: &str) -> oneshot::Receiver<PermissionAnswer> {
        let (tx, rx) = oneshot::channel();
        if let Ok(mut g) = self.pending.lock() {
            g.insert(request_id.to_string(), tx);
        }
        rx
    }

    /// Resolve a pending request with the user's choice. Returns false when the
    /// request is unknown (already answered / timed out).
    pub fn resolve(&self, request_id: &str, answer: PermissionAnswer) -> bool {
        let tx = self
            .pending
            .lock()
            .ok()
            .and_then(|mut g| g.remove(request_id));
        match tx {
            Some(tx) => tx.send(answer).is_ok(),
            None => false,
        }
    }
}

/// User decision for a pending elicitation.
#[derive(Debug, Clone)]
pub enum ElicitationAnswer {
    /// Accept with field values (property id → string content).
    Accept(BTreeMap<String, String>),
    Decline,
    Cancel,
}

/// Process-wide table of elicitation requests awaiting a user decision.
#[derive(Clone, Default)]
pub struct ElicitationGate {
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<ElicitationAnswer>>>>,
}

impl ElicitationGate {
    pub fn new() -> Self {
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn register(&self, request_id: &str) -> oneshot::Receiver<ElicitationAnswer> {
        let (tx, rx) = oneshot::channel();
        if let Ok(mut g) = self.pending.lock() {
            g.insert(request_id.to_string(), tx);
        }
        rx
    }

    pub fn resolve(&self, request_id: &str, answer: ElicitationAnswer) -> bool {
        let tx = self
            .pending
            .lock()
            .ok()
            .and_then(|mut g| g.remove(request_id));
        match tx {
            Some(tx) => tx.send(answer).is_ok(),
            None => false,
        }
    }
}
