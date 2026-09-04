use serde::{Deserialize, Serialize};

/// Byte range of the target portion of an internal-link token in its source file.
/// It deliberately excludes aliases, fragments and Markdown labels so a rename can
/// replace only the target while preserving the user's surrounding text.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceRange {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum InternalLinkSyntax {
    Wikilink,
    Markdown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LinkFragment {
    Heading {
        path: Vec<String>,
    },
    Block {
        id: String,
    },
    /// PDF mark/annotation id (`[[paper@id]]` / `[[paper#@id]]`).
    Annotation {
        id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LinkResolutionStatus {
    Resolved,
    Missing,
    Ambiguous,
    InvalidFragment,
}

/// A parsed explicit Vault-local link. Markdown remains the source of truth; this
/// is only an in-memory, rebuildable occurrence projection.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InternalLinkOccurrence {
    pub source: String,
    pub target_raw: String,
    pub syntax: InternalLinkSyntax,
    pub embed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fragment: Option<LinkFragment>,
    pub source_range: SourceRange,
    /// Byte range of the fragment text after `#`, excluding the separator,
    /// display alias/label, and closing syntax. Heading rename transactions use
    /// this range instead of reconstructing source syntax.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fragment_range: Option<SourceRange>,
    pub line: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
}

/// Document-local anchors and aliases used by the resolver.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WikiDocument {
    pub path: String,
    pub aliases: Vec<String>,
    pub headings: Vec<HeadingAnchor>,
    pub blocks: Vec<BlockAnchor>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HeadingAnchor {
    pub text: String,
    pub path: Vec<String>,
    #[serde(default)]
    pub level: u8,
    pub line: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BlockAnchor {
    pub id: String,
    #[serde(default)]
    pub preview: String,
    pub line: u32,
}

/// A parsed occurrence enriched with one deterministic resolution result.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLink {
    pub occurrence: InternalLinkOccurrence,
    pub status: LinkResolutionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_path: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub candidates: Vec<String>,
}

/// Compatibility/public graph edge. It preserves occurrence semantics so callers
/// that need navigation or a later rewrite never have to reconstruct it from the
/// file-level graph projection.
pub type WikiLinkEdge = ResolvedLink;

/// One incoming occurrence for a selected target file.
pub type Backlink = ResolvedLink;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklinksResponse {
    pub path: String,
    pub backlinks: Vec<Backlink>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingLinksResponse {
    pub path: String,
    pub outgoing: Vec<ResolvedLink>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WikiCheckCounts {
    pub resolved: u32,
    pub missing: u32,
    pub ambiguous: u32,
    pub invalid_fragment: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WikiCheckIssue {
    pub status: LinkResolutionStatus,
    pub source: String,
    pub line: u32,
    pub target_raw: String,
    pub syntax: InternalLinkSyntax,
    pub embed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_path: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub candidates: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
}

/// Read-only semantic validation of explicit Vault-local links.
///
/// `scope` is a normalized Vault-relative Markdown file or directory. `None`
/// means the complete Vault. Only non-resolved occurrences appear in `issues`;
/// `counts` still includes resolved links for an auditable total.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WikiCheckResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    pub checked_files: u32,
    pub counts: WikiCheckCounts,
    pub issues: Vec<WikiCheckIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiResolveResponse {
    pub link: ResolvedLink,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WikiEmbedContentKind {
    Markdown,
    Image,
    Pdf,
    /// PDF highlight / visual-trace reference; content filled by frontend marks IO.
    Annotation,
    Unsupported,
}

/// Read-only source projection for one resolved `![[...]]` reference.
///
/// `link` always carries the canonical resolution status. Content is present
/// only when that status is resolved and the target kind is supported.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WikiEmbedResponse {
    pub link: ResolvedLink,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_kind: Option<WikiEmbedContentKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WikiSearchCandidateKind {
    File,
    Heading,
    Block,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WikiSearchCandidate {
    pub kind: WikiSearchCandidateKind,
    pub path: String,
    pub insert_text: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// A human-facing alias selected by the user. The editor writes this as a
    /// display alias while preserving `insert_text` as the canonical target.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fragment: Option<LinkFragment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebuildResult {
    pub indexed_files: u32,
    pub edges: u32,
    pub nodes: u32,
}

/// Why an internal-link rename transaction could not safely proceed.
///
/// These codes are deliberately independent from filesystem error text so UI
/// callers can present a recoverable action without trying to parse messages.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WikiRenameErrorCode {
    InvalidPath,
    SourceMissing,
    TargetExists,
    TargetInsideSource,
    IndexStale,
    SourceChanged,
    UnsavedEdits,
    PermissionDenied,
    AtomicRenameUnsupported,
    HeadingMissing,
    InvalidHeading,
    AmbiguousHeading,
    OverlappingEdits,
    MoveFailed,
    WriteFailed,
    CommitFailed,
}

/// How far a failed transaction was restored.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WikiRenameRollback {
    NotNeeded,
    Completed,
    ManualRecoveryRequired,
}

/// A source skipped by the rename planner because it was not safe to rewrite.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WikiRenameSkipped {
    pub path: String,
    pub reason: String,
}

/// Observable outcome of a successful link-aware file or directory move.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WikiRenameResult {
    pub moved_path: String,
    pub updated_sources: Vec<String>,
    pub skipped: Vec<WikiRenameSkipped>,
    pub rollback: WikiRenameRollback,
}

/// Observable outcome of a successful explicit heading rename.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WikiRenameHeadingResult {
    pub path: String,
    pub old_path: Vec<String>,
    pub new_path: Vec<String>,
    pub updated_sources: Vec<String>,
    pub rollback: WikiRenameRollback,
}

/// A verified external filesystem rename that is safe to present for explicit
/// approval. The opaque ID keeps the pre-rename semantic snapshot in the Host
/// until the renderer either applies or discards the repair.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WikiExternalRenamePreview {
    pub candidate_id: String,
    pub from: String,
    pub to: String,
    pub affected_sources: Vec<String>,
    pub skipped: Vec<WikiRenameSkipped>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backlinks_serialize_occurrences_as_nested_api_objects() {
        let response = BacklinksResponse {
            path: "notes/Target.md".to_string(),
            backlinks: vec![ResolvedLink {
                occurrence: InternalLinkOccurrence {
                    source: "notes/Source.md".to_string(),
                    target_raw: "notes/Target".to_string(),
                    syntax: InternalLinkSyntax::Wikilink,
                    embed: false,
                    display_text: None,
                    fragment: None,
                    source_range: SourceRange { start: 4, end: 16 },
                    fragment_range: None,
                    line: 1,
                    context: Some("[[notes/Target]]".to_string()),
                },
                status: LinkResolutionStatus::Resolved,
                target_path: Some("notes/Target.md".to_string()),
                candidates: Vec::new(),
            }],
        };

        let value = serde_json::to_value(response).expect("backlinks serialize");
        let link = &value["backlinks"][0];
        assert_eq!(link["occurrence"]["source"], "notes/Source.md");
        assert_eq!(link["occurrence"]["targetRaw"], "notes/Target");
        assert!(link.get("source").is_none());
    }
}
