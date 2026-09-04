//! Recycle bin over remote `VaultFs` (SFTP / local-sim).
//!
//! Semantics match local `services/trash.rs`: `.agentero/.trash/<batchId>/` +
//! `manifest.json` with catalog snapshots. Files move via rename (copy+remove
//! fallback). Catalog mutations hit the session work mirror then PUT.

use super::session::RemoteSession;
use crate::core::error::AppError;
use crate::core::fs::{VaultFs, WriteOpts};
use crate::features::catalog::papers::{self, PaperRecord};
use crate::features::trash::{TrashEntry, TrashResult};
use serde::{Deserialize, Serialize};
use std::path::Path;

const TRASH_REL: &str = ".agentero/.trash";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrashItem {
    rel: String,
    stored: String,
    #[serde(default)]
    catalog_rows: Vec<PaperRecord>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrashManifest {
    batch_id: String,
    created_at: String,
    items: Vec<TrashItem>,
}

fn norm_rel(rel: &str) -> String {
    rel.replace('\\', "/").trim_matches('/').to_string()
}

fn is_under_papers(rel: &str) -> bool {
    rel == "papers" || rel.starts_with("papers/")
}

fn validate_batch_id(batch_id: &str) -> Result<(), AppError> {
    if batch_id.is_empty()
        || batch_id.contains('/')
        || batch_id.contains('\\')
        || batch_id.contains("..")
    {
        return Err(AppError::message("invalid batch id"));
    }
    Ok(())
}

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
    let batch_rel = format!("{TRASH_REL}/{batch_id}");

    let mut items: Vec<TrashItem> = Vec::new();
    for (i, raw) in rels.iter().enumerate() {
        let rel = norm_rel(raw);
        if rel.is_empty() || rel == "papers" || rel.contains("..") {
            continue;
        }
        if rel.starts_with(".agentero") {
            continue;
        }
        if !fs.exists(&rel).await? {
            continue;
        }

        let base = Path::new(&rel)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("item")
            .to_string();
        let stored = format!("{i}__{base}");
        let dest = format!("{batch_rel}/{stored}");

        // Snapshot catalog from work mirror before moving files.
        let catalog_rows = if is_under_papers(&rel) {
            papers::list_under_path(&session.work_root, &rel).unwrap_or_default()
        } else {
            Vec::new()
        };

        let _ = fs.mkdir(TRASH_REL).await;
        let _ = fs.mkdir(&batch_rel).await;

        if let Err(e) = move_path(fs.as_ref(), &rel, &dest).await {
            // Leave item in place; do not touch catalog for this path.
            log::warn!("remote trash move {rel} → {dest}: {e}");
            continue;
        }

        if is_under_papers(&rel) {
            let _ = papers::delete_under_path(&session.work_root, &rel);
        }
        items.push(TrashItem {
            rel,
            stored,
            catalog_rows,
        });
    }

    if items.is_empty() {
        let _ = fs.remove(&batch_rel, true).await;
        return Ok(TrashResult {
            batch_id,
            count: 0,
            rels: Vec::new(),
        });
    }

    let rels: Vec<String> = items.iter().map(|item| item.rel.clone()).collect();
    let manifest = TrashManifest {
        batch_id: batch_id.clone(),
        created_at: crate::core::time::now_rfc3339_millis(),
        items,
    };
    write_manifest(fs.as_ref(), &batch_rel, &manifest).await?;

    {
        let mut cat = session.catalog.lock().await;
        cat.push(fs.clone()).await?;
    }

    Ok(TrashResult {
        batch_id: manifest.batch_id,
        count: manifest.items.len(),
        rels,
    })
}

pub async fn restore_batch(session: &RemoteSession, batch_id: &str) -> Result<usize, AppError> {
    validate_batch_id(batch_id)?;
    let fs = session.fs.clone();
    let batch_rel = format!("{TRASH_REL}/{batch_id}");
    let manifest = read_manifest(fs.as_ref(), &batch_rel).await?;

    for item in &manifest.items {
        if fs.exists(&item.rel).await? {
            return Err(AppError::message(format!(
                "cannot undo: '{}' already exists",
                item.rel
            )));
        }
    }

    for item in &manifest.items {
        let stored = format!("{batch_rel}/{}", item.stored);
        // Ensure parent of original path exists
        if let Some(parent) = Path::new(&item.rel).parent() {
            let p = parent.to_string_lossy().replace('\\', "/");
            if !p.is_empty() && p != "." {
                let _ = fs.mkdir(&p).await;
            }
        }
        move_path(fs.as_ref(), &stored, &item.rel).await?;
        for row in &item.catalog_rows {
            papers::upsert_paper(&session.work_root, row)?;
        }
    }

    let _ = fs.remove(&batch_rel, true).await;
    {
        let mut cat = session.catalog.lock().await;
        cat.push(fs.clone()).await?;
    }
    Ok(manifest.items.len())
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
        let batch_rel = format!("{TRASH_REL}/{}", batch.name);
        let Ok(manifest) = read_manifest(fs, &batch_rel).await else {
            continue;
        };
        for item in &manifest.items {
            let stored_path = format!("{batch_rel}/{}", item.stored);
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
    let batch_rel = format!("{TRASH_REL}/{batch_id}");
    let mut manifest = read_manifest(fs.as_ref(), &batch_rel).await?;
    let idx = manifest
        .items
        .iter()
        .position(|i| i.stored == stored)
        .ok_or_else(|| AppError::message("trash item not found"))?;

    if fs.exists(&manifest.items[idx].rel).await? {
        return Err(AppError::message(format!(
            "cannot restore: '{}' already exists",
            manifest.items[idx].rel
        )));
    }

    let item = manifest.items.remove(idx);
    let stored_path = format!("{batch_rel}/{}", item.stored);
    if let Some(parent) = Path::new(&item.rel).parent() {
        let p = parent.to_string_lossy().replace('\\', "/");
        if !p.is_empty() && p != "." {
            let _ = fs.mkdir(&p).await;
        }
    }
    move_path(fs.as_ref(), &stored_path, &item.rel).await?;
    for row in &item.catalog_rows {
        papers::upsert_paper(&session.work_root, row)?;
    }

    if manifest.items.is_empty() {
        let _ = fs.remove(&batch_rel, true).await;
    } else {
        write_manifest(fs.as_ref(), &batch_rel, &manifest).await?;
    }

    {
        let mut cat = session.catalog.lock().await;
        cat.push(fs.clone()).await?;
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
    let batch_rel = format!("{TRASH_REL}/{batch_id}");
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
    let path = format!("{batch_rel}/manifest.json");
    let bytes = fs
        .read(&path)
        .await
        .map_err(|_| AppError::message("trash batch not found"))?;
    let raw = String::from_utf8(bytes).map_err(|e| AppError::message(e.to_string()))?;
    serde_json::from_str(&raw).map_err(|e| AppError::message(e.to_string()))
}

async fn write_manifest(
    fs: &dyn VaultFs,
    batch_rel: &str,
    manifest: &TrashManifest,
) -> Result<(), AppError> {
    let json =
        serde_json::to_string_pretty(manifest).map_err(|e| AppError::message(e.to_string()))?;
    let path = format!("{batch_rel}/manifest.json");
    fs.write(
        &path,
        json.as_bytes(),
        WriteOpts {
            create_parents: true,
        },
    )
    .await
}

/// Rename when possible; otherwise copy tree then remove source.
async fn move_path(fs: &dyn VaultFs, from: &str, to: &str) -> Result<(), AppError> {
    match fs.rename(from, to).await {
        Ok(()) => Ok(()),
        Err(rename_err) => {
            log::debug!("remote rename {from} → {to} failed ({rename_err}); copy fallback");
            copy_tree(fs, from, to).await?;
            fs.remove(from, true).await?;
            Ok(())
        }
    }
}

async fn copy_tree(fs: &dyn VaultFs, from: &str, to: &str) -> Result<(), AppError> {
    let meta = fs.stat(from).await?;
    if meta.is_dir {
        fs.mkdir(to).await?;
        let entries = fs.list(from).await?;
        for e in entries {
            let child_from = if from.is_empty() {
                e.name.clone()
            } else {
                format!("{from}/{}", e.name)
            };
            let child_to = format!("{to}/{}", e.name);
            Box::pin(copy_tree(fs, &child_from, &child_to)).await?;
        }
        Ok(())
    } else {
        let bytes = fs.read(from).await?;
        fs.write(
            to,
            &bytes,
            WriteOpts {
                create_parents: true,
            },
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::fs::WriteOpts;
    use crate::integration::remote::session::{RemoteRegistry, LOCAL_SIM_HOST};
    use std::env;

    fn sample_record(path: &str, id: &str) -> PaperRecord {
        PaperRecord {
            path: path.into(),
            id: id.into(),
            paper_type: "article".into(),
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
            added_at: "t".into(),
            updated_at: "t".into(),
        }
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
