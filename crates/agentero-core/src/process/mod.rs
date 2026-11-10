#[cfg(any(target_os = "macos", test))]
mod desktop_cli;
pub mod discover;
#[cfg(windows)]
mod windows_job;

pub use discover::{path_entries, probe_command, resolve_command, resolve_command_in_paths};

/// Capture a prepared command's output and own its process tree until the
/// future completes. Dropping it (timeout or cancellation) kills Windows
/// descendants too; `kill_on_drop` alone only kills the directly spawned process.
///
/// Stdio matches `Command::output`: stdin is closed, both output pipes are captured.
pub async fn command_output(
    command: &mut tokio::process::Command,
) -> std::io::Result<std::process::Output> {
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    ProcessTree::spawn(command)?.wait_with_output().await
}

/// A spawned process whose Windows descendants die with this guard.
///
/// Unix keeps `kill_on_drop` on the direct child. Callers that already put the
/// child in its own process group still have to signal that group themselves.
pub struct ProcessTree {
    /// Dropped before `child` so a launcher's descendants cannot outlive the guard.
    #[cfg(windows)]
    job: Option<windows_job::Job>,
    child: tokio::process::Child,
}

impl ProcessTree {
    pub fn spawn(command: &mut tokio::process::Command) -> std::io::Result<Self> {
        #[cfg(windows)]
        {
            let (child, job) = windows_job::spawn(command)?;
            Ok(Self {
                child,
                job: Some(job),
            })
        }
        #[cfg(not(windows))]
        {
            command.kill_on_drop(true);
            Ok(Self {
                child: command.spawn()?,
            })
        }
    }

    pub fn id(&self) -> Option<u32> {
        self.child.id()
    }

    pub fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        self.child.try_wait()
    }

    pub async fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        self.child.wait().await
    }

    /// Kill the direct child. On Windows the job is closed first, so descendants
    /// die even when the root is only a `.cmd` / `perl` launcher.
    pub fn start_kill(&mut self) -> std::io::Result<()> {
        #[cfg(windows)]
        {
            self.job.take();
            let _ = self.child.start_kill();
            Ok(())
        }
        #[cfg(not(windows))]
        self.child.start_kill()
    }

    pub async fn kill(&mut self) -> std::io::Result<()> {
        self.start_kill()
    }

    pub fn stdin(&mut self) -> &mut Option<tokio::process::ChildStdin> {
        &mut self.child.stdin
    }

    pub fn stdout(&mut self) -> &mut Option<tokio::process::ChildStdout> {
        &mut self.child.stdout
    }

    pub fn stderr(&mut self) -> &mut Option<tokio::process::ChildStderr> {
        &mut self.child.stderr
    }

    pub async fn wait_with_output(self) -> std::io::Result<std::process::Output> {
        #[cfg(windows)]
        {
            let Self { mut child, mut job } = self;
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();
            // A descendant can inherit the output pipes. Close the job as soon as
            // the root exits, before waiting for pipe EOF, or output can hang even
            // after a successful launcher exit. Abort/timeout drops this guard too.
            let wait = async move {
                let status = child.wait().await;
                job.take();
                status
            };
            let (status, stdout, stderr) =
                tokio::try_join!(wait, read_pipe(stdout), read_pipe(stderr))?;
            Ok(std::process::Output {
                status,
                stdout,
                stderr,
            })
        }
        #[cfg(not(windows))]
        self.child.wait_with_output().await
    }
}

/// Synchronous counterpart of [`ProcessTree`] for installers that already run
/// on a blocking thread.
pub struct BlockingProcessTree {
    /// Dropped before `child` so a launcher's descendants cannot outlive the guard.
    #[cfg(windows)]
    job: Option<windows_job::Job>,
    child: std::process::Child,
}

impl BlockingProcessTree {
    pub fn spawn(command: &mut std::process::Command) -> std::io::Result<Self> {
        #[cfg(windows)]
        {
            let (child, job) = windows_job::spawn_std(command)?;
            Ok(Self {
                child,
                job: Some(job),
            })
        }
        #[cfg(not(windows))]
        Ok(Self {
            child: command.spawn()?,
        })
    }

    pub fn take_stdout(&mut self) -> Option<std::process::ChildStdout> {
        self.child.stdout.take()
    }

    pub fn take_stderr(&mut self) -> Option<std::process::ChildStderr> {
        self.child.stderr.take()
    }

    pub fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        self.child.try_wait()
    }

    pub fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        self.child.wait()
    }

    pub fn kill(&mut self) -> std::io::Result<()> {
        #[cfg(windows)]
        {
            self.job.take();
            let _ = self.child.kill();
            Ok(())
        }
        #[cfg(not(windows))]
        self.child.kill()
    }
}

/// Only the Windows `wait_with_output` path reads pipes itself. Unix uses
/// `Child::wait_with_output`, so this helper must stay out of non-Windows
/// builds or `-D warnings` rejects it as dead code.
#[cfg(windows)]
async fn read_pipe(pipe: Option<impl tokio::io::AsyncRead + Unpin>) -> std::io::Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let mut bytes = Vec::new();
    if let Some(mut pipe) = pipe {
        pipe.read_to_end(&mut bytes).await?;
    }
    Ok(bytes)
}

/// Win32 `CREATE_NO_WINDOW` process creation flag.
///
/// The released Host is a GUI-subsystem binary, so Windows allocates a visible
/// console window for every console child process spawned without this flag.
/// `gh` (the Skill-import GitHub CLI fallback) is a console program, so each
/// `gh api` / `gh auth token` call would otherwise flash a black terminal (#741).
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Hide the console window a spawned console program would otherwise get on
/// Windows. No-op on other platforms.
pub fn hide_console_window(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// [`hide_console_window`] for `tokio::process::Command`.
pub fn hide_console_window_tokio(command: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// Remove the extended-length prefix from local Windows drive paths before
/// handing them to cmd.exe or MSYS2 shells. UNC/device paths retain their own
/// semantics and must not be turned into relative paths by stripping `\\?\`.
pub fn windows_shell_path(path: &std::path::Path) -> std::path::PathBuf {
    let value = path.to_string_lossy();
    match value.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => rest.into(),
        _ => path.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_shell_path_strips_extended_prefix() {
        // Rust canonicalize() hands back extended-length drive paths; cmd.exe
        // and MSYS2 shells cannot cd into them, so callers get the plain form.
        assert_eq!(
            windows_shell_path(std::path::Path::new(r"\\?\D:\Documents\Zotero")),
            std::path::PathBuf::from(r"D:\Documents\Zotero")
        );
        assert_eq!(
            windows_shell_path(std::path::Path::new(r"D:\Documents\Zotero")),
            std::path::PathBuf::from(r"D:\Documents\Zotero")
        );
        // UNC layouts have no plain drive form and stay unchanged.
        assert_eq!(
            windows_shell_path(std::path::Path::new(r"\\?\UNC\server\share")),
            std::path::Path::new(r"\\?\UNC\server\share")
        );
        // POSIX paths pass through untouched.
        assert_eq!(
            windows_shell_path(std::path::Path::new("/home/user/vault")),
            std::path::Path::new("/home/user/vault")
        );
    }
}
