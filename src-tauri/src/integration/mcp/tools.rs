//! MCP tools + ServerHandler.

use super::icons;
use super::notes::{self, WriteMode};
use super::paper;
use super::resources::{self, VAULT_NAME, VAULT_URI};
use super::McpController;
use crate::core::error::AppError;
use crate::features::catalog::{self, papers};
use crate::features::import::{self, LookupImportArgs, NoteShellMode};
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::model::{
    CallToolResult, ContentBlock, Implementation, ListResourcesResult, PaginatedRequestParams,
    ReadResourceRequestParams, ReadResourceResponse, ReadResourceResult, Resource,
    ResourceContents, ServerCapabilities, ServerInfo,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::{tool, tool_handler, tool_router, ErrorData as McpError, ServerHandler};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::Manager;

#[derive(Clone)]
pub struct AgenteroMcp {
    pub ctrl: Arc<McpController>,
    #[allow(dead_code)]
    tool_router: ToolRouter<Self>,
}

impl AgenteroMcp {
    pub fn new(ctrl: Arc<McpController>) -> Self {
        Self {
            ctrl,
            tool_router: Self::tool_router(),
        }
    }
}

fn tool_err(err: AppError) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(
        serde_json::json!({
            "code": err.code(),
            "message": err.to_string(),
        })
        .to_string(),
    )])
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct PaperListArgs {
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    tag: Vec<String>,
    #[serde(default)]
    unread: bool,
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct PaperRefArgs {
    /// Paper id or vault-relative folder path (`papers/…`).
    r#ref: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ImportIdArgs {
    /// arXiv id, DOI, or URL.
    text: String,
    /// Vault-relative parent under `papers/` (default: current Library scope).
    #[serde(default)]
    parent: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct NotesWriteArgs {
    r#ref: String,
    content: String,
    /// `replace` (default) or `append`.
    #[serde(default)]
    mode: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct TagArgs {
    r#ref: String,
    tags: Vec<String>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ImportIdOut {
    paper_dir: String,
    path: String,
    id: String,
    title: String,
    used_translator: bool,
    translator_base_url: String,
    pdf: bool,
    tex: bool,
    paper_md: bool,
    asset_messages: Vec<String>,
}

impl From<import::LookupImportResult> for ImportIdOut {
    fn from(r: import::LookupImportResult) -> Self {
        Self {
            paper_dir: r.paper_dir,
            path: r.path,
            id: r.id,
            title: r.title,
            used_translator: r.used_translator,
            translator_base_url: r.translator_base_url,
            pdf: r.pdf,
            tex: r.tex,
            paper_md: r.paper_md,
            asset_messages: r.asset_messages,
        }
    }
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct NotesGetOut {
    /// Vault-relative paper folder.
    r#ref: String,
    id: String,
    content: String,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct NotesWriteOut {
    r#ref: String,
    id: String,
    mode: String,
}

fn clamp_limit(raw: Option<u32>) -> usize {
    raw.unwrap_or(50).clamp(1, 200) as usize
}

#[tool_router]
impl AgenteroMcp {
    #[tool(
        description = "List papers in the open vault with catalog metadata (id, path, title, authors, year, tags, doi, arxivId, publication, status, isRead). Abstract is omitted; use paper_get for the full record."
    )]
    async fn paper_list(
        &self,
        Parameters(args): Parameters<PaperListArgs>,
    ) -> Result<Json<paper::PaperListOut>, CallToolResult> {
        let vault = match self.ctrl.local_vault() {
            Ok(v) => v,
            Err(e) => return Err(tool_err(e)),
        };
        match paper::list_papers(
            &vault,
            args.query.as_deref(),
            &args.tag,
            args.unread,
            clamp_limit(args.limit),
        ) {
            Ok(items) => Ok(Json(paper::PaperListOut { items })),
            Err(e) => Err(tool_err(e)),
        }
    }

    #[tool(description = "Get one paper's full catalog metadata by id or vault-relative path.")]
    async fn paper_get(
        &self,
        Parameters(args): Parameters<PaperRefArgs>,
    ) -> Result<Json<paper::PaperGetOut>, CallToolResult> {
        let vault = match self.ctrl.local_vault() {
            Ok(v) => v,
            Err(e) => return Err(tool_err(e)),
        };
        match paper::get_paper(&vault, &args.r#ref) {
            Ok(row) => Ok(Json(row)),
            Err(e) => Err(tool_err(e)),
        }
    }

    #[tool(description = "Import a paper into the vault by arXiv id, DOI, or URL (magic wand).")]
    async fn import_id(
        &self,
        Parameters(args): Parameters<ImportIdArgs>,
    ) -> Result<Json<ImportIdOut>, CallToolResult> {
        let vault = match self.ctrl.local_vault() {
            Ok(v) => v,
            Err(e) => return Err(tool_err(e)),
        };
        let parent = args
            .parent
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| self.ctrl.parent_dir());
        let parent = match import::normalize_parent_dir(&parent) {
            Ok(p) => p,
            Err(e) => return Err(tool_err(e)),
        };
        let import_args = LookupImportArgs {
            vault_path: vault.to_string_lossy().to_string(),
            parent_dir: parent,
            text: args.text,
            translator_base_url: self.ctrl.translator_url(),
            task_id: None,
        };
        let note_mode = NoteShellMode::parse(&self.ctrl.paper_note_mode());
        let result = if let Some(app) = self.ctrl.app_handle() {
            let cache = app.try_state::<catalog::CapsCache>();
            import::import_by_identifier_with_progress(
                import_args,
                Some(&app),
                cache.as_ref().map(|s| s.inner()),
                note_mode,
            )
            .await
        } else {
            import::import_by_identifier_with_progress(import_args, None, None, note_mode).await
        };
        match result {
            Ok(r) => Ok(Json(ImportIdOut::from(r))),
            Err(e) => Err(tool_err(e)),
        }
    }

    #[tool(
        description = "Read NOTES.md for a paper (id or vault-relative path). Empty string if the file does not exist."
    )]
    async fn paper_notes_get(
        &self,
        Parameters(args): Parameters<PaperRefArgs>,
    ) -> Result<Json<NotesGetOut>, CallToolResult> {
        let vault = match self.ctrl.local_vault() {
            Ok(v) => v,
            Err(e) => return Err(tool_err(e)),
        };
        let paper = match paper::resolve_paper(&vault, &args.r#ref) {
            Ok(p) => p,
            Err(e) => return Err(tool_err(e)),
        };
        match notes::read_notes(&vault, &paper.path) {
            Ok(text) => Ok(Json(NotesGetOut {
                r#ref: paper.path,
                id: paper.id,
                content: text,
            })),
            Err(e) => Err(tool_err(e)),
        }
    }

    #[tool(
        description = "Write NOTES.md for a paper. mode=replace (default) keeps existing YAML frontmatter unless content includes its own; mode=append adds to the body."
    )]
    async fn paper_notes_write(
        &self,
        Parameters(args): Parameters<NotesWriteArgs>,
    ) -> Result<Json<NotesWriteOut>, CallToolResult> {
        let vault = match self.ctrl.local_vault() {
            Ok(v) => v,
            Err(e) => return Err(tool_err(e)),
        };
        let paper = match paper::resolve_paper(&vault, &args.r#ref) {
            Ok(p) => p,
            Err(e) => return Err(tool_err(e)),
        };
        let mode = match args.mode.as_deref().map(str::trim).unwrap_or("replace") {
            "" | "replace" => WriteMode::Replace,
            "append" => WriteMode::Append,
            other => {
                return Err(tool_err(AppError::message(format!(
                    "mode must be replace or append, got {other}"
                ))));
            }
        };
        match notes::write_notes(&vault, &paper.path, &paper.id, &args.content, mode) {
            Ok(()) => Ok(Json(NotesWriteOut {
                r#ref: paper.path,
                id: paper.id,
                mode: match mode {
                    WriteMode::Replace => "replace".into(),
                    WriteMode::Append => "append".into(),
                },
            })),
            Err(e) => Err(tool_err(e)),
        }
    }

    #[tool(description = "Add tags to a paper. Names may use a color suffix like topic:blue.")]
    async fn paper_tag_add(
        &self,
        Parameters(args): Parameters<TagArgs>,
    ) -> Result<Json<paper::PaperGetOut>, CallToolResult> {
        let vault = match self.ctrl.local_vault() {
            Ok(v) => v,
            Err(e) => return Err(tool_err(e)),
        };
        let paper = match paper::resolve_paper(&vault, &args.r#ref) {
            Ok(p) => p,
            Err(e) => return Err(tool_err(e)),
        };
        let parsed: Result<Vec<_>, _> =
            args.tags.iter().map(|t| paper::parse_tag_spec(t)).collect();
        let parsed = match parsed {
            Ok(t) => t,
            Err(e) => return Err(tool_err(e)),
        };
        match papers::add_tags(&vault, &paper.path, &parsed) {
            Ok(row) => Ok(Json(paper::PaperGetOut::from_record(&row))),
            Err(e) => Err(tool_err(e)),
        }
    }

    #[tool(description = "Remove tags from a paper (case-insensitive names).")]
    async fn paper_tag_rm(
        &self,
        Parameters(args): Parameters<TagArgs>,
    ) -> Result<Json<paper::PaperGetOut>, CallToolResult> {
        let vault = match self.ctrl.local_vault() {
            Ok(v) => v,
            Err(e) => return Err(tool_err(e)),
        };
        let paper = match paper::resolve_paper(&vault, &args.r#ref) {
            Ok(p) => p,
            Err(e) => return Err(tool_err(e)),
        };
        let names: Vec<String> = args
            .tags
            .iter()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect();
        match papers::remove_tags(&vault, &paper.path, &names) {
            Ok(row) => Ok(Json(paper::PaperGetOut::from_record(&row))),
            Err(e) => Err(tool_err(e)),
        }
    }
}

#[tool_handler]
impl ServerHandler for AgenteroMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .build(),
        )
        .with_instructions(
            "Agentero research vault MCP. Read resource agentero://vault first, then paper_list / paper_get. ref is a paper id or vault-relative path. Notes writes only touch NOTES.md.",
        )
        .with_server_info(
            Implementation::new("agentero", env!("CARGO_PKG_VERSION"))
                .with_title("Agentero")
                .with_website_url("https://agentero.poco-ai.com")
                .with_icons(icons::server_icons()),
        )
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, McpError> {
        Ok(ListResourcesResult::with_all_items(vec![Resource::new(
            VAULT_URI, VAULT_NAME,
        )
        .with_title("Current vault")
        .with_mime_type("text/markdown")
        .with_icons(icons::server_icons())]))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, McpError> {
        if request.uri != VAULT_URI {
            return Err(McpError::resource_not_found(
                format!("unknown resource {}", request.uri),
                None,
            ));
        }
        let markdown = resources::vault_markdown(&self.ctrl);
        Ok(ReadResourceResult::new(vec![ResourceContents::text(markdown, VAULT_URI)]).into())
    }
}

#[cfg(test)]
mod schema_tests {
    use super::AgenteroMcp;
    use crate::integration::mcp::McpController;
    use rmcp::ServerHandler;

    #[test]
    fn import_id_advertises_output_schema() {
        let tool = AgenteroMcp::import_id_tool_attr();
        let schema = tool
            .output_schema
            .expect("import_id should advertise outputSchema");
        let props = schema
            .get("properties")
            .and_then(|v| v.as_object())
            .expect("object properties");
        for key in ["path", "id", "title", "pdf", "tex", "paperMd"] {
            assert!(props.contains_key(key), "missing {key} in {props:?}");
        }
    }

    #[test]
    fn server_info_includes_embedded_icons() {
        let mcp = AgenteroMcp::new(std::sync::Arc::new(McpController::new()));
        let info = mcp.get_info();
        let icons = info.server_info.icons.as_ref().expect("serverInfo.icons");
        assert!(!icons.is_empty());
        assert!(icons[0].src.starts_with("data:image/png;base64,"));
        assert_eq!(info.server_info.title.as_deref(), Some("Agentero"));
    }
}
