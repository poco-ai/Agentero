//! Pure decisions for remote delegation. No SSH, no ACP.

use std::time::Duration;

pub const DEFAULT_WAIT: Duration = Duration::from_secs(10 * 60);
pub const MAX_WAIT: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentChoice {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetChoice {
    pub session_id: String,
    pub handle: String,
    pub destination: String,
    pub remote_path: String,
    pub local_sim: bool,
}

/// Host label shown to the local agent and on the permission dialog.
pub fn target_host(target: &TargetChoice) -> String {
    if target.local_sim {
        target.remote_path.clone()
    } else {
        target.destination.clone()
    }
}

/// `None` and `0` use the default. Longer requests are clamped to [`MAX_WAIT`].
pub fn clamp_wait(requested_ms: Option<u64>) -> Duration {
    let Some(ms) = requested_ms.filter(|ms| *ms > 0) else {
        return DEFAULT_WAIT;
    };
    let max = u64::try_from(MAX_WAIT.as_millis()).unwrap_or(u64::MAX);
    Duration::from_millis(ms.min(max))
}

/// The model cannot widen permission or supply a shell. Unknown keys that
/// mean either of those are rejected before a run starts.
pub fn reject_privilege_escalation(value: &serde_json::Value) -> Result<(), &'static str> {
    let Some(obj) = value.as_object() else {
        return Err("delegate request must be a JSON object");
    };
    for key in [
        "autoApprove",
        "permissionMode",
        "permission",
        "command",
        "args",
    ] {
        if obj.contains_key(key) {
            return Err("delegated runs cannot set permission policy or a shell command");
        }
    }
    Ok(())
}

pub fn tokens_match(presented: &str, expected: &str) -> bool {
    let presented = presented.as_bytes();
    let expected = expected.as_bytes();
    if presented.len() != expected.len() {
        return false;
    }
    let mut diff = 0u8;
    for (left, right) in presented.iter().zip(expected) {
        diff |= left ^ right;
    }
    diff == 0
}

pub fn resolve_target<'a>(
    explicit: Option<&str>,
    targets: &'a [TargetChoice],
) -> Result<&'a TargetChoice, String> {
    if targets.is_empty() {
        return Err("no remote vault is connected".into());
    }
    let explicit = explicit.map(str::trim).filter(|value| !value.is_empty());
    let Some(explicit) = explicit else {
        return if targets.len() == 1 {
            Ok(&targets[0])
        } else {
            Err("target is required when more than one remote vault is connected".into())
        };
    };
    let bare = explicit.strip_prefix("remote:").unwrap_or(explicit);
    targets
        .iter()
        .find(|target| {
            target.session_id == bare
                || target.session_id == explicit
                || target.handle == explicit
                || target.destination == explicit
        })
        .ok_or_else(|| format!("remote target is not connected: {explicit}"))
}

pub fn resolve_agent<'a>(
    explicit: Option<&str>,
    agents: &'a [AgentChoice],
) -> Result<&'a AgentChoice, String> {
    if agents.is_empty() {
        return Err("no registered agent can run on the remote host".into());
    }
    let explicit = explicit.map(str::trim).filter(|value| !value.is_empty());
    let Some(explicit) = explicit else {
        return if agents.len() == 1 {
            Ok(&agents[0])
        } else {
            Err("agentId is required when more than one agent is registered".into())
        };
    };
    agents
        .iter()
        .find(|agent| agent.id == explicit)
        .ok_or_else(|| format!("agent is not registered: {explicit}"))
}

/// Fixed instructions in front of the task the local agent wrote.
pub fn remote_task_prompt(host: &str, vault: &str, task: &str) -> String {
    format!(
        "You are running on {host}. The working directory is the vault {vault}. \
         Do this task on this machine. Write outputs under the vault. \
         Finish with relative paths and a short result. \
         Do not assume you can read the user's laptop.\n\nTask:\n{task}"
    )
}

/// One line block for the local agent's prompt. Empty when nothing is connected.
pub fn delegate_hint(targets: &[TargetChoice], agents: &[AgentChoice]) -> Option<String> {
    if targets.is_empty() {
        return None;
    }
    let mut lines = vec![
        "Connected remote vaults. Call the agentero-delegate tools only when the work must run on that machine. Do not invent a shell command.".to_string(),
    ];
    for target in targets {
        lines.push(format!(
            "- {} at {} vault {}",
            target.handle,
            target_host(target),
            target.remote_path
        ));
    }
    if agents.is_empty() {
        lines.push("No registered agent is available to run there.".into());
    } else {
        let names = agents
            .iter()
            .map(|agent| format!("{} ({})", agent.id, agent.name))
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!("Registered agents: {names}."));
    }
    Some(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn target(id: &str, destination: &str) -> TargetChoice {
        TargetChoice {
            session_id: id.into(),
            handle: format!("remote:{id}"),
            destination: destination.into(),
            remote_path: "/vault".into(),
            local_sim: false,
        }
    }

    fn agent(id: &str) -> AgentChoice {
        AgentChoice {
            id: id.into(),
            name: id.into(),
        }
    }

    #[test]
    fn wait_defaults_and_clamps() {
        assert_eq!(clamp_wait(None), DEFAULT_WAIT);
        assert_eq!(clamp_wait(Some(0)), DEFAULT_WAIT);
        assert_eq!(clamp_wait(Some(1_500)), Duration::from_millis(1_500));
        assert_eq!(clamp_wait(Some(u64::MAX)), MAX_WAIT);
    }

    #[test]
    fn privilege_keys_are_rejected() {
        assert!(reject_privilege_escalation(&json!({"prompt": "run"})).is_ok());
        assert!(reject_privilege_escalation(&json!({"autoApprove": true})).is_err());
        assert!(reject_privilege_escalation(&json!({"permissionMode": "auto"})).is_err());
        assert!(reject_privilege_escalation(&json!({"command": "bash"})).is_err());
        assert!(reject_privilege_escalation(&json!([])).is_err());
    }

    #[test]
    fn token_compare_checks_every_byte() {
        assert!(tokens_match("abc", "abc"));
        assert!(!tokens_match("abc", "abd"));
        assert!(!tokens_match("abc", "abcd"));
        assert!(!tokens_match("", "a"));
    }

    #[test]
    fn target_resolution() {
        let one = vec![target("s1", "me@host")];
        assert_eq!(resolve_target(None, &one).unwrap().session_id, "s1");
        assert_eq!(
            resolve_target(Some("remote:s1"), &one).unwrap().session_id,
            "s1"
        );
        assert_eq!(
            resolve_target(Some("me@host"), &one).unwrap().session_id,
            "s1"
        );
        assert!(resolve_target(Some("other"), &one).is_err());
        assert!(resolve_target(None, &[]).unwrap_err().contains("no remote"));

        let two = vec![target("s1", "a"), target("s2", "b")];
        assert!(resolve_target(None, &two).unwrap_err().contains("required"));
        assert_eq!(resolve_target(Some("s2"), &two).unwrap().session_id, "s2");
    }

    #[test]
    fn agent_resolution() {
        let one = vec![agent("claude")];
        assert_eq!(resolve_agent(None, &one).unwrap().id, "claude");
        let two = vec![agent("claude"), agent("codex")];
        assert!(resolve_agent(None, &two).is_err());
        assert_eq!(resolve_agent(Some("codex"), &two).unwrap().id, "codex");
        assert!(resolve_agent(Some("pi"), &two).is_err());
        assert!(resolve_agent(None, &[]).is_err());
    }

    #[test]
    fn hint_is_absent_without_targets() {
        assert!(delegate_hint(&[], &[]).is_none());
        let hint = delegate_hint(&[target("s1", "me@host")], &[agent("claude")]).unwrap();
        assert!(hint.contains("remote:s1"));
        assert!(hint.contains("me@host"));
        assert!(hint.contains("claude"));
        assert!(!hint.contains("shell command:"));
    }

    #[test]
    fn remote_prompt_names_the_host_and_keeps_the_task() {
        let prompt = remote_task_prompt("me@host", "/data/vault", "run the ablation");
        assert!(prompt.contains("me@host"));
        assert!(prompt.contains("/data/vault"));
        assert!(prompt.contains("run the ablation"));
        assert!(prompt.contains("Do not assume you can read the user's laptop"));
    }

    #[test]
    fn local_sim_host_is_the_vault_path() {
        let target = TargetChoice {
            session_id: "s".into(),
            handle: "remote:s".into(),
            destination: "__local_sim__".into(),
            remote_path: "/tmp/vault".into(),
            local_sim: true,
        };
        assert_eq!(target_host(&target), "/tmp/vault");
    }
}
