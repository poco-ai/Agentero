//! Shared preflight helpers and macros for `#[tauri::command]` shells.
//!
//! Commands report failures as resolved promises carrying an `ApiResult`
//! error object — never a rejected IPC `Err` —
//! so every preflight repeats the same early-return `match` on
//! `map_err`. These macros expand to exactly the hand-written shape (IPC
//! error semantics unchanged) and stay await-compatible inside async command
//! bodies, which a `with_vault(|vault| …)` closure cannot be.
//!
//! Two return conventions coexist and each macro targets one:
//!
//! - plain `ApiResult<T>` (or a `run_blocking` closure returning it):
//!   [`try_vault`] / [`lock_wiki_index`] early `return map_err(err)`.
//! - `Result<ApiResult<T>, String>` (State-borrowing async commands):
//!   [`try_vault_ok`] / [`try_session`] early `return Ok(map_err(err))`.
//!
//! An optional trailing `$op` ([`OpTimer`](crate::core::log_util::OpTimer))
//! logs the preflight failure (`op.finish_err(&err)`) before returning.

/// Trim a path argument and reject empty input without resolving the vault.
pub(crate) fn vault_path_arg(
    path: &str,
) -> Result<std::path::PathBuf, crate::core::error::AppError> {
    let p = std::path::PathBuf::from(path.trim());
    if p.as_os_str().is_empty() {
        return Err(crate::core::error::AppError::message("path is required"));
    }
    Ok(p)
}

/// Resolve a vault path (trim + remote-handle aware) or early-return the
/// `ApiResult` error object.
macro_rules! try_vault {
    ($path:expr $(, $op:expr)?) => {
        match $crate::core::fs::resolve_vault($path) {
            Ok(vault) => vault,
            Err(err) => {
                $($op.finish_err(&err);)?
                return $crate::core::error::map_err(err);
            }
        }
    };
}

/// [`try_vault!`] for commands returning `Result<ApiResult<T>, String>`
/// (State-borrowing async commands).
macro_rules! try_vault_ok {
    ($path:expr $(, $op:expr)?) => {
        match $crate::core::fs::resolve_vault($path) {
            Ok(vault) => vault,
            Err(err) => {
                $($op.finish_err(&err);)?
                return Ok($crate::core::error::map_err(err));
            }
        }
    };
}

/// Look up a remote-vault session or early-return the IPC error object
/// (`Result<ApiResult<T>, String>` commands).
macro_rules! try_session {
    ($registry:expr, $id:expr $(, $op:expr)?) => {
        match $registry.get($id).await {
            Ok(session) => session,
            Err(err) => {
                $($op.finish_err(&err);)?
                return Ok($crate::core::error::map_err(err));
            }
        }
    };
}

/// Lock the global wiki index or early-return the `ApiResult` error object.
/// Expands to the `MutexGuard` itself, so it must form the `let` initializer —
/// a helper fn cannot hand out the guard without re-introducing a `match`.
/// With a vault path (`lock_wiki_index!(index, &vault_path)`) the freshly
/// locked index is additionally switched to that vault (`ensure_vault`).
/// An optional timer is passed as `lock_wiki_index!(index, &vault, op)` or
/// `lock_wiki_index!(index; op)` (bare lock; the `;` keeps it distinct from
/// the vault-argument form).
macro_rules! lock_wiki_index {
    ($index:expr, $vault_path:expr $(, $op:expr)?) => {{
        let mut guard = match $index.lock() {
            Ok(guard) => guard,
            Err(err) => {
                let err = $crate::core::error::AppError::message(format!("wiki index lock: {err}"));
                $($op.finish_err(&err);)?
                return $crate::core::error::map_err(err);
            }
        };
        if let Err(err) = guard.ensure_vault($vault_path) {
            let err = $crate::core::error::AppError::message(err);
            $($op.finish_err(&err);)?
            return $crate::core::error::map_err(err);
        }
        guard
    }};
    ($index:expr $(; $op:expr)?) => {
        match $index.lock() {
            Ok(guard) => guard,
            Err(err) => {
                let err = $crate::core::error::AppError::message(format!("wiki index lock: {err}"));
                $($op.finish_err(&err);)?
                return $crate::core::error::map_err(err);
            }
        }
    };
}

pub(crate) use lock_wiki_index;
pub(crate) use try_session;
pub(crate) use try_vault;
pub(crate) use try_vault_ok;
