//! Process-wide connector server state and lifecycle.

use super::server;
use crate::core::error::AppError;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachmentPhase {
    AwaitingBrowserOrResolver,
    WritingBrowser,
    WritingFallback,
    TerminalSuccess,
    TerminalFailure,
}

impl AttachmentPhase {
    fn is_terminal(self) -> bool {
        matches!(self, Self::TerminalSuccess | Self::TerminalFailure)
    }
}

#[derive(Debug)]
pub struct SaveSession {
    pub created: std::time::Instant,
    pub items: Vec<ProgressItem>,
    pub done: bool,
    /// Immutable initial Vault-relative parent copied from the current Library scope.
    pub parent_dir: String,
    /// Latest collection-picker target waiting to be applied after attachment IO.
    pub desired_parent: Option<String>,
    /// Paper folders created in this session (vault-relative), for updateSession moves.
    pub paper_paths: Vec<String>,
    /// Connector item id (stringified) → paper folder path; resolves `saveAttachment` `parentItemID`.
    pub item_map: HashMap<String, String>,
    /// Per-item primary attachment acquisition state. Deduped items are excluded.
    pub attachment_phase: HashMap<String, AttachmentPhase>,
    /// Attachment handlers currently writing into session-owned paper folders.
    pub active_writers: usize,
    /// Completion events held until every new item has a stable final path.
    pub pending_saved: Vec<ConnectorItemSaved>,
    pub initial_finalized: bool,
    /// Serializes finalization and collection moves without blocking browser downloads.
    pub io_gate: Arc<AsyncMutex<()>>,
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
    remote_registry: Mutex<Option<Arc<crate::features::remote::RemoteRegistry>>>,
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

    pub fn app_handle(&self) -> Option<AppHandle> {
        self.inner.lock().ok().and_then(|g| g.app.clone())
    }

    pub fn set_remote_registry(&self, registry: Arc<crate::features::remote::RemoteRegistry>) {
        if let Ok(mut g) = self.remote_registry.lock() {
            *g = Some(registry);
        }
    }

    pub fn remote_registry(&self) -> Option<Arc<crate::features::remote::RemoteRegistry>> {
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
    pub async fn set_port(self: &Arc<Self>, port: u16) -> ConnectorStatus {
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

    pub fn is_remote_vault(&self) -> bool {
        self.inner
            .lock()
            .ok()
            .and_then(|g| g.vault_handle.clone())
            .is_some_and(|h| h.starts_with("remote:"))
    }

    /// Enable or disable the HTTP server. Idempotent.
    ///
    /// Async: binding the listener is awaited on the runtime instead of
    /// `block_on`, so command handlers never stall their calling thread.
    pub async fn set_enabled(self: &Arc<Self>, enabled: bool) -> ConnectorStatus {
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

    async fn start_server(self: &Arc<Self>) -> Result<(), AppError> {
        let port = {
            let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            g.port
        };

        // Stop any previous listener first.
        self.stop_server_internal();

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let ctrl = Arc::clone(self);

        // Await the bind so EADDRINUSE fails before we claim success — without
        // `block_on`, which would stall the calling thread.
        let listener =
            tokio::net::TcpListener::bind(std::net::SocketAddr::from(([127, 0, 0, 1], port)))
                .await
                .map_err(|e| {
                    if e.kind() == std::io::ErrorKind::AddrInUse {
                        AppError::message("请先退出本地Zotero".to_string())
                    } else {
                        AppError::message(format!("Failed to bind 127.0.0.1:{port}: {e}"))
                    }
                })?;

        {
            let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            g.shutdown_tx = Some(shutdown_tx);
            g.listening = true;
            g.last_error = None;
        }
        self.running.store(true, Ordering::SeqCst);

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
                parent_dir: parent_dir.clone(),
                desired_parent: Some(parent_dir),
                paper_paths: Vec::new(),
                item_map: HashMap::new(),
                attachment_phase: HashMap::new(),
                active_writers: 0,
                pending_saved: Vec::new(),
                initial_finalized: false,
                io_gate: Arc::new(AsyncMutex::new(())),
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

    /// Record one imported item. New papers remain pending until their primary
    /// attachment path is terminal; deduped papers are mapped but never moved.
    pub fn record_session_import(
        &self,
        session_id: &str,
        connector_item_id: &str,
        mut payload: ConnectorItemSaved,
        waits_for_attachment: bool,
    ) -> Result<(), AppError> {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let session = g
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| AppError::message("SESSION_NOT_FOUND"))?;
        payload.path = payload.path.replace('\\', "/");
        let item_key = if connector_item_id.is_empty() {
            payload.id.clone()
        } else {
            connector_item_id.to_string()
        };
        if !item_key.is_empty() {
            session
                .item_map
                .insert(item_key.clone(), payload.path.clone());
        }
        if payload.deduped {
            return Ok(());
        }
        if !session.paper_paths.contains(&payload.path) {
            session.paper_paths.push(payload.path.clone());
        }
        session.attachment_phase.insert(
            item_key,
            if waits_for_attachment {
                AttachmentPhase::AwaitingBrowserOrResolver
            } else {
                AttachmentPhase::TerminalSuccess
            },
        );
        session.pending_saved.push(payload);
        Ok(())
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

    /// Exact Connector item id → paper path (no last-paper fallback).
    /// Used by OA resolvers so multi-item saves cannot attach the wrong PDF.
    pub fn session_item_paper_exact(
        &self,
        session_id: &str,
        item_id: &str,
    ) -> Result<Option<String>, AppError> {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let session = g
            .sessions
            .get(session_id)
            .ok_or_else(|| AppError::message("SESSION_NOT_FOUND"))?;
        Ok(session.item_map.get(item_id).cloned())
    }

    fn session_io_gate(&self, session_id: &str) -> Result<Arc<AsyncMutex<()>>, AppError> {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.sessions
            .get(session_id)
            .map(|session| Arc::clone(&session.io_gate))
            .ok_or_else(|| AppError::message("SESSION_NOT_FOUND"))
    }

    fn attachment_key(session: &SaveSession, item_id: Option<&str>) -> Option<String> {
        if let Some(item_id) = item_id.filter(|id| !id.is_empty()) {
            if session.attachment_phase.contains_key(item_id) {
                return Some(item_id.to_string());
            }
            if let Some(path) = session.item_map.get(item_id) {
                if let Some(key) = session.attachment_phase.keys().find(|key| {
                    session
                        .item_map
                        .get(*key)
                        .is_some_and(|candidate| candidate == path)
                }) {
                    return Some(key.clone());
                }
            }
        }
        if session.attachment_phase.len() == 1 {
            return session.attachment_phase.keys().next().cloned();
        }
        None
    }

    fn set_attachment_writing(
        &self,
        session_id: &str,
        item_id: Option<&str>,
        phase: AttachmentPhase,
    ) -> Result<(), AppError> {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let session = g
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| AppError::message("SESSION_NOT_FOUND"))?;
        session.active_writers += 1;
        if let Some(key) = Self::attachment_key(session, item_id) {
            session.attachment_phase.insert(key, phase);
        }
        Ok(())
    }

    pub async fn begin_browser_attachment(
        &self,
        session_id: &str,
        item_id: Option<&str>,
    ) -> Result<(), AppError> {
        let gate = self.session_io_gate(session_id)?;
        let _guard = gate.lock().await;
        self.set_attachment_writing(session_id, item_id, AttachmentPhase::WritingBrowser)
    }

    pub async fn begin_fallback_attachment(
        &self,
        session_id: &str,
        item_id: &str,
    ) -> Result<(), AppError> {
        let gate = self.session_io_gate(session_id)?;
        let _guard = gate.lock().await;
        self.set_attachment_writing(session_id, Some(item_id), AttachmentPhase::WritingFallback)
    }

    pub fn emit_attachment_progress(
        &self,
        session_id: &str,
        item_id: Option<&str>,
        status: &str,
        detail: &str,
        error: Option<String>,
    ) {
        let context = {
            let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            g.sessions.get(session_id).and_then(|session| {
                let key = Self::attachment_key(session, item_id)?;
                let path = session.item_map.get(&key)?.clone();
                let title = session
                    .pending_saved
                    .iter()
                    .find(|saved| saved.path == path)
                    .map(|saved| saved.title.clone())
                    .unwrap_or_else(|| key.clone());
                Some((path, title))
            })
        };
        let Some((path, title)) = context else {
            return;
        };
        self.emit_progress(ConnectorProgress {
            key: format!("{session_id}:{path}"),
            session_id: session_id.to_string(),
            path,
            title,
            status: status.to_string(),
            progress: None,
            detail: Some(detail.to_string()),
            error,
        });
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

        if let Some(sid) = crate::features::remote::parse_remote_handle(&handle) {
            let reg = self
                .remote_registry()
                .ok_or_else(|| AppError::message("remote registry unavailable"))?;
            let session = reg.get(sid).await?;
            return super::import::write_attachment_pdf_remote(session, &rel, bytes).await;
        }

        let vault = PathBuf::from(&handle);
        let paper_dir = vault.join(&rel);
        if !paper_dir.is_dir() {
            return Err(AppError::message("paper folder missing"));
        }
        let id = rel.rsplit('/').next().unwrap_or("paper").to_string();
        std::fs::write(paper_dir.join(format!("{id}.pdf")), bytes)?;
        Ok(rel)
    }

    pub fn mark_session_done(&self, session_id: &str) {
        if let Ok(mut g) = self.inner.lock() {
            if let Some(s) = g.sessions.get_mut(session_id) {
                s.done = true;
            }
        }
    }

    fn path_is_in_parent(path: &str, parent: &str) -> bool {
        path.rsplit_once('/')
            .is_some_and(|(current_parent, _)| current_parent == parent)
    }

    fn rebase_path(value: &str, from: &str, to: &str) -> String {
        if value == from {
            return to.to_string();
        }
        value
            .strip_prefix(from)
            .filter(|suffix| suffix.starts_with('/'))
            .map(|suffix| format!("{to}{suffix}"))
            .unwrap_or_else(|| value.to_string())
    }

    fn rebase_session_path(&self, session_id: &str, from: &str, to: &str) {
        if from == to {
            return;
        }
        if let Ok(mut g) = self.inner.lock() {
            if let Some(session) = g.sessions.get_mut(session_id) {
                for path in &mut session.paper_paths {
                    *path = Self::rebase_path(path, from, to);
                }
                for path in session.item_map.values_mut() {
                    *path = Self::rebase_path(path, from, to);
                }
                for saved in &mut session.pending_saved {
                    saved.path = Self::rebase_path(&saved.path, from, to);
                }
            }
        }
    }

    async fn move_paper_to_parent(
        &self,
        vault_handle: &str,
        from: &str,
        parent: &str,
    ) -> Result<String, AppError> {
        if Self::path_is_in_parent(from, parent) {
            return Ok(from.to_string());
        }
        if let Some(sid) = crate::features::remote::parse_remote_handle(vault_handle) {
            let reg = self
                .remote_registry()
                .ok_or_else(|| AppError::message("remote registry unavailable"))?;
            let session = reg.get(sid).await?;
            return super::import::move_paper_folder_remote(&session, from, parent).await;
        }

        let app = self
            .app_handle()
            .ok_or_else(|| AppError::message("Connector app handle unavailable"))?;
        let index = app
            .state::<crate::features::wiki::WikiIndexState>()
            .handle();
        let result = crate::features::catalog::commands::paper_move_service(
            crate::features::catalog::commands::PaperMoveArgs {
                vault_path: vault_handle.to_string(),
                from_rel: from.to_string(),
                dest_parent_rel: parent.to_string(),
                dirty_paths: Vec::new(),
            },
            index,
        )
        .await?;
        Ok(result.new_rel)
    }

    /// Apply a ready desired target while the caller holds this session's IO gate.
    async fn apply_ready_session_target(&self, session_id: &str) -> Result<(), AppError> {
        let (vault_handle, desired_parent, paths) = {
            let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let session = g
                .sessions
                .get(session_id)
                .ok_or_else(|| AppError::message("SESSION_NOT_FOUND"))?;
            if session.active_writers != 0
                || session.attachment_phase.is_empty()
                || session
                    .attachment_phase
                    .values()
                    .any(|phase| !phase.is_terminal())
            {
                return Ok(());
            }
            let Some(parent) = session.desired_parent.clone() else {
                return Ok(());
            };
            let handle = g
                .vault_handle
                .clone()
                .ok_or_else(|| AppError::message("No vault open"))?;
            (handle, parent, session.paper_paths.clone())
        };

        for from in paths {
            let new_rel = match self
                .move_paper_to_parent(&vault_handle, &from, &desired_parent)
                .await
            {
                Ok(path) => path,
                Err(error) => {
                    self.emit_error(
                        &format!("move {from} to {desired_parent}: {error}"),
                        Some(session_id),
                    );
                    return Err(error);
                }
            };
            self.rebase_session_path(session_id, &from, &new_rel);
        }

        let pending = {
            let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let session = g
                .sessions
                .get_mut(session_id)
                .ok_or_else(|| AppError::message("SESSION_NOT_FOUND"))?;
            session.desired_parent = None;
            if session.initial_finalized {
                Vec::new()
            } else {
                session.initial_finalized = true;
                std::mem::take(&mut session.pending_saved)
            }
        };
        for saved in pending {
            self.emit_item_saved(saved);
        }
        Ok(())
    }

    pub async fn complete_attachment(
        &self,
        session_id: &str,
        item_id: Option<&str>,
        success: bool,
        writer_finished: bool,
    ) -> Result<(), AppError> {
        let gate = self.session_io_gate(session_id)?;
        let _guard = gate.lock().await;
        {
            let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let session = g
                .sessions
                .get_mut(session_id)
                .ok_or_else(|| AppError::message("SESSION_NOT_FOUND"))?;
            if writer_finished {
                session.active_writers =
                    session.active_writers.checked_sub(1).ok_or_else(|| {
                        AppError::message("attachment writer completion without a matching start")
                    })?;
            }
            if let Some(key) = Self::attachment_key(session, item_id) {
                session.attachment_phase.insert(
                    key,
                    if success {
                        AttachmentPhase::TerminalSuccess
                    } else {
                        AttachmentPhase::TerminalFailure
                    },
                );
            }
        }
        self.apply_ready_session_target(session_id).await
    }

    pub async fn finalize_session_if_ready(&self, session_id: &str) -> Result<(), AppError> {
        let gate = self.session_io_gate(session_id)?;
        let _guard = gate.lock().await;
        self.apply_ready_session_target(session_id).await
    }

    /// Remember the latest collection picker target. Pending attachment IO only
    /// changes desired state; terminal sessions use the shared paper move.
    pub async fn update_session_target(
        &self,
        session_id: &str,
        target: &str,
    ) -> Result<String, AppError> {
        let parent = super::targets::resolve_target_parent(target).ok_or_else(|| {
            AppError::message(format!("unknown or invalid save target: {target}"))
        })?;

        let gate = {
            let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            g.parent_dir = parent.clone();
            if g.vault_handle.is_none() {
                return Err(AppError::message("No vault open"));
            }
            let session = g
                .sessions
                .get(session_id)
                .ok_or_else(|| AppError::message("SESSION_NOT_FOUND"))?;
            Arc::clone(&session.io_gate)
        };

        let _guard = gate.lock().await;
        {
            let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let session = g
                .sessions
                .get_mut(session_id)
                .ok_or_else(|| AppError::message("SESSION_NOT_FOUND"))?;
            session.desired_parent = Some(parent.clone());
        }
        self.apply_ready_session_target(session_id).await?;
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
        let paper_tags: Vec<crate::features::catalog::papers::PaperTag> =
            tags.iter().cloned().map(Into::into).collect();
        if let Some(sid) = crate::features::remote::parse_remote_handle(&handle) {
            let reg = self
                .remote_registry()
                .ok_or_else(|| AppError::message("remote registry unavailable"))?;
            let session = reg.get(sid).await?;
            for path in paths {
                let row = crate::features::catalog::papers::add_tags(
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
                        crate::core::fs::WriteOpts {
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
                let _ = crate::features::catalog::papers::add_tags(&vault, &path, &paper_tags)?;
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
            if let Some(sid) = crate::features::remote::parse_remote_handle(h) {
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

        // Official Connector only uploads PDFs when `filesEditable` is true:
        //   getSelectedCollection → if (response.filesEditable) saveAttachmentsToZotero()
        // Missing this field left it undefined/falsey, so saveItems succeeded but
        // saveAttachment was never called (IEEE stamp pages looked "saved" with no PDF).
        let targets_json: Vec<serde_json::Value> = targets
            .iter()
            .map(|t| {
                serde_json::json!({
                    "id": t.id,
                    "name": t.name,
                    "level": t.level,
                    "filesEditable": true,
                })
            })
            .collect();

        serde_json::json!({
            "libraryID": 1,
            "libraryName": vault_name,
            "libraryEditable": true,
            "filesEditable": true,
            "editable": true,
            "id": if parent == "papers" { serde_json::Value::Null } else { serde_json::json!(sel_id) },
            "name": sel_name,
            "targets": targets_json,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn saved(session_id: &str, path: &str) -> ConnectorItemSaved {
        ConnectorItemSaved {
            path: path.to_string(),
            id: path.rsplit('/').next().unwrap_or("paper").to_string(),
            title: "Paper".into(),
            deduped: false,
            session_id: session_id.to_string(),
        }
    }

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

    #[tokio::test]
    async fn selected_collection_reports_files_editable() {
        let ctrl = ConnectorController::new();
        // No vault is fine for this JSON shape check.
        let v = ctrl.selected_collection_json().await;
        assert_eq!(v.get("filesEditable"), Some(&serde_json::json!(true)));
        assert_eq!(v.get("libraryEditable"), Some(&serde_json::json!(true)));
        assert_eq!(v.get("editable"), Some(&serde_json::json!(true)));
        if let Some(targets) = v.get("targets").and_then(|t| t.as_array()) {
            for t in targets {
                assert_eq!(
                    t.get("filesEditable"),
                    Some(&serde_json::json!(true)),
                    "target missing filesEditable: {t}"
                );
            }
        }
    }

    #[test]
    fn session_keeps_initial_parent_and_tracks_desired_parent_separately() {
        let ctrl = ConnectorController::new();
        ctrl.set_parent_dir("papers/inbox".into());
        ctrl.create_session("s1", Vec::new()).expect("session");
        ctrl.set_parent_dir("papers/later".into());

        let g = ctrl.inner.lock().expect("state");
        let session = g.sessions.get("s1").expect("saved session");
        assert_eq!(session.parent_dir, "papers/inbox");
        assert_eq!(session.desired_parent.as_deref(), Some("papers/inbox"));
        assert_eq!(g.parent_dir, "papers/later");
    }

    #[tokio::test]
    async fn target_change_while_browser_download_is_pending_only_updates_desired_parent() {
        let vault = std::env::temp_dir().join(format!(
            "agentero-connector-pending-{}",
            uuid::Uuid::new_v4()
        ));
        let ctrl = ConnectorController::new();
        ctrl.set_vault(Some(vault.to_string_lossy().to_string()));
        ctrl.set_parent_dir("papers/inbox".into());
        ctrl.create_session("s2", Vec::new()).expect("session");
        ctrl.record_session_import("s2", "item-1", saved("s2", "papers/inbox/paper-1"), true)
            .expect("record import");

        ctrl.update_session_target("s2", "Dpapers/final")
            .await
            .expect("remember target");
        ctrl.update_session_target("s2", "Dpapers/latest")
            .await
            .expect("replace target");

        let g = ctrl.inner.lock().expect("state");
        let session = g.sessions.get("s2").expect("saved session");
        assert_eq!(session.parent_dir, "papers/inbox");
        assert_eq!(session.desired_parent.as_deref(), Some("papers/latest"));
        assert_eq!(session.paper_paths, ["papers/inbox/paper-1"]);
        assert_eq!(
            session.attachment_phase.get("item-1"),
            Some(&AttachmentPhase::AwaitingBrowserOrResolver)
        );
        assert!(!session.initial_finalized);
    }

    #[test]
    fn deduped_import_is_mapped_but_never_owned_by_the_session() {
        let ctrl = ConnectorController::new();
        ctrl.create_session("s-dedupe", Vec::new())
            .expect("session");
        let mut payload = saved("s-dedupe", "papers/existing");
        payload.deduped = true;

        ctrl.record_session_import("s-dedupe", "item-1", payload, true)
            .expect("record dedupe");

        let g = ctrl.inner.lock().expect("state");
        let session = g.sessions.get("s-dedupe").expect("saved session");
        assert_eq!(
            session.item_map.get("item-1").map(String::as_str),
            Some("papers/existing")
        );
        assert!(session.paper_paths.is_empty());
        assert!(session.attachment_phase.is_empty());
        assert!(session.pending_saved.is_empty());
    }

    #[tokio::test]
    async fn failed_attachment_still_finalizes_shell_when_target_is_unchanged() {
        let vault = std::env::temp_dir().join(format!(
            "agentero-connector-failed-{}",
            uuid::Uuid::new_v4()
        ));
        let ctrl = ConnectorController::new();
        ctrl.set_vault(Some(vault.to_string_lossy().to_string()));
        ctrl.create_session("s3", Vec::new()).expect("session");
        ctrl.record_session_import("s3", "item-1", saved("s3", "papers/paper-1"), true)
            .expect("record import");
        ctrl.begin_browser_attachment("s3", Some("item-1"))
            .await
            .expect("begin browser write");

        ctrl.complete_attachment("s3", Some("item-1"), false, true)
            .await
            .expect("failure finalizer");
        ctrl.finalize_session_if_ready("s3")
            .await
            .expect("idempotent finalizer");

        let g = ctrl.inner.lock().expect("state");
        let session = g.sessions.get("s3").expect("saved session");
        assert_eq!(
            session.attachment_phase.get("item-1"),
            Some(&AttachmentPhase::TerminalFailure)
        );
        assert!(session.initial_finalized);
        assert!(session.desired_parent.is_none());
        assert!(session.pending_saved.is_empty());
    }

    #[tokio::test]
    async fn overlapping_attachment_writers_finalize_only_after_the_last_writer() {
        let ctrl = ConnectorController::new();
        let vault = std::env::temp_dir().join(format!(
            "agentero-connector-writers-{}",
            uuid::Uuid::new_v4()
        ));
        ctrl.set_vault(Some(vault.to_string_lossy().to_string()));
        ctrl.create_session("s-writers", Vec::new())
            .expect("session");
        ctrl.record_session_import(
            "s-writers",
            "item-1",
            saved("s-writers", "papers/paper-1"),
            true,
        )
        .expect("record import");
        ctrl.begin_browser_attachment("s-writers", Some("item-1"))
            .await
            .expect("first writer");
        ctrl.begin_browser_attachment("s-writers", Some("item-1"))
            .await
            .expect("second writer");

        ctrl.complete_attachment("s-writers", Some("item-1"), true, true)
            .await
            .expect("first completion");
        {
            let g = ctrl.inner.lock().expect("state");
            let session = g.sessions.get("s-writers").expect("saved session");
            assert_eq!(session.active_writers, 1);
            assert!(!session.initial_finalized);
            assert_eq!(session.pending_saved.len(), 1);
        }

        ctrl.complete_attachment("s-writers", Some("item-1"), true, true)
            .await
            .expect("last completion");
        let g = ctrl.inner.lock().expect("state");
        let session = g.sessions.get("s-writers").expect("saved session");
        assert_eq!(session.active_writers, 0);
        assert!(session.initial_finalized);
        assert!(session.pending_saved.is_empty());
    }

    #[tokio::test]
    async fn late_attachment_begin_waits_for_the_session_move_gate() {
        let ctrl = Arc::new(ConnectorController::new());
        ctrl.create_session("s-late", Vec::new()).expect("session");
        ctrl.record_session_import("s-late", "item-1", saved("s-late", "papers/paper-1"), true)
            .expect("record import");
        let gate = ctrl.session_io_gate("s-late").expect("gate");
        let guard = gate.lock().await;
        let ctrl_bg = Arc::clone(&ctrl);
        let begin = tokio::spawn(async move {
            ctrl_bg
                .begin_browser_attachment("s-late", Some("item-1"))
                .await
        });
        tokio::task::yield_now().await;
        assert!(
            !begin.is_finished(),
            "attachment begin bypassed the move gate"
        );

        drop(guard);
        begin.await.expect("join").expect("begin attachment");
        let g = ctrl.inner.lock().expect("state");
        assert_eq!(
            g.sessions
                .get("s-late")
                .and_then(|session| session.attachment_phase.get("item-1")),
            Some(&AttachmentPhase::WritingBrowser)
        );
    }

    #[test]
    fn rebasing_updates_every_session_path_owner() {
        let ctrl = ConnectorController::new();
        ctrl.create_session("s4", Vec::new()).expect("session");
        ctrl.record_session_import("s4", "item-1", saved("s4", "papers/inbox/paper-1"), true)
            .expect("record import");
        ctrl.record_session_item_paper("s4", "alias", "papers/inbox/paper-1");

        ctrl.rebase_session_path("s4", "papers/inbox/paper-1", "papers/final/paper-1");

        let g = ctrl.inner.lock().expect("state");
        let session = g.sessions.get("s4").expect("saved session");
        assert_eq!(session.paper_paths, ["papers/final/paper-1"]);
        assert_eq!(
            session.item_map.get("item-1").map(String::as_str),
            Some("papers/final/paper-1")
        );
        assert_eq!(
            session.item_map.get("alias").map(String::as_str),
            Some("papers/final/paper-1")
        );
        assert_eq!(session.pending_saved[0].path, "papers/final/paper-1");
    }

    #[test]
    fn connector_does_not_start_parser_before_item_saved_handoff() {
        let parser_entrypoint = ["maybe_generate_paper_md_", "after_download"].concat();
        assert!(!include_str!("state.rs").contains(&parser_entrypoint));
        assert!(!include_str!("import.rs").contains(&parser_entrypoint));
        assert!(!include_str!("server.rs").contains(&parser_entrypoint));
    }
}
