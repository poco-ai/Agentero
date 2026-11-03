//! Open the system default terminal at a local path, or with a confirm-then-run command.

use crate::core::error::AppError;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(all(unix, not(target_os = "macos")))]
type TerminalCommandFactory = fn(&str) -> Command;

/// Resolve folders/files to a cwd; local Windows paths use a shell-compatible form.
pub fn terminal_cwd_for_path(path: &Path) -> Result<PathBuf, AppError> {
    if path.as_os_str().is_empty() {
        return Err(AppError::message("path is required"));
    }
    let meta = std::fs::metadata(path)
        .map_err(|e| AppError::message(format!("path not found ({}): {e}", path.display())))?;
    let cwd = if meta.is_dir() {
        path.to_path_buf()
    } else {
        path.parent()
            .filter(|p| !p.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .ok_or_else(|| AppError::message("cannot resolve parent directory"))?
    };
    #[cfg(windows)]
    let cwd = crate::core::process::windows_shell_path(&cwd);
    Ok(cwd)
}

/// Open the system default terminal with cwd at `path` (or its parent if a file).
///
/// `preferred` is a preset id from Settings; empty means the system default.
/// A missing or failing preset logs and falls back to the system default so the
/// action never fails just because a terminal was uninstalled.
pub fn open_in_terminal(path: &Path, preferred: &str) -> Result<PathBuf, AppError> {
    let cwd = terminal_cwd_for_path(path)?;
    let preferred = preferred.trim();
    if !preferred.is_empty() {
        match presets::launch(preferred, &cwd) {
            Ok(()) => return Ok(cwd),
            Err(error) => log::warn!(
                target: "agentero::terminal",
                "preferred terminal '{preferred}' unavailable, using system default: {error}"
            ),
        }
    }
    open_terminal_at(&cwd)?;
    Ok(cwd)
}

/// Copy and temp-script identity shared by terminal launches (banner title for
/// confirm-to-run flows, post-run hint and temp script name prefix).
struct ConfirmCopy {
    /// Temp script file prefix ("install" / "login").
    stem: &'static str,
    /// Banner title printed above the command.
    title: &'static str,
    /// Hint printed after the command finishes successfully.
    done_hint: &'static str,
}

#[cfg(windows)]
const CONFIRM_INSTALL: ConfirmCopy = ConfirmCopy {
    stem: "install",
    title: "Agentero - install helper",
    done_hint: "Done. Return to Agentero Settings - Agent and click Refresh.",
};

#[cfg(windows)]
const CONFIRM_LOGIN: ConfirmCopy = ConfirmCopy {
    stem: "login",
    title: "Agentero - agent login",
    done_hint: "Done. Agentero will re-check the login status automatically.",
};

#[cfg(not(windows))]
const CONFIRM_INSTALL: ConfirmCopy = ConfirmCopy {
    stem: "install",
    title: "Agentero — install helper",
    done_hint: "Done. Return to Agentero → Settings → Agent and click Refresh.",
};

#[cfg(not(windows))]
const CONFIRM_LOGIN: ConfirmCopy = ConfirmCopy {
    stem: "login",
    title: "Agentero — agent login",
    done_hint: "Done. Agentero will re-check the login status automatically.",
};

#[cfg(windows)]
const CONFIRM_AGENT_CLI: ConfirmCopy = ConfirmCopy {
    stem: "agent-cli",
    title: "Agentero - agent CLI",
    done_hint: "Agent CLI session ended. You can close this window.",
};

#[cfg(not(windows))]
const CONFIRM_AGENT_CLI: ConfirmCopy = ConfirmCopy {
    stem: "agent-cli",
    title: "Agentero — agent CLI",
    done_hint: "Agent CLI session ended. You can close this window.",
};

/// How the terminal should run the command: `Confirm` prints it and waits for
/// Enter, `Direct` runs it immediately.
#[derive(Clone, Copy)]
enum RunMode {
    Confirm,
    Direct,
}

/// Open a system terminal that prints `command`, waits for Enter (or Ctrl+C), then runs it.
///
/// Used for guided installs (e.g. Claude ACP adapter). The shell never auto-runs without
/// confirmation. Only trusted Host-side callers should pass commands.
pub fn open_terminal_confirm_command(command: &str) -> Result<(), AppError> {
    run_terminal_script(command, &CONFIRM_INSTALL, RunMode::Confirm)
}

/// Same confirm-to-run terminal as [`open_terminal_confirm_command`], worded for
/// agent CLI OAuth login flows (e.g. `codex login`, `claude auth login`).
pub fn open_terminal_confirm_login(command: &str) -> Result<(), AppError> {
    run_terminal_script(command, &CONFIRM_LOGIN, RunMode::Confirm)
}

/// Open a system terminal that immediately launches an installed Agent's
/// interactive CLI (e.g. `claude`, `codex`).
///
/// No Enter gate: the click is an explicit launch of the user's own installed
/// CLI, not an unattended installer.
pub fn open_terminal_agent_cli(command: &str) -> Result<(), AppError> {
    run_terminal_script(command, &CONFIRM_AGENT_CLI, RunMode::Direct)
}

fn run_terminal_script(command: &str, copy: &ConfirmCopy, mode: RunMode) -> Result<(), AppError> {
    let command = command.trim();
    if command.is_empty() {
        return Err(AppError::message("command is required"));
    }
    // Reject multi-line / shell metacharacter abuse from unexpected callers.
    if command.contains('\n') || command.contains('\r') || command.contains(';') {
        return Err(AppError::message("command contains disallowed characters"));
    }

    #[cfg(windows)]
    {
        open_terminal_command_windows(command, copy, mode)
    }
    #[cfg(not(windows))]
    {
        open_terminal_command_unix(command, copy, mode)
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
    if destination.contains('\n')
        || destination.contains('\r')
        || destination.contains(';')
        || destination.contains(' ')
    {
        return Err(AppError::message(
            "SSH destination contains disallowed characters",
        ));
    }
    if install_command.contains('\n')
        || install_command.contains('\r')
        || install_command.contains(';')
    {
        return Err(AppError::message(
            "install command contains disallowed characters",
        ));
    }

    #[cfg(windows)]
    {
        // Single remote command string so the whole npm line is the -c payload.
        let command = format!("ssh -t {destination} -- \"bash -lc {install_command:?}\"");
        open_terminal_command_windows(&command, &CONFIRM_INSTALL, RunMode::Confirm)
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
  ssh -T "$DEST" "bash -lc $(printf '%q' 'command -v claude-agent-acp || command -v opencode || command -v hermes || true; ls -la \"$HOME/.local/bin\" 2>/dev/null | head -20')" || true
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
fn open_terminal_command_unix(
    command: &str,
    copy: &ConfirmCopy,
    mode: RunMode,
) -> Result<(), AppError> {
    let script_path = write_terminal_script_unix(command, copy, mode)?;
    let script = script_path.to_string_lossy().replace('\'', "'\\''");

    #[cfg(target_os = "macos")]
    {
        // Terminal.app: run the script in a new window.
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
        let candidates: &[(&str, TerminalCommandFactory)] = &[
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
fn write_terminal_script_unix(
    command: &str,
    copy: &ConfirmCopy,
    mode: RunMode,
) -> Result<PathBuf, AppError> {
    let dir = std::env::temp_dir().join("agentero-install");
    fs::create_dir_all(&dir)
        .map_err(|e| AppError::message(format!("failed to create temp dir: {e}")))?;
    let path = dir.join(format!("{}-{}.sh", copy.stem, std::process::id()));
    // Single-quoted shell literal for the command display/run.
    let quoted = command.replace('\'', "'\\''");
    let title = copy.title;
    let done_hint = copy.done_hint;
    let body = match mode {
        RunMode::Confirm => format!(
            r#"#!/usr/bin/env bash
set +e
echo ""
echo "{title}"
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
  echo "{done_hint}"
else
  echo "Command exited with status $status."
fi
echo "You can close this window."
"#
        ),
        RunMode::Direct => format!(
            r#"#!/usr/bin/env bash
set +e
bash -lc '{quoted}'
"#
        ),
    };
    fs::write(&path, body)
        .map_err(|e| AppError::message(format!("failed to write script: {e}")))?;
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
fn open_terminal_command_windows(
    command: &str,
    copy: &ConfirmCopy,
    mode: RunMode,
) -> Result<(), AppError> {
    let dir = std::env::temp_dir().join("agentero-install");
    fs::create_dir_all(&dir)
        .map_err(|e| AppError::message(format!("failed to create temp dir: {e}")))?;
    let path = dir.join(format!("{}-{}.cmd", copy.stem, std::process::id()));
    let title = copy.title;
    let done_hint = copy.done_hint;
    // The display `echo` line must not execute the command's shell syntax:
    // escape cmd metacharacters for display only. The run line below stays
    // raw so multi-statement logins (`mkdir … & if not exist … echo …> …`)
    // keep working.
    let display = command
        .replace('^', "^^")
        .replace('&', "^&")
        .replace('>', "^>")
        .replace('|', "^|")
        .replace('<', "^<");
    let body = match mode {
        RunMode::Confirm => format!(
            "@echo off\r\n\
echo.\r\n\
echo {title}\r\n\
echo Command:\r\n\
echo   {display}\r\n\
echo.\r\n\
echo Press any key to run, or close this window to cancel...\r\n\
pause >nul\r\n\
echo.\r\n\
echo Running...\r\n\
{command}\r\n\
set STATUS=%ERRORLEVEL%\r\n\
echo.\r\n\
if %STATUS%==0 (\r\n\
  echo {done_hint}\r\n\
) else (\r\n\
  echo Command exited with status %STATUS%.\r\n\
)\r\n\
echo You can close this window.\r\n\
pause\r\n"
        ),
        RunMode::Direct => format!("@echo off\r\n{command}\r\n"),
    };
    fs::write(&path, body)
        .map_err(|e| AppError::message(format!("failed to write script: {e}")))?;

    // Rust's `Command` spawns wt directly (no shell), so a literal
    // `%USERPROFILE%` is never expanded and wt fails with "cannot access startup
    // directory" (it resolves the literal against the app's cwd). Resolve the
    // real profile path; fall back to the temp dir, which is guaranteed to
    // exist (the script was just written under it).
    let start_dir = std::env::var("USERPROFILE")
        .ok()
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| dir.display().to_string());

    if Command::new("wt")
        .arg("-d")
        .arg(&start_dir)
        .args(["cmd", "/K"])
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
    if Command::new("wt.exe").arg("-d").arg(cwd).spawn().is_ok() {
        return Ok(());
    }
    let status = cmd_terminal_command(cwd)
        .status()
        .map_err(|e| AppError::message(format!("failed to open terminal: {e}")))?;
    if !status.success() {
        return Err(AppError::message(format!(
            "failed to open terminal (exit {status})"
        )));
    }
    Ok(())
}

#[cfg(windows)]
fn cmd_terminal_command(cwd: &Path) -> Command {
    // `start` gives the interactive shell its own console handles. Directly
    // spawning cmd with CREATE_NEW_CONSOLE can inherit closed/redirected stdin
    // from the desktop app and exit immediately. Never put the path in script.
    let mut command = Command::new("cmd.exe");
    command
        .args(["/D", "/C", "start", "", "cmd.exe", "/D"])
        .current_dir(cwd);
    // Hide only the launcher; `start` still opens the interactive console.
    crate::core::process::hide_console_window(&mut command);
    command
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
    #[cfg(windows)]
    fn cmd_opens_canonical_paths_with_interactive_stdio() {
        use base64::Engine;
        use std::process::Stdio;
        use std::time::{Duration, Instant};

        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("中文 Vault & %CD% ! (notes)^");
        fs::create_dir(&dir).unwrap();
        let file = dir.join("note.md");
        fs::write(&file, "x").unwrap();

        // The probe runs inside the actual terminal, then exits. No typing or
        // persistent test windows; redirected parent handles reproduce GUI EOF.
        let script = r#"
$result = @{
    cwd = (Get-Location).Path
    inputRedirected = [Console]::IsInputRedirected
    outputRedirected = [Console]::IsOutputRedirected
}
[IO.File]::WriteAllText($env:AGENTERO_TERMINAL_PROBE, ($result | ConvertTo-Json -Compress))
"#;
        let encoded = base64::engine::general_purpose::STANDARD.encode(
            script
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );

        for (index, path) in [&dir, &file].into_iter().enumerate() {
            let canonical = fs::canonicalize(path).unwrap();
            let cwd = terminal_cwd_for_path(&canonical).unwrap();
            assert!(!cwd.to_string_lossy().starts_with(r"\\?\"));
            let probe = temp.path().join(format!("probe-{index}.json"));
            let status = cmd_terminal_command(&cwd)
                .args([
                    "/C",
                    "powershell.exe",
                    "-NoProfile",
                    "-EncodedCommand",
                    &encoded,
                ])
                .env("AGENTERO_TERMINAL_PROBE", &probe)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(status.success(), "{status}");
            let deadline = Instant::now() + Duration::from_secs(10);
            let result = loop {
                if let Some(result) = fs::read_to_string(&probe)
                    .ok()
                    .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
                {
                    break result;
                }
                assert!(Instant::now() < deadline, "terminal probe did not run");
                std::thread::sleep(Duration::from_millis(20));
            };
            assert_eq!(Path::new(result["cwd"].as_str().unwrap()), cwd);
            assert_eq!(result["inputRedirected"], false);
            assert_eq!(result["outputRedirected"], false);
        }
    }

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
}

/// Tauri command shells for this feature.
pub mod commands;
pub(crate) mod presets;
