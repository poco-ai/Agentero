use super::{
    apply_alias_repairs, apply_catalog_duplicate_repairs, apply_visual_mark_repairs,
    apply_wikilink_repairs, diagnose, plan_wikilink_repairs, set_ignored_alias_paths,
    AliasRepairChange, AliasRepairResult, DoctorDirtyPathsState, DoctorReport, DoctorVaultState,
    DuplicateRepairResult, VisualMarkRepairChange, VisualMarkRepairResult, WikilinkRepairChange,
    WikilinkRepairPlan, WikilinkRepairResult,
};
use crate::core::blocking::run_blocking;
use crate::core::error::{map_err, ApiResult, AppError};
use crate::features::wiki::WikiIndexState;
use serde::Deserialize;
use std::path::PathBuf;
use tauri::State;

// Heavy commands (full-vault diagnosis / repairs) are async and run inside
// `run_blocking` so the main thread (Windows UI message pump) never blocks.
// `doctor_set_dirty_paths` stays sync: it only touches an in-memory map.

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorCheckArgs {
    pub vault_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorApplyAliasesArgs {
    pub vault_path: String,
    pub changes: Vec<AliasRepairChange>,
    #[serde(default)]
    pub dirty_paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorSetDirtyPathsArgs {
    pub vault_path: String,
    #[serde(default)]
    pub dirty_paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorIgnoreAliasesArgs {
    pub vault_path: String,
    #[serde(default)]
    pub paths: Vec<String>,
    /// `true` = add to ignore list; `false` = restore (remove from list).
    pub ignore: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorPlanWikilinksArgs {
    pub vault_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorApplyWikilinksArgs {
    pub vault_path: String,
    pub changes: Vec<WikilinkRepairChange>,
    #[serde(default)]
    pub dirty_paths: Vec<String>,
}

#[tauri::command]
pub fn doctor_set_dirty_paths(
    args: DoctorSetDirtyPathsArgs,
    state: State<'_, DoctorDirtyPathsState>,
) -> ApiResult<()> {
    match state.set(&args.vault_path, &args.dirty_paths) {
        Ok(()) => ApiResult::ok(()),
        Err(error) => map_err(AppError::message(format!(
            "doctor dirty paths lock: {error}"
        ))),
    }
}

#[tauri::command]
pub async fn doctor_check(args: DoctorCheckArgs) -> ApiResult<DoctorReport> {
    run_blocking(move || {
        let vault = match crate::core::fs::resolve_vault(&args.vault_path) {
            Ok(vault) => vault,
            Err(error) => return map_err(error),
        };
        match diagnose(&vault) {
            Ok(report) => ApiResult::ok(report),
            Err(error) => map_err(error),
        }
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorFixCatalogDuplicatesArgs {
    pub vault_path: String,
}

#[tauri::command]
pub async fn doctor_fix_catalog_duplicates(
    args: DoctorFixCatalogDuplicatesArgs,
) -> ApiResult<DuplicateRepairResult> {
    run_blocking(move || {
        let vault = match crate::core::fs::resolve_vault(&args.vault_path) {
            Ok(vault) => vault,
            Err(error) => return map_err(error),
        };
        match apply_catalog_duplicate_repairs(&vault) {
            Ok(result) => ApiResult::ok(result),
            Err(error) => map_err(error),
        }
    })
    .await
}

#[tauri::command]
pub async fn doctor_ignore_aliases(args: DoctorIgnoreAliasesArgs) -> ApiResult<DoctorVaultState> {
    run_blocking(move || {
        let vault = PathBuf::from(&args.vault_path);
        match set_ignored_alias_paths(&vault, &args.paths, args.ignore) {
            Ok(state) => ApiResult::ok(state),
            Err(error) => map_err(error),
        }
    })
    .await
}

#[tauri::command]
pub async fn doctor_apply_aliases(
    args: DoctorApplyAliasesArgs,
    index: State<'_, WikiIndexState>,
    dirty_state: State<'_, DoctorDirtyPathsState>,
) -> Result<ApiResult<AliasRepairResult>, String> {
    // The dirty-path snapshot is an in-memory read; take it before spawning.
    let mut dirty_paths = match dirty_state.get(&args.vault_path) {
        Ok(paths) => paths,
        Err(error) => {
            return Ok(map_err(AppError::message(format!(
                "doctor dirty paths lock: {error}"
            ))))
        }
    };
    let index = index.handle();
    Ok(run_blocking(move || {
        let vault = PathBuf::from(&args.vault_path);
        dirty_paths.extend(args.dirty_paths);
        match apply_alias_repairs(&vault, &args.changes, &dirty_paths) {
            Ok(result) => {
                if !result.updated_paths.is_empty() {
                    let mut guard = match index.lock() {
                        Ok(guard) => guard,
                        Err(error) => {
                            return map_err(AppError::message(format!("wiki index lock: {error}")))
                        }
                    };
                    if let Err(error) = guard.rebuild(&args.vault_path) {
                        return map_err(AppError::message(format!(
                            "aliases updated but Wiki index rebuild failed: {error}"
                        )));
                    }
                }
                ApiResult::ok(result)
            }
            Err(error) => ApiResult::err_with_details(
                AppError::message(error.to_string()),
                serde_json::to_value(&error).unwrap_or_default(),
            ),
        }
    })
    .await)
}

#[tauri::command]
pub async fn doctor_plan_wikilinks(args: DoctorPlanWikilinksArgs) -> ApiResult<WikilinkRepairPlan> {
    run_blocking(move || {
        let vault = match crate::core::fs::resolve_vault(&args.vault_path) {
            Ok(vault) => vault,
            Err(error) => return map_err(error),
        };
        match plan_wikilink_repairs(&vault) {
            Ok(plan) => ApiResult::ok(plan),
            Err(error) => ApiResult::err_with_details(
                AppError::message(error.to_string()),
                serde_json::to_value(&error).unwrap_or_default(),
            ),
        }
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorApplyVisualMarksArgs {
    pub vault_path: String,
    pub changes: Vec<VisualMarkRepairChange>,
    #[serde(default)]
    pub dirty_paths: Vec<String>,
}

#[tauri::command]
pub async fn doctor_apply_visual_marks(
    args: DoctorApplyVisualMarksArgs,
    dirty_state: State<'_, DoctorDirtyPathsState>,
) -> Result<ApiResult<VisualMarkRepairResult>, String> {
    let mut dirty_paths = match dirty_state.get(&args.vault_path) {
        Ok(paths) => paths,
        Err(error) => {
            return Ok(map_err(AppError::message(format!(
                "doctor dirty paths lock: {error}"
            ))))
        }
    };
    Ok(run_blocking(move || {
        let vault = PathBuf::from(&args.vault_path);
        dirty_paths.extend(args.dirty_paths);
        match apply_visual_mark_repairs(&vault, &args.changes, &dirty_paths) {
            Ok(result) => ApiResult::ok(result),
            Err(error) => map_err(error),
        }
    })
    .await)
}

#[tauri::command]
pub async fn doctor_apply_wikilinks(
    args: DoctorApplyWikilinksArgs,
    index: State<'_, WikiIndexState>,
    dirty_state: State<'_, DoctorDirtyPathsState>,
) -> Result<ApiResult<WikilinkRepairResult>, String> {
    let mut dirty_paths = match dirty_state.get(&args.vault_path) {
        Ok(paths) => paths,
        Err(error) => {
            return Ok(map_err(AppError::message(format!(
                "doctor dirty paths lock: {error}"
            ))))
        }
    };
    let index = index.handle();
    Ok(run_blocking(move || {
        let vault = PathBuf::from(&args.vault_path);
        dirty_paths.extend(args.dirty_paths);
        match apply_wikilink_repairs(&vault, &args.changes, &dirty_paths) {
            Ok(result) => {
                if !result.updated_paths.is_empty() {
                    let mut guard = match index.lock() {
                        Ok(guard) => guard,
                        Err(error) => {
                            return map_err(AppError::message(format!("wiki index lock: {error}")))
                        }
                    };
                    if let Err(error) = guard.rebuild(&args.vault_path) {
                        return map_err(AppError::message(format!(
                            "wikilinks updated but Wiki index rebuild failed: {error}"
                        )));
                    }
                }
                ApiResult::ok(result)
            }
            Err(error) => ApiResult::err_with_details(
                AppError::message(error.to_string()),
                serde_json::to_value(&error).unwrap_or_default(),
            ),
        }
    })
    .await)
}
