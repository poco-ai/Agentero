use crate::core::error::{map_err, ApiResult};

use super::{
    add_shim_dir_to_user_path, cli_command_name, collect_status, ensure_cli_binary, install_shim,
    managed_cli_binary, managed_cli_dir, managed_shim_path, remove_shim_dir_from_user_path,
    resolve_local_cli, uninstall_shim, CliInstallResult, CliInstallStatus,
};
use tauri::{AppHandle, Runtime};

#[tauri::command]
pub fn cli_install_status<R: Runtime>(app: AppHandle<R>) -> ApiResult<CliInstallStatus> {
    ApiResult::ok(collect_status(&app))
}

#[tauri::command]
pub async fn cli_install_command<R: Runtime>(app: AppHandle<R>) -> ApiResult<CliInstallResult> {
    let (binary, action) = match ensure_cli_binary(&app).await {
        Ok(v) => v,
        Err(e) => return map_err(e),
    };
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
pub fn cli_uninstall_command<R: Runtime>(app: AppHandle<R>) -> ApiResult<CliInstallResult> {
    let local = resolve_local_cli(&app);
    let binary = local.as_ref().map(|r| r.path.as_path());
    let shim = managed_shim_path();
    match uninstall_shim(&shim, binary) {
        Ok(_) => {}
        Err(e) => return map_err(e),
    }
    // Drop download cache only (never delete dev target/ or App bundle binaries).
    let managed = managed_cli_binary();
    if managed.is_file() {
        let _ = std::fs::remove_file(&managed);
        let _ = std::fs::remove_dir(managed_cli_dir());
    }
    // Windows: best-effort removal of the shim dir from the user PATH.
    if let Err(e) = remove_shim_dir_from_user_path() {
        log::warn!("cli uninstall: failed to remove shim dir from user PATH: {e}");
    }
    let mut status = collect_status(&app);
    status.message = Some("Removed the Agentero-managed CLI shim.".into());
    ApiResult::ok(CliInstallResult {
        status,
        action: "uninstall".into(),
    })
}
