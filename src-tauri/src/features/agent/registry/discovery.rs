//! Agent-specific command discovery helpers.
//!
//! Generic PATH / executable resolution lives in `crate::core::process::discover`;
//! this module adds desktop-host discovery where installation probes need Tauri.

pub use crate::core::process::discover::login_shell_env;
#[cfg(not(windows))]
pub use crate::core::process::discover::path_entries;

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

pub fn resolve_command(command: &str) -> Option<std::path::PathBuf> {
    crate::core::process::discover::resolve_command(command).or_else(|| {
        // A CLI bundled with a known desktop app (QwenWork's Qoder engine) only
        // stands in when nothing is PATH-installed, so lifecycle install/update
        // still targets the user's own tooling.
        crate::features::system::desktop_apps::bundled_cli(command)
            .or_else(|| dsh_desktop_fallback(command))
    })
}

/// Explicit paths remain authoritative. Only the known Dsh command may use the
/// Windows desktop installation fallback.
#[cfg(windows)]
fn dsh_desktop_fallback(command: &str) -> Option<std::path::PathBuf> {
    if command != "dsh" {
        return None;
    }
    let directory = crate::features::system::desktop_apps::dsh_cli_dir()?;
    crate::core::process::resolve_command_in_paths(command, &[directory])
}

#[cfg(not(windows))]
fn dsh_desktop_fallback(_command: &str) -> Option<std::path::PathBuf> {
    None
}

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
