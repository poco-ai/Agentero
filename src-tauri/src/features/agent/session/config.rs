//! Session model / mode / effort / fast-mode preference types.
//!
//! Preference *application* (`session/set_config_option`) currently lives on
//! `RunOnceContext` in `run.rs` because it is tightly coupled to cancellation
//! and `agent:completed` emission. Warm uses the same ACP helpers from
//! `acp::updates` directly.

/// User-selected session preferences applied after the session opens.
#[derive(Debug, Clone, Default)]
pub(crate) struct RunPreferences {
    pub model_id: Option<String>,
    pub collaboration_mode_id: Option<String>,
    pub reasoning_effort: Option<String>,
    pub fast_mode: Option<bool>,
}
