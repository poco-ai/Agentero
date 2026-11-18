use crate::features::agent::models::AgentDescriptor;
#[cfg(any(windows, test))]
use crate::{core::process::windows_shell_path, features::agent::models::AgentTemplate};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

#[cfg(not(windows))]
pub(super) fn wrap_local_command_with_cwd(
    command: &Path,
    args: &[String],
    cwd: &Path,
) -> (PathBuf, Vec<String>) {
    let mut argv = vec![
        "-c".into(),
        r#"cd "$1" && shift && exec "$@""#.into(),
        "agentero-acp".into(),
        cwd.display().to_string(),
        command.display().to_string(),
    ];
    argv.extend_from_slice(args);
    (PathBuf::from("/bin/sh"), argv)
}

/// Quote a token for a Windows `cmd /C` command. Empty strings, spaces, and
/// most cmd metacharacters trigger double-quote wrapping; internal double
/// quotes are backslash-escaped.
#[cfg(any(windows, test))]
pub(super) fn windows_shell_quote(s: &str) -> String {
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
pub(super) fn windows_cmd_cwd(cwd: &Path) -> String {
    windows_shell_path(cwd).to_string_lossy().into_owned()
}

/// Pre-quote the cwd environment value so metacharacters remain literal after
/// `cmd.exe` expands `%AGENTERO_AGENT_CWD%`, even when the path has no spaces.
#[cfg(any(windows, test))]
pub(super) fn windows_cmd_cwd_env_value(cwd: &Path) -> String {
    format!("\"{}\"", windows_cmd_cwd(cwd))
}

/// Templates whose Windows process must start in the Vault.
///
/// ACP stdio has no cwd field. Pi and Custom already used a `cmd` `cd`.
/// Zcode's `server` mode ignores the ACP session cwd and indexes
/// `.agents/skills` from the process cwd, so a direct spawn never sees the
/// Vault. Other templates stay direct children: wrapping them changes
/// quoting, `cd /d` rejects UNC, and the SDK only kills the direct child.
#[cfg(any(windows, test))]
pub(super) fn windows_process_cwd_template(template: &AgentTemplate) -> bool {
    matches!(
        template,
        AgentTemplate::Pi | AgentTemplate::Custom | AgentTemplate::Zcode
    )
}

/// Windows launch policy and command construction. Kept available to unit
/// tests on Unix so changes to the wrapper policy are checked on every CI run.
#[cfg(any(windows, test))]
pub(super) fn windows_launch_command(
    desc: &AgentDescriptor,
    command: PathBuf,
    env: &mut HashMap<String, String>,
    cwd: Option<&Path>,
) -> (PathBuf, Vec<String>) {
    let Some(cwd) = cwd.filter(|_| windows_process_cwd_template(&desc.template)) else {
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
pub(super) use windows_launch_command as local_launch_command;

/// Unix launches change cwd before exec (#570): Finder-launched apps inherit
/// `/`, and `dsh --profile acp` treats the invoking directory as its default
/// workspace root.
#[cfg(not(windows))]
pub(super) fn local_launch_command(
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
