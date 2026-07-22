//! Process-wide connector server state and lifecycle.

use super::server;
use crate::error::AppError;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
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

pub(super) struct Inner {
    pub(super) enabled: bool,
    pub(super) listening: bool,
    pub(super) port: u16,
    pub(super) last_error: Option<String>,
    /// Local absolute path or `remote:<sessionId>` handle.
    pub(super) vault_handle: Option<String>,
    pub(super) parent_dir: String,
    /// Cancels the accept loop when the server should stop.
    pub(super) shutdown_tx: Option<oneshot::Sender<()>>,
    pub(super) sessions: HashMap<String, SaveSession>,
    pub(super) app: Option<AppHandle>,
}

/// Shared controller managed by Tauri (`app.manage`).
pub struct ConnectorController {
    pub(super) inner: Mutex<Inner>,
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

    pub(super) fn gc_sessions_locked(&self, g: &mut Inner) {
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
