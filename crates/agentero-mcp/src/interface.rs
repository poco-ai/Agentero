//! The same catalog drives protocol discovery, argument validation and CLI execution.
use crate::{excerpts::ExcerptKey, vault_id, McpController, Permissions};
use agentero_core::error::AppError;
use agentero_core::ops::execute::{self, operation, ToolId};
use rmcp::model::*;
use rmcp::service::{RequestContext, RoleServer};
use rmcp::{ErrorData as McpError, ServerHandler, ServiceExt};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

static TOOLS: LazyLock<Vec<Tool>> = LazyLock::new(|| {
    let manifest: Value =
        serde_json::from_str(agentero_core::ops::MCP_INTERFACE_JSON).expect("invalid MCP manifest");
    manifest["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .map(|entry| {
            let mut tool: Tool = serde_json::from_value(entry.clone()).expect("invalid MCP tool");
            let op = operation(&tool.name, Permissions::all())
                .expect("MCP tool missing execution policy");
            let annotations = tool.annotations.get_or_insert_with(Default::default);
            annotations.read_only_hint = Some(!op.writes());
            annotations.destructive_hint =
                Some(op.spec.side_effects == agentero_core::ops::OpSideEffect::Destructive);
            tool
        })
        .collect()
});

pub fn tools_list(permissions: Permissions) -> ListToolsResult {
    let mut result = ListToolsResult::with_all_items(
        TOOLS
            .iter()
            .filter(|t| operation(&t.name, permissions).is_ok())
            .cloned()
            .collect(),
    );
    result.ttl_ms = Some(0);
    result.cache_scope = Some(CacheScope::Private);
    result
}

fn resolve_id(ctrl: &McpController, id: Option<&str>) -> Result<PathBuf, AppError> {
    if let Some(id) = id {
        let entry = ctrl
            .vault_list()
            .vaults
            .into_iter()
            .find(|v| v.exists && vault_id(Path::new(&v.path)) == id)
            .ok_or_else(|| {
                AppError::domain(
                    "permission_denied",
                    "Select an authorized ID from vault_list",
                )
            })?;
        ctrl.resolve_vault(Some(&entry.path))
    } else {
        ctrl.local_vault().map_err(|_| {
            let ids = ctrl
                .vault_list()
                .vaults
                .into_iter()
                .filter(|v| v.exists)
                .map(|v| vault_id(Path::new(&v.path)))
                .collect::<Vec<_>>();
            AppError::domain(
                "vault_required",
                format!(
                    "Select a vault from vault_list. Authorized IDs: {}",
                    ids.join(", ")
                ),
            )
            .with_details(json!({"vaults":ids}))
        })
    }
}

#[derive(Clone)]
pub(crate) struct ResearchServer {
    controller: Arc<McpController>,
    session_key: ExcerptKey,
}

impl ResearchServer {
    pub(crate) fn new(controller: Arc<McpController>) -> Self {
        Self {
            controller,
            session_key: ExcerptKey::new(),
        }
    }
    fn permissions(&self) -> Permissions {
        self.controller.host().permissions()
    }
    async fn execute(
        &self,
        name: &str,
        mut args: Value,
        mut permissions: Permissions,
        key: &ExcerptKey,
    ) -> Result<Value, AppError> {
        let op = operation(name, permissions)?;
        op.validate_input(&args)?;
        if name == "vault_list" {
            let items = self
                .controller
                .vault_list()
                .vaults
                .into_iter()
                .filter(|v| v.exists)
                .map(|v| json!({"id":vault_id(Path::new(&v.path)),"name":v.name,"current":v.open}))
                .collect::<Vec<_>>();
            return op.checked_output(json!({"items":items}));
        }
        let requested_vault = args["vault"].as_str();
        let vault = if op.id == ToolId::PaperDiscover && requested_vault.is_none() {
            self.controller.local_vault().unwrap_or_default()
        } else {
            resolve_id(&self.controller, requested_vault)?
        };
        args.as_object_mut().unwrap().remove("vault");
        if let Some(id) = args["to_vault"].as_str() {
            args["to_vault"] = json!(resolve_id(&self.controller, Some(id))?);
        }
        let excerpt_only = !permissions.full_text;
        let mut replay = None;
        let budget = args["max_chars"].as_u64().unwrap_or(260) as usize;
        if excerpt_only && op.id == ToolId::EvidenceRead {
            replay = key.authorize_read(&args)?;
            permissions.full_text = replay.is_some();
            if replay.is_some() {
                args["max_chars"] = json!(260);
            }
        } else if excerpt_only && op.id == ToolId::AnnotationAdd {
            // A signed citation authorizes only the server-issued span. Free text remains protected.
            permissions.full_text = args["cite"]
                .as_str()
                .is_some_and(|cite| key.verified(cite).is_some());
        }
        let mut value = execute::run(self.controller.clone(), vault, op, args, permissions).await?;
        if excerpt_only && op.id == ToolId::EvidenceSearch {
            key.seal_cards(&mut value)?;
        }
        if let Some((cite, fingerprint)) = replay {
            let text = value["text"].as_str().unwrap_or_default();
            if fingerprint != ring::digest::digest(&ring::digest::SHA256, text.as_bytes()).as_ref()
            {
                return Err(AppError::domain(
                    "stale_citation",
                    "The issued excerpt has changed",
                ));
            }
            let excerpt: String = text.chars().take(budget).collect();
            value["truncated"] = json!(text.len() > excerpt.len());
            value["text"] = json!(excerpt);
            value["next_cursor"] = Value::Null;
            let card = value["evidence"]
                .as_array_mut()
                .and_then(|v| v.first_mut())
                .ok_or_else(|| AppError::domain("stale_citation", "The cited passage changed"))?;
            if card["cite"].as_str() != cite.split_once("#excerpt=").map(|(base, _)| base) {
                return Err(AppError::domain(
                    "stale_citation",
                    "Source changed while reading the excerpt",
                ));
            }
            card["cite"] = json!(cite);
            card["excerpt"] = json!(excerpt);
        }
        Ok(value)
    }
}

impl ServerHandler for ResearchServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().enable_resources().build())
        .with_instructions("Read agentero://guide. Use paper_list for catalog records, evidence_search for sources and evidence_read to expand a citation.")
        .with_server_info(Implementation::new("agentero",env!("CARGO_PKG_VERSION")).with_title("Agentero").with_website_url("https://agentero.app").with_icons(crate::icons::server_icons()))
    }
    fn get_tool(&self, name: &str) -> Option<Tool> {
        operation(name, self.permissions()).ok()?;
        TOOLS.iter().find(|tool| tool.name == name).cloned()
    }
    async fn list_tools(
        &self,
        _req: Option<PaginatedRequestParams>,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(tools_list(self.permissions()))
    }
    async fn call_tool(
        &self,
        req: CallToolRequestParams,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let p = self.permissions();
        let key = ctx
            .extensions
            .get::<axum::http::request::Parts>()
            .filter(|parts| !parts.headers.contains_key("mcp-session-id"))
            .and_then(|parts| parts.extensions.get::<ExcerptKey>())
            .unwrap_or(&self.session_key);
        let result = self
            .execute(
                &req.name,
                Value::Object(req.arguments.unwrap_or_default()),
                p,
                key,
            )
            .await;
        match result {
            Ok(value) => Ok(CallToolResult::structured(value).into()),
            Err(error) if matches!(error.code(), "unknown_tool" | "usage") => Err(
                McpError::invalid_params(error.to_string(), error.details().cloned()),
            ),
            Err(error) => {
                let hint = match error.code() {
                    "revision_conflict" => "Read the current revision and retry.",
                    "permission_denied" | "full_text_required" => {
                        "Inspect the grants on this server."
                    }
                    "stale_citation" | "stale_cursor" => "Repeat the original search.",
                    _ => "Check the input and selected vault.",
                };
                let details = error.details().cloned().unwrap_or_else(|| json!({}));
                let body = json!({"error":{"code":error.code(),"message":error.to_string(),"details":details,"hint":hint}});
                Ok(CallToolResult::error(vec![ContentBlock::text(body.to_string())]).into())
            }
        }
    }
    async fn list_resources(
        &self,
        _req: Option<PaginatedRequestParams>,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, McpError> {
        let mut out = ListResourcesResult::with_all_items(vec![Resource::new(
            "agentero://guide",
            "Agentero research tools",
        )
        .with_mime_type("text/markdown")]);
        out.ttl_ms = Some(0);
        out.cache_scope = Some(CacheScope::Private);
        Ok(out)
    }
    async fn read_resource(
        &self,
        req: ReadResourceRequestParams,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, McpError> {
        if req.uri != "agentero://guide" {
            return Err(McpError::resource_not_found("Unknown resource", None));
        }
        let guide="Choose a vault ID from vault_list. paper_list finds records. evidence_search returns short excerpts with cite URIs; pass one to evidence_read. A cursor continues the same request. Use a current revision for replacements and a stable request_id for retries.";
        let mut out = ReadResourceResult::new(vec![ResourceContents::text(guide, req.uri)]);
        out.ttl_ms = Some(0);
        out.cache_scope = Some(CacheScope::Private);
        Ok(out.into())
    }
}

pub async fn serve_stdio(ctrl: Arc<McpController>) -> Result<(), AppError> {
    let running = ResearchServer::new(ctrl)
        .serve(rmcp::transport::stdio())
        .await
        .map_err(|e| AppError::message(e.to_string()))?;
    running
        .waiting()
        .await
        .map_err(|e| AppError::message(e.to_string()))?;
    Ok(())
}
