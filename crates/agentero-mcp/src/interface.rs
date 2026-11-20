//! The same catalog drives protocol discovery, argument validation and CLI execution.
use crate::{operations, McpController};
use agentero_core::error::AppError;
use rmcp::model::*;
use rmcp::service::{RequestContext, RoleServer};
use rmcp::{ErrorData as McpError, ServerHandler, ServiceExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

struct Operation {
    tool: Tool,
    input: jsonschema::Validator,
    output: jsonschema::Validator,
}
static OPERATIONS: LazyLock<Vec<Operation>> = LazyLock::new(|| {
    let manifest: Value =
        serde_json::from_str(agentero_core::ops::MCP_INTERFACE_JSON).expect("invalid MCP manifest");
    manifest["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .map(|entry| Operation {
            tool: serde_json::from_value(entry.clone()).expect("invalid tool"),
            output: jsonschema::validator_for(&entry["outputSchema"])
                .expect("invalid output schema"),
            input: jsonschema::validator_for(&entry["inputSchema"]).expect("invalid input schema"),
        })
        .collect()
});

#[derive(Clone, Copy, Default)]
pub struct Permissions {
    pub write: bool,
    pub online: bool,
    pub full_text: bool,
}

impl Permissions {
    pub fn all() -> Self {
        Self {
            write: true,
            online: true,
            full_text: true,
        }
    }
    fn permits(self, tool: &Tool) -> bool {
        (!changes_vault(tool) || self.write)
            && (self.online || !matches!(tool.name.as_ref(), "paper_discover" | "paper_import"))
    }
}

fn changes_vault(tool: &Tool) -> bool {
    !tool
        .annotations
        .as_ref()
        .and_then(|a| a.read_only_hint)
        .unwrap_or(false)
}

pub fn tools_list(permissions: Permissions) -> ListToolsResult {
    let mut result = ListToolsResult::with_all_items(
        OPERATIONS
            .iter()
            .filter(|op| permissions.permits(&op.tool))
            .map(|op| op.tool.clone())
            .collect(),
    );
    result.ttl_ms = Some(0);
    result.cache_scope = Some(CacheScope::Private);
    result
}

fn operation(name: &str, permissions: Permissions) -> Result<&'static Operation, AppError> {
    let op = OPERATIONS
        .iter()
        .find(|op| op.tool.name == name)
        .ok_or_else(|| AppError::domain("unknown_tool", "Unknown Agentero tool"))?;
    if !permissions.permits(&op.tool) {
        return Err(AppError::domain(
            "permission_denied",
            "This tool requires additional grants",
        ));
    }
    Ok(op)
}

fn validate(op: &Operation, arguments: &Value) -> Result<(), AppError> {
    op.input.validate(arguments).map_err(|e| {
        AppError::domain(
            "usage",
            format!(
                "Invalid {} argument at {} (schema {})",
                op.tool.name, e.instance_path, e.schema_path
            ),
        )
    })
}

fn checked_output(op: &Operation, value: Value) -> Result<Value, AppError> {
    op.output.validate(&value).map_err(|e| {
        AppError::domain(
            "invalid_result",
            format!(
                "{} produced invalid output at {} (schema {})",
                op.tool.name, e.instance_path, e.schema_path
            ),
        )
    })?;
    Ok(value)
}

pub fn vault_id(path: &Path) -> String {
    format!(
        "v-{:x}",
        Sha256::digest(
            agentero_core::fs::canonicalize_best_effort(path)
                .to_string_lossy()
                .as_bytes()
        )
    )
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

pub async fn execute_local(vault: &Path, name: &str, args: Value) -> Result<Value, AppError> {
    let op = operation(name, Permissions::all())?;
    validate(op, &args)?;
    let ctrl = Arc::new(McpController::new());
    ctrl.set_vault(Some(vault.to_string_lossy().into_owned()));
    checked_output(
        op,
        operations::execute(
            ctrl,
            vault.to_owned(),
            name,
            args,
            Permissions::all(),
            changes_vault(&op.tool),
        )
        .await?,
    )
}

#[derive(Clone)]
pub(crate) struct ResearchServer(pub Arc<McpController>);

impl ResearchServer {
    fn permissions(&self) -> Permissions {
        let host = self.0.host();
        Permissions {
            write: host.allow_write(),
            online: host.allow_online(),
            full_text: host.expose_paper_text(),
        }
    }
    async fn execute(
        &self,
        name: &str,
        mut args: Value,
        permissions: Permissions,
    ) -> Result<Value, AppError> {
        let op = operation(name, permissions)?;
        validate(op, &args)?;
        if name == "vault_list" {
            let items = self
                .0
                .vault_list()
                .vaults
                .into_iter()
                .filter(|v| v.exists)
                .map(|v| json!({"id":vault_id(Path::new(&v.path)),"name":v.name,"current":v.open}))
                .collect::<Vec<_>>();
            return checked_output(op, json!({"items":items}));
        }
        let vault = resolve_id(&self.0, args["vault"].as_str())?;
        args.as_object_mut().unwrap().remove("vault");
        if let Some(id) = args["to_vault"].as_str() {
            args["to_vault"] = json!(resolve_id(&self.0, Some(id))?);
        }
        checked_output(
            op,
            operations::execute(
                self.0.clone(),
                vault,
                name,
                args,
                permissions,
                changes_vault(&op.tool),
            )
            .await?,
        )
    }
}

impl ServerHandler for ResearchServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().enable_resources().build())
        .with_instructions("Read agentero://guide. Use paper_list for catalog records, evidence_search for sources and evidence_read to expand a citation.")
        .with_server_info(Implementation::new("agentero",env!("CARGO_PKG_VERSION")).with_title("Agentero").with_website_url("https://agentero.app").with_icons(crate::icons::server_icons()))
    }
    fn get_tool(&self, name: &str) -> Option<Tool> {
        operation(name, self.permissions())
            .ok()
            .map(|op| op.tool.clone())
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
        _ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let p = self.permissions();
        let result = self
            .execute(
                &req.name,
                Value::Object(req.arguments.unwrap_or_default()),
                p,
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
    let running = ResearchServer(ctrl)
        .serve(rmcp::transport::stdio())
        .await
        .map_err(|e| AppError::message(e.to_string()))?;
    running
        .waiting()
        .await
        .map_err(|e| AppError::message(e.to_string()))?;
    Ok(())
}
