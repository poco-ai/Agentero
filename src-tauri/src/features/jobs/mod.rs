//! Cross-cutting frontend background-task commands.
//!
//! Cancellation state lives in `core::background_tasks`; this module only
//! exposes the Tauri command surface (kept out of `core` / `agent`).

pub mod commands;
