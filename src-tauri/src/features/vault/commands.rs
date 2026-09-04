use crate::core::blocking::run_blocking;
use crate::core::error::{map_err, ApiResult, AppError};
use crate::core::log_util::{trunc, OpTimer};
use crate::features::vault::tree::VaultTreeNode;
use crate::features::vault::{self, tree, CreateVaultResult};
use std::path::PathBuf;
use tauri::State;

fn vault_path_arg(path: &str) -> Result<std::path::PathBuf, AppError> {
    let p = PathBuf::from(path.trim());
    if p.as_os_str().is_empty() {
        return Err(AppError::message("path is required"));
    }
    Ok(p)
}

/// Create / scaffold a Agentero vault at the given absolute path.
#[tauri::command]
pub async fn vault_create(path: String, locale: Option<String>) -> ApiResult<CreateVaultResult> {
    run_blocking(move || {
        let op = OpTimer::start_with("vault_create", format!("path={}", trunc(&path, 200)));
        let locale = vault::resolve_vault_locale(locale.as_deref().unwrap_or(""));
        match vault_path_arg(&path) {
            Ok(p) => op.finish_result(vault::create_vault(&p, locale)),
            Err(err) => {
                op.finish_err(&err);
                map_err(err)
            }
        }
    })
    .await
}

/// Ensure scaffold, seed missing bundled content, and safely update untouched
/// first-party skills.
///
/// Call on vault open so app updates can ship new `.agents/skills/*` or onboarding
/// content without requiring the user to re-run Create Vault. User-customized
/// files are never overwritten.
#[tauri::command]
pub async fn vault_ensure(path: String, locale: Option<String>) -> ApiResult<CreateVaultResult> {
    run_blocking(move || {
        let op = OpTimer::start_with("vault_ensure", format!("path={}", trunc(&path, 200)));
        let locale = vault::resolve_vault_locale(locale.as_deref().unwrap_or(""));
        match vault_path_arg(&path) {
            Ok(p) => op.finish_result(vault::ensure_vault(&p, locale)),
            Err(err) => {
                op.finish_err(&err);
                map_err(err)
            }
        }
    })
    .await
}

/// Build the whole vault file tree in one pass (single IPC).
#[tauri::command]
pub async fn vault_tree_build(
    vault_path: String,
    caps: State<'_, crate::features::catalog::CapsCache>,
) -> Result<ApiResult<Vec<VaultTreeNode>>, String> {
    let caps = caps.inner().clone();
    Ok(run_blocking(move || {
        let op = OpTimer::start_with(
            "vault_tree_build",
            format!("vault={}", trunc(&vault_path, 200)),
        );
        let root = match crate::core::fs::resolve_vault(&vault_path) {
            Ok(root) => root,
            Err(err) => {
                op.finish_err(&err);
                return map_err(err);
            }
        };
        op.finish_result(Ok(tree::build_tree(&root, &caps)))
    })
    .await)
}

/// List one directory's children (lazy expand / targeted tree refresh).
#[tauri::command]
pub async fn vault_tree_children(
    vault_path: String,
    dir_path: String,
    caps: State<'_, crate::features::catalog::CapsCache>,
) -> Result<ApiResult<Vec<VaultTreeNode>>, String> {
    let caps = caps.inner().clone();
    Ok(run_blocking(move || {
        let op = OpTimer::start_with(
            "vault_tree_children",
            format!("dir={}", trunc(&dir_path, 200)),
        );
        let root = match vault_path_arg(&vault_path) {
            Ok(root) => root,
            Err(err) => {
                op.finish_err(&err);
                return map_err(err);
            }
        };
        let dir = match vault_path_arg(&dir_path) {
            Ok(dir) => dir,
            Err(err) => {
                op.finish_err(&err);
                return map_err(err);
            }
        };
        op.finish_result(tree::list_children(&root, &dir, &caps))
    })
    .await)
}
