//! Save-session tracking, attachment uploads, and collection-target moves
//! for the connector controller. Split from `state.rs`.

use super::state::*;
use crate::error::AppError;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

impl ConnectorController {
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
