//! Compatibility shim — terminal ACP lives in `acp::terminal`.
//! Prefer `crate::features::agent::acp::terminal` for new code.

pub use crate::features::agent::acp::terminal::*;
