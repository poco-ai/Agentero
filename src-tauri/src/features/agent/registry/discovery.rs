//! Agent-specific command discovery helpers.
//!
//! Generic PATH / executable resolution lives in `crate::core::process::discover`;
//! this module adds the probe wrapper used by the Agent registry.

pub use crate::core::process::discover::{path_entries, resolve_command};
use std::path::PathBuf;

pub fn probe_command(command: &str) -> Result<PathBuf, String> {
    resolve_command(command).ok_or_else(|| {
        format!("command `{command}` not found on PATH (or common install locations)")
    })
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::*;

    #[cfg(unix)]
    #[test]
    fn finds_sh_on_unix() {
        let p = resolve_command("sh");
        assert!(p.is_some());
    }

    #[test]
    fn probe_command_errors_for_missing_bin() {
        let err = super::probe_command("__agentero_missing_binary_xyz__").unwrap_err();
        assert!(err.contains("not found"));
    }
}
