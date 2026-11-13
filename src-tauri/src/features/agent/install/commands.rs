use crate::core::error::{map_err, ApiResult, AppError};

use super::{
    add_shim_dir_to_user_path, cli_command_name, collect_status, ensure_cli_binary,
    ensure_pdfium_beside, install_shim, managed_cli_binary, managed_cli_dir, managed_shim_path,
    remove_managed_pdfium, remove_shim_dir_from_user_path, resolve_local_cli, uninstall_shim,
    CliInstallResult, CliInstallStatus,
};
use tauri::{AppHandle, Runtime};

#[tauri::command]
#[specta::specta]
pub async fn cli_install_status<R: Runtime>(app: AppHandle<R>) -> ApiResult<CliInstallStatus> {
    // `collect_status` spawns the CLI binary to read its version; on the main
    // thread (sync command) that freezes the whole UI on every About open.
    match tauri::async_runtime::spawn_blocking(move || collect_status(&app)).await {
        Ok(status) => ApiResult::ok(status),
        Err(e) => map_err(AppError::message(format!("CLI status probe failed: {e}"))),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn cli_install_command<R: Runtime>(app: AppHandle<R>) -> ApiResult<CliInstallResult> {
    let (binary, action) = match ensure_cli_binary(&app).await {
        Ok(v) => v,
        Err(e) => return map_err(e),
    };
    if let Err(e) = ensure_pdfium_beside(&binary) {
        return map_err(e);
    }
    let shim = managed_shim_path();
    if let Err(e) = install_shim(&binary, &shim) {
        return map_err(e);
    }
    // Windows: register the shim dir on the user PATH so `agentero-cli` works in
    // new terminals without manual setup. Non-fatal — the message below then
    // still points the user at the directory to add.
    if let Err(e) = add_shim_dir_to_user_path() {
        log::warn!("cli install: failed to add shim dir to user PATH: {e}");
    }
    let mut status = collect_status(&app);
    if !status.preferred_bin_on_path {
        status.message = Some(if cfg!(windows) {
            format!(
                "Installed to {}. Add that directory to the PATH environment variable if `{}` is not found in new terminals.",
                status.preferred_bin_dir,
                cli_command_name()
            )
        } else {
            format!(
                "Installed to {}. Add that directory to PATH if `{}` is not found in new terminals.",
                status.preferred_bin_dir,
                cli_command_name()
            )
        });
    } else {
        status.message = Some(format!(
            "Installed. Run `{} --version` in a new terminal.",
            cli_command_name()
        ));
    }
    ApiResult::ok(CliInstallResult {
        status,
        action: action.into(),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn cli_uninstall_command<R: Runtime>(app: AppHandle<R>) -> ApiResult<CliInstallResult> {
    match tauri::async_runtime::spawn_blocking(move || run_uninstall(&app)).await {
        Ok(Ok(result)) => ApiResult::ok(result),
        Ok(Err(e)) => map_err(e),
        Err(e) => map_err(AppError::message(format!("CLI uninstall failed: {e}"))),
    }
}

/// Blocking uninstall body (shim removal + status probe) for `spawn_blocking`.
fn run_uninstall<R: Runtime>(app: &AppHandle<R>) -> Result<CliInstallResult, AppError> {
    let local = resolve_local_cli(app);
    let binary = local.as_ref().map(|r| r.path.as_path());
    let shim = managed_shim_path();
    uninstall_shim(&shim, binary)?;
    // Drop download cache only (never delete dev target/ or App bundle binaries).
    let managed = managed_cli_binary();
    if managed.is_file() {
        let _ = std::fs::remove_file(&managed);
    }
    remove_managed_pdfium();
    let _ = std::fs::remove_dir(managed_cli_dir());
    // Windows: best-effort removal of the shim dir from the user PATH.
    if let Err(e) = remove_shim_dir_from_user_path() {
        log::warn!("cli uninstall: failed to remove shim dir from user PATH: {e}");
    }
    let mut status = collect_status(app);
    status.message = Some("Removed the Agentero-managed CLI shim.".into());
    Ok(CliInstallResult {
        status,
        action: "uninstall".into(),
    })
}
