//! Active remote vault sessions (SSH/SFTP or local-sim for tests).

use super::catalog_mirror::CatalogMirror;
use crate::core::error::AppError;
use crate::core::fs::{FsCaps, LocalFs, VaultFs};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Magic host for local-sim backend (dev / unit-style integration without SSH).
pub const LOCAL_SIM_HOST: &str = "__local_sim__";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSessionInfo {
    pub session_id: String,
    pub kind: String,
    pub display_name: String,
    pub host: String,
    pub remote_path: String,
    pub caps: FsCaps,
    /// Pseudo vault path for frontend: `remote:<sessionId>`
    pub vault_handle: String,
}

pub struct RemoteSession {
    pub id: String,
    pub host: String,
    pub remote_path: String,
    pub display_name: String,
    pub kind: String,
    pub fs: Arc<dyn VaultFs>,
    pub work_root: PathBuf,
    pub blob_root: PathBuf,
    pub catalog: Mutex<CatalogMirror>,
}

impl RemoteSession {
    pub fn info(&self) -> RemoteSessionInfo {
        RemoteSessionInfo {
            session_id: self.id.clone(),
            kind: self.kind.clone(),
            display_name: self.display_name.clone(),
            host: self.host.clone(),
            remote_path: self.remote_path.clone(),
            caps: self.fs.caps(),
            vault_handle: format!("remote:{}", self.id),
        }
    }
}

pub struct RemoteRegistry {
    inner: Mutex<HashMap<String, Arc<RemoteSession>>>,
}

impl Default for RemoteRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl RemoteRegistry {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    pub async fn get(&self, session_id: &str) -> Result<Arc<RemoteSession>, AppError> {
        self.inner
            .lock()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| AppError::message(format!("remote session not found: {session_id}")))
    }

    pub async fn disconnect(&self, session_id: &str) -> Result<(), AppError> {
        let session = {
            let mut map = self.inner.lock().await;
            map.remove(session_id).ok_or_else(|| {
                AppError::message(format!("remote session not found: {session_id}"))
            })?
        };
        // Best-effort catalog push before drop
        {
            let mut cat = session.catalog.lock().await;
            let _ = cat.push(session.fs.clone()).await;
        }
        let _ = std::fs::remove_dir_all(&session.work_root);
        // Keep blob cache for LRU reuse; optional cleanup of empty parent
        Ok(())
    }

    pub async fn connect(
        &self,
        host: &str,
        user: Option<&str>,
        remote_path: &str,
    ) -> Result<RemoteSessionInfo, AppError> {
        let host = host.trim();
        let remote_path = remote_path.trim();
        if host.is_empty() || remote_path.is_empty() {
            return Err(AppError::message("host and remotePath are required"));
        }

        let (kind, fs, display_name): (String, Arc<dyn VaultFs>, String) = if host == LOCAL_SIM_HOST
        {
            let root = PathBuf::from(remote_path);
            if !root.is_dir() {
                return Err(AppError::message(format!(
                    "local-sim path is not a directory: {}",
                    root.display()
                )));
            }
            let display = format!("local-sim:{}", root.display());
            ("local-sim".into(), Arc::new(LocalFs::new(root)), display)
        } else {
            #[cfg(unix)]
            {
                use super::sftp_fs::SftpFs;
                let destination = match user.map(str::trim).filter(|s| !s.is_empty()) {
                    Some(u) => format!("{u}@{host}"),
                    None => host.to_string(),
                };
                let sftp = SftpFs::connect(&destination, remote_path).await?;
                let display = format!("{destination}:{remote_path}");
                ("ssh".into(), Arc::new(sftp) as Arc<dyn VaultFs>, display)
            }
            #[cfg(not(unix))]
            {
                let _ = user;
                return Err(AppError::message(
                    "Remote vault over SSH is not supported on Windows yet \
                     (openssh/SFTP client is Unix-only). Open a local vault, \
                     or use Agentero on macOS/Linux for remote vaults.",
                ));
            }
        };

        let session_id = uuid::Uuid::new_v4().to_string();
        let cache_key = hex::encode(Sha256::digest(format!("{host}\0{remote_path}").as_bytes()));
        let base_cache = dirs::cache_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("agentero")
            .join("remote")
            .join(&cache_key);
        let work_root = base_cache.join("work").join(&session_id);
        let blob_root = base_cache.join("blobs");
        std::fs::create_dir_all(&work_root)?;
        std::fs::create_dir_all(&blob_root)?;

        let catalog = CatalogMirror::checkout(fs.clone(), &work_root).await?;

        let session = Arc::new(RemoteSession {
            id: session_id.clone(),
            host: host.to_string(),
            remote_path: remote_path.to_string(),
            display_name,
            kind,
            fs,
            work_root,
            blob_root,
            catalog: Mutex::new(catalog),
        });

        let info = session.info();
        self.inner.lock().await.insert(session_id, session);
        Ok(info)
    }
}

/// Resolve vault handle `remote:<id>` → session id.
pub fn parse_remote_handle(vault_handle: &str) -> Option<&str> {
    let h = vault_handle.trim();
    h.strip_prefix("remote:").filter(|id| !id.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::fs::WriteOpts;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp_vault() -> PathBuf {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p = std::env::temp_dir().join(format!("agentero-remote-sim-{n}"));
        std::fs::create_dir_all(p.join("papers/demo")).unwrap();
        std::fs::create_dir_all(p.join("notes")).unwrap();
        std::fs::write(p.join("AGENTS.md"), "# agents\n").unwrap();
        std::fs::write(p.join("papers/demo/NOTES.md"), "# Demo paper\n\nhello\n").unwrap();
        p
    }

    #[tokio::test]
    async fn local_sim_connect_list_read_write_catalog() {
        let root = tmp_vault();
        let reg = RemoteRegistry::new();
        let info = reg
            .connect(LOCAL_SIM_HOST, None, &root.to_string_lossy())
            .await
            .expect("connect");
        assert_eq!(info.kind, "local-sim");
        assert!(info.vault_handle.starts_with("remote:"));

        let session = reg.get(&info.session_id).await.unwrap();
        let entries = session.fs.list("").await.unwrap();
        assert!(entries.iter().any(|e| e.name == "papers" && e.is_dir));
        assert!(entries.iter().any(|e| e.name == "AGENTS.md" && e.is_file));

        let notes = session.fs.read("papers/demo/NOTES.md").await.unwrap();
        assert!(String::from_utf8_lossy(&notes).contains("Demo paper"));

        session
            .fs
            .write(
                "notes/idea.md",
                b"# idea\n",
                WriteOpts {
                    create_parents: true,
                },
            )
            .await
            .unwrap();
        assert!(root.join("notes/idea.md").is_file());

        // catalog work mirror exists
        assert!(session.work_root.join(".agentero/catalog.sqlite").is_file());
        // and was pushed to "remote" authority
        assert!(root.join(".agentero/catalog.sqlite").is_file());

        reg.disconnect(&info.session_id).await.unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn parse_handle() {
        assert_eq!(parse_remote_handle("remote:abc"), Some("abc"));
        assert_eq!(parse_remote_handle("/local/path"), None);
    }

    /// Live SSH smoke test against any Host in `~/.ssh/config`.
    ///
    /// ```bash
    /// AGENTERO_REMOTE_SSH_HOST=<alias> \
    /// AGENTERO_REMOTE_SSH_PATH=<absolute-remote-vault> \
    /// cargo test -p agentero --lib live_ssh_remote_vault -- --ignored --nocapture
    /// ```
    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "set AGENTERO_REMOTE_SSH_HOST + AGENTERO_REMOTE_SSH_PATH for live SSH"]
    async fn live_ssh_remote_vault() {
        use crate::core::fs::WriteOpts;
        use crate::integration::remote::agent_exec;

        let host = std::env::var("AGENTERO_REMOTE_SSH_HOST")
            .expect("AGENTERO_REMOTE_SSH_HOST (ssh config Host alias)");
        let path = std::env::var("AGENTERO_REMOTE_SSH_PATH")
            .expect("AGENTERO_REMOTE_SSH_PATH (absolute remote vault path)");
        let user = std::env::var("AGENTERO_REMOTE_SSH_USER").ok();

        eprintln!("connecting host={host} path={path} user={user:?}");
        let reg = RemoteRegistry::new();
        let info = reg
            .connect(&host, user.as_deref(), &path)
            .await
            .expect("remote_connect");
        eprintln!("connected: {:?}", info.display_name);
        assert_eq!(info.kind, "ssh");
        assert!(info.vault_handle.starts_with("remote:"));

        let session = reg.get(&info.session_id).await.expect("session");

        // list root
        let root = session.fs.list("").await.expect("list root");
        eprintln!(
            "root entries: {:?}",
            root.iter().map(|e| &e.name).collect::<Vec<_>>()
        );
        assert!(
            root.iter().any(|e| e.name == "papers" && e.is_dir),
            "expected papers/ on remote"
        );
        assert!(
            root.iter().any(|e| e.name == "AGENTS.md" && e.is_file),
            "expected AGENTS.md"
        );

        // read NOTES
        let notes = session
            .fs
            .read("papers/demo-paper/NOTES.md")
            .await
            .expect("read NOTES");
        let notes_s = String::from_utf8_lossy(&notes);
        eprintln!("NOTES.md:\n{notes_s}");
        assert!(notes_s.contains("Demo Paper") || notes_s.contains("NOTES"));

        // write-through then re-read
        let stamp = crate::core::time::now_rfc3339_millis();
        let body = format!("# remote write test\n\nstamp={stamp}\n");
        session
            .fs
            .write(
                "notes/remote-smoke.md",
                body.as_bytes(),
                WriteOpts {
                    create_parents: true,
                },
            )
            .await
            .expect("write notes/remote-smoke.md");
        let back = session
            .fs
            .read("notes/remote-smoke.md")
            .await
            .expect("re-read smoke");
        assert_eq!(String::from_utf8_lossy(&back), body);

        // catalog work mirror present + paper rescan markers
        assert!(
            session.work_root.join(".agentero/catalog.sqlite").is_file(),
            "work catalog missing"
        );
        // push already done at connect; re-stat remote catalog
        let cat_meta = session
            .fs
            .stat(".agentero/catalog.sqlite")
            .await
            .expect("remote catalog after connect");
        eprintln!(
            "remote catalog size={} mtime={}",
            cat_meta.size, cat_meta.mtime
        );
        assert!(cat_meta.size > 0);

        // paper rescan should find demo-paper and push catalog
        use crate::features::catalog::papers::{self, PaperRecord};
        let papers_list = session.fs.list("papers").await.expect("list papers");
        assert!(
            papers_list
                .iter()
                .any(|e| e.name == "demo-paper" && e.is_dir),
            "demo-paper folder"
        );
        // Minimal rescan: upsert demo-paper into work catalog then push
        let now = crate::core::time::now_rfc3339_millis();
        let rec = PaperRecord {
            path: "papers/demo-paper".into(),
            id: "demo-paper".into(),
            paper_type: "article".into(),
            title: "Demo Paper on DGX".into(),
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
            meta_source: Some("live_ssh_test".into()),
            extra: None,
            summary: None,
            status: "unread".into(),
            is_read: false,
            zotero_item_id: None,
            zotero_last_synced: None,
            added_at: now.clone(),
            updated_at: now,
        };
        papers::upsert_paper(&session.work_root, &rec).expect("upsert paper");
        {
            let mut cat = session.catalog.lock().await;
            cat.push(session.fs.clone())
                .await
                .expect("push catalog after upsert");
        }
        let listed = papers::list_all(&session.work_root).expect("list catalog");
        eprintln!(
            "catalog papers: {:?}",
            listed.iter().map(|p| &p.path).collect::<Vec<_>>()
        );
        assert!(
            listed.iter().any(|p| p.path == "papers/demo-paper"),
            "demo-paper in catalog"
        );

        // agent discover via ssh which (login shell PATH)
        let dest_for_ssh = host.clone();
        let mut found_any_agent = false;
        for bin in [
            "claude",
            "codex",
            "opencode",
            "openclaw",
            "hermes",
            "claude-agent-acp",
            "grok",
        ] {
            match agent_exec::remote_which(&dest_for_ssh, bin).await {
                Ok(Some(p)) => {
                    eprintln!("remote which {bin} -> {p}");
                    found_any_agent = true;
                }
                Ok(None) => eprintln!("remote which {bin} -> (not found)"),
                Err(e) => eprintln!("remote which {bin} err: {e}"),
            }
        }
        assert!(
            found_any_agent,
            "expected at least one agent binary on remote PATH (login shell)"
        );

        reg.disconnect(&info.session_id).await.expect("disconnect");
        eprintln!("disconnect ok");
    }

    /// Paper + catalog features over live SSH.
    ///
    /// ```bash
    /// AGENTERO_REMOTE_SSH_HOST=<alias> \
    /// AGENTERO_REMOTE_SSH_PATH=<absolute-remote-vault> \
    /// cargo test -p agentero --lib live_paper_features -- --ignored --nocapture
    /// ```
    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "set AGENTERO_REMOTE_SSH_HOST + AGENTERO_REMOTE_SSH_PATH for live SSH"]
    async fn live_paper_features() {
        use crate::core::fs::WriteOpts;
        use crate::features::catalog::papers::{self, PaperRecord, PaperTag};
        use crate::integration::remote::catalog_mirror::CatalogMirror;

        let host = std::env::var("AGENTERO_REMOTE_SSH_HOST").expect("AGENTERO_REMOTE_SSH_HOST");
        let path = std::env::var("AGENTERO_REMOTE_SSH_PATH").expect("AGENTERO_REMOTE_SSH_PATH");
        let user = std::env::var("AGENTERO_REMOTE_SSH_USER").ok();

        eprintln!("=== live_paper_features host={host} path={path} ===");
        let reg = RemoteRegistry::new();
        let info = reg
            .connect(&host, user.as_deref(), &path)
            .await
            .expect("connect");
        let session = reg.get(&info.session_id).await.expect("session");
        let mut passed = 0usize;
        let mut failed: Vec<String> = Vec::new();

        macro_rules! check {
            ($name:expr, $cond:expr) => {{
                if $cond {
                    eprintln!("  PASS  {}", $name);
                    passed += 1;
                } else {
                    eprintln!("  FAIL  {}", $name);
                    failed.push($name.to_string());
                }
            }};
        }

        // --- 1. list papers/ ---
        let papers_dir = session.fs.list("papers").await.expect("list papers");
        let names: Vec<_> = papers_dir.iter().map(|e| e.name.as_str()).collect();
        eprintln!("  papers/: {names:?}");
        check!(
            "list papers has demo-paper",
            papers_dir
                .iter()
                .any(|e| e.name == "demo-paper" && e.is_dir)
        );
        check!(
            "list papers has attention-is-all-you-need",
            papers_dir
                .iter()
                .any(|e| e.name == "attention-is-all-you-need" && e.is_dir)
        );

        // --- 2. read NOTES ---
        let notes = session
            .fs
            .read("papers/attention-is-all-you-need/NOTES.md")
            .await
            .expect("read NOTES");
        let notes_s = String::from_utf8_lossy(&notes);
        check!(
            "read NOTES contains Attention",
            notes_s.contains("Attention")
        );

        // --- 3. write NOTES (write-through) ---
        let stamp = crate::core::time::now_rfc3339_millis();
        let new_notes = format!(
            "# Attention Is All You Need\n\n## Method\nTransformers.\n\n<!-- smoke {stamp} -->\n"
        );
        session
            .fs
            .write(
                "papers/attention-is-all-you-need/NOTES.md",
                new_notes.as_bytes(),
                WriteOpts {
                    create_parents: true,
                },
            )
            .await
            .expect("write NOTES");
        let back = session
            .fs
            .read("papers/attention-is-all-you-need/NOTES.md")
            .await
            .expect("re-read NOTES");
        check!(
            "NOTES write-through",
            String::from_utf8_lossy(&back).contains(&stamp)
        );

        // --- 4. rescan-like upsert both papers + push catalog ---
        let now = crate::core::time::now_rfc3339_millis();
        for (rel, id, title) in [
            ("papers/demo-paper", "demo-paper", "Demo Paper on DGX"),
            (
                "papers/attention-is-all-you-need",
                "1706.03762",
                "Attention Is All You Need",
            ),
        ] {
            let rec = PaperRecord {
                path: rel.into(),
                id: id.into(),
                paper_type: "article".into(),
                title: title.into(),
                authors: vec!["Test Author".into()],
                creators: None,
                year: Some(2017),
                date: None,
                abstract_text: Some("smoke abstract".into()),
                tags: vec![],
                arxiv_id: if id.chars().all(|c| c.is_ascii_digit() || c == '.') {
                    Some(id.into())
                } else {
                    None
                },
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
                meta_source: Some("live_paper_features".into()),
                extra: None,
                summary: None,
                status: "unread".into(),
                is_read: false,
                zotero_item_id: None,
                zotero_last_synced: None,
                added_at: now.clone(),
                updated_at: now.clone(),
            };
            papers::upsert_paper(&session.work_root, &rec).expect("upsert");
        }
        {
            let mut cat = session.catalog.lock().await;
            cat.push(session.fs.clone())
                .await
                .expect("push after upsert");
        }
        let listed = papers::list_all(&session.work_root).expect("list_all");
        eprintln!(
            "  catalog paths: {:?}",
            listed.iter().map(|p| &p.path).collect::<Vec<_>>()
        );
        check!("catalog has 2+ papers", listed.len() >= 2);
        check!(
            "catalog has attention path",
            listed
                .iter()
                .any(|p| p.path == "papers/attention-is-all-you-need")
        );

        // --- 5. paper get_by_path / get_by_id ---
        let by_path = papers::get_by_path(&session.work_root, "papers/attention-is-all-you-need")
            .expect("get_by_path");
        check!(
            "get_by_path title",
            by_path
                .as_ref()
                .is_some_and(|p| p.title.contains("Attention"))
        );
        let by_id = papers::get_by_id(&session.work_root, "1706.03762").expect("get_by_id");
        check!("get_by_id arxiv", by_id.is_some());

        // --- 6. set_tags + push ---
        let tags = vec![
            PaperTag {
                name: "transformer".into(),
                color: Some("blue".into()),
            },
            PaperTag {
                name: "nlp".into(),
                color: Some("green".into()),
            },
        ];
        let tagged = papers::set_tags(
            &session.work_root,
            "papers/attention-is-all-you-need",
            &tags,
        )
        .expect("set_tags");
        check!("set_tags count", tagged.tags.len() == 2);
        {
            let mut cat = session.catalog.lock().await;
            cat.push(session.fs.clone()).await.expect("push tags");
        }
        // re-checkout remote catalog into a fresh work root to prove authority is remote
        let pull_root =
            std::env::temp_dir().join(format!("agentero-live-pull-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&pull_root).unwrap();
        let _mirror = CatalogMirror::checkout(session.fs.clone(), &pull_root)
            .await
            .expect("re-checkout catalog from remote");
        let pulled = papers::get_by_path(&pull_root, "papers/attention-is-all-you-need")
            .expect("get after pull");
        check!(
            "tags survive remote catalog pull",
            pulled.as_ref().is_some_and(|p| {
                p.tags.iter().any(|t| t.name == "transformer")
                    && p.tags.iter().any(|t| t.name == "nlp")
            })
        );
        let _ = std::fs::remove_dir_all(&pull_root);

        // --- 7. set_is_read + push ---
        let read_row =
            papers::set_is_read(&session.work_root, "papers/attention-is-all-you-need", true)
                .expect("set_is_read");
        check!("set_is_read true", read_row.is_read);
        {
            let mut cat = session.catalog.lock().await;
            cat.push(session.fs.clone()).await.expect("push is_read");
        }

        // --- 8. PDF bytes / cache-like read ---
        let pdf = session
            .fs
            .read("papers/attention-is-all-you-need/1706.03762.pdf")
            .await
            .expect("read pdf");
        check!("pdf readable non-empty", pdf.len() > 10);
        check!(
            "pdf looks like PDF",
            pdf.starts_with(b"%PDF") || pdf.windows(4).any(|w| w == b"%PDF")
        );

        // --- 9. mkdir + write file under notes/ ---
        session.fs.mkdir("notes/smoke-dir").await.expect("mkdir");
        session
            .fs
            .write(
                "notes/smoke-dir/hello.md",
                b"# hello remote\n",
                WriteOpts {
                    create_parents: true,
                },
            )
            .await
            .expect("write nested");
        let hello = session
            .fs
            .read("notes/smoke-dir/hello.md")
            .await
            .expect("read nested");
        check!(
            "mkdir + nested write",
            String::from_utf8_lossy(&hello).contains("hello remote")
        );

        // --- 10. paper_delete from catalog (not files) + push ---
        let removed =
            papers::delete_under_path(&session.work_root, "papers/demo-paper").expect("delete");
        check!("catalog delete demo-paper", removed >= 1);
        {
            let mut cat = session.catalog.lock().await;
            cat.push(session.fs.clone()).await.expect("push delete");
        }
        let after_del = papers::list_all(&session.work_root).expect("list after del");
        check!(
            "demo-paper gone from catalog",
            !after_del.iter().any(|p| p.path == "papers/demo-paper")
        );
        // file still on remote (delete is catalog-only here)
        check!(
            "demo-paper files still on remote",
            session
                .fs
                .exists("papers/demo-paper/NOTES.md")
                .await
                .unwrap_or(false)
        );

        // --- 11. SFTP remove nested smoke file ---
        session
            .fs
            .remove("notes/smoke-dir", true)
            .await
            .expect("remove smoke-dir");
        check!(
            "SFTP recursive remove",
            !session.fs.exists("notes/smoke-dir").await.unwrap_or(true)
        );

        // --- 12. remote_which agents ---
        use crate::integration::remote::agent_exec;
        let claude = agent_exec::remote_which(&host, "claude")
            .await
            .ok()
            .flatten();
        eprintln!("  remote which claude: {claude:?}");
        check!("remote agent discover claude", claude.is_some());

        reg.disconnect(&info.session_id).await.expect("disconnect");

        eprintln!(
            "\n=== SUMMARY: {passed} passed, {} failed ===",
            failed.len()
        );
        for f in &failed {
            eprintln!("  - {f}");
        }
        assert!(
            failed.is_empty(),
            "live_paper_features failures: {failed:?}"
        );
    }

    /// Local-sim magic-wand import (arXiv fallback; needs network unless AGENTERO_SKIP_NETWORK).
    #[tokio::test]
    async fn local_sim_remote_import_arxiv() {
        use crate::features::import::{LookupImportArgs, PaperDownloadAssetsArgs};
        use crate::integration::remote::import_bridge;
        use std::time::{SystemTime, UNIX_EPOCH};

        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("agentero-remote-import-{n}"));
        std::fs::create_dir_all(root.join("papers")).unwrap();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(root.join("AGENTS.md"), "# t\n").unwrap();

        let reg = RemoteRegistry::new();
        let info = reg
            .connect(LOCAL_SIM_HOST, None, &root.to_string_lossy())
            .await
            .expect("connect");
        let session = reg.get(&info.session_id).await.unwrap();

        if std::env::var("AGENTERO_SKIP_NETWORK").is_ok() {
            reg.disconnect(&info.session_id).await.ok();
            let _ = std::fs::remove_dir_all(&root);
            return;
        }

        let result = import_bridge::import_by_identifier_remote(
            session.clone(),
            LookupImportArgs {
                vault_path: info.vault_handle.clone(),
                parent_dir: "papers".into(),
                text: "1706.03762".into(),
                translator_base_url: None,
                task_id: None,
            },
            crate::features::import::NoteShellMode::Standard,
        )
        .await;

        match result {
            Ok(r) => {
                eprintln!("import ok path={} paperDir={}", r.path, r.paper_dir);
                assert!(r.path.starts_with("papers/"));
                assert!(r.paper_dir.starts_with("remote:"));
                assert!(
                    root.join(&r.path).join("NOTES.md").is_file(),
                    "NOTES should be on remote root"
                );
                use crate::features::catalog::papers;
                let row = papers::get_by_path(&session.work_root, &r.path)
                    .unwrap()
                    .expect("catalog row");
                assert!(!row.title.is_empty());
                let _ = import_bridge::download_paper_assets_remote(
                    session.clone(),
                    PaperDownloadAssetsArgs {
                        vault_path: info.vault_handle.clone(),
                        path: r.path.clone(),
                        task_id: None,
                    },
                )
                .await;
            }
            Err(e) => {
                let msg = e.to_string();
                eprintln!("import network error (ok offline): {msg}");
                assert!(
                    msg.contains("translator")
                        || msg.contains("unreachable")
                        || msg.contains("error sending")
                        || msg.contains("timed out")
                        || msg.contains("dns")
                        || msg.contains("connection")
                        || msg.contains("arxiv")
                        || msg.contains("http"),
                    "unexpected import error: {msg}"
                );
            }
        }

        reg.disconnect(&info.session_id).await.ok();
        let _ = std::fs::remove_dir_all(&root);
    }

    /// All remote-capable import paths via local-sim (network for bib/arxiv).
    #[tokio::test]
    async fn local_sim_all_import_methods() {
        use crate::features::import::{
            ImportLocalPdfArgs, LookupImportArgs, PaperDownloadAssetsArgs, PaperImportArgs,
        };
        use crate::integration::remote::import_bridge;
        use std::time::{SystemTime, UNIX_EPOCH};

        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("agentero-all-import-{n}"));
        std::fs::create_dir_all(root.join("papers")).unwrap();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(root.join("AGENTS.md"), "# t\n").unwrap();

        let pdf_path = root.join("_fixture.pdf");
        std::fs::write(
            &pdf_path,
            b"%PDF-1.1\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n",
        )
        .unwrap();

        let reg = RemoteRegistry::new();
        let info = reg
            .connect(LOCAL_SIM_HOST, None, &root.to_string_lossy())
            .await
            .expect("connect");
        let session = reg.get(&info.session_id).await.unwrap();
        let mut report: Vec<(String, bool, String)> = Vec::new();

        // 1) Local PDF import (no network)
        match import_bridge::import_local_pdfs_remote(
            session.clone(),
            ImportLocalPdfArgs {
                vault_path: info.vault_handle.clone(),
                parent_dir: "papers".into(),
                file_paths: vec![pdf_path.to_string_lossy().into()],
                entries: vec![],
                task_id: None,
                translator_base_url: None,
            },
            crate::features::import::NoteShellMode::Standard,
        )
        .await
        {
            Ok(r) => {
                let ok = r.papers.len() == 1 && r.errors.is_empty();
                report.push((
                    "local PDF import".into(),
                    ok,
                    format!("papers={} errs={:?}", r.papers.len(), r.errors),
                ));
                if ok {
                    assert!(root.join(&r.papers[0].path).join("NOTES.md").is_file());
                }
            }
            Err(e) => report.push(("local PDF import".into(), false, e.to_string())),
        }

        fn is_network_error(e: &AppError) -> bool {
            let msg = e.to_string().to_lowercase();
            msg.contains("error sending request")
                || msg.contains("timed out")
                || msg.contains("connection refused")
                || msg.contains("could not connect")
                || msg.contains("dns error")
        }

        // 2) Magic wand arXiv (network)
        if std::env::var("AGENTERO_SKIP_NETWORK").is_err() {
            match import_bridge::import_by_identifier_remote(
                session.clone(),
                LookupImportArgs {
                    vault_path: info.vault_handle.clone(),
                    parent_dir: "papers".into(),
                    text: "1602.07360".into(), // MobileNets - smaller
                    translator_base_url: None,
                    task_id: None,
                },
                crate::features::import::NoteShellMode::Standard,
            )
            .await
            {
                Ok(r) => report.push((
                    "magic-wand arXiv".into(),
                    r.path.starts_with("papers/") && r.pdf,
                    format!("path={} pdf={}", r.path, r.pdf),
                )),
                Err(e) => {
                    if is_network_error(&e) {
                        report.push((
                            "magic-wand arXiv".into(),
                            true,
                            format!("skipped (network unavailable): {e}"),
                        ));
                    } else {
                        report.push(("magic-wand arXiv".into(), false, e.to_string()));
                    }
                }
            }

            // 3) Bib import via translator
            let bib = r#"@article{remoteSmoke2024,
  title={Remote Bib Import Smoke},
  author={Doe, Jane},
  year={2024},
  journal={Smoke J}
}
"#;
            match import_bridge::import_catalog_remote(
                session.clone(),
                PaperImportArgs {
                    vault_path: info.vault_handle.clone(),
                    parent_dir: Some("papers".into()),
                    content: bib.into(),
                    translator_base_url: None,
                },
                crate::features::import::NoteShellMode::Standard,
            )
            .await
            {
                Ok(r) => report.push((
                    "bib/RIS catalog import".into(),
                    r.imported >= 1 || r.skipped >= 1,
                    format!(
                        "imported={} skipped={} errs={:?}",
                        r.imported, r.skipped, r.errors
                    ),
                )),
                Err(e) => {
                    if is_network_error(&e) {
                        report.push((
                            "bib/RIS catalog import".into(),
                            true,
                            format!("skipped (network unavailable): {e}"),
                        ));
                    } else {
                        report.push(("bib/RIS catalog import".into(), false, e.to_string()));
                    }
                }
            }

            // 4) Download assets for local-pdf paper if any
            if let Ok(list) = crate::features::catalog::papers::list_all(&session.work_root) {
                if let Some(p) = list.first() {
                    match import_bridge::download_paper_assets_remote(
                        session.clone(),
                        PaperDownloadAssetsArgs {
                            vault_path: info.vault_handle.clone(),
                            path: p.path.clone(),
                            task_id: None,
                        },
                    )
                    .await
                    {
                        Ok(r) => report.push((
                            "download assets".into(),
                            true,
                            format!("pdf={} tex={} msgs={:?}", r.pdf, r.tex, r.messages),
                        )),
                        Err(e) => {
                            if is_network_error(&e) {
                                report.push((
                                    "download assets".into(),
                                    true,
                                    format!("skipped (network unavailable): {e}"),
                                ));
                            } else {
                                report.push(("download assets".into(), false, e.to_string()));
                            }
                        }
                    }
                }
            }
        } else {
            report.push((
                "magic-wand arXiv".into(),
                true,
                "skipped (no network)".into(),
            ));
            report.push((
                "bib/RIS catalog import".into(),
                true,
                "skipped (no network)".into(),
            ));
            report.push((
                "download assets".into(),
                true,
                "skipped (no network)".into(),
            ));
        }

        // 5) Rescan-style list
        let listed = crate::features::catalog::papers::list_all(&session.work_root).unwrap();
        report.push((
            "catalog list after imports".into(),
            !listed.is_empty(),
            format!("count={}", listed.len()),
        ));

        eprintln!("\n=== IMPORT METHOD MATRIX ===");
        let mut failed = 0usize;
        for (name, ok, detail) in &report {
            eprintln!(
                "  {}  {} — {}",
                if *ok { "PASS" } else { "FAIL" },
                name,
                detail
            );
            if !ok {
                failed += 1;
            }
        }
        reg.disconnect(&info.session_id).await.ok();
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(failed, 0, "import method failures: {report:?}");
    }

    /// Live SSH magic-wand import smoke (env-driven; needs network).
    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "set AGENTERO_REMOTE_SSH_HOST + AGENTERO_REMOTE_SSH_PATH for live SSH"]
    async fn live_ssh_import_arxiv() {
        use crate::features::import::LookupImportArgs;
        use crate::integration::remote::import_bridge;
        let host = std::env::var("AGENTERO_REMOTE_SSH_HOST").unwrap();
        let path = std::env::var("AGENTERO_REMOTE_SSH_PATH").unwrap();
        let reg = RemoteRegistry::new();
        let info = reg.connect(&host, None, &path).await.expect("connect");
        let session = reg.get(&info.session_id).await.unwrap();
        let r = import_bridge::import_by_identifier_remote(
            session,
            LookupImportArgs {
                vault_path: info.vault_handle.clone(),
                parent_dir: "papers".into(),
                text: "1512.03385".into(),
                translator_base_url: None,
                task_id: None,
            },
            crate::features::import::NoteShellMode::Standard,
        )
        .await
        .expect("import");
        eprintln!(
            "LIVE IMPORT path={} paperDir={} title={} pdf={}",
            r.path, r.paper_dir, r.title, r.pdf
        );
        assert!(r.path.contains("1512") || r.path.starts_with("papers/"));
        reg.disconnect(&info.session_id).await.ok();
    }
}
