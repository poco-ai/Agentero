//! Run synchronous catalog (rusqlite) work off the async runtime.
//!
//! rusqlite is blocking; calling it directly from an `async fn` stalls the
//! Tokio worker servicing Tauri commands / the connector server. [`blocking`]
//! moves that work onto the blocking thread pool.

use crate::error::AppError;

/// Execute blocking catalog work on the blocking thread pool.
///
/// The closure typically opens a short-lived rusqlite connection and runs one
/// query; connections are cheap to open with WAL, so a dedicated actor thread
/// would be over-engineering here.
pub async fn blocking<T, F>(f: F) -> Result<T, AppError>
where
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::internal(format!("catalog task failed: {e}")))?
}
