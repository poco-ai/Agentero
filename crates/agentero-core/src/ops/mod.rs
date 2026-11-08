//! Curated machine-facing operation catalog for agents (CLI `describe`, MCP).
//!
//! This is not a clap reflection dump: each entry is a stable contract agents
//! can introspect without stuffing docs into the prompt.
//!
//! `stability`, `permission`, and `since` on [`OpSpec`] are the v0 plugin
//! data-API contract. There is no plugin host here. Public lifecycle names
//! are [`public_events`].

mod catalog;
mod classify;
mod events;
mod invariants;

use serde::Serialize;
use serde_json::Value;
use std::sync::OnceLock;

pub use events::{public_events, PublicEventSpec};
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

/// Plugin-contract stability. Only `stable` ids are public.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OpStability {
    Internal,
    Experimental,
    Stable,
}

/// Data permission for a public operation.
///
/// Colon forms are the wire values. `vault:notes:write` is only `NOTES.md`,
/// separate from `vault:write` (`file.write` / `paper.move`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OpPermission {
    Unspecified,
    #[serde(rename = "vault:read")]
    VaultRead,
    #[serde(rename = "vault:notes:write")]
    VaultNotesWrite,
    #[serde(rename = "catalog:write")]
    CatalogWrite,
    #[serde(rename = "vault:write")]
    VaultWrite,
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
    /// `internal` | `experimental` | `stable`.
    pub stability: OpStability,
    /// `unspecified` | `vault:read` | `vault:notes:write` | `catalog:write` | `vault:write`.
    pub permission: OpPermission,
    /// Contract generation: `"1"` for stable/experimental, `"0"` for internal.
    pub since: String,
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
    fn vault_search_contract_is_read_only_and_mcp_only() {
        let op = get("vault_search").expect("vault.search catalog entry");
        assert_eq!(op.id, "vault.search");
        assert_eq!(op.side_effects, OpSideEffect::Read);
        assert!(!op.requires_confirmation);
        assert!(op.cli.is_none());
        assert_eq!(op.surfaces.len(), 1);
        assert!(matches!(op.surfaces[0], OpSurface::Mcp));
        assert!(op.input.get("query").is_some());
        assert!(op.output.get("truncated").is_some());
    }

    #[test]
    fn discover_documents_both_keyword_match_spellings() {
        let op = get("discover.arxiv").expect("discover.arxiv catalog entry");
        assert!(
            op.input.get("match?").is_some(),
            "CLI --match missing from describe: {:?}",
            op.input
        );
        assert!(
            op.input.get("keywordMatch?").is_some(),
            "MCP keywordMatch missing from describe: {:?}",
            op.input
        );
    }

    #[test]
    fn catalog_has_core_ops() {
        assert!(get("paper.list").is_some());
        assert!(get("paper_list").is_some()); // mcp alias
        assert!(get("layout.list").is_some());
        assert!(get("paper.set_read").is_some());
        assert!(get("file_read").is_some());
        assert!(get("table.query").is_some());
        assert!(get("table_query").is_some());
        assert!(get("table.upsert").is_some());
        assert!(get("table.update_cells").is_some());
        assert!(get("table_update_cells").is_some());
        let table_query = get("table.query").unwrap();
        assert_eq!(table_query.side_effects, OpSideEffect::Read);
        assert!(!table_query.requires_confirmation);
        let table_upsert = get("table.upsert").unwrap();
        assert_eq!(table_upsert.side_effects, OpSideEffect::Write);
        assert!(table_upsert.requires_confirmation);
        assert_eq!(
            get("table.update_cells").unwrap().side_effects,
            OpSideEffect::Write
        );
        assert!(get("table.update_cells").unwrap().requires_confirmation);
        assert!(get("page.read").is_some());
        assert!(get("page_read").is_some());
        assert!(get("file.write").is_some());
        assert!(get("file_move").is_some());
        assert!(get("file_delete").is_some());
        assert!(get("paper_move").is_some());
        assert!(get("paper_paths").is_some());
        assert!(get("paper_tag_set").is_some());
        assert!(get("paper_tag_list").is_some());
        assert!(get("paper.notes.fetch").is_some());
        assert!(get("vault_list").is_some());
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

    #[test]
    fn every_catalog_id_is_classified_exactly_once() {
        use std::collections::BTreeMap;

        let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
        for class in classify::classifications() {
            *counts.entry(class.id).or_insert(0) += 1;
        }
        let mut missing = Vec::new();
        let mut duplicated = Vec::new();
        for op in all() {
            match counts.get(op.id.as_str()).copied().unwrap_or(0) {
                0 => missing.push(op.id.as_str()),
                1 => {}
                n => duplicated.push((op.id.as_str(), n)),
            }
        }
        let extras: Vec<_> = counts
            .keys()
            .copied()
            .filter(|id| all().iter().all(|op| op.id != *id))
            .collect();
        assert!(
            missing.is_empty() && duplicated.is_empty() && extras.is_empty(),
            "missing={missing:?} duplicated={duplicated:?} extras={extras:?}"
        );
        for op in all() {
            let class = classify::classifications()
                .iter()
                .find(|c| c.id == op.id)
                .unwrap();
            assert_eq!(op.stability, class.stability, "{}", op.id);
            assert_eq!(op.permission, class.permission, "{}", op.id);
            assert_eq!(op.since, class.since, "{}", op.id);
            match op.stability {
                OpStability::Internal => assert_eq!(op.since, "0", "{}", op.id),
                OpStability::Experimental | OpStability::Stable => {
                    assert_eq!(op.since, "1", "{}", op.id)
                }
            }
        }
    }

    #[test]
    fn stable_set_is_the_v0_allowlist() {
        const READ: &[&str] = &[
            "vault.list",
            "vault.search",
            "paper.list",
            "paper.get",
            "paper.paths",
            "paper.notes.get",
            "paper.tag.list",
            "file.list",
            "file.read",
            "layout.list",
            "layout.get",
            "page.read",
        ];
        const CATALOG_WRITE: &[&str] = &[
            "paper.set_meta",
            "paper.set_read",
            "paper.tag.add",
            "paper.tag.rm",
            "paper.tag.set",
        ];
        const NOTES_WRITE: &[&str] = &["paper.notes.write"];
        const VAULT_WRITE: &[&str] = &["file.write", "paper.move"];

        let mut expected: Vec<&str> = Vec::new();
        expected.extend_from_slice(READ);
        expected.extend_from_slice(CATALOG_WRITE);
        expected.extend_from_slice(NOTES_WRITE);
        expected.extend_from_slice(VAULT_WRITE);
        expected.sort_unstable();

        let mut actual: Vec<&str> = all()
            .iter()
            .filter(|op| op.stability == OpStability::Stable)
            .map(|op| op.id.as_str())
            .collect();
        actual.sort_unstable();
        assert_eq!(actual, expected);

        for id in READ {
            let op = get(id).unwrap_or_else(|| panic!("missing {id}"));
            assert_eq!(op.stability, OpStability::Stable, "{id}");
            assert_eq!(op.side_effects, OpSideEffect::Read, "{id}");
            assert_eq!(op.permission, OpPermission::VaultRead, "{id}");
        }
        for id in CATALOG_WRITE {
            let op = get(id).unwrap();
            assert_eq!(op.stability, OpStability::Stable, "{id}");
            assert_eq!(op.side_effects, OpSideEffect::Write, "{id}");
            assert_eq!(op.permission, OpPermission::CatalogWrite, "{id}");
        }
        let notes = get("paper.notes.write").unwrap();
        assert_eq!(notes.stability, OpStability::Stable);
        assert_eq!(notes.permission, OpPermission::VaultNotesWrite);
        assert_eq!(notes.side_effects, OpSideEffect::Write);

        for id in VAULT_WRITE {
            let op = get(id).unwrap();
            assert_eq!(op.stability, OpStability::Stable, "{id}");
            assert_eq!(op.side_effects, OpSideEffect::Write, "{id}");
            assert_eq!(op.permission, OpPermission::VaultWrite, "{id}");
        }
    }

    #[test]
    fn destructive_and_reserved_ops_are_not_stable() {
        for op in all() {
            if op.side_effects == OpSideEffect::Destructive
                || op.id == "file.delete"
                || op.id == "paper.delete"
            {
                assert_ne!(op.stability, OpStability::Stable, "{}", op.id);
            }
        }
        for id in [
            "paper.download",
            "paper.parse",
            "discover.arxiv",
            "doctor.wiki",
            "export.bib",
            "paper.open",
            "file.delete",
            "paper.delete",
        ] {
            let op = get(id).unwrap_or_else(|| panic!("missing {id}"));
            assert_ne!(op.stability, OpStability::Stable, "{id}");
        }
        for prefix in ["import.", "mark.", "ui."] {
            let matched: Vec<_> = all()
                .iter()
                .filter(|op| op.id.starts_with(prefix))
                .collect();
            assert!(!matched.is_empty(), "no ops with prefix {prefix}");
            for op in matched {
                assert_ne!(op.stability, OpStability::Stable, "{}", op.id);
            }
        }
    }

    #[test]
    fn stable_ops_have_a_surface_and_since_one() {
        for op in all()
            .iter()
            .filter(|op| op.stability == OpStability::Stable)
        {
            let has_mcp = op.mcp_tool.as_ref().is_some_and(|s| !s.is_empty());
            let has_cli = op.cli.as_ref().is_some_and(|s| !s.is_empty());
            assert!(has_mcp || has_cli, "{}", op.id);
            assert!(!op.surfaces.is_empty(), "{}", op.id);
            if op.surfaces.contains(&OpSurface::Mcp) {
                assert!(has_mcp, "{}", op.id);
            }
            if op.surfaces.contains(&OpSurface::Cli) {
                assert!(has_cli, "{}", op.id);
            }
            assert_eq!(op.since, "1", "{}", op.id);
        }
    }

    #[test]
    fn get_still_resolves_id_mcp_and_cli_aliases() {
        assert_eq!(get("paper.list").unwrap().id, "paper.list");
        assert_eq!(get("paper_list").unwrap().id, "paper.list");
        assert_eq!(get("agentero paper list").unwrap().id, "paper.list");
        assert_eq!(get("file_read").unwrap().id, "file.read");
        assert_eq!(get("paper_move").unwrap().id, "paper.move");
        assert!(get("no.such.op").is_none());
    }

    #[test]
    fn contract_fields_serialize_as_wire_strings() {
        let stable = serde_json::to_value(get("paper.notes.write").unwrap()).unwrap();
        assert_eq!(stable["stability"], "stable");
        assert_eq!(stable["permission"], "vault:notes:write");
        assert_eq!(stable["since"], "1");
        assert_eq!(stable["sideEffects"], "write");

        let internal = serde_json::to_value(get("file.delete").unwrap()).unwrap();
        assert_eq!(internal["stability"], "internal");
        assert_eq!(internal["permission"], "unspecified");
        assert_eq!(internal["since"], "0");
        assert_eq!(internal["sideEffects"], "destructive");

        assert_eq!(
            serde_json::to_value(OpPermission::VaultRead).unwrap(),
            "vault:read"
        );
        assert_eq!(
            serde_json::to_value(OpPermission::CatalogWrite).unwrap(),
            "catalog:write"
        );
        assert_eq!(
            serde_json::to_value(OpPermission::VaultWrite).unwrap(),
            "vault:write"
        );
    }

    #[test]
    fn public_events_are_exactly_the_five_v0_names() {
        let events = public_events();
        let names: Vec<&str> = events.iter().map(|e| e.name).collect();
        assert_eq!(
            names,
            [
                "vault:opened",
                "paper:imported",
                "paper:assets-ready",
                "paper:renamed",
                "paper:opened",
            ]
        );
        let mut unique = names.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), names.len());
        for event in events {
            assert!(!event.payload_fields.is_empty(), "{}", event.name);
            for field in event.payload_fields {
                assert!(!field.is_empty(), "{}", event.name);
            }
        }
        for banned in [
            "window:closed",
            "job:completed",
            "job:failed",
            "agent:registry-changed",
            "app:ready",
        ] {
            assert!(!names.contains(&banned), "{banned}");
        }
        let renamed = events.iter().find(|e| e.name == "paper:renamed").unwrap();
        assert_eq!(
            renamed.payload_fields,
            [
                "vaultId",
                "oldPaperId",
                "newPaperId",
                "oldPath",
                "newPath",
                "outcome",
            ]
        );
    }
}
