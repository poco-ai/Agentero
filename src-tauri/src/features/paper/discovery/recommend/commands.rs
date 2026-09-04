//! Tauri commands for arXiv daily recommendation.

use super::{
    last_result, probe_embedding_endpoint, recommend, ProbeEmbeddingResult, RecommendResult,
    ERR_NO_EMBEDDING,
};
use crate::core::blocking::run_blocking;
use crate::core::error::{map_err, ApiResult, AppError};
use crate::features::settings::AppSettingsStore;
use serde::Deserialize;
use tauri::{AppHandle, Manager};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendArxivArgs {
    pub vault_path: String,
    /// Categories to fetch; falls back to the last run, then the defaults.
    #[serde(default)]
    pub categories: Option<Vec<String>>,
    #[serde(default)]
    pub top_n: Option<usize>,
    /// Recompute even when today's stored run covers the same categories.
    #[serde(default)]
    pub force: bool,
}

/// Rank today's arXiv papers against the Vault library.
///
/// Reuses the stored same-day run unless `force` is set, so the vault-open
/// prewarm and repeated page opens stay free.
#[tauri::command]
pub async fn recommend_arxiv(
    app: AppHandle,
    args: RecommendArxivArgs,
) -> ApiResult<RecommendResult> {
    let vault = match crate::core::fs::resolve_vault(&args.vault_path) {
        Ok(vault) => vault,
        Err(e) => return map_err(e),
    };
    // Read managed state before awaiting: the guard must not cross an await.
    let embedding = app.state::<AppSettingsStore>().embedding_config();
    match recommend(&vault, args.categories, args.top_n, args.force, embedding).await {
        Ok(result) => ApiResult::ok(result),
        Err(e) => map_err(e),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendArxivLastArgs {
    pub vault_path: String,
}

/// Stored recommendation run, if any — lets the page render before refreshing.
#[tauri::command]
pub async fn recommend_arxiv_last(
    args: RecommendArxivLastArgs,
) -> ApiResult<Option<RecommendResult>> {
    run_blocking(move || {
        let vault = match crate::core::fs::resolve_vault(&args.vault_path) {
            Ok(vault) => vault,
            Err(e) => return map_err(e),
        };
        match last_result(&vault) {
            Ok(result) => ApiResult::ok(result),
            Err(e) => map_err(e),
        }
    })
    .await
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeEmbeddingArgs {
    /// Override the stored base URL. Empty / missing keeps the stored value.
    #[serde(default)]
    pub base_url: Option<String>,
    /// Override the stored API key. Empty / missing keeps the stored value.
    /// The Host's `*` mask is also treated as "use the stored secret".
    #[serde(default)]
    pub api_key: Option<String>,
    /// Override the stored model. Empty / missing keeps the stored value.
    #[serde(default)]
    pub model: Option<String>,
}

/// Liveness check for the user's configured embedding endpoint.
///
/// Reads the stored embedding config; the optional args let the caller
/// (typically the Agent settings pane) probe a draft that has not been
/// committed yet. Returns `ERR_NO_EMBEDDING` when nothing is configured so
/// the UI can route the user to the settings page.
#[tauri::command]
pub async fn probe_embedding(
    app: AppHandle,
    args: ProbeEmbeddingArgs,
) -> ApiResult<ProbeEmbeddingResult> {
    // Read managed state before awaiting: the guard must not cross an await.
    let stored = app.state::<AppSettingsStore>().embedding_config();
    let (base_url, api_key, model) = match stored {
        Some(triple) => triple,
        None => return ApiResult::err(AppError::message(ERR_NO_EMBEDDING)),
    };
    let override_base = args
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let override_key = args
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.chars().all(|c| c == '*'));
    let override_model = args
        .model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let resolved_base = override_base.unwrap_or(&base_url).to_string();
    let resolved_key = override_key.map(|s| s.to_string()).or(api_key);
    let resolved_model = override_model.unwrap_or(&model).to_string();
    if resolved_base.trim().is_empty() || resolved_model.trim().is_empty() {
        return ApiResult::err(AppError::message(ERR_NO_EMBEDDING));
    }
    match probe_embedding_endpoint(&resolved_base, resolved_key.as_deref(), &resolved_model).await {
        Ok(result) => ApiResult::ok(result),
        Err(e) => map_err(e),
    }
}
