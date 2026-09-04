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
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::AsyncReadExt;
use tokio::process::Child;
use tokio::sync::{watch, Mutex};
use uuid::Uuid;

/// Default byte limit for captured terminal output when the agent does not specify one.
const DEFAULT_OUTPUT_BYTE_LIMIT: u64 = 1024 * 1024; // 1 MiB

/// Shared manager for all terminals created on one ACP connection.
pub struct AcpTerminalManager {
    terminals: HashMap<String, AcpTerminal>,
}

struct AcpTerminal {
    child: Arc<Mutex<Child>>,
    state: Arc<Mutex<AcpTerminalState>>,
    exit_tx: watch::Sender<Option<TerminalExitStatus>>,
    readers: Vec<tokio::task::JoinHandle<()>>,
}

struct AcpTerminalState {
    output_bytes: Vec<u8>,
    truncated: bool,
    exit_status: Option<TerminalExitStatus>,
}

impl AcpTerminalManager {
    /// Create an empty manager.
    pub fn new() -> Self {
        Self {
            terminals: HashMap::new(),
        }
    }

    /// Spawn a command and return its terminal id.
    pub(crate) async fn create(
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
        let command = resolve_command(&request.command)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| request.command.clone());

        let mut cmd = tokio::process::Command::new(&command);
        cmd.args(&request.args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        if let Some(cwd) = &request.cwd {
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
            exit_status: None,
        }));
        let child_arc = Arc::new(Mutex::new(child));
        let (exit_tx, _) = watch::channel(None);

        let stdout_handle = spawn_reader(stdout, state.clone(), output_byte_limit);
        let stderr_handle = spawn_reader(stderr, state.clone(), output_byte_limit);
        spawn_waiter(child_arc.clone(), state.clone(), exit_tx.clone());

        self.terminals.insert(
            terminal_id.clone(),
            AcpTerminal {
                child: child_arc,
                state,
                exit_tx,
                readers: vec![stdout_handle, stderr_handle],
            },
        );

        Ok(CreateTerminalResponse::new(TerminalId::new(terminal_id)))
    }

    /// Return current output, truncation flag, and exit status if known.
    pub(crate) async fn output(
        &mut self,
        request: &TerminalOutputRequest,
    ) -> Result<TerminalOutputResponse, String> {
        let terminal = self
            .terminals
            .get_mut(request.terminal_id.0.as_ref())
            .ok_or_else(|| "terminal not found".to_string())?;
        drain_readers(terminal).await;
        let state = terminal.state.lock().await;
        let output = String::from_utf8_lossy(&state.output_bytes).to_string();
        Ok(TerminalOutputResponse::new(output, state.truncated)
            .exit_status(state.exit_status.clone()))
    }

    /// Wait for the command to exit and return its exit status.
    pub(crate) async fn wait_for_exit(
        &mut self,
        request: &WaitForTerminalExitRequest,
    ) -> Result<WaitForTerminalExitResponse, String> {
        let terminal = self
            .terminals
            .get_mut(request.terminal_id.0.as_ref())
            .ok_or_else(|| "terminal not found".to_string())?;

        // Fast path: already exited.
        if let Some(status) = terminal.state.lock().await.exit_status.clone() {
            return Ok(WaitForTerminalExitResponse::new(status));
        }

        let mut rx = terminal.exit_tx.subscribe();
        rx.changed()
            .await
            .map_err(|_| "terminal exit watcher dropped".to_string())?;
        drain_readers(terminal).await;
        let status = rx
            .borrow()
            .clone()
            .ok_or_else(|| "terminal exited but status unavailable".to_string())?;
        Ok(WaitForTerminalExitResponse::new(status))
    }

    /// Kill a running terminal command without releasing its resources.
    pub(crate) async fn kill(
        &self,
        request: &KillTerminalRequest,
    ) -> Result<KillTerminalResponse, String> {
        let terminal = self
            .terminals
            .get(request.terminal_id.0.as_ref())
            .ok_or_else(|| "terminal not found".to_string())?;
        let mut child = terminal.child.lock().await;
        let _ = child.kill().await;
        Ok(KillTerminalResponse::new())
    }

    /// Release a terminal, killing it if still running and removing it from the manager.
    pub(crate) async fn release(
        &mut self,
        request: ReleaseTerminalRequest,
    ) -> Result<ReleaseTerminalResponse, String> {
        let terminal_id = request.terminal_id.0.as_ref();
        if let Some(terminal) = self.terminals.get(terminal_id) {
            let mut child = terminal.child.lock().await;
            let _ = child.kill().await;
        }
        self.terminals.remove(terminal_id);
        Ok(ReleaseTerminalResponse::new())
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

/// Wait for all output reader tasks to finish so captured output is complete.
async fn drain_readers(terminal: &mut AcpTerminal) {
    let handles = std::mem::take(&mut terminal.readers);
    for handle in handles {
        let _ = handle.await;
    }
}

fn spawn_waiter(
    child: Arc<Mutex<Child>>,
    state: Arc<Mutex<AcpTerminalState>>,
    exit_tx: watch::Sender<Option<TerminalExitStatus>>,
) {
    tokio::spawn(async move {
        let status = {
            let mut child = child.lock().await;
            match child.wait().await {
                Ok(status) => TerminalExitStatus::new().exit_code(status.code().map(|c| c as u32)),
                Err(_) => TerminalExitStatus::new(),
            }
        };
        {
            let mut locked = state.lock().await;
            locked.exit_status = Some(status.clone());
        }
        let _ = exit_tx.send(Some(status));
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
                    let response = terminals.lock().await.create(request).await;
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
                    let response = terminals.lock().await.output(&request).await;
                    match response {
                        Ok(resp) => responder.respond(resp),
                        Err(e) => responder.respond_with_internal_error(e),
                    }
                }
            })
            .await
            .if_request({
                let terminals = terminals.clone();
                async move |request: WaitForTerminalExitRequest, responder| {
                    let response = terminals.lock().await.wait_for_exit(&request).await;
                    match response {
                        Ok(resp) => responder.respond(resp),
                        Err(e) => responder.respond_with_internal_error(e),
                    }
                }
            })
            .await
            .if_request({
                let terminals = terminals.clone();
                async move |request: KillTerminalRequest, responder| {
                    let response = terminals.lock().await.kill(&request).await;
                    match response {
                        Ok(resp) => responder.respond(resp),
                        Err(e) => responder.respond_with_internal_error(e),
                    }
                }
            })
            .await
            .if_request({
                let terminals = terminals.clone();
                async move |request: ReleaseTerminalRequest, responder| {
                    let response = terminals.lock().await.release(request).await;
                    match response {
                        Ok(resp) => responder.respond(resp),
                        Err(e) => responder.respond_with_internal_error(e),
                    }
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
        let manager = Arc::new(Mutex::new(AcpTerminalManager::new()));
        let request =
            CreateTerminalRequest::new("session-1", if cfg!(windows) { "cmd" } else { "echo" })
                .args(if cfg!(windows) {
                    vec!["/C".to_string(), "echo hello".to_string()]
                } else {
                    vec!["hello".to_string()]
                })
                .output_byte_limit(1024u64);

        let response = manager.lock().await.create(request).await.unwrap();
        let terminal_id = response.terminal_id.to_string();

        // Wait for exit so output is finalized.
        let wait_req =
            WaitForTerminalExitRequest::new("session-1", TerminalId::new(terminal_id.clone()));
        let _ = manager.lock().await.wait_for_exit(&wait_req).await.unwrap();

        let output_req =
            TerminalOutputRequest::new("session-1", TerminalId::new(terminal_id.clone()));
        let output = manager.lock().await.output(&output_req).await.unwrap();
        assert!(output.output.contains("hello"));
        assert!(output.exit_status.is_some());

        let release_req = ReleaseTerminalRequest::new("session-1", TerminalId::new(terminal_id));
        manager.lock().await.release(release_req).await.unwrap();
    }

    #[tokio::test]
    async fn output_byte_limit_truncates() {
        let manager = Arc::new(Mutex::new(AcpTerminalManager::new()));
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

        let response = manager.lock().await.create(request).await.unwrap();
        let terminal_id = response.terminal_id.to_string();

        let wait_req =
            WaitForTerminalExitRequest::new("session-2", TerminalId::new(terminal_id.clone()));
        let _ = manager.lock().await.wait_for_exit(&wait_req).await.unwrap();

        let output_req =
            TerminalOutputRequest::new("session-2", TerminalId::new(terminal_id.clone()));
        let output = manager.lock().await.output(&output_req).await.unwrap();
        assert!(output.truncated);
        assert!(output.output.contains("MARKER"));
        assert!(output.output.len() <= 105);
    }
}
