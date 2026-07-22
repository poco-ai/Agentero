//! Process-wide connector server state and lifecycle.

use super::server;
use crate::error::AppError;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

/// Default Zotero Connector port (must match official extension default).
pub const DEFAULT_CONNECTOR_PORT: u16 = 23119;

const CONNECTOR_API_VERSION: &str = "2";
const AGENTERO_CONNECTOR_VERSION: &str = "0.1.0-agentero";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorStatus {
    pub enabled: bool,
    pub listening: bool,
    pub port: u16,
    pub bound_address: Option<String>,
    pub last_error: Option<String>,
    pub vault_path: Option<String>,
    pub parent_dir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorItemSaved {
    pub path: String,
    pub id: String,
    pub title: String,
    pub deduped: bool,
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorProgress {
    pub key: String,
    pub session_id: String,
    pub path: String,
    pub title: String,
    pub status: String,
    pub progress: Option<i32>,
    pub detail: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ProgressAttachment {
    pub id: String,
    pub title: String,
    pub content_type: String,
    pub progress: i32,
}

#[derive(Debug, Clone)]
pub struct ProgressItem {
    pub id: serde_json::Value,
    pub title: String,
    pub item_type: String,
    pub attachments: Vec<ProgressAttachment>,
}

#[derive(Debug)]
pub struct SaveSession {
    pub created: std::time::Instant,
    pub items: Vec<ProgressItem>,
    pub done: bool,
    /// Vault-relative parent (`papers` or `papers/…`) for this save session.
    pub parent_dir: String,
    /// Paper folders created in this session (vault-relative), for updateSession moves.
    pub paper_paths: Vec<String>,
    /// Connector item id (stringified) → paper folder path; resolves `saveAttachment` `parentItemID`.
    pub item_map: HashMap<String, String>,
}

struct Inner {
    enabled: bool,
    listening: bool,
    port: u16,
    last_error: Option<String>,
    /// Local absolute path or `remote:<sessionId>` handle.
    vault_handle: Option<String>,
    parent_dir: String,
    /// Cancels the accept loop when the server should stop.
    shutdown_tx: Option<oneshot::Sender<()>>,
    sessions: HashMap<String, SaveSession>,
    app: Option<AppHandle>,
}

/// Shared controller managed by Tauri (`app.manage`).
pub struct ConnectorController {
    inner: Mutex<Inner>,
    /// Fast path for handlers without locking the full struct for vault checks.
    running: AtomicBool,
    /// Remote vault registry (injected at app start) for `remote:…` saves.
    remote_registry: Mutex<Option<Arc<crate::services::remote::RemoteRegistry>>>,
}

impl Default for ConnectorController {
    fn default() -> Self {
        Self::new()
    }
}

impl ConnectorController {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                enabled: false,
                listening: false,
                port: DEFAULT_CONNECTOR_PORT,
                last_error: None,
                vault_handle: None,
                parent_dir: "papers".into(),
                shutdown_tx: None,
                sessions: HashMap::new(),
                app: None,
            }),
            running: AtomicBool::new(false),
            remote_registry: Mutex::new(None),
        }
    }

    pub fn set_app_handle(&self, app: AppHandle) {
        if let Ok(mut g) = self.inner.lock() {
            g.app = Some(app);
        }
    }

    pub fn set_remote_registry(&self, registry: Arc<crate::services::remote::RemoteRegistry>) {
        if let Ok(mut g) = self.remote_registry.lock() {
            *g = Some(registry);
        }
    }

    pub fn remote_registry(&self) -> Option<Arc<crate::services::remote::RemoteRegistry>> {
        self.remote_registry.lock().ok().and_then(|g| g.clone())
    }

    pub fn status(&self) -> ConnectorStatus {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        ConnectorStatus {
            enabled: g.enabled,
            listening: g.listening,
            port: g.port,
            bound_address: if g.listening {
                Some(format!("127.0.0.1:{}", g.port))
            } else {
                None
            },
            last_error: g.last_error.clone(),
            vault_path: g.vault_handle.clone(),
            parent_dir: g.parent_dir.clone(),
        }
    }

    /// Update the Vault handle used by `saveItems` (None when no vault open).
    /// Accepts local absolute paths and `remote:<sessionId>` handles.
    pub fn set_vault(&self, vault_path: Option<String>) {
        if let Ok(mut g) = self.inner.lock() {
            let raw = vault_path
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            g.vault_handle = raw.clone();
            // Clear stale remote-only error / previous bind errors when rebinding.
            if g.last_error.as_deref().is_some_and(|e| {
                e.contains("remote vault is not supported")
                    || e.contains("No vault open")
                    || e.contains("remote session not found")
            }) {
                g.last_error = None;
            }
            log::debug!(
                target: "agentero::connector",
                "set_vault handle={}",
                raw.as_deref().unwrap_or("(none)")
            );
        }
        self.emit_status();
    }

    pub fn set_parent_dir(&self, parent_dir: String) {
        if let Ok(mut g) = self.inner.lock() {
            let trimmed = parent_dir
                .trim()
                .replace('\\', "/")
                .trim_matches('/')
                .to_string();
            if !trimmed.is_empty() {
                g.parent_dir = trimmed;
            }
        }
    }

    /// Change the loopback port. If the server is enabled, restart it so the
    /// status cannot claim a port that is not actually bound.
    pub fn set_port(self: &Arc<Self>, port: u16) -> ConnectorStatus {
        if port == 0 {
            if let Ok(mut g) = self.inner.lock() {
                g.last_error = Some("Connector port must be between 1 and 65535".into());
            }
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
            if let Err(e) = self.start_server() {
                if let Ok(mut g) = self.inner.lock() {
                    g.last_error = Some(e.to_string());
                    g.listening = false;
                }
            }
        }
        self.emit_status();
        self.status()
    }

    /// Vault handle string (local path or `remote:…`) + parent dir.
    pub fn vault_handle_and_parent(&self) -> Result<(String, String), AppError> {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let handle = g.vault_handle.clone().ok_or_else(|| {
            AppError::message(
                "No vault open — open a local or remote vault in Agentero first (Connector needs an active vault)",
            )
        })?;
        Ok((handle, g.parent_dir.clone()))
    }

    /// Local vault absolute path + parent (errors if remote or missing).
    pub fn vault_and_parent(&self) -> Result<(PathBuf, String), AppError> {
        let (handle, parent) = self.vault_handle_and_parent()?;
        if handle.starts_with("remote:") {
            return Err(AppError::message(
                "use remote import path for remote vault handles",
            ));
        }
        let vault = PathBuf::from(&handle);
        if !vault.is_dir() {
            return Err(AppError::message("Vault path is not a directory"));
        }
        Ok((vault, parent))
    }

    pub fn is_remote_vault(&self) -> bool {
        self.inner
            .lock()
            .ok()
            .and_then(|g| g.vault_handle.clone())
            .is_some_and(|h| h.starts_with("remote:"))
    }

    /// Enable or disable the HTTP server. Idempotent.
    pub fn set_enabled(self: &Arc<Self>, enabled: bool) -> ConnectorStatus {
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
                return self.status_from(&g);
            }
        }

        match self.start_server() {
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

    fn status_from(&self, g: &Inner) -> ConnectorStatus {
        ConnectorStatus {
            enabled: g.enabled,
            listening: g.listening,
            port: g.port,
            bound_address: if g.listening {
                Some(format!("127.0.0.1:{}", g.port))
            } else {
                None
            },
            last_error: g.last_error.clone(),
            vault_path: g.vault_handle.clone(),
            parent_dir: g.parent_dir.clone(),
        }
    }

    fn start_server(self: &Arc<Self>) -> Result<(), AppError> {
        let port = {
            let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            g.port
        };

        // Stop any previous listener first.
        self.stop_server_internal();

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let ctrl = Arc::clone(self);

        // Bind synchronously (no runtime needed) so EADDRINUSE fails before we
        // claim success. Converted to a tokio listener inside the serve task.
        let std_listener =
            std::net::TcpListener::bind(std::net::SocketAddr::from(([127, 0, 0, 1], port)))
                .map_err(|e| {
                    if e.kind() == std::io::ErrorKind::AddrInUse {
                        AppError::message(format!(
                            "Port {port} is already in use (often Zotero is running). Quit the other app and try again."
                        ))
                    } else {
                        AppError::message(format!("Failed to bind 127.0.0.1:{port}: {e}"))
                    }
                })?;
        std_listener
            .set_nonblocking(true)
            .map_err(|e| AppError::message(format!("Failed to configure listener: {e}")))?;

        {
            let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            g.shutdown_tx = Some(shutdown_tx);
            g.listening = true;
            g.last_error = None;
        }
        self.running.store(true, Ordering::SeqCst);

        let ctrl_serve = Arc::clone(&ctrl);
        tauri::async_runtime::spawn(async move {
            let listener = match tokio::net::TcpListener::from_std(std_listener) {
                Ok(l) => l,
                Err(e) => {
                    if let Ok(mut g) = ctrl.inner.lock() {
                        g.listening = false;
                        g.last_error = Some(format!("Failed to register listener: {e}"));
                    }
                    ctrl.running.store(false, Ordering::SeqCst);
                    ctrl.emit_status();
                    return;
                }
            };
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

    fn stop_server(&self) {
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

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn create_session(
        &self,
        session_id: &str,
        items: Vec<ProgressItem>,
    ) -> Result<(), AppError> {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        self.gc_sessions_locked(&mut g);
        if g.sessions.contains_key(session_id) {
            return Err(AppError::message("SESSION_EXISTS"));
        }
        let parent_dir = g.parent_dir.clone();
        g.sessions.insert(
            session_id.to_string(),
            SaveSession {
                created: std::time::Instant::now(),
                items,
                done: false,
                parent_dir,
                paper_paths: Vec::new(),
                item_map: HashMap::new(),
            },
        );
        Ok(())
    }

    /// Parent dir for a live session (falls back to global default).
    pub fn session_parent_dir(&self, session_id: &str) -> String {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.sessions
            .get(session_id)
            .map(|s| s.parent_dir.clone())
            .unwrap_or_else(|| g.parent_dir.clone())
    }

    pub fn record_session_paper(&self, session_id: &str, paper_path: &str) {
        if let Ok(mut g) = self.inner.lock() {
            if let Some(s) = g.sessions.get_mut(session_id) {
                s.paper_paths.push(paper_path.replace('\\', "/"));
            }
        }
    }

    /// Map a Connector item id (stringified) to its paper folder, so a later
    /// `saveAttachment` can resolve `parentItemID` → paper.
    pub fn record_session_item_paper(
        &self,
        session_id: &str,
        connector_item_id: &str,
        paper_path: &str,
    ) {
        if connector_item_id.is_empty() {
            return;
        }
        if let Ok(mut g) = self.inner.lock() {
            if let Some(s) = g.sessions.get_mut(session_id) {
                s.item_map
                    .insert(connector_item_id.to_string(), paper_path.replace('\\', "/"));
            }
        }
    }

    /// Resolve a saved paper by Connector item id, falling back to the only
    /// paper in the session for older saveSingleFile callers.
    pub fn session_item_paper(&self, session_id: &str, item_id: Option<&str>) -> Option<String> {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let session = g.sessions.get(session_id)?;
        item_id
            .and_then(|id| session.item_map.get(id).cloned())
            .or_else(|| session.paper_paths.last().cloned())
    }

    /// Resolve paper rel for a `saveAttachment` upload (session map / last paper).
    fn resolve_attachment_rel(
        &self,
        session_id: &str,
        parent_item_id: Option<&str>,
    ) -> Result<String, AppError> {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let session = g
            .sessions
            .get(session_id)
            .ok_or_else(|| AppError::message("SESSION_NOT_FOUND"))?;
        parent_item_id
            .and_then(|pid| session.item_map.get(pid))
            .cloned()
            .or_else(|| session.paper_paths.last().cloned())
            .ok_or_else(|| AppError::message("no paper folder for attachment"))
    }

    /// Write a browser-uploaded attachment as the paper's `{id}.pdf` (login-wall PDFs).
    /// Local vault: sync write. Remote vault: SFTP via async runtime.
    pub async fn write_attachment_pdf(
        &self,
        session_id: &str,
        parent_item_id: Option<&str>,
        bytes: &[u8],
    ) -> Result<String, AppError> {
        if bytes.len() < 4 || &bytes[..4] != b"%PDF" {
            return Err(AppError::message("uploaded attachment is not a PDF"));
        }
        let rel = self.resolve_attachment_rel(session_id, parent_item_id)?;
        let handle = {
            let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            g.vault_handle
                .clone()
                .ok_or_else(|| AppError::message("No vault open"))?
        };

        if let Some(sid) = crate::services::remote::parse_remote_handle(&handle) {
            let reg = self
                .remote_registry()
                .ok_or_else(|| AppError::message("remote registry unavailable"))?;
            let session = reg.get(sid).await?;
            let rel = super::import::write_attachment_pdf_remote(session, &rel, bytes).await?;
            let id = rel.rsplit('/').next().unwrap_or("paper").to_string();
            self.emit_item_saved(ConnectorItemSaved {
                path: rel.clone(),
                id: id.clone(),
                title: id,
                deduped: false,
                session_id: session_id.to_string(),
            });
            return Ok(rel);
        }

        let vault = PathBuf::from(&handle);
        let paper_dir = vault.join(&rel);
        if !paper_dir.is_dir() {
            return Err(AppError::message("paper folder missing"));
        }
        let id = rel.rsplit('/').next().unwrap_or("paper").to_string();
        std::fs::write(paper_dir.join(format!("{id}.pdf")), bytes)?;

        self.emit_item_saved(ConnectorItemSaved {
            path: rel.clone(),
            id: id.clone(),
            title: id.clone(),
            deduped: false,
            session_id: session_id.to_string(),
        });

        let rel_bg = rel.clone();
        let dir_bg = paper_dir;
        tauri::async_runtime::spawn(async move {
            let _ = crate::services::pdf_parse::maybe_generate_paper_md_after_download(
                &vault, &rel_bg, &dir_bg,
            )
            .await;
        });
        Ok(rel)
    }

    pub fn mark_session_done(&self, session_id: &str) {
        if let Ok(mut g) = self.inner.lock() {
            if let Some(s) = g.sessions.get_mut(session_id) {
                s.done = true;
            }
        }
    }

    /// Apply Connector collection picker change: remember parent + move papers already saved.
    pub async fn update_session_target(
        &self,
        session_id: &str,
        target: &str,
    ) -> Result<String, AppError> {
        let parent = super::targets::resolve_target_parent(target).ok_or_else(|| {
            AppError::message(format!("unknown or invalid save target: {target}"))
        })?;

        let (handle, paths_to_move) = {
            let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            g.parent_dir = parent.clone();
            let handle = g
                .vault_handle
                .clone()
                .ok_or_else(|| AppError::message("No vault open"))?;
            let session = g
                .sessions
                .get_mut(session_id)
                .ok_or_else(|| AppError::message("SESSION_NOT_FOUND"))?;
            session.parent_dir = parent.clone();
            let paths = session.paper_paths.clone();
            (handle, paths)
        };

        let mut new_paths = Vec::new();
        if let Some(sid) = crate::services::remote::parse_remote_handle(&handle) {
            let reg = self
                .remote_registry()
                .ok_or_else(|| AppError::message("remote registry unavailable"))?;
            let session = reg.get(sid).await?;
            for from in &paths_to_move {
                match super::import::move_paper_folder_remote(&session, from, &parent).await {
                    Ok(new_rel) => new_paths.push(new_rel),
                    Err(e) => {
                        self.emit_error(&format!("move {from}: {e}"), Some(session_id));
                        new_paths.push(from.clone());
                    }
                }
            }
        } else {
            let vault = PathBuf::from(&handle);
            for from in &paths_to_move {
                match move_paper_folder(&vault, from, &parent) {
                    Ok(new_rel) => new_paths.push(new_rel),
                    Err(e) => {
                        self.emit_error(&format!("move {from}: {e}"), Some(session_id));
                        new_paths.push(from.clone());
                    }
                }
            }
        }

        if !new_paths.is_empty() {
            if let Ok(mut g) = self.inner.lock() {
                if let Some(s) = g.sessions.get_mut(session_id) {
                    s.paper_paths = new_paths.clone();
                }
            }
            for path in &new_paths {
                if let Some(id) = path.rsplit('/').next() {
                    self.emit_item_saved(ConnectorItemSaved {
                        path: path.clone(),
                        id: id.to_string(),
                        title: id.to_string(),
                        deduped: false,
                        session_id: session_id.to_string(),
                    });
                }
            }
        }

        Ok(parent)
    }

    /// Apply Connector's post-save tags to every paper in a session.
    pub async fn update_session_tags(
        &self,
        session_id: &str,
        tags: &[String],
    ) -> Result<(), AppError> {
        let (handle, paths) = {
            let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let session = g
                .sessions
                .get(session_id)
                .ok_or_else(|| AppError::message("SESSION_NOT_FOUND"))?;
            (
                g.vault_handle
                    .clone()
                    .ok_or_else(|| AppError::message("No vault open"))?,
                session.paper_paths.clone(),
            )
        };
        let paper_tags: Vec<crate::services::catalog::papers::PaperTag> =
            tags.iter().cloned().map(Into::into).collect();
        if let Some(sid) = crate::services::remote::parse_remote_handle(&handle) {
            let reg = self
                .remote_registry()
                .ok_or_else(|| AppError::message("remote registry unavailable"))?;
            let session = reg.get(sid).await?;
            for path in paths {
                let row = crate::services::catalog::papers::add_tags(
                    &session.work_root,
                    &path,
                    &paper_tags,
                )?;
                let metadata = serde_json::to_vec_pretty(&row)
                    .map_err(|e| AppError::message(e.to_string()))?;
                session
                    .fs
                    .write(
                        &format!("{path}/metadata.json"),
                        &metadata,
                        crate::services::fs::WriteOpts {
                            create_parents: true,
                        },
                    )
                    .await?;
            }
            session
                .catalog
                .lock()
                .await
                .push(session.fs.clone())
                .await?;
        } else {
            let vault = PathBuf::from(handle);
            for path in paths {
                let _ = crate::services::catalog::papers::add_tags(&vault, &path, &paper_tags)?;
            }
        }
        Ok(())
    }

    /// JSON body for `/connector/getSelectedCollection` (async for remote targets).
    pub async fn selected_collection_json(&self) -> serde_json::Value {
        let (parent, handle) = {
            let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            (g.parent_dir.clone(), g.vault_handle.clone())
        };

        let vault_name_owned = handle.as_deref().and_then(|h| {
            if h.starts_with("remote:") {
                None
            } else {
                PathBuf::from(h)
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
            }
        });
        let vault_name = if handle.as_deref().is_some_and(|h| h.starts_with("remote:")) {
            "Agentero Remote Vault"
        } else {
            vault_name_owned.as_deref().unwrap_or("Agentero Vault")
        };

        let targets = if let Some(h) = handle.as_deref() {
            if let Some(sid) = crate::services::remote::parse_remote_handle(h) {
                if let Some(reg) = self.remote_registry() {
                    match reg.get(sid).await {
                        Ok(session) => super::import::list_save_targets_remote(&session).await,
                        Err(_) => vec![super::targets::SaveTarget {
                            id: "L1".into(),
                            name: "papers".into(),
                            level: 0,
                        }],
                    }
                } else {
                    vec![super::targets::SaveTarget {
                        id: "L1".into(),
                        name: "papers".into(),
                        level: 0,
                    }]
                }
            } else {
                super::targets::list_save_targets(Path::new(h))
            }
        } else {
            vec![super::targets::SaveTarget {
                id: "L1".into(),
                name: "papers".into(),
                level: 0,
            }]
        };

        let (sel_id, sel_name) = if parent == "papers" {
            ("L1".to_string(), "papers".to_string())
        } else {
            let name = parent
                .rsplit('/')
                .next()
                .unwrap_or(parent.as_str())
                .to_string();
            (format!("D{parent}"), name)
        };

        serde_json::json!({
            "libraryID": 1,
            "libraryName": vault_name,
            "libraryEditable": true,
            "editable": true,
            "id": if parent == "papers" { serde_json::Value::Null } else { serde_json::json!(sel_id) },
            "name": sel_name,
            "targets": targets,
        })
    }

    pub fn session_progress_json(&self, session_id: &str) -> Result<serde_json::Value, AppError> {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let session = g
            .sessions
            .get(session_id)
            .ok_or_else(|| AppError::message("SESSION_NOT_FOUND"))?;
        let items: Vec<serde_json::Value> = session
            .items
            .iter()
            .map(|it| {
                let atts: Vec<serde_json::Value> = it
                    .attachments
                    .iter()
                    .map(|a| {
                        serde_json::json!({
                            "id": format!("{}_{}", session_id, a.id),
                            "title": a.title,
                            "contentType": a.content_type,
                            "mimeType": a.content_type,
                            "progress": a.progress,
                        })
                    })
                    .collect();
                serde_json::json!({
                    "id": it.id,
                    "title": it.title,
                    "itemType": it.item_type,
                    "attachments": atts,
                })
            })
            .collect();
        Ok(serde_json::json!({
            "items": items,
            "done": session.done,
        }))
    }

    fn gc_sessions_locked(&self, g: &mut Inner) {
        let ttl = if g.sessions.len() >= 10 {
            std::time::Duration::from_secs(60)
        } else {
            std::time::Duration::from_secs(600)
        };
        g.sessions.retain(|_, s| s.created.elapsed() < ttl);
    }

    pub fn emit_item_saved(&self, payload: ConnectorItemSaved) {
        if let Ok(g) = self.inner.lock() {
            if let Some(app) = &g.app {
                let _ = app.emit("connector:item-saved", &payload);
            }
        }
    }

    pub fn emit_progress(&self, payload: ConnectorProgress) {
        if let Ok(g) = self.inner.lock() {
            if let Some(app) = &g.app {
                let _ = app.emit("connector:progress", &payload);
            }
        }
    }

    pub fn emit_error(&self, message: &str, session_id: Option<&str>) {
        if let Ok(g) = self.inner.lock() {
            if let Some(app) = &g.app {
                let _ = app.emit(
                    "connector:error",
                    serde_json::json!({
                        "message": message,
                        "sessionId": session_id,
                    }),
                );
            }
        }
    }

    fn emit_status(&self) {
        let status = self.status();
        if let Ok(g) = self.inner.lock() {
            if let Some(app) = &g.app {
                let _ = app.emit("connector:status", &status);
            }
        }
    }

    pub fn response_headers() -> [(&'static str, &'static str); 2] {
        [
            ("X-Zotero-Version", AGENTERO_CONNECTOR_VERSION),
            ("X-Zotero-Connector-API-Version", CONNECTOR_API_VERSION),
        ]
    }
}

/// Move a paper folder under a new org parent and rewrite catalog paths.
fn move_paper_folder(
    vault: &std::path::Path,
    from_rel: &str,
    dest_parent: &str,
) -> Result<String, AppError> {
    use crate::services::catalog::papers;

    let from = from_rel.trim().trim_matches('/').replace('\\', "/");
    let dest_parent = dest_parent.trim().trim_matches('/').replace('\\', "/");
    if from.is_empty() {
        return Err(AppError::message("empty paper path"));
    }
    let base = from.rsplit('/').next().unwrap_or(from.as_str()).to_string();
    let new_rel = format!("{dest_parent}/{base}");
    if new_rel == from {
        return Ok(from);
    }
    let from_abs = vault.join(&from);
    let new_abs = vault.join(&new_rel);
    if !from_abs.is_dir() {
        return Err(AppError::message(format!("paper folder missing: {from}")));
    }
    if new_abs.exists() {
        return Err(AppError::message(format!(
            "destination already exists: {new_rel}"
        )));
    }
    if let Some(parent) = new_abs.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(&from_abs, &new_abs)?;
    let _ = papers::move_under_path(vault, &from, &new_rel);
    Ok(new_rel)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_vault_accepts_remote_handle() {
        let ctrl = ConnectorController::new();
        ctrl.set_vault(Some("remote:sess-abc".into()));
        let (handle, parent) = ctrl.vault_handle_and_parent().expect("bound");
        assert_eq!(handle, "remote:sess-abc");
        assert_eq!(parent, "papers");
        assert!(ctrl.is_remote_vault());
        assert_eq!(ctrl.status().vault_path.as_deref(), Some("remote:sess-abc"));
    }

    #[test]
    fn set_vault_none_reports_no_vault() {
        let ctrl = ConnectorController::new();
        ctrl.set_vault(None);
        let err = ctrl.vault_handle_and_parent().unwrap_err().to_string();
        assert!(err.contains("No vault open"), "{err}");
    }
}
