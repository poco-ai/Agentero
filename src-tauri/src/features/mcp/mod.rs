//! Loopback Streamable HTTP MCP server (Settings toggle).
//!
//! See `docs/backend/mcp.md`.

mod icons;
mod notes;
mod paper;
mod resources;
mod server;
mod tools;
pub mod tunnel;

pub mod commands;

use crate::core::error::AppError;
use crate::features::settings::DEFAULT_MCP_PORT;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

pub const MCP_STATUS_EVENT: &str = "mcp:status";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub enabled: bool,
    pub listening: bool,
    pub port: u16,
    pub url: Option<String>,
    pub last_error: Option<String>,
    pub vault_path: Option<String>,
}

struct Inner {
    enabled: bool,
    listening: bool,
    port: u16,
    last_error: Option<String>,
    vault_handle: Option<String>,
    parent_dir: String,
    translator_url: Option<String>,
    paper_note_mode: String,
    shutdown_tx: Option<oneshot::Sender<()>>,
    app: Option<AppHandle>,
}

pub struct McpController {
    inner: Mutex<Inner>,
    running: AtomicBool,
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
                parent_dir: "papers".into(),
                translator_url: None,
                paper_note_mode: "standard".into(),
                shutdown_tx: None,
                app: None,
            }),
            running: AtomicBool::new(false),
        }
    }

    pub fn set_app_handle(&self, app: AppHandle) {
        if let Ok(mut g) = self.inner.lock() {
            g.app = Some(app);
        }
    }

    pub fn app_handle(&self) -> Option<AppHandle> {
        self.inner.lock().ok().and_then(|g| g.app.clone())
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
        if let Ok(mut g) = self.inner.lock() {
            g.vault_handle = vault_path
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
        }
        self.emit_status();
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
        crate::core::fs::resolve_vault(&handle)
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
        tauri::async_runtime::spawn(async move {
            if let Err(e) = server::serve(listener, shutdown_rx, ctrl_serve).await {
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
        if let Ok(g) = self.inner.lock() {
            if let Some(app) = &g.app {
                let _ = app.emit(MCP_STATUS_EVENT, &status);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::catalog::papers::{self, PaperRecord, PaperTag};
    use crate::features::mcp::notes::WriteMode;
    use crate::features::vault;
    use tempfile::tempdir;

    fn sample_record(path: &str, id: &str, title: &str) -> PaperRecord {
        PaperRecord {
            path: path.into(),
            id: id.into(),
            paper_type: "article".into(),
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

    #[test]
    fn list_and_get_and_notes() {
        let dir = tempdir().unwrap();
        let vault = dir.path().join("v");
        vault::create_vault(&vault, "en").unwrap();
        let rec = sample_record("papers/p1", "p1", "Hello");
        std::fs::create_dir_all(vault.join("papers").join("p1")).unwrap();
        papers::upsert_paper(&vault, &rec).unwrap();

        let items = paper::list_papers(&vault, Some("Hello"), &[], false, 50).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "p1");
        assert_eq!(items[0].title, "Hello");

        let got = paper::get_paper(&vault, "p1").unwrap();
        assert_eq!(got.title, "Hello");
        assert_eq!(got.abstract_text.as_deref(), Some("abs"));

        notes::write_notes(&vault, "papers/p1", "p1", "# n", WriteMode::Replace).unwrap();
        let text = notes::read_notes(&vault, "papers/p1").unwrap();
        assert!(text.contains("# n"), "{text}");

        let escaped = paper::resolve_paper(&vault, "../etc/passwd");
        assert!(escaped.is_err());
    }

    #[test]
    fn resource_markdown_without_vault() {
        let ctrl = McpController::new();
        let md = resources::vault_markdown(&ctrl);
        assert!(md.contains("No local vault"), "{md}");
    }

    #[tokio::test]
    async fn enable_listens_disable_stops() {
        let ctrl = Arc::new(McpController::new());
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
