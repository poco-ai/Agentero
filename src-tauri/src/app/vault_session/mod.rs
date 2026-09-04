//! Active Vault session coordination owned by the application shell.

pub mod fs_scope;
pub mod lifecycle;

pub(super) fn vault_path_arg(
    path: &str,
) -> Result<std::path::PathBuf, crate::core::error::AppError> {
    let p = std::path::PathBuf::from(path.trim());
    if p.as_os_str().is_empty() {
        return Err(crate::core::error::AppError::message("path is required"));
    }
    Ok(p)
}
