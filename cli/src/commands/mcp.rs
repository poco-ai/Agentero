//! Discover the actual public tools or start their stdio/HTTP server.
use crate::{
    error::CliError,
    resolve::{named_vault, resolve_vault, GlobalOpts},
};
use agentero_mcp::{McpController, McpHost, Permissions};
use serde_json::{json, Value};
use std::{io::Read, path::Path, sync::Arc};

struct CliHost(Permissions);
impl McpHost for CliHost {
    fn permissions(&self) -> Permissions {
        self.0
    }
}

pub async fn run(op: &str, a: Value, g: &GlobalOpts) -> Result<Value, CliError> {
    let mut grants = Permissions::default();
    for grant in a["allow"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        match grant {
            "write" => grants.write = true,
            "online" => grants.online = true,
            "full-text" => grants.full_text = true,
            _ => return Err(CliError::usage("Unknown grant")),
        }
    }
    let mut allowed = Vec::new();
    for p in a["allow_vault"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        allowed.push(named_vault(Path::new(p))?.to_string_lossy().into_owned());
    }
    if op == "mcp tools" {
        if g.vault_flag.is_some() {
            resolve_vault(g)?;
        }
        return Ok(json!({"tools":agentero_mcp::tools_list(grants).tools}));
    }
    let vault = resolve_vault(g)?;
    let ctrl = Arc::new(McpController::new());
    ctrl.set_host(Arc::new(CliHost(grants)));
    ctrl.set_known_vaults(allowed);
    ctrl.set_vault(Some(vault.to_string_lossy().into_owned()));
    ctrl.set_translator_url(g.translator_base_url());
    let listen = a["listen"].as_str().unwrap_or("127.0.0.1:0");
    if a["transport"].as_str().unwrap_or("stdio") == "stdio" {
        if a.get("token_input").is_some() || a.get("listen").is_some() {
            return Err(CliError::usage("--token-input and --listen require HTTP"));
        }
        agentero_mcp::serve_stdio(ctrl).await?;
        return Ok(Value::Null);
    }
    let addr =
        agentero_mcp::parse_loopback_listen(listen).map_err(|e| CliError::usage(e.to_string()))?;
    let _private_token_file;
    let token = match a["token_input"].as_str() {
        Some("-") => {
            let mut s = String::new();
            std::io::stdin().read_to_string(&mut s)?;
            s.trim().to_owned()
        }
        Some(path) => std::fs::read_to_string(path)?.trim().to_owned(),
        None => {
            let (value, file) = agentero_mcp::ephemeral_token()?;
            _private_token_file = file;
            if !g.quiet {
                eprintln!(
                    "MCP bearer token file: {}",
                    _private_token_file.path().display()
                );
            }
            value
        }
    };
    if token.is_empty() {
        return Err(CliError::usage("Bearer token cannot be empty"));
    }
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let url = format!("http://{}/mcp", listener.local_addr()?);
    if !g.quiet {
        eprintln!("MCP listening on {url}")
    }
    agentero_mcp::serve_until_signal(ctrl, listener, token).await?;
    Ok(json!({"transport":"http","address":url}))
}
