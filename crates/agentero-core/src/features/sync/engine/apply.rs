use super::{
    blob_key, gunzip_limited, local, snapshot, AppError, FileEntry, MergePlan, Progress,
    RemoteStore, SyncOutcome,
};
use std::{collections::BTreeMap, fs, io::Write, path::Path};

pub(super) struct PreparedLocal {
    writes: Vec<(String, tempfile::NamedTempFile)>,
}

pub(super) async fn prepare_local<S: RemoteStore>(
    vault: &Path,
    client: &S,
    plan: &MergePlan,
    scanned: &BTreeMap<String, FileEntry>,
    progress: Progress<'_>,
) -> Result<PreparedLocal, AppError> {
    let mut writes = Vec::new();
    for (from, to) in &plan.preserve_local {
        verify_local_unchanged(vault, from, scanned.get(from))?;
        let staged = local::stage_file(vault)?;
        fs::copy(vault.join(from), staged.path())?;
        if snapshot::hash_file(staged.path())? != plan.merged[to].hash {
            return Err(AppError::message(format!("{from} changed during sync")));
        }
        writes.push((to.clone(), staged));
    }
    for (index, (rel, entry)) in plan.downloads.iter().enumerate() {
        progress("download", index + 1, plan.downloads.len());
        let (bytes, _) = client
            .get(&blob_key(&entry.hash))
            .await?
            .ok_or_else(|| AppError::message(format!("blob missing for {rel}")))?;
        let raw = gunzip_limited(&bytes, entry.size)?;
        if raw.len() as u64 != entry.size || snapshot::hash_bytes(&raw) != entry.hash {
            return Err(AppError::message(format!("blob corrupt for {rel}")));
        }
        let mut staged = local::stage_file(vault)?;
        staged.write_all(&raw)?;
        writes.push((rel.clone(), staged));
    }
    Ok(PreparedLocal { writes })
}

impl PreparedLocal {
    pub(super) fn apply(
        self,
        vault: &Path,
        plan: &MergePlan,
        scanned: &BTreeMap<String, FileEntry>,
        outcome: &mut SyncOutcome,
    ) -> Result<(), AppError> {
        let mut dirs = std::collections::BTreeSet::new();
        for (rel, _) in &self.writes {
            check_parents(vault, rel)?;
            let target = vault.join(rel);
            if fs::symlink_metadata(&target).is_ok_and(|meta| meta.is_dir()) {
                for item in walkdir::WalkDir::new(&target).follow_root_links(false) {
                    let item = item.map_err(|e| AppError::message(e.to_string()))?;
                    if item.file_type().is_dir() {
                        dirs.insert(item.into_path());
                        continue;
                    }
                    let child = item
                        .path()
                        .strip_prefix(vault)
                        .expect("vault descendant")
                        .to_string_lossy()
                        .replace('\\', "/");
                    if !item.file_type().is_file()
                        || plan.delete_local.binary_search(&child).is_err()
                    {
                        return Err(AppError::message(format!(
                            "cannot replace {rel}: local item {child} must be kept"
                        )));
                    }
                }
            }
        }
        if !self.writes.is_empty() || !plan.delete_local.is_empty() {
            local::mark_catalog_dirty(vault)?;
        }
        for rel in &plan.delete_local {
            verify_local_unchanged(vault, rel, scanned.get(rel))?;
            fs::remove_file(vault.join(rel))?;
            outcome.deleted_local += 1;
        }
        for dir in dirs.iter().rev() {
            fs::remove_dir(dir)?;
        }
        for (rel, staged) in self.writes {
            verify_local_unchanged(vault, &rel, scanned.get(&rel))?;
            let target = vault.join(&rel);
            fs::create_dir_all(target.parent().expect("vault descendant"))?;
            if scanned.contains_key(&rel) {
                staged.persist(&target)
            } else {
                staged.persist_noclobber(&target)
            }
            .or_else(|error| {
                if error.error.kind() != std::io::ErrorKind::CrossesDevices {
                    return Err(error.error);
                }
                let sibling = tempfile::Builder::new()
                    .suffix(".tmp")
                    .tempfile_in(target.parent().expect("vault descendant"))?;
                fs::copy(error.file.path(), sibling.path())?;
                if scanned.contains_key(&rel) {
                    sibling.persist(&target)
                } else {
                    sibling.persist_noclobber(&target)
                }
                .map_err(|e| e.error)
            })?;
        }
        outcome.downloaded += plan.downloads.len();
        outcome
            .conflict_copies
            .extend_from_slice(&plan.conflict_copies);
        Ok(())
    }
}

fn check_parents(vault: &Path, rel: &str) -> Result<(), AppError> {
    for (offset, _) in rel.match_indices('/') {
        match fs::symlink_metadata(vault.join(&rel[..offset])) {
            Ok(meta) if meta.is_symlink() => {
                return Err(AppError::message(format!("symlink parent of {rel}")))
            }
            Ok(meta) if !meta.is_dir() => break,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            Err(e) => return Err(e.into()),
            _ => (),
        }
    }
    Ok(())
}

/// Recheck after network I/O before applying a plan based on the initial scan.
fn verify_local_unchanged(
    vault: &Path,
    rel: &str,
    scanned: Option<&FileEntry>,
) -> Result<(), AppError> {
    check_parents(vault, rel)?;
    let path = vault.join(rel);
    let unchanged = match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => scanned.is_none(),
        Err(error) => return Err(error.into()),
        Ok(meta) => match scanned {
            Some(entry) if meta.is_file() && meta.len() == entry.size => {
                snapshot::hash_file(&path)? == entry.hash
            }
            _ => false,
        },
    };
    if unchanged {
        return Ok(());
    }
    Err(AppError::message(format!(
        "{rel} changed during sync; run sync again"
    )))
}
