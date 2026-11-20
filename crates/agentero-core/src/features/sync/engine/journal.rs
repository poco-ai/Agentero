//! Experimental WebDAV format. Each record adds file versions and explicitly
//! retires observed versions. Concurrent adds survive even if their author
//! never reconnects. A directory omission is never a removal operation.
use super::*;
use crate::features::sync::{
    lock::SyncLock,
    webdav::{WebdavClient, JOURNAL_LIST_LIMIT},
};
use std::collections::BTreeSet;

type Files = BTreeMap<String, FileEntry>;
type Records = BTreeMap<String, Record>;
type Version = (String, String); // record hash, original path

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    parents: BTreeSet<String>,
    adds: Files,
    removes: BTreeSet<Version>,
}

#[derive(Serialize, Deserialize)]
pub(super) struct Journal {
    store: String,
    vault_id: String,
    records: Records,
    scope: SyncScope,
    // While applying a published view, either the before or the target
    // bytes can legitimately be on disk after interruption.
    before: BTreeMap<String, Option<String>>,
}

fn state_path(vault: &Path) -> std::path::PathBuf {
    local::sync_dir(vault).join("webdav-journal.json")
}

pub(super) fn binding(vault: &Path, cfg: &SyncBackendConfig) -> Result<Option<Journal>, AppError> {
    let journal = local::read_json::<Journal>(&state_path(vault))?;
    if journal
        .as_ref()
        .is_some_and(|j| cfg.backend != SyncBackendKind::Webdav || j.store != cfg.remote_identity())
    {
        return Err(AppError::message(
            "disconnect the WebDAV journal before changing stores",
        ));
    }
    Ok(journal)
}

impl Journal {
    pub(super) async fn verify_remote(&self, client: &WebdavClient) -> Result<(), AppError> {
        let info = remote_info(client).await?;
        if !info.is_some_and(|info| info.format_version == 2 && info.vault_id == self.vault_id) {
            return Err(AppError::message("WebDAV journal identity changed"));
        }
        Ok(())
    }
}

async fn remote_info(client: &WebdavClient) -> Result<Option<RemoteVaultInfo>, AppError> {
    client
        .get(VAULT_KEY)
        .await?
        .map(|(bytes, _)| serde_json::from_slice(&bytes))
        .transpose()
        .map_err(Into::into)
}

/// Explicitly initialize a new journal or join one on another device.
pub async fn configure_webdav_journal(
    lock: &SyncLock,
    cfg: &SyncBackendConfig,
) -> Result<(), AppError> {
    let vault = lock.vault();
    crate::features::sync::ensure_vault_sync_available(vault)?;
    if cfg.backend != SyncBackendKind::Webdav {
        return Err(AppError::message("journal requires a WebDAV binding"));
    }
    cfg.validate()?;
    let client = WebdavClient::new(cfg)?;
    client.ensure_root().await?;
    if let Some(state) = binding(vault, cfg)? {
        state.verify_remote(&client).await?;
        client.test_journal().await?;
        return Ok(());
    }
    if recovery::unfinished(vault)?
        || local::read_meta(vault)?.last_sync_at.is_some()
        || local::read_base(vault)?.version != 0
    {
        return Err(AppError::message(
            "use a fresh test vault or explicitly disconnect its previous sync binding",
        ));
    }
    let vault_id = match remote_info(&client).await? {
        Some(info) if info.format_version == 2 && uuid::Uuid::parse_str(&info.vault_id).is_ok() => {
            info.vault_id
        }
        Some(_) => {
            return Err(AppError::message(
                "use a separate directory for the WebDAV journal",
            ))
        }
        None => {
            client.create_journal().await?;
            let id = local::ensure_vault_id(vault)?;
            let info = RemoteVaultInfo {
                vault_id: id.clone(),
                format_version: 2,
                encryption: "none".into(),
            };
            client
                .journal_put(VAULT_KEY, serde_json::to_vec(&info)?)
                .await?;
            id
        }
    };
    client.test_journal().await?;
    local::set_vault_id(vault, &vault_id)?;
    local::write_json(
        &state_path(vault),
        &Journal {
            store: cfg.remote_identity(),
            vault_id,
            records: Records::new(),
            scope: cfg.scope,
            before: BTreeMap::new(),
        },
    )
}

struct Value {
    versions: BTreeSet<Version>,
    entry: FileEntry,
}

/// Give concurrent versions stable filenames on every device, reserving
/// real user paths before assigning any conflict name.
fn view(records: &Records, seen: &BTreeSet<String>) -> Result<BTreeMap<String, Value>, AppError> {
    let mut removed = BTreeSet::new();
    for id in seen {
        let record = &records[id];
        if !record.parents.is_subset(seen) {
            return Err(AppError::message(
                "WebDAV journal is missing parent records",
            ));
        }
        for (source, path) in &record.removes {
            if !seen.contains(source) || !records[source].adds.contains_key(path) {
                return Err(AppError::message(
                    "WebDAV journal is missing a retired file version",
                ));
            }
        }
        removed.extend(&record.removes);
    }
    let mut paths = BTreeMap::<&String, BTreeMap<&String, Value>>::new();
    for id in seen {
        for (path, entry) in &records[id].adds {
            let version = (id.clone(), path.clone());
            if removed.contains(&version) {
                continue;
            }
            paths
                .entry(path)
                .or_default()
                .entry(&entry.hash)
                .or_insert_with(|| Value {
                    versions: BTreeSet::new(),
                    entry: entry.clone(),
                })
                .versions
                .insert(version);
        }
    }
    let mut reserved: BTreeSet<String> = paths.keys().map(|p| (**p).clone()).collect();
    let mut result = BTreeMap::new();
    for (path, variants) in paths {
        for (index, (hash, value)) in variants.into_iter().enumerate() {
            let name = if index == 0 {
                path.clone()
            } else {
                (1..)
                    .map(|n| conflict_name(path, hash, n))
                    .find(|name| reserved.insert(name.clone()))
                    .expect("unbounded conflict names")
            };
            result.insert(name, value);
        }
    }
    validate_tree(&result)?;
    Ok(result)
}

fn same_file(entry: Option<&FileEntry>, other: Option<&FileEntry>) -> bool {
    entry.map(|f| &f.hash) == other.map(|f| &f.hash)
}

fn record_key(id: &str) -> String {
    format!("manifests/{}/{id}.json", &id[..1])
}

async fn fetch_records(
    client: &WebdavClient,
    records: &mut Records,
    previous: &BTreeSet<String>,
) -> Result<BTreeSet<String>, AppError> {
    let seen = client.list_journal_records().await?;
    if !previous.is_subset(&seen) {
        return Err(AppError::message(
            "WebDAV listing omitted previously observed journal records",
        ));
    }
    for (id, cached) in records.iter() {
        if snapshot::hash_bytes(&serde_json::to_vec(cached)?) != *id {
            return Err(AppError::message("invalid local WebDAV journal checkpoint"));
        }
    }
    for id in seen.difference(previous) {
        let bytes = client
            .journal_record(&record_key(id), MAX_MANIFEST_BYTES as usize)
            .await?;
        let record: Record = serde_json::from_slice(&bytes)?;
        if snapshot::hash_bytes(&bytes) != *id || serde_json::to_vec(&record)? != bytes {
            return Err(AppError::message("WebDAV journal record checksum mismatch"));
        }
        validate_manifest(&Manifest {
            files: record.adds.clone(),
            ..Default::default()
        })?;
        records.insert(id.clone(), record);
    }
    Ok(seen)
}

fn local_changes(
    state: &Journal,
    scope: SyncScope,
    local: &Files,
    base: &BTreeMap<String, Value>,
    remote: &BTreeMap<String, Value>,
) -> Record {
    let paths: BTreeSet<_> = base.keys().chain(local.keys()).collect();
    let roots = scope::paper_roots(paths.iter().map(|p| p.as_str()));
    let mut change = Record::default();
    for path in paths {
        let current = local.get(path);
        if scope::excluded(&scope, path, &roots) {
            continue;
        }
        let old = base
            .get(path)
            .filter(|_| !scope::excluded(&state.scope, path, &roots));
        if same_file(current, old.map(|old| &old.entry))
            || state
                .before
                .get(path)
                .is_some_and(|hash| hash.as_ref() == current.map(|f| &f.hash))
        {
            continue;
        }
        if old.is_none() && same_file(current, remote.get(path).map(|value| &value.entry)) {
            continue;
        }
        // A third value during interrupted apply may be an edit of the
        // pre-download file. Preserve the incoming version in that case.
        if let Some(old) = old.filter(|_| !state.before.contains_key(path)) {
            change.removes.extend(old.versions.iter().cloned());
        }
        if let Some(file) = current {
            change.adds.insert(path.clone(), file.clone());
        }
    }
    change
}

pub(super) async fn run(
    vault: &Path,
    cfg: &SyncBackendConfig,
    mut state: Journal,
    progress: Progress<'_>,
) -> Result<SyncOutcome, AppError> {
    let client = WebdavClient::new(cfg)?;
    state.verify_remote(&client).await?;
    progress("pull", 0, 0);
    let mut records = std::mem::take(&mut state.records);
    let previous = records.keys().cloned().collect::<BTreeSet<_>>();
    let mut seen = fetch_records(&client, &mut records, &previous).await?;
    let remote = view(&records, &seen)?;
    let base = view(&records, &previous)?;
    progress("scan", 0, 0);
    local::clear_staged(vault)?;
    let scope = cfg.scope;
    let mut scan_cache = Manifest::default();
    if state.before.is_empty() && state.scope == scope {
        scan_cache.files = base
            .iter()
            .map(|(path, value)| (path.clone(), value.entry.clone()))
            .collect();
    }
    let local = scan_local(vault, scan_cache, scope).await?;
    let mut change = local_changes(&state, scope, &local, &base, &remote);
    let mut outcome = SyncOutcome::default();
    let target = if change.adds.is_empty() && change.removes.is_empty() {
        remote
    } else {
        // Parents are the history the local edits were based on. A retry
        // after losing the PUT response must generate the same record ID.
        change.parents = previous.clone();
        for id in &previous {
            for parent in &records[id].parents {
                change.parents.remove(parent);
            }
        }
        let mut available: HashSet<_> = records
            .values()
            .flat_map(|r| r.adds.values().map(|e| e.hash.clone()))
            .collect();
        for (i, (path, entry)) in change.adds.iter().enumerate() {
            if available.insert(entry.hash.clone()) {
                progress("upload", i + 1, change.adds.len());
                client
                    .journal_put(&blob_key(&entry.hash), read_blob(vault, path, entry)?)
                    .await?;
                outcome.uploaded += 1;
            }
        }
        let bytes = serde_json::to_vec(&change)?;
        if bytes.len() > MAX_MANIFEST_BYTES as usize {
            return Err(AppError::message(
                "WebDAV journal record exceeds size limit",
            ));
        }
        let id = snapshot::hash_bytes(&bytes);
        let unpublished = seen.insert(id.clone());
        records.insert(id.clone(), change);
        let target = view(&records, &seen)?;
        if seen.iter().filter(|key| key.starts_with(&id[..1])).count() >= JOURNAL_LIST_LIMIT {
            return Err(AppError::message(
                "WebDAV journal prototype reached the directory listing limit",
            ));
        }
        if unpublished {
            client.journal_put(&record_key(&id), bytes).await?;
        }
        outcome.removed_remote = remote.keys().filter(|p| !target.contains_key(*p)).count();
        target
    };
    let files = target
        .iter()
        .map(|(p, v)| (p.clone(), v.entry.clone()))
        .collect();
    // All scanned local edits have now been published. Reuse the ordinary
    // merge planner to install this view, including scope and shape checks.
    let plan = merge(&local, &local, &files, &scope, &SyncScope::all());
    outcome
        .conflict_copies
        .extend(plan.downloads.iter().filter_map(|(path, _)| {
            target[path]
                .versions
                .first()
                .filter(|(_, original)| original != path)
                .map(|_| path.clone())
        }));
    let prepared = prepare_local(vault, &client, &plan, &local, progress).await?;
    let checkpoint_changed = scope != state.scope || !state.before.is_empty();
    state.records = records;
    state.scope = scope;
    state.before = plan
        .downloads
        .iter()
        .map(|(p, _)| p)
        .chain(&plan.delete_local)
        .map(|p| (p.clone(), local.get(p).map(|f| f.hash.clone())))
        .collect();
    if previous != seen || !state.before.is_empty() || checkpoint_changed {
        local::write_json(&state_path(vault), &state)?;
    }
    prepared.apply(vault, &plan, &local, &mut outcome)?;
    if !state.before.is_empty() {
        state.before.clear();
        local::write_json(&state_path(vault), &state)?;
    }
    refresh_catalog_if_needed(vault)?;
    outcome.version = state.records.len() as u64;
    local::write_meta(
        vault,
        &SyncMeta {
            last_sync_at: Some(now()),
            last_version: outcome.version,
            ..Default::default()
        },
    )?;
    Ok(outcome)
}
