//! Serialize create-or-focus for singleton native windows.
//!
//! Tauri only registers a window label once the window exists, and its
//! duplicate-label check runs on the calling thread (`prepare_window`), before
//! the event loop creates the window. Two overlapping `async` commands that
//! both observe "no such window" therefore both pass the check and both build
//! a real window; the manager keeps only the later one, so the other is a
//! titled window nobody can focus or close through the singleton label. On
//! Windows that is the extra window reported in #1144.
//!
//! Create-or-focus must hold this gate from the existence check through
//! `build()`. `build()` blocks the calling thread while the event loop creates
//! the window, so a plain mutex is enough. The guard must never be held across
//! an `.await`: that would make the command future non-`Send`.

use std::sync::{Mutex, MutexGuard};

static CREATE_GATE: Mutex<()> = Mutex::new(());

/// Held for the whole create-or-focus sequence of a singleton window.
pub(crate) fn create_gate() -> MutexGuard<'static, ()> {
    CREATE_GATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
