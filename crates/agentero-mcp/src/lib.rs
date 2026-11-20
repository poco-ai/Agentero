//! Loopback Streamable HTTP MCP server shared by the desktop app and the CLI.
//!
//! The desktop shell keeps settings IPC, status
//! events, and the ChatGPT tunnel; this crate owns the tool surface and the
//! listener. Desktop-only side effects go through [`McpHost`].

mod excerpts;
mod host;
mod icons;
mod interface;
#[cfg(test)]
mod protocol_tests;
mod server;
pub use agentero_core::ops::execute::{vault_id, Permissions};
pub use interface::{serve_stdio, tools_list};

pub use host::{ImportContext, McpHost, NullHost};
pub use server::{
    default_token, default_token_path, ephemeral_token, parse_loopback_listen, serve_until_signal,
};

use agentero_core::error::AppError;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

pub const MCP_STATUS_EVENT: &str = "mcp:status";
/// Default desktop loopback port.
pub const DEFAULT_MCP_PORT: u16 = 8765;

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub enabled: bool,
    pub listening: bool,
    pub port: u16,
    pub url: Option<String>,
    pub last_error: Option<String>,
    pub vault_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultEntry {
    /// Local path used by the host to derive a public Vault ID.
    pub path: String,
    pub name: String,
    pub exists: bool,
    /// True for the vault the desktop app currently has open.
    pub open: bool,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultListOut {
    pub vaults: Vec<VaultEntry>,
    /// Currently open local vault, if any.
    pub open: Option<String>,
}

struct Inner {
    enabled: bool,
    listening: bool,
    port: u16,
    last_error: Option<String>,
    vault_handle: Option<String>,
    /// Local vaults the user has opened, most-recent first. Used only to let
    /// MCP tools target a known vault by absolute path.
    known_vaults: Vec<String>,
    parent_dir: String,
    translator_url: Option<String>,
    paper_note_mode: String,
    shutdown_tx: Option<oneshot::Sender<()>>,
    host: Arc<dyn McpHost>,
}

pub struct McpController {
    inner: Mutex<Inner>,
    running: AtomicBool,
    token_file: PathBuf,
}

impl Default for McpController {
    fn default() -> Self {
        Self::new()
    }
}

impl McpController {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                enabled: false,
                listening: false,
                port: DEFAULT_MCP_PORT,
                last_error: None,
                vault_handle: None,
                known_vaults: Vec::new(),
                parent_dir: "papers".into(),
                translator_url: None,
                paper_note_mode: "standard".into(),
                shutdown_tx: None,
                host: Arc::new(NullHost),
            }),
            running: AtomicBool::new(false),
            token_file: server::default_token_path(),
        }
    }

    pub fn set_host(&self, host: Arc<dyn McpHost>) {
        if let Ok(mut g) = self.inner.lock() {
            g.host = host;
        }
    }

    pub fn host(&self) -> Arc<dyn McpHost> {
        self.inner
            .lock()
            .map(|g| Arc::clone(&g.host))
            .unwrap_or_else(|_| Arc::new(NullHost))
    }

    pub fn port(&self) -> u16 {
        self.inner
            .lock()
            .map(|g| g.port)
            .unwrap_or(DEFAULT_MCP_PORT)
    }

    pub fn status(&self) -> McpStatus {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        Self::status_from(&g)
    }

    fn status_from(g: &Inner) -> McpStatus {
        McpStatus {
            enabled: g.enabled,
            listening: g.listening,
            port: g.port,
            url: if g.listening {
                Some(format!("http://127.0.0.1:{}/mcp", g.port))
            } else {
                None
            },
            last_error: g.last_error.clone(),
            vault_path: g.vault_handle.clone(),
        }
    }

    pub fn set_vault(&self, vault_path: Option<String>) {
        let next = vault_path
            .as_deref()
            .and_then(normalize_local_vault)
            .map(|p| p.to_string_lossy().into_owned());
        if let Ok(mut g) = self.inner.lock() {
            if let Some(path) = &next {
                remember_vault(&mut g.known_vaults, path);
            }
            g.vault_handle = next.clone();
        }
        self.emit_status();
    }

    /// Replace the known-vault list with the renderer's recent local vaults.
    /// Unknown paths are rejected by [`resolve_vault`](Self::resolve_vault), so
    /// external clients can only target vaults the user has opened.
    pub fn set_known_vaults(&self, vaults: Vec<String>) {
        let mut normalized = Vec::new();
        for path in vaults {
            if let Some(path) = normalize_local_vault(&path) {
                remember_vault(&mut normalized, &path.to_string_lossy());
            }
        }
        normalized.reverse();
        if let Ok(mut g) = self.inner.lock() {
            if let Some(open) = g.vault_handle.clone() {
                remember_vault(&mut normalized, &open);
            }
            g.known_vaults = normalized;
        }
    }

    pub fn set_parent_dir(&self, parent_dir: String) {
        if let Ok(mut g) = self.inner.lock() {
            g.parent_dir = parent_dir;
        }
    }

    pub fn parent_dir(&self) -> String {
        self.inner
            .lock()
            .map(|g| g.parent_dir.clone())
            .unwrap_or_else(|_| "papers".into())
    }

    pub fn set_translator_url(&self, url: Option<String>) {
        if let Ok(mut g) = self.inner.lock() {
            g.translator_url = url.filter(|s| !s.trim().is_empty());
        }
    }

    pub fn translator_url(&self) -> Option<String> {
        self.inner
            .lock()
            .ok()
            .and_then(|g| g.translator_url.clone())
    }

    pub fn set_paper_note_mode(&self, mode: String) {
        if let Ok(mut g) = self.inner.lock() {
            g.paper_note_mode = mode;
        }
    }

    pub fn paper_note_mode(&self) -> String {
        self.inner
            .lock()
            .map(|g| g.paper_note_mode.clone())
            .unwrap_or_else(|_| "standard".into())
    }

    /// Local vault directory. Remote handles are rejected.
    pub fn local_vault(&self) -> Result<PathBuf, AppError> {
        let handle = {
            let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            g.vault_handle.clone()
        };
        let Some(handle) = handle else {
            return Err(AppError::message(
                "No vault open — open a local vault in Agentero first",
            ));
        };
        if handle.starts_with("remote:") {
            return Err(AppError::message("MCP requires a local vault"));
        }
        agentero_core::fs::resolve_vault(&handle)
    }

    /// All local vaults the user has opened, newest first. The open vault is
    /// always present even before the renderer has synced its recent list.
    pub fn vault_list(&self) -> VaultListOut {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let open = g.vault_handle.clone();
        let open_key = open.as_deref().map(canonical_vault_key);
        let mut paths = Vec::new();
        for path in g.known_vaults.iter().rev() {
            remember_vault(&mut paths, path);
        }
        if let Some(path) = &open {
            remember_vault(&mut paths, path);
        }
        let vaults = paths
            .into_iter()
            .map(|path| {
                let exists = Path::new(&path).is_dir();
                let name = Path::new(&path)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| path.clone());
                VaultEntry {
                    open: open_key.as_ref() == Some(&canonical_vault_key(&path)),
                    path,
                    name,
                    exists,
                }
            })
            .collect();
        VaultListOut { vaults, open }
    }

    /// Resolve a tool's optional `vault` argument. Only the open vault or a
    /// renderer-synced recent vault is accepted, so an external client cannot
    /// point tools at arbitrary filesystem roots.
    pub fn resolve_vault(&self, requested: Option<&str>) -> Result<PathBuf, AppError> {
        let Some(raw) = requested.map(str::trim).filter(|s| !s.is_empty()) else {
            return self.local_vault();
        };
        let Some(path) = normalize_local_vault(raw) else {
            return Err(AppError::message(
                "vault must be an absolute local vault path from vault_list",
            ));
        };
        let key = canonical_vault_key(&path.to_string_lossy());
        let known = {
            let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let open = g.vault_handle.as_deref().map(canonical_vault_key);
            open.as_ref() == Some(&key)
                || g.known_vaults.iter().any(|p| canonical_vault_key(p) == key)
        };
        if !known {
            return Err(AppError::message(format!(
                "vault is not open or known: {} — call vault_list first",
                path.display()
            )));
        }
        agentero_core::fs::resolve_vault(&path.to_string_lossy())
    }

    pub async fn set_enabled(self: &Arc<Self>, enabled: bool) -> McpStatus {
        if !enabled {
            self.stop_server();
            if let Ok(mut g) = self.inner.lock() {
                g.enabled = false;
                g.last_error = None;
            }
            self.emit_status();
            return self.status();
        }

        {
            let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            g.enabled = true;
            g.last_error = None;
            if g.listening {
                return Self::status_from(&g);
            }
        }

        match self.start_server().await {
            Ok(()) => {}
            Err(e) => {
                if let Ok(mut g) = self.inner.lock() {
                    g.enabled = true;
                    g.listening = false;
                    g.last_error = Some(e.to_string());
                }
                self.running.store(false, Ordering::SeqCst);
            }
        }
        self.emit_status();
        self.status()
    }

    pub async fn set_port(self: &Arc<Self>, port: u16) -> McpStatus {
        if port == 0 {
            if let Ok(mut g) = self.inner.lock() {
                g.last_error = Some("MCP port must be between 1 and 65535".into());
            }
            self.emit_status();
            return self.status();
        }
        let enabled = self.inner.lock().map(|g| g.enabled).unwrap_or(false);
        if enabled {
            self.stop_server_internal();
        }
        if let Ok(mut g) = self.inner.lock() {
            g.port = port;
            g.last_error = None;
        }
        if enabled {
            if let Err(e) = self.start_server().await {
                if let Ok(mut g) = self.inner.lock() {
                    g.last_error = Some(e.to_string());
                    g.listening = false;
                }
            }
        }
        self.emit_status();
        self.status()
    }

    async fn start_server(self: &Arc<Self>) -> Result<(), AppError> {
        let port = {
            let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            g.port
        };
        self.stop_server_internal();
        let token = server::token_at(&self.token_file)?;
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let listener =
            tokio::net::TcpListener::bind(std::net::SocketAddr::from(([127, 0, 0, 1], port)))
                .await
                .map_err(|e| AppError::message(format!("Failed to bind 127.0.0.1:{port}: {e}")))?;

        {
            let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            g.shutdown_tx = Some(shutdown_tx);
            g.listening = true;
            g.last_error = None;
        }
        self.running.store(true, Ordering::SeqCst);

        let ctrl = Arc::clone(self);
        let ctrl_serve = Arc::clone(&ctrl);
        tokio::spawn(async move {
            if let Err(e) = server::serve(listener, shutdown_rx, ctrl_serve, token).await {
                if let Ok(mut g) = ctrl.inner.lock() {
                    g.listening = false;
                    g.last_error = Some(e.to_string());
                }
                ctrl.running.store(false, Ordering::SeqCst);
                ctrl.emit_status();
            }
        });
        Ok(())
    }

    pub fn stop(&self) {
        self.stop_server();
        if let Ok(mut g) = self.inner.lock() {
            g.enabled = false;
        }
        self.emit_status();
    }

    pub fn stop_server(&self) {
        self.stop_server_internal();
        if let Ok(mut g) = self.inner.lock() {
            g.listening = false;
        }
        self.running.store(false, Ordering::SeqCst);
    }

    fn stop_server_internal(&self) {
        if let Ok(mut g) = self.inner.lock() {
            if let Some(tx) = g.shutdown_tx.take() {
                let _ = tx.send(());
            }
            g.listening = false;
        }
        self.running.store(false, Ordering::SeqCst);
    }

    fn emit_status(&self) {
        let status = self.status();
        self.host().on_status(&status);
    }
}

fn normalize_local_vault(raw: &str) -> Option<PathBuf> {
    let raw = raw.trim();
    if raw.is_empty() || raw.starts_with("remote:") {
        return None;
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return None;
    }
    Some(agentero_core::fs::canonicalize_best_effort(&path))
}

fn canonical_vault_key(path: &str) -> String {
    normalize_local_vault(path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| agentero_core::fs::normalize_rel_separators(path.trim()))
}

fn remember_vault(list: &mut Vec<String>, path: &str) {
    let Some(path) = normalize_local_vault(path) else {
        return;
    };
    let path = path.to_string_lossy().into_owned();
    let key = canonical_vault_key(&path);
    list.retain(|existing| canonical_vault_key(existing) != key);
    list.insert(0, path);
    list.truncate(32);
}

#[cfg(test)]
mod tests {
    use super::*;
    use agentero_core::features::paper::catalog::papers::{self, PaperRecord, PaperTag};
    use agentero_core::features::vault;
    use agentero_core::ops::execute::run_local;
    use tempfile::tempdir;

    fn sample_record(path: &str, id: &str, title: &str) -> PaperRecord {
        PaperRecord {
            path: path.into(),
            id: id.into(),
            paper_type: papers::PaperKind::Doi,
            title: title.into(),
            authors: vec!["Ann".into()],
            creators: None,
            year: Some(2020),
            date: None,
            abstract_text: Some("abs".into()),
            tags: vec![PaperTag::new("nlp")],
            arxiv_id: Some("2001.00001".into()),
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
    async fn list_and_get_and_notes() {
        let dir = tempdir().unwrap();
        let vault = dir.path().join("v");
        vault::create_vault(&vault, "en").unwrap();
        let rec = sample_record("papers/p1", "p1", "Hello");
        std::fs::create_dir_all(vault.join("papers").join("p1")).unwrap();
        papers::upsert_paper(&vault, &rec).unwrap();

        let listed = run_local(
            &vault,
            "paper_list",
            serde_json::json!({"query":"Hello"}),
            None,
        )
        .await
        .unwrap();
        let items = listed["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["id"], "p1");
        assert_eq!(items[0]["title"], "Hello");
        assert!(items[0].get("authors").is_none());
        let got = run_local(&vault, "paper_get", serde_json::json!({"paper":"p1"}), None)
            .await
            .unwrap();
        assert_eq!(got["title"], "Hello");
        assert_eq!(got["authors"], serde_json::json!(["Ann"]));
        assert_eq!(got["abstract"], "abs");

        run_local(
            &vault,
            "paper_note_replace",
            serde_json::json!({"paper":"p1","content":"# n","if_revision":"missing"}),
            None,
        )
        .await
        .unwrap();
        let text = std::fs::read_to_string(vault.join("papers/p1/NOTES.md")).unwrap();
        assert!(text.contains("# n"), "{text}");

        let escaped = papers::resolve_paper(&vault, "../etc/passwd");
        assert!(escaped.is_err());
    }

    #[test]
    fn vault_discovery_without_an_open_vault() {
        let ctrl = McpController::new();
        assert!(ctrl.vault_list().vaults.is_empty());
        assert!(ctrl.local_vault().is_err());
    }

    #[test]
    fn vault_list_tracks_open_and_known_local_vaults() {
        let first = tempdir().unwrap();
        let second = tempdir().unwrap();
        let unknown = tempdir().unwrap();
        let key = |p: &std::path::Path| {
            agentero_core::fs::canonicalize_best_effort(p)
                .to_string_lossy()
                .into_owned()
        };
        let ctrl = McpController::new();
        ctrl.set_known_vaults(vec![
            key(second.path()),
            "remote:session-1".into(),
            "relative/vault".into(),
        ]);
        ctrl.set_vault(Some(key(first.path())));

        let listed = ctrl.vault_list();
        assert_eq!(listed.open.as_deref(), Some(key(first.path()).as_str()));
        assert_eq!(listed.vaults.len(), 2);
        assert!(listed.vaults[0].open);
        assert_eq!(listed.vaults[0].path, key(first.path()));
        assert!(listed.vaults.iter().any(|v| v.path == key(second.path())));
        assert!(listed.vaults.iter().all(|v| v.exists));

        assert_eq!(
            ctrl.resolve_vault(Some(&key(second.path()))).unwrap(),
            second.path().canonicalize().unwrap()
        );
        assert!(ctrl.resolve_vault(Some(&key(unknown.path()))).is_err());
        assert!(ctrl.resolve_vault(Some("remote:session-1")).is_err());
    }

    #[tokio::test]
    async fn enable_listens_disable_stops() {
        let dir = tempdir().unwrap();
        let ctrl = Arc::new(McpController {
            token_file: dir.path().join("token"),
            ..McpController::new()
        });
        // Bind an ephemeral port first so the test does not collide.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let st = ctrl.set_port(port).await;
        assert!(!st.listening);
        let st = ctrl.set_enabled(true).await;
        assert!(st.listening, "{st:?}");
        assert!(st.url.as_deref().unwrap().contains("/mcp"));
        let st = ctrl.set_enabled(false).await;
        assert!(!st.listening);
        assert!(!st.enabled);
    }
}
