//! One launch boundary for warm, prompt, probe and history ACP connections.
#[cfg(not(windows))]
pub(crate) use agent_client_protocol::AcpAgent;

#[cfg(windows)]
pub(crate) use windows::AcpAgent;

/// Synchronous: Tauri's static runtime is not dropped when the app exits.
pub(crate) fn shutdown() {
    #[cfg(windows)]
    windows::shutdown();
}

#[cfg(windows)]
mod windows {
    use agent_client_protocol::{schema::v1::McpServer, ConnectTo, LineDirection};
    use futures_util::StreamExt;
    use std::collections::VecDeque;
    use std::io;
    use std::os::windows::io::AsHandle;
    use std::sync::{Arc, Mutex, OnceLock, Weak};
    use std::time::Duration;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    use windows_spawn::{Command, CreationFlags, Job, SpawnOptions, Stdio};

    type DebugCallback = Arc<dyn Fn(&str, LineDirection) + Send + Sync>;
    const GRACE: Duration = Duration::from_secs(1);

    #[derive(Default)]
    struct Jobs {
        closed: bool,
        live: Vec<Weak<Job>>,
    }

    fn jobs() -> &'static Mutex<Jobs> {
        static JOBS: OnceLock<Mutex<Jobs>> = OnceLock::new();
        JOBS.get_or_init(Mutex::default)
    }

    pub(super) fn shutdown() {
        let mut jobs = jobs().lock().unwrap_or_else(|e| e.into_inner());
        jobs.closed = true;
        for job in jobs.live.drain(..).filter_map(|job| job.upgrade()) {
            if let Err(error) = job.terminate(1) {
                log::warn!(target: "agentero::agent", "ACP job shutdown failed: {error}");
            }
        }
    }

    /// The Job handle is private and non-inheritable. Descendants inherit Job
    /// membership, not the handle, so a host crash closes its last handle.
    struct Process {
        job: Arc<Job>,
        child: windows_spawn::Child,
    }

    impl Drop for Process {
        fn drop(&mut self) {
            // Explicit termination also works if shutdown briefly upgraded the
            // registry's Weak pointer, keeping the last handle open.
            let _ = self.job.terminate(1);
        }
    }

    pub(crate) struct AcpAgent {
        server: McpServer,
        debug: Option<DebugCallback>,
    }

    impl AcpAgent {
        pub(crate) fn new(server: McpServer) -> Self {
            Self {
                server,
                debug: None,
            }
        }

        pub(crate) fn with_debug<F>(mut self, callback: F) -> Self
        where
            F: Fn(&str, LineDirection) + Send + Sync + 'static,
        {
            self.debug = Some(Arc::new(callback));
            self
        }

        fn spawn(&self) -> io::Result<Process> {
            let McpServer::Stdio(stdio) = &self.server else {
                return Err(io::Error::other("ACP requires stdio transport"));
            };
            let is_batch = stdio.command.extension().is_some_and(|ext| {
                ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat")
            });
            let mut command = if is_batch {
                let mut command =
                    Command::new(std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into()));
                let mut script =
                    super::super::client::windows_shell_quote(&stdio.command.to_string_lossy());
                for arg in &stdio.args {
                    script.push(' ');
                    script.push_str(&super::super::client::windows_shell_quote(arg));
                }
                command
                    .args(["/D", "/S", "/C"])
                    .raw_arg(format!("\"{script}\""));
                command
            } else {
                let mut command = Command::new(&stdio.command);
                command.args(&stdio.args);
                command
            };
            for env in &stdio.env {
                command.env(&env.name, &env.value);
            }
            command
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            // Serialize spawn with shutdown, so Exit cannot miss a new Job.
            let mut jobs = jobs().lock().unwrap_or_else(|e| e.into_inner());
            if jobs.closed {
                return Err(io::Error::other("ACP host is shutting down"));
            }
            let job = Arc::new(Job::create()?);
            job.set_kill_on_close(true)?;
            // windows-spawn uses PROC_THREAD_ATTRIBUTE_JOB_LIST: membership is
            // atomic with CreateProcessW, with no spawn/assignment crash gap.
            let child = command.spawn_with(
                SpawnOptions::new()
                    .job(&job)
                    .creation_flags(CreationFlags::NO_WINDOW),
            )?;
            jobs.live.retain(|job| job.strong_count() != 0);
            jobs.live.push(Arc::downgrade(&job));
            Ok(Process { job, child })
        }
    }

    impl ConnectTo<agent_client_protocol::Client> for AcpAgent {
        async fn connect_to(
            self,
            client: impl ConnectTo<agent_client_protocol::Agent>,
        ) -> Result<(), agent_client_protocol::Error> {
            use agent_client_protocol::util::internal_error;
            let mut process = self.spawn().map_err(internal_error)?;
            // Duplicate only the parent pipe endpoints; the originals close here.
            let stdin = process.child.stdin.take().unwrap();
            let stdout = process.child.stdout.take().unwrap();
            let stderr = process.child.stderr.take().unwrap();
            let writer = tokio::process::ChildStdin::from_std(std::process::ChildStdin::from(
                stdin
                    .as_handle()
                    .try_clone_to_owned()
                    .map_err(internal_error)?,
            ))
            .map_err(internal_error)?;
            let reader = tokio::process::ChildStdout::from_std(std::process::ChildStdout::from(
                stdout
                    .as_handle()
                    .try_clone_to_owned()
                    .map_err(internal_error)?,
            ))
            .map_err(internal_error)?;
            let mut stderr_reader =
                tokio::process::ChildStderr::from_std(std::process::ChildStderr::from(
                    stderr
                        .as_handle()
                        .try_clone_to_owned()
                        .map_err(internal_error)?,
                ))
                .map_err(internal_error)?;
            drop((stdin, stdout, stderr));

            let debug = self.debug.clone();
            let outgoing = futures_util::sink::unfold(writer, move |mut writer, line: String| {
                let debug = debug.clone();
                async move {
                    if let Some(debug) = debug {
                        debug(&line, LineDirection::Stdin);
                    }
                    writer.write_all(line.as_bytes()).await?;
                    writer.write_all(b"\n").await?;
                    writer.flush().await?;
                    Ok::<_, io::Error>(writer)
                }
            });
            let debug = self.debug.clone();
            let incoming =
                futures_util::stream::unfold(BufReader::new(reader).lines(), |mut lines| async {
                    match lines.next_line().await {
                        Ok(Some(line)) => Some((Ok(line), lines)),
                        Ok(None) => None,
                        Err(error) => Some((Err(error), lines)),
                    }
                })
                .inspect(move |line| {
                    if let (Some(debug), Ok(line)) = (&debug, line) {
                        debug(line, LineDirection::Stdout);
                    }
                });
            let protocol = ConnectTo::<agent_client_protocol::Client>::connect_to(
                agent_client_protocol::Lines::new(Box::pin(outgoing), Box::pin(incoming)),
                client,
            );
            // Drain stderr within this connection, never in a detached task.
            // A byte-bounded tail avoids unbounded lines from a faulty adapter.
            let tail = Arc::new(Mutex::new(VecDeque::new()));
            let stderr_tail = tail.clone();
            let stderr = async {
                let mut buffer = [0; 8192];
                loop {
                    let read = stderr_reader.read(&mut buffer).await?;
                    if read == 0 {
                        return Ok::<_, io::Error>(());
                    }
                    let mut tail = stderr_tail.lock().unwrap_or_else(|e| e.into_inner());
                    tail.extend(&buffer[..read]);
                    while tail.len() > 65536 {
                        tail.pop_front();
                    }
                    if let Some(debug) = &self.debug {
                        debug(
                            &String::from_utf8_lossy(&buffer[..read]),
                            LineDirection::Stderr,
                        );
                    }
                }
            };
            tokio::pin!(protocol, stderr);
            let report = |status: std::process::ExitStatus| {
                if status.success() {
                    return Ok(());
                }
                let bytes: Vec<u8> = tail
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .iter()
                    .copied()
                    .collect();
                Err(internal_error(format!(
                    "ACP process exited with {status}: {}",
                    String::from_utf8_lossy(&bytes)
                )))
            };
            let main = async {
                tokio::select! {
                    result = &mut protocol => {
                        result?;
                        // Preserve delayed adapter failures after a clean ACP
                        // close, but never wait indefinitely for a launcher.
                        match tokio::time::timeout(GRACE, wait_for_exit(&mut process.child)).await {
                            Ok(status) => report(status.map_err(internal_error)?),
                            Err(_) => Ok(()),
                        }
                    }
                    status = wait_for_exit(&mut process.child) => {
                        process.job.terminate(1).map_err(internal_error)?;
                        report(status.map_err(internal_error)?)?;
                        tokio::time::timeout(GRACE, &mut protocol).await.unwrap_or(Ok(()))
                    }
                }
            };
            let result = {
                tokio::pin!(main);
                tokio::select! {
                    result = &mut main => result,
                    _ = &mut stderr => main.await,
                }
            };
            // No protocol drain can keep the process alive indefinitely.
            // Drop kills the entire tree on success, error or task cancellation.
            drop(process);
            result
        }
    }

    async fn wait_for_exit(
        child: &mut windows_spawn::Child,
    ) -> io::Result<std::process::ExitStatus> {
        loop {
            if let Some(status) = child.try_wait()? {
                return Ok(status);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use agent_client_protocol::schema::v1::{EnvVariable, McpServerStdio};
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use std::path::Path;
        use std::time::Instant;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
        };

        fn fixture(dir: &Path) -> AcpAgent {
            let script = "$p = Start-Process $env:COMSPEC -WindowStyle Hidden -ArgumentList '/D /C ping -n 60 127.0.0.1 >NUL' -PassThru; [IO.File]::WriteAllText($env:AGENTERO_ACP_TEST_PID, [string]$p.Id); Start-Sleep -Seconds 60";
            AcpAgent::new(McpServer::Stdio(
                McpServerStdio::new("fixture", "powershell.exe")
                    .args(vec![
                        "-NoProfile".into(),
                        "-NonInteractive".into(),
                        "-Command".into(),
                        script.into(),
                    ])
                    .env(vec![EnvVariable::new(
                        "AGENTERO_ACP_TEST_PID",
                        dir.join("descendant").to_string_lossy(),
                    )]),
            ))
        }

        fn wait_pid(path: &Path) -> u32 {
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                if let Ok(pid) = std::fs::read_to_string(path).unwrap_or_default().parse() {
                    return pid;
                }
                assert!(
                    Instant::now() < deadline,
                    "fixture did not publish {}",
                    path.display()
                );
                std::thread::sleep(Duration::from_millis(20));
            }
        }

        fn process_handle(pid: u32) -> OwnedHandle {
            // Hold the original process object so PID reuse cannot fool assertions.
            let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
            assert!(!handle.is_null(), "process {pid} was not alive");
            unsafe { OwnedHandle::from_raw_handle(handle) }
        }

        fn assert_exited(handle: &OwnedHandle) {
            assert_eq!(
                unsafe { WaitForSingleObject(handle.as_raw_handle(), 5000) },
                0,
                "owned ACP process survived teardown"
            );
        }

        #[test]
        fn dropping_connection_kills_descendants() {
            let dir = tempfile::tempdir().unwrap();
            let process = fixture(dir.path()).spawn().unwrap();
            let root = process_handle(process.child.id());
            let descendant = process_handle(wait_pid(&dir.path().join("descendant")));
            drop(process);
            assert_exited(&root);
            assert_exited(&descendant);
        }

        #[tokio::test]
        async fn cancelling_transport_kills_descendants() {
            let dir = tempfile::tempdir().unwrap();
            let agent = fixture(dir.path());
            let (client, _peer) = agent_client_protocol::Channel::duplex();
            let task = tokio::spawn(ConnectTo::<agent_client_protocol::Client>::connect_to(
                agent, client,
            ));
            let path = dir.path().join("descendant");
            let pid = tokio::task::spawn_blocking(move || wait_pid(&path))
                .await
                .unwrap();
            let descendant = process_handle(pid);
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
            assert_exited(&descendant);
        }

        #[tokio::test]
        async fn stdio_initialize_and_clean_close_reap_nonexiting_agent() {
            use agent_client_protocol::schema::{v1::InitializeRequest, ProtocolVersion};
            let dir = tempfile::tempdir().unwrap();
            let pid_file = dir.path().join("root");
            let script = "[IO.File]::WriteAllText($env:AGENTERO_ACP_TEST_PID, [string]$PID); while ($line = [Console]::ReadLine()) { $r = ConvertFrom-Json $line; if ($r.method -eq 'initialize') { @{jsonrpc='2.0'; id=$r.id; result=@{protocolVersion=1;agentCapabilities=@{};agentInfo=@{name='fixture';version='1'}}} | ConvertTo-Json -Depth 5 -Compress | ForEach-Object { [Console]::WriteLine($_) } } }; Start-Sleep -Seconds 60";
            let agent = AcpAgent::new(McpServer::Stdio(
                McpServerStdio::new("fixture", "powershell.exe")
                    .args(vec![
                        "-NoProfile".into(),
                        "-NonInteractive".into(),
                        "-Command".into(),
                        script.into(),
                    ])
                    .env(vec![EnvVariable::new(
                        "AGENTERO_ACP_TEST_PID",
                        pid_file.to_string_lossy(),
                    )]),
            ));
            let captured = Arc::new(Mutex::new(None));
            let process = captured.clone();
            let future = agent_client_protocol::Client.builder().connect_with(
                agent,
                move |connection: agent_client_protocol::ConnectionTo<
                    agent_client_protocol::Agent,
                >| async move {
                    let response = connection
                        .send_request(InitializeRequest::new(ProtocolVersion::V1))
                        .block_task()
                        .await?;
                    assert_eq!(response.agent_info.unwrap().name, "fixture");
                    *process.lock().unwrap() = Some(process_handle(wait_pid(&pid_file)));
                    Ok(())
                },
            );
            tokio::time::timeout(Duration::from_secs(10), future)
                .await
                .unwrap()
                .unwrap();
            assert_exited(captured.lock().unwrap().as_ref().unwrap());
        }

        #[test]
        fn batch_shim_in_path_with_spaces_keeps_arguments() {
            let dir = tempfile::tempdir().unwrap();
            let batch = dir.path().join("agent shim.cmd");
            std::fs::write(
                &batch,
                "@echo off\r\nif not \"%~1\"==\"hello world\" exit /b 1\r\nexit /b 0\r\n",
            )
            .unwrap();
            let agent = AcpAgent::new(McpServer::Stdio(
                McpServerStdio::new("fixture", batch).args(vec!["hello world".into()]),
            ));
            let mut process = agent.spawn().unwrap();
            assert!(process.child.wait().unwrap().success());
        }

        // Isolated host: shutdown is irreversible and must not poison other tests.
        #[test]
        #[ignore]
        fn exit_host_fixture() {
            let Some(dir) = std::env::var_os("AGENTERO_ACP_TEST_DIR") else {
                return;
            };
            let dir = Path::new(&dir);
            let agent = fixture(dir);
            let process = agent.spawn().unwrap();
            wait_pid(&dir.join("descendant"));
            std::fs::write(dir.join("root"), process.child.id().to_string()).unwrap();
            // Mimic an ACP guard retained by Tauri's static runtime.
            std::mem::forget(process);
            if std::env::var_os("AGENTERO_ACP_TEST_SHUTDOWN").is_some() {
                wait_pid(&dir.join("ready"));
                shutdown();
                shutdown();
                assert!(agent.spawn().is_err());
            } else {
                std::thread::sleep(Duration::from_secs(60));
            }
        }

        fn check_host_exit(shutdown: bool) {
            let dir = tempfile::tempdir().unwrap();
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .args(["exit_host_fixture", "--ignored", "--nocapture"])
                .env("AGENTERO_ACP_TEST_DIR", dir.path());
            if shutdown {
                command.env("AGENTERO_ACP_TEST_SHUTDOWN", "1");
            }
            let mut host = command.spawn().unwrap();
            let root = process_handle(wait_pid(&dir.path().join("root")));
            let descendant = process_handle(wait_pid(&dir.path().join("descendant")));
            if shutdown {
                std::fs::write(dir.path().join("ready"), "1").unwrap();
                assert!(host.wait().unwrap().success());
            } else {
                host.kill().unwrap();
                host.wait().unwrap();
            }
            assert_exited(&root);
            assert_exited(&descendant);
        }

        #[test]
        fn host_shutdown_reaps_static_runtime_connections() {
            check_host_exit(true);
        }

        #[test]
        fn forced_host_exit_kills_entire_tree() {
            check_host_exit(false);
        }
    }
}
