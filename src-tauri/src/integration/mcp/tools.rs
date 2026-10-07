//! MCP tools + ServerHandler.

use super::files::{self, WriteMode as FileWriteMode};
use super::icons;
use super::layout;
use super::notes::{self, WriteMode};
use super::paper;
use super::resources::{
    self, INVARIANTS_NAME, INVARIANTS_URI, SKILL_NAME, SKILL_URI, VAULT_NAME, VAULT_URI,
};
use super::McpController;
use crate::core::error::AppError;
use crate::features::paper::catalog::{self, papers};
use crate::features::paper::discovery::discover;
use crate::features::paper::import::{self, LookupImportArgs, NoteShellMode};
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
use std::collections::HashSet;
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
    /// Extra fields on top of id/path/title (e.g. year, date, tags, authors, isRead).
    #[serde(default)]
    fields: Vec<String>,
    /// Emit the previous full metadata row shape.
    #[serde(default)]
    full: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct PaperRefArgs {
    /// Paper id or vault-relative folder path (`papers/…`).
    r#ref: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct PaperSetReadArgs {
    /// Paper id or vault-relative folder path (`papers/…`).
    r#ref: String,
    /// Default true.
    #[serde(default = "default_true")]
    is_read: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct LayoutListArgs {
    r#ref: String,
    /// Filter kinds: figure|image|chart|table|algorithm|formula (OR).
    #[serde(default)]
    kind: Vec<String>,
    #[serde(default)]
    min_score: Option<f64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct LayoutGetArgs {
    r#ref: String,
    /// Region id from layout_list (e.g. figure-3).
    id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct PaperTextArgs {
    r#ref: String,
    /// 1-based page numbers; omit for all pages.
    pages: Option<Vec<u32>>,
    /// Per-page character budget (default 20000, capped at 50000).
    max_chars: Option<usize>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct PageReadArgs {
    /// Paper id or vault-relative folder path (`papers/…`).
    r#ref: String,
    /// 1-based physical page number to read (first page is 1).
    page: u32,
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
struct FileListArgs {
    /// Vault-relative directory. Empty lists the vault root.
    #[serde(default)]
    path: Option<String>,
    /// Default 200, capped at 500.
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct FileReadArgs {
    /// Vault-relative text file, e.g. `drafts/main.tex`.
    path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct FileWriteArgs {
    /// Vault-relative text file, e.g. `drafts/main.tex`.
    path: String,
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

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct DiscoverArxivArgs {
    /// Topic terms / phrases (repeatable).
    #[serde(default)]
    keywords: Vec<String>,
    /// arXiv categories, e.g. cs.AI (repeatable).
    #[serde(default)]
    categories: Vec<String>,
    /// Only papers submitted on/after this date (YYYY-MM-DD).
    #[serde(default)]
    since: Option<String>,
    /// Only papers submitted on/before this date (YYYY-MM-DD).
    #[serde(default)]
    until: Option<String>,
    /// Shortlist size (default 8).
    #[serde(default)]
    top: Option<usize>,
    /// Max candidates fetched before ranking (default 100, max 200).
    #[serde(default)]
    max_candidates: Option<usize>,
    /// Drop candidates already in the library catalog (default true).
    #[serde(default = "default_true")]
    dedup: bool,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct DiscoverScoreTermOut {
    term: String,
    /// `title` or `abstract`.
    field: String,
    count: u32,
    weight: f32,
    contribution: f32,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct DiscoverItemOut {
    arxiv_id: String,
    title: String,
    #[serde(rename = "abstract")]
    abstract_text: String,
    url: String,
    pdf_url: Option<String>,
    published_at: Option<String>,
    score: f32,
    matches: Vec<DiscoverScoreTermOut>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct DiscoverArxivOut {
    source: String,
    /// Raw arXiv `search_query` expression, for transparency/replay.
    search_query: String,
    candidates_scanned: usize,
    /// Candidates dropped as already in the library.
    excluded: usize,
    computed_at: String,
    items: Vec<DiscoverItemOut>,
}

impl From<discover::DiscoverResult> for DiscoverArxivOut {
    fn from(result: discover::DiscoverResult) -> Self {
        Self {
            source: result.source,
            search_query: result.search_query,
            candidates_scanned: result.candidates_scanned,
            excluded: result.excluded,
            computed_at: result.computed_at,
            items: result
                .items
                .into_iter()
                .map(|item| DiscoverItemOut {
                    arxiv_id: item.arxiv_id,
                    title: item.title,
                    abstract_text: item.abstract_text,
                    url: item.url,
                    pdf_url: item.pdf_url,
                    published_at: item.published_at,
                    score: item.score,
                    matches: item
                        .matches
                        .into_iter()
                        .map(|m| DiscoverScoreTermOut {
                            term: m.term,
                            field: m.field,
                            count: m.count,
                            weight: m.weight,
                            contribution: m.contribution,
                        })
                        .collect(),
                })
                .collect(),
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

#[derive(Debug, Default, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct VaultSearchArgs {
    query: String,
    #[serde(default)]
    limit: Option<usize>,
    /// Exact publication year; narrows hits to catalog papers with this year.
    #[serde(default)]
    year: Option<i32>,
    /// Case-insensitive substring on the catalog `publication` field.
    #[serde(default)]
    publication: Option<String>,
    /// Case-insensitive substring on the catalog `doi` field.
    #[serde(default)]
    doi: Option<String>,
    /// Catalog read state (true = read); narrows hits to catalog papers.
    #[serde(default)]
    is_read: Option<bool>,
}

#[tool_router]
impl AgenteroMcp {
    #[tool(
        description = "Search Markdown in the open local vault using case-insensitive keyword AND (not semantic search). Returns ranked relative paths, snippets, 1-based lines and truncated; read hits with file_read. limit defaults to 60, clamped to 1..200.",
        annotations(read_only_hint = true)
    )]
    async fn vault_search(
        &self,
        Parameters(args): Parameters<VaultSearchArgs>,
    ) -> Result<Json<crate::features::markdown::search::VaultSearchResult>, CallToolResult> {
        let ctrl = self.ctrl.clone();
        // Root resolution and the walk both do sync I/O; keep them off the MCP runtime.
        tokio::task::spawn_blocking(move || {
            let vault = ctrl.local_vault()?;
            files::search(
                &vault,
                args.query,
                args.limit,
                args.year,
                args.publication,
                args.doi,
                args.is_read,
            )
        })
        .await
        .map_err(|e| tool_err(AppError::message(format!("blocking search failed: {e}"))))?
        .map(Json)
        .map_err(tool_err)
    }

    #[tool(
        description = "List papers in the open vault. Default rows are only id/path/title (token-cheap). Pass fields (year, date, tags, authors, isRead, …) or full=true for more. Abstract is only on paper_get."
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
            &args.fields,
            args.full,
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
            let host_app = crate::features::host_hooks::wrap(&app);
            import::import_by_identifier_with_progress(
                import_args,
                Some(&host_app),
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
        description = "Discover and rank arXiv papers for a topic (keywords / categories / submission-date window) with a deterministic lexical scorer. Vault-free; when the vault is open, dedup (default) drops papers already in the library. Returns arXiv ids for a follow-up import_id."
    )]
    async fn discover_arxiv(
        &self,
        Parameters(args): Parameters<DiscoverArxivArgs>,
    ) -> Result<Json<DiscoverArxivOut>, CallToolResult> {
        let exclude: HashSet<String> = if args.dedup {
            match self.ctrl.local_vault() {
                Ok(vault) => match discover::known_arxiv_ids(&vault) {
                    Ok(ids) => ids,
                    Err(e) => return Err(tool_err(e)),
                },
                // Discovery is vault-free; a closed vault just skips novelty.
                Err(_) => HashSet::new(),
            }
        } else {
            HashSet::new()
        };
        let query = discover::DiscoverQuery {
            keywords: args.keywords,
            categories: args.categories,
            since: args.since,
            until: args.until,
            top: args.top,
            max_candidates: args.max_candidates,
            semantic_weight: None,
        };
        match discover::discover_arxiv(&query, &exclude, None).await {
            Ok(result) => Ok(Json(DiscoverArxivOut::from(result))),
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
        let parsed: Result<Vec<_>, _> = args
            .tags
            .iter()
            .map(|t| papers::parse_tag_spec(t))
            .collect();
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

    #[tool(
        description = "Set catalog is_read for a paper (does not run paper-reader). Default isRead=true."
    )]
    async fn paper_set_read(
        &self,
        Parameters(args): Parameters<PaperSetReadArgs>,
    ) -> Result<Json<paper::PaperGetOut>, CallToolResult> {
        let vault = match self.ctrl.local_vault() {
            Ok(v) => v,
            Err(e) => return Err(tool_err(e)),
        };
        match paper::set_read(&vault, &args.r#ref, args.is_read) {
            Ok(row) => Ok(Json(row)),
            Err(e) => Err(tool_err(e)),
        }
    }

    #[tool(
        description = "List sidebar layout regions (figures/tables/algorithms/formulas) from layout-index.json. Requires desktop layout analysis first."
    )]
    async fn layout_list(
        &self,
        Parameters(args): Parameters<LayoutListArgs>,
    ) -> Result<Json<layout::LayoutListOut>, CallToolResult> {
        let vault = match self.ctrl.local_vault() {
            Ok(v) => v,
            Err(e) => return Err(tool_err(e)),
        };
        match layout::list(&vault, &args.r#ref, &args.kind, args.min_score) {
            Ok(out) => Ok(Json(out)),
            Err(e) => Err(tool_err(e)),
        }
    }

    #[tool(description = "Get one layout region by id (e.g. figure-3) from layout-index.json.")]
    async fn layout_get(
        &self,
        Parameters(args): Parameters<LayoutGetArgs>,
    ) -> Result<Json<layout::LayoutGetOut>, CallToolResult> {
        let vault = match self.ctrl.local_vault() {
            Ok(v) => v,
            Err(e) => return Err(tool_err(e)),
        };
        match layout::get(&vault, &args.r#ref, &args.id) {
            Ok(out) => Ok(Json(out)),
            Err(e) => Err(tool_err(e)),
        }
    }

    /// Opt-in (#676): paper full text leaves the vault only when the user
    /// enables `mcpExposePaperText`; otherwise this tool errors.
    #[tool(
        description = "Read page text of a paper's PDF (opt-in). Disabled unless the owner enables mcpExposePaperText in Settings. pages selects 1-based pages (omit for all); each page is truncated to maxChars (default 20000)."
    )]
    async fn paper_text_get(
        &self,
        Parameters(args): Parameters<PaperTextArgs>,
    ) -> Result<Json<paper::PaperTextOut>, CallToolResult> {
        let app = match self.ctrl.app_handle() {
            Some(app) => app,
            None => return Err(tool_err(AppError::message("app handle unavailable"))),
        };
        let expose = app
            .state::<crate::features::system::settings::AppSettingsStore>()
            .get()
            .map(|result| result.settings.mcp_expose_paper_text)
            .unwrap_or(false);
        if !expose {
            return Err(tool_err(AppError::message(
                "paper_text_get is disabled: enable mcpExposePaperText in Settings                  (opt-in — paper full text would be sent to external clients)",
            )));
        }
        let vault = match self.ctrl.local_vault() {
            Ok(v) => v,
            Err(e) => return Err(tool_err(e)),
        };
        let max_chars = args.max_chars.unwrap_or(20_000).clamp(1, 50_000);
        match paper::text(&vault, &args.r#ref, args.pages, max_chars) {
            Ok(out) => Ok(Json(out)),
            Err(e) => Err(tool_err(e)),
        }
    }

    #[tool(
        description = "Read the full text layout of one physical page of a paper from source/layout.json (schemaVersion 3, desktop layout analysis). Returns every region in reading order, plus text_regions (paragraph-level). Requires layout analysis to have run for the paper.",
        annotations(read_only_hint = true)
    )]
    async fn page_read(
        &self,
        Parameters(args): Parameters<PageReadArgs>,
    ) -> Result<Json<layout::PageReadOut>, CallToolResult> {
        let ctrl = self.ctrl.clone();
        tokio::task::spawn_blocking(move || {
            let vault = ctrl.local_vault()?;
            layout::read_page(&vault, &args.r#ref, args.page)
        })
        .await
        .map_err(|e| tool_err(AppError::message(format!("blocking page_read failed: {e}"))))?
        .map(Json)
        .map_err(tool_err)
    }

    #[tool(
        description = "List one directory in the open vault (not the whole tree). path is vault-relative; omit it for the vault root. Skips .agentero, hidden dirs, and LaTeX build artifacts. Use this to find drafts such as main.tex outside papers/."
    )]
    async fn file_list(
        &self,
        Parameters(args): Parameters<FileListArgs>,
    ) -> Result<Json<files::FileListOut>, CallToolResult> {
        let vault = match self.ctrl.local_vault() {
            Ok(v) => v,
            Err(e) => return Err(tool_err(e)),
        };
        let limit = args.limit.unwrap_or(200).clamp(1, 500) as usize;
        match files::list_dir(&vault, args.path.as_deref().unwrap_or(""), limit) {
            Ok(out) => Ok(Json(out)),
            Err(e) => Err(tool_err(e)),
        }
    }

    #[tool(
        description = "Read one UTF-8 text file by vault-relative path (e.g. drafts/main.tex or notes/idea.md). Refuses .agentero, binaries, marks, and layout indexes. Missing file is an error. NOTES.md is allowed here; prefer paper_notes_get for a paper."
    )]
    async fn file_read(
        &self,
        Parameters(args): Parameters<FileReadArgs>,
    ) -> Result<Json<files::FileReadOut>, CallToolResult> {
        let vault = match self.ctrl.local_vault() {
            Ok(v) => v,
            Err(e) => return Err(tool_err(e)),
        };
        match files::read_text(&vault, &args.path) {
            Ok(out) => Ok(Json(out)),
            Err(e) => Err(tool_err(e)),
        }
    }

    #[tool(
        description = "Write one UTF-8 text file by vault-relative path. mode=replace (default) or append. Creates missing parent directories inside the vault. Use for a LaTeX draft outside papers/. Refuses NOTES.md (use paper_notes_write), .agentero, binaries, marks, and layout indexes. Confirm with the user before replace."
    )]
    async fn file_write(
        &self,
        Parameters(args): Parameters<FileWriteArgs>,
    ) -> Result<Json<files::FileWriteOut>, CallToolResult> {
        let vault = match self.ctrl.local_vault() {
            Ok(v) => v,
            Err(e) => return Err(tool_err(e)),
        };
        let mode = match args.mode.as_deref().map(str::trim).unwrap_or("replace") {
            "" | "replace" => FileWriteMode::Replace,
            "append" => FileWriteMode::Append,
            other => {
                return Err(tool_err(AppError::message(format!(
                    "mode must be replace or append, got {other}"
                ))));
            }
        };
        match files::write_text(&vault, &args.path, &args.content, mode) {
            Ok(out) => Ok(Json(out)),
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
        .with_instructions(concat!(
            "Agentero research vault MCP (local vault; App must be open). ",
            "Read agentero://vault, then agentero://agent-invariants. ",
            "paper_list defaults to id/path/title only — pass fields or full when needed. ",
            "ref is a paper id or vault-relative path. Notes writes only touch NOTES.md. ",
            "Other vault text (a .tex draft outside papers/) uses file_list, file_read, and file_write. ",
            "Confirm with the user before replace of user-written NOTES or other files. ",
            "Optional: agentero://skills/agentero-cli for the bundled CLI skill body."
        ))
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
        let icons = icons::server_icons();
        Ok(ListResourcesResult::with_all_items(vec![
            Resource::new(VAULT_URI, VAULT_NAME)
                .with_title("Current vault")
                .with_mime_type("text/markdown")
                .with_icons(icons.clone()),
            Resource::new(INVARIANTS_URI, INVARIANTS_NAME)
                .with_title("Agent invariants")
                .with_mime_type("text/markdown")
                .with_icons(icons.clone()),
            Resource::new(SKILL_URI, SKILL_NAME)
                .with_title("Bundled agentero-cli skill")
                .with_mime_type("text/markdown")
                .with_icons(icons),
        ]))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, McpError> {
        let Some((markdown, _mime)) = resources::read(&request.uri, &self.ctrl) else {
            return Err(McpError::resource_not_found(
                format!("unknown resource {}", request.uri),
                None,
            ));
        };
        Ok(
            ReadResourceResult::new(vec![ResourceContents::text(markdown, request.uri.clone())])
                .into(),
        )
    }
}

#[cfg(test)]
mod schema_tests {
    use super::AgenteroMcp;
    use crate::integration::mcp::McpController;
    use rmcp::ServerHandler;

    #[test]
    fn vault_search_advertises_read_only_hint() {
        let tool = AgenteroMcp::vault_search_tool_attr();
        assert_eq!(
            tool.annotations.as_ref().and_then(|a| a.read_only_hint),
            Some(true)
        );
    }

    #[test]
    fn vault_search_is_registered_with_structured_output() {
        let router = AgenteroMcp::tool_router();
        let tools = router.list_all();
        let tool = tools
            .iter()
            .find(|t| t.name == "vault_search")
            .expect("read-only vault_search must be registered");
        let schema = tool
            .output_schema
            .as_ref()
            .expect("structured search output");
        let props = schema.get("properties").unwrap();
        assert!(props.get("hits").is_some());
        assert!(props.get("truncated").is_some());
        let inputs = tool.input_schema.get("properties").unwrap();
        assert!(inputs.get("query").is_some());
        assert!(inputs.get("limit").is_some());
        assert!(inputs.get("vaultPath").is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn vault_search_does_not_follow_links_outside_the_host_vault() {
        use rmcp::handler::server::wrapper::Parameters;
        use std::os::unix::fs::symlink;
        let vault = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(
            vault.path().join("inside.md"),
            "# Test material\nneedle inside\n",
        )
        .unwrap();
        std::fs::write(outside.path().join("secret.md"), "needle outside secret\n").unwrap();
        symlink(
            outside.path().join("secret.md"),
            vault.path().join("linked.md"),
        )
        .unwrap();
        symlink(outside.path(), vault.path().join("linked-dir")).unwrap();
        for rel in [
            ".hidden.md",
            ".agentero/skip.md",
            "target/skip.md",
            "source/skip.md",
        ] {
            let path = vault.path().join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "needle ignored test material\n").unwrap();
        }
        let ctrl = std::sync::Arc::new(McpController::new());
        ctrl.set_vault(Some(vault.path().to_string_lossy().into_owned()));
        let mcp = AgenteroMcp::new(ctrl);
        let result = mcp
            .vault_search(Parameters(super::VaultSearchArgs {
                query: "needle".into(),
                limit: None,
                ..Default::default()
            }))
            .await
            .unwrap()
            .0;
        assert_eq!(
            result
                .hits
                .iter()
                .map(|h| h.path.as_str())
                .collect::<Vec<_>>(),
            vec!["inside.md"]
        );
        assert!(super::files::read_text(vault.path(), "linked.md").is_err());
    }

    #[tokio::test]
    async fn vault_search_protocol_round_trip_reads_fixture_hits() {
        use rmcp::{model::CallToolRequestParams, ServiceExt};
        use serde_json::json;
        let vault = tempfile::tempdir().unwrap();
        let fixture =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../test/fixtures/mcp-search");
        let mut before = Vec::new();
        for rel in [
            "papers/alpha/PAPER.md",
            "papers/alpha/NOTES.md",
            "papers/beta/PAPER.md",
            "papers/beta/NOTES.md",
        ] {
            let bytes = std::fs::read(fixture.join(rel)).unwrap();
            let target = vault.path().join(rel);
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
            std::fs::write(&target, &bytes).unwrap();
            before.push((target, bytes));
        }
        let ctrl = std::sync::Arc::new(McpController::new());
        ctrl.set_vault(Some(vault.path().to_string_lossy().into_owned()));
        let (server_io, client_io) = tokio::io::duplex(65536);
        let server =
            tokio::spawn(async move { AgenteroMcp::new(ctrl).serve(server_io).await.unwrap() });
        let mut client = ().serve(client_io).await.unwrap();
        let mut server = server.await.unwrap();
        assert_eq!(
            client
                .peer_info()
                .unwrap()
                .server_info
                .as_ref()
                .unwrap()
                .name,
            "agentero"
        );
        assert!(client
            .list_all_tools()
            .await
            .unwrap()
            .iter()
            .any(|t| t.name == "vault_search"));
        let result = client
            .call_tool(
                CallToolRequestParams::new("vault_search").with_arguments(
                    json!({"query":"TRANSFORMER attention"})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            )
            .await
            .unwrap();
        assert_ne!(result.is_error, Some(true));
        let out = result.structured_content.unwrap();
        eprintln!(
            "MCP tools/call vault_search: {}",
            serde_json::to_string_pretty(&out).unwrap()
        );
        let hits = out["hits"].as_array().unwrap();
        assert_eq!(hits.len(), 3);
        assert_eq!(out["truncated"], false);
        let host = crate::features::markdown::search::vault_search(
            crate::features::markdown::search::VaultSearchArgs {
                vault_path: vault.path().to_string_lossy().into_owned(),
                query: "TRANSFORMER attention".into(),
                limit: None,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            out,
            serde_json::to_value(host).unwrap(),
            "same ranking/snippets as Host"
        );
        for hit in hits {
            let read = client
                .call_tool(
                    CallToolRequestParams::new("file_read")
                        .with_arguments(json!({"path":hit["path"]}).as_object().unwrap().clone()),
                )
                .await
                .unwrap();
            assert_ne!(read.is_error, Some(true));
            let read = read.structured_content.unwrap();
            let content = read["content"].as_str().unwrap();
            let line = hit["line"].as_u64().unwrap() as usize;
            assert_eq!(line, 3);
            assert_eq!(
                content.lines().nth(line - 1).unwrap(),
                hit["snippet"].as_str().unwrap()
            );
            eprintln!(
                "MCP file_read verified {} line {}: {}",
                hit["path"], line, hit["snippet"]
            );
        }
        for (args, count, truncated) in [
            (json!({"query":"transformer attention", "limit":1}), 1, true),
            (json!({"query":"transformer attention", "limit":0}), 1, true),
            (
                json!({"query":"transformer attention", "limit":999}),
                3,
                false,
            ),
            (json!({"query":"   "}), 0, false),
            (json!({"query":"absent-keyword"}), 0, false),
            (json!({"query":"transformer cats"}), 0, false),
        ] {
            let response = client
                .call_tool(
                    CallToolRequestParams::new("vault_search")
                        .with_arguments(args.as_object().unwrap().clone()),
                )
                .await
                .unwrap();
            let value = response.structured_content.unwrap();
            assert_eq!(value["hits"].as_array().unwrap().len(), count);
            assert_eq!(value["truncated"], truncated);
        }
        for args in [
            json!({}),
            json!({"query":"attention", "limit":-1}),
            json!({"query":"attention", "limit":1.5}),
        ] {
            let response = client
                .call_tool(
                    CallToolRequestParams::new("vault_search")
                        .with_arguments(args.as_object().unwrap().clone()),
                )
                .await
                .unwrap();
            assert_eq!(response.is_error, Some(true));
        }
        client.close().await.unwrap();
        server.close().await.unwrap();
        for (path, bytes) in before {
            assert_eq!(
                std::fs::read(path).unwrap(),
                bytes,
                "search/read must not write fixture"
            );
        }
    }

    #[tokio::test]
    async fn vault_search_requires_a_local_host_selected_root() {
        use rmcp::handler::server::wrapper::Parameters;
        let ctrl = std::sync::Arc::new(McpController::new());
        let mcp = AgenteroMcp::new(ctrl.clone());
        assert!(mcp
            .vault_search(Parameters(super::VaultSearchArgs {
                query: "needle".into(),
                limit: None,
                ..Default::default()
            }))
            .await
            .is_err());
        ctrl.set_vault(Some("remote:test-fixture".into()));
        assert!(mcp
            .vault_search(Parameters(super::VaultSearchArgs {
                query: "needle".into(),
                limit: None,
                ..Default::default()
            }))
            .await
            .is_err());
    }

    #[test]
    fn vault_search_uses_the_blocking_pool_without_stalling_the_runtime() {
        use rmcp::handler::server::wrapper::Parameters;
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .build()
            .unwrap();
        let (release, wait) = std::sync::mpsc::channel();
        let (ready, started) = std::sync::mpsc::channel();
        let blocker = rt.spawn_blocking(move || {
            ready.send(()).unwrap();
            wait.recv().unwrap();
        });
        started.recv().unwrap();
        let vault = tempfile::tempdir().unwrap();
        std::fs::write(vault.path().join("test.md"), "needle test material\n").unwrap();
        let ctrl = std::sync::Arc::new(McpController::new());
        ctrl.set_vault(Some(vault.path().to_string_lossy().into_owned()));
        let mcp = AgenteroMcp::new(ctrl);
        rt.block_on(async move {
            let search = tokio::spawn(async move {
                mcp.vault_search(Parameters(super::VaultSearchArgs {
                    query: "needle".into(),
                    limit: None,
                    ..Default::default()
                }))
                .await
                .unwrap()
                .0
            });
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            let queued = !search.is_finished();
            release.send(()).unwrap(); // Release even if the assertion will fail.
            blocker.await.unwrap();
            let result = search.await.unwrap();
            assert!(
                queued,
                "search must wait for the blocking pool, not run sync I/O on the runtime"
            );
            assert_eq!(result.hits.len(), 1);
            eprintln!(
                "MCP current-thread timer progressed while search was queued on the blocking pool"
            );
        });
    }

    #[tokio::test]
    async fn vault_search_allows_markdown_in_a_directory_with_binary_extension() {
        use rmcp::handler::server::wrapper::Parameters;
        let vault = tempfile::tempdir().unwrap();
        std::fs::create_dir(vault.path().join("draft.pdf")).unwrap();
        std::fs::write(
            vault.path().join("draft.pdf/note.md"),
            "needle test material\n",
        )
        .unwrap();
        assert!(super::files::read_text(vault.path(), "draft.pdf/note.md").is_ok());
        let ctrl = std::sync::Arc::new(McpController::new());
        ctrl.set_vault(Some(vault.path().to_string_lossy().into_owned()));
        let mcp = AgenteroMcp::new(ctrl);
        let out = mcp
            .vault_search(Parameters(super::VaultSearchArgs {
                query: "needle".into(),
                limit: None,
                ..Default::default()
            }))
            .await
            .unwrap()
            .0;
        assert_eq!(out.hits.len(), 1);
        assert_eq!(out.hits[0].path, "draft.pdf/note.md");
    }

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
    fn discover_arxiv_advertises_output_schema() {
        let tool = AgenteroMcp::discover_arxiv_tool_attr();
        let schema = tool
            .output_schema
            .expect("discover_arxiv should advertise outputSchema");
        let props = schema
            .get("properties")
            .and_then(|v| v.as_object())
            .expect("object properties");
        for key in [
            "source",
            "searchQuery",
            "candidatesScanned",
            "excluded",
            "computedAt",
            "items",
        ] {
            assert!(props.contains_key(key), "missing {key} in {props:?}");
        }
    }

    #[test]
    fn file_read_advertises_output_schema() {
        let tool = AgenteroMcp::file_read_tool_attr();
        let schema = tool
            .output_schema
            .expect("file_read should advertise outputSchema");
        let props = schema
            .get("properties")
            .and_then(|v| v.as_object())
            .expect("object properties");
        for key in ["path", "content", "bytes"] {
            assert!(props.contains_key(key), "missing {key} in {props:?}");
        }
    }

    fn serve_fixture_vault(root: &std::path::Path, rels: &[&str]) {
        let fixture =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../test/fixtures/mcp-search");
        for rel in rels {
            let bytes = std::fs::read(fixture.join(rel)).unwrap();
            let target = root.join(rel);
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
            std::fs::write(&target, &bytes).unwrap();
        }
    }

    #[tokio::test]
    async fn page_read_protocol_round_trip_reads_a_physical_page() {
        use crate::features::paper::catalog::papers::{self, PaperRecord};
        use rmcp::{model::CallToolRequestParams, ServiceExt};
        use serde_json::json;
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path();
        serve_fixture_vault(
            root,
            &[
                "papers/alpha/PAPER.md",
                "papers/alpha/NOTES.md",
                "papers/alpha/source/layout.json",
            ],
        );
        // resolve_paper reads the catalog, so index the paper first.
        papers::upsert_paper(
            root,
            &PaperRecord::local_pdf("alpha".into(), "Alpha".into()).at_path("papers/alpha"),
        )
        .unwrap();
        let ctrl = std::sync::Arc::new(McpController::new());
        ctrl.set_vault(Some(root.to_string_lossy().into_owned()));
        let (server_io, client_io) = tokio::io::duplex(65536);
        let server =
            tokio::spawn(async move { AgenteroMcp::new(ctrl).serve(server_io).await.unwrap() });
        let mut client = ().serve(client_io).await.unwrap();
        let mut server = server.await.unwrap();

        let result = client
            .call_tool(
                CallToolRequestParams::new("page_read").with_arguments(
                    json!({"ref": "papers/alpha", "page": 2})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            )
            .await
            .unwrap();
        assert_ne!(result.is_error, Some(true));
        let out = result.structured_content.unwrap();
        eprintln!(
            "MCP tools/call page_read: {}",
            serde_json::to_string_pretty(&out).unwrap()
        );
        assert_eq!(out["paperPath"], "papers/alpha");
        assert_eq!(out["page"], 2);
        assert_eq!(out["pageCount"], 2, "fixture layout spans pageIndex 0..=1");
        assert_eq!(out["regionCount"], 1);
        assert_eq!(out["regions"][0]["id"], "page2-body");
        let text_regions = out["textRegions"].as_array().unwrap();
        assert_eq!(text_regions.len(), 1);
        assert_eq!(
            text_regions[0]["text"],
            "Transformer attention test evidence."
        );

        // Out-of-range page is an empty page, not an error.
        let empty = client
            .call_tool(
                CallToolRequestParams::new("page_read").with_arguments(
                    json!({"ref": "papers/alpha", "page": 9999})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            )
            .await
            .unwrap();
        let out = empty.structured_content.unwrap();
        assert_eq!(out["regionCount"], 0);

        // page=0 is rejected (1-based).
        let bad = client
            .call_tool(
                CallToolRequestParams::new("page_read").with_arguments(
                    json!({"ref": "papers/alpha", "page": 0})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            )
            .await
            .unwrap();
        assert_eq!(bad.is_error, Some(true));

        client.close().await.unwrap();
        server.close().await.unwrap();
    }

    #[tokio::test]
    async fn vault_search_carries_physical_page_and_metadata_filter() {
        use crate::features::paper::catalog::papers::{self, PaperRecord};
        use rmcp::{model::CallToolRequestParams, ServiceExt};
        use serde_json::json;
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path();
        serve_fixture_vault(
            root,
            &[
                "papers/alpha/PAPER.md",
                "papers/alpha/NOTES.md",
                "papers/alpha/source/layout.json",
                "papers/beta/PAPER.md",
                "papers/beta/NOTES.md",
            ],
        );
        // A lone note outside the catalog: full-text searchable but no metadata.
        std::fs::write(
            root.join("scratch.md"),
            "# Scratch\n\ntransformer attention scratch note\n",
        )
        .unwrap();
        let mut alpha =
            PaperRecord::local_pdf("alpha".into(), "Alpha".into()).at_path("papers/alpha");
        alpha.year = Some(2024);
        alpha.publication = Some("NeurIPS".into());
        alpha.doi = Some("10.5555/alpha".into());
        papers::upsert_paper(root, &alpha).unwrap();
        let mut beta = PaperRecord::local_pdf("beta".into(), "Beta".into()).at_path("papers/beta");
        beta.year = Some(2019);
        beta.publication = Some("ICLR".into());
        papers::upsert_paper(root, &beta).unwrap();

        let ctrl = std::sync::Arc::new(McpController::new());
        ctrl.set_vault(Some(root.to_string_lossy().into_owned()));
        let (server_io, client_io) = tokio::io::duplex(65536);
        let server =
            tokio::spawn(async move { AgenteroMcp::new(ctrl).serve(server_io).await.unwrap() });
        let mut client = ().serve(client_io).await.unwrap();
        let mut server = server.await.unwrap();

        // Baseline: alpha PAPER+NOTES, beta PAPER, scratch note = 4 hits.
        let base = client
            .call_tool(
                CallToolRequestParams::new("vault_search").with_arguments(
                    json!({"query": "transformer attention"})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            )
            .await
            .unwrap();
        let base_hits = base.structured_content.unwrap()["hits"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(base_hits.len(), 4, "baseline hit count");
        let baseline_alpha_paper = base_hits
            .iter()
            .find(|h| h["path"] == "papers/alpha/PAPER.md")
            .expect("alpha PAPER baseline hit");
        assert_eq!(
            baseline_alpha_paper["page"], 2,
            "PAPER.md body maps to physical page 2"
        );
        let baseline_notes = base_hits
            .iter()
            .find(|h| h["path"] == "papers/alpha/NOTES.md")
            .expect("alpha NOTES baseline hit");
        assert!(
            baseline_notes.get("page").is_none(),
            "NOTES.md must not carry a physical page"
        );

        // year=2024 filter keeps only the alpha paper's hits.
        let filtered = client
            .call_tool(
                CallToolRequestParams::new("vault_search").with_arguments(
                    json!({"query": "transformer attention", "year": 2024})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            )
            .await
            .unwrap();
        let hits = filtered.structured_content.unwrap()["hits"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(hits.len(), 2, "alpha PAPER + NOTES");
        for h in &hits {
            assert_eq!(h["paperPath"], "papers/alpha");
        }

        // A publication substring filter also narrows.
        let publ = client
            .call_tool(
                CallToolRequestParams::new("vault_search").with_arguments(
                    json!({"query": "transformer attention", "publication": "iclr"})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            )
            .await
            .unwrap();
        let publ_hits = publ.structured_content.unwrap()["hits"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(publ_hits.len(), 1, "beta PAPER only");
        assert_eq!(publ_hits[0]["path"], "papers/beta/PAPER.md");

        // A year with no catalog paper drops every hit.
        let none = client
            .call_tool(
                CallToolRequestParams::new("vault_search").with_arguments(
                    json!({"query": "transformer attention", "year": 1000})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            )
            .await
            .unwrap();
        assert_eq!(
            none.structured_content.unwrap()["hits"]
                .as_array()
                .unwrap()
                .len(),
            0
        );

        client.close().await.unwrap();
        server.close().await.unwrap();
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
