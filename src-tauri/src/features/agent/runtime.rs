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
    runs: Mutex<HashMap<String, ActiveAgentRun>>,
}

struct ActiveAgentRun {
    cancellation: watch::Sender<bool>,
    workflow: Option<String>,
}

impl AgentRunController {
    pub fn new() -> Self {
        Self {
            runs: Mutex::new(HashMap::new()),
        }
    }

    pub fn register(
        &self,
        session_id: &str,
        workflow: Option<&str>,
    ) -> Result<watch::Receiver<bool>, AppError> {
        let (sender, receiver) = watch::channel(false);
        let mut runs = self
            .runs
            .lock()
            .map_err(|_| AppError::message("agent run controller lock poisoned"))?;
        if runs.contains_key(session_id) {
            return Err(AppError::message("agent run is already active"));
        }
        runs.insert(
            session_id.to_string(),
            ActiveAgentRun {
                cancellation: sender,
                workflow: workflow
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string),
            },
        );
        Ok(receiver)
    }

    pub fn cancel(&self, session_id: &str) -> Result<(), AppError> {
        let sender = self
            .runs
            .lock()
            .map_err(|_| AppError::message("agent run controller lock poisoned"))?
            .get(session_id)
            .map(|run| run.cancellation.clone())
            .ok_or_else(|| AppError::message("agent run is no longer active"))?;
        sender.send_replace(true);
        Ok(())
    }

    pub fn finish(&self, session_id: &str) -> Result<(), AppError> {
        self.runs
            .lock()
            .map_err(|_| AppError::message("agent run controller lock poisoned"))?
            .remove(session_id);
        Ok(())
    }

    pub fn is_active(&self, session_id: &str) -> Result<bool, AppError> {
        Ok(self
            .runs
            .lock()
            .map_err(|_| AppError::message("agent run controller lock poisoned"))?
            .contains_key(session_id))
    }

    pub fn is_workflow_active(&self, workflow: &str) -> Result<bool, AppError> {
        let workflow = workflow.trim();
        if workflow.is_empty() {
            return Err(AppError::message("agent workflow is required"));
        }
        Ok(self
            .runs
            .lock()
            .map_err(|_| AppError::message("agent run controller lock poisoned"))?
            .values()
            .any(|run| run.workflow.as_deref() == Some(workflow)))
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
        let receiver = controller
            .register("session-1", None)
            .expect("register run");

        controller.cancel("session-1").expect("cancel run");
        assert!(*receiver.borrow());

        controller.finish("session-1").expect("finish run");
        assert!(controller.cancel("session-1").is_err());
    }

    #[test]
    fn duplicate_registration_does_not_replace_the_active_run() {
        let controller = AgentRunController::new();
        let receiver = controller
            .register("session-1", None)
            .expect("register run");

        assert!(controller.register("session-1", None).is_err());
        controller.cancel("session-1").expect("cancel original run");
        assert!(*receiver.borrow());
    }

    #[test]
    fn active_state_clears_only_after_finish() {
        let controller = AgentRunController::new();
        let _receiver = controller
            .register("session-1", None)
            .expect("register run");

        assert!(controller.is_active("session-1").expect("query active run"));
        controller.finish("session-1").expect("finish run");
        assert!(!controller
            .is_active("session-1")
            .expect("query finished run"));
        assert!(!controller.is_active("unknown").expect("query unknown run"));
    }

    #[test]
    fn workflow_queries_are_independent() {
        let controller = AgentRunController::new();
        let _preparation = controller
            .register("prep", Some("voice_defense_preparation"))
            .expect("register preparation");

        assert!(controller
            .is_workflow_active("voice_defense_preparation")
            .expect("query preparation"));
        assert!(!controller
            .is_workflow_active("paper_read")
            .expect("query unrelated workflow"));
    }

    #[test]
    fn workflow_stays_active_until_its_last_run_finishes() {
        let controller = AgentRunController::new();
        let _first = controller
            .register("prep-1", Some("voice_defense_preparation"))
            .expect("register first preparation");
        let _second = controller
            .register("prep-2", Some("voice_defense_preparation"))
            .expect("register second preparation");

        controller.finish("prep-1").expect("finish first run");
        assert!(controller
            .is_workflow_active("voice_defense_preparation")
            .expect("query remaining run"));

        controller.finish("prep-2").expect("finish second run");
        assert!(!controller
            .is_workflow_active("voice_defense_preparation")
            .expect("query finished workflow"));
    }

    #[test]
    fn empty_workflow_queries_are_rejected() {
        let controller = AgentRunController::new();

        assert!(controller.is_workflow_active("").is_err());
        assert!(controller.is_workflow_active("   ").is_err());
    }
}
