//! ACP terminal capability: headless command execution on behalf of the agent.
//!
//! Implements the `terminal/*` request family (create, output, release, wait_for_exit, kill)
//! so ACP agents like Kimi Code can execute shell commands in the local environment.

use crate::features::agent::registry::discovery::resolve_command;
use agent_client_protocol::schema::v1::{
    CreateTerminalRequest, CreateTerminalResponse, EnvVariable, KillTerminalRequest,
    KillTerminalResponse, ReleaseTerminalRequest, ReleaseTerminalResponse, TerminalExitStatus,
    TerminalId, TerminalOutputRequest, TerminalOutputResponse, WaitForTerminalExitRequest,
    WaitForTerminalExitResponse,
};
use agent_client_protocol::util::MatchDispatchFrom;
use agent_client_protocol::{Agent, ConnectionTo, Dispatch, HandleDispatchFrom, Handled};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::AsyncReadExt;
use tokio::process::Child;
use tokio::sync::{mpsc, oneshot, watch, Mutex};
use tokio::time::{timeout, Duration};
use uuid::Uuid;

/// Default byte limit for captured terminal output when the agent does not specify one.
const DEFAULT_OUTPUT_BYTE_LIMIT: u64 = 1024 * 1024; // 1 MiB
const OUTPUT_DRAIN_TIMEOUT: Duration = Duration::from_millis(250);

/// Shared manager for all terminals created on one ACP connection.
pub struct AcpTerminalManager {
    terminals: HashMap<String, Arc<AcpTerminal>>,
    default_cwd: Option<PathBuf>,
}

struct AcpTerminal {
    state: Arc<Mutex<AcpTerminalState>>,
    exit_rx: watch::Receiver<Option<TerminalExitStatus>>,
    control_tx: mpsc::Sender<TerminalControl>,
}

struct AcpTerminalState {
    output_bytes: Vec<u8>,
    truncated: bool,
}

enum TerminalControl {
    Kill(oneshot::Sender<Result<(), String>>),
}

fn terminal_exit_status(status: std::io::Result<std::process::ExitStatus>) -> TerminalExitStatus {
    match status {
        Ok(status) => TerminalExitStatus::new().exit_code(status.code().map(|code| code as u32)),
        Err(_) => TerminalExitStatus::new(),
    }
}

fn command_and_args(command: &str, args: &[String]) -> (String, Vec<String>) {
    if !args.is_empty() {
        let command = resolve_command(command)
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|| command.to_string());
        return (command, args.to_vec());
    }
    if let Some(command) = resolve_command(command) {
        return (command.to_string_lossy().to_string(), Vec::new());
    }

    #[cfg(windows)]
    {
        let shell = resolve_command("powershell.exe")
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|| "powershell.exe".to_string());
        (
            shell,
            vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-NonInteractive".to_string(),
                "-Command".to_string(),
                command.to_string(),
            ],
        )
    }
    #[cfg(not(windows))]
    {
        (
            "/bin/sh".to_string(),
            vec!["-c".to_string(), command.to_string()],
        )
    }
}

impl AcpTerminalManager {
    /// Create an empty manager.
    pub fn new() -> Self {
        Self {
            terminals: HashMap::new(),
            default_cwd: None,
        }
    }

    pub(crate) fn with_cwd(cwd: PathBuf) -> Self {
        Self {
            terminals: HashMap::new(),
            default_cwd: Some(cwd),
        }
    }

    /// Spawn a command and return its terminal id.
    pub(crate) fn create(
        &mut self,
        request: CreateTerminalRequest,
    ) -> Result<CreateTerminalResponse, String> {
        log::debug!(
            target: "agentero::agent::terminal",
            "create: command={} args={:?} cwd={:?} env_count={}",
            request.command,
            request.args,
            request.cwd,
            request.env.len()
        );
        let (command, args) = command_and_args(&request.command, &request.args);

        let mut cmd = tokio::process::Command::new(&command);
        cmd.args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        if let Some(cwd) = request.cwd.as_ref().or(self.default_cwd.as_ref()) {
            cmd.current_dir(cwd);
        }

        for EnvVariable { name, value, .. } in &request.env {
            cmd.env(name, value);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn terminal command `{command}`: {e}"))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "terminal command has no stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "terminal command has no stderr".to_string())?;

        let terminal_id = Uuid::new_v4().to_string();
        let output_byte_limit = request
            .output_byte_limit
            .unwrap_or(DEFAULT_OUTPUT_BYTE_LIMIT);

        let state = Arc::new(Mutex::new(AcpTerminalState {
            output_bytes: Vec::new(),
            truncated: false,
        }));
        let (exit_tx, exit_rx) = watch::channel(None);
        let (control_tx, control_rx) = mpsc::channel(1);

        let stdout_handle = spawn_reader(stdout, state.clone(), output_byte_limit);
        let stderr_handle = spawn_reader(stderr, state.clone(), output_byte_limit);
        spawn_controller(
            child,
            exit_tx,
            control_rx,
            vec![stdout_handle, stderr_handle],
        );

        self.terminals.insert(
            terminal_id.clone(),
            Arc::new(AcpTerminal {
                state,
                exit_rx,
                control_tx,
            }),
        );

        Ok(CreateTerminalResponse::new(TerminalId::new(terminal_id)))
    }

    /// Clone a terminal handle without holding the manager lock during I/O.
    fn get(&self, terminal_id: &TerminalId) -> Result<Arc<AcpTerminal>, String> {
        self.terminals
            .get(terminal_id.0.as_ref())
            .cloned()
            .ok_or_else(|| "terminal not found".to_string())
    }

    fn remove(&mut self, terminal_id: &TerminalId) -> Option<Arc<AcpTerminal>> {
        self.terminals.remove(terminal_id.0.as_ref())
    }
}

impl AcpTerminal {
    /// Return the output captured so far without waiting for process completion.
    async fn output(&self) -> TerminalOutputResponse {
        let state = self.state.lock().await;
        let output = String::from_utf8_lossy(&state.output_bytes).to_string();
        TerminalOutputResponse::new(output, state.truncated)
            .exit_status(self.exit_rx.borrow().clone())
    }

    /// Wait for the command to exit and return its exit status.
    async fn wait_for_exit(&self) -> Result<WaitForTerminalExitResponse, String> {
        let mut rx = self.exit_rx.clone();
        let status = rx
            .wait_for(Option::is_some)
            .await
            .map_err(|_| "terminal exit watcher dropped".to_string())?
            .clone()
            .ok_or_else(|| "terminal exited but status unavailable".to_string())?;
        Ok(WaitForTerminalExitResponse::new(status))
    }

    /// Kill a running terminal command without releasing its resources.
    async fn kill(&self) -> Result<KillTerminalResponse, String> {
        let (done_tx, done_rx) = oneshot::channel();
        if self
            .control_tx
            .send(TerminalControl::Kill(done_tx))
            .await
            .is_err()
        {
            return Ok(KillTerminalResponse::new());
        }
        match done_rx.await {
            Ok(result) => result?,
            Err(_) => return Ok(KillTerminalResponse::new()),
        }
        Ok(KillTerminalResponse::new())
    }
}

impl Default for AcpTerminalManager {
    fn default() -> Self {
        Self::new()
    }
}

fn spawn_reader<R>(
    mut stream: R,
    state: Arc<Mutex<AcpTerminalState>>,
    output_byte_limit: u64,
) -> tokio::task::JoinHandle<()>
where
    R: AsyncReadExt + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut buf = [0u8; 4096];
        loop {
            match stream.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    let mut locked = state.lock().await;
                    locked.output_bytes.extend_from_slice(&buf[..n]);
                    if locked.output_bytes.len() > output_byte_limit as usize
                        && truncate_to_limit(&mut locked.output_bytes, output_byte_limit as usize)
                    {
                        locked.truncated = true;
                    }
                }
                Err(_) => break,
            }
        }
    })
}

/// Drain final output without allowing inherited pipe handles to block exit forever.
async fn drain_readers(handles: Vec<tokio::task::JoinHandle<()>>) {
    for mut handle in handles {
        if timeout(OUTPUT_DRAIN_TIMEOUT, &mut handle).await.is_err() {
            handle.abort();
        }
    }
}

fn spawn_controller(
    mut child: Child,
    exit_tx: watch::Sender<Option<TerminalExitStatus>>,
    mut control_rx: mpsc::Receiver<TerminalControl>,
    readers: Vec<tokio::task::JoinHandle<()>>,
) {
    tokio::spawn(async move {
        let (status, kill_done) = loop {
            tokio::select! {
                status = child.wait() => break (terminal_exit_status(status), None),
                control = control_rx.recv() => {
                    match control {
                        Some(TerminalControl::Kill(done)) => match child.start_kill() {
                            Ok(()) => {
                                break (terminal_exit_status(child.wait().await), Some(done));
                            }
                            Err(error) => {
                                let _ = done.send(Err(format!(
                                    "failed to kill terminal command: {error}"
                                )));
                            }
                        },
                        None => {
                            // Always reap and publish a status, even if the kill fails.
                            let _ = child.start_kill();
                            break (terminal_exit_status(child.wait().await), None);
                        }
                    }
                }
            }
        };
        drain_readers(readers).await;
        exit_tx.send_replace(Some(status));
        if let Some(done) = kill_done {
            let _ = done.send(Ok(()));
        }
    });
}

/// Truncate `bytes` from the beginning so its length is at most `limit`,
/// always cutting at a UTF-8 character boundary. Returns `true` if bytes were removed.
fn truncate_to_limit(bytes: &mut Vec<u8>, limit: usize) -> bool {
    if bytes.len() <= limit {
        return false;
    }
    let mut start = bytes.len() - limit;
    while start < bytes.len() && std::str::from_utf8(&bytes[start..]).is_err() {
        start += 1;
    }
    bytes.drain(..start.min(bytes.len()));
    true
}

/// Handler that dispatches incoming ACP terminal requests to a manager.
pub struct AcpTerminalHandler {
    terminals: Arc<Mutex<AcpTerminalManager>>,
}

impl AcpTerminalHandler {
    /// Create a handler backed by the given manager.
    pub fn new(terminals: Arc<Mutex<AcpTerminalManager>>) -> Self {
        Self { terminals }
    }
}

impl HandleDispatchFrom<Agent> for AcpTerminalHandler {
    async fn handle_dispatch_from(
        &mut self,
        message: Dispatch,
        connection: ConnectionTo<Agent>,
    ) -> Result<Handled<Dispatch>, agent_client_protocol::Error> {
        let terminals = self.terminals.clone();
        MatchDispatchFrom::new(message, &connection)
            .if_request({
                let terminals = terminals.clone();
                async move |request: CreateTerminalRequest, responder| {
                    let response = terminals.lock().await.create(request);
                    match response {
                        Ok(resp) => responder.respond(resp),
                        Err(e) => responder.respond_with_internal_error(e),
                    }
                }
            })
            .await
            .if_request({
                let terminals = terminals.clone();
                async move |request: TerminalOutputRequest, responder| {
                    let terminal = terminals.lock().await.get(&request.terminal_id);
                    match terminal {
                        Ok(terminal) => responder.respond(terminal.output().await),
                        Err(e) => responder.respond_with_internal_error(e),
                    }
                }
            })
            .await
            .if_request({
                let terminals = terminals.clone();
                let connection = connection.clone();
                async move |request: WaitForTerminalExitRequest, responder| {
                    let terminal = terminals.lock().await.get(&request.terminal_id);
                    // Dispatch is serial: capture the handle in order, then wait off-loop.
                    connection.spawn(async move {
                        match terminal {
                            Ok(terminal) => match terminal.wait_for_exit().await {
                                Ok(resp) => responder.respond(resp),
                                Err(e) => responder.respond_with_internal_error(e),
                            },
                            Err(e) => responder.respond_with_internal_error(e),
                        }
                    })
                }
            })
            .await
            .if_request({
                let terminals = terminals.clone();
                let connection = connection.clone();
                async move |request: KillTerminalRequest, responder| {
                    let terminal = terminals.lock().await.get(&request.terminal_id);
                    connection.spawn(async move {
                        match terminal {
                            Ok(terminal) => match terminal.kill().await {
                                Ok(resp) => responder.respond(resp),
                                Err(e) => responder.respond_with_internal_error(e),
                            },
                            Err(e) => responder.respond_with_internal_error(e),
                        }
                    })
                }
            })
            .await
            .if_request({
                let terminals = terminals.clone();
                let connection = connection.clone();
                async move |request: ReleaseTerminalRequest, responder| {
                    let terminal = terminals.lock().await.remove(&request.terminal_id);
                    connection.spawn(async move {
                        if let Some(terminal) = terminal {
                            if let Err(e) = terminal.kill().await {
                                return responder.respond_with_internal_error(e);
                            }
                        }
                        responder.respond(ReleaseTerminalResponse::new())
                    })
                }
            })
            .await
            .done()
    }

    fn describe_chain(&self) -> impl std::fmt::Debug {
        "AcpTerminalHandler"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_keeps_valid_utf8() {
        let mut bytes = "hello 世界".as_bytes().to_vec();
        truncate_to_limit(&mut bytes, 8);
        let s = String::from_utf8_lossy(&bytes);
        assert!(s.contains("世界"));
        assert!(!s.contains("hello"));
        assert_eq!(std::str::from_utf8(&bytes).unwrap(), s.as_ref());
    }

    #[test]
    fn truncate_at_char_boundary() {
        // "世" = E4 B8 96; cut in the middle should advance to the char boundary.
        let mut bytes = "世界".as_bytes().to_vec();
        truncate_to_limit(&mut bytes, 4);
        assert!(std::str::from_utf8(&bytes).is_ok());
    }

    #[tokio::test]
    async fn create_output_release_lifecycle() {
        let mut manager = AcpTerminalManager::new();
        let request =
            CreateTerminalRequest::new("session-1", if cfg!(windows) { "cmd" } else { "echo" })
                .args(if cfg!(windows) {
                    vec!["/C".to_string(), "echo hello".to_string()]
                } else {
                    vec!["hello".to_string()]
                })
                .output_byte_limit(1024u64);

        let response = manager.create(request).unwrap();
        let terminal = manager.get(&response.terminal_id).unwrap();

        // Wait for exit so output is finalized.
        let _ = terminal.wait_for_exit().await.unwrap();
        let output = terminal.output().await;
        assert!(output.output.contains("hello"));
        assert!(output.exit_status.is_some());

        manager.remove(&response.terminal_id);
    }

    #[tokio::test]
    async fn shell_command_string_executes() {
        let mut manager = AcpTerminalManager::new();
        let response = manager
            .create(CreateTerminalRequest::new(
                "session-shell",
                "echo AGENTERO_SMOKE",
            ))
            .unwrap();
        let terminal = manager.get(&response.terminal_id).unwrap();

        terminal.wait_for_exit().await.unwrap();
        assert!(terminal.output().await.output.contains("AGENTERO_SMOKE"));

        manager.remove(&response.terminal_id);
    }

    #[tokio::test]
    async fn missing_request_cwd_uses_session_cwd() {
        let cwd = tempfile::tempdir().unwrap();
        let marker = cwd
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        let mut manager = AcpTerminalManager::with_cwd(cwd.path().to_path_buf());
        let request =
            CreateTerminalRequest::new("session-cwd", if cfg!(windows) { "cmd" } else { "pwd" })
                .args(if cfg!(windows) {
                    vec!["/D".to_string(), "/C".to_string(), "cd".to_string()]
                } else {
                    Vec::new()
                });
        let response = manager.create(request).unwrap();
        let terminal = manager.get(&response.terminal_id).unwrap();

        terminal.wait_for_exit().await.unwrap();
        assert!(terminal.output().await.output.contains(&marker));

        manager.remove(&response.terminal_id);
    }

    #[tokio::test]
    async fn exit_before_wait_remains_observable() {
        let mut manager = AcpTerminalManager::new();
        let response = manager
            .create(CreateTerminalRequest::new(
                "session-fast-exit",
                "echo finished",
            ))
            .unwrap();
        let terminal = manager.get(&response.terminal_id).unwrap();
        // Generous windows: process spawn latency on a loaded machine can
        // exceed sub-second budgets; the scenario only needs exit-before-wait.
        timeout(Duration::from_secs(5), async {
            while terminal.exit_rx.borrow().is_none() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("terminal must exit before testing a late wait");

        timeout(Duration::from_secs(1), terminal.wait_for_exit())
            .await
            .expect("an exit reported before wait_for_exit must not be lost")
            .expect("wait_for_exit failed");

        manager.remove(&response.terminal_id);
    }

    #[tokio::test]
    async fn running_output_returns_and_wait_can_be_killed() {
        let mut manager = AcpTerminalManager::new();
        let request = CreateTerminalRequest::new(
            "session-running",
            if cfg!(windows) { "cmd" } else { "bash" },
        )
        .args(if cfg!(windows) {
            vec![
                "/D".to_string(),
                "/C".to_string(),
                "echo ready & ping -n 6 127.0.0.1 >NUL".to_string(),
            ]
        } else {
            vec!["-c".to_string(), "echo ready; sleep 5".to_string()]
        });

        let response = manager.create(request).unwrap();
        let terminal = manager.get(&response.terminal_id).unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;

        let output = timeout(Duration::from_millis(500), terminal.output())
            .await
            .expect("terminal/output must not wait for process exit");
        assert!(output.output.contains("ready"));
        assert!(output.exit_status.is_none());

        let waiter = {
            let terminal = terminal.clone();
            tokio::spawn(async move { terminal.wait_for_exit().await })
        };
        timeout(Duration::from_secs(2), terminal.kill())
            .await
            .expect("terminal/kill must remain available during wait_for_exit")
            .expect("terminal/kill failed");
        timeout(Duration::from_secs(2), waiter)
            .await
            .expect("wait_for_exit must finish after kill")
            .expect("waiter task failed")
            .expect("wait_for_exit failed");

        manager.remove(&response.terminal_id);
    }

    #[tokio::test]
    async fn pending_wait_does_not_block_acp_requests() {
        use agent_client_protocol::Client;

        let mut manager = AcpTerminalManager::new();
        let request = CreateTerminalRequest::new(
            "session-dispatch",
            if cfg!(windows) {
                "powershell.exe"
            } else {
                "sleep"
            },
        )
        .args(if cfg!(windows) {
            vec![
                "-NoProfile".to_string(),
                "-NonInteractive".to_string(),
                "-Command".to_string(),
                "Start-Sleep -Seconds 30".to_string(),
            ]
        } else {
            vec!["30".to_string()]
        });
        let id = manager.create(request).unwrap().terminal_id;
        let terminal = manager.get(&id).unwrap();
        let host = Client
            .builder()
            .with_handler(AcpTerminalHandler::new(Arc::new(Mutex::new(manager))));
        let run =
            Agent
                .builder()
                .connect_with(host, async move |connection: ConnectionTo<Client>| {
                    let wait = connection
                        .send_request(WaitForTerminalExitRequest::new(
                            "session-dispatch",
                            id.clone(),
                        ))
                        .block_task();
                    let stop = async {
                        let output = connection
                            .send_request(TerminalOutputRequest::new(
                                "session-dispatch",
                                id.clone(),
                            ))
                            .block_task()
                            .await?;
                        assert!(output.exit_status.is_none());
                        connection
                            .send_request(KillTerminalRequest::new("session-dispatch", id.clone()))
                            .block_task()
                            .await?;
                        connection
                            .send_request(ReleaseTerminalRequest::new("session-dispatch", id))
                            .block_task()
                            .await?;
                        Ok::<_, agent_client_protocol::Error>(())
                    };
                    let (wait, stop) = tokio::join!(wait, stop);
                    wait?;
                    stop?;
                    Ok(())
                });
        let result = timeout(Duration::from_secs(5), run).await;
        // Clean up through the controller even if the protocol dispatcher stalls.
        timeout(Duration::from_secs(2), terminal.kill())
            .await
            .expect("terminal cleanup must not hang")
            .expect("terminal cleanup failed");
        result
            .expect("pending wait must not block output, kill or release on the connection")
            .expect("ACP terminal requests failed");
    }

    #[tokio::test]
    async fn output_byte_limit_truncates() {
        let mut manager = AcpTerminalManager::new();
        // Print 2000 bytes of "x" then a marker.
        let script = if cfg!(windows) {
            "cmd /C for /L %i in (1,1,2000) do @<NUL set /p=\"x\" & echo MARKER"
        } else {
            "printf '%0.sx' $(seq 1 2000); echo MARKER"
        };
        let request =
            CreateTerminalRequest::new("session-2", if cfg!(windows) { "cmd" } else { "bash" })
                .args(if cfg!(windows) {
                    vec!["/C".to_string(), script.to_string()]
                } else {
                    vec!["-c".to_string(), script.to_string()]
                })
                .output_byte_limit(100u64);

        let response = manager.create(request).unwrap();
        let terminal = manager.get(&response.terminal_id).unwrap();
        let _ = terminal.wait_for_exit().await.unwrap();
        let output = terminal.output().await;
        assert!(output.truncated);
        assert!(output.output.contains("MARKER"));
        assert!(output.output.len() <= 105);
    }

    #[tokio::test]
    async fn dropping_last_handle_kills_running_process() {
        let mut manager = AcpTerminalManager::new();
        let request =
            CreateTerminalRequest::new("session-drop", if cfg!(windows) { "cmd" } else { "bash" })
                .args(if cfg!(windows) {
                    vec![
                        "/D".to_string(),
                        "/C".to_string(),
                        "ping -n 12 127.0.0.1 >NUL".to_string(),
                    ]
                } else {
                    vec!["-c".to_string(), "exec sleep 30".to_string()]
                });

        let response = manager.create(request).unwrap();
        let mut exit_rx = manager.get(&response.terminal_id).unwrap().exit_rx.clone();
        // Session teardown drops the whole manager, closing the control channel.
        drop(manager);

        timeout(Duration::from_secs(5), exit_rx.wait_for(Option::is_some))
            .await
            .expect("dropping the last handle must kill the still-running command")
            .expect("controller dropped the exit watcher without publishing a status");
    }
}
