//! External terminals the user can pick for "Open in Terminal".
//!
//! Detection is best-effort and local-only. Launching a preset always targets
//! the resolved cwd; callers fall back to the system default when a preset is
//! missing or its launch fails, so a stale setting never breaks the action.

use crate::core::error::AppError;
use serde::Serialize;
use std::path::Path;
#[cfg(target_os = "macos")]
use std::path::PathBuf;
use std::process::Command;

/// One row in Settings. `name` is a brand name shown verbatim.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAppStatus {
    pub id: String,
    pub name: String,
    pub installed: bool,
}

struct Preset {
    id: &'static str,
    name: &'static str,
}

#[cfg(target_os = "macos")]
const PRESETS: &[Preset] = &[
    Preset {
        id: "terminal",
        name: "Terminal",
    },
    Preset {
        id: "iterm",
        name: "iTerm2",
    },
    Preset {
        id: "otty",
        name: "Otty",
    },
];

#[cfg(windows)]
const PRESETS: &[Preset] = &[
    Preset {
        id: "wt",
        name: "Windows Terminal",
    },
    Preset {
        id: "powershell",
        name: "PowerShell",
    },
    Preset {
        id: "cmd",
        name: "Command Prompt",
    },
];

#[cfg(all(unix, not(target_os = "macos")))]
const PRESETS: &[Preset] = &[
    Preset {
        id: "gnome-terminal",
        name: "GNOME Terminal",
    },
    Preset {
        id: "konsole",
        name: "Konsole",
    },
    Preset {
        id: "xfce4-terminal",
        name: "Xfce Terminal",
    },
    Preset {
        id: "kitty",
        name: "kitty",
    },
    Preset {
        id: "alacritty",
        name: "Alacritty",
    },
    Preset {
        id: "wezterm",
        name: "WezTerm",
    },
];

/// Probe every preset on this platform. `mdfind` lookups make this blocking.
pub fn probe() -> Vec<TerminalAppStatus> {
    PRESETS
        .iter()
        .map(|preset| TerminalAppStatus {
            id: preset.id.to_string(),
            name: preset.name.to_string(),
            installed: is_installed(preset.id),
        })
        .collect()
}

/// Launch `id` with `cwd`. Unknown or missing presets return an error so the
/// caller can fall back to the system default.
pub fn launch(id: &str, cwd: &Path) -> Result<(), AppError> {
    let preset = PRESETS
        .iter()
        .find(|preset| preset.id == id)
        .ok_or_else(|| AppError::message(format!("unknown terminal app: {id}")))?;
    if !is_installed(preset.id) {
        return Err(AppError::message(format!(
            "{} is not installed",
            preset.name
        )));
    }
    launch_installed(preset.id, cwd)
}

#[cfg(target_os = "macos")]
fn is_installed(id: &str) -> bool {
    // Terminal.app ships with macOS; older systems keep it under `/Applications`.
    id == "terminal" || macos_app(id).is_some()
}

#[cfg(target_os = "macos")]
fn macos_app(id: &str) -> Option<PathBuf> {
    use crate::features::system::desktop_apps::detect_macos_app;

    match id {
        "iterm" => detect_macos_app(&["iTerm", "iTerm2"], &["com.googlecode.iterm2"]),
        "otty" => detect_macos_app(&["Otty"], &[]),
        _ => None,
    }
}

#[cfg(windows)]
fn is_installed(id: &str) -> bool {
    match id {
        // Both are part of Windows itself.
        "powershell" | "cmd" => true,
        _ => in_path(id, Some(".exe")),
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn is_installed(id: &str) -> bool {
    in_path(id, None)
}

#[cfg(not(target_os = "macos"))]
fn in_path(bin: &str, extension: Option<&str>) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| {
        dir.join(bin).is_file()
            || extension.is_some_and(|extension| dir.join(format!("{bin}{extension}")).is_file())
    })
}

#[cfg(target_os = "macos")]
fn launch_installed(id: &str, cwd: &Path) -> Result<(), AppError> {
    match id {
        // `open -a Terminal <dir>` starts the shell with that directory as cwd.
        "terminal" => open_app("Terminal", cwd),
        "iterm" => launch_iterm(cwd),
        "otty" => launch_otty(cwd),
        _ => Err(unknown_terminal(id)),
    }
}

#[cfg(target_os = "macos")]
fn launch_iterm(cwd: &Path) -> Result<(), AppError> {
    // Bundle id keeps working when iTerm is renamed; `write text` is the
    // long-standing way to cd without depending on shell integration.
    let script = format!(
        "tell application id \"com.googlecode.iterm2\"\n\
         activate\n\
         set newWindow to (create window with default profile)\n\
         tell current session of newWindow\n\
         write text \"{}\"\n\
         end tell\n\
         end tell",
        apple_quote(&cd_command(cwd))
    );
    run_osascript(&script)
}

#[cfg(target_os = "macos")]
fn launch_otty(cwd: &Path) -> Result<(), AppError> {
    // Otty's CLI opens a window in a directory without Apple Events
    // automation. It is only on PATH after the user installs it, so try the
    // bundled CLI and common install locations before AppleScript.
    for bin in otty_cli_candidates() {
        if Command::new(&bin)
            .arg("open")
            .arg(cwd)
            .status()
            .is_ok_and(|s| s.success())
        {
            return Ok(());
        }
    }
    let script = format!(
        "tell application \"Otty\"\n\
         activate\n\
         do script \"{}\"\n\
         end tell",
        apple_quote(&cd_command(cwd))
    );
    run_osascript(&script)
}

#[cfg(target_os = "macos")]
fn otty_cli_candidates() -> Vec<PathBuf> {
    let mut candidates = vec![
        PathBuf::from("/usr/local/bin/otty"),
        PathBuf::from("/opt/homebrew/bin/otty"),
    ];
    if let Some(app) = macos_app("otty") {
        candidates.push(app.join("Contents/MacOS/otty-cli"));
    }
    candidates.push(PathBuf::from("otty"));
    candidates
}

#[cfg(target_os = "macos")]
fn open_app(name: &str, cwd: &Path) -> Result<(), AppError> {
    let status = Command::new("open")
        .args(["-a", name])
        .arg(cwd)
        .status()
        .map_err(|e| AppError::message(format!("failed to open {name}: {e}")))?;
    if !status.success() {
        return Err(AppError::message(format!(
            "failed to open {name} (exit {status})"
        )));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn run_osascript(script: &str) -> Result<(), AppError> {
    let status = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .status()
        .map_err(|e| AppError::message(format!("failed to run osascript: {e}")))?;
    if !status.success() {
        return Err(AppError::message(format!(
            "osascript failed (exit {status})"
        )));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn cd_command(cwd: &Path) -> String {
    format!("cd '{}'", cwd.to_string_lossy().replace('\'', "'\\''"))
}

#[cfg(target_os = "macos")]
fn apple_quote(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(windows)]
fn launch_installed(id: &str, cwd: &Path) -> Result<(), AppError> {
    match id {
        "wt" => {
            let mut command = Command::new("wt.exe");
            command.arg("-d").arg(cwd);
            spawn(command)
        }
        "powershell" => {
            let mut command = Command::new("cmd.exe");
            command
                .args(["/D", "/C", "start", "", "powershell.exe", "-NoExit"])
                .current_dir(cwd);
            crate::core::process::hide_console_window(&mut command);
            spawn(command)
        }
        "cmd" => spawn(super::cmd_terminal_command(cwd)),
        _ => Err(unknown_terminal(id)),
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn launch_installed(id: &str, cwd: &Path) -> Result<(), AppError> {
    let mut command = Command::new(id);
    match id {
        "gnome-terminal" | "mate-terminal" | "tilix" => {
            command.arg("--working-directory").arg(cwd);
        }
        "konsole" => {
            command.arg("--workdir").arg(cwd);
        }
        "xfce4-terminal" => {
            command.arg("--working-directory").arg(cwd);
        }
        "kitty" => {
            command.arg("--directory").arg(cwd);
        }
        "alacritty" => {
            command.arg("--working-directory").arg(cwd);
        }
        "wezterm" => {
            command.args(["start", "--cwd"]).arg(cwd);
        }
        _ => return Err(unknown_terminal(id)),
    }
    spawn(command)
}

#[cfg(not(target_os = "macos"))]
fn spawn(mut command: Command) -> Result<(), AppError> {
    command
        .spawn()
        .map(|_| ())
        .map_err(|e| AppError::message(format!("failed to open terminal: {e}")))
}

fn unknown_terminal(id: &str) -> AppError {
    AppError::message(format!("unknown terminal app: {id}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preset_ids_are_unique_and_non_empty() {
        let mut seen = std::collections::HashSet::new();
        for preset in PRESETS {
            assert!(!preset.id.is_empty());
            assert!(!preset.name.is_empty());
            assert!(seen.insert(preset.id), "duplicate terminal id");
        }
    }

    #[test]
    fn unknown_launch_fails_so_callers_can_fall_back() {
        let cwd = std::env::temp_dir();
        assert!(launch("definitely-not-a-terminal", &cwd).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn cd_command_quotes_single_quotes() {
        assert_eq!(
            cd_command(Path::new("/tmp/it's here")),
            "cd '/tmp/it'\\''s here'"
        );
    }
}
