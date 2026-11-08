//! Recycle bin over remote `VaultFs` (SFTP / local-sim).
//!
//! Eligibility, stored names, manifest types, and batch-id checks come from
//! core `plan_trash`. Files move via rename only. Catalog
//! mutations hit the session work mirror, then the existing `cat.push`.

use super::session::{RemoteRegistry, RemoteSession};
use crate::core::error::AppError;
use crate::core::fs::{normalize_rel_separators, VaultFs, WriteOpts};
use crate::features::paper::catalog::papers;
use crate::features::vault::trash::remote_ops::RemoteTrashOps;
use crate::features::vault::trash::{
    delete_absent_paper_rows, delete_trashed_catalog, is_trash_candidate, plan_trash,
    restore_action, restore_catalog, restore_sidecar_path, snapshot_title, trash_batch_rel,
    validate_batch_id, RestoreAction, TrashEntry, TrashManifest, TrashPhase, TrashResult,
    TRASH_REL,
};
use std::collections::HashMap;
use std::path::Path;

/// Move vault-relative paths into a new remote recycle-bin batch.
pub async fn trash_paths(
    session: &RemoteSession,
    rels: &[String],
) -> Result<TrashResult, AppError> {
    let fs = session.fs.clone();
    let now = chrono::Utc::now();
    let batch_id = format!(
        "{}-{}",
        now.format("%Y%m%dT%H%M%S"),
        now.timestamp_subsec_nanos()
    );

    // Existence is async, so resolve it before the sync plan. An exists error
    // still aborts before any move. Ineligible shapes are not probed.
    let mut present_map = HashMap::new();
    for raw in rels {
        let rel = normalize_rel_separators(raw);
        if !is_trash_candidate(&rel) {
            continue;
        }
        present_map.insert(rel.clone(), fs.exists(&rel).await?);
    }

    let work_root = session.work_root.clone();
    let mut snapshots = HashMap::new();
    for rel in present_map.keys() {
        snapshots.insert(rel.clone(), papers::list_under_path(&work_root, rel)?);
    }
    let plan = plan_trash(
        rels,
        &batch_id,
        |rel| present_map.get(rel).copied().unwrap_or(false),
        |rel| snapshots.remove(rel).unwrap_or_default(),
    )?;
    if plan.items.is_empty() {
        let removed = delete_absent_paper_rows(&work_root, rels, &[])?;
        if !removed.is_empty() {
            let mut cat = session.catalog.lock().await;
            cat.push(fs.clone()).await?;
        }
        return Ok(TrashResult {
            batch_id,
            count: 0,
            rels: removed,
        });
    }

    let batch_rel = trash_batch_rel(&plan.batch_id);
    fs.mkdir(&batch_rel).await?;
    let mut manifest = TrashManifest {
        batch_id: plan.batch_id,
        created_at: crate::core::time::now_rfc3339_millis(),
        items: plan.items.into_iter().map(Into::into).collect(),
    };
    write_manifest(fs.as_ref(), &batch_rel, &manifest).await?;
    for index in 0..manifest.items.len() {
        let item = &manifest.items[index];
        fs.rename(&item.rel, &format!("{batch_rel}/{}", item.stored))
            .await?;
        manifest.items[index].phase = TrashPhase::Trashed;
        write_manifest(fs.as_ref(), &batch_rel, &manifest).await?;
    }
    let mut rels_out: Vec<String> = manifest.items.iter().map(|item| item.rel.clone()).collect();
    let catalog_result =
        delete_trashed_catalog(&session.work_root, &manifest.batch_id, &manifest.items);
    let absent_result = if catalog_result.is_ok() {
        let mut ids = Vec::new();
        for item in &manifest.items {
            for row in &item.catalog_rows {
                if !row.id.is_empty() {
                    ids.push(row.id.clone());
                }
            }
        }
        delete_absent_paper_rows(&session.work_root, rels, &ids)
    } else {
        Ok(Vec::new())
    };

    // Publish even when a catalog delete failed, so the mirror does not keep
    // a partial delete that the server has not seen. A push failure leaves
    // the batch in place.
    {
        let mut cat = session.catalog.lock().await;
        cat.push(fs.clone()).await?;
    }
    catalog_result?;
    rels_out.extend(absent_result?);

    Ok(TrashResult {
        batch_id: manifest.batch_id,
        count: manifest.items.len(),
        rels: rels_out,
    })
}

pub async fn restore_batch(session: &RemoteSession, batch_id: &str) -> Result<usize, AppError> {
    validate_batch_id(batch_id)?;
    let fs = session.fs.clone();
    let batch_rel = trash_batch_rel(batch_id);
    let mut manifest = read_manifest(fs.as_ref(), &batch_rel).await?;
    let count = manifest.items.len();
    for item in &manifest.items {
        restore_action(
            item,
            fs.exists(&format!("{batch_rel}/{}", item.stored)).await?,
            fs.exists(&item.rel).await?,
        )?;
    }
    for index in 0..count {
        restore_remote_entry(session, &batch_rel, &mut manifest, index).await?;
    }
    session.push_catalog().await?;
    fs.remove(&batch_rel, true).await?;
    Ok(count)
}

async fn restore_remote_entry(
    session: &RemoteSession,
    batch: &str,
    manifest: &mut TrashManifest,
    index: usize,
) -> Result<(), AppError> {
    let fs = session.fs.as_ref();
    let item = &manifest.items[index];
    let stored = format!("{batch}/{}", item.stored);
    let target = item.rel.clone();
    match restore_action(item, fs.exists(&stored).await?, fs.exists(&target).await?)? {
        RestoreAction::Unmoved => return Ok(()),
        RestoreAction::Move => {
            manifest.items[index].phase = TrashPhase::Restoring;
            write_manifest(fs, batch, manifest).await?;
            let item = &manifest.items[index];
            for row in &item.catalog_rows {
                let rel = restore_sidecar_path(item, row)?
                    .to_string_lossy()
                    .replace('\\', "/");
                let path = format!("{stored}/{rel}");
                if !fs
                    .exists(path.rsplit_once('/').expect("sidecar parent").0)
                    .await?
                {
                    continue;
                }
                let temp = format!("{path}.tmp");
                fs.write(
                    &temp,
                    &serde_json::to_vec_pretty(row)?,
                    WriteOpts::default(),
                )
                .await?;
                fs.rename(&temp, &path).await?;
            }
            if let Some(parent) = Path::new(&target).parent() {
                let parent = parent.to_string_lossy().replace('\\', "/");
                if !parent.is_empty() {
                    fs.mkdir(&parent).await?;
                }
            }
            fs.rename(&stored, &target).await?;
        }
        RestoreAction::Finish => {}
    }
    let mut present = Vec::new();
    for row in &manifest.items[index].catalog_rows {
        if fs.exists(&row.path).await? {
            present.push(row.path.clone());
        }
    }
    let mut catalog = session.catalog.lock().await;
    for path in present {
        catalog.queue_sidecar(path);
    }
    restore_catalog(&session.work_root, &manifest.items[index])
}

pub async fn list_trash(session: &RemoteSession) -> Result<Vec<TrashEntry>, AppError> {
    let fs = session.fs.as_ref();
    let mut out: Vec<TrashEntry> = Vec::new();
    if !fs.exists(TRASH_REL).await? {
        return Ok(out);
    }
    let batches = fs.list(TRASH_REL).await.unwrap_or_default();
    for batch in batches {
        if !batch.is_dir {
            continue;
        }
        let batch_rel = trash_batch_rel(&batch.name);
        let Ok(manifest) = read_manifest(fs, &batch_rel).await else {
            continue;
        };
        for item in &manifest.items {
            let stored_path = format!("{batch_rel}/{}", item.stored);
            if item.phase == TrashPhase::Prepared && !fs.exists(&stored_path).await? {
                continue;
            }
            let is_dir = fs
                .stat(&stored_path)
                .await
                .map(|m| m.is_dir)
                .unwrap_or(false);
            let name = Path::new(&item.rel)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(item.rel.as_str())
                .to_string();
            out.push(TrashEntry {
                id: format!("{}::{}", manifest.batch_id, item.stored),
                batch_id: manifest.batch_id.clone(),
                stored: item.stored.clone(),
                rel: item.rel.clone(),
                name,
                title: snapshot_title(&item.catalog_rows),
                deleted_at: manifest.created_at.clone(),
                is_dir,
            });
        }
    }
    out.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(out)
}

pub async fn restore_item(
    session: &RemoteSession,
    batch_id: &str,
    stored: &str,
) -> Result<String, AppError> {
    validate_batch_id(batch_id)?;
    let fs = session.fs.clone();
    let batch_rel = trash_batch_rel(batch_id);
    let mut manifest = read_manifest(fs.as_ref(), &batch_rel).await?;
    let idx = manifest
        .items
        .iter()
        .position(|i| i.stored == stored)
        .ok_or_else(|| AppError::message("trash item not found"))?;

    restore_remote_entry(session, &batch_rel, &mut manifest, idx).await?;
    session.push_catalog().await?;
    let item = manifest.items.remove(idx);
    if manifest.items.is_empty() {
        fs.remove(&batch_rel, true).await?;
    } else {
        write_manifest(fs.as_ref(), &batch_rel, &manifest).await?;
    }
    Ok(item.rel)
}

pub async fn purge_item(
    session: &RemoteSession,
    batch_id: &str,
    stored: &str,
) -> Result<(), AppError> {
    validate_batch_id(batch_id)?;
    let fs = session.fs.as_ref();
    let batch_rel = trash_batch_rel(batch_id);
    let mut manifest = read_manifest(fs, &batch_rel).await?;
    let idx = manifest
        .items
        .iter()
        .position(|i| i.stored == stored)
        .ok_or_else(|| AppError::message("trash item not found"))?;
    let item = manifest.items.remove(idx);
    let stored_path = format!("{batch_rel}/{}", item.stored);
    let _ = fs.remove(&stored_path, true).await;
    if manifest.items.is_empty() {
        let _ = fs.remove(&batch_rel, true).await;
    } else {
        write_manifest(fs, &batch_rel, &manifest).await?;
    }
    Ok(())
}

pub async fn purge_all(session: &RemoteSession) -> Result<(), AppError> {
    let fs = session.fs.as_ref();
    if fs.exists(TRASH_REL).await? {
        fs.remove(TRASH_REL, true).await?;
    }
    Ok(())
}

async fn read_manifest(fs: &dyn VaultFs, batch_rel: &str) -> Result<TrashManifest, AppError> {
    let bytes = fs.read(&format!("{batch_rel}/manifest.json")).await?;
    Ok(serde_json::from_slice(&bytes)?)
}

async fn write_manifest(
    fs: &dyn VaultFs,
    batch_rel: &str,
    manifest: &TrashManifest,
) -> Result<(), AppError> {
    let json = serde_json::to_vec_pretty(manifest)?;
    let path = format!("{batch_rel}/manifest.json");
    let temp = format!("{batch_rel}/manifest.json.tmp");
    fs.write(
        &temp,
        &json,
        WriteOpts {
            create_parents: true,
        },
    )
    .await?;
    fs.rename(&temp, &path).await
}

#[async_trait::async_trait]
impl RemoteTrashOps for RemoteRegistry {
    async fn trash_paths_remote(
        &self,
        session_id: &str,
        rels: &[String],
    ) -> Result<TrashResult, AppError> {
        let session = self.get(session_id).await?;
        trash_paths(&session, rels).await
    }

    async fn list_trash_remote(&self, session_id: &str) -> Result<Vec<TrashEntry>, AppError> {
        let session = self.get(session_id).await?;
        list_trash(&session).await
    }

    async fn purge_all_remote(&self, session_id: &str) -> Result<(), AppError> {
        let session = self.get(session_id).await?;
        purge_all(&session).await
    }

    async fn restore_item_remote(
        &self,
        session_id: &str,
        batch_id: &str,
        stored: &str,
    ) -> Result<String, AppError> {
        let session = self.get(session_id).await?;
        restore_item(&session, batch_id, stored).await
    }

    async fn purge_item_remote(
        &self,
        session_id: &str,
        batch_id: &str,
        stored: &str,
    ) -> Result<(), AppError> {
        let session = self.get(session_id).await?;
        purge_item(&session, batch_id, stored).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::fs::WriteOpts;
    use crate::features::paper::catalog::papers::PaperRecord;
    use crate::integration::remote::session::{RemoteRegistry, LOCAL_SIM_HOST};
    use std::env;

    fn sample_record(path: &str, id: &str) -> PaperRecord {
        PaperRecord {
            path: path.into(),
            id: id.into(),
            paper_type: papers::PaperKind::Doi,
            title: "T".into(),
            authors: vec![],
            creators: None,
            year: None,
            date: None,
            abstract_text: None,
            tags: vec![],
            arxiv_id: None,
            doi: None,
            isbn: None,
            issn: None,
            pmid: None,
            publication: None,
            volume: None,
            issue: None,
            pages: None,
            publisher: None,
            place: None,
            series: None,
            language: None,
            pdf_url: None,
            html_url: None,
            source_url: None,
            code_repo: None,
            openreview_url: None,
            body_source: None,
            body_quality: None,
            bibtex_key: None,
            citation_count: None,
            zotero_item_type: None,
            meta_source: None,
            extra: None,
            summary: None,
            status: "completed".into(),
            is_read: false,
            zotero_item_id: None,
            zotero_last_synced: None,
            custom_props: Default::default(),
            added_at: "t".into(),
            updated_at: "t".into(),
        }
    }

    #[tokio::test]
    async fn restore_parent_skips_sidecars_for_orphan_rows() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("papers/group")).unwrap();
        std::fs::write(root.path().join("papers/group/note.md"), "keep").unwrap();
        let reg = RemoteRegistry::new();
        let info = reg
            .connect(LOCAL_SIM_HOST, None, &root.path().to_string_lossy())
            .await
            .unwrap();
        let session = reg.get(&info.session_id).await.unwrap();
        papers::upsert_paper(
            &session.work_root,
            &sample_record("papers/group/missing", "missing"),
        )
        .unwrap();
        session.push_catalog().await.unwrap();
        let batch = trash_paths(&session, &["papers/group".into()])
            .await
            .unwrap();
        restore_batch(&session, &batch.batch_id).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(root.path().join("papers/group/note.md")).unwrap(),
            "keep"
        );
        assert!(!root.path().join("papers/group/missing").exists());
        reg.disconnect(&info.session_id).await.unwrap();
    }

    #[tokio::test]
    async fn restore_keeps_manifest_until_publish_succeeds() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("papers/x")).unwrap();
        let reg = RemoteRegistry::new();
        let info = reg
            .connect(LOCAL_SIM_HOST, None, &root.path().to_string_lossy())
            .await
            .unwrap();
        let session = reg.get(&info.session_id).await.unwrap();
        let mut record = sample_record("papers/x", "x");
        std::fs::write(
            root.path().join("papers/x/metadata.json"),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();
        record.title = "Latest".into();
        papers::upsert_paper(&session.work_root, &record).unwrap();
        session.push_catalog().await.unwrap();
        for single in [false, true] {
            let batch = trash_paths(&session, &["papers/x".into()]).await.unwrap();
            let batch_rel = trash_batch_rel(&batch.batch_id);
            let manifest = read_manifest(session.fs.as_ref(), &batch_rel)
                .await
                .unwrap();
            let stored = &manifest.items[0].stored;
            let obstacle = root.path().join(".agentero/catalog.sqlite.tmp");
            std::fs::create_dir(&obstacle).unwrap();
            let result = if single {
                restore_item(&session, &batch.batch_id, stored)
                    .await
                    .map(|_| ())
            } else {
                restore_batch(&session, &batch.batch_id).await.map(|_| ())
            };
            assert!(result.is_err());
            assert!(root.path().join(&batch_rel).join("manifest.json").is_file());
            assert!(root.path().join("papers/x").is_dir());
            assert_eq!(
                agentero_core::features::catalog::sidecar::read_sidecar(root.path(), "papers/x")
                    .unwrap()
                    .title,
                "Latest"
            );
            papers::set_is_read(&session.work_root, "papers/x", true).unwrap();
            std::fs::remove_dir(&obstacle).unwrap();
            if single {
                restore_item(&session, &batch.batch_id, stored)
                    .await
                    .unwrap();
            } else {
                restore_batch(&session, &batch.batch_id).await.unwrap();
            }
            assert!(!root.path().join(&batch_rel).exists());
            assert!(
                papers::get_by_path(&session.work_root, "papers/x")
                    .unwrap()
                    .unwrap()
                    .is_read
            );
        }
        reg.disconnect(&info.session_id).await.unwrap();
    }

    #[tokio::test]
    async fn local_sim_trash_restore_roundtrip() {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = env::temp_dir().join(format!("agentero-remote-trash-{n}"));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("papers/x")).unwrap();
        std::fs::write(root.join("papers/x/NOTES.md"), "# x\n").unwrap();
        std::fs::create_dir_all(root.join(".agentero")).unwrap();

        let reg = RemoteRegistry::new();
        let info = reg
            .connect(LOCAL_SIM_HOST, None, &root.to_string_lossy())
            .await
            .expect("connect");
        let session = reg.get(&info.session_id).await.unwrap();

        papers::upsert_paper(&session.work_root, &sample_record("papers/x", "x")).unwrap();
        {
            let mut cat = session.catalog.lock().await;
            cat.push(session.fs.clone()).await.unwrap();
        }

        let res = trash_paths(&session, &["papers/x".into()])
            .await
            .expect("trash");
        assert_eq!(res.count, 1);
        assert!(!session.fs.exists("papers/x").await.unwrap());
        assert!(papers::get_by_path(&session.work_root, "papers/x")
            .unwrap()
            .is_none());

        let listed = list_trash(&session).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].rel, "papers/x");

        let n = restore_batch(&session, &res.batch_id).await.unwrap();
        assert_eq!(n, 1);
        assert!(session.fs.exists("papers/x/NOTES.md").await.unwrap());
        assert!(papers::get_by_path(&session.work_root, "papers/x")
            .unwrap()
            .is_some());

        // trash file then purge
        session
            .fs
            .write(
                "notes/a.md",
                b"hi",
                WriteOpts {
                    create_parents: true,
                },
            )
            .await
            .unwrap();
        let res2 = trash_paths(&session, &["notes/a.md".into()]).await.unwrap();
        assert_eq!(res2.count, 1);
        purge_all(&session).await.unwrap();
        assert!(list_trash(&session).await.unwrap().is_empty());

        reg.disconnect(&info.session_id).await.unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }
}
