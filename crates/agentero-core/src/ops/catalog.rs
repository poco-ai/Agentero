use super::{OpSpec, OpSurface, CLI_INTERFACE_JSON, MCP_INTERFACE_JSON};
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
            let args = entry["args"].as_array().expect("missing arguments");
            OpSpec {
                id: path.replace(' ', "."),
                cli: Some(format!("agentero {path}")),
                mcp_tool: entry["tool"].as_str().map(str::to_owned),
                summary: entry["about"].as_str().unwrap_or_default().into(),
                side_effects: serde_json::from_value(entry["sideEffects"].clone())
                    .expect("missing operation effect"),
                permission: serde_json::from_value(entry["permission"].clone())
                    .expect("missing operation permission"),
                stability: serde_json::from_value(entry["stability"].clone())
                    .expect("missing operation stability"),
                requires_online: entry["online"].as_bool().unwrap_or(false),
                surfaces: if tool.is_some() {
                    vec![OpSurface::Cli, OpSurface::Mcp]
                } else {
                    vec![OpSurface::Cli]
                },
                supports_dry_run: args.iter().any(|a| a["name"] == "dry-run"),
                requires_confirmation: args.iter().any(|a| a["name"] == "yes"),
                input: tool.map_or_else(|| entry["args"].clone(), |t| t["inputSchema"].clone()),
                output: tool.map_or_else(|| entry["result"].clone(), |t| t["outputSchema"].clone()),
                examples: entry["example"]
                    .as_str()
                    .map(str::to_owned)
                    .into_iter()
                    .collect(),
            }
        })
        .collect()
}
