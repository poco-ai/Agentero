//! Sync commands. Long-running `sync_now` broadcasts `sync:state` /
//! `sync:progress` events so the settings pane (and later a status bar
//! indicator) can follow along from any window.

use super::config::{self, SyncBackendConfig};
use super::engine::{self, SyncOutcome};
use super::local;
use super::snapshot;
use super::SyncService;
use crate::core::error::{map_err, ApiResult, AppError};
use agentero_core::features::sync::lock::SyncLock;
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
    /// Read-only mirrors published after the primary pass. The primary stays
    /// the only backend that pulls and merges.
    #[serde(default)]
    pub mirrors: Vec<SyncBackendConfig>,
}

/// One read-only mirror and its last pass result.
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncMirrorStatus {
    pub config: SyncBackendConfig,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_sync_at: Option<String>,
    pub last_version: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
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
    /// Mirrors in configuration order; empty for a single-backend binding.
    #[serde(default)]
    pub mirrors: Vec<SyncMirrorStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncStateEvent<'a> {
    vault_path: &'a str,
    status: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    /// Stable domain code of `error` (e.g. `sync_no_conditional_writes`) so
    /// listeners can localize without matching message text.
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncProgressEvent<'a> {
    vault_path: &'a str,
    phase: &'a str,
    current: usize,
    total: usize,
}

/// Per-mirror pass state. Progress phases stay vault-level, so a mirror run is
/// reported as one `started` → `published` | `error` pair instead.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncMirrorEvent<'a> {
    vault_path: &'a str,
    /// Zero-based position in the vault's mirror list (matches
    /// `SyncStatus.mirrors[]` while the saved binding is unchanged).
    index: usize,
    /// `SyncBackendConfig::remote_identity` — matches `SyncStatus.mirrors[].config`.
    identity: &'a str,
    backend: &'a str,
    /// `started` | `published` | `error`.
    status: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a str>,
}

fn backend_label(backend: config::SyncBackendKind) -> &'static str {
    match backend {
        config::SyncBackendKind::S3 => "s3",
        config::SyncBackendKind::Webdav => "webdav",
        config::SyncBackendKind::Git => "git",
        config::SyncBackendKind::Agentero => "agentero",
    }
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
    let dir = match vault_dir(&args.vault_path) {
        Ok(dir) => dir,
        Err(e) => return Ok(map_err(e)),
    };
    let meta = match local::read_meta(&dir) {
        Ok(meta) => meta,
        Err(e) => return Ok(map_err(e)),
    };
    let config = config::get(args.vault_path.trim());
    let mirrors = config
        .as_ref()
        .map(|binding| mirror_statuses(&dir, binding))
        .unwrap_or_default();
    Ok(ApiResult::ok(SyncStatus {
        configured: config.is_some(),
        config: config.map(|binding| binding.primary.masked()),
        running,
        last_sync_at: meta.last_sync_at,
        last_version: meta.last_version,
        mirrors,
    }))
}

/// Per-mirror status in configuration order.
fn mirror_statuses(
    dir: &std::path::Path,
    binding: &config::VaultSyncConfig,
) -> Vec<SyncMirrorStatus> {
    binding
        .mirrors
        .iter()
        .map(|mirror| {
            let state = engine::mirror_state(dir, mirror);
            SyncMirrorStatus {
                config: mirror.masked(),
                last_sync_at: state.last_sync_at,
                last_version: state.last_version,
                last_error: state.last_error,
            }
        })
        .collect()
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
        let _lock = SyncLock::acquire(&dir)?;
        let mut binding = config::VaultSyncConfig {
            primary: args.config.normalized(),
            mirrors: args
                .mirrors
                .into_iter()
                .map(SyncBackendConfig::normalized)
                .collect(),
        };
        binding.merge_mask(config::get(&key).as_ref());
        attach_agentero_session(&app, &mut binding.primary).await;
        binding.validate()?;
        if binding.duplicate_remote().is_some() {
            return Err(AppError::message(
                "the same remote is configured twice; each backend needs its own store",
            ));
        }
        binding.primary.conditional_writes =
            engine::test_connection(&dir, &binding.primary).await?;
        for mirror in &mut binding.mirrors {
            // Mirrors only need a reachable target: a Git mirror branch is a
            // push target, not the vault's own branch, and object stores need
            // conditional writes for the HEAD CAS.
            mirror.conditional_writes = engine::test_mirror_connection(&dir, mirror).await?;
        }
        let meta = local::read_meta(&dir)?;
        config::set(&key, binding.clone())?;
        let mirrors = mirror_statuses(&dir, &binding);
        Ok::<_, AppError>(SyncStatus {
            configured: true,
            config: Some(binding.primary.masked()),
            running: false,
            last_sync_at: meta.last_sync_at,
            last_version: meta.last_version,
            mirrors,
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
        let lock = SyncLock::acquire(&dir)?;
        config::disconnect(&key, &lock)
    };
    Ok(match inner() {
        Ok(()) => {
            service.stop_scheduler(&key);
            ApiResult::ok(())
        }
        Err(e) => map_err(e),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn sync_scope_sizes(
    args: SyncVaultArgs,
) -> Result<ApiResult<snapshot::SyncScopeSizes>, String> {
    let inner = async {
        let dir = vault_dir(&args.vault_path)?;
        tokio::task::spawn_blocking(move || snapshot::scope_sizes(&dir))
            .await
            .map_err(|e| AppError::message(format!("scope sizes: {e}")))?
    };
    Ok(match inner.await {
        Ok(sizes) => ApiResult::ok(sizes),
        Err(e) => map_err(e),
    })
}

/// One full sync pass shared by the `sync_now` command and the auto-sync
/// scheduler (scan → merge → publish → apply).
pub async fn perform_sync(
    app: &AppHandle,
    service: &SyncService,
    vault_key: &str,
) -> Result<SyncOutcome, AppError> {
    let dir = vault_dir(vault_key)?;
    let lock = SyncLock::acquire(&dir)?;
    let mut binding =
        config::get(vault_key).ok_or_else(|| AppError::message("sync is not configured"))?;
    attach_agentero_session(app, &mut binding.primary).await;
    let lease = service
        .try_begin(vault_key)
        .ok_or_else(|| AppError::message("sync already running"))?;
    emit_state(app, vault_key, "syncing", None, None);
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
    let mirror_app = app.clone();
    let mirror_key = vault_key.to_string();
    let mirror_watch = move |index: usize,
                             mirror: &config::SyncBackendConfig,
                             phase: engine::MirrorPhase,
                             error: Option<&str>| {
        let status = match phase {
            engine::MirrorPhase::Started => "started",
            engine::MirrorPhase::Published => "published",
            engine::MirrorPhase::Failed => "error",
        };
        let _ = mirror_app.emit(
            "sync:mirror",
            SyncMirrorEvent {
                vault_path: &mirror_key,
                index,
                identity: &mirror.remote_identity(),
                backend: backend_label(mirror.backend),
                status,
                error,
            },
        );
    };
    let result = engine::sync_all_locked(&lock, &binding, &progress, Some(&mirror_watch)).await;
    drop(lock);
    // Terminal event consumers immediately re-read status; release first.
    drop(lease);
    match result {
        Ok(outcome) => {
            emit_state(app, vault_key, "idle", None, None);
            Ok(outcome)
        }
        Err(e) => {
            emit_state(
                app,
                vault_key,
                "error",
                Some(e.to_string()),
                Some(e.code().to_string()),
            );
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
pub struct SyncOverwriteArgs {
    pub vault_path: String,
    pub direction: engine::OverwriteDirection,
}

/// Read-only impact preview for the manual-overwrite confirmation dialog.
#[tauri::command]
#[specta::specta]
pub async fn sync_overwrite_preview(
    args: SyncOverwriteArgs,
) -> Result<ApiResult<engine::OverwritePreview>, String> {
    let key = args.vault_path.trim().to_string();
    let inner = async {
        let dir = vault_dir(&key)?;
        let binding =
            config::get(&key).ok_or_else(|| AppError::message("sync is not configured"))?;
        engine::overwrite_preview(&dir, &binding.primary, args.direction).await
    };
    Ok(match inner.await {
        Ok(preview) => ApiResult::ok(preview),
        Err(error) => map_err(error),
    })
}

/// Manual overwrite: `remoteToLocal` mirrors the remote HEAD onto disk
/// (discarding divergent local content); `localToRemote` publishes the local
/// scan as the new HEAD. The UI confirms with a preview before calling this.
#[tauri::command]
#[specta::specta]
pub async fn sync_overwrite(
    app: AppHandle,
    service: State<'_, SyncService>,
    args: SyncOverwriteArgs,
) -> Result<ApiResult<SyncOutcome>, String> {
    use crate::core::log_util::OpTimer;

    let vault_key = args.vault_path.trim().to_string();
    let op = OpTimer::start_with(
        "sync_overwrite",
        format!("vault={vault_key} direction={:?}", args.direction),
    );
    let inner = async {
        let dir = vault_dir(&vault_key)?;
        let lock = SyncLock::acquire(&dir)?;
        let binding =
            config::get(&vault_key).ok_or_else(|| AppError::message("sync is not configured"))?;
        let lease = service
            .try_begin(&vault_key)
            .ok_or_else(|| AppError::message("sync already running"))?;
        emit_state(&app, &vault_key, "syncing", None, None);
        let progress_app = app.clone();
        let progress_key = vault_key.clone();
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
        let result =
            engine::overwrite_locked(&lock, &binding.primary, args.direction, &progress).await;
        drop(lock);
        // Terminal event consumers immediately re-read status; release first.
        drop(lease);
        match &result {
            Ok(_) => emit_state(&app, &vault_key, "idle", None, None),
            Err(e) => emit_state(
                &app,
                &vault_key,
                "error",
                Some(e.to_string()),
                Some(e.code().to_string()),
            ),
        }
        result
    };
    match inner.await {
        Ok(outcome) => {
            op.finish_ok_extra(format!(
                "version={} up={} down={} deletedLocal={}",
                outcome.version, outcome.uploaded, outcome.downloaded, outcome.deleted_local
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

fn emit_state(
    app: &AppHandle,
    vault_path: &str,
    status: &str,
    error: Option<String>,
    error_code: Option<String>,
) {
    let _ = app.emit(
        "sync:state",
        SyncStateEvent {
            vault_path,
            status,
            error,
            error_code,
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
    use super::{SyncMirrorEvent, SyncProgressEvent, SyncStateEvent};
    use crate::app::events_contract::{
        SyncMirrorEvent as MirrorSyncMirror, SyncProgressEvent as MirrorSyncProgress,
        SyncStateEvent as MirrorSyncState,
    };

    #[test]
    fn sync_state_mirror_matches_emit_payload_shape() {
        let real = SyncStateEvent {
            vault_path: "/vault",
            status: "configured",
            error: Some("offline".to_string()),
            error_code: Some("sync_unreachable".to_string()),
        };
        let mirror = MirrorSyncState {
            vault_path: "/vault".to_string(),
            status: "configured".to_string(),
            error: Some("offline".to_string()),
            error_code: Some("sync_unreachable".to_string()),
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
            error_code: None,
        };
        let mirror_none = MirrorSyncState {
            vault_path: "/vault".to_string(),
            status: "disconnected".to_string(),
            error: None,
            error_code: None,
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

    #[test]
    fn sync_mirror_mirror_matches_emit_payload_shape() {
        let real = SyncMirrorEvent {
            vault_path: "/vault",
            index: 0,
            identity: "git|git@example.com:me/vault.git|main",
            backend: "git",
            status: "error",
            error: Some("push rejected"),
        };
        let mirror = MirrorSyncMirror {
            vault_path: "/vault".to_string(),
            index: 0,
            identity: "git|git@example.com:me/vault.git|main".to_string(),
            backend: "git".to_string(),
            status: "error".to_string(),
            error: Some("push rejected".to_string()),
        };
        assert_eq!(
            serde_json::to_value(&real).unwrap(),
            serde_json::to_value(&mirror).unwrap(),
            "SyncMirrorEvent mirror drifted from the emitted payload"
        );
        let real_none = SyncMirrorEvent {
            vault_path: "/vault",
            index: 0,
            identity: "git|git@example.com:me/vault.git|main",
            backend: "git",
            status: "published",
            error: None,
        };
        let mirror_none = MirrorSyncMirror {
            vault_path: "/vault".to_string(),
            index: 0,
            identity: "git|git@example.com:me/vault.git|main".to_string(),
            backend: "git".to_string(),
            status: "published".to_string(),
            error: None,
        };
        assert_eq!(
            serde_json::to_value(&real_none).unwrap(),
            serde_json::to_value(&mirror_none).unwrap(),
            "SyncMirrorEvent mirror drifted from the emitted payload (None variant)"
        );
    }
}
