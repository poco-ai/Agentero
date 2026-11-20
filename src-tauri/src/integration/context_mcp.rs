//! Session-scoped `agentero-context` MCP.
//!
//! The desktop process re-executes itself with [`MCP_WORKER_ARG`] and a grant
//! file, then speaks MCP over stdio. The ACP agent spawns that process. It is
//! not the loopback Vault MCP: the grant is the only allow-list.

use agentero_core::features::context::{ContextSession, EvidenceQuery, MCP_WORKER_ARG};
use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerConfig};
use rmcp::{tool, tool_handler, tool_router, ServerHandler, ServiceExt};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Clone)]
struct ContextMcp {
    session: Arc<ContextSession>,
    #[allow(dead_code)]
    tool_router: rmcp::handler::server::router::tool::ToolRouter<Self>,
}

impl ContextMcp {
    fn new(session: Arc<ContextSession>) -> Self {
        Self {
            session,
            tool_router: Self::tool_router(),
        }
    }
}

fn tool_err(err: impl std::fmt::Display) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(err.to_string())])
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ContextSearchArgs {
    /// Words to match inside the sources authorized for this session.
    query: String,
    /// Optional subset of authorized vault-relative paths. Empty means the whole grant.
    #[serde(default)]
    scope: Vec<String>,
    /// Card count, default 5, maximum 8. Cards are short excerpts, not the paper.
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct EvidenceRefArgs {
    #[serde(default)]
    paper_path: Option<String>,
    #[serde(default)]
    file_path: Option<String>,
    /// 1-based PDF page.
    #[serde(default)]
    page: Option<u32>,
    #[serde(default)]
    section: Option<String>,
    #[serde(default)]
    region_id: Option<String>,
    /// Vault-relative citation such as `papers/foo/paper.pdf#page=3`.
    #[serde(default)]
    citation_uri: Option<String>,
    #[serde(default)]
    quote: Option<String>,
}

impl From<EvidenceRefArgs> for EvidenceQuery {
    fn from(args: EvidenceRefArgs) -> Self {
        Self {
            paper_path: args.paper_path,
            file_path: args.file_path,
            page: args.page,
            section: args.section,
            region_id: args.region_id,
            citation_uri: args.citation_uri,
            quote: args.quote,
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ContextReadArgs {
    /// Object form is preferred. A plain citation string is accepted as a
    /// compatibility shorthand because some ACP agents pass it that way.
    /// Optional when this turn's grant holds exactly one source.
    #[serde(default)]
    #[schemars(with = "EvidenceRefArgs")]
    evidence_ref: serde_json::Value,
    /// `metadata` (default), `excerpt`, `section`, `page`, `region`, or `full`.
    /// `full` is explicit and still capped. Do not start there.
    #[serde(default)]
    level: Option<String>,
}

impl ContextReadArgs {
    fn evidence_ref(&self) -> Result<EvidenceRefArgs, String> {
        if self.evidence_ref.is_null() {
            return Ok(EvidenceRefArgs::default());
        }
        if let Some(citation_uri) = self.evidence_ref.as_str() {
            return Ok(EvidenceRefArgs {
                citation_uri: Some(citation_uri.trim().to_string()),
                ..Default::default()
            });
        }
        serde_json::from_value(self.evidence_ref.clone()).map_err(|_| {
            "evidenceRef must be an object (paperPath, filePath, citationUri, page, section, or regionId) or a citation string"
                .to_string()
        })
    }
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ToolOut {
    evidence: Vec<EvidenceOut>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct EvidenceOut {
    provider: String,
    work_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    paper_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    file_path: Option<String>,
    locator: EvidenceLocatorOut,
    excerpt: String,
    revision: String,
    citation_uri: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct EvidenceLocatorOut {
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    page: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    section: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    region_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    line_from: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    line_to: Option<u32>,
}

fn tool_out(
    result: agentero_core::features::context::ContextToolResult,
) -> Result<Json<ToolOut>, String> {
    let value = serde_json::to_value(result).map_err(|error| error.to_string())?;
    serde_json::from_value(value)
        .map(Json)
        .map_err(|error| error.to_string())
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct PaperRelationsArgs {
    /// Paper id or vault-relative folder authorized for this session.
    paper_ref: String,
    /// `citations`, `cited_by`, or `related`. Omit for all three.
    #[serde(default)]
    direction: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
}

#[tool_router]
impl ContextMcp {
    #[tool(
        description = "Search the sources authorized for this session. Returns a few short evidence cards with citation URIs. Does not return paper text."
    )]
    async fn context_search(
        &self,
        Parameters(args): Parameters<ContextSearchArgs>,
    ) -> Result<Json<ToolOut>, CallToolResult> {
        let found = self
            .session
            .search(&args.query, &args.scope, args.limit)
            .map_err(tool_err)?;
        tool_out(found).map_err(tool_err)
    }

    #[tool(
        description = "Read one authorized source one level deeper. Default level is metadata (title, authors, abstract). Then excerpt, section, page, or region. full is explicit, capped, and not the default."
    )]
    async fn context_read(
        &self,
        Parameters(args): Parameters<ContextReadArgs>,
    ) -> Result<Json<ToolOut>, CallToolResult> {
        let evidence_ref = args.evidence_ref().map_err(tool_err)?;
        let read = self
            .session
            .read(&evidence_ref.into(), args.level.as_deref())
            .map_err(tool_err)?;
        tool_out(read).map_err(tool_err)
    }

    #[tool(
        description = "List citation, cited-by, or related papers for one authorized paper. Cards are thin. A related paper outside this grant cannot be read with context_read."
    )]
    async fn paper_relations(
        &self,
        Parameters(args): Parameters<PaperRelationsArgs>,
    ) -> Result<Json<ToolOut>, CallToolResult> {
        let related = self
            .session
            .relations(&args.paper_ref, args.direction.as_deref(), args.limit)
            .map_err(tool_err)?;
        tool_out(related).map_err(tool_err)
    }
}

#[tool_handler]
impl ServerHandler for ContextMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions(
                "agentero-context is a read-only, session-scoped research context server. \
                 It can only see the sources in this turn's grant. \
                 context_search returns short cards. context_read starts at metadata \
                 (title and abstract) and opens a section, page, or region only when needed. \
                 With exactly one source in this turn's grant, context_read may omit evidenceRef. \
                 Otherwise pass evidenceRef as an object with paperPath, filePath, or citationUri. \
                 paper_relations lists citation, cited-by, and related cards. \
                 Do not expect a full-text dump. Each card's citationUri jumps back to the source.",
            )
            .with_server_info(Implementation::new(
                "agentero-context",
                env!("CARGO_PKG_VERSION"),
            ))
    }
}

/// Exit into the stdio server when this process was spawned as `agentero-context`.
/// `None` means a normal application launch.
pub fn try_run_context_mcp() -> Option<i32> {
    let mut args = std::env::args();
    let _argv0 = args.next();
    if args.next().as_deref() != Some(MCP_WORKER_ARG) {
        return None;
    }
    let Some(grant) = args.next() else {
        eprintln!("agentero-context: missing grant path");
        return Some(2);
    };
    if args.next().is_some() {
        eprintln!("agentero-context: unexpected arguments");
        return Some(2);
    }
    match serve(PathBuf::from(grant)) {
        Ok(()) => Some(0),
        Err(error) => {
            eprintln!("agentero-context: {error}");
            Some(1)
        }
    }
}

fn serve(grant: PathBuf) -> Result<(), String> {
    let session = ContextSession::open(&grant).map_err(|error| error.to_string())?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("start context mcp runtime: {error}"))?;
    runtime.block_on(async move {
        let server = ContextMcp::new(Arc::new(session))
            .serve(rmcp::transport::stdio())
            .await
            .map_err(|error| format!("context mcp handshake: {error}"))?;
        server
            .waiting()
            .await
            .map_err(|error| format!("context mcp stopped: {error}"))?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::ContextReadArgs;

    #[test]
    fn evidence_ref_accepts_object_string_and_omission() {
        let object: ContextReadArgs = serde_json::from_str(
            r#"{"evidenceRef":{"paperPath":"papers/attention"},"level":"metadata"}"#,
        )
        .unwrap();
        assert_eq!(
            object.evidence_ref().unwrap().paper_path.as_deref(),
            Some("papers/attention")
        );

        let string: ContextReadArgs = serde_json::from_str(
            r#"{"evidenceRef":"papers/attention/paper.pdf#page=3","level":"page"}"#,
        )
        .unwrap();
        assert_eq!(
            string.evidence_ref().unwrap().citation_uri.as_deref(),
            Some("papers/attention/paper.pdf#page=3")
        );

        let omitted: ContextReadArgs = serde_json::from_str(r#"{"level":"metadata"}"#).unwrap();
        assert!(omitted.evidence_ref().unwrap().paper_path.is_none());
    }
}
