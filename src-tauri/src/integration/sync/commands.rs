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

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncVaultArgs {
    pub vault_path: String,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfigureArgs {
    pub vault_path: String,
    pub config: SyncBackendConfig,
}

#[derive(Debug, Serialize, specta::Type)]
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

pub fn account_api_origin() -> String {
    let local = cfg!(debug_assertions) && option_env!("AGENTERO_LOCAL_AUTH") == Some("1");
    if local {
        "http://localhost:8788".into()
    } else {
        "https://api.agentero.app".into()
    }
}

pub async fn session_bearer(app: &AppHandle) -> Option<String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        use tauri_plugin_better_auth::BetterAuthExt;
        return app
            .better_auth()
            .bearer_token()
            .await
            .filter(|token| !token.trim().is_empty());
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = app;
        None
    }
}

async fn attach_agentero_session(app: &AppHandle, cfg: &mut SyncBackendConfig) {
    if cfg.backend != super::config::SyncBackendKind::Agentero {
        return;
    }
    if cfg.agentero_api.trim().is_empty() {
        cfg.agentero_api = account_api_origin();
    }
    if let Some(token) = session_bearer(app).await {
        cfg.agentero_token = token;
    }
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
#[specta::specta]
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
#[specta::specta]
pub async fn sync_configure(
    app: AppHandle,
    service: State<'_, SyncService>,
    args: SyncConfigureArgs,
) -> Result<ApiResult<SyncStatus>, String> {
    let key = args.vault_path.trim().to_string();
    let inner = async {
        let dir = vault_dir(&args.vault_path)?;
        let _lock = agentero_core::features::sync::lock::SyncLock::try_acquire(&dir)?
            .ok_or_else(|| AppError::message("another vault sync is running"))?;
        let mut cfg = args.config.normalized();
        cfg.merge_mask(config::get(&key).as_ref());
        attach_agentero_session(&app, &mut cfg).await;
        cfg.validate()?;
        cfg.conditional_writes = engine::test_connection(&dir, &cfg).await?;
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
#[specta::specta]
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
#[derive(Debug, Default, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncScopeSizes {
    pub pdf: u64,
    pub source: u64,
    pub attachments: u64,
}

#[tauri::command]
#[specta::specta]
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
    let mut cfg =
        config::get(vault_key).ok_or_else(|| AppError::message("sync is not configured"))?;
    attach_agentero_session(app, &mut cfg).await;
    let lease = service
        .try_begin(vault_key)
        .ok_or_else(|| AppError::message("sync already running"))?;
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
    let result = engine::sync_vault_locked(&dir, &cfg, &progress).await;
    // Terminal event consumers immediately re-read status; release first.
    drop(lease);
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
#[specta::specta]
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

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncCloudUsageArgs {
    /// `user` or `organization`.
    pub subject: String,
    pub org_id: Option<String>,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncCloudUsage {
    pub signed_in: bool,
    pub used: u64,
    pub limit: i64,
    pub tier: String,
    pub plan_key: String,
}

fn signed_out_usage() -> SyncCloudUsage {
    SyncCloudUsage {
        signed_in: false,
        used: 0,
        limit: 0,
        tier: String::new(),
        plan_key: String::new(),
    }
}

/// Used and included bytes for the signed-in personal or team space.
/// The bearer stays in the keychain; the webview only sees the numbers.
#[tauri::command]
#[specta::specta]
pub async fn sync_cloud_usage(
    app: AppHandle,
    args: SyncCloudUsageArgs,
) -> Result<ApiResult<SyncCloudUsage>, String> {
    let Some(token) = session_bearer(&app).await else {
        return Ok(ApiResult::ok(signed_out_usage()));
    };
    let subject = if args.subject == "organization" {
        "organization"
    } else {
        "user"
    };
    if subject == "organization" && args.org_id.as_deref().unwrap_or("").trim().is_empty() {
        return Ok(ApiResult::ok(SyncCloudUsage {
            signed_in: true,
            ..signed_out_usage()
        }));
    }
    let mut url = format!("{}/api/sync/usage?subject={subject}", account_api_origin());
    if subject == "organization" {
        let id = args.org_id.unwrap_or_default();
        url.push_str("&id=");
        for byte in id.bytes() {
            match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    url.push(byte as char);
                }
                _ => url.push_str(&format!("%{byte:02X}")),
            }
        }
    }
    let client = match crate::core::http::client_builder().build() {
        Ok(client) => client,
        Err(e) => return Ok(map_err(AppError::message(e.to_string()))),
    };
    let response = match client.get(url).bearer_auth(token).send().await {
        Ok(response) => response,
        Err(e) => return Ok(map_err(AppError::message(e.to_string()))),
    };
    if response.status().as_u16() == 401 {
        return Ok(ApiResult::ok(signed_out_usage()));
    }
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Ok(map_err(AppError::message(format!(
            "cloud usage: {status} {}",
            body.chars().take(180).collect::<String>()
        ))));
    }
    let payload: serde_json::Value = match response.json().await {
        Ok(payload) => payload,
        Err(e) => return Ok(map_err(AppError::message(format!("cloud usage: {e}")))),
    };
    let data = payload.get("data").cloned().unwrap_or(payload);
    Ok(ApiResult::ok(SyncCloudUsage {
        signed_in: true,
        used: data.get("used").and_then(|v| v.as_u64()).unwrap_or(0),
        limit: data.get("limit").and_then(|v| v.as_i64()).unwrap_or(0),
        tier: data
            .get("tier")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        plan_key: data
            .get("planKey")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    }))
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

/// Anti-drift: bind the owned `SyncStateEvent` / `SyncProgressEvent` mirrors
/// (in `app::events_contract`, feeding the `sync:state` / `sync:progress`
/// payload types in bindings.ts) to the private borrowed structs actually
/// emitted here. Borrowed fields (`&str`) cannot share compile-time type
/// identity with the owned mirror, so the binding is the serde shape (covers
/// `rename_all` + `skip_serializing_if`); the owned `usize` counters are also
/// type-bound.
#[cfg(test)]
mod events_contract_shape_tests {
    use super::{SyncProgressEvent, SyncStateEvent};
    use crate::app::events_contract::{
        SyncProgressEvent as MirrorSyncProgress, SyncStateEvent as MirrorSyncState,
    };

    #[test]
    fn sync_state_mirror_matches_emit_payload_shape() {
        let real = SyncStateEvent {
            vault_path: "/vault",
            status: "configured",
            error: Some("offline".to_string()),
        };
        let mirror = MirrorSyncState {
            vault_path: "/vault".to_string(),
            status: "configured".to_string(),
            error: Some("offline".to_string()),
        };
        assert_eq!(
            serde_json::to_value(&real).unwrap(),
            serde_json::to_value(&mirror).unwrap(),
            "SyncStateEvent mirror drifted from the emitted payload"
        );
        let real_none = SyncStateEvent {
            vault_path: "/vault",
            status: "disconnected",
            error: None,
        };
        let mirror_none = MirrorSyncState {
            vault_path: "/vault".to_string(),
            status: "disconnected".to_string(),
            error: None,
        };
        assert_eq!(
            serde_json::to_value(&real_none).unwrap(),
            serde_json::to_value(&mirror_none).unwrap(),
            "SyncStateEvent mirror drifted from the emitted payload (None variant)"
        );
    }

    #[test]
    fn sync_progress_mirror_matches_emit_payload_shape() {
        let real = SyncProgressEvent {
            vault_path: "/vault",
            phase: "upload",
            current: 3,
            total: 10,
        };
        let mirror = MirrorSyncProgress {
            vault_path: "/vault".to_string(),
            phase: "upload".to_string(),
            current: 3,
            total: 10,
        };
        assert_eq!(
            serde_json::to_value(&real).unwrap(),
            serde_json::to_value(&mirror).unwrap(),
            "SyncProgressEvent mirror drifted from the emitted payload"
        );
        fn eq_type<T>(_: &T, _: &T) {}
        eq_type(&real.current, &mirror.current);
        eq_type(&real.total, &mirror.total);
    }
}
