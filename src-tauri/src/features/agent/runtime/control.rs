use crate::core::error::AppError;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::sync::watch;

/// In-memory controls for active one-shot ACP sessions.
///
/// ACP connections are intentionally short-lived today, so cancellation state is
/// runtime-only and is removed as soon as the corresponding session finishes.
pub struct AgentRunController {
    cancellations: Mutex<HashMap<String, watch::Sender<bool>>>,
}

impl AgentRunController {
    pub fn new() -> Self {
        Self {
            cancellations: Mutex::new(HashMap::new()),
        }
    }

    pub fn register(&self, session_id: &str) -> Result<watch::Receiver<bool>, AppError> {
        let (sender, receiver) = watch::channel(false);
        let mut cancellations = self
            .cancellations
            .lock()
            .map_err(|_| AppError::message("agent run controller lock poisoned"))?;
        if cancellations.contains_key(session_id) {
            return Err(AppError::message("agent run is already active"));
        }
        cancellations.insert(session_id.to_string(), sender);
        Ok(receiver)
    }

    pub fn cancel(&self, session_id: &str) -> Result<(), AppError> {
        let sender = self
            .cancellations
            .lock()
            .map_err(|_| AppError::message("agent run controller lock poisoned"))?
            .get(session_id)
            .cloned()
            .ok_or_else(|| AppError::message("agent run is no longer active"))?;
        sender.send_replace(true);
        Ok(())
    }

    pub fn finish(&self, session_id: &str) -> Result<(), AppError> {
        self.cancellations
            .lock()
            .map_err(|_| AppError::message("agent run controller lock poisoned"))?
            .remove(session_id);
        Ok(())
    }
}

impl Default for AgentRunController {
    fn default() -> Self {
        Self::new()
    }
}

/// Cooldown before background ACP spawns (warm / list sessions) retry an agent
/// whose last background spawn failed. Prevents every panel mount from
/// re-spawning a CLI that cannot start a session (e.g. Gemini not signed in).
const WARM_GATE_COOLDOWN: Duration = Duration::from_secs(120);

pub struct AgentWarmGate {
    cooldown: Duration,
    failures: Mutex<HashMap<String, (Instant, String)>>,
}

impl AgentWarmGate {
    pub fn new() -> Self {
        Self::with_cooldown(WARM_GATE_COOLDOWN)
    }

    fn with_cooldown(cooldown: Duration) -> Self {
        Self {
            cooldown,
            failures: Mutex::new(HashMap::new()),
        }
    }

    /// Returns the last failure message while the agent is still cooling down.
    pub fn blocked(&self, agent_id: &str) -> Option<String> {
        let mut failures = self.failures.lock().ok()?;
        match failures.get(agent_id) {
            Some((at, error)) if at.elapsed() < self.cooldown => Some(error.clone()),
            Some(_) => {
                failures.remove(agent_id);
                None
            }
            None => None,
        }
    }

    pub fn record_failure(&self, agent_id: &str, error: &str) {
        if let Ok(mut failures) = self.failures.lock() {
            failures.insert(agent_id.to_string(), (Instant::now(), error.to_string()));
        }
    }

    pub fn clear(&self, agent_id: &str) {
        if let Ok(mut failures) = self.failures.lock() {
            failures.remove(agent_id);
        }
    }
}

impl Default for AgentWarmGate {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::{AgentRunController, AgentWarmGate};
    use std::time::Duration;

    #[test]
    fn warm_gate_blocks_during_cooldown_and_clears_on_success() {
        let gate = AgentWarmGate::new();
        assert_eq!(gate.blocked("gemini"), None);

        gate.record_failure("gemini", "new_session timed out after 15s");
        assert_eq!(
            gate.blocked("gemini"),
            Some("new_session timed out after 15s".to_string())
        );
        assert_eq!(gate.blocked("other"), None);

        gate.clear("gemini");
        assert_eq!(gate.blocked("gemini"), None);
    }

    #[test]
    fn warm_gate_expires_after_cooldown() {
        let gate = AgentWarmGate::with_cooldown(Duration::ZERO);
        gate.record_failure("gemini", "boom");
        assert_eq!(gate.blocked("gemini"), None);
        // Expired entry is removed, not just ignored.
        assert_eq!(gate.blocked("gemini"), None);
    }

    #[test]
    fn cancellation_is_signalled_only_while_the_run_is_registered() {
        let controller = AgentRunController::new();
        let receiver = controller.register("session-1").expect("register run");

        controller.cancel("session-1").expect("cancel run");
        assert!(*receiver.borrow());

        controller.finish("session-1").expect("finish run");
        assert!(controller.cancel("session-1").is_err());
    }

    #[test]
    fn duplicate_registration_does_not_replace_the_active_run() {
        let controller = AgentRunController::new();
        let receiver = controller.register("session-1").expect("register run");

        assert!(controller.register("session-1").is_err());
        controller.cancel("session-1").expect("cancel original run");
        assert!(*receiver.borrow());
    }
}
