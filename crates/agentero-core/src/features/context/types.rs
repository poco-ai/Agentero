//! Wire types for one turn of research context.
//!
//! Field names are camelCase so the desktop IPC contract and the MCP tool
//! results stay the same shape.

use serde::{Deserialize, Serialize};

/// Where the turn started. Quick Chat and the sidebar share one resolver.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ContextSurface {
    QuickChat,
    Sidebar,
}

/// First phase is read-only. Write tools are not part of this grant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type, Default)]
#[serde(rename_all = "snake_case")]
pub enum ContextMode {
    #[default]
    ReadOnly,
}

/// How an anchor entered the turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type, Default)]
#[serde(rename_all = "snake_case")]
pub enum ContextAnchorKind {
    #[default]
    Selection,
    Paper,
    Mention,
}

/// One piece of user-supplied location: a selection, the open paper, or an @ mention.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContextAnchor {
    pub kind: ContextAnchorKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paper_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    /// 1-based PDF page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_from: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_to: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub translation: Option<String>,
    /// Composer annotation number, when the quote sits inline as `[Annotation N]`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotation: Option<u32>,
}

/// What the host knows before it resolves a turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ContextRequest {
    pub surface: ContextSurface,
    #[serde(default)]
    pub question: String,
    #[serde(default)]
    pub anchors: Vec<ContextAnchor>,
    #[serde(default)]
    pub mode: ContextMode,
}

/// A paper folder, a vault directory, or a single vault file this turn may read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AllowedSource {
    pub kind: AllowedSourceKind,
    /// Vault-relative paper folder, directory, or file.
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paper_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum AllowedSourceKind {
    Paper,
    File,
    /// An ordinary vault directory from an @ mention. Not a catalog paper.
    Directory,
}

/// Character and count caps for tool results. Full text is never the default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ContextBudget {
    pub search_limit: u32,
    pub card_chars: u32,
    pub read_chars: u32,
    pub full_chars: u32,
}

impl Default for ContextBudget {
    fn default() -> Self {
        Self {
            search_limit: 5,
            card_chars: 280,
            read_chars: 4_000,
            full_chars: 12_000,
        }
    }
}

/// Whether this session can call the context tools.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ContextExpansion {
    /// Local ACP session with a turn-bound evidence CLI.
    Cli,
    /// Remote agent, or an agent without a local CLI.
    /// The prompt carries only the minimum evidence and says so.
    PromptOnly,
}

/// Quote, title, and location copied into the prompt. Not the paper body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImmediateEvidence {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotation: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paper_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paper_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_from: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_to: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote: Option<String>,
    #[serde(default)]
    pub quote_truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub translation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub citation_uri: Option<String>,
}

/// One turn's context: what goes in the prompt, what the tools may open, and
/// the fingerprint that decides whether an ACP session may be resumed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ContextPlan {
    pub mode: ContextMode,
    pub expansion: ContextExpansion,
    pub immediate: Vec<ImmediateEvidence>,
    pub allowed: Vec<AllowedSource>,
    pub budget: ContextBudget,
    /// Stable hash of the tool profile, allowed sources, budget, and expansion.
    /// A quote edit does not change it. A new source does.
    pub fingerprint: String,
}

/// Read-only evidence grant kept in the hosting desktop process.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextGrant {
    pub schema_version: u32,
    pub session_id: String,
    pub vault_path: String,
    pub fingerprint: String,
    pub allowed: Vec<AllowedSource>,
    pub budget: ContextBudget,
    pub mode: ContextMode,
}

pub const GRANT_SCHEMA_VERSION: u32 = 1;

/// Quote length copied into the prompt. The rest is available through scoped evidence reads.
pub const PROMPT_QUOTE_CHARS: usize = 1_200;
