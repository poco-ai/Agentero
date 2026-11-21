//! Catalog checkout and checkin for remote vaults.
//!
//! SQLite cannot open over SFTP; Host keeps an ephemeral work copy and push-after-write.

use super::catalog_snapshot::CatalogSource;
use crate::core::error::AppError;
use crate::core::fs::{FsFileMeta, VaultFs, WriteOpts};
use crate::features::paper::catalog::{
    ensure_catalog, schema_version, with_catalog, SCHEMA_VERSION,
};
use rusqlite::{Connection, OpenFlags};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const CATALOG_REL: &str = ".agentero/catalog.sqlite";
const CATALOG_WAL_REL: &str = ".agentero/catalog.sqlite-wal";
const CATALOG_TMP_REL: &str = ".agentero/catalog.sqlite.tmp";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RemoteFileStamp {
    pub size: u64,
    pub mtime: u64,
}

impl From<FsFileMeta> for RemoteFileStamp {
    fn from(m: FsFileMeta) -> Self {
        Self {
            size: m.size,
            mtime: m.mtime,
        }
    }
}

pub struct CatalogMirror {
    work_db: PathBuf,
    source: CatalogSource,
    local_digest: Vec<u8>,
    /// Stamp of the remote file at last successful GET/PUT.
    remote_stamp: RemoteFileStamp,
    pending_sidecars: HashSet<String>,
}

impl CatalogMirror {
    pub fn work_db_path(&self) -> &Path {
        &self.work_db
    }

    /// Download remote catalog (or create empty + migrate if missing), store under `work_root`.
    pub async fn checkout(
        fs: Arc<dyn VaultFs>,
        work_root: &Path,
        source: CatalogSource,
    ) -> Result<Self, AppError> {
        let work_agentero = work_root.join(".agentero");
        std::fs::create_dir_all(&work_agentero)?;
        let work_db = work_agentero.join("catalog.sqlite");

        let stamp = if fs.exists(CATALOG_REL).await? {
            let meta = fs.stat(CATALOG_REL).await?;
            let bytes = source.read().await?;
            std::fs::write(&work_db, &bytes)?;
            RemoteFileStamp::from(meta)
        } else {
            // Initialize empty catalog locally then push as authority on remote.
            if work_db.exists() {
                let _ = std::fs::remove_file(&work_db);
            }
            // ensure_catalog expects vault root (= work_root here)
            let _conn = ensure_catalog(work_root)?;
            // Create remote .agentero and push
            let _ = fs.mkdir(".agentero").await;
            let bytes = snapshot_catalog(&work_db)?;
            fs.write(
                CATALOG_REL,
                &bytes,
                WriteOpts {
                    create_parents: true,
                },
            )
            .await?;
            let meta = fs.stat(CATALOG_REL).await?;
            RemoteFileStamp::from(meta)
        };

        // Migrate the work copy; ensure_catalog also rejects future schemas.
        ensure_catalog(work_root)?;

        let local_digest = Sha256::digest(snapshot_catalog(&work_db)?).to_vec();
        Ok(Self {
            work_db,
            source,
            local_digest,
            remote_stamp: stamp,
            pending_sidecars: HashSet::new(),
        })
    }

    pub fn open(&self) -> Result<Connection, AppError> {
        let conn = Connection::open(&self.work_db)
            .map_err(|e| AppError::message(format!("open work catalog: {e}")))?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(|e| AppError::message(format!("pragma: {e}")))?;
        Ok(conn)
    }

    /// Refresh an unchanged work copy without discarding failed/unpublished writes.
    pub async fn refresh(&mut self, fs: Arc<dyn VaultFs>) -> Result<(), AppError> {
        let stamp = RemoteFileStamp::from(fs.stat(CATALOG_REL).await?);
        let bytes = self.source.read().await?;
        let root = self
            .work_db
            .parent()
            .and_then(Path::parent)
            .expect("work catalog root");
        let snapshot = tempfile::NamedTempFile::new()?;
        std::fs::write(snapshot.path(), bytes)?;
        let source =
            Connection::open_with_flags(snapshot.path(), OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let version = schema_version(&source)?;
        if version > SCHEMA_VERSION {
            return Err(AppError::message(format!(
                "catalog schema version {version} is newer than this app supports ({SCHEMA_VERSION})"
            )));
        }
        // Serialize the dirty check and restore with existing catalog readers/writers.
        self.local_digest = with_catalog(root, |_| {
            if Sha256::digest(snapshot_catalog(&self.work_db)?).as_slice() != self.local_digest {
                return Err(AppError::message(
                    "work catalog has unpublished changes; retry publishing before refreshing",
                ));
            }
            let mut destination = self.open()?;
            let backup = rusqlite::backup::Backup::new(&source, &mut destination)?;
            if backup.step(-1)? != rusqlite::backup::StepResult::Done {
                return Err(AppError::message(
                    "work catalog is busy; retry refreshing the remote vault",
                ));
            }
            drop(backup);
            drop(destination);
            let _conn = ensure_catalog(root)?;
            Ok(Sha256::digest(snapshot_catalog(&self.work_db)?).to_vec())
        })?;
        self.remote_stamp = stamp;
        Ok(())
    }

    /// Import writes the row while holding the mirror lock, then registers its
    /// sidecar before any caller can publish that row.
    pub fn queue_sidecar(&mut self, path: String) {
        self.pending_sidecars.insert(path);
    }

    fn sidecar_uploads(&self, snapshot_bytes: &[u8]) -> Result<Vec<(String, Vec<u8>)>, AppError> {
        if self.pending_sidecars.is_empty() {
            return Ok(Vec::new());
        }
        let snapshot = tempfile::NamedTempFile::new()?;
        std::fs::write(snapshot.path(), snapshot_bytes)?;
        let conn = Connection::open_with_flags(snapshot.path(), OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        crate::features::paper::catalog::papers::list_all_conn(&conn)?
            .into_iter()
            .filter(|record| self.pending_sidecars.contains(&record.path))
            .map(|record| Ok((record.path.clone(), serde_json::to_vec_pretty(&record)?)))
            .collect()
    }

    /// A disconnect may discard the work copy only when no write arrived
    /// during publishing. Keep it available for an explicit retry otherwise.
    pub async fn push_for_disconnect(&mut self, fs: Arc<dyn VaultFs>) -> Result<(), AppError> {
        self.push(fs).await?;
        if !self.pending_sidecars.is_empty()
            || Sha256::digest(snapshot_catalog(&self.work_db)?).as_slice() != self.local_digest
        {
            return Err(AppError::message(
                "remote catalog changed while publishing; retry disconnecting",
            ));
        }
        Ok(())
    }

    /// Optimistic lock + atomic-ish push (tmp then rename on remote when possible).
    pub async fn push(&mut self, fs: Arc<dyn VaultFs>) -> Result<(), AppError> {
        let bytes = snapshot_catalog(&self.work_db)?;
        let digest = Sha256::digest(&bytes).to_vec();
        if digest == self.local_digest && self.pending_sidecars.is_empty() {
            return Ok(());
        }
        // Replacing the main database while its WAL remains can corrupt the catalog.
        if fs.exists(CATALOG_WAL_REL).await? && fs.stat(CATALOG_WAL_REL).await?.size > 0 {
            return Err(AppError::message(
                "remote catalog WAL remains; close remote database connections and reopen the vault before publishing",
            ));
        }
        if fs.exists(CATALOG_REL).await? {
            let meta = fs.stat(CATALOG_REL).await?;
            let stamp = RemoteFileStamp::from(meta);
            if stamp != self.remote_stamp {
                return Err(AppError::message(
                    "remote catalog changed (conflict); reopen the remote vault",
                ));
            }
        }
        // Both payloads come from the same immutable snapshot. Other writers
        // can update the work DB while remote IO is awaiting completion.
        let sidecars = self.sidecar_uploads(&bytes)?;
        for (path, bytes) in &sidecars {
            fs.write(
                &format!("{path}/metadata.json"),
                bytes,
                WriteOpts::default(),
            )
            .await?;
        }
        // Write tmp then rename
        fs.write(
            CATALOG_TMP_REL,
            &bytes,
            WriteOpts {
                create_parents: true,
            },
        )
        .await?;
        match fs.rename(CATALOG_TMP_REL, CATALOG_REL).await {
            Ok(()) => {}
            Err(_) => {
                // Fallback: direct overwrite
                fs.write(
                    CATALOG_REL,
                    &bytes,
                    WriteOpts {
                        create_parents: true,
                    },
                )
                .await?;
                let _ = fs.remove(CATALOG_TMP_REL, false).await;
            }
        }
        let meta = fs.stat(CATALOG_REL).await?;
        self.remote_stamp = RemoteFileStamp::from(meta);
        self.local_digest = digest;
        let root = self
            .work_db
            .parent()
            .and_then(Path::parent)
            .expect("work catalog root");
        for path in self.pending_sidecars.clone() {
            let uploaded = sidecars
                .iter()
                .find(|(candidate, _)| candidate == &path)
                .map(|(_, bytes)| bytes);
            let current = crate::features::paper::catalog::papers::get_by_path(root, &path)?;
            if current
                .as_ref()
                .map(serde_json::to_vec_pretty)
                .transpose()?
                .is_none_or(|bytes| uploaded == Some(&bytes))
            {
                self.pending_sidecars.remove(&path);
            }
        }
        Ok(())
    }
}

/// Read a consistent, standalone SQLite image, including committed WAL pages.
/// VACUUM INTO reads through SQLite's snapshot isolation; reading the source
/// file (even after a checkpoint) would race active writers. The temporary
/// output is owned for this call and cleaned up on success or failure.
pub(super) fn snapshot_catalog(db: &Path) -> Result<Vec<u8>, AppError> {
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let snapshot = tempfile::NamedTempFile::new()?;
    let path = snapshot
        .path()
        .to_str()
        .ok_or_else(|| AppError::message("catalog snapshot path is not valid UTF-8"))?;
    conn.execute("VACUUM INTO ?1", [path])?;
    Ok(std::fs::read(snapshot.path())?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::fs::LocalFs;
    use crate::features::paper::catalog::evict_catalog_conn;
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct MutatingFs {
        local: LocalFs,
        work: PathBuf,
    }

    #[async_trait::async_trait]
    impl VaultFs for MutatingFs {
        fn caps(&self) -> crate::core::fs::FsCaps {
            self.local.caps()
        }
        async fn list(&self, p: &str) -> Result<Vec<crate::core::fs::FsDirEntry>, AppError> {
            self.local.list(p).await
        }
        async fn stat(&self, p: &str) -> Result<FsFileMeta, AppError> {
            self.local.stat(p).await
        }
        async fn read(&self, p: &str) -> Result<Vec<u8>, AppError> {
            self.local.read(p).await
        }
        async fn write(&self, p: &str, bytes: &[u8], opts: WriteOpts) -> Result<(), AppError> {
            if p == "papers/x/metadata.json" {
                crate::features::paper::catalog::papers::set_is_read(&self.work, "papers/x", true)?;
            }
            self.local.write(p, bytes, opts).await
        }
        async fn mkdir(&self, p: &str) -> Result<(), AppError> {
            self.local.mkdir(p).await
        }
        async fn rename(&self, a: &str, b: &str) -> Result<(), AppError> {
            self.local.rename(a, b).await
        }
        async fn remove(&self, p: &str, recursive: bool) -> Result<(), AppError> {
            self.local.remove(p, recursive).await
        }
    }

    #[tokio::test]
    async fn sidecar_and_catalog_share_snapshot_and_retry_inflight_changes() {
        use crate::features::paper::catalog::papers;
        let remote = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let fs: Arc<dyn VaultFs> = Arc::new(LocalFs::new(remote.path()));
        let mut mirror = CatalogMirror::checkout(
            fs.clone(),
            work.path(),
            CatalogSource::Local(remote.path().into()),
        )
        .await
        .unwrap();
        std::fs::create_dir_all(remote.path().join("papers/x")).unwrap();
        let row = papers::PaperRecord::local_pdf("x".into(), "X".into()).at_path("papers/x");
        papers::upsert_paper(work.path(), &row).unwrap();
        mirror.queue_sidecar(row.path.clone());
        let mutating: Arc<dyn VaultFs> = Arc::new(MutatingFs {
            local: LocalFs::new(remote.path()),
            work: work.path().into(),
        });
        assert!(mirror
            .push_for_disconnect(mutating)
            .await
            .unwrap_err()
            .to_string()
            .contains("retry disconnecting"));
        let read_published = || {
            let conn = Connection::open_with_flags(
                remote.path().join(CATALOG_REL),
                OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .unwrap();
            let row = papers::list_all_conn(&conn).unwrap().remove(0);
            let sidecar: serde_json::Value = serde_json::from_slice(
                &std::fs::read(remote.path().join("papers/x/metadata.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(sidecar, serde_json::to_value(&row).unwrap());
            row
        };
        assert!(!read_published().is_read);
        assert!(mirror.pending_sidecars.contains("papers/x"));
        mirror.push(fs).await.unwrap();
        assert!(read_published().is_read);
        assert!(mirror.pending_sidecars.is_empty());
    }

    #[tokio::test]
    async fn catalog_conflict_does_not_touch_pending_sidecar() {
        use crate::features::paper::catalog::papers;
        let remote = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let fs: Arc<dyn VaultFs> = Arc::new(LocalFs::new(remote.path()));
        let mut mirror = CatalogMirror::checkout(
            fs.clone(),
            work.path(),
            CatalogSource::Local(remote.path().into()),
        )
        .await
        .unwrap();
        std::fs::create_dir_all(remote.path().join("papers/x")).unwrap();
        let sidecar = remote.path().join("papers/x/metadata.json");
        std::fs::write(&sidecar, b"remote version").unwrap();
        let row = papers::PaperRecord::local_pdf("x".into(), "X".into()).at_path("papers/x");
        papers::upsert_paper(work.path(), &row).unwrap();
        mirror.queue_sidecar(row.path);
        let conn = Connection::open(remote.path().join(CATALOG_REL)).unwrap();
        conn.execute_batch("CREATE TABLE conflicting_writer(value)")
            .unwrap();
        drop(conn);
        assert!(mirror
            .push(fs)
            .await
            .unwrap_err()
            .to_string()
            .contains("conflict"));
        assert_eq!(std::fs::read(sidecar).unwrap(), b"remote version");
        assert!(mirror.pending_sidecars.contains("papers/x"));
    }

    fn tmp() -> PathBuf {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p = std::env::temp_dir().join(format!("agentero-cmirror-{n}"));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[tokio::test]
    async fn checkout_and_refresh_read_remote_wal_and_protect_unpublished_writes() {
        let value = |conn: &Connection| {
            conn.query_row("SELECT value FROM _probe", [], |r| r.get::<_, String>(0))
                .unwrap()
        };
        let remote = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let writer = ensure_catalog(remote.path()).unwrap();
        writer
            .execute_batch(
                "PRAGMA wal_autocheckpoint=0;
            CREATE TABLE _probe(value); INSERT INTO _probe VALUES ('latest');",
            )
            .unwrap();
        let fs: Arc<dyn VaultFs> = Arc::new(LocalFs::new(remote.path()));
        let mut mirror = CatalogMirror::checkout(
            fs.clone(),
            work.path(),
            CatalogSource::Local(remote.path().into()),
        )
        .await
        .unwrap();
        assert_eq!(
            with_catalog(work.path(), |c| Ok(value(c))).unwrap(),
            "latest"
        );
        // Retain a reader in addition to the cached catalog connection.
        let reader = mirror.open().unwrap();
        writer
            .execute("UPDATE _probe SET value='refreshed'", [])
            .unwrap();
        mirror.refresh(fs.clone()).await.unwrap();
        assert_eq!(value(&reader), "refreshed");
        assert_eq!(
            with_catalog(work.path(), |c| Ok(value(c))).unwrap(),
            "refreshed"
        );
        let remote_wal = std::fs::read(remote.path().join(CATALOG_WAL_REL)).unwrap();
        mirror.push(fs.clone()).await.unwrap();
        assert_eq!(
            std::fs::read(remote.path().join(CATALOG_WAL_REL)).unwrap(),
            remote_wal
        );
        with_catalog(work.path(), |c| {
            c.execute("UPDATE _probe SET value='local'", [])?;
            Ok(())
        })
        .unwrap();
        assert!(mirror
            .push(fs.clone())
            .await
            .unwrap_err()
            .to_string()
            .contains("WAL remains"));
        writer
            .execute("UPDATE _probe SET value='remote'", [])
            .unwrap();
        assert!(mirror
            .refresh(fs)
            .await
            .unwrap_err()
            .to_string()
            .contains("unpublished"));
        assert_eq!(value(&reader), "local");
        assert_eq!(value(&writer), "remote");
        evict_catalog_conn(work.path());
    }

    #[tokio::test]
    async fn checkout_creates_and_push_roundtrip() {
        let remote_root = tmp();
        let work = tmp();
        let fs: Arc<dyn VaultFs> = Arc::new(LocalFs::new(&remote_root));

        let mut mirror =
            CatalogMirror::checkout(fs.clone(), &work, CatalogSource::Local(remote_root.clone()))
                .await
                .unwrap();
        assert!(mirror.work_db_path().is_file());
        let initial_remote = Connection::open_with_flags(
            remote_root.join(CATALOG_REL),
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        assert_eq!(schema_version(&initial_remote).unwrap(), SCHEMA_VERSION);
        drop(initial_remote);

        // Keep the WAL writer alive throughout both pushes: closing the last
        // connection would checkpoint and let a raw-main-file copy pass.
        let writer = mirror.open().unwrap();
        writer
            .execute_batch(
                "PRAGMA wal_autocheckpoint = 0;
             CREATE TABLE _probe(x INTEGER);
             INSERT INTO _probe VALUES (1);",
            )
            .unwrap();
        let mode: String = writer
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        assert!(
            std::fs::metadata(work.join(".agentero/catalog.sqlite-wal"))
                .unwrap()
                .len()
                > 0
        );

        // A separate snapshot sees committed data, never the in-flight insert.
        writer
            .execute_batch("BEGIN IMMEDIATE; INSERT INTO _probe VALUES (2);")
            .unwrap();
        mirror.push(fs.clone()).await.unwrap();
        let pulled_work = tmp();
        let pulled = CatalogMirror::checkout(
            fs.clone(),
            &pulled_work,
            CatalogSource::Local(remote_root.clone()),
        )
        .await
        .unwrap();
        let reader = pulled.open().unwrap();
        assert_eq!(
            reader
                .query_row("SELECT sum(x) FROM _probe", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(schema_version(&reader).unwrap(), SCHEMA_VERSION);
        drop(reader);
        writer.execute_batch("COMMIT;").unwrap();

        mirror.push(fs.clone()).await.unwrap();
        let pulled_again_work = tmp();
        let pulled_again = CatalogMirror::checkout(
            fs.clone(),
            &pulled_again_work,
            CatalogSource::Local(remote_root.clone()),
        )
        .await
        .unwrap();
        let reader = pulled_again.open().unwrap();
        assert_eq!(
            reader
                .query_row("SELECT sum(x) FROM _probe", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            3
        );
        assert_eq!(
            reader
                .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        drop(reader);
        drop(writer);

        // Conflict detection for a pending local write
        mirror
            .open()
            .unwrap()
            .execute("INSERT INTO _probe VALUES (4)", [])
            .unwrap();
        std::fs::write(
            remote_root.join(".agentero/catalog.sqlite"),
            b"not-a-real-db-but-different-size-xxxxxx",
        )
        .unwrap();
        // Fix size: write longer content
        let err = mirror.push(fs).await.unwrap_err();
        assert!(err.to_string().contains("conflict") || err.to_string().contains("changed"));

        let _ = std::fs::remove_dir_all(&remote_root);
        let _ = std::fs::remove_dir_all(&work);
        let _ = std::fs::remove_dir_all(&pulled_work);
        let _ = std::fs::remove_dir_all(&pulled_again_work);
    }
}
