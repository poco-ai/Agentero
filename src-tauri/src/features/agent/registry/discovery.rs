//! Agent-specific command discovery helpers.
//!
//! Generic PATH / executable resolution lives in `crate::core::process::discover`;
//! this module adds desktop-host discovery where installation probes need Tauri.

pub use crate::core::process::discover::login_shell_env;
#[cfg(not(windows))]
pub use crate::core::process::discover::{path_entries, probe_command, resolve_command};

#[cfg(windows)]
pub fn path_entries() -> Vec<std::path::PathBuf> {
    let mut paths = crate::core::process::discover::path_entries();
    if let Some(directory) = crate::features::system::desktop_apps::dsh_cli_dir() {
        if !paths.contains(&directory) {
            paths.push(directory);
        }
    }
    paths
}

#[cfg(windows)]
pub fn resolve_command(command: &str) -> Option<std::path::PathBuf> {
    crate::core::process::resolve_command(command).or_else(|| {
        // Explicit paths remain authoritative. Only the known Dsh command may
        // use the desktop installation fallback.
        if command != "dsh" {
            return None;
        }
        let directory = crate::features::system::desktop_apps::dsh_cli_dir()?;
        crate::core::process::resolve_command_in_paths(command, &[directory])
    })
}

#[cfg(windows)]
pub fn probe_command(command: &str) -> Result<std::path::PathBuf, String> {
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
