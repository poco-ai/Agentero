//! Sync commands. Long-running `sync_now` broadcasts `sync:state` /
//! `sync:progress` events so the settings pane (and later a status bar
//! indicator) can follow along from any window.

use super::config::{self, SyncBackendConfig};
use super::engine::{self, SyncOutcome};
use super::local;
use super::snapshot;
use super::SyncService;
use crate::core::error::{map_err, ApiResult, AppError};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncVaultArgs {
    pub vault_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfigureArgs {
    pub vault_path: String,
    pub config: SyncBackendConfig,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<SyncBackendConfig>,
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_sync_at: Option<String>,
    pub last_version: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncStateEvent<'a> {
    vault_path: &'a str,
    status: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncProgressEvent<'a> {
    vault_path: &'a str,
    phase: &'a str,
    current: usize,
    total: usize,
}

fn vault_dir(vault_path: &str) -> Result<PathBuf, AppError> {
    let trimmed = vault_path.trim();
    if trimmed.is_empty() || trimmed.starts_with("remote:") {
        return Err(AppError::message("sync requires a local vault"));
    }
    crate::core::fs::resolve_vault(trimmed)
}

/// Current sync binding + last-pass info for the settings pane.
#[tauri::command]
pub async fn sync_get_status(
    args: SyncVaultArgs,
    service: State<'_, SyncService>,
) -> Result<ApiResult<SyncStatus>, String> {
    let running = service.is_running(args.vault_path.trim());
    Ok(match vault_dir(&args.vault_path) {
        Ok(dir) => {
            let meta = local::read_meta(&dir);
            let config = config::get(args.vault_path.trim());
            ApiResult::ok(SyncStatus {
                configured: config.is_some(),
                config: config.map(|c| c.masked()),
                running,
                last_sync_at: meta.last_sync_at,
                last_version: meta.last_version,
            })
        }
        Err(e) => map_err(e),
    })
}

/// Validate + connection-test + persist the S3 binding for a vault.
#[tauri::command]
pub async fn sync_configure(
    app: AppHandle,
    service: State<'_, SyncService>,
    args: SyncConfigureArgs,
) -> Result<ApiResult<SyncStatus>, String> {
    let key = args.vault_path.trim().to_string();
    let inner = async {
        let dir = vault_dir(&args.vault_path)?;
        let mut cfg = args.config.normalized();
        cfg.merge_mask(config::get(&key).as_ref());
        cfg.validate()?;
        cfg.conditional_writes = engine::test_connection(&cfg).await?;
        config::set(&key, cfg.clone())?;
        let meta = local::read_meta(&dir);
        Ok::<_, AppError>(SyncStatus {
            configured: true,
            config: Some(cfg.masked()),
            running: false,
            last_sync_at: meta.last_sync_at,
            last_version: meta.last_version,
        })
    };
    let result = inner.await;
    if result.is_ok() {
        service.restart_scheduler(&app, &key);
    }
    Ok(match result {
        Ok(status) => ApiResult::ok(status),
        Err(e) => map_err(e),
    })
}

/// Remove the binding and local sync state (remote data stays untouched).
#[tauri::command]
pub async fn sync_disconnect(
    service: State<'_, SyncService>,
    args: SyncVaultArgs,
) -> Result<ApiResult<()>, String> {
    let key = args.vault_path.trim().to_string();
    let inner = || {
        let dir = vault_dir(&args.vault_path)?;
        config::remove(&key)?;
        local::clear(&dir);
        Ok::<_, AppError>(())
    };
    Ok(match inner() {
        Ok(()) => {
            service.stop_scheduler(&key);
            ApiResult::ok(())
        }
        Err(e) => map_err(e),
    })
}

/// Local disk usage per bulky-asset category (bytes), for the sync-scope UI.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncScopeSizes {
    pub pdf: u64,
    pub source: u64,
    pub attachments: u64,
}

#[tauri::command]
pub async fn sync_scope_sizes(args: SyncVaultArgs) -> Result<ApiResult<SyncScopeSizes>, String> {
    let inner = async {
        let dir = vault_dir(&args.vault_path)?;
        tokio::task::spawn_blocking(move || {
            let mut sizes = SyncScopeSizes::default();
            let walker = walkdir::WalkDir::new(&dir)
                .follow_links(false)
                .into_iter()
                .filter_entry(|e| {
                    e.depth() == 0 || !snapshot::is_ignored_name(&e.file_name().to_string_lossy())
                });
            for entry in walker.flatten() {
                if !entry.file_type().is_file() {
                    continue;
                }
                let Some(rel) = entry
                    .path()
                    .strip_prefix(&dir)
                    .ok()
                    .and_then(|p| p.to_str())
                    .map(|s| s.replace('\\', "/"))
                else {
                    continue;
                };
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                match snapshot::scope_category(&rel) {
                    Some("pdf") => sizes.pdf += size,
                    Some("source") => sizes.source += size,
                    Some("attachments") => sizes.attachments += size,
                    _ => {}
                }
            }
            sizes
        })
        .await
        .map_err(|e| AppError::message(format!("scope sizes: {e}")))
    };
    Ok(match inner.await {
        Ok(sizes) => ApiResult::ok(sizes),
        Err(e) => map_err(e),
    })
}

/// One full sync pass shared by the `sync_now` command and the auto-sync
/// scheduler (scan → merge → apply → publish).
pub async fn perform_sync(
    app: &AppHandle,
    service: &SyncService,
    vault_key: &str,
) -> Result<SyncOutcome, AppError> {
    let dir = vault_dir(vault_key)?;
    let cfg = config::get(vault_key).ok_or_else(|| AppError::message("sync is not configured"))?;
    if !service.try_begin(vault_key) {
        return Err(AppError::message("sync already running"));
    }
    emit_state(app, vault_key, "syncing", None);
    let progress_app = app.clone();
    let progress_key = vault_key.to_string();
    let progress = move |phase: &str, current: usize, total: usize| {
        let _ = progress_app.emit(
            "sync:progress",
            SyncProgressEvent {
                vault_path: &progress_key,
                phase,
                current,
                total,
            },
        );
    };
    let result = engine::sync_vault(&dir, &cfg, &progress).await;
    service.end(vault_key);
    match result {
        Ok(outcome) => {
            emit_state(app, vault_key, "idle", None);
            Ok(outcome)
        }
        Err(e) => {
            emit_state(app, vault_key, "error", Some(e.to_string()));
            Err(e)
        }
    }
}

/// One full sync pass (manual trigger from the settings pane).
#[tauri::command]
pub async fn sync_now(
    app: AppHandle,
    service: State<'_, SyncService>,
    args: SyncVaultArgs,
) -> Result<ApiResult<SyncOutcome>, String> {
    use crate::core::log_util::OpTimer;

    let vault_key = args.vault_path.trim().to_string();
    let op = OpTimer::start_with("sync_now", format!("vault={vault_key}"));
    match perform_sync(&app, &service, &vault_key).await {
        Ok(outcome) => {
            op.finish_ok_extra(format!(
                "version={} up={} down={} conflicts={}",
                outcome.version,
                outcome.uploaded,
                outcome.downloaded,
                outcome.conflict_copies.len()
            ));
            Ok(ApiResult::ok(outcome))
        }
        Err(e) => {
            op.finish_err(&e);
            Ok(map_err(e))
        }
    }
}

fn emit_state(app: &AppHandle, vault_path: &str, status: &str, error: Option<String>) {
    let _ = app.emit(
        "sync:state",
        SyncStateEvent {
            vault_path,
            status,
            error,
        },
    );
}
