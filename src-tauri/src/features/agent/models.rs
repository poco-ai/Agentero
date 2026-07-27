use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AgentTemplate {
    Opencode,
    Gemini,
    ClaudeAcp,
    CodexAcp,
    /// Qoder CLI native ACP (`qodercli --acp`).
    /// Docs: https://docs.qoder.com/en/cli/acp
    QoderCli,
    /// Grok Build ACP (`npx @xai-official/grok@0.2.100 agent stdio`).
    /// Docs: https://zed.dev/acp/agent/grok-build
    GrokBuild,
    Custom,
}

impl AgentTemplate {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Opencode => "opencode",
            Self::Gemini => "gemini",
            Self::ClaudeAcp => "claude-acp",
            Self::CodexAcp => "codex-acp",
            Self::QoderCli => "qodercli",
            Self::GrokBuild => "grok-build",
            Self::Custom => "custom",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDescriptor {
    pub id: String,
    pub name: String,
    pub template: AgentTemplate,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// Last ACP probe succeeded (None = never probed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_probe_ok: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_probe_agent_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_probe_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_probed_at: Option<String>,
}

pub const DEFAULT_AGENT_PROXY_URL: &str = "http://127.0.0.1:7890";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRegistryState {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_id: Option<String>,
    #[serde(default)]
    pub agents: Vec<AgentDescriptor>,
    #[serde(default)]
    pub proxy_enabled: bool,
    #[serde(default = "default_agent_proxy_url")]
    pub proxy_url: String,
}

impl Default for AgentRegistryState {
    fn default() -> Self {
        Self {
            enabled: true,
            default_id: None,
            agents: Vec::new(),
            proxy_enabled: false,
            proxy_url: default_agent_proxy_url(),
        }
    }
}

pub fn default_agent_proxy_url() -> String {
    DEFAULT_AGENT_PROXY_URL.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentListResponse {
    pub agents: Vec<AgentDescriptor>,
    pub default_id: Option<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTemplateInfo {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub command: String,
    pub args: Vec<String>,
    /// Binary checked for "installed" badge (may differ from ACP command).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detect_command: Option<String>,
    pub install_hint: String,
    /// Optional shell command to install a missing ACP adapter (opened in the
    /// system terminal with a confirmation prompt — never run silently).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_command: Option<String>,
}

/// Status for a common agent row in Settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CatalogAcpStatus {
    /// Detect binary missing.
    Missing,
    /// Binary found, ACP not probed yet.
    NotProbed,
    /// ACP initialize succeeded.
    Ready,
    /// ACP initialize failed.
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub template_id: String,
    pub name: String,
    pub description: String,
    pub command: String,
    pub args: Vec<String>,
    pub install_hint: String,
    /// Shell install command for a missing ACP adapter (from the template).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_command: Option<String>,
    /// Host CLI present but ACP entrypoint missing — Settings may offer install.
    #[serde(default)]
    pub offer_install: bool,
    /// Primary CLI found on PATH (detect_command or command).
    pub binary_available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_path: Option<String>,
    /// ACP entrypoint command found (e.g. npx / opencode).
    pub acp_command_available: bool,
    pub acp_status: CatalogAcpStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registered_id: Option<String>,
    pub is_default: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acp_agent_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_probe_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_probed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogScanResponse {
    pub entries: Vec<CatalogEntry>,
    pub custom_agents: Vec<AgentDescriptor>,
    pub default_id: Option<String>,
    pub enabled: bool,
    pub proxy_enabled: bool,
    pub proxy_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertAgentRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub template: Option<AgentTemplate>,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub set_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub agent_id: String,
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_capabilities: Option<AcpSessionCapabilities>,
}

/// Base64 image payload for multimodal ACP prompts (PDF region crops, etc.).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptImage {
    /// Raw base64 (no data: URL prefix).
    pub data: String,
    pub mime_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunOnceRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// ACP session id for multi-turn: when provided, `session/resume` is used
    /// instead of `session/new` so the agent retains conversation context.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub prompt: String,
    /// Optional images attached to this prompt (ACP `ContentBlock::Image`).
    #[serde(default)]
    pub images: Vec<PromptImage>,
    /// Vault root used as ACP session cwd. Falls back to process cwd when omitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vault_path: Option<String>,
    #[serde(default)]
    pub workflow: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// Preferred model id from ACP session config (category: model). Applied after session/new.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    /// Preferred ACP reasoning effort (category: thought_level). Applied after session/new.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    /// Preferred ACP fast mode (category: model_config). Applied after session/new.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast_mode: Option<bool>,
    /// Locally discovered SKILL.md identifiers selected through the composer.
    #[serde(default)]
    pub skill_ids: Vec<String>,
    /// When enabled, automatically select the first ACP permission option for this run.
    #[serde(default)]
    pub auto_approve: bool,
    /// ACP permission handling: "restricted" (decline), "auto" (approve all),
    /// or "ask" (forward each request to the user). Defaults to "restricted".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    /// Language every response and generated note must use (e.g. `zh-CN`).
    /// Resolved from the global setting on the frontend; `None` = no directive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_language: Option<String>,
    /// Free-form user preference instructions (Settings → Agent).
    /// Injected into the Host prompt envelope; empty / omitted = off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub personal_prompt: Option<String>,
    /// When true, do not list this session in Agent chat history
    /// (paper-reader and other non-composer workflows).
    #[serde(default)]
    pub hide_from_chat_history: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkill {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunOnceAccepted {
    pub session_id: String,
    pub message_id: String,
    pub agent_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentResultPayload {
    pub session_id: String,
    pub message_id: String,
    pub content: String,
    /// ACP agent thought / reasoning (from AgentThoughtChunk), if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    pub sources: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    /// Durable ACP provider session id used by `session/resume`.
    /// This is distinct from Agentero's per-run event correlation id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>,
}

/// Stream chunk kind: assistant message body vs internal thought/reasoning.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentStreamKind {
    Message,
    Thought,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStreamEvent {
    pub session_id: String,
    pub chunk: String,
    pub kind: AgentStreamKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEffortChoice {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// ACP reasoning-effort selector advertised for the current session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEffortEvent {
    pub session_id: String,
    pub agent_id: String,
    pub config_id: String,
    pub current_id: String,
    pub efforts: Vec<AgentEffortChoice>,
}

/// ACP fast-mode toggle advertised for the current session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFastModeEvent {
    pub session_id: String,
    pub agent_id: String,
    pub config_id: String,
    pub enabled: bool,
}

/// ACP tool call create/update for UI (`Tool` element).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolEvent {
    pub session_id: String,
    pub tool_call_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// pending | in_progress | completed | failed
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<serde_json::Value>,
    /// When true, fields are a full snapshot (ToolCall); false = patch (ToolCallUpdate).
    #[serde(default)]
    pub full: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPlanEntry {
    pub content: String,
    /// pending | in_progress | completed
    pub status: String,
    /// high | medium | low
    pub priority: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPlanEvent {
    pub session_id: String,
    pub entries: Vec<AgentPlanEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsageEvent {
    pub session_id: String,
    pub used: u64,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelChoice {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

/// Models advertised by the ACP agent via session config options (category: model).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelsEvent {
    pub session_id: String,
    pub agent_id: String,
    /// ACP config option id for the model selector.
    pub config_id: String,
    pub current_id: String,
    pub models: Vec<AgentModelChoice>,
}

/// Background ACP warm-up (no user prompt) so Chat can show models/context early.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WarmRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vault_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WarmResult {
    pub agent_id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<AgentModelsEvent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_used: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFailedEvent {
    pub session_id: String,
    pub error: String,
}

/// A single session entry from ACP `session/list`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionInfo {
    pub session_id: String,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

/// Response for `agent_list_sessions`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpListSessionsResult {
    pub sessions: Vec<AcpSessionInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    /// Whether the agent advertised session.list capability.
    pub supported: bool,
}

/// Tool call snapshot rebuilt from ACP `session/load` replay.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpHistoryTool {
    pub id: String,
    pub title: String,
    pub kind: String,
    /// pending | in_progress | completed | failed
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<serde_json::Value>,
}

/// Ordered slice of a replayed agent turn (mirrors the frontend `AgentPart`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AcpHistoryPart {
    Reasoning { text: String },
    Text { text: String },
    Tool { tool: Box<AcpHistoryTool> },
    Plan { entries: Vec<AgentPlanEntry> },
}

/// A single history line reconstructed from ACP `session/load` replay.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpHistoryLine {
    pub id: String,
    /// "user" | "agent"
    pub kind: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    /// Ordered parts for agent lines (empty for user lines).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parts: Vec<AcpHistoryPart>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<String>,
}

/// Response for `agent_load_session`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpLoadSessionResult {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub lines: Vec<AcpHistoryLine>,
}

/// Session capabilities advertised by an ACP agent during initialize.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionCapabilities {
    pub list: bool,
    pub resume: bool,
    pub load: bool,
    pub delete: bool,
}
