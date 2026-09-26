//! Curated machine-facing operation catalog for agents (CLI `describe`, MCP).
//!
//! This is not a clap reflection dump: each entry is a stable contract agents
//! can introspect without stuffing docs into the prompt.

mod catalog;
mod invariants;

use serde::Serialize;
use serde_json::Value;
use std::sync::OnceLock;

pub use invariants::agent_invariants_markdown;

/// Side-effect class for an operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OpSideEffect {
    None,
    Read,
    Write,
    Destructive,
}

/// Surfaces that expose this operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OpSurface {
    Cli,
    Mcp,
}

/// Full operation spec returned by `describe <id>`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpSpec {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cli: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_tool: Option<String>,
    pub summary: String,
    pub side_effects: OpSideEffect,
    pub surfaces: Vec<OpSurface>,
    pub supports_dry_run: bool,
    pub requires_confirmation: bool,
    pub input: Value,
    pub output: Value,
    pub errors: Vec<String>,
    pub examples: Vec<String>,
}

/// Compact row for `describe` with no argument.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpSummary {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cli: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_tool: Option<String>,
    pub summary: String,
    pub side_effects: OpSideEffect,
    pub surfaces: Vec<OpSurface>,
    pub supports_dry_run: bool,
    pub requires_confirmation: bool,
}

impl From<&OpSpec> for OpSummary {
    fn from(op: &OpSpec) -> Self {
        Self {
            id: op.id.clone(),
            cli: op.cli.clone(),
            mcp_tool: op.mcp_tool.clone(),
            summary: op.summary.clone(),
            side_effects: op.side_effects,
            surfaces: op.surfaces.clone(),
            supports_dry_run: op.supports_dry_run,
            requires_confirmation: op.requires_confirmation,
        }
    }
}

fn catalog() -> &'static [OpSpec] {
    static OPS: OnceLock<Vec<OpSpec>> = OnceLock::new();
    OPS.get_or_init(catalog::build).as_slice()
}

/// All curated operations (stable order).
pub fn all() -> &'static [OpSpec] {
    catalog()
}

/// Lookup by exact id (`paper.list`) or mcp tool name (`paper_list`).
pub fn get(id: &str) -> Option<&'static OpSpec> {
    let id = id.trim();
    if id.is_empty() {
        return None;
    }
    catalog().iter().find(|op| {
        op.id == id || op.mcp_tool.as_deref() == Some(id) || op.cli.as_deref() == Some(id)
    })
}

/// Compact list for index describe.
pub fn summaries() -> Vec<OpSummary> {
    catalog().iter().map(OpSummary::from).collect()
}

/// Suggest nearby ids when lookup fails (prefix / substring).
pub fn suggest(id: &str) -> Vec<&'static str> {
    let needle = id.trim().to_ascii_lowercase();
    if needle.is_empty() {
        return Vec::new();
    }
    let mut hits: Vec<&'static str> = catalog()
        .iter()
        .filter(|op| {
            op.id.to_ascii_lowercase().contains(&needle)
                || op
                    .mcp_tool
                    .as_ref()
                    .is_some_and(|t| t.to_ascii_lowercase().contains(&needle))
        })
        .map(|op| op.id.as_str())
        .collect();
    hits.sort_unstable();
    hits.dedup();
    hits.truncate(8);
    hits
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_has_core_ops() {
        assert!(get("paper.list").is_some());
        assert!(get("paper_list").is_some()); // mcp alias
        assert!(get("layout.list").is_some());
        assert!(get("paper.set_read").is_some());
        assert!(get("file_read").is_some());
        assert!(get("file.write").is_some());
        assert!(get("import.pdf").is_some());
        assert!(get("no.such.op").is_none());
    }

    #[test]
    fn invariants_nonempty() {
        let md = agent_invariants_markdown();
        assert!(md.contains("Progressive disclosure"));
        assert!(md.contains("agentero://vault"));
    }

    #[test]
    fn suggest_finds_prefix() {
        let s = suggest("paper.");
        assert!(s.contains(&"paper.list"));
    }
}
