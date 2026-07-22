use crate::error::AppError;
use crate::log_util::{trunc, OpTimer};
use crate::services::vault::{self, CreateVaultResult};
use std::path::{Path, PathBuf};

fn vault_path_arg(path: &str) -> Result<std::path::PathBuf, AppError> {
    let p = PathBuf::from(path.trim());
    if p.as_os_str().is_empty() {
        return Err(AppError::invalid("path is required"));
    }
    Ok(p)
}

/// Extend the webview fs scope to the vault root (recursive) so plugin-fs
/// reads/writes work without a blanket `$HOME/**` static scope. Persisted
/// across restarts by `tauri-plugin-persisted-scope`.
fn allow_vault_scope(app: &tauri::AppHandle, root: &Path) {
    use tauri_plugin_fs::FsExt;
    if let Err(err) = app.fs_scope().allow_directory(root, true) {
        log::warn!("fs scope grant failed for {}: {}", root.display(), err);
    }
}

/// Create / scaffold a Agentero vault at the given absolute path.
#[tauri::command]
pub fn vault_create(app: tauri::AppHandle, path: String) -> Result<CreateVaultResult, AppError> {
    let op = OpTimer::start_with("vault_create", format!("path={}", trunc(&path, 200)));
    op.finish(vault_path_arg(&path).and_then(|p| {
        let result = vault::create_vault(&p);
        if result.is_ok() {
            allow_vault_scope(&app, &p);
        }
        result
    }))
}

/// Ensure vault scaffold + seed any **missing** bundled skills (no overwrite).
///
/// Call on vault open so app updates can ship new `.agents/skills/*` without
/// requiring the user to re-run Create Vault.
#[tauri::command]
pub fn vault_ensure(app: tauri::AppHandle, path: String) -> Result<CreateVaultResult, AppError> {
    let op = OpTimer::start_with("vault_ensure", format!("path={}", trunc(&path, 200)));
    op.finish(vault_path_arg(&path).and_then(|p| {
        let result = vault::ensure_vault(&p);
        if result.is_ok() {
            allow_vault_scope(&app, &p);
        }
        result
    }))
}

/// Probe an existing vault directory and, when present, grant it to the
/// webview fs scope. Unlike `vault_ensure` this never creates directories,
/// so it is safe as an existence check for restore / recent-vault flows.
#[tauri::command]
pub fn vault_authorize(app: tauri::AppHandle, path: String) -> Result<bool, AppError> {
    let op = OpTimer::start_with("vault_authorize", format!("path={}", trunc(&path, 200)));
    op.finish(vault_path_arg(&path).map(|p| {
        let exists = p.is_dir();
        if exists {
            allow_vault_scope(&app, &p);
        }
        exists
    }))
}
