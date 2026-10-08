use crate::core::error::AppError;
use crate::core::process::windows_shell_path;
use crate::features::agent::acp::terminal::AcpTerminalManager;
use crate::features::agent::models::{AgentDescriptor, AgentResultPayload, AgentTemplate};

use super::process::AcpAgent;
use crate::features::agent::registry::discovery::{login_shell_env, path_entries};
use agent_client_protocol::schema::v1::{
    ClientCapabilities, ElicitationCapabilities, ElicitationFormCapabilities, EnvVariable,
    InitializeRequest, McpServer, McpServerStdio,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::util;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

/// Shared ACP client builder: name + terminal handler. Call sites attach their own
/// notification / request handlers.
macro_rules! agentero_acp_builder {
    ($terminals:expr) => {
        ::agent_client_protocol::Client
            .builder()
            .name("agentero")
            .with_handler(
                $crate::features::agent::acp::terminal::AcpTerminalHandler::new($terminals),
            )
    };
}
pub(crate) use agentero_acp_builder;

/// Terminal manager for one ACP connection (`Some(cwd)` → Vault cwd default).
pub(crate) fn acp_terminals(
    cwd: Option<std::path::PathBuf>,
) -> Arc<tokio::sync::Mutex<AcpTerminalManager>> {
    Arc::new(tokio::sync::Mutex::new(match cwd {
        Some(cwd) => AcpTerminalManager::with_cwd(cwd),
        None => AcpTerminalManager::new(),
    }))
}

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
fn wrap_local_command_with_cwd(
    command: &Path,
    args: &[String],
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
#[cfg(any(windows, test))]
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
    windows_shell_path(cwd).to_string_lossy().into_owned()
}

/// Pre-quote the cwd environment value so metacharacters remain literal after
/// `cmd.exe` expands `%AGENTERO_AGENT_CWD%`, even when the path has no spaces.
#[cfg(any(windows, test))]
pub(crate) fn windows_cmd_cwd_env_value(cwd: &Path) -> String {
    format!("\"{}\"", windows_cmd_cwd(cwd))
}

/// Windows launch policy and command construction. Kept available to unit
/// tests on Unix so changes to the wrapper policy are checked on every CI run.
#[cfg(any(windows, test))]
fn windows_launch_command(
    desc: &AgentDescriptor,
    command: PathBuf,
    env: &mut HashMap<String, String>,
    cwd: Option<&Path>,
) -> (PathBuf, Vec<String>) {
    // Keep the pre-#570 Windows policy: adding cmd around native launchers
    // changes quoting and breaks UNC cwd. Process-tree ownership is handled
    // separately by the Windows ACP transport's Job Object.
    let Some(cwd) =
        cwd.filter(|_| matches!(desc.template, AgentTemplate::Pi | AgentTemplate::Custom))
    else {
        return (command, desc.args.clone());
    };
    env.insert(
        "AGENTERO_AGENT_CWD".to_string(),
        windows_cmd_cwd_env_value(cwd),
    );
    let mut agent_command = windows_shell_quote(&command.to_string_lossy());
    for arg in &desc.args {
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

#[cfg(windows)]
use windows_launch_command as local_launch_command;

/// Summarize an ACP stdio line for debug logs without dumping the full payload.
fn summarize_acp_line(line: &str) -> String {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
        if let Some(method) = value.get("method").and_then(|m| m.as_str()) {
            return method.to_string();
        }
        if let Some(id) = value.get("id") {
            if value.get("error").is_some() {
                return format!("error(id={id})");
            }
            return format!("response(id={id})");
        }
    }
    if line.len() > 120 {
        format!("{}...", &line[..120])
    } else {
        line.to_string()
    }
}

fn acp_agent_with_debug(agent: AcpAgent, name: &str) -> AcpAgent {
    let name = name.to_string();
    agent.with_debug(
        move |line: &str, direction: agent_client_protocol::LineDirection| {
            let summary = summarize_acp_line(line);
            log::debug!(
                target: "agentero::acp::stdio",
                "{name} {direction:?}: {summary}",
            );
            log::trace!(
                target: "agentero::acp::stdio",
                "{name} {direction:?}: {line}",
            );
        },
    )
}

fn append_path_entries(entries: &mut Vec<PathBuf>, value: Option<&String>) {
    let Some(value) = value else {
        return;
    };
    for entry in std::env::split_paths(value) {
        if !entry.as_os_str().is_empty() && !entries.iter().any(|existing| existing == &entry) {
            entries.push(entry);
        }
    }
}

/// Build the environment for an ACP child process.
///
/// Non-PATH priority (low → high): process, missing login-shell values, descriptor.
/// PATH is merged in executable-resolution order: descriptor, process, login shell,
/// then common GUI-missing locations.
pub(crate) fn build_child_env(
    process_env: impl Iterator<Item = (String, String)>,
    shell_env: Option<&HashMap<String, String>>,
    desc_env: &HashMap<String, String>,
) -> HashMap<String, String> {
    let process_env: HashMap<String, String> = process_env.collect();
    let mut child_env = process_env.clone();
    if let Some(shell_env) = shell_env {
        for (key, value) in shell_env {
            child_env.entry(key.clone()).or_insert(value.clone());
        }
    }
    for (key, value) in desc_env {
        child_env.insert(key.clone(), value.clone());
    }

    let mut merged_path = Vec::new();
    append_path_entries(&mut merged_path, desc_env.get("PATH"));
    append_path_entries(&mut merged_path, process_env.get("PATH"));
    append_path_entries(
        &mut merged_path,
        shell_env.and_then(|environment| environment.get("PATH")),
    );
    for entry in path_entries() {
        if !merged_path.iter().any(|existing| existing == &entry) {
            merged_path.push(entry);
        }
    }
    if let Ok(path) = std::env::join_paths(&merged_path) {
        child_env.insert("PATH".to_string(), path.to_string_lossy().to_string());
    }

    child_env
}

pub(crate) fn effective_local_agent_env(desc: &AgentDescriptor) -> HashMap<String, String> {
    build_child_env(std::env::vars(), login_shell_env(), &desc.env)
}

/// Merged process + login-shell environment without any per-agent overrides.
/// Used when resolving a template-owned command (e.g. the login terminal) that
/// is not tied to a registered `AgentDescriptor`.
pub(crate) fn local_login_shell_env() -> HashMap<String, String> {
    build_child_env(std::env::vars(), login_shell_env(), &HashMap::new())
}

pub(crate) fn resolve_command_in_agent_env(
    command: &str,
    environment: &HashMap<String, String>,
) -> Option<PathBuf> {
    let paths = environment
        .get("PATH")
        .map(|value| std::env::split_paths(value).collect::<Vec<_>>())
        .unwrap_or_default();
    crate::core::process::resolve_command_in_paths(command, &paths)
}

/// Resolve the ACP session cwd, also used by cwd-aware process launchers.
///
/// A remote target advertises its own vault path; a local one uses the open
/// Vault, falling back to [`crate::core::paths::agent_scratch_dir`] when the
/// vault path is missing or invalid. Never Agentero's process cwd: a macOS GUI
/// app launched by LaunchServices has `/`, so an agent that scans its startup
/// cwd would walk `$HOME` and trip TCC folder prompts (#570). If neither scratch
/// location can be created, fail before spawning instead of broadening the cwd.
pub(crate) fn agent_spawn_cwd(
    remote: Option<&dyn crate::features::agent::remote_host::RemoteAgentLaunch>,
    vault_path: Option<&str>,
) -> Result<PathBuf, AppError> {
    let raw = match remote {
        Some(remote) => remote.agent_cwd(),
        None => vault_path
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .map_or_else(crate::core::paths::agent_scratch_dir, Ok)?,
    };
    Ok(windows_shell_path(&raw))
}

/// Unix launches change cwd before exec (#570): Finder-launched apps inherit
/// `/`, and `dsh --profile acp` treats the invoking directory as its default
/// workspace root. The shell takes the cwd inline, so `env` stays unused on
/// this platform (signature parity with the Windows launcher below).
#[cfg(not(windows))]
fn local_launch_command(
    desc: &AgentDescriptor,
    command: PathBuf,
    _env: &mut HashMap<String, String>,
    cwd: Option<&Path>,
) -> (PathBuf, Vec<String>) {
    match cwd {
        Some(cwd) => wrap_local_command_with_cwd(&command, &desc.args, cwd),
        None => (command, desc.args.clone()),
    }
}

/// Bundled-tier spawn plan, as a plain fn so tests can stub the tier.
type BundledSpawnFn = fn(
    &str,
    &HashMap<String, String>,
) -> Option<(
    PathBuf,
    crate::features::agent::registry::bundled::BundledAdapter,
)>;

/// Decide how to launch a local ACP agent, in tier order:
/// 1. PATH/lifecycle-installed adapter (resolved against the merged child
///    env) — always wins when present;
/// 2. the bundled adapter tier — spawn `node <entry.js> [desc args…]` and
///    point the stripped adapter at the user's host CLI
///    (`CLAUDE_CODE_EXECUTABLE` / `CODEX_PATH`, or_insert so user env wins);
/// 3. today's behavior — the raw descriptor command, letting the spawn
///    surface the OS error.
pub(crate) fn plan_local_launch(
    desc: &AgentDescriptor,
    child_env: &mut HashMap<String, String>,
) -> (AgentDescriptor, PathBuf) {
    plan_local_launch_with(desc, child_env, registry_bundled_spawn)
}

fn registry_bundled_spawn(
    template_id: &str,
    child_env: &HashMap<String, String>,
) -> Option<(
    PathBuf,
    crate::features::agent::registry::bundled::BundledAdapter,
)> {
    crate::features::agent::registry::bundled::bundled_spawn(template_id, child_env)
}

fn plan_local_launch_with(
    desc: &AgentDescriptor,
    child_env: &mut HashMap<String, String>,
    bundled_spawn: BundledSpawnFn,
) -> (AgentDescriptor, PathBuf) {
    if let Some(path) = resolve_command_in_agent_env(&desc.command, child_env) {
        return (desc.clone(), path);
    }
    if let Some((node, adapter)) = bundled_spawn(desc.template.as_str(), child_env) {
        for (key, value) in crate::features::agent::registry::bundled::host_env_injection(
            desc.template.as_str(),
            child_env,
        ) {
            child_env.entry(key).or_insert(value);
        }
        let mut launch_desc = desc.clone();
        let mut args = Vec::with_capacity(desc.args.len() + 1);
        // Tauri resource paths can carry a Windows extended-length prefix;
        // Node's entry-script resolution rejects it before ACP initializes.
        args.push(windows_shell_path(&adapter.entry_js).display().to_string());
        args.extend(desc.args.iter().cloned());
        launch_desc.args = args;
        return (launch_desc, node);
    }
    (desc.clone(), PathBuf::from(&desc.command))
}

pub(crate) fn to_acp_agent_local(
    desc: &AgentDescriptor,
    cwd: Option<&Path>,
) -> Result<AcpAgent, AppError> {
    let mut child_env = effective_local_agent_env(desc);
    // ZCode's adapter needs the desktop app's runtime provider table and a
    // backend CLI that still supports the provider-registry push. Skip keys
    // already present (descriptor env and any user shell export), so explicit
    // user settings always win over auto-discovery.
    if desc.template == AgentTemplate::Zcode {
        for (key, value) in crate::features::agent::registry::templates::zcode_runtime_env() {
            child_env.entry(key).or_insert(value);
        }
    }
    let (launch_desc, command) = plan_local_launch(desc, &mut child_env);

    // Unix agents must not inherit `/` from a Finder-launched app (#570).
    // Windows retains its existing Pi/Custom-only wrapping policy until the
    // transport supports native cwd + tree teardown.
    let (command, args) = local_launch_command(&launch_desc, command, &mut child_env, cwd);

    let env: Vec<EnvVariable> = child_env
        .into_iter()
        .map(|(k, v)| EnvVariable::new(k.clone(), v.clone()))
        .collect();

    let stdio = McpServerStdio::new(desc.name.clone(), command)
        .args(args)
        .env(env);
    Ok(acp_agent_with_debug(
        AcpAgent::new(McpServer::Stdio(stdio)),
        &desc.name,
    ))
}

/// Build ACP agent process. When `remote` is SSH, wrap launch as `ssh … 'cd vault && exec agent'`.
/// Local-sim remotes validate their vault and reuse the local platform launch policy.
pub(crate) fn to_acp_agent(
    desc: &AgentDescriptor,
    cwd: Option<&Path>,
    remote: Option<&dyn crate::features::agent::remote_host::RemoteAgentLaunch>,
) -> Result<AcpAgent, AppError> {
    if let Some(r) = remote {
        if r.is_ssh() {
            let (program, args) = r.ssh_stdio(&desc.command, &desc.args, &desc.env)?;
            let stdio = McpServerStdio::new(desc.name.clone(), program).args(args);
            return Ok(acp_agent_with_debug(
                AcpAgent::new(McpServer::Stdio(stdio)),
                &desc.name,
            ));
        }
        // A stale local-sim handle must not silently run against scratch (or
        // fail later with an opaque shell/ACP handshake error). SSH paths were
        // handled above and must never be checked against the local filesystem.
        let remote_cwd = r.agent_cwd();
        if r.is_local_sim() && !remote_cwd.is_dir() {
            return Err(AppError::message(format!(
                "local-sim vault directory is unavailable: {}",
                remote_cwd.display()
            )));
        }
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

/// `session/new` during warm gets the same allowance as `initialize`: heavy BYOA
/// agents (Hermes profiles) build the full agent — provider inventory, tools,
/// MCP — on session create, and a cold spawn racing other warm-ups blows the
/// shared 15s budget even though the agent is healthy. Only warm uses this;
/// interactive turns keep the responsive 15s budget.
pub(crate) const ACP_NEW_SESSION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// `session/new` variant of [`timed_acp_request`]; see [`ACP_NEW_SESSION_TIMEOUT`].
pub(crate) async fn timed_acp_new_session<T, E>(
    request: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, agent_client_protocol::Error>
where
    E: std::fmt::Display,
{
    timed_acp_request_with(ACP_NEW_SESSION_TIMEOUT, "new_session", request).await
}

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
        sources: Vec::new(),
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
    use crate::features::agent::models::AgentTemplate;
    use crate::features::agent::remote_host::RemoteAgentLaunch;

    fn descriptor(template: AgentTemplate) -> AgentDescriptor {
        let info = crate::features::agent::registry::templates::template_info(template.as_str());
        AgentDescriptor {
            id: template.as_str().into(),
            name: template.as_str().into(),
            command: info
                .as_ref()
                .map(|info| info.command.clone())
                .unwrap_or_else(|| "agent.exe".into()),
            args: info.map(|info| info.args).unwrap_or_default(),
            template,
            env: HashMap::new(),
            available: true,
            last_error: None,
            last_probe_ok: None,
            last_probe_agent_name: None,
            last_probe_error: None,
            last_probed_at: None,
        }
    }

    struct RemoteTarget {
        cwd: PathBuf,
        ssh: bool,
    }

    #[async_trait::async_trait]
    impl RemoteAgentLaunch for RemoteTarget {
        fn is_ssh(&self) -> bool {
            self.ssh
        }
        fn is_local_sim(&self) -> bool {
            !self.ssh
        }
        fn host(&self) -> &str {
            "test-host"
        }
        fn agent_cwd(&self) -> PathBuf {
            self.cwd.clone()
        }
        fn work_root(&self) -> &Path {
            &self.cwd
        }
        fn ssh_stdio(
            &self,
            _command: &str,
            _args: &[String],
            _env: &HashMap<String, String>,
        ) -> Result<(PathBuf, Vec<String>), AppError> {
            Ok((
                PathBuf::from("ssh"),
                vec![self.cwd.to_string_lossy().into_owned()],
            ))
        }
        async fn which(&self, _bin: &str) -> Result<Option<String>, AppError> {
            unreachable!()
        }
        async fn materialize_skills(&self) -> Result<(), AppError> {
            unreachable!()
        }
        async fn ensure_vault_skills(
            &self,
            _locale: Option<&str>,
        ) -> Result<crate::features::vault::CreateVaultResult, AppError> {
            unreachable!()
        }
    }

    /// Fake bin dir with runnable shims (`fake-agent`, `claude`, `codex`) so
    /// PATH resolution and host-env injection stay hermetic on any machine.
    fn fake_agent_bin(names: &[&str]) -> (tempfile::TempDir, HashMap<String, String>) {
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        for name in names {
            let file = bin.join(name);
            std::fs::write(&file, "#!/bin/sh\n").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            // Windows resolution probes PATHEXT-style suffixes.
            #[cfg(windows)]
            std::fs::write(bin.join(format!("{name}.cmd")), "@echo off\r\n").unwrap();
        }
        let mut env = HashMap::new();
        env.insert(
            "PATH".to_string(),
            std::env::join_paths(std::iter::once(bin))
                .unwrap()
                .to_string_lossy()
                .to_string(),
        );
        (tmp, env)
    }

    /// Static fn-pointer payload for `plan_local_launch_with`: a fake bundled
    /// claude adapter plan (no capture needed, so it fits the fn type).
    fn fake_bundled_claude(
        _template_id: &str,
        _child_env: &HashMap<String, String>,
    ) -> Option<(
        PathBuf,
        crate::features::agent::registry::bundled::BundledAdapter,
    )> {
        Some((
            PathBuf::from("/fake/node"),
            crate::features::agent::registry::bundled::BundledAdapter {
                entry_js: PathBuf::from("/fake/adapters/claude-agent-acp/dist/index.js"),
                version: "0.0.0-test".to_string(),
                node_major: Some(22),
            },
        ))
    }

    #[test]
    fn plan_local_launch_prefers_path_tier_over_bundled() {
        let (_tmp, mut env) = fake_agent_bin(&["fake-agent"]);
        let mut desc = descriptor(AgentTemplate::Custom);
        desc.command = "fake-agent".to_string();
        desc.args = vec!["--flag".to_string()];
        let (launch_desc, command) = plan_local_launch_with(&desc, &mut env, fake_bundled_claude);
        // Resolved PATH tier: args untouched, no entry injection. (Windows
        // resolution lands on the `.cmd` shim, so match by substring.)
        assert!(
            command.to_string_lossy().contains("fake-agent"),
            "command: {command:?}"
        );
        assert_eq!(launch_desc.args, vec!["--flag".to_string()]);
        assert!(!env.contains_key("CLAUDE_CODE_EXECUTABLE"));
    }

    #[test]
    fn plan_local_launch_falls_back_to_bundled_node_entry_and_host_env() {
        // No adapter on PATH, but the host CLI (`claude`) is: the bundled tier
        // spawns `node <entry>` and points the adapter at the host.
        let (_tmp, mut env) = fake_agent_bin(&["claude"]);
        let desc = descriptor(AgentTemplate::ClaudeAcp);
        assert_ne!(
            desc.command, "claude",
            "adapter command must differ from host"
        );
        let (launch_desc, command) = plan_local_launch_with(&desc, &mut env, fake_bundled_claude);
        assert_eq!(command, PathBuf::from("/fake/node"));
        assert_eq!(
            launch_desc.args,
            vec!["/fake/adapters/claude-agent-acp/dist/index.js".to_string()]
        );
        let injected = env
            .get("CLAUDE_CODE_EXECUTABLE")
            .expect("host env injected");
        assert!(injected.contains("claude"), "injected: {injected}");

        // User-configured env wins: an explicit CLAUDE_CODE_EXECUTABLE survives.
        let (_tmp2, mut env2) = fake_agent_bin(&["claude"]);
        env2.insert(
            "CLAUDE_CODE_EXECUTABLE".to_string(),
            "/user/chosen/claude".to_string(),
        );
        let (_, _) = plan_local_launch_with(&desc, &mut env2, fake_bundled_claude);
        assert_eq!(
            env2.get("CLAUDE_CODE_EXECUTABLE").map(String::as_str),
            Some("/user/chosen/claude")
        );
    }

    #[test]
    fn plan_local_launch_falls_back_to_bundled_with_descriptor_args() {
        // Bundled entry is prepended before the descriptor's own args.
        let (_tmp, mut env) = fake_agent_bin(&[]);
        let mut desc = descriptor(AgentTemplate::Custom);
        desc.command = "nowhere-agent".to_string();
        desc.args = vec!["--flag".to_string(), "value".to_string()];
        let (launch_desc, command) = plan_local_launch_with(&desc, &mut env, fake_bundled_claude);
        assert_eq!(command, PathBuf::from("/fake/node"));
        assert_eq!(
            launch_desc.args,
            vec![
                "/fake/adapters/claude-agent-acp/dist/index.js".to_string(),
                "--flag".to_string(),
                "value".to_string(),
            ]
        );
    }

    #[test]
    fn plan_local_launch_normalizes_bundled_windows_entry() {
        for template in [AgentTemplate::CodexAcp, AgentTemplate::ClaudeAcp] {
            let (_tmp, mut env) = fake_agent_bin(&[]);
            let mut desc = descriptor(template);
            desc.args = vec!["--flag".to_string(), "value with spaces".to_string()];
            let (launch_desc, command) = plan_local_launch_with(&desc, &mut env, |_, _| {
                Some((
                    PathBuf::from(r"C:\Program Files\nodejs\node.exe"),
                    crate::features::agent::registry::bundled::BundledAdapter {
                        entry_js: PathBuf::from(
                            r"\\?\C:\Users\Test User\Agentero\adapters\dist\index.js",
                        ),
                        version: "0.0.0-test".to_string(),
                        node_major: Some(22),
                    },
                ))
            });
            assert_eq!(command, PathBuf::from(r"C:\Program Files\nodejs\node.exe"));
            assert_eq!(
                launch_desc.args,
                vec![
                    r"C:\Users\Test User\Agentero\adapters\dist\index.js".to_string(),
                    "--flag".to_string(),
                    "value with spaces".to_string(),
                ]
            );
        }
    }

    #[test]
    fn plan_local_launch_keeps_raw_command_without_tiers() {
        let (_tmp, mut env) = fake_agent_bin(&[]);
        let desc = descriptor(AgentTemplate::CodexAcp);
        let raw = desc.command.clone();
        let (launch_desc, command) =
            plan_local_launch_with(&desc, &mut env, |_template_id, _child_env| None);
        assert_eq!(command, PathBuf::from(&raw));
        assert_eq!(launch_desc.args, desc.args);
        assert!(!env.contains_key("CODEX_PATH"));
    }

    #[test]
    #[cfg(not(windows))]
    fn dsh_gets_the_standard_cwd_wrapper_like_every_local_template() {
        let desc = descriptor(AgentTemplate::Dsh);
        let command = PathBuf::from(&desc.command);
        let mut env = HashMap::new();
        let (program, args) =
            local_launch_command(&desc, command.clone(), &mut env, Some(Path::new("/vault")));
        // `dsh --profile acp` resolves its default workspace root from the
        // invoking directory, so it must go through the same `cd` wrapper.
        assert_eq!(program, PathBuf::from("/bin/sh"));
        assert!(
            args.first().map(String::as_str) == Some("-c")
                && args
                    .get(1)
                    .is_some_and(|s| s.starts_with("cd '/vault' && exec ")),
            "dsh not wrapped: {args:?}"
        );
        assert!(env.is_empty());
    }

    #[test]
    fn stale_local_sim_is_rejected_without_checking_ssh_paths_locally() {
        let root = tempfile::tempdir().unwrap();
        let mut remote = RemoteTarget {
            cwd: root.path().join("missing-vault"),
            ssh: false,
        };
        let desc = descriptor(AgentTemplate::CodexAcp);
        // None is also the Windows probe path: validation must not depend on
        // whether the platform needs a cwd shell wrapper.
        for cwd in [None, Some(remote.cwd.as_path())] {
            let Err(error) = to_acp_agent(&desc, cwd, Some(&remote)) else {
                panic!("stale local-sim vault must fail before spawning an agent");
            };
            assert!(error.to_string().contains("local-sim"));
            assert!(error.to_string().contains("missing-vault"));
        }
        remote.ssh = true;
        assert_eq!(agent_spawn_cwd(Some(&remote), None).unwrap(), remote.cwd);
        assert!(to_acp_agent(&desc, Some(&remote.cwd), Some(&remote)).is_ok());
    }

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
        let (cmd, args) = wrap_local_command_with_cwd(
            Path::new("/usr/bin/pi-acp"),
            &["--foo".to_string(), "bar baz".to_string()],
            Path::new("/path/with spaces"),
        );
        assert_eq!(cmd, PathBuf::from("/bin/sh"));
        assert_eq!(args.len(), 2);
        assert_eq!(args[0], "-c");
        assert!(args[1]
            .starts_with("cd '/path/with spaces' && exec '/usr/bin/pi-acp' '--foo' 'bar baz'"));
    }

    /// #570 policy guard: on Unix every local template is wrapped with a
    /// `cd <cwd> && exec …` shell (no per-template exemptions — `dsh --profile
    /// acp` also resolves its default workspace root from the invoking cwd).
    #[test]
    #[cfg(not(windows))]
    fn unix_wraps_every_local_template() {
        use crate::features::agent::registry::templates::{builtin_templates, template_from_id};

        let mut templates = builtin_templates()
            .into_iter()
            .map(|info| template_from_id(&info.id))
            .collect::<Vec<_>>();
        templates.push(AgentTemplate::Custom);

        for template in templates {
            let desc = descriptor(template);
            let command = PathBuf::from(&desc.command);
            let mut env = HashMap::new();
            let (program, args) =
                local_launch_command(&desc, command.clone(), &mut env, Some(Path::new("/vault")));

            assert_eq!(program, PathBuf::from("/bin/sh"), "{}", desc.id);
            assert!(
                args.first().map(String::as_str) == Some("-c")
                    && args
                        .get(1)
                        .is_some_and(|s| s.contains("cd '/vault' && exec ")),
                "{} not wrapped: {args:?}",
                desc.id
            );
            assert!(env.is_empty(), "{}", desc.id);
        }
    }

    /// #570 regression guard: Codex used to be excluded from the shell wrap
    /// (only `Pi` / `Custom` were), yet it scans its process cwd on startup.
    #[test]
    #[cfg(not(windows))]
    fn unix_codex_wraps_in_the_spawn_cwd() {
        let mut desc = descriptor(AgentTemplate::CodexAcp);
        desc.args = vec!["--flag".into()];
        let mut env = HashMap::new();

        let (cmd, args) = local_launch_command(
            &desc,
            PathBuf::from("codex-acp"),
            &mut env,
            Some(Path::new("/vault")),
        );
        assert_eq!(cmd, PathBuf::from("/bin/sh"));
        assert_eq!(
            args,
            vec![
                "-c".to_string(),
                "cd '/vault' && exec 'codex-acp' '--flag'".to_string()
            ]
        );

        // No cwd known: the bare command is kept.
        let (cmd, args) = local_launch_command(&desc, PathBuf::from("codex-acp"), &mut env, None);
        assert_eq!(cmd, PathBuf::from("codex-acp"));
        assert_eq!(args, vec!["--flag".to_string()]);
    }

    #[test]
    fn windows_preserves_native_launchers_and_unwrapped_probes() {
        use crate::features::agent::registry::templates::{builtin_templates, template_from_id};

        let mut templates = builtin_templates()
            .into_iter()
            .map(|info| template_from_id(&info.id))
            .collect::<Vec<_>>();
        templates.push(AgentTemplate::Custom);
        for template in templates {
            let desc = descriptor(template);
            // Probe has no cwd wrapper, including Pi/Custom. A native .exe
            // remains the SDK's direct child and can still be killed on timeout.
            let mut env = HashMap::new();
            let command = PathBuf::from(&desc.command);
            assert_eq!(
                windows_launch_command(&desc, command.clone(), &mut env, None),
                (command.clone(), desc.args.clone())
            );
            assert!(env.is_empty());

            if matches!(desc.template, AgentTemplate::Pi | AgentTemplate::Custom) {
                let (program, _) =
                    windows_launch_command(&desc, command, &mut env, Some(Path::new(r"C:\Vault")));
                assert_eq!(program, PathBuf::from("cmd"));
                assert!(env.contains_key("AGENTERO_AGENT_CWD"));
                continue;
            }
            // Native launchers also remain direct for UNC vaults; they must not
            // hit CMD's unsupported `cd /d` network path handling.
            for cwd in [
                r"C:\My Vault",
                r"\\server\share\vault",
                r"\\?\UNC\server\share\vault",
            ] {
                let mut env = HashMap::new();
                assert_eq!(
                    windows_launch_command(&desc, command.clone(), &mut env, Some(Path::new(cwd))),
                    (command.clone(), desc.args.clone()),
                    "{} at {cwd}",
                    desc.id
                );
                assert!(env.is_empty());
            }
        }
    }

    #[test]
    fn agent_spawn_cwd_prefers_the_vault_and_never_the_process_cwd() {
        let vault = std::env::temp_dir().join(format!("agentero-cwd-{}", std::process::id()));
        std::fs::create_dir_all(&vault).unwrap();

        assert_eq!(
            agent_spawn_cwd(None, vault.to_str()).unwrap(),
            windows_shell_path(&vault)
        );
        // Missing/invalid vault -> private scratch dir, never the process cwd.
        assert_eq!(
            agent_spawn_cwd(None, vault.join("missing").to_str()).unwrap(),
            windows_shell_path(&crate::core::paths::agent_scratch_dir().unwrap())
        );

        let _ = std::fs::remove_dir(&vault);
    }

    #[test]
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
    fn wrap_windows_builds_cmd_cd_script() {
        let mut env = HashMap::new();
        let mut desc = descriptor(AgentTemplate::Pi);
        desc.args = vec!["--foo".into(), "bar baz".into()];
        let (cmd, args) = windows_launch_command(
            &desc,
            PathBuf::from(r"C:\Program Files\pi-acp.cmd"),
            &mut env,
            Some(Path::new(r"\\?\C:\My Vault")),
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

    #[test]
    fn build_child_env_priority_order() {
        let process_env = vec![
            ("OPENAI_API_KEY".to_string(), "process-key".to_string()),
            ("SHARED".to_string(), "process".to_string()),
        ]
        .into_iter();
        let mut shell_env = HashMap::new();
        shell_env.insert(
            "OPENAI_BASE_URL".to_string(),
            "https://shell/v1".to_string(),
        );
        shell_env.insert("SHARED".to_string(), "shell".to_string());
        let mut desc_env = HashMap::new();
        desc_env.insert("OPENAI_API_KEY".to_string(), "desc-key".to_string());

        let env = build_child_env(process_env, Some(&shell_env), &desc_env);

        // desc_env wins over everything.
        assert_eq!(env.get("OPENAI_API_KEY"), Some(&"desc-key".to_string()));
        // shell_env fills missing keys but does not overwrite process env.
        assert_eq!(
            env.get("OPENAI_BASE_URL"),
            Some(&"https://shell/v1".to_string())
        );
        assert_eq!(env.get("SHARED"), Some(&"process".to_string()));
    }

    #[test]
    fn build_child_env_merges_path_in_resolution_order() {
        let process_path = std::env::join_paths(["/process/bin", "/shared/bin"]).unwrap();
        let shell_path = std::env::join_paths(["/shell/bin", "/shared/bin"]).unwrap();
        let descriptor_path = std::env::join_paths(["/descriptor/bin"]).unwrap();
        let process_env = vec![(
            "PATH".to_string(),
            process_path.to_string_lossy().into_owned(),
        )]
        .into_iter();
        let mut shell_env = HashMap::new();
        shell_env.insert(
            "PATH".to_string(),
            shell_path.to_string_lossy().into_owned(),
        );
        let mut desc_env = HashMap::new();
        desc_env.insert(
            "PATH".to_string(),
            descriptor_path.to_string_lossy().into_owned(),
        );

        let env = build_child_env(process_env, Some(&shell_env), &desc_env);
        let entries = std::env::split_paths(env.get("PATH").unwrap()).collect::<Vec<_>>();

        assert_eq!(entries[0], PathBuf::from("/descriptor/bin"));
        assert_eq!(entries[1], PathBuf::from("/process/bin"));
        assert_eq!(entries[2], PathBuf::from("/shared/bin"));
        assert_eq!(entries[3], PathBuf::from("/shell/bin"));
        assert_eq!(
            entries
                .iter()
                .filter(|entry| entry.as_path() == Path::new("/shared/bin"))
                .count(),
            1
        );
    }
}
