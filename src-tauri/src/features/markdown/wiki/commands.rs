use crate::core::blocking::run_blocking;
use crate::core::error::{map_err, ApiResult, AppError};
use crate::features::wiki::heading_rename::run_heading_rename_transaction;
use crate::features::wiki::models::{
    BacklinksResponse, InternalLinkSyntax, RebuildResult, WikiEmbedResponse,
    WikiRenameHeadingResult, WikiResolveResponse, WikiSearchCandidate, WikiSearchCandidateKind,
};
use crate::features::wiki::WikiIndexState;
use tauri::State;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiRenameHeadingArgs {
    pub vault_path: String,
    pub path: String,
    pub heading_path: Vec<String>,
    pub heading_line: u32,
    pub expected_content: String,
    pub new_text: String,
    #[serde(default)]
    pub dirty_paths: Vec<String>,
}

// Every command here may lazily (re)build the whole Wiki index behind the
// global Mutex, so each one is async and runs the lock+work inside
// `run_blocking` — never on the main thread (Windows UI message pump).

#[tauri::command]
pub async fn graph_get_backlinks(
    index: State<'_, WikiIndexState>,
    vault_path: String,
    path: String,
) -> Result<ApiResult<BacklinksResponse>, String> {
    let index = index.handle();
    Ok(run_blocking(move || {
        let mut guard = match index.lock() {
            Ok(g) => g,
            Err(e) => return map_err(AppError::message(format!("wiki index lock: {e}"))),
        };
        if let Err(e) = guard.ensure_vault(&vault_path) {
            return map_err(AppError::message(e));
        }
        ApiResult::ok(guard.get_backlinks(&vault_path, &path))
    })
    .await)
}

#[tauri::command]
pub async fn wiki_resolve(
    index: State<'_, WikiIndexState>,
    vault_path: String,
    source_path: String,
    link_text: String,
    syntax: Option<InternalLinkSyntax>,
) -> Result<ApiResult<WikiResolveResponse>, String> {
    let index = index.handle();
    Ok(run_blocking(move || {
        let mut guard = match index.lock() {
            Ok(g) => g,
            Err(e) => return map_err(AppError::message(format!("wiki index lock: {e}"))),
        };
        if let Err(e) = guard.ensure_vault(&vault_path) {
            return map_err(AppError::message(e));
        }
        ApiResult::ok(guard.resolve_text(
            &vault_path,
            &source_path,
            &link_text,
            syntax.unwrap_or(InternalLinkSyntax::Wikilink),
        ))
    })
    .await)
}

/// Resolve and read the exact source projection for one `![[...]]` embed.
#[tauri::command]
pub async fn wiki_embed_read(
    index: State<'_, WikiIndexState>,
    vault_path: String,
    source_path: String,
    link_text: String,
) -> Result<ApiResult<WikiEmbedResponse>, String> {
    let index = index.handle();
    Ok(run_blocking(move || {
        let mut guard = match index.lock() {
            Ok(g) => g,
            Err(e) => return map_err(AppError::message(format!("wiki index lock: {e}"))),
        };
        if let Err(e) = guard.ensure_vault(&vault_path) {
            return map_err(AppError::message(e));
        }
        match guard.read_embed(&vault_path, &source_path, &link_text) {
            Ok(response) => ApiResult::ok(response),
            Err(error) => map_err(AppError::message(error)),
        }
    })
    .await)
}

#[tauri::command]
pub async fn wiki_search(
    index: State<'_, WikiIndexState>,
    vault_path: String,
    query: String,
    path: Option<String>,
    kind: Option<WikiSearchCandidateKind>,
) -> Result<ApiResult<Vec<WikiSearchCandidate>>, String> {
    let index = index.handle();
    Ok(run_blocking(move || {
        let mut guard = match index.lock() {
            Ok(g) => g,
            Err(e) => return map_err(AppError::message(format!("wiki index lock: {e}"))),
        };
        if let Err(e) = guard.ensure_vault(&vault_path) {
            return map_err(AppError::message(e));
        }
        ApiResult::ok(guard.search_scoped(&query, path.as_deref(), kind.as_ref()))
    })
    .await)
}

/// Explicitly rename one saved heading and rewrite every resolved inbound
/// heading fragment as one rollback-capable local transaction.
#[tauri::command]
pub async fn wiki_rename_heading(
    args: WikiRenameHeadingArgs,
    index: State<'_, WikiIndexState>,
) -> Result<ApiResult<WikiRenameHeadingResult>, String> {
    let index = index.handle();
    Ok(run_blocking(move || {
        let vault = match crate::core::fs::resolve_vault(&args.vault_path) {
            Ok(vault) => vault,
            Err(error) => return map_err(error),
        };
        let mut guard = match index.lock() {
            Ok(guard) => guard,
            Err(error) => return map_err(AppError::message(format!("wiki index lock: {error}"))),
        };
        match run_heading_rename_transaction(
            &vault,
            &mut guard,
            &args.path,
            &args.heading_path,
            args.heading_line,
            &args.expected_content,
            &args.new_text,
            &args.dirty_paths,
        ) {
            Ok(result) => ApiResult::ok(result),
            Err(error) => ApiResult::err_with_details(
                AppError::message(error.to_string()),
                serde_json::json!({
                    "code": error.code,
                    "rollback": error.rollback,
                    "paths": error.paths,
                }),
            ),
        }
    })
    .await)
}

#[tauri::command]
pub async fn graph_rebuild(
    index: State<'_, WikiIndexState>,
    vault_path: String,
) -> Result<ApiResult<RebuildResult>, String> {
    use crate::core::log_util::OpTimer;

    let index = index.handle();
    Ok(run_blocking(move || {
        let op = OpTimer::start("graph_rebuild");
        let mut guard = match index.lock() {
            Ok(g) => g,
            Err(e) => {
                let err = AppError::message(format!("wiki index lock: {e}"));
                op.finish_err(&err);
                return map_err(err);
            }
        };
        match guard.rebuild(&vault_path) {
            Ok(r) => {
                op.finish_ok();
                ApiResult::ok(r)
            }
            Err(e) => {
                let err = AppError::message(e);
                op.finish_err(&err);
                map_err(err)
            }
        }
    })
    .await)
}

/// Internal diagnostic: remove the derived snapshot and rebuild it from Vault files.
#[tauri::command]
pub async fn wiki_cache_rebuild(
    index: State<'_, WikiIndexState>,
    vault_path: String,
) -> Result<ApiResult<RebuildResult>, String> {
    let index = index.handle();
    Ok(run_blocking(move || {
        let mut guard = match index.lock() {
            Ok(guard) => guard,
            Err(error) => {
                return map_err(AppError::message(format!("wiki index lock: {error}")));
            }
        };
        match guard.rebuild_fresh(&vault_path) {
            Ok(result) => ApiResult::ok(result),
            Err(error) => map_err(AppError::message(error)),
        }
    })
    .await)
}
