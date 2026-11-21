//! Read-only research context for one ACP turn.
//!
//! Host turns a [`ContextRequest`] into a [`ContextPlan`]: the minimum evidence
//! that belongs in the prompt, the sources this turn may open, a budget, and a
//! fingerprint. The turn-bound CLI enforces the grant. The global
//! Vault MCP is a different permission model and is not reused here.

mod artifacts;
mod grant;
mod plan;
#[cfg(test)]
mod service;
mod types;

pub use artifacts::{present_files, PresentedFile, TURN_ENV};
pub use grant::{remember_session_fingerprint, resume_allowed, session_fingerprint};
pub use plan::{
    facts_from_anchors, plan_from_facts, render_prompt_block, resolve_in_vault, AnchorFacts,
};
pub use types::*;

/// Set only in the process environment of a locally scoped agent turn.
pub const CLI_GRANT_ENV: &str = "AGENTERO_CONTEXT_GRANT";

/// Tool profile name recorded in the fingerprint. Changing it starts a new session.
pub const TOOL_PROFILE: &str = "agentero-cli-evidence/v1";
