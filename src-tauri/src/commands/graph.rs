use crate::error::AppError;
use crate::models::wiki::{BacklinksResponse, GraphResponse, RebuildResult};
use crate::services::wiki::WikiIndexState;
use std::sync::MutexGuard;
use tauri::State;

/// Lock the wiki index, mapping a poisoned lock to an internal error.
fn lock_index<'a>(
    index: &'a State<'_, WikiIndexState>,
) -> Result<MutexGuard<'a, crate::services::wiki::index::WikiIndex>, AppError> {
    index
        .inner
        .lock()
        .map_err(|e| AppError::internal(format!("wiki index lock: {e}")))
}

#[tauri::command]
pub fn graph_get_backlinks(
    index: State<'_, WikiIndexState>,
    vault_path: String,
    path: String,
) -> Result<BacklinksResponse, AppError> {
    let mut guard = lock_index(&index)?;
    guard
        .ensure_vault(&vault_path)
        .map_err(AppError::internal)?;
    Ok(guard.get_backlinks(&vault_path, &path))
}

#[tauri::command]
pub fn graph_get_graph(
    index: State<'_, WikiIndexState>,
    vault_path: String,
    center: Option<String>,
    depth: Option<u32>,
) -> Result<GraphResponse, AppError> {
    let mut guard = lock_index(&index)?;
    guard
        .ensure_vault(&vault_path)
        .map_err(AppError::internal)?;
    let center_ref = center.as_deref().filter(|s| !s.trim().is_empty());
    Ok(guard.get_graph(&vault_path, center_ref, depth))
}

#[tauri::command]
pub fn graph_rebuild(
    index: State<'_, WikiIndexState>,
    vault_path: String,
) -> Result<RebuildResult, AppError> {
    use crate::log_util::OpTimer;

    let op = OpTimer::start("graph_rebuild");
    op.finish(
        lock_index(&index)
            .and_then(|mut guard| guard.rebuild(&vault_path).map_err(AppError::internal)),
    )
}
