//! JSON shapes shared by the delegate socket and the stdio MCP worker.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const WORKER_ARG: &str = "--agentero-delegate-mcp";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DelegateGrant {
    pub socket: String,
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireRequest {
    pub token: String,
    pub id: String,
    pub op: String,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub wait_ms: Option<u64>,
    #[serde(default)]
    pub run_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WireResponse {
    pub id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TargetInfo {
    pub target: String,
    pub destination: String,
    pub remote_path: String,
    pub local_sim: bool,
    pub agents: Vec<AgentInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TargetsBody {
    pub targets: Vec<TargetInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunBody {
    pub run_id: String,
    pub target: String,
    pub agent_id: String,
    pub destination: String,
    pub status: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// Tool arguments for `remote_delegate`. Extra keys such as `autoApprove`
/// or `command` fail to deserialize.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DelegateArgs {
    /// `remote:<sessionId>` from `remote_targets`. Omit only when one vault is connected.
    #[serde(default)]
    pub target: Option<String>,
    /// Registered agent id. Omit only when one agent is registered.
    #[serde(default)]
    pub agent_id: Option<String>,
    /// Task for the remote agent. Do not include a shell command.
    pub prompt: String,
    /// How long to wait for the remote turn, in milliseconds. The host clamps this.
    #[serde(default)]
    pub wait_ms: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunIdArgs {
    pub run_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delegate_args_reject_privilege_fields() {
        let ok =
            serde_json::from_str::<DelegateArgs>(r#"{"prompt":"run the ablation","waitMs":1000}"#);
        assert!(ok.is_ok());
        let auto = serde_json::from_str::<DelegateArgs>(r#"{"prompt":"run","autoApprove":true}"#);
        assert!(auto.is_err());
        let command = serde_json::from_str::<DelegateArgs>(r#"{"prompt":"run","command":"bash"}"#);
        assert!(command.is_err());
    }
}
