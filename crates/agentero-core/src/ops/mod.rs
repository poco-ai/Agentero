//! Public research operations, derived from the same manifests as CLI help and MCP discovery.
mod catalog;
mod events;
pub mod execute;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::OnceLock;

pub const CLI_INTERFACE_JSON: &str = include_str!("cli.json");
pub const MCP_INTERFACE_JSON: &str = include_str!("mcp.json");

pub use events::{public_events, PublicEventSpec};

/// Side-effect class for an operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OpSideEffect {
    Read,
    Write,
    Destructive,
}

/// Surfaces that expose this operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OpSurface {
    Cli,
    Mcp,
}

/// Plugin-contract stability. Only `stable` ids are public.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OpPermission {
    None,
    Desktop,
    Sync,
    #[serde(rename = "vault:read")]
    VaultRead,
    #[serde(rename = "vault:notes:write")]
    VaultNotesWrite,
    #[serde(rename = "catalog:write")]
    CatalogWrite,
    #[serde(rename = "vault:write")]
    VaultWrite,
}

/// Operation metadata shared by the terminal and protocol adapters.
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
    pub permission: OpPermission,
    pub requires_online: bool,
    pub surfaces: Vec<OpSurface>,
    pub supports_dry_run: bool,
    pub requires_confirmation: bool,
    pub input: Value,
    pub output: Value,
    pub examples: Vec<String>,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_matches_shipped_interfaces() {
        let cli: Value = serde_json::from_str(CLI_INTERFACE_JSON).unwrap();
        let mcp: Value = serde_json::from_str(MCP_INTERFACE_JSON).unwrap();
        let tools = mcp["tools"].as_array().unwrap();
        let commands = cli
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| entry["result"].is_string())
            .count();
        assert_eq!(all().len(), commands);
        assert_eq!(
            all().iter().filter(|op| op.mcp_tool.is_some()).count(),
            tools.len()
        );
        for t in tools {
            let op = get(t["name"].as_str().unwrap()).unwrap();
            assert!(op.cli.is_some());
            assert_eq!(op.input, t["inputSchema"]);
            assert_eq!(op.output, t["outputSchema"]);
            assert_eq!(
                op.side_effects == OpSideEffect::Read,
                t["annotations"]["readOnlyHint"]
            );
        }
        assert_eq!(
            get("paper_note_append").unwrap().permission,
            OpPermission::VaultNotesWrite
        );
        assert_eq!(
            get("paper_update").unwrap().permission,
            OpPermission::CatalogWrite
        );
        assert_eq!(
            get("file_remove").unwrap().side_effects,
            OpSideEffect::Destructive
        );
        assert_eq!(
            get("evidence_read").unwrap().permission,
            OpPermission::VaultRead
        );
    }

    #[test]
    fn contract_fields_serialize_as_wire_strings() {
        let stable = serde_json::to_value(get("paper.note.append").unwrap()).unwrap();
        assert_eq!(stable["stability"], "stable");
        assert_eq!(stable["permission"], "vault:notes:write");
        assert!(!get("paper.note.append").unwrap().requires_online);
        assert_eq!(stable["sideEffects"], "write");

        let internal = serde_json::to_value(get("file.trash.purge").unwrap()).unwrap();
        assert_eq!(internal["stability"], "internal");
        assert_eq!(internal["permission"], "vault:write");
        assert!(get("paper_import").unwrap().requires_online);
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
