use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, RwLock, Weak};
use tauri::{AppHandle, Emitter, EventTarget};

type RunWindows = HashMap<String, Weak<RwLock<String>>>;

fn run_windows() -> &'static Mutex<RunWindows> {
    static SLOTS: OnceLock<Mutex<RunWindows>> = OnceLock::new();
    SLOTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_slots() -> std::sync::MutexGuard<'static, RunWindows> {
    run_windows().lock().unwrap_or_else(|err| err.into_inner())
}

fn run_window(session_id: &str, label: impl Into<String>) -> Arc<RwLock<String>> {
    let binding = Arc::new(RwLock::new(label.into()));
    let mut slots = lock_slots();
    slots.retain(|_, slot| slot.strong_count() > 0);
    slots.insert(session_id.to_owned(), Arc::downgrade(&binding));
    binding
}

fn read_label(slot: &RwLock<String>) -> String {
    slot.read().unwrap_or_else(|err| err.into_inner()).clone()
}

pub fn rebind_agent_event_window(from: &str, to: &str, session_ids: &[String]) -> bool {
    if from.is_empty() || to.is_empty() || from == to {
        return false;
    }
    let slots = lock_slots();
    let mut rebound = false;
    for id in session_ids {
        let Some(slot) = slots.get(id).and_then(Weak::upgrade) else {
            continue;
        };
        let mut label = slot.write().unwrap_or_else(|err| err.into_inner());
        if label.as_str() == from {
            *label = to.to_string();
            rebound = true;
        }
    }
    rebound
}

#[derive(Clone)]
pub struct AgentEventEmitter {
    app: AppHandle,
    window_label: Arc<RwLock<String>>,
}

impl AgentEventEmitter {
    pub fn new(app: AppHandle, window_label: impl Into<String>) -> Self {
        Self {
            app,
            window_label: Arc::new(RwLock::new(window_label.into())),
        }
    }

    pub fn for_run(app: AppHandle, window_label: impl Into<String>, session_id: &str) -> Self {
        Self {
            app,
            window_label: run_window(session_id, window_label),
        }
    }

    pub(crate) fn window_binding(&self) -> Arc<RwLock<String>> {
        self.window_label.clone()
    }

    pub fn window_label(&self) -> String {
        read_label(&self.window_label)
    }

    pub fn app_handle(&self) -> &AppHandle {
        &self.app
    }

    pub fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) -> tauri::Result<()> {
        let label = self.window_label();
        self.app
            .emit_to(EventTarget::webview_window(label), event, payload)
    }
}

#[cfg(test)]
mod tests {
    use super::{rebind_agent_event_window, run_window};

    #[test]
    fn rebind_updates_only_handed_off_sessions() {
        let from = "handoff-test-source-slot";
        let to = "handoff-test-feature-agent";
        let first = run_window("handoff-first", from);
        let second = run_window("handoff-second", from);
        assert!(rebind_agent_event_window(
            from,
            to,
            &["handoff-first".into()]
        ));
        assert_eq!(first.read().unwrap().as_str(), to);
        assert_eq!(second.read().unwrap().as_str(), from);
        assert_eq!(
            run_window("handoff-future", from).read().unwrap().as_str(),
            from
        );
    }

    #[test]
    fn rebind_leaves_other_windows_and_refuses_a_noop() {
        let other = "handoff-test-unrelated-window";
        let slot = run_window("handoff-unrelated", other);
        let ids = ["handoff-unrelated".into()];
        assert!(!rebind_agent_event_window(other, other, &ids));
        assert!(!rebind_agent_event_window("", "feature-agent", &ids));
        assert!(!rebind_agent_event_window(
            "wrong-window",
            "feature-agent",
            &ids
        ));
        assert_eq!(slot.read().unwrap().as_str(), other);
    }
}
