//! Sync engine: content-addressed blobs + immutable manifests + one mutable
//! `HEAD` pointer advanced with compare-and-swap.
//!
//! Remote layout under the configured prefix:
//!
//! ```text
//! vault.json                  { vaultId, formatVersion, encryption }
//! HEAD                        { version, manifestKey, updatedAt }   闂?CAS
//! manifests/<v>-<nonce>.json.gz
//! blobs/<aa>/<sha256>         gzip(file content)
//! ```
//!
//! One pass = scan 闂?three-way merge against the last synced manifest 闂?//! stage verified bytes 闂?upload blobs and manifest 闂?CAS `HEAD` 闂?apply locally. A lost CAS re-runs the merge against the winner's manifest.
//!
//! Passes that would change nothing stop early: an up-to-date vault returns
//! after the single `HEAD` read, and a pass whose merged manifest matches the
//! remote one adopts it instead of publishing. Request-metered backends
//! (Nutstore: 600 per 30 min on a free plan) make the idle cost the dominant
//! one, and republishing mtime drift used to advance `HEAD` forever.
//!
//! A pass interrupted mid-upload resumes instead of starting over:
//! `.agentero/sync/pushed.jsonl` records the blobs it already sent, which no
//! manifest can vouch for until `HEAD` moves.

use crate::error::AppError;
use crate::features::sync::config::{self, SyncBackendConfig, SyncBackendKind};
use crate::features::sync::local::{self, SyncMeta};
use crate::features::sync::scope;
use crate::features::sync::snapshot::{self, FileEntry, Manifest, SyncScope};
use crate::features::sync::store::{PutCondition, PutOutcome, RemoteStore, SyncStore};
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::Path;

mod apply;
mod journal;
mod recovery;
use apply::prepare_local;
pub use journal::configure_webdav_journal;

pub const FORMAT_VERSION: u32 = 1;
const HEAD_KEY: &str = "HEAD";
const VAULT_KEY: &str = "vault.json";
const MAX_CAS_RETRIES: usize = 5;
/// Decompressed manifest cap; a vault of 1M files serializes to ~150MB.
const MAX_MANIFEST_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteVaultInfo {
    vault_id: String,
    format_version: u32,
    encryption: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeadPointer {
    version: u64,
    manifest_key: String,
    updated_at: String,
}

#[derive(Debug, Default, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    pub version: u64,
    pub uploaded: usize,
    pub downloaded: usize,
    pub deleted_local: usize,
    pub removed_remote: usize,
    pub conflict_copies: Vec<String>,
}

/// `(phase, current, total)` 闂?totals of 0 mean indeterminate.
pub type Progress<'a> = &'a (dyn Fn(&str, usize, usize) + Send + Sync);

/// Test the configured endpoint and its conditional-write semantics.
pub async fn test_connection(vault: &Path, cfg: &SyncBackendConfig) -> Result<bool, AppError> {
    crate::features::sync::ensure_vault_sync_available(vault)?;
    if let Some(state) = journal::binding(vault, cfg)? {
        let client = super::webdav::WebdavClient::new(cfg)?;
        state.verify_remote(&client).await?;
        client.test_journal().await?;
        return Ok(false);
    }
    if cfg.backend == SyncBackendKind::Git {
        crate::features::sync::git::test_connection(vault, cfg).await?;
        return Ok(true);
    }
    // The probe must measure the server, not echo the persisted verdict: a
    // config re-saved with a different address (or after the server's
    // behavior changed) must re-evaluate conditional-write support instead
    // of preserving a stale `conditional_writes = false`.
    let mut probe = cfg.clone();
    crate::features::sync::config::hydrate_agentero(&mut probe);
    let client = SyncStore::new(&probe, vault)?;
    client.ensure_root().await?;
    client.probe_conditional_writes().await
}

async fn sync_vault(
    vault: &Path,
    cfg: &SyncBackendConfig,
    progress: Progress<'_>,
) -> Result<SyncOutcome, AppError> {
    crate::features::sync::ensure_vault_sync_available(vault)?;
    if let Some(state) = journal::binding(vault, cfg)? {
        return journal::run(vault, cfg, state, progress).await;
    }
    if cfg.backend == SyncBackendKind::Git {
        if recovery::unfinished(vault)? {
            return Err(AppError::message(
                "unfinished object sync; restore its binding or disconnect explicitly",
            ));
        }
        return crate::features::sync::git::sync_vault(vault, cfg, progress).await;
    }
    let mut cfg = cfg.clone();
    crate::features::sync::config::hydrate_agentero(&mut cfg);
    let client = SyncStore::new(&cfg, vault)?;
    run_sync(vault, &cfg, &client, progress).await
}

/// One sync pass under the cross-process vault lock: the desktop Host, the
/// CLI and cron jobs on the same machine serialize here. Fails with the
/// `sync_busy` domain code while another process is mid-pass, and records
/// any failure into `.agentero/sync/state.json` (`last_error`) so
/// `sync status` can explain the last failed pass.
pub async fn sync_vault_locked(
    lock: &super::lock::SyncLock,
    cfg: &SyncBackendConfig,
    progress: Progress<'_>,
) -> Result<SyncOutcome, AppError> {
    let vault = lock.vault();
    match sync_vault(vault, cfg, progress).await {
        Ok(outcome) => Ok(outcome),
        Err(e) => {
            local::record_error(vault, &e.to_string());
            Err(e)
        }
    }
}

/// Engine core, generic over the storage contract: `sync_vault` plugs in the
/// configured backend; tests can plug in an in-memory store instead.
async fn run_sync<S: RemoteStore>(
    vault: &Path,
    cfg: &SyncBackendConfig,
    client: &S,
    progress: Progress<'_>,
) -> Result<SyncOutcome, AppError> {
    progress("scan", 0, 0);
    // Pin both the merge baseline and the pushed-blob log to this store.
    let store_id = snapshot::hash_bytes(cfg.remote_identity().as_bytes());
    local::clear_staged(vault)?;
    recovery::resume(vault, &store_id, client).await?;
    let meta = local::read_meta(vault)?;
    let repointed = meta.store_id.as_deref().is_some_and(|id| id != store_id);
    let base = if repointed {
        Manifest::default()
    } else {
        local::read_base(vault)?
    };
    if !repointed
        && (meta.store_id.is_some() || meta.last_sync_at.is_none())
        && base.version != meta.last_version
    {
        return Err(AppError::message(
            "incomplete sync checkpoint; back up the vault before rebinding",
        ));
    }
    let base_scope = base.scope;
    let base_version = base.version;
    let mut base_files = visible_files(base.files.clone(), &cfg.scope);
    let scan_cache = if meta.needs_merge {
        Manifest::default()
    } else {
        base
    };
    let local_files = scan_local(vault, scan_cache, cfg.scope).await?;

    let mut outcome = SyncOutcome::default();
    // Opt-in degraded protocol (WebDAV only, phase 1): resolved from the live
    // probe on the first attempt, then stable across CAS retries.
    let mut degraded = false;
    for attempt in 0..MAX_CAS_RETRIES {
        progress("pull", 0, 0);
        let head = client.get(HEAD_KEY).await?;
        let (head_ptr, head_etag) = match &head {
            Some((bytes, etag)) => (
                Some(serde_json::from_slice::<HeadPointer>(bytes)?),
                Some(etag.clone()),
            ),
            None => (None, None),
        };

        if !repointed
            && meta.manifest_key.is_some()
            && !head_ptr.as_ref().is_some_and(|head| {
                head.version > meta.last_version
                    || (head.version == meta.last_version
                        && Some(&head.manifest_key) == meta.manifest_key.as_ref())
            })
        {
            return Err(AppError::message(
                "remote HEAD diverged from the last sync; refusing to infer deletions",
            ));
        }

        // A later attempt is a CAS retry, which always has work in flight.
        if attempt == 0 {
            // Up to date: HEAD still points at the manifest this vault last
            // agreed on, no local file changed content since, and this
            // device is using the same scope as before. One request
            // instead of a full pull/merge/publish pass 闂?backends meter
            // requests per account (Nutstore allows 600 per 30 min on a free
            // plan), so the steady state has to be cheap. Sync history is
            // required because a first pass must establish the remote
            // identity; a no-op pass writes nothing, so skipping the
            // handshake below is what makes the single request possible.
            let up_to_date = !meta.needs_merge
                && meta.last_sync_at.is_some()
                && meta.store_id.as_deref() == Some(store_id.as_str())
                && head_ptr.as_ref().is_some_and(|p| {
                    p.version == meta.last_version
                        && p.version == base_version
                        && meta.manifest_key.as_deref() == Some(p.manifest_key.as_str())
                })
                && base_scope == cfg.scope
                && same_content(&local_files, &base_files);
            if up_to_date {
                outcome.version = meta.last_version;
                // The pass succeeded (nothing to do); a stale failure note
                // from an earlier pass must not survive it.
                if meta.last_error.is_some() {
                    let mut cleared = meta.clone();
                    cleared.last_error = None;
                    local::write_meta(vault, &cleared)?;
                }
                return Ok(outcome);
            }
            degraded = resolve_degraded(cfg, client).await?;
            ensure_remote_identity(vault, client, degraded).await?;
            // A new or reset store has no baseline against which it could
            // have deleted local files. Start by publishing the local scan.
            if head_ptr.is_none() {
                base_files.clear();
            }
        }

        // Conditional publication needs a usable strong ETag; the degraded
        // protocol takes the publish lock instead and ignores ETags entirely.
        if !degraded {
            if let Some(tag) = &head_etag {
                PutCondition::IfMatch(tag.clone()).header()?;
            }
        }
        // Keep the authoritative remote manifest intact. A device that skips
        // an asset carries its remote entry forward without transferring it.
        let remote_manifest = match &head_ptr {
            Some(ptr) => Some(load_manifest(client, ptr).await?),
            None => None,
        };
        let remote_scope = remote_manifest
            .as_ref()
            .map(|m| m.scope)
            .unwrap_or_default();
        let empty = BTreeMap::new();
        let remote_files = remote_manifest.as_ref().map_or(&empty, |m| &m.files);

        let plan = merge(
            &base_files,
            &local_files,
            remote_files,
            &cfg.scope,
            &remote_scope,
        );
        let merged = &plan.merged;
        validate_tree(merged)?;
        let prepared = prepare_local(vault, client, &plan, &local_files, progress).await?;

        let adopt = head_ptr
            .as_ref()
            .filter(|_| same_content(merged, remote_files));
        let accepted = if let Some(head) = adopt {
            recovery::save(
                vault,
                &store_id,
                head,
                &cfg.scope,
                &plan,
                &local_files,
                true,
            )?;
            head.clone()
        } else {
            outcome.uploaded += plan
                .upload_missing(vault, &store_id, client, remote_files, progress)
                .await?;
            progress("finalize", 0, 0);
            let new_version = head_ptr
                .as_ref()
                .map_or(0, |p| p.version)
                .checked_add(1)
                .ok_or_else(|| AppError::message("sync version exhausted"))?;
            let manifest_key = format!(
                "manifests/{new_version:010}-{}.json.gz",
                &uuid::Uuid::new_v4().simple().to_string()[..8]
            );
            let manifest = Manifest {
                version: new_version,
                files: merged.clone(),
                // Old clients could omit entries entirely. Keep that ambiguity
                // for absent paths while preserving every explicit remote entry.
                scope: remote_scope,
            };
            validate_manifest(&manifest)?;
            if client
                .put(
                    &manifest_key,
                    gzip(&serde_json::to_vec(&manifest)?)?,
                    PutCondition::IfNoneMatch,
                )
                .await?
                != PutOutcome::Ok
            {
                continue;
            }
            let next_head = HeadPointer {
                version: new_version,
                manifest_key,
                updated_at: now(),
            };
            let head_bytes = serde_json::to_vec(&next_head)?;
            recovery::save(
                vault,
                &store_id,
                &next_head,
                &cfg.scope,
                &plan,
                &local_files,
                false,
            )?;
            let lost_race = if degraded {
                !publish_head_locked(vault, client, &head_bytes, head_ptr.as_ref()).await?
            } else {
                let condition = match head_etag {
                    Some(etag) => PutCondition::IfMatch(etag),
                    None => PutCondition::IfNoneMatch,
                };
                client.put(HEAD_KEY, head_bytes, condition).await? == PutOutcome::PreconditionFailed
            };
            if lost_race {
                recovery::discard(vault)?;
                continue;
            }
            recovery::accept(vault)?;
            next_head
        };
        prepared.apply(vault, &plan, &local_files, &mut outcome)?;
        outcome.removed_remote = remote_files
            .keys()
            .filter(|path| !merged.contains_key(*path))
            .count();
        record_sync(vault, &store_id, &accepted, &cfg.scope, plan.merged, false)?;
        recovery::finish(vault)?;
        local::clear_pushed(vault);
        refresh_catalog_if_needed(vault)?;
        outcome.version = accepted.version;
        return Ok(outcome);
    }
    Err(AppError::message(
        "sync contention: too many concurrent updates, try again",
    ))
}

async fn scan_local(
    vault: &Path,
    cache: Manifest,
    scope: SyncScope,
) -> Result<BTreeMap<String, FileEntry>, AppError> {
    let dir = vault.to_owned();
    tokio::task::spawn_blocking(move || {
        crate::features::paper::catalog::sidecar::flush_pending(&dir)?;
        refresh_catalog_if_needed(&dir)?;
        snapshot::scan_vault(&dir, &cache, &scope)
    })
    .await
    .map_err(|e| AppError::message(format!("scan task: {e}")))?
}

/// Read-only impact preview for both overwrite directions.
pub async fn overwrite_preview(
    vault: &Path,
    cfg: &SyncBackendConfig,
    direction: OverwriteDirection,
) -> Result<OverwritePreview, AppError> {
    crate::features::sync::ensure_vault_sync_available(vault)?;
    ensure_webdav_overwrite(cfg)?;
    let client = SyncStore::new(cfg, vault)?;
    overwrite_preview_with(vault, cfg, &client, direction).await
}

fn ensure_webdav_overwrite(cfg: &SyncBackendConfig) -> Result<(), AppError> {
    if cfg.backend != SyncBackendKind::Webdav {
        return Err(AppError::message(
            "manual overwrite is only supported for WebDAV sync",
        ));
    }
    Ok(())
}

async fn overwrite_preview_with<S: RemoteStore>(
    vault: &Path,
    cfg: &SyncBackendConfig,
    client: &S,
    direction: OverwriteDirection,
) -> Result<OverwritePreview, AppError> {
    let local_files = visible_files(scan_local_read_only(vault, cfg.scope).await?, &cfg.scope);
    let head = client.get(HEAD_KEY).await?;
    let head_ptr = match &head {
        Some((bytes, _)) => Some(serde_json::from_slice::<HeadPointer>(bytes)?),
        None => None,
    };
    if direction == OverwriteDirection::RemoteToLocal && head_ptr.is_none() {
        return Err(AppError::domain(
            "sync_remote_history_missing",
            "Remote sync history is missing; local files were left untouched",
        ));
    }
    let remote_manifest = match &head_ptr {
        Some(ptr) => Some(load_manifest(client, ptr).await?),
        None => None,
    };
    let empty = BTreeMap::new();
    let remote_files = remote_manifest.as_ref().map_or(&empty, |m| &m.files);
    let mut preview = OverwritePreview {
        remote_version: head_ptr.as_ref().map_or(0, |p| p.version),
        ..Default::default()
    };
    match direction {
        OverwriteDirection::RemoteToLocal => {
            let plan = plan_remote_mirror(&local_files, remote_files, &cfg.scope);
            preview.will_delete_local = plan.delete_local.len();
            preview.will_download = plan.downloads.len();
        }
        OverwriteDirection::LocalToRemote => {
            let remote_hashes: HashSet<&str> =
                remote_files.values().map(|e| e.hash.as_str()).collect();
            preview.will_upload = local_files
                .values()
                .filter(|e| !remote_hashes.contains(e.hash.as_str()))
                .count();
            preview.will_remove_remote = remote_files
                .keys()
                .filter(|path| !local_files.contains_key(*path))
                .count();
        }
    }
    Ok(preview)
}

/// Manual overwrite under the caller's SyncLock; failures are recorded into
/// `last_error` exactly like an ordinary pass.
pub async fn overwrite_locked(
    lock: &super::lock::SyncLock,
    cfg: &SyncBackendConfig,
    direction: OverwriteDirection,
    progress: Progress<'_>,
) -> Result<SyncOutcome, AppError> {
    let vault = lock.vault();
    let result = async {
        crate::features::sync::ensure_vault_sync_available(vault)?;
        ensure_webdav_overwrite(cfg)?;
        if recovery::unfinished(vault)? {
            return Err(AppError::message(
                "unfinished object sync; restore its binding or disconnect explicitly",
            ));
        }
        let client = SyncStore::new(cfg, vault)?;
        match direction {
            OverwriteDirection::RemoteToLocal => force_pull(vault, cfg, &client, progress).await,
            OverwriteDirection::LocalToRemote => force_push(vault, cfg, &client, progress).await,
        }
    }
    .await;
    match result {
        Ok(outcome) => Ok(outcome),
        Err(e) => {
            local::record_error(vault, &e.to_string());
            Err(e)
        }
    }
}

/// Remote overwrites local: mirror the remote HEAD manifest onto disk and
/// adopt it as the base. No new version is published. Divergent local
/// content is discarded by explicit user choice (confirmation dialog upstream).
async fn force_pull<S: RemoteStore>(
    vault: &Path,
    cfg: &SyncBackendConfig,
    client: &S,
    progress: Progress<'_>,
) -> Result<SyncOutcome, AppError> {
    let store_id = snapshot::hash_bytes(cfg.remote_identity().as_bytes());
    local::clear_staged(vault)?;
    ensure_remote_identity(vault, client, false).await?;
    progress("pull", 0, 0);
    let Some((head_bytes, _)) = client.get(HEAD_KEY).await? else {
        return Err(AppError::domain(
            "sync_remote_history_missing",
            "Remote sync history is missing; local files were left untouched",
        ));
    };
    let head_ptr: HeadPointer = serde_json::from_slice(&head_bytes)?;
    let remote_manifest = load_manifest(client, &head_ptr).await?;
    let scanned = scan_local(vault, Manifest::default(), cfg.scope).await?;
    let local_files = visible_files(scanned.clone(), &cfg.scope);
    let plan = plan_remote_mirror(&local_files, &remote_manifest.files, &cfg.scope);
    validate_tree(&plan.merged)?;
    let prepared = prepare_local(vault, client, &plan, &scanned, progress).await?;
    let mut outcome = SyncOutcome::default();
    recovery::save(
        vault, &store_id, &head_ptr, &cfg.scope, &plan, &scanned, true,
    )?;
    prepared.apply(vault, &plan, &scanned, &mut outcome)?;
    record_sync(vault, &store_id, &head_ptr, &cfg.scope, plan.merged, false)?;
    recovery::finish(vault)?;
    local::clear_pushed(vault);
    refresh_catalog_if_needed(vault)?;
    outcome.version = head_ptr.version;
    Ok(outcome)
}

/// Local overwrites remote: publish the local scan as HEAD version + 1.
/// Remote-only entries drop out of the manifest; peers infer the deletions
/// through their ordinary three-way merge. Old manifests and blobs stay on
/// the store, so the superseded remote state remains recoverable until GC.
/// No local mutation happens, hence no staged apply or recovery journal.
async fn force_push<S: RemoteStore>(
    vault: &Path,
    cfg: &SyncBackendConfig,
    client: &S,
    progress: Progress<'_>,
) -> Result<SyncOutcome, AppError> {
    let store_id = snapshot::hash_bytes(cfg.remote_identity().as_bytes());
    local::clear_staged(vault)?;
    let degraded = resolve_degraded(cfg, client).await?;
    ensure_remote_identity(vault, client, degraded).await?;
    let scanned = scan_local(vault, Manifest::default(), cfg.scope).await?;
    let merged = visible_files(scanned, &cfg.scope);
    validate_tree(&merged)?;
    let plan = MergePlan {
        merged: merged.clone(),
        ..Default::default()
    };
    let mut outcome = SyncOutcome::default();
    let empty = BTreeMap::new();
    for attempt in 0..MAX_CAS_RETRIES {
        if attempt > 0 {
            progress("pull", 0, 0);
        }
        let head = client.get(HEAD_KEY).await?;
        let head_ptr = match &head {
            Some((bytes, _)) => Some(serde_json::from_slice::<HeadPointer>(bytes)?),
            None => None,
        };
        let remote_manifest = match &head_ptr {
            Some(ptr) => Some(load_manifest(client, ptr).await?),
            None => None,
        };
        let remote_files = remote_manifest.as_ref().map_or(&empty, |m| &m.files);
        let remote_scope = remote_manifest
            .as_ref()
            .map(|m| m.scope)
            .unwrap_or_default();
        outcome.uploaded += plan
            .upload_missing(vault, &store_id, client, remote_files, progress)
            .await?;
        let new_version = head_ptr
            .as_ref()
            .map_or(0, |p| p.version)
            .checked_add(1)
            .ok_or_else(|| AppError::message("sync version exhausted"))?;
        let manifest_key = format!(
            "manifests/{new_version:010}-{}.json.gz",
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        );
        let next_head = HeadPointer {
            version: new_version,
            manifest_key: manifest_key.clone(),
            updated_at: now(),
        };
        let manifest = Manifest {
            version: new_version,
            files: merged.clone(),
            // Keep the remote's scope declaration; this pass has no new
            // exclusions to announce beyond what the store already carries.
            scope: remote_scope,
        };
        validate_manifest(&manifest)?;
        if client
            .put(
                &manifest_key,
                gzip(&serde_json::to_vec(&manifest)?)?,
                PutCondition::IfNoneMatch,
            )
            .await?
            != PutOutcome::Ok
        {
            continue;
        }
        let head_bytes = serde_json::to_vec(&next_head)?;
        let lost_race = if degraded {
            !publish_head_locked(vault, client, &head_bytes, head_ptr.as_ref()).await?
        } else {
            let condition = match &head {
                Some((_, etag)) => PutCondition::IfMatch(etag.clone()),
                None => PutCondition::IfNoneMatch,
            };
            client.put(HEAD_KEY, head_bytes, condition).await? == PutOutcome::PreconditionFailed
        };
        if lost_race {
            continue;
        }
        outcome.removed_remote = remote_files
            .keys()
            .filter(|path| !merged.contains_key(*path))
            .count();
        record_sync(
            vault,
            &store_id,
            &next_head,
            &cfg.scope,
            merged.clone(),
            false,
        )?;
        local::clear_pushed(vault);
        outcome.version = new_version;
        return Ok(outcome);
    }
    Err(AppError::message(
        "sync contention: too many concurrent updates, try again",
    ))
}

/// Degraded-mode HEAD publication: acquire the publish lock, re-read HEAD
/// (a changed pointer rebases like a lost CAS), plain-PUT, read back, release.
/// `Ok(false)` means "lost the race or could not hold the lock" 闂?the caller
/// rebases and retries; transport failures propagate as errors.
async fn publish_head_locked<S: RemoteStore>(
    vault: &Path,
    client: &S,
    head_bytes: &[u8],
    expected_head: Option<&HeadPointer>,
) -> Result<bool, AppError> {
    use crate::features::sync::store::LockOutcome;
    let device_id = local::ensure_device_id(vault)?;
    for attempt in 0..MAX_CAS_RETRIES {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(300 * attempt as u64)).await;
        }
        match client.try_acquire_publish_lock(&device_id).await? {
            LockOutcome::Acquired => {}
            LockOutcome::Busy => continue,
            LockOutcome::Unsupported => {
                return Err(AppError::message(
                    "degraded sync requires the WebDAV backend",
                ));
            }
        }
        let acquired = std::time::Instant::now();
        let result = async {
            let head = client.get(HEAD_KEY).await?;
            let current = match &head {
                Some((bytes, _)) => Some(serde_json::from_slice::<HeadPointer>(bytes)?),
                None => None,
            };
            let unchanged = match (&current, expected_head) {
                (Some(a), Some(b)) => a.version == b.version && a.manifest_key == b.manifest_key,
                (None, None) => true,
                _ => false,
            };
            if !unchanged {
                return Ok(false);
            }
            // The lock's server timestamp predates arbitration round-trips;
            // abort with half the TTL as margin so an expired lock can never
            // reach the publication (Joplin rule: own lock expired 闂?cancel).
            if acquired.elapsed().as_secs() >= (super::store::PUBLISH_LOCK_TTL_SECS as u64) / 2 {
                return Ok(false);
            }
            client
                .put(HEAD_KEY, head_bytes.to_vec(), PutCondition::Unconditional)
                .await?;
            // Best-effort detection of a concurrent publisher that slipped
            // through arbitration; a mismatch rebases like a lost CAS.
            match client.get(HEAD_KEY).await? {
                Some((bytes, _)) if bytes == head_bytes => Ok(true),
                _ => Ok(false),
            }
        }
        .await;
        let _ = client.release_publish_lock(&device_id).await;
        return result;
    }
    Ok(false)
}

/// Which side wins a manual overwrite. `RemoteToLocal` mirrors the remote
/// HEAD manifest onto disk (discarding divergent local content);
/// `LocalToRemote` publishes the local scan as the new HEAD (superseding
/// remote changes).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum OverwriteDirection {
    RemoteToLocal,
    LocalToRemote,
}

/// Impact preview for the confirmation dialog. Counts only; computed without
/// any local or remote write.
#[derive(Debug, Default, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OverwritePreview {
    /// Local files the remote does not have (force pull deletes them).
    pub will_delete_local: usize,
    /// Remote files force pull downloads or restores over local edits.
    pub will_download: usize,
    /// Remote files absent locally (force push drops them from the manifest).
    pub will_remove_remote: usize,
    /// Blobs force push uploads (local content the remote lacks).
    pub will_upload: usize,
    pub remote_version: u64,
}

/// Resolve the degraded protocol from a live probe: supported store 闂?false;
/// ignoring store + per-device opt-in on WebDAV 闂?true; otherwise the
/// localized hard stop. Phase 1 keeps degraded sync WebDAV-only.
async fn resolve_degraded<S: RemoteStore>(
    cfg: &SyncBackendConfig,
    client: &S,
) -> Result<bool, AppError> {
    if client.probe_conditional_writes().await? {
        return Ok(false);
    }
    if cfg.allow_degraded_sync && cfg.backend == SyncBackendKind::Webdav {
        return Ok(true);
    }
    Err(AppError::domain(
        super::SYNC_NO_CONDITIONAL_WRITES,
        "remote does not enforce conditional writes; sync stopped without changing vault files",
    ))
}

/// Force-pull plan: remote membership wins wholesale within the sync scope.
/// Divergent local bytes are discarded (no conflict copies 闂?the user chose
/// overwrite). `delete_local` is sorted because the staged apply resolves
/// directory replacements with a binary search.
fn plan_remote_mirror(
    local_files: &BTreeMap<String, FileEntry>,
    remote_files: &BTreeMap<String, FileEntry>,
    sync_scope: &SyncScope,
) -> MergePlan {
    let mut plan = MergePlan {
        merged: remote_files.clone(),
        ..Default::default()
    };
    // Scope-excluded categories stay inert: never downloaded, never deleted.
    let visible_remote = visible_files(remote_files.clone(), sync_scope);
    for (path, entry) in &visible_remote {
        if local_files
            .get(path)
            .is_some_and(|local| local.hash == entry.hash)
        {
            continue;
        }
        plan.downloads.push((path.clone(), entry.clone()));
    }
    for path in local_files.keys() {
        if !remote_files.contains_key(path) {
            plan.delete_local.push(path.clone());
        }
    }
    plan.delete_local.sort();
    plan.delete_local.dedup();
    plan.downloads.sort_by(|a, b| a.0.cmp(&b.0));
    plan
}

/// Read-only scan for the overwrite preview: never flushes pending sidecars
/// or refreshes the catalog.
async fn scan_local_read_only(
    vault: &Path,
    scope: SyncScope,
) -> Result<BTreeMap<String, FileEntry>, AppError> {
    let dir = vault.to_owned();
    let cache = local::read_base(vault)?;
    tokio::task::spawn_blocking(move || snapshot::scan_vault(&dir, &cache, &scope))
        .await
        .map_err(|e| AppError::message(format!("scan task: {e}")))?
}

fn record_sync(
    vault: &Path,
    store_id: &str,
    head: &HeadPointer,
    sync_scope: &SyncScope,
    files: BTreeMap<String, FileEntry>,
    needs_merge: bool,
) -> Result<(), AppError> {
    local::write_base(
        vault,
        &Manifest {
            version: head.version,
            files: visible_files(files, sync_scope),
            scope: *sync_scope,
        },
    )?;
    local::write_meta(
        vault,
        &SyncMeta {
            needs_merge,
            last_sync_at: Some(now()),
            last_version: head.version,
            store_id: Some(store_id.to_owned()),
            manifest_key: Some(head.manifest_key.clone()),
            last_error: None,
        },
    )
}

async fn load_manifest(client: &impl RemoteStore, ptr: &HeadPointer) -> Result<Manifest, AppError> {
    let name = ptr.manifest_key.strip_prefix("manifests/").filter(|name| {
        !name.is_empty() && !name.contains(['/', '\\', '?', '#', '%']) && name.ends_with(".json.gz")
    });
    if name.is_none() {
        return Err(AppError::message("invalid manifest key"));
    }
    let (bytes, _) = client
        .get(&ptr.manifest_key)
        .await?
        .ok_or_else(|| AppError::message(format!("manifest {} missing", ptr.manifest_key)))?;
    let manifest: Manifest = serde_json::from_slice(&gunzip_limited(&bytes, MAX_MANIFEST_BYTES)?)?;
    validate_manifest(&manifest)?;
    if manifest.version != ptr.version {
        return Err(AppError::message(
            "HEAD version does not match its manifest",
        ));
    }
    Ok(manifest)
}

/// First contact: create or verify the remote store identity.
/// A vault that never synced adopts an existing remote id (joining a store);
/// a vault with sync history refuses a foreign store.
async fn ensure_remote_identity<S: RemoteStore>(
    vault: &Path,
    client: &S,
    degraded: bool,
) -> Result<String, AppError> {
    let vault_id = local::ensure_vault_id(vault)?;
    match client.get(VAULT_KEY).await? {
        Some((bytes, _)) => {
            let info: RemoteVaultInfo = serde_json::from_slice(&bytes)
                .map_err(|_| AppError::message("remote vault.json is not a sync store"))?;
            if info.format_version > FORMAT_VERSION {
                return Err(AppError::message(
                    "remote sync store uses a newer format; update the app",
                ));
            }
            if info.vault_id == vault_id {
                return Ok(vault_id);
            }
            if local::read_base(vault)?.version == 0
                && local::read_meta(vault)?.last_sync_at.is_none()
            {
                local::set_vault_id(vault, &info.vault_id)?;
                return Ok(info.vault_id);
            }
            Err(AppError::message(
                "remote sync store belongs to a different vault",
            ))
        }
        None => {
            let info = RemoteVaultInfo {
                vault_id: vault_id.clone(),
                format_version: FORMAT_VERSION,
                encryption: "none".into(),
            };
            // Lost create race 闂?re-verify against the winner.
            if degraded {
                // No create-if-absent guarantee on this store: plain PUT, then
                // read back so a foreign vault id is detected instead of
                // silently adopted.
                client
                    .put(
                        VAULT_KEY,
                        serde_json::to_vec_pretty(&info)?,
                        PutCondition::Unconditional,
                    )
                    .await?;
                let Some((bytes, _)) = client.get(VAULT_KEY).await? else {
                    return Err(AppError::message(
                        "remote vault.json vanished after creation",
                    ));
                };
                let stored: RemoteVaultInfo = serde_json::from_slice(&bytes)
                    .map_err(|_| AppError::message("remote vault.json is not a sync store"))?;
                if stored.vault_id != vault_id {
                    return Err(AppError::message(
                        "remote sync store belongs to a different vault",
                    ));
                }
                return Ok(vault_id);
            }
            match client
                .put(
                    VAULT_KEY,
                    serde_json::to_vec_pretty(&info)?,
                    PutCondition::IfNoneMatch,
                )
                .await?
            {
                PutOutcome::Ok => {
                    // Stores that ignore If-None-Match (Nutstore) let two
                    // concurrent creators both succeed; read back so a foreign
                    // vault id is detected instead of silently adopted.
                    let Some((bytes, _)) = client.get(VAULT_KEY).await? else {
                        return Err(AppError::message(
                            "remote vault.json vanished after creation",
                        ));
                    };
                    let stored: RemoteVaultInfo = serde_json::from_slice(&bytes)
                        .map_err(|_| AppError::message("remote vault.json is not a sync store"))?;
                    if stored.vault_id != vault_id {
                        return Err(AppError::message(
                            "remote sync store belongs to a different vault",
                        ));
                    }
                    Ok(vault_id)
                }
                PutOutcome::PreconditionFailed => {
                    Box::pin(ensure_remote_identity(vault, client, degraded)).await
                }
            }
        }
    }
}

/// Remote manifests are untrusted input: paths feed `vault.join` for
/// write/delete and hashes feed `blob_key`, so reject anything that could
/// escape the vault or index outside `blobs/`.
fn validate_manifest(manifest: &Manifest) -> Result<(), AppError> {
    validate_tree(&manifest.files)?;
    for (rel, entry) in &manifest.files {
        if rel.is_empty()
            || rel.starts_with('/')
            || rel.contains('\\')
            || rel.split('/').any(|c| {
                c.is_empty()
                    || c == ".."
                    || c == "."
                    || snapshot::is_ignored_name(c)
                    || (cfg!(windows) && c.contains(':'))
            })
        {
            return Err(AppError::message(format!(
                "remote manifest has an unsafe path: {rel}"
            )));
        }
        if entry.hash.len() != 64
            || !entry
                .hash
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        {
            return Err(AppError::message(format!(
                "remote manifest has an invalid hash for {rel}"
            )));
        }
    }
    Ok(())
}

fn validate_tree<T>(files: &BTreeMap<String, T>) -> Result<(), AppError> {
    for path in files.keys() {
        if path
            .match_indices('/')
            .any(|(offset, _)| files.contains_key(&path[..offset]))
        {
            return Err(AppError::message(format!(
                "file/directory conflict at {path}; preserve both versions and rename one"
            )));
        }
    }
    Ok(())
}

#[derive(Default)]
struct MergePlan {
    merged: BTreeMap<String, FileEntry>,
    downloads: Vec<(String, FileEntry)>,
    delete_local: Vec<String>,
    /// `(original rel, conflict-copy rel)` 闂?copy the local file aside before
    /// the remote version overwrites it.
    preserve_local: Vec<(String, String)>,
    conflict_copies: Vec<String>,
}

impl MergePlan {
    async fn upload_missing(
        &self,
        vault: &Path,
        store_id: &str,
        client: &impl RemoteStore,
        remote_files: &BTreeMap<String, FileEntry>,
        progress: Progress<'_>,
    ) -> Result<usize, AppError> {
        let mut uploaded = 0;
        let remote_hashes: HashSet<&str> = remote_files.values().map(|e| e.hash.as_str()).collect();
        let mut pushed = local::read_pushed(vault, store_id);
        let uploads: Vec<(&String, &FileEntry)> = self
            .merged
            .iter()
            .filter(|(_, e)| !remote_hashes.contains(e.hash.as_str()))
            .collect();
        let total = uploads.len();
        for (i, (rel, entry)) in uploads.into_iter().enumerate() {
            progress("upload", i + 1, total);
            // Also covers two paths with identical content in one pass.
            if pushed.contains(&entry.hash) {
                continue;
            }
            // A preserved conflict copy is staged by `prepare_local` and applied only
            // after publication, so upload from the original file it is taken
            // from; `read_blob` verifies the content hash either way.
            let source = self
                .preserve_local
                .iter()
                .find(|(_, copy)| copy == rel)
                .map_or(rel, |(from, _)| from);
            client
                .put(
                    &blob_key(&entry.hash),
                    read_blob(vault, source, entry)?,
                    PutCondition::IfNoneMatch,
                )
                .await?;
            pushed.insert(entry.hash.clone());
            local::record_pushed(vault, store_id, &entry.hash);
            uploaded += 1;
        }

        Ok(uploaded)
    }
}

fn visible_files(
    mut files: BTreeMap<String, FileEntry>,
    sync_scope: &SyncScope,
) -> BTreeMap<String, FileEntry> {
    if !sync_scope.is_all() {
        let roots = scope::paper_roots(files.keys().map(String::as_str));
        files.retain(|path, _| !scope::excluded(sync_scope, path, &roots));
    }
    files
}

/// Three-way merge per path. Only-one-side changes win outright; both-changed
/// Markdown keeps the newer version and saves the loser as a conflict copy;
/// everything else (sidecars, marks, binaries) is last-writer-wins by mtime.
/// Delete-vs-modify keeps the modification.
///
/// A local exclusion preserves the remote entry without transferring bytes.
/// A legacy remote omission in a filtered category cannot delete local data.
fn merge(
    base: &BTreeMap<String, FileEntry>,
    local: &BTreeMap<String, FileEntry>,
    remote: &BTreeMap<String, FileEntry>,
    local_scope: &SyncScope,
    remote_scope: &SyncScope,
) -> MergePlan {
    let mut plan = MergePlan::default();
    let mut paths: Vec<&String> = base
        .keys()
        .chain(local.keys())
        .chain(remote.keys())
        .collect();
    paths.sort();
    paths.dedup();
    let roots = if local_scope.is_all() && remote_scope.is_all() {
        Default::default()
    } else {
        scope::paper_roots(paths.iter().map(|path| path.as_str()))
    };

    for path in paths {
        let b = base.get(path);
        let l = local.get(path);
        let r = remote.get(path);

        if scope::excluded(local_scope, path, &roots) {
            if let Some(entry) = r {
                plan.merged.insert(path.clone(), entry.clone());
            }
            continue;
        }
        if r.is_none() && scope::excluded(remote_scope, path, &roots) {
            if let Some(entry) = l {
                plan.merged.insert(path.clone(), entry.clone());
            }
            continue;
        }

        let same = |a: Option<&FileEntry>, b: Option<&FileEntry>| match (a, b) {
            (Some(x), Some(y)) => x.hash == y.hash,
            (None, None) => true,
            _ => false,
        };

        if same(l, r) {
            if let Some(entry) = l {
                plan.merged.insert(path.clone(), entry.clone());
            }
        } else if same(r, b) {
            // Local-only change (edit or delete) wins; deletion = omit.
            if let Some(entry) = l {
                plan.merged.insert(path.clone(), entry.clone());
            }
        } else if same(l, b) {
            // Remote-only change wins.
            match r {
                Some(entry) => {
                    plan.downloads.push((path.clone(), entry.clone()));
                    plan.merged.insert(path.clone(), entry.clone());
                }
                None => plan.delete_local.push(path.clone()),
            }
        } else {
            match (l, r) {
                // Divergent edits.
                (Some(le), Some(re)) => {
                    let remote_newer = re.mtime_ms >= le.mtime_ms;
                    if path.ends_with(".md") || path.to_ascii_lowercase().ends_with(".table.json") {
                        let loser = if remote_newer { le } else { re };
                        let copy = (1..)
                            .map(|index| conflict_name(path, &loser.hash, index))
                            .find(|name| {
                                ![base, local, remote, &plan.merged]
                                    .iter()
                                    .any(|files| files.contains_key(name))
                            })
                            .expect("unbounded conflict names");
                        plan.conflict_copies.push(copy.clone());
                        if remote_newer {
                            plan.preserve_local.push((path.clone(), copy.clone()));
                            plan.merged.insert(copy, le.clone());
                            plan.downloads.push((path.clone(), re.clone()));
                            plan.merged.insert(path.clone(), re.clone());
                        } else {
                            plan.downloads.push((copy.clone(), re.clone()));
                            plan.merged.insert(copy, re.clone());
                            plan.merged.insert(path.clone(), le.clone());
                        }
                    } else if remote_newer {
                        plan.downloads.push((path.clone(), re.clone()));
                        plan.merged.insert(path.clone(), re.clone());
                    } else {
                        plan.merged.insert(path.clone(), le.clone());
                    }
                }
                // Delete vs modify 闂?keep the modification.
                (Some(le), None) => {
                    plan.merged.insert(path.clone(), le.clone());
                }
                (None, Some(re)) => {
                    plan.downloads.push((path.clone(), re.clone()));
                    plan.merged.insert(path.clone(), re.clone());
                }
                (None, None) => {}
            }
        }
    }
    plan
}

/// Whether two manifests carry identical content, ignoring mtime: a download
/// rewrites the file with a fresh local mtime, so mtime drift alone must never
/// read as a change worth publishing.
fn same_content(a: &BTreeMap<String, FileEntry>, b: &BTreeMap<String, FileEntry>) -> bool {
    a.len() == b.len()
        && a.iter()
            .all(|(path, entry)| b.get(path).is_some_and(|o| o.hash == entry.hash))
}

/// Downloaded sidecars / deleted paper folders must be reflected in catalog.
pub(super) fn refresh_catalog_if_needed(vault: &Path) -> Result<(), AppError> {
    let marker = local::sync_dir(vault).join("catalog.dirty");
    if marker.try_exists()? {
        crate::features::paper::catalog::papers::rebuild_from_disk(vault)?;
        crate::features::paper::catalog::papers::prune_missing(vault)?;
        fs::remove_file(marker)?;
    }
    Ok(())
}

fn blob_key(hash: &str) -> String {
    format!("blobs/{}/{hash}", &hash[..2])
}

fn read_blob(vault: &Path, rel: &str, entry: &FileEntry) -> Result<Vec<u8>, AppError> {
    let raw = fs::read(vault.join(rel))?;
    if snapshot::hash_bytes(&raw) != entry.hash {
        return Err(AppError::message(format!(
            "{rel} changed during sync; run sync again"
        )));
    }
    gzip(&raw)
}

fn conflict_name(path: &str, hash: &str, index: u64) -> String {
    let stamp = &hash[..hash.len().min(12)];
    let stamp = if index == 1 {
        stamp.to_string()
    } else {
        format!("{stamp}-{index}")
    };
    if path.to_ascii_lowercase().ends_with(".table.json") {
        let stem = &path[..path.len() - ".table.json".len()];
        return format!("{stem} (conflict {stamp}).table.json");
    }
    match path.rsplit_once('.') {
        Some((stem, ext)) => format!("{stem} (conflict {stamp}).{ext}"),
        None => format!("{path} (conflict {stamp})"),
    }
}

// ---- Read-only mirrors -----------------------------------------------------
//
// A mirror is an output target, never an input: a pass publishes the vault's
// local state and never merges the mirror's manifest back. Two bidirectional
// backends would each carry their own merge base and fight over deletions, so
// the authoritative side stays singular by construction.

/// Test a mirror binding. Unlike [`test_connection`], the primary's rules do
/// not apply: a Git mirror branch is only a push target (the vault's own branch
/// and `origin` stay untouched), and object-store mirrors just need a usable
/// root with conditional writes for the HEAD CAS.
pub async fn test_mirror_connection(
    vault: &Path,
    cfg: &SyncBackendConfig,
) -> Result<bool, AppError> {
    crate::features::sync::ensure_vault_sync_available(vault)?;
    if cfg.backend == SyncBackendKind::Git {
        crate::features::sync::git::test_mirror_connection(vault, cfg).await?;
        return Ok(true);
    }
    let client = SyncStore::new(cfg, vault)?;
    client.ensure_root().await?;
    client.probe_conditional_writes().await
}

/// One pass that publishes `cfg` as a read-only mirror of `vault`.
///
/// The remote layout matches the primary's, so another Agentero can still open
/// the mirror as a normal store; this device just never reads it back.
pub async fn publish_mirror(
    vault: &Path,
    cfg: &SyncBackendConfig,
    progress: Progress<'_>,
) -> Result<SyncOutcome, AppError> {
    crate::features::sync::ensure_vault_sync_available(vault)?;
    if cfg.backend == SyncBackendKind::Git {
        return crate::features::sync::git::publish_mirror(vault, cfg, progress).await;
    }
    let client = SyncStore::new(cfg, vault)?;
    client.ensure_root().await?;
    run_mirror(vault, cfg, &client, progress).await
}

async fn run_mirror<S: RemoteStore>(
    vault: &Path,
    cfg: &SyncBackendConfig,
    client: &S,
    progress: Progress<'_>,
) -> Result<SyncOutcome, AppError> {
    let store_id = config::backend_identity(cfg);
    let state_dir = local::mirror_dir(vault, &store_id);
    progress("scan", 0, 0);
    let base = local::read_base_at(&state_dir)?;
    // The base doubles as the scan cache: unchanged files keep their mtime/hash.
    let files = visible_files(
        scan_local(vault, base.clone(), cfg.scope).await?,
        &cfg.scope,
    );
    validate_tree(&files)?;
    let mut outcome = SyncOutcome::default();
    // Idle pass: the last published manifest still matches the local tree, so
    // nothing is uploaded and no request is made.
    if base.version > 0 && same_content(&files, &base.files) {
        outcome.version = base.version;
        return Ok(outcome);
    }
    ensure_mirror_identity(vault, client).await?;

    for _ in 0..MAX_CAS_RETRIES {
        progress("pull", 0, 0);
        let head = client.get(HEAD_KEY).await?;
        let (head_ptr, head_etag) = match &head {
            Some((bytes, etag)) => (
                Some(serde_json::from_slice::<HeadPointer>(bytes)?),
                Some(etag.clone()),
            ),
            None => (None, None),
        };
        // What the mirror can already have. Without a HEAD (fresh, wiped, or
        // hand-edited mirror) nothing can be assumed and everything is re-sent.
        let known: HashSet<&str> = if head_ptr.is_some() {
            base.files
                .values()
                .map(|entry| entry.hash.as_str())
                .collect()
        } else {
            HashSet::new()
        };
        let mut uploaded = 0;
        let total = files.len();
        for (i, (rel, entry)) in files.iter().enumerate() {
            if known.contains(entry.hash.as_str()) {
                continue;
            }
            progress("upload", i + 1, total);
            match client
                .put(
                    &blob_key(&entry.hash),
                    read_blob(vault, rel, entry)?,
                    PutCondition::IfNoneMatch,
                )
                .await?
            {
                PutOutcome::Ok => uploaded += 1,
                // Already present (a previous pass uploaded it before publishing).
                PutOutcome::PreconditionFailed => {}
            }
        }
        outcome.uploaded += uploaded;

        progress("finalize", 0, 0);
        let new_version = head_ptr
            .as_ref()
            .map_or(0, |pointer| pointer.version)
            .checked_add(1)
            .ok_or_else(|| AppError::message("sync version exhausted"))?;
        let manifest_key = format!(
            "manifests/{new_version:010}-{}.json.gz",
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        );
        // Keep the scope the mirror was first published with; changing the
        // primary's scope must not silently reinterpret an existing mirror.
        let scope = head_ptr.as_ref().map_or(cfg.scope, |_| base.scope);
        let manifest = Manifest {
            version: new_version,
            files: files.clone(),
            scope,
        };
        validate_manifest(&manifest)?;
        if client
            .put(
                &manifest_key,
                gzip(&serde_json::to_vec(&manifest)?)?,
                PutCondition::IfNoneMatch,
            )
            .await?
            != PutOutcome::Ok
        {
            continue;
        }
        let next_head = HeadPointer {
            version: new_version,
            manifest_key,
            updated_at: now(),
        };
        let condition = match head_etag {
            Some(etag) => PutCondition::IfMatch(etag),
            None => PutCondition::IfNoneMatch,
        };
        if client
            .put(HEAD_KEY, serde_json::to_vec(&next_head)?, condition)
            .await?
            == PutOutcome::PreconditionFailed
        {
            continue;
        }
        local::write_base_at(
            &state_dir,
            &Manifest {
                version: next_head.version,
                files: visible_files(files.clone(), &scope),
                scope,
            },
        )?;
        local::write_meta_at(
            &state_dir,
            &SyncMeta {
                needs_merge: false,
                last_sync_at: Some(now()),
                last_version: next_head.version,
                store_id: Some(store_id.clone()),
                manifest_key: Some(next_head.manifest_key.clone()),
                last_error: None,
            },
        )?;
        outcome.removed_remote = base
            .files
            .keys()
            .filter(|path| !files.contains_key(*path))
            .count();
        outcome.version = next_head.version;
        return Ok(outcome);
    }
    Err(AppError::message(
        "mirror contention: too many concurrent updates, try again",
    ))
}

/// Bind a mirror store to this vault. A mirror that already holds another
/// vault's id is refused instead of being overwritten: pointing two vaults at
/// one mirror would make the second pass silently erase the first one.
async fn ensure_mirror_identity<S: RemoteStore>(vault: &Path, client: &S) -> Result<(), AppError> {
    let vault_id = local::ensure_vault_id(vault)?;
    match client.get(VAULT_KEY).await? {
        Some((bytes, _)) => {
            let info: RemoteVaultInfo = serde_json::from_slice(&bytes)
                .map_err(|_| AppError::message("mirror store is not an Agentero sync store"))?;
            if info.format_version > FORMAT_VERSION {
                return Err(AppError::message(
                    "mirror sync store uses a newer format; update the app",
                ));
            }
            if info.vault_id != vault_id {
                return Err(AppError::message(
                    "mirror store belongs to a different vault; pick an empty prefix",
                ));
            }
        }
        None => {
            client
                .put(
                    VAULT_KEY,
                    serde_json::to_vec(&RemoteVaultInfo {
                        vault_id,
                        format_version: FORMAT_VERSION,
                        encryption: "none".into(),
                    })?,
                    PutCondition::IfNoneMatch,
                )
                .await?;
        }
    }
    Ok(())
}

/// Per-mirror pass state. Progress phases stay vault-level (both passes share
/// them), so the host gets one event per mirror instead of a phase stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MirrorPhase {
    Started,
    Published,
    Failed,
}

/// Called once per mirror pass: `(index, mirror, phase, error)`.
pub type MirrorWatch<'a> =
    &'a (dyn Fn(usize, &SyncBackendConfig, MirrorPhase, Option<&str>) + Send + Sync);

/// One pass under the vault lock: the authoritative primary, then every
/// configured mirror in order.
///
/// A mirror failure never fails the pass — the primary already succeeded and
/// the mirror records its own `lastError` for the next attempt. A primary
/// failure stops before the mirrors, because publishing a half-applied local
/// tree would only spread it.
pub async fn sync_all_locked(
    lock: &super::lock::SyncLock,
    cfg: &config::VaultSyncConfig,
    progress: Progress<'_>,
    watch: Option<MirrorWatch<'_>>,
) -> Result<SyncOutcome, AppError> {
    let outcome = sync_vault_locked(lock, &cfg.primary, progress).await?;
    let vault = lock.vault();
    for (index, mirror) in cfg.mirrors.iter().enumerate() {
        // Scope is a whole-vault policy: a mirror always publishes exactly what
        // the primary does, so a stale mirror binding cannot shrink the copy.
        let mut mirror_cfg = mirror.clone();
        mirror_cfg.scope = cfg.primary.scope;
        if let Some(watch) = watch {
            watch(index, &mirror_cfg, MirrorPhase::Started, None);
        }
        if let Err(error) = publish_mirror(vault, &mirror_cfg, progress).await {
            let state_dir = local::mirror_dir(vault, &config::backend_identity(&mirror_cfg));
            let message = error.to_string();
            local::record_error_at(&state_dir, &message);
            log::warn!(
                target: "agentero::sync",
                "mirror pass failed backend={:?}: {error}",
                mirror.backend
            );
            if let Some(watch) = watch {
                watch(index, &mirror_cfg, MirrorPhase::Failed, Some(&message));
            }
        } else if let Some(watch) = watch {
            watch(index, &mirror_cfg, MirrorPhase::Published, None);
        }
    }
    Ok(outcome)
}

/// Last pass result for one mirror (settings pane / CLI status).
#[derive(Debug, Default, Clone)]
pub struct MirrorState {
    pub last_sync_at: Option<String>,
    pub last_version: u64,
    pub last_error: Option<String>,
}

pub fn mirror_state(vault: &Path, cfg: &SyncBackendConfig) -> MirrorState {
    let dir = local::mirror_dir(vault, &config::backend_identity(cfg));
    let meta = local::read_meta_at(&dir).unwrap_or_default();
    MirrorState {
        last_sync_at: meta.last_sync_at,
        last_version: meta.last_version,
        last_error: meta.last_error,
    }
}

fn gzip(raw: &[u8]) -> Result<Vec<u8>, AppError> {
    let mut enc = GzEncoder::new(Vec::new(), flate2::Compression::default());
    enc.write_all(raw)?;
    Ok(enc.finish()?)
}

/// Decompress with an output cap; reading `limit + 1` bytes detects overflow
/// without allocating it.
fn gunzip_limited(bytes: &[u8], limit: u64) -> Result<Vec<u8>, AppError> {
    let mut out = Vec::new();
    let n = GzDecoder::new(bytes)
        .take(limit.saturating_add(1))
        .read_to_end(&mut out)?;
    if n as u64 > limit {
        return Err(AppError::message(format!(
            "decompressed data exceeds the {limit} byte limit"
        )));
    }
    Ok(out)
}

fn now() -> String {
    crate::time::now_rfc3339_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    fn entry(hash: &str, mtime: i64) -> FileEntry {
        FileEntry {
            hash: hash.into(),
            size: 1,
            mtime_ms: mtime,
        }
    }

    fn map(pairs: &[(&str, FileEntry)]) -> BTreeMap<String, FileEntry> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    /// In-memory `RemoteStore` that counts requests, so a test can assert what
    /// a pass costs and not only what it produces.
    struct MemStore {
        objects: Mutex<BTreeMap<String, (Vec<u8>, String)>>,
        revisions: AtomicUsize,
        gets: AtomicUsize,
        puts: AtomicUsize,
        /// PUTs allowed before the store starts refusing 闂?models a rate limit
        /// landing partway through a pass.
        put_budget: AtomicUsize,
    }

    impl Default for MemStore {
        fn default() -> Self {
            Self {
                objects: Mutex::new(BTreeMap::new()),
                revisions: AtomicUsize::new(0),
                gets: AtomicUsize::new(0),
                puts: AtomicUsize::new(0),
                put_budget: AtomicUsize::new(usize::MAX),
            }
        }
    }

    impl MemStore {
        fn counts(&self) -> (usize, usize) {
            (
                self.gets.load(Ordering::Relaxed),
                self.puts.load(Ordering::Relaxed),
            )
        }
    }

    impl RemoteStore for MemStore {
        async fn ensure_root(&self) -> Result<(), AppError> {
            Ok(())
        }

        async fn get(&self, key: &str) -> Result<Option<(Vec<u8>, String)>, AppError> {
            self.gets.fetch_add(1, Ordering::Relaxed);
            Ok(self.objects.lock().unwrap().get(key).cloned())
        }

        async fn put(
            &self,
            key: &str,
            body: Vec<u8>,
            condition: PutCondition,
        ) -> Result<PutOutcome, AppError> {
            let attempt = self.puts.fetch_add(1, Ordering::Relaxed) + 1;
            if attempt > self.put_budget.load(Ordering::Relaxed) {
                return Err(AppError::message("PUT {key}: 429 Too Many Requests"));
            }
            let mut objects = self.objects.lock().unwrap();
            let current = objects.get(key).map(|(_, etag)| etag.clone());
            match (&current, condition) {
                (Some(_), PutCondition::IfNoneMatch) => return Ok(PutOutcome::PreconditionFailed),
                (None, PutCondition::IfMatch(_)) => return Ok(PutOutcome::PreconditionFailed),
                (Some(etag), PutCondition::IfMatch(want)) if *etag != want => {
                    return Ok(PutOutcome::PreconditionFailed)
                }
                _ => {}
            }
            let etag = format!("\"r{}\"", self.revisions.fetch_add(1, Ordering::Relaxed));
            objects.insert(key.to_string(), (body, etag));
            Ok(PutOutcome::Ok)
        }

        async fn probe_conditional_writes(&self) -> Result<bool, AppError> {
            Ok(true)
        }
    }

    fn temp_vault(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("agentero-sync-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn noop_progress() -> &'static (dyn Fn(&str, usize, usize) + Send + Sync) {
        &|_, _, _| {}
    }

    /// The point of the up-to-date check: an idle vault costs one request per
    /// pass instead of a full pull/merge/publish round trip.
    #[tokio::test]
    async fn idle_pass_costs_one_request() {
        let store = MemStore::default();
        let cfg = SyncBackendConfig::default();
        let vault = temp_vault("idle");
        fs::create_dir_all(vault.join("papers/x")).unwrap();
        fs::write(vault.join("papers/x/NOTES.md"), "# x\n").unwrap();

        let first = run_sync(&vault, &cfg, &store, noop_progress())
            .await
            .unwrap();
        assert_eq!((first.version, first.uploaded), (1, 1));

        let before = store.counts();
        let second = run_sync(&vault, &cfg, &store, noop_progress())
            .await
            .unwrap();
        assert_eq!(second.version, 1);
        let (gets, puts) = store.counts();
        assert_eq!((gets - before.0, puts - before.1), (1, 0));

        let _ = fs::remove_dir_all(&vault);
    }

    #[tokio::test]
    async fn projection_failure_stops_sync_before_remote_io() {
        use crate::features::paper::catalog::papers::{self, PaperRecord};
        let vault = tempfile::tempdir().unwrap();
        fs::create_dir_all(vault.path().join("papers/x/metadata.json")).unwrap();
        papers::upsert_paper(
            vault.path(),
            &PaperRecord::local_pdf("x".into(), "X".into()).at_path("papers/x"),
        )
        .unwrap();
        let store = MemStore::default();
        assert!(run_sync(
            vault.path(),
            &SyncBackendConfig::default(),
            &store,
            noop_progress()
        )
        .await
        .is_err());
        assert_eq!(store.counts(), (0, 0));
    }

    /// Two idle devices must not advance HEAD. A download rewrites the file
    /// with a fresh local mtime, and republishing that difference used to make
    /// each device outbid the other forever.
    #[tokio::test]
    async fn idle_devices_do_not_ping_pong_head() {
        let store = MemStore::default();
        let cfg = SyncBackendConfig::default();
        let (a, b) = (temp_vault("ping-a"), temp_vault("ping-b"));
        fs::create_dir_all(a.join("papers/x")).unwrap();
        fs::create_dir_all(&b).unwrap();
        fs::write(a.join("papers/x/NOTES.md"), "# x\n").unwrap();

        let published = run_sync(&a, &cfg, &store, noop_progress()).await.unwrap();
        assert_eq!(published.version, 1);
        // B joins by download only: it adopts the remote manifest instead of
        // publishing a content-identical one.
        let joined = run_sync(&b, &cfg, &store, noop_progress()).await.unwrap();
        assert_eq!((joined.version, joined.downloaded), (1, 1));

        for round in 0..2 {
            let before = store.counts();
            let again_a = run_sync(&a, &cfg, &store, noop_progress()).await.unwrap();
            let again_b = run_sync(&b, &cfg, &store, noop_progress()).await.unwrap();
            assert_eq!((again_a.version, again_b.version), (1, 1), "round {round}");
            let (gets, puts) = store.counts();
            assert_eq!(puts - before.1, 0, "round {round} republished");
            assert_eq!(gets - before.0, 2, "round {round}: one HEAD read each");
        }

        // A real edit still publishes, and B still picks it up.
        fs::write(a.join("papers/x/NOTES.md"), "# x\nedited\n").unwrap();
        let edited = run_sync(&a, &cfg, &store, noop_progress()).await.unwrap();
        assert_eq!((edited.version, edited.uploaded), (2, 1));
        let pulled = run_sync(&b, &cfg, &store, noop_progress()).await.unwrap();
        assert_eq!((pulled.version, pulled.downloaded), (2, 1));
        assert!(fs::read_to_string(b.join("papers/x/NOTES.md"))
            .unwrap()
            .contains("edited"));

        for dir in [a, b] {
            let _ = fs::remove_dir_all(dir);
        }
    }

    /// An interrupted upload must not be re-sent. The remote manifest still
    /// describes the pre-pass state, so without the pushed log the next pass
    /// recomputes the same upload list and re-sends the request bodies.
    #[tokio::test]
    async fn interrupted_upload_resumes_without_resending() {
        let store = MemStore::default();
        let cfg = SyncBackendConfig::default();
        let vault = temp_vault("resume");
        fs::create_dir_all(vault.join("notes")).unwrap();
        for name in ["a", "b", "c", "d"] {
            fs::write(
                vault.join("notes").join(format!("{name}.md")),
                format!("# {name}\n"),
            )
            .unwrap();
        }

        // The budget covers vault.json plus the first two blobs; the third is
        // refused, so HEAD never advances and nothing is published.
        store.put_budget.store(3, Ordering::Relaxed);
        assert!(run_sync(&vault, &cfg, &store, noop_progress())
            .await
            .is_err());

        store.put_budget.store(usize::MAX, Ordering::Relaxed);
        let before = store.counts();
        let resumed = run_sync(&vault, &cfg, &store, noop_progress())
            .await
            .unwrap();
        let (gets, puts) = store.counts();
        assert_eq!((resumed.version, resumed.uploaded), (1, 2));
        assert_eq!(puts - before.1, 4, "2 remaining blobs + manifest + HEAD");
        assert_eq!(gets - before.0, 2, "vault.json + HEAD");

        // The published manifest covers every blob, so the log is spent and
        // the next pass short-circuits.
        let before = store.counts();
        run_sync(&vault, &cfg, &store, noop_progress())
            .await
            .unwrap();
        let (gets, puts) = store.counts();
        assert_eq!((gets - before.0, puts - before.1), (1, 0));

        let _ = fs::remove_dir_all(&vault);
    }

    #[test]
    fn merge_one_sided_changes() {
        let base = map(&[("a.md", entry("h1", 1)), ("b.pdf", entry("h2", 1))]);
        let local = map(&[("a.md", entry("h1-local", 2)), ("b.pdf", entry("h2", 1))]);
        let remote = map(&[("a.md", entry("h1", 1))]); // remote deleted b.pdf

        let plan = merge(
            &base,
            &local,
            &remote,
            &snapshot::SyncScope::all(),
            &snapshot::SyncScope::all(),
        );
        assert_eq!(plan.merged["a.md"].hash, "h1-local");
        assert!(!plan.merged.contains_key("b.pdf"));
        assert_eq!(plan.delete_local, vec!["b.pdf"]);
        assert!(plan.downloads.is_empty());
    }

    #[test]
    fn merge_divergent_md_keeps_both_versions() {
        let base = map(&[("n.md", entry("h0", 1))]);
        let local = map(&[("n.md", entry("hl", 10))]);
        let remote = map(&[("n.md", entry("hr", 20))]);

        let plan = merge(
            &base,
            &local,
            &remote,
            &snapshot::SyncScope::all(),
            &snapshot::SyncScope::all(),
        );
        // Remote newer: it takes the path, local survives as conflict copy.
        assert_eq!(plan.merged["n.md"].hash, "hr");
        assert_eq!(plan.preserve_local.len(), 1);
        let copy = &plan.preserve_local[0].1;
        assert!(copy.contains("(conflict"));
        assert_eq!(plan.merged[copy].hash, "hl");
    }

    #[test]
    fn merge_divergent_research_tables_preserves_both_readable_files() {
        for (local_time, remote_time) in [(10, 20), (20, 10)] {
            let path = "data/results.table.json";
            let plan = merge(
                &map(&[(path, entry("base", 1))]),
                &map(&[(path, entry("local", local_time))]),
                &map(&[(path, entry("remote", remote_time))]),
                &snapshot::SyncScope::all(),
                &snapshot::SyncScope::all(),
            );
            assert_eq!(plan.merged.len(), 2);
            let copy = plan.merged.keys().find(|key| key.as_str() != path).unwrap();
            assert!(copy.ends_with(".table.json"));
            assert!(copy.contains(" (conflict "));
            assert_ne!(plan.merged[path].hash, plan.merged[copy].hash);
        }
    }

    #[test]
    fn merge_divergent_binary_is_lww() {
        let base = map(&[("m.json", entry("h0", 1))]);
        let local = map(&[("m.json", entry("hl", 30))]);
        let remote = map(&[("m.json", entry("hr", 20))]);

        let plan = merge(
            &base,
            &local,
            &remote,
            &snapshot::SyncScope::all(),
            &snapshot::SyncScope::all(),
        );
        assert_eq!(plan.merged["m.json"].hash, "hl");
        assert!(plan.downloads.is_empty());
        assert!(plan.preserve_local.is_empty());
    }

    #[test]
    fn merge_delete_vs_modify_keeps_modification() {
        let base = map(&[("k.md", entry("h0", 1))]);
        let local = map(&[]); // deleted locally
        let remote = map(&[("k.md", entry("hr", 5))]); // modified remotely

        let plan = merge(
            &base,
            &local,
            &remote,
            &snapshot::SyncScope::all(),
            &snapshot::SyncScope::all(),
        );
        assert_eq!(plan.merged["k.md"].hash, "hr");
        assert_eq!(plan.downloads.len(), 1);
    }

    fn no_pdf_scope() -> snapshot::SyncScope {
        snapshot::SyncScope {
            pdf: false,
            source: true,
            attachments: true,
        }
    }

    #[test]
    fn merge_remote_filtered_path_is_not_a_delete() {
        // The remote publisher syncs without PDFs: its manifest lacks the
        // entry, but that absence must not delete the local file.
        let base = map(&[("papers/x/x.pdf", entry("h0", 1))]);
        let local = map(&[("papers/x/x.pdf", entry("h0", 1))]);
        let remote = map(&[]);

        let plan = merge(
            &base,
            &local,
            &remote,
            &snapshot::SyncScope::all(),
            &no_pdf_scope(),
        );
        assert_eq!(plan.merged["papers/x/x.pdf"].hash, "h0");
        assert!(plan.delete_local.is_empty());
        assert!(plan.downloads.is_empty());
    }

    #[test]
    fn merge_locally_filtered_path_is_inert() {
        // This device skips PDFs: the remote entry must not be downloaded,
        // and the base entry survives in the merged manifest.
        let base = map(&[("papers/x/x.pdf", entry("h0", 1))]);
        let local = map(&[]); // filtered out of the scan
        let remote = map(&[("papers/x/x.pdf", entry("h0", 1))]);

        let plan = merge(
            &base,
            &local,
            &remote,
            &no_pdf_scope(),
            &snapshot::SyncScope::all(),
        );
        assert_eq!(plan.merged["papers/x/x.pdf"].hash, "h0");
        assert!(plan.downloads.is_empty());
        assert!(plan.delete_local.is_empty());
    }

    #[test]
    fn merge_local_delete_wins_over_blind_remote() {
        // This device sees PDFs and deleted one; the remote publisher was
        // blind to the category, so the delete propagates (entry dropped).
        let base = map(&[("papers/x/x.pdf", entry("h0", 1))]);
        let local = map(&[]); // genuinely deleted
        let remote = map(&[]); // blind publisher

        let plan = merge(
            &base,
            &local,
            &remote,
            &snapshot::SyncScope::all(),
            &no_pdf_scope(),
        );
        assert!(!plan.merged.contains_key("papers/x/x.pdf"));
        assert!(plan.downloads.is_empty());
        assert!(plan.delete_local.is_empty());
    }

    #[test]
    fn validate_manifest_rejects_unsafe_paths_and_hashes() {
        let ok_hash = "a".repeat(64);
        let valid = Manifest {
            version: 1,
            files: map(&[("papers/x/NOTES.md", entry(&ok_hash, 1))]),
            scope: snapshot::SyncScope::all(),
        };
        assert!(validate_manifest(&valid).is_ok());

        for bad in [
            "../evil.md",
            "/abs.md",
            "a\\b.md",
            "a//b.md",
            "a/./b.md",
            "a/../b.md",
            "",
        ] {
            let m = Manifest {
                version: 1,
                files: map(&[(bad, entry(&ok_hash, 1))]),
                scope: snapshot::SyncScope::all(),
            };
            assert!(
                validate_manifest(&m).is_err(),
                "path {bad:?} must be rejected"
            );
        }

        for bad_hash in ["", "abc", &"A".repeat(64), &"g".repeat(64), &"a".repeat(63)] {
            let m = Manifest {
                version: 1,
                files: map(&[("n.md", entry(bad_hash, 1))]),
                scope: snapshot::SyncScope::all(),
            };
            assert!(
                validate_manifest(&m).is_err(),
                "hash {bad_hash:?} must be rejected"
            );
        }
    }

    #[test]
    fn gunzip_limited_enforces_cap() {
        let packed = gzip(&vec![0u8; 4096]).unwrap();
        assert_eq!(gunzip_limited(&packed, 4096).unwrap().len(), 4096);
        assert!(gunzip_limited(&packed, 4095).is_err());
    }

    /// The remote layout's artifact names must stay covered by the shared
    /// ignore list, or a mirrored store would leak back into the blob store.
    #[test]
    fn store_artifact_names_cover_the_remote_layout() {
        use crate::features::vault::tree::SYNC_STORE_ARTIFACT_NAMES;
        for key in [HEAD_KEY, VAULT_KEY, "blobs", "manifests"] {
            assert!(
                SYNC_STORE_ARTIFACT_NAMES.contains(&key),
                "{key} missing from SYNC_STORE_ARTIFACT_NAMES"
            );
        }
    }

    /// Full two-device round trip against a live S3 endpoint.
    ///
    /// ```sh
    /// docker run -d --rm --name minio -p 19000:9000 \
    ///   -e MINIO_ROOT_USER=testkey -e MINIO_ROOT_PASSWORD=testsecret \
    ///   minio/minio server /data
    /// docker exec minio mc alias set local http://127.0.0.1:9000 testkey testsecret
    /// docker exec minio mc mb local/vault-test
    /// cargo test -p agentero --lib features::sync::engine -- --ignored
    /// ```
    #[tokio::test]
    #[ignore = "requires a local MinIO (see doc comment)"]
    async fn two_device_roundtrip_against_minio() {
        use crate::features::sync::config::SyncBackendConfig;
        use uuid::Uuid;

        let cfg = SyncBackendConfig {
            endpoint: std::env::var("AGENTERO_SYNC_TEST_ENDPOINT")
                .unwrap_or_else(|_| "http://127.0.0.1:19000".into()),
            region: "us-east-1".into(),
            bucket: "vault-test".into(),
            prefix: format!("it-{}", Uuid::new_v4()),
            access_key: "testkey".into(),
            secret_key: "testsecret".into(),
            force_path_style: true,
            auto_sync: false,
            interval_minutes: 30,
            conditional_writes: true,
            scope: snapshot::SyncScope::all(),
            ..SyncBackendConfig::default()
        };
        let noop: &(dyn Fn(&str, usize, usize) + Send + Sync) = &|_, _, _| {};

        let tmp = std::env::temp_dir().join(format!("agentero-sync-it-{}", Uuid::new_v4()));
        let (a, b) = (tmp.join("a"), tmp.join("b"));
        fs::create_dir_all(a.join("papers/x")).unwrap();
        fs::create_dir_all(&b).unwrap();
        fs::write(a.join("papers/x/NOTES.md"), "# x\n").unwrap();
        fs::write(a.join("papers/x/metadata.json"), r#"{"id":"x"}"#).unwrap();

        // A publishes, empty B joins and receives everything. B adds nothing,
        // so it adopts version 1 rather than republishing it.
        let up = sync_vault(&a, &cfg, noop).await.expect("sync A");
        assert_eq!((up.version, up.uploaded), (1, 2));
        let down = sync_vault(&b, &cfg, noop).await.expect("sync B");
        assert_eq!((down.version, down.downloaded), (1, 2));
        assert_eq!(
            fs::read_to_string(b.join("papers/x/NOTES.md")).unwrap(),
            "# x\n"
        );

        // B edits; A picks it up.
        fs::write(b.join("papers/x/NOTES.md"), "# x\nedited on B\n").unwrap();
        sync_vault(&b, &cfg, noop).await.expect("sync B edit");
        let pull = sync_vault(&a, &cfg, noop).await.expect("sync A pull");
        assert_eq!(pull.downloaded, 1);
        assert!(fs::read_to_string(a.join("papers/x/NOTES.md"))
            .unwrap()
            .contains("edited on B"));

        // Divergent edits on both 闂?conflict copy, then both converge.
        fs::write(a.join("papers/x/NOTES.md"), "# x\nA version\n").unwrap();
        fs::write(b.join("papers/x/NOTES.md"), "# x\nB version\n").unwrap();
        sync_vault(&a, &cfg, noop).await.expect("sync A divergent");
        let conflicted = sync_vault(&b, &cfg, noop).await.expect("sync B divergent");
        assert_eq!(conflicted.conflict_copies.len(), 1);
        sync_vault(&a, &cfg, noop).await.expect("sync A converge");
        // Compare content only: mtimes legitimately differ across devices.
        let hashes = |vault: &Path| -> BTreeMap<String, String> {
            snapshot::scan_vault(vault, &Manifest::default(), &snapshot::SyncScope::all())
                .unwrap()
                .into_iter()
                .map(|(k, v)| (k, v.hash))
                .collect()
        };
        assert_eq!(hashes(&a), hashes(&b), "both devices converge");

        let _ = fs::remove_dir_all(&tmp);
    }

    /// Full two-device round trip against a live WebDAV endpoint.
    ///
    /// ```sh
    /// AGENTERO_SYNC_WEBDAV_TEST_URL=https://dav.jianguoyun.com/dav/ \
    /// AGENTERO_SYNC_WEBDAV_TEST_USERNAME=user@example.com \
    /// AGENTERO_SYNC_WEBDAV_TEST_PASSWORD=app-password \
    /// cargo test -p agentero --lib integration::sync::engine -- --ignored
    /// ```
    ///
    /// Uses a fresh `agentero-it-<hex>` directory per run (created via MKCOL;
    /// Nutstore caps top-level folder name length, so keep it short); clean
    /// it up afterwards by deleting the directory (Nutstore requires deleting
    /// files before their parent collection).
    ///
    /// Set `AGENTERO_SYNC_WEBDAV_TEST_DEGRADED=1` to opt into the degraded
    /// protocol (required for servers that ignore conditional headers, e.g.
    /// fnOS built-in WebDAV; the probe result is printed either way).
    #[tokio::test]
    #[ignore = "requires a live WebDAV server (see doc comment)"]
    async fn two_device_roundtrip_against_webdav() {
        use crate::features::sync::config::SyncBackendKind;
        use uuid::Uuid;

        let base = std::env::var("AGENTERO_SYNC_WEBDAV_TEST_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:9001".into());
        let nonce = &Uuid::new_v4().simple().to_string()[..12];
        let mut cfg = SyncBackendConfig {
            backend: SyncBackendKind::Webdav,
            webdav_url: format!("{}/agentero-it-{nonce}", base.trim_end_matches('/')),
            webdav_username: std::env::var("AGENTERO_SYNC_WEBDAV_TEST_USERNAME")
                .unwrap_or_default(),
            webdav_password: std::env::var("AGENTERO_SYNC_WEBDAV_TEST_PASSWORD")
                .unwrap_or_default(),
            auto_sync: false,
            interval_minutes: 30,
            conditional_writes: true,
            scope: snapshot::SyncScope::all(),
            ..SyncBackendConfig::default()
        };
        // Mirror sync_configure: reachability (creates the directory) plus
        // the conditional-write probe that seeds the persisted flag.
        let probed = test_connection(Path::new("."), &cfg)
            .await
            .expect("webdav test_connection");
        cfg.conditional_writes = probed;
        cfg.allow_degraded_sync = std::env::var("AGENTERO_SYNC_WEBDAV_TEST_DEGRADED")
            .map(|v| v == "1")
            .unwrap_or(false);
        eprintln!("webdav conditional writes: {probed}");

        let noop: &(dyn Fn(&str, usize, usize) + Send + Sync) = &|_, _, _| {};

        let tmp = std::env::temp_dir().join(format!("agentero-sync-it-{}", Uuid::new_v4()));
        let (a, b) = (tmp.join("a"), tmp.join("b"));
        fs::create_dir_all(a.join("papers/x")).unwrap();
        fs::create_dir_all(&b).unwrap();
        fs::write(a.join("papers/x/NOTES.md"), "# x\n").unwrap();
        fs::write(a.join("papers/x/metadata.json"), r#"{"id":"x"}"#).unwrap();

        // A publishes, empty B joins and receives everything. B adds nothing,
        // so it adopts version 1 rather than republishing it.
        let up = sync_vault(&a, &cfg, noop).await.expect("sync A");
        assert_eq!((up.version, up.uploaded), (1, 2));
        let down = sync_vault(&b, &cfg, noop).await.expect("sync B");
        assert_eq!((down.version, down.downloaded), (1, 2));
        assert_eq!(
            fs::read_to_string(b.join("papers/x/NOTES.md")).unwrap(),
            "# x\n"
        );

        // B edits; A picks it up.
        fs::write(b.join("papers/x/NOTES.md"), "# x\nedited on B\n").unwrap();
        sync_vault(&b, &cfg, noop).await.expect("sync B edit");
        let pull = sync_vault(&a, &cfg, noop).await.expect("sync A pull");
        assert_eq!(pull.downloaded, 1);
        assert!(fs::read_to_string(a.join("papers/x/NOTES.md"))
            .unwrap()
            .contains("edited on B"));

        // Divergent edits on both 闂?conflict copy, then both converge.
        fs::write(a.join("papers/x/NOTES.md"), "# x\nA version\n").unwrap();
        fs::write(b.join("papers/x/NOTES.md"), "# x\nB version\n").unwrap();
        sync_vault(&a, &cfg, noop).await.expect("sync A divergent");
        let conflicted = sync_vault(&b, &cfg, noop).await.expect("sync B divergent");
        assert_eq!(conflicted.conflict_copies.len(), 1);
        sync_vault(&a, &cfg, noop).await.expect("sync A converge");
        // Compare content only: mtimes legitimately differ across devices.
        let hashes = |vault: &Path| -> BTreeMap<String, String> {
            snapshot::scan_vault(vault, &Manifest::default(), &snapshot::SyncScope::all())
                .unwrap()
                .into_iter()
                .map(|(k, v)| (k, v.hash))
                .collect()
        };
        assert_eq!(hashes(&a), hashes(&b), "both devices converge");

        let _ = fs::remove_dir_all(&tmp);
    }
}
