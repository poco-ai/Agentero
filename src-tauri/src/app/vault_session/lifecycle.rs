//! Cross-feature lifecycle coordination for the active Vault session.

use crate::app::command_util::vault_path_arg;
use crate::app::vault_session::holder_key;
use crate::app::vault_session::VaultHolders;
use crate::core::error::{map_err, ApiResult};
use crate::core::log_util::{trunc, OpTimer};
use crate::features::jobs::{emit_job_changed, JobCenter};
use crate::features::paper::catalog::CapsCache;
use tauri::Manager;

/// Register this window as a holder of `vault`.
///
/// Paired with [`vault_release`]: a window holds a vault for as long as its
/// frontend `vault:opened` scope is live (hold in setup, release in teardown),
/// so the vault-global release below only runs when the last window lets go.
/// Idempotent per (vault, window).
#[tauri::command]
#[specta::specta]
pub async fn vault_hold(window: tauri::WebviewWindow, path: String) -> ApiResult<()> {
    let op = OpTimer::start_with("vault_hold", format!("path={}", trunc(&path, 200)));
    if let Err(err) = vault_path_arg(&path) {
        op.finish_err(&err);
        return map_err(err);
    }
    // Ordering: the holder-set mutation below has no await, so the observed
    // order comes from the single-threaded frontend sender; no FIFO is assumed
    // (async commands are spawned onto the runtime, and the canonicalization
    // awaited below already yields to the blocking pool). A theoretical
    // hold/release reorder leaves a stale hold that the window-destroyed drain
    // in `app::mod` cleans up.
    let key = holder_key(&path).await;
    window.state::<VaultHolders>().hold(&key, window.label());
    op.finish_result(Ok(()))
}

/// Release Host-side resources held for a vault the app switched away from.
///
/// Feature-specific cleanup remains owned by each feature; the app shell only
/// orchestrates the cross-feature release sequence, and only once the calling
/// window was the last holder of the vault (see [`VaultHolders`]).
#[tauri::command]
#[specta::specta]
pub async fn vault_release(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> ApiResult<()> {
    let op = OpTimer::start_with("vault_release", format!("path={}", trunc(&path, 200)));
    if let Err(err) = vault_path_arg(&path) {
        op.finish_err(&err);
        return map_err(err);
    }
    // Same key normalization as `vault_hold`; the canonical key doubles as the
    // vault path for the release sequence (`cancel_for_vault` /
    // `evict_catalog_conn` re-canonicalize internally, so this is idempotent).
    let key = holder_key(&path).await;

    // Window-level scope: other windows may still hold this vault open, so the
    // global release below only runs for the last holder. With no entry on
    // record (e.g. a window that missed its `vault_hold`, or a canonicalize
    // fallback for an already-deleted directory) `release` deliberately still
    // returns `true` — the single-window compatibility fallback in
    // `VaultHolders::release`.
    let last_holder = window.state::<VaultHolders>().release(&key, window.label());
    if last_holder {
        release_vault_resources(&app, std::path::Path::new(&key)).await;
    }
    op.finish_result(Ok(()))
}

/// The vault-global release sequence: cancel in-flight jobs for the vault,
/// drain freed slots, clear the paper caps cache and evict the catalog
/// connection. Shared by [`vault_release`] and the window-destroyed holder
/// cleanup in `app::mod`.
pub(crate) async fn release_vault_resources(app: &tauri::AppHandle, vault: &std::path::Path) {
    let jobs = app.state::<JobCenter>().handle();
    let cancelled = jobs.cancel_for_vault(vault).await;
    for snapshot in cancelled {
        emit_job_changed(app, snapshot);
    }
    jobs.drain_and_spawn(app).await;

    app.state::<CapsCache>().clear();
    crate::features::paper::catalog::evict_catalog_conn(vault);
    app.state::<crate::features::web::html_preview::HtmlPreviewGrants>()
        .revoke_vault(vault);
}
