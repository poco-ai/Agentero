use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use tauri::{AppHandle, Emitter, EventTarget};

/// Window label shared by every emitter created for that label.
///
/// In-flight runs each hold an `AgentEventEmitter`. Cloning the struct used to
/// copy a `String`, so a later assignment could not reach runs that had already
/// started. Emitters for the same source label share this `Arc` instead.
/// [`rebind_agent_event_window`] updates the cell; the next `emit` reads it.
fn window_label_slots() -> &'static Mutex<HashMap<String, Arc<RwLock<String>>>> {
    static SLOTS: OnceLock<Mutex<HashMap<String, Arc<RwLock<String>>>>> = OnceLock::new();
    SLOTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_slots() -> std::sync::MutexGuard<'static, HashMap<String, Arc<RwLock<String>>>> {
    window_label_slots()
        .lock()
        .unwrap_or_else(|err| err.into_inner())
}

pub(crate) fn shared_window_label(label: impl Into<String>) -> Arc<RwLock<String>> {
    let label = label.into();
    let mut slots = lock_slots();
    slots
        .entry(label.clone())
        .or_insert_with(|| Arc::new(RwLock::new(label)))
        .clone()
}

fn read_label(slot: &RwLock<String>) -> String {
    slot.read().unwrap_or_else(|err| err.into_inner()).clone()
}

/// Point emitters created for `from` at `to`.
///
/// Runs that already captured an emitter share the slot, so events they emit
/// after this call go to `to`. Until this runs, they keep emitting to `from`.
/// Returns false when there is nothing to retarget (`from` is empty or equal
/// to `to`). A missing slot is created so a run that starts on `from` after
/// the handoff still follows the target.
pub fn rebind_agent_event_window(from: &str, to: &str) -> bool {
    if from.is_empty() || to.is_empty() || from == to {
        return false;
    }
    let slot = shared_window_label(from);
    *slot.write().unwrap_or_else(|err| err.into_inner()) = to.to_string();
    true
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
            window_label: shared_window_label(window_label),
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
    use super::{rebind_agent_event_window, shared_window_label};

    #[test]
    fn rebind_updates_every_emitter_that_shares_the_source_slot() {
        let from = "handoff-test-source-slot";
        let to = "handoff-test-feature-agent";
        let first = shared_window_label(from);
        let second = shared_window_label(from);
        assert!(rebind_agent_event_window(from, to));
        assert_eq!(first.read().unwrap().as_str(), to);
        assert_eq!(second.read().unwrap().as_str(), to);
        // A run started against the source label after the ack follows the target.
        assert_eq!(shared_window_label(from).read().unwrap().as_str(), to);
    }

    #[test]
    fn rebind_leaves_other_windows_and_refuses_a_noop() {
        let other = "handoff-test-unrelated-window";
        let slot = shared_window_label(other);
        assert!(!rebind_agent_event_window(other, other));
        assert!(!rebind_agent_event_window("", "feature-agent"));
        assert_eq!(slot.read().unwrap().as_str(), other);
    }
}
