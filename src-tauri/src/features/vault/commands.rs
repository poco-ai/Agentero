use crate::core::error::{map_err, ApiResult, AppError};
use crate::core::log_util::{trunc, OpTimer};
use crate::features::catalog::papers as catalog_papers;
use crate::features::remote::RemoteRegistry;
use crate::features::vault::host_fs::{self, VaultFileFingerprint};
use crate::features::vault::tree::VaultTreeNode;
use crate::features::vault::{self, tree, CreateVaultResult};
use crate::features::wiki::models::{
    WikiExternalRenamePreview, WikiRenameErrorCode, WikiRenameResult,
};
use crate::features::wiki::rename::{
    run_local_rename_transaction, run_prepared_external_rename_repair, ExternalRenameRepairStore,
    WikiRenameTransaction,
};
use crate::features::wiki::WikiIndexState;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_fs::FsExt;

fn vault_path_arg(path: &str) -> Result<std::path::PathBuf, AppError> {
    let p = PathBuf::from(path.trim());
    if p.as_os_str().is_empty() {
        return Err(AppError::message("path is required"));
    }
    Ok(p)
}

/// Create / scaffold a Agentero vault at the given absolute path.
#[tauri::command]
pub fn vault_create(path: String, locale: Option<String>) -> ApiResult<CreateVaultResult> {
    let op = OpTimer::start_with("vault_create", format!("path={}", trunc(&path, 200)));
    let locale = vault::resolve_vault_locale(locale.as_deref().unwrap_or(""));
    match vault_path_arg(&path) {
        Ok(p) => op.finish_result(vault::create_vault(&p, locale)),
        Err(err) => {
            op.finish_err(&err);
            map_err(err)
        }
    }
}

/// Ensure scaffold, seed missing bundled content, and safely update untouched
/// first-party skills.
///
/// Call on vault open so app updates can ship new `.agents/skills/*` or onboarding
/// content without requiring the user to re-run Create Vault. User-customized
/// files are never overwritten.
#[tauri::command]
pub fn vault_ensure(path: String, locale: Option<String>) -> ApiResult<CreateVaultResult> {
    let op = OpTimer::start_with("vault_ensure", format!("path={}", trunc(&path, 200)));
    let locale = vault::resolve_vault_locale(locale.as_deref().unwrap_or(""));
    match vault_path_arg(&path) {
        Ok(p) => op.finish_result(vault::ensure_vault(&p, locale)),
        Err(err) => {
            op.finish_err(&err);
            map_err(err)
        }
    }
}

/// Extend the fs-plugin scope so the renderer can read/write this vault dir.
///
/// The dialog plugin grants runtime scope for a picked folder, but that grant
/// is not persisted. On startup restore a vault located outside the static
/// scope (`$HOME/**`, `$DOCUMENT/**`, …) would otherwise fail every fs-plugin
/// call with "forbidden path" until the user re-picks it. Called whenever a
/// local vault becomes active, before the file tree loads. Idempotent.
#[tauri::command]
pub fn vault_allow_fs_scope<R: Runtime>(app: AppHandle<R>, path: String) -> ApiResult<()> {
    let op = OpTimer::start_with(
        "vault_allow_fs_scope",
        format!("path={}", trunc(&path, 200)),
    );
    let p = match vault_path_arg(&path) {
        Ok(p) => p,
        Err(err) => {
            op.finish_err(&err);
            return map_err(err);
        }
    };
    match app.fs_scope().allow_directory(&p, true) {
        Ok(()) => op.finish_result(Ok(())),
        Err(e) => {
            let err = AppError::message(format!("allow fs scope failed: {e}"));
            op.finish_err(&err);
            map_err(err)
        }
    }
}

/// Hash a local or remote Vault file without sending its bytes through IPC.
#[tauri::command]
pub async fn vault_file_fingerprint(
    registry: State<'_, Arc<RemoteRegistry>>,
    vault_root: String,
    vault_relative_path: String,
) -> Result<ApiResult<VaultFileFingerprint>, String> {
    Ok(
        match host_fs::fingerprint_vault_file(
            registry.inner().as_ref(),
            &vault_root,
            &vault_relative_path,
        )
        .await
        {
            Ok(fingerprint) => ApiResult::ok(fingerprint),
            Err(error) => map_err(error),
        },
    )
}

/// Atomically replace a UTF-8 file under a local or remote Vault root.
#[tauri::command]
pub async fn vault_write_text_atomic(
    registry: State<'_, Arc<RemoteRegistry>>,
    vault_root: String,
    vault_relative_path: String,
    content: String,
) -> Result<ApiResult<()>, String> {
    Ok(
        match host_fs::write_vault_file_atomic(
            registry.inner().as_ref(),
            &vault_root,
            &vault_relative_path,
            &content,
        )
        .await
        {
            Ok(()) => ApiResult::ok(()),
            Err(error) => map_err(error),
        },
    )
}

/// Materialize a read-only local paper snapshot outside the Vault so ACP
/// preparation workers cannot observe concurrent Vault edits.
#[tauri::command]
pub async fn vault_snapshot_workspace_create(
    vault_root: String,
    workspace_id: String,
    source_paths: Vec<String>,
) -> Result<ApiResult<String>, String> {
    Ok(
        match host_fs::materialize_local_snapshot_workspace(
            &vault_root,
            &workspace_id,
            &source_paths,
        )
        .await
        {
            Ok(path) => ApiResult::ok(path),
            Err(error) => map_err(error),
        },
    )
}

/// Remove a previously materialized Host-owned paper snapshot workspace.
#[tauri::command]
pub async fn vault_snapshot_workspace_release(
    workspace_path: String,
) -> Result<ApiResult<()>, String> {
    Ok(
        match host_fs::release_local_snapshot_workspace(&workspace_path).await {
            Ok(()) => ApiResult::ok(()),
            Err(error) => map_err(error),
        },
    )
}

/// Build the whole vault file tree in one pass (single IPC).
#[tauri::command]
pub fn vault_tree_build(vault_path: String) -> ApiResult<Vec<VaultTreeNode>> {
    let op = OpTimer::start_with(
        "vault_tree_build",
        format!("vault={}", trunc(&vault_path, 200)),
    );
    let root = match vault_path_arg(&vault_path) {
        Ok(root) if root.is_dir() => root,
        Ok(_) => {
            let err = AppError::message("vault path is not a directory");
            op.finish_err(&err);
            return map_err(err);
        }
        Err(err) => {
            op.finish_err(&err);
            return map_err(err);
        }
    };
    op.finish_result(Ok(tree::build_tree(&root)))
}

/// List one directory's children (lazy expand / targeted tree refresh).
#[tauri::command]
pub fn vault_tree_children(vault_path: String, dir_path: String) -> ApiResult<Vec<VaultTreeNode>> {
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
    op.finish_result(tree::list_children(&root, &dir))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiMoveArgs {
    pub vault_path: String,
    /// Vault-relative file or directory path to rename/move.
    pub from_rel: String,
    /// Vault-relative final path, including the new basename.
    pub to_rel: String,
    /// Dirty open Markdown/NOTES paths supplied by the renderer.
    #[serde(default)]
    pub dirty_paths: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiExternalRenamePreviewArgs {
    pub vault_path: String,
    /// Verified watcher pair: the former Vault-relative path and its final path.
    pub from_rel: String,
    pub to_rel: String,
    /// Dirty open Markdown/NOTES paths supplied by the renderer.
    #[serde(default)]
    pub dirty_paths: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiApplyExternalRenameArgs {
    pub vault_path: String,
    pub candidate_id: String,
    /// Rechecked immediately before any Vault write.
    #[serde(default)]
    pub dirty_paths: Vec<String>,
}

/// Move or rename one local Vault path while updating resolved internal links.
#[tauri::command]
pub fn wiki_move(
    args: WikiMoveArgs,
    index: State<'_, WikiIndexState>,
) -> ApiResult<WikiRenameResult> {
    let vault = match vault_path_arg(&args.vault_path) {
        Ok(vault) if vault.is_dir() => vault,
        Ok(_) => return map_err(AppError::message("vault path is not a directory")),
        Err(error) => return map_err(error),
    };
    let mut guard = match index.inner.lock() {
        Ok(guard) => guard,
        Err(error) => return map_err(AppError::message(format!("wiki index lock: {error}"))),
    };
    match run_local_rename_transaction(
        &vault,
        &mut guard,
        &args.from_rel,
        &args.to_rel,
        &args.dirty_paths,
        || {
            catalog_papers::move_under_path(&vault, &args.from_rel, &args.to_rel)
                .map(|_| ())
                .map_err(|error| error.to_string())
        },
    ) {
        Ok(result) => ApiResult::ok(result),
        Err(error) => map_err(AppError::message(error.to_string())),
    }
}

/// Preserve a pre-rename semantic plan for an externally observed local rename.
/// This is intentionally a read-only preflight: the caller must explicitly apply
/// it, or opt into the `always` policy in the renderer.
#[tauri::command]
pub fn wiki_external_rename_preview(
    args: WikiExternalRenamePreviewArgs,
    index: State<'_, WikiIndexState>,
    repairs: State<'_, ExternalRenameRepairStore>,
) -> ApiResult<WikiExternalRenamePreview> {
    let vault = match vault_path_arg(&args.vault_path) {
        Ok(vault) if vault.is_dir() => vault,
        Ok(_) => return map_err(AppError::message("vault path is not a directory")),
        Err(error) => return map_err(error),
    };
    let guard = match index.inner.lock() {
        Ok(guard) => guard,
        Err(error) => return map_err(AppError::message(format!("wiki index lock: {error}"))),
    };
    let transaction = match WikiRenameTransaction::plan_external_repair(
        &vault,
        &guard,
        &args.from_rel,
        &args.to_rel,
    ) {
        Ok(transaction) => transaction,
        Err(error) => return map_err(AppError::message(error.to_string())),
    };
    if let Err(error) = transaction.reject_dirty_paths(&args.dirty_paths) {
        return map_err(AppError::message(error.to_string()));
    }
    let affected_sources = transaction.updated_sources();
    let skipped = transaction.skipped().to_vec();
    let from = transaction.from().to_string();
    let to = transaction.moved_path().to_string();
    drop(guard);
    match repairs.insert(transaction) {
        Ok(candidate_id) => ApiResult::ok(WikiExternalRenamePreview {
            candidate_id,
            from,
            to,
            affected_sources,
            skipped,
        }),
        Err(error) => map_err(AppError::message(error.to_string())),
    }
}

/// Apply one previously previewed external rename repair. The Host rechecks the
/// candidate's source hashes and current dirty paths before touching Markdown.
#[tauri::command]
pub fn wiki_apply_external_rename_repair(
    args: WikiApplyExternalRenameArgs,
    index: State<'_, WikiIndexState>,
    repairs: State<'_, ExternalRenameRepairStore>,
) -> ApiResult<WikiRenameResult> {
    let vault = match vault_path_arg(&args.vault_path) {
        Ok(vault) if vault.is_dir() => vault,
        Ok(_) => return map_err(AppError::message("vault path is not a directory")),
        Err(error) => return map_err(error),
    };
    let transaction = match repairs.get(&args.candidate_id) {
        Ok(transaction) => transaction,
        Err(error) => return map_err(AppError::message(error.to_string())),
    };
    let mut guard = match index.inner.lock() {
        Ok(guard) => guard,
        Err(error) => return map_err(AppError::message(format!("wiki index lock: {error}"))),
    };
    match run_prepared_external_rename_repair(&vault, &mut guard, &transaction, &args.dirty_paths) {
        Ok(result) => {
            repairs.remove(&args.candidate_id);
            ApiResult::ok(result)
        }
        Err(error) => {
            if error.code != WikiRenameErrorCode::UnsavedEdits {
                repairs.remove(&args.candidate_id);
            }
            ApiResult::err_with_details(
                AppError::message(error.to_string()),
                serde_json::json!({
                    "code": error.code,
                    "rollback": error.rollback,
                    "paths": error.paths,
                }),
            )
        }
    }
}
