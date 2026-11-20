use super::{
    OpPermission, OpSideEffect, OpSpec, OpStability, OpSurface, CLI_INTERFACE_JSON,
    MCP_INTERFACE_JSON,
};
use serde_json::Value;

pub(super) fn build() -> Vec<OpSpec> {
    let cli: Vec<Value> = serde_json::from_str(CLI_INTERFACE_JSON).expect("invalid CLI descriptor");
    let mcp: Value = serde_json::from_str(MCP_INTERFACE_JSON).expect("invalid MCP descriptor");
    let tools = mcp["tools"].as_array().expect("missing MCP tools");
    cli.into_iter()
        .filter(|entry| entry["result"].is_string())
        .map(|entry| {
            let path = entry["path"].as_str().expect("missing CLI path");
            let tool = entry["tool"].as_str().map(|name| {
                tools
                    .iter()
                    .find(|t| t["name"] == name)
                    .expect("missing MCP tool")
            });
            let side_effects = match tool {
                Some(t) if t["annotations"]["readOnlyHint"] == true => OpSideEffect::Read,
                Some(t) if t["annotations"]["destructiveHint"] == true => OpSideEffect::Destructive,
                Some(_) => OpSideEffect::Write,
                None => match path {
                    "vault list" | "vault info" | "vault check" | "feed list"
                    | "feed item list" | "app views" | "delegate targets" | "delegate result"
                    | "sync status" | "mcp tools" | "help" => OpSideEffect::Read,
                    "file trash purge" | "feed remove" | "sync disconnect" => {
                        OpSideEffect::Destructive
                    }
                    _ => OpSideEffect::Write,
                },
            };
            let permission = match (tool, side_effects) {
                (None, _) => OpPermission::Unspecified,
                (_, OpSideEffect::Read) => OpPermission::VaultRead,
                _ if path.starts_with("paper note ") => OpPermission::VaultNotesWrite,
                _ if path == "paper update" || path.starts_with("paper tag ") => {
                    OpPermission::CatalogWrite
                }
                _ => OpPermission::VaultWrite,
            };
            let args = entry["args"].as_array().expect("missing arguments");
            OpSpec {
                id: path.replace(' ', "."),
                cli: Some(format!("agentero {path}")),
                mcp_tool: entry["tool"].as_str().map(str::to_owned),
                summary: entry["about"].as_str().unwrap_or_default().into(),
                side_effects,
                permission,
                stability: if tool.is_some() && side_effects != OpSideEffect::Destructive {
                    OpStability::Stable
                } else {
                    OpStability::Internal
                },
                since: "2".into(),
                surfaces: if tool.is_some() {
                    vec![OpSurface::Cli, OpSurface::Mcp]
                } else {
                    vec![OpSurface::Cli]
                },
                supports_dry_run: args.iter().any(|a| a["name"] == "dry-run"),
                requires_confirmation: args.iter().any(|a| a["name"] == "yes"),
                input: tool.map_or_else(|| entry["args"].clone(), |t| t["inputSchema"].clone()),
                output: tool.map_or_else(|| entry["result"].clone(), |t| t["outputSchema"].clone()),
                errors: Vec::new(),
                examples: entry["example"]
                    .as_str()
                    .map(str::to_owned)
                    .into_iter()
                    .collect(),
            }
        })
        .collect()
}
