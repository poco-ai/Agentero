use crate::core::error::AppError;
use crate::features::agent::models::{AgentDescriptor, AgentResultPayload, AgentTemplate};
use crate::features::agent::prompt::envelope::extract_sources;
use crate::features::agent::registry::discovery::{path_entries, resolve_command};
use agent_client_protocol::schema::v1::{
    ClientCapabilities, ElicitationCapabilities, ElicitationFormCapabilities, EnvVariable,
    InitializeRequest, McpServer, McpServerStdio,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{util, AcpAgent};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

/// Advertise form elicitation so codex-acp bridges `request_user_input` to the client,
/// and terminal execution so agents like Kimi Code can run shell commands.
pub(crate) fn client_initialize_request() -> InitializeRequest {
    InitializeRequest::new(ProtocolVersion::V1).client_capabilities(
        ClientCapabilities::new()
            .elicitation(ElicitationCapabilities::new().form(ElicitationFormCapabilities::new()))
            .terminal(true),
    )
}

/// Quote a string for a POSIX `sh -c` command so spaces/special characters are
/// preserved. Wraps in single quotes and escapes embedded single quotes.
#[cfg(not(windows))]
pub(crate) fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}

/// Wrap a local agent command in a shell that changes to `cwd` before exec'ing
/// the real agent. The ACP stdio transport has no `cwd` field, so this ensures
/// agents like the Pi adapter start with the vault as their OS-level working
/// directory.
#[cfg(not(windows))]
pub(crate) fn wrap_local_command_with_cwd(
    command: &Path,
    args: &[String],
    _env: &mut HashMap<String, String>,
    cwd: &Path,
) -> (PathBuf, Vec<String>) {
    let mut script = format!(
        "cd {} && exec {}",
        shell_quote(&cwd.to_string_lossy()),
        shell_quote(&command.to_string_lossy())
    );
    for arg in args {
        script.push(' ');
        script.push_str(&shell_quote(arg));
    }
    (PathBuf::from("/bin/sh"), vec!["-c".to_string(), script])
}

/// Quote a token for a Windows `cmd /C` command. Empty strings, spaces, and
/// most cmd metacharacters trigger double-quote wrapping; internal double
/// quotes are backslash-escaped.
#[cfg(windows)]
pub(crate) fn windows_shell_quote(s: &str) -> String {
    if s.is_empty()
        || s.contains(' ')
        || s.contains('"')
        || s.contains('&')
        || s.contains('|')
        || s.contains('<')
        || s.contains('>')
        || s.contains('^')
        || s.contains('%')
    {
        format!("\"{}\"", s.replace('"', "\\\""))
    } else {
        s.to_string()
    }
}

/// Convert Rust's canonicalized local drive path into a form accepted by `cmd.exe`.
/// True UNC paths stay unchanged; supporting them requires a separate `pushd` flow.
#[cfg(any(windows, test))]
pub(crate) fn windows_cmd_cwd(cwd: &Path) -> String {
    let cwd = cwd.to_string_lossy();
    cwd.strip_prefix(r"\\?\")
        .filter(|path| path.as_bytes().get(1) == Some(&b':'))
        .unwrap_or(cwd.as_ref())
        .to_string()
}

/// Pre-quote the cwd environment value so metacharacters remain literal after
/// `cmd.exe` expands `%AGENTERO_AGENT_CWD%`, even when the path has no spaces.
#[cfg(any(windows, test))]
pub(crate) fn windows_cmd_cwd_env_value(cwd: &Path) -> String {
    format!("\"{}\"", windows_cmd_cwd(cwd))
}

/// Windows variant of [`wrap_local_command_with_cwd`]. Uses `cmd /D /C` and an
/// environment variable for the cwd so spaces in the vault path do not need to
/// be quoted inside the command string.
#[cfg(windows)]
pub(crate) fn wrap_local_command_with_cwd(
    command: &Path,
    args: &[String],
    env: &mut HashMap<String, String>,
    cwd: &Path,
) -> (PathBuf, Vec<String>) {
    env.insert(
        "AGENTERO_AGENT_CWD".to_string(),
        windows_cmd_cwd_env_value(cwd),
    );
    let mut agent_command = windows_shell_quote(&command.to_string_lossy());
    for arg in args {
        agent_command.push(' ');
        agent_command.push_str(&windows_shell_quote(arg));
    }
    env.insert("AGENTERO_AGENT_COMMAND".to_string(), agent_command);
    (
        PathBuf::from("cmd"),
        vec![
            "/D".to_string(),
            "/C".to_string(),
            "cd /d %AGENTERO_AGENT_CWD% && %AGENTERO_AGENT_COMMAND%".to_string(),
        ],
    )
}

pub(crate) fn to_acp_agent_local(
    desc: &AgentDescriptor,
    cwd: Option<&Path>,
) -> Result<AcpAgent, AppError> {
    let command = resolve_command(&desc.command).unwrap_or_else(|| PathBuf::from(&desc.command));
    let mut child_env: HashMap<String, String> = desc.env.clone();
    if !child_env.contains_key("PATH") {
        if let Ok(path) = std::env::join_paths(path_entries()) {
            child_env.insert("PATH".to_string(), path.to_string_lossy().to_string());
        }
    }
    // Gemini CLI launches a browser OAuth flow from `new_session` when it has no
    // cached credentials; our 15s ACP timeout kills the child before login can
    // finish, so the browser would pop up on every spawn. Sign-in must happen in
    // a terminal instead (BYOA).
    if matches!(desc.template, AgentTemplate::Gemini) && !child_env.contains_key("NO_BROWSER") {
        child_env.insert("NO_BROWSER".to_string(), "true".to_string());
    }

    let (command, args) =
        if let Some(cwd) = cwd.filter(|_| desc.template.needs_local_cwd_shell_wrap()) {
            wrap_local_command_with_cwd(&command, &desc.args, &mut child_env, cwd)
        } else {
            (command, desc.args.clone())
        };

    let env: Vec<EnvVariable> = child_env
        .into_iter()
        .map(|(k, v)| EnvVariable::new(k.clone(), v.clone()))
        .collect();

    let stdio = McpServerStdio::new(desc.name.clone(), command)
        .args(args)
        .env(env);
    Ok(AcpAgent::new(McpServer::Stdio(stdio)))
}

/// Build ACP agent process. When `remote` is SSH, wrap launch as `ssh … 'cd vault && exec agent'`.
/// Local-sim remotes use a normal local process with cwd = remote vault path.
pub(crate) fn to_acp_agent(
    desc: &AgentDescriptor,
    cwd: Option<&Path>,
    remote: Option<&dyn crate::features::agent::remote_host::RemoteAgentLaunch>,
) -> Result<AcpAgent, AppError> {
    if let Some(r) = remote {
        if r.is_ssh() {
            let (program, args) = r.ssh_stdio(&desc.command, &desc.args, &desc.env)?;
            let stdio = McpServerStdio::new(desc.name.clone(), program).args(args);
            return Ok(AcpAgent::new(McpServer::Stdio(stdio)));
        }
        // local-sim: local binary, cwd set via NewSessionRequest to remote_cwd
    }
    to_acp_agent_local(desc, cwd)
}

pub(crate) async fn wait_for_cancellation(cancellation: &mut watch::Receiver<bool>) {
    if *cancellation.borrow() {
        return;
    }
    let _ = cancellation.changed().await;
}

/// Shared budget for ACP session RPCs.
pub(crate) const ACP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Initialize gets a longer budget: BYOA agents bootstrap heavy runtimes
/// (python venvs, plugin and MCP discovery) before answering, and cold
/// starts routinely exceed a 15s window — two cold spawns racing after an
/// app start made Hermes miss it repeatedly. A hard 15s turns slow-but-
/// working agents into hard "agent unavailable" failures.
pub(crate) const ACP_INITIALIZE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

pub(crate) async fn timed_acp_request<T, E>(
    label: &str,
    request: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, agent_client_protocol::Error>
where
    E: std::fmt::Display,
{
    timed_acp_request_with(ACP_TIMEOUT, label, request).await
}

/// `initialize` variant of [`timed_acp_request`]; see [`ACP_INITIALIZE_TIMEOUT`].
pub(crate) async fn timed_acp_initialize<T, E>(
    request: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, agent_client_protocol::Error>
where
    E: std::fmt::Display,
{
    timed_acp_request_with(ACP_INITIALIZE_TIMEOUT, "initialize", request).await
}

async fn timed_acp_request_with<T, E>(
    budget: std::time::Duration,
    label: &str,
    request: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, agent_client_protocol::Error>
where
    E: std::fmt::Display,
{
    tokio::time::timeout(budget, request)
        .await
        .map_err(|_| acp_err(format!("{label} timed out after {}s", budget.as_secs())))?
        .map_err(|error| acp_err(format!("{label}: {error}")))
}

/// The vault path can arrive as Rust's canonicalized extended-length form
/// (`\\?\D:\…`). Agents forward it to MSYS2-based shells (Git Bash), which
/// cannot `cd` into `\\?\` paths and mis-initialize their POSIX cwd when
/// spawned under one (mktemp/cd fail with ENOENT), so hand agents the plain
/// drive path. Extended UNC paths stay unchanged until their shell semantics
/// are handled separately.
pub(crate) fn simplified_agent_cwd(cwd: &Path) -> PathBuf {
    let cwd = cwd.to_string_lossy();
    match cwd.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => cwd.as_ref().into(),
    }
}

pub(crate) fn cancelled_payload(
    session_id: String,
    message_id: String,
    provider_session_id: Option<String>,
    content: &Arc<Mutex<String>>,
    thought: &Arc<Mutex<String>>,
) -> AgentResultPayload {
    let content = content
        .lock()
        .map(|buffer| buffer.clone())
        .unwrap_or_default();
    let reasoning = thought
        .lock()
        .map(|buffer| buffer.clone())
        .unwrap_or_default();
    AgentResultPayload {
        session_id,
        message_id,
        sources: extract_sources(&content),
        content,
        reasoning: (!reasoning.is_empty()).then_some(reasoning),
        stop_reason: Some("cancelled".to_string()),
        provider_session_id,
    }
}

pub(crate) fn acp_err(msg: impl ToString) -> agent_client_protocol::Error {
    util::internal_error(msg)
}

#[cfg(test)]
mod timeout_tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn initialize_has_an_independent_budget() {
        let slow_request = || async {
            tokio::time::sleep(std::time::Duration::from_secs(20)).await;
            Ok::<_, &str>(())
        };
        let (initialize, session) = tokio::join!(
            timed_acp_initialize(slow_request()),
            timed_acp_request("session/list", slow_request()),
        );
        assert!(initialize.is_ok());
        assert!(session
            .unwrap_err()
            .to_string()
            .contains("session/list timed out after 15s"));
        let error = timed_acp_initialize(std::future::pending::<Result<(), &str>>())
            .await
            .unwrap_err();
        assert!(error.to_string().contains("initialize timed out after 30s"));
    }
}

#[cfg(test)]
mod cwd_shell_wrap_tests {
    use super::*;

    #[test]
    #[cfg(not(windows))]
    fn shell_quote_wraps_and_escapes_single_quotes() {
        assert_eq!(shell_quote("hello"), "'hello'");
        assert_eq!(shell_quote("it's ok"), "'it'\"'\"'s ok'");
        assert_eq!(shell_quote(""), "''");
    }

    #[test]
    #[cfg(not(windows))]
    fn wrap_unix_builds_sh_cd_exec_script() {
        let mut env = HashMap::new();
        let (cmd, args) = wrap_local_command_with_cwd(
            Path::new("/usr/bin/pi-acp"),
            &["--foo".to_string(), "bar baz".to_string()],
            &mut env,
            Path::new("/path/with spaces"),
        );
        assert_eq!(cmd, PathBuf::from("/bin/sh"));
        assert_eq!(args.len(), 2);
        assert_eq!(args[0], "-c");
        assert!(args[1]
            .starts_with("cd '/path/with spaces' && exec '/usr/bin/pi-acp' '--foo' 'bar baz'"));
        assert!(env.is_empty());
    }

    #[test]
    #[cfg(windows)]
    fn windows_shell_quote_wraps_metacharacters() {
        assert_eq!(windows_shell_quote("plain"), "plain");
        assert_eq!(windows_shell_quote("with space"), "\"with space\"");
        assert_eq!(windows_shell_quote("a\"b"), "\"a\\\"b\"");
        assert_eq!(windows_shell_quote(""), "\"\"");
    }

    #[test]
    fn windows_cmd_cwd_env_value_normalizes_and_always_quotes() {
        assert_eq!(
            windows_cmd_cwd_env_value(Path::new(r"\\?\C:\Vault)")),
            r#""C:\Vault)""#
        );
        assert_eq!(
            windows_cmd_cwd_env_value(Path::new(r"C:\Vault")),
            r#""C:\Vault""#
        );
        assert_eq!(
            windows_cmd_cwd(Path::new(r"\\?\UNC\server\share")),
            r"\\?\UNC\server\share"
        );
    }

    #[test]
    #[cfg(windows)]
    fn wrap_windows_builds_cmd_cd_script() {
        let mut env = HashMap::new();
        let (cmd, args) = wrap_local_command_with_cwd(
            Path::new(r"C:\Program Files\pi-acp.cmd"),
            &["--foo".to_string(), "bar baz".to_string()],
            &mut env,
            Path::new(r"\\?\C:\My Vault"),
        );
        assert_eq!(cmd, PathBuf::from("cmd"));
        assert_eq!(
            args,
            vec![
                "/D".to_string(),
                "/C".to_string(),
                "cd /d %AGENTERO_AGENT_CWD% && %AGENTERO_AGENT_COMMAND%".to_string(),
            ]
        );
        assert_eq!(
            env.get("AGENTERO_AGENT_CWD"),
            Some(&r#""C:\My Vault""#.to_string())
        );
        assert_eq!(
            env.get("AGENTERO_AGENT_COMMAND"),
            Some(&r#""C:\Program Files\pi-acp.cmd" --foo "bar baz""#.to_string())
        );
    }
}
