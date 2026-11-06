//! Session-scoped `agentero-delegate` MCP.
//!
//! The local CLI agent spawns this process. It only forwards tool calls to the
//! desktop Unix socket named in the grant file. It cannot see remote sessions.

use crate::features::agent::delegate::protocol::WORKER_ARG;

#[cfg(unix)]
use crate::features::agent::delegate::protocol::{
    DelegateArgs, DelegateGrant, RunBody, RunIdArgs, TargetsBody, WireRequest, WireResponse,
};
#[cfg(unix)]
use rmcp::handler::server::wrapper::{Json, Parameters};
#[cfg(unix)]
use rmcp::model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerInfo};
#[cfg(unix)]
use rmcp::{tool, tool_handler, tool_router, ServerHandler, ServiceExt};
#[cfg(unix)]
use std::path::PathBuf;
#[cfg(unix)]
use std::sync::Arc;

#[cfg(unix)]
#[derive(Clone)]
struct DelegateMcp {
    grant: Arc<DelegateGrant>,
    #[allow(dead_code)]
    tool_router: rmcp::handler::server::router::tool::ToolRouter<Self>,
}

#[cfg(unix)]
impl DelegateMcp {
    fn new(grant: DelegateGrant) -> Self {
        Self {
            grant: Arc::new(grant),
            tool_router: Self::tool_router(),
        }
    }
}

#[cfg(unix)]
fn tool_err(err: impl std::fmt::Display) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(err.to_string())])
}

#[cfg(unix)]
#[tool_router]
impl DelegateMcp {
    #[tool(
        description = "List remote vaults that are already connected, and the registered agents that can run there. Do not invent a shell command."
    )]
    async fn remote_targets(&self) -> Result<Json<TargetsBody>, CallToolResult> {
        let value = call(&self.grant, "targets", serde_json::json!({}))
            .await
            .map_err(tool_err)?;
        serde_json::from_value(value).map(Json).map_err(tool_err)
    }

    #[tool(
        description = "Ask a registered agent on an already connected remote vault to do a task. There is no shell command and no auto-approve switch. The host waits, then returns the run id, status, and text. On timeout the remote agent keeps running."
    )]
    async fn remote_delegate(
        &self,
        Parameters(args): Parameters<DelegateArgs>,
    ) -> Result<Json<RunBody>, CallToolResult> {
        let value = call(
            &self.grant,
            "delegate",
            serde_json::json!({
                "target": args.target,
                "agentId": args.agent_id,
                "prompt": args.prompt,
                "waitMs": args.wait_ms,
            }),
        )
        .await
        .map_err(tool_err)?;
        serde_json::from_value(value).map(Json).map_err(tool_err)
    }

    #[tool(description = "Read the status and text of a remote_delegate run.")]
    async fn remote_delegate_result(
        &self,
        Parameters(args): Parameters<RunIdArgs>,
    ) -> Result<Json<RunBody>, CallToolResult> {
        let value = call(
            &self.grant,
            "result",
            serde_json::json!({ "runId": args.run_id }),
        )
        .await
        .map_err(tool_err)?;
        serde_json::from_value(value).map(Json).map_err(tool_err)
    }

    #[tool(description = "Cancel a remote_delegate run and stop that remote turn.")]
    async fn remote_delegate_cancel(
        &self,
        Parameters(args): Parameters<RunIdArgs>,
    ) -> Result<Json<RunBody>, CallToolResult> {
        let value = call(
            &self.grant,
            "cancel",
            serde_json::json!({ "runId": args.run_id }),
        )
        .await
        .map_err(tool_err)?;
        serde_json::from_value(value).map(Json).map_err(tool_err)
    }
}

#[cfg(unix)]
#[tool_handler]
impl ServerHandler for DelegateMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions(
                "agentero-delegate runs a task on a remote vault that is already connected. \
                 Call remote_targets first. remote_delegate takes a target, an agent id, and a task. \
                 It cannot run an arbitrary shell command or change the permission policy. \
                 Use remote_delegate_result if the run is still going, and remote_delegate_cancel to stop it.",
            )
            .with_server_info(Implementation::new(
                "agentero-delegate",
                env!("CARGO_PKG_VERSION"),
            ))
    }
}

/// Exit into the stdio server when this process was spawned as `agentero-delegate`.
/// `None` means a normal application launch.
pub fn try_run_delegate_mcp() -> Option<i32> {
    let mut args = std::env::args();
    let _argv0 = args.next();
    if args.next().as_deref() != Some(WORKER_ARG) {
        return None;
    }
    let Some(grant) = args.next() else {
        eprintln!("agentero-delegate: missing grant path");
        return Some(2);
    };
    if args.next().is_some() {
        eprintln!("agentero-delegate: unexpected arguments");
        return Some(2);
    }
    #[cfg(not(unix))]
    {
        let _ = grant;
        eprintln!("agentero-delegate: unavailable");
        Some(2)
    }
    #[cfg(unix)]
    match serve(PathBuf::from(grant)) {
        Ok(()) => Some(0),
        Err(error) => {
            eprintln!("agentero-delegate: {error}");
            Some(1)
        }
    }
}

#[cfg(unix)]
fn serve(grant_path: PathBuf) -> Result<(), String> {
    let bytes = std::fs::read(&grant_path).map_err(|error| error.to_string())?;
    let grant: DelegateGrant = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("start delegate mcp runtime: {error}"))?;
    runtime.block_on(async move {
        let server = DelegateMcp::new(grant)
            .serve(rmcp::transport::stdio())
            .await
            .map_err(|error| format!("delegate mcp handshake: {error}"))?;
        server
            .waiting()
            .await
            .map_err(|error| format!("delegate mcp stopped: {error}"))?;
        Ok(())
    })
}

#[cfg(unix)]
async fn call(
    grant: &DelegateGrant,
    op: &str,
    extra: serde_json::Value,
) -> Result<serde_json::Value, String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixStream;

    let mut request = serde_json::json!({
        "token": grant.token,
        "id": uuid::Uuid::new_v4().to_string(),
        "op": op,
    });
    if let (Some(target), Some(extra)) = (request.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            target.insert(key.clone(), value.clone());
        }
    }
    let request: WireRequest =
        serde_json::from_value(request).map_err(|error| error.to_string())?;
    let mut stream = UnixStream::connect(&grant.socket)
        .await
        .map_err(|error| format!("delegate socket: {error}"))?;
    let mut bytes = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    stream
        .write_all(&bytes)
        .await
        .map_err(|error| error.to_string())?;
    let mut lines = BufReader::new(stream);
    let mut buf = Vec::new();
    lines
        .read_until(b'\n', &mut buf)
        .await
        .map_err(|error| error.to_string())?;
    if buf.is_empty() {
        return Err("delegate socket closed".into());
    }
    let response: WireResponse =
        serde_json::from_slice(trim_line(&buf)).map_err(|error| error.to_string())?;
    if response.ok {
        Ok(response.result.unwrap_or(serde_json::Value::Null))
    } else {
        Err(response
            .error
            .unwrap_or_else(|| "delegate call failed".into()))
    }
}

#[cfg(unix)]
fn trim_line(buf: &[u8]) -> &[u8] {
    let end = buf
        .iter()
        .rposition(|byte| !byte.is_ascii_whitespace())
        .map(|index| index + 1)
        .unwrap_or(0);
    &buf[..end]
}
