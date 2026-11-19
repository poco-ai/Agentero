use super::{load_manifest, record_sync, HeadPointer, MergePlan, HEAD_KEY};
use crate::error::AppError;
use crate::features::sync::{
    local,
    snapshot::{self, FileEntry, Manifest, SyncScope},
    store::RemoteStore,
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::Path};

#[derive(Serialize, Deserialize)]
struct Intent {
    store: String,
    head: HeadPointer,
    scope: SyncScope,
    before: BTreeMap<String, Option<FileEntry>>,
}

const PENDING: &str = "pending.json";
const ACCEPTED: &str = "accepted.json";

pub(super) fn unfinished(vault: &Path) -> Result<bool, AppError> {
    let dir = local::sync_dir(vault);
    Ok(dir.join(PENDING).try_exists()? || dir.join(ACCEPTED).try_exists()?)
}

pub(super) fn save(
    vault: &Path,
    store: &str,
    head: &HeadPointer,
    scope: &SyncScope,
    plan: &MergePlan,
    scanned: &BTreeMap<String, FileEntry>,
    accepted: bool,
) -> Result<(), AppError> {
    let before = plan
        .downloads
        .iter()
        .map(|(path, _)| path)
        .chain(&plan.delete_local)
        .chain(plan.preserve_local.iter().map(|(_, to)| to))
        .map(|path| (path.clone(), scanned.get(path).cloned()))
        .collect();
    local::write_json(
        &local::sync_dir(vault).join(if accepted { ACCEPTED } else { PENDING }),
        &Intent {
            store: store.into(),
            head: head.clone(),
            scope: *scope,
            before,
        },
    )
}

pub(super) fn accept(vault: &Path) -> Result<(), AppError> {
    let dir = local::sync_dir(vault);
    Ok(fs::rename(dir.join(PENDING), dir.join(ACCEPTED))?)
}

pub(super) fn finish(vault: &Path) -> Result<(), AppError> {
    Ok(fs::remove_file(local::sync_dir(vault).join(ACCEPTED))?)
}

pub(super) fn discard(vault: &Path) -> Result<(), AppError> {
    Ok(fs::remove_file(local::sync_dir(vault).join(PENDING))?)
}

pub(super) async fn resume(
    vault: &Path,
    store: &str,
    client: &impl RemoteStore,
) -> Result<(), AppError> {
    let dir = local::sync_dir(vault);
    let (intent, accepted): (Intent, _) =
        if let Some(intent) = local::read_json(&dir.join(ACCEPTED))? {
            (intent, true)
        } else if let Some(intent) = local::read_json(&dir.join(PENDING))? {
            (intent, false)
        } else {
            return Ok(());
        };
    if intent.store != store {
        return Err(AppError::message("unfinished sync belongs to another store; restore its binding or disconnect explicitly"));
    }
    if !accepted {
        let head = client
            .get(HEAD_KEY)
            .await?
            .map(|(bytes, _)| serde_json::from_slice::<HeadPointer>(&bytes))
            .transpose()?;
        match head {
            Some(head)
                if (head.version, &head.manifest_key)
                    == (intent.head.version, &intent.head.manifest_key) =>
            {
                accept(vault)?;
            }
            Some(head) if head.version > intent.head.version => {
                return Err(AppError::message(
                    "publication outcome unknown and HEAD has advanced; back up the vault before rebinding",
                ));
            }
            _ => return discard(vault),
        }
    }
    let mut files = load_manifest(client, &intent.head).await?.files;
    let observed = snapshot::scan_vault(vault, &Manifest::default(), &intent.scope)?;
    for (path, before) in intent.before {
        if files.get(&path).map(|e| &e.hash) != observed.get(&path).map(|e| &e.hash) {
            match before {
                Some(entry) => {
                    files.insert(path, entry);
                }
                None => {
                    files.remove(&path);
                }
            }
        }
    }
    record_sync(vault, store, &intent.head, &intent.scope, files, true)?;
    finish(vault)
}
