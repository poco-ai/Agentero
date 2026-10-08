//! `agentero ui *` — workspace / window management from the CLI.
//!
//! Mirrors the desktop workspace primitives (open-or-focus a document or a
//! native child window, close a document) so scripts and external agents can
//! drive the running App without touching its internals.

use crate::error::CliError;
use crate::resolve::{resolve_vault, GlobalOpts};
use clap::{Subcommand, ValueHint};
use serde_json::Value;

/// Window ids `agentero ui window` may target (mirrors the desktop frontend's
/// openable windows).
const UI_WINDOWS: &[&str] = &["settings", "agent", "annotations"];

#[derive(Debug, Subcommand)]
pub enum UiCmd {
    /// Open (or focus) a Vault-relative document / folder / paper in the workspace.
    Open {
        /// Vault-relative path (e.g. `notes/idea.md`, `papers/demo`).
        #[arg(value_hint = ValueHint::DirPath)]
        path: String,
    },
    /// Close the workspace panel(s) for a Vault-relative path.
    Close {
        /// Vault-relative path (e.g. `notes/idea.md`, `papers/demo`).
        #[arg(value_hint = ValueHint::DirPath)]
        path: String,
    },
    /// Open (or focus) a native child window.
    ///
    /// `view` is `settings` or a right-rail feature: agent / backlinks /
    /// annotations / references / figures.
    Window {
        /// Window id (`settings`, `agent`, `backlinks`, …).
        view: String,
        /// Settings section (only meaningful for `settings`).
        #[arg(long = "section")]
        section: Option<String>,
    },
}

pub fn run(cmd: UiCmd, globals: &GlobalOpts) -> Result<Value, CliError> {
    match cmd {
        UiCmd::Open { path } => {
            let vault = resolve_vault(globals)?;
            crate::commands::open::open_path_in_app(&vault, &path, globals)
        }
        UiCmd::Close { path } => {
            let vault = resolve_vault(globals)?;
            crate::commands::open::close_path_in_app(&vault, &path, globals)
        }
        UiCmd::Window { view, section } => {
            let view = view.trim().to_ascii_lowercase();
            if !UI_WINDOWS.contains(&view.as_str()) {
                return Err(CliError::usage(format!(
                    "unknown window: {view} (expected one of {})",
                    UI_WINDOWS.join(", ")
                )));
            }
            crate::commands::open::open_window_in_app(&view, section, globals)
        }
    }
}
