//! Map Connector `saveItems` payloads into Vault papers (reuse lookup pipeline).

use super::state::ProgressItem;
use crate::core::error::AppError;
use crate::core::fs::WriteOpts;
use crate::features::catalog::papers;
use crate::features::catalog::papers::is_internal_tag_name;
use crate::features::connector::ConnectorController;
use crate::features::import::{
    enrich_remote_urls, ensure_paper_assets_with_cookies, map_zotero_item, normalize_parent_dir,
    paper_record_from_meta, write_paper_shell_opts, NoteShellMode, PaperMeta,
};
use crate::features::remote::import_bridge::{unique_remote_paper_path, upload_tree};
use crate::features::remote::{parse_remote_handle, RemoteSession};
use crate::features::translate::{free_mt_to_zh, looks_mostly_cjk};
use crate::features::zotero::ZOTERO_INTERNAL_TAG_PREFIX;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

#[derive(Debug, Clone)]
pub struct ConnectorImportResult {
    pub path: String,
    pub id: String,
    pub title: String,
    pub deduped: bool,
    pub connector_item_id: Value,
    pub item_type: String,
}

/// Resolve the configured NOTES shell mode from the controller's AppHandle
/// (settings `paperNoteMode`). Standard when no handle is attached yet.
fn note_mode_from_ctrl(ctrl: &ConnectorController) -> NoteShellMode {
    match ctrl.app_handle() {
        Some(app) => crate::features::import::note_mode_from_app(&app),
        None => NoteShellMode::Standard,
    }
}

pub async fn import_connector_item_with_cookies(
    ctrl: Arc<ConnectorController>,
    _session_id: &str,
    vault: &Path,
    parent_dir: &str,
    item: &Value,
    page_uri: Option<&str>,
    _cookies: Option<&str>,
) -> Result<ConnectorImportResult, AppError> {
    use crate::features::import::paper_import::{
        paper_commit, AssetsPolicy, CommitStatus, DedupePolicy, PaperCommitOptions,
    };

    let connector_item_id = item.get("id").cloned().unwrap_or(Value::Null);
    let item_type = item
        .get("itemType")
        .and_then(|v| v.as_str())
        .unwrap_or("journalArticle")
        .to_string();

    let meta = connector_paper_meta(item, page_uri)?;
    let abstract_text = meta.abstract_text.clone();

    // No abstract MT and no awaited downloads — the browser extension's HTTP
    // request must finish within ~15s, so assets stay Deferred.
    let app = ctrl.app_handle();
    let note_mode = note_mode_from_ctrl(&ctrl);
    let commit = paper_commit(
        meta,
        PaperCommitOptions {
            vault,
            parent_dir,
            dedupe: DedupePolicy::ByCatalogId,
            assets: AssetsPolicy::Deferred,
            translate_abstract: false,
            note_mode,
            fresh_timestamps: true,
            cache: None,
            app: app.as_ref(),
            defer_parse_jobs: false,
        },
    )
    .await?;

    if commit.status == CommitStatus::Deduped {
        return Ok(ConnectorImportResult {
            path: commit.path,
            id: commit.id,
            title: commit.title,
            deduped: true,
            connector_item_id,
            item_type,
        });
    }

    let paper_dir = PathBuf::from(&commit.paper_dir);

    // Translate the abstract to Chinese in the background (the synchronous shell
    // write above skips MT to stay within the Connector's 15s timeout). Guarded
    // by NOTES.md mtime so a user edit is never overwritten. Only the Standard
    // shell carries the machine-translatable `> {abstract}` blockquote; Custom
    // templates render the original abstract by contract, so never rewrite them
    // (title-only/blank shells have no abstract line at all).
    if note_mode == NoteShellMode::Standard {
        let created_at = fs::metadata(paper_dir.join("NOTES.md"))
            .and_then(|m| m.modified())
            .ok();
        if let Some(abstract_text) = abstract_text {
            let abs = abstract_text.trim().to_string();
            if !abs.is_empty() && !looks_mostly_cjk(&abs) {
                let notes_path = paper_dir.join("NOTES.md");
                tauri::async_runtime::spawn(async move {
                    translate_notes_abstract(notes_path, abs, created_at).await;
                });
            }
        }
    }

    Ok(ConnectorImportResult {
        path: commit.path,
        id: commit.id,
        title: commit.title,
        deduped: false,
        connector_item_id,
        item_type,
    })
}

/// Remote vault variant: stage the shell, upload it, and push the catalog.
pub async fn import_connector_item_remote_with_cookies(
    ctrl: Arc<ConnectorController>,
    _session_id: &str,
    session: Arc<RemoteSession>,
    parent_dir: &str,
    item: &Value,
    page_uri: Option<&str>,
    _cookies: Option<&str>,
) -> Result<ConnectorImportResult, AppError> {
    let note_mode = note_mode_from_ctrl(&ctrl);
    let parent_rel = normalize_parent_dir(parent_dir)?;
    let connector_item_id = item.get("id").cloned().unwrap_or(Value::Null);
    let item_type = item
        .get("itemType")
        .and_then(|v| v.as_str())
        .unwrap_or("journalArticle")
        .to_string();

    let mut meta = connector_paper_meta(item, page_uri)?;

    let id = meta.id.clone();
    if id.is_empty() {
        return Err(AppError::message("resolved metadata has empty id"));
    }

    if let Ok(Some(existing)) = papers::get_by_id(&session.work_root, &id) {
        return Ok(ConnectorImportResult {
            path: existing.path,
            id: existing.id,
            title: existing.title,
            deduped: true,
            connector_item_id,
            item_type,
        });
    }

    let (folder_id, path_rel) =
        unique_remote_paper_path(session.fs.as_ref(), &parent_rel, &id).await?;
    meta.id = folder_id.clone();
    let now = crate::core::time::now_rfc3339_millis();
    meta.added_at = now.clone();
    meta.updated_at = now;

    let staging = session.work_root.join(&path_rel);
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    fs::create_dir_all(&staging)?;
    write_paper_shell_opts(&staging, &session.work_root, &meta, note_mode, false).await?;
    let record = paper_record_from_meta(&path_rel, &meta);
    papers::upsert_paper(&session.work_root, &record)?;

    // Shell only first so Connector HTTP stays under timeout.
    upload_tree(session.fs.as_ref(), &staging, &path_rel).await?;
    {
        let mut cat = session.catalog.lock().await;
        cat.push(session.fs.clone()).await?;
    }

    Ok(ConnectorImportResult {
        path: path_rel,
        id: meta.id,
        title: meta.title,
        deduped: false,
        connector_item_id,
        item_type,
    })
}

/// Store a SingleFile HTML snapshot inside a paper unit.
pub async fn write_snapshot_html(
    vault: &Path,
    paper_rel: &str,
    html: &str,
) -> Result<String, AppError> {
    let rel = paper_rel.trim().trim_matches('/').replace('\\', "/");
    if rel.is_empty() {
        return Err(AppError::message("paper folder missing"));
    }
    let dir = vault.join(&rel);
    if !dir.is_dir() {
        return Err(AppError::message("paper folder missing"));
    }
    fs::write(dir.join("snapshot.html"), html.as_bytes())?;
    Ok(format!("{rel}/snapshot.html"))
}

pub async fn write_snapshot_html_remote(
    session: Arc<RemoteSession>,
    paper_rel: &str,
    html: &str,
) -> Result<String, AppError> {
    let rel = paper_rel.trim().trim_matches('/').replace('\\', "/");
    if rel.is_empty() || !session.fs.exists(&rel).await? {
        return Err(AppError::message("paper folder missing"));
    }
    let path = format!("{rel}/snapshot.html");
    session
        .fs
        .write(
            &path,
            html.as_bytes(),
            WriteOpts {
                create_parents: true,
            },
        )
        .await?;
    Ok(path)
}

/// Write a browser-uploaded PDF into a remote paper folder.
pub async fn write_attachment_pdf_remote(
    session: Arc<RemoteSession>,
    paper_rel: &str,
    bytes: &[u8],
) -> Result<String, AppError> {
    if bytes.len() < 4 || &bytes[..4] != b"%PDF" {
        return Err(AppError::message("uploaded attachment is not a PDF"));
    }
    let rel = paper_rel.trim().trim_matches('/').replace('\\', "/");
    if rel.is_empty() || !session.fs.exists(&rel).await? {
        return Err(AppError::message("paper folder missing"));
    }
    let id = rel.rsplit('/').next().unwrap_or("paper").to_string();
    let pdf_rel = format!("{rel}/{id}.pdf");
    session
        .fs
        .write(
            &pdf_rel,
            bytes,
            WriteOpts {
                create_parents: true,
            },
        )
        .await?;

    Ok(rel)
}

/// List org folders under remote `papers/` for the Connector collection picker.
pub async fn list_save_targets_remote(
    session: &RemoteSession,
) -> Vec<crate::features::connector::targets::SaveTarget> {
    use crate::features::connector::targets::SaveTarget;
    let mut out = vec![SaveTarget {
        id: "L1".into(),
        name: "papers".into(),
        level: 0,
    }];
    walk_remote_org(session, "papers", 1, &mut out).await;
    out
}

async fn walk_remote_org(
    session: &RemoteSession,
    rel: &str,
    level: u32,
    out: &mut Vec<crate::features::connector::targets::SaveTarget>,
) {
    if level > 12 {
        return;
    }
    let Ok(entries) = session.fs.list(rel).await else {
        return;
    };
    let mut dirs: Vec<String> = entries
        .into_iter()
        .filter(|e| e.is_dir && !e.name.starts_with('.'))
        .map(|e| e.name)
        .collect();
    dirs.sort_by_key(|a| a.to_lowercase());
    for name in dirs {
        let child = format!("{rel}/{name}");
        // Paper unit heuristic: NOTES.md / metadata.json / {stem}.pdf
        let is_paper = session
            .fs
            .exists(&format!("{child}/NOTES.md"))
            .await
            .unwrap_or(false)
            || session
                .fs
                .exists(&format!("{child}/metadata.json"))
                .await
                .unwrap_or(false)
            || session
                .fs
                .exists(&format!("{child}/{name}.pdf"))
                .await
                .unwrap_or(false);
        if is_paper {
            continue;
        }
        out.push(crate::features::connector::targets::SaveTarget {
            id: format!("D{child}"),
            name: name.clone(),
            level,
        });
        Box::pin(walk_remote_org(session, &child, level + 1, out)).await;
    }
}

/// Move a remote paper folder under a new org parent + catalog path rewrite.
pub async fn move_paper_folder_remote(
    session: &RemoteSession,
    from_rel: &str,
    dest_parent: &str,
) -> Result<String, AppError> {
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
    if !session.fs.exists(&from).await? {
        return Err(AppError::message(format!("paper folder missing: {from}")));
    }
    if session.fs.exists(&new_rel).await? {
        return Err(AppError::message(format!(
            "destination already exists: {new_rel}"
        )));
    }
    let _ = session.fs.mkdir(&dest_parent).await;
    session.fs.rename(&from, &new_rel).await?;
    let _ = papers::move_under_path(&session.work_root, &from, &new_rel);
    {
        let mut cat = session.catalog.lock().await;
        cat.push(session.fs.clone()).await?;
    }
    Ok(new_rel)
}

/// Map a connector item and apply connector-specific meta fixups: tag the
/// source, fall back to the captured page URI for source/html URLs, and prefer
/// a browser-captured PDF attachment URL when the translator gave none —
/// ACM/IEEE et al. often only expose the PDF through the page the user is on.
fn connector_paper_meta(item: &Value, page_uri: Option<&str>) -> Result<PaperMeta, AppError> {
    let mut meta = map_zotero_item(item)?;
    for tag in &mut meta.tags {
        if !tag.is_empty() && !is_internal_tag_name(tag) {
            *tag = format!("{ZOTERO_INTERNAL_TAG_PREFIX}{tag}");
        }
    }
    meta.meta_source = Some("zotero-connector".into());
    if meta.source_url.is_none() {
        if let Some(uri) = page_uri.filter(|s| !s.is_empty()) {
            meta.source_url = Some(uri.to_string());
        }
    }
    if meta.html_url.is_none() {
        meta.html_url = meta.source_url.clone();
    }
    enrich_remote_urls(&mut meta);
    if meta.pdf_url.as_deref().map(str::is_empty).unwrap_or(true) {
        meta.pdf_url = pdf_attachment_url(item);
    }
    Ok(meta)
}

/// First PDF attachment URL from a connector item (browser-captured PDF link).
fn pdf_attachment_url(item: &Value) -> Option<String> {
    let atts = item.get("attachments").and_then(|v| v.as_array())?;
    for a in atts {
        let mime = a
            .get("mimeType")
            .or_else(|| a.get("contentType"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let url = a.get("url").and_then(|v| v.as_str()).unwrap_or("").trim();
        if url.is_empty() {
            continue;
        }
        if mime.contains("pdf") || url.to_ascii_lowercase().ends_with(".pdf") {
            return Some(url.to_string());
        }
    }
    None
}

/// Decode Connector `title` values that may be RFC 2047 encoded
/// (`=?UTF-8?B?...?=` / `=?UTF-8?Q?...?=`). Falls back to the raw string.
fn decode_connector_title(raw: &str) -> String {
    let t = raw.trim();
    if t.is_empty() {
        return String::new();
    }
    // Simple single-token RFC 2047: =?charset?B|Q?text?=
    let Some(rest) = t.strip_prefix("=?") else {
        return t.to_string();
    };
    let Some(end) = rest.find("?=") else {
        return t.to_string();
    };
    let body = &rest[..end];
    let parts: Vec<&str> = body.splitn(3, '?').collect();
    if parts.len() != 3 {
        return t.to_string();
    }
    let charset = parts[0].to_ascii_lowercase();
    if charset != "utf-8" && charset != "utf8" {
        return t.to_string();
    }
    let encoding = parts[1].to_ascii_uppercase();
    let data = parts[2];
    match encoding.as_str() {
        "B" => {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD
                .decode(data.as_bytes())
                .ok()
                .and_then(|b| String::from_utf8(b).ok())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| t.to_string())
        }
        "Q" => {
            // Quoted-printable-ish: `_` → space, `=HH` hex.
            let mut out = Vec::new();
            let bytes = data.as_bytes();
            let mut i = 0;
            while i < bytes.len() {
                match bytes[i] {
                    b'_' => {
                        out.push(b' ');
                        i += 1;
                    }
                    b'=' if i + 2 < bytes.len() => {
                        let hex = &data[i + 1..i + 3];
                        if let Ok(v) = u8::from_str_radix(hex, 16) {
                            out.push(v);
                            i += 3;
                        } else {
                            out.push(bytes[i]);
                            i += 1;
                        }
                    }
                    b => {
                        out.push(b);
                        i += 1;
                    }
                }
            }
            String::from_utf8(out)
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| t.to_string())
        }
        _ => t.to_string(),
    }
}

/// Browser-uploaded **standalone** PDF (no parent bibliographic item).
/// Used when the user saves an open PDF tab via the Connector icon.
///
/// Creates a session + paper shell, writes `{id}.pdf`, and returns metadata for
/// the HTTP 201 body. Parsing is triggered only after `connector:item-saved`.
/// Official Zotero returns `{ canRecognize }`; we return `canRecognize: false`
/// because `/connector/getRecognizedItem` is not implemented yet.
pub async fn import_standalone_attachment(
    ctrl: Arc<ConnectorController>,
    session_id: &str,
    title: Option<&str>,
    url: Option<&str>,
    bytes: &[u8],
) -> Result<ConnectorImportResult, AppError> {
    if bytes.len() < 4 || &bytes[..4] != b"%PDF" {
        return Err(AppError::message("uploaded attachment is not a PDF"));
    }

    let (vault_handle, parent_dir) = ctrl.vault_handle_and_parent()?;
    let parent_dir = {
        // Prefer session parent if the session was already opened (e.g. re-save).
        let session_parent = ctrl.session_parent_dir(session_id);
        if session_parent.is_empty() {
            parent_dir
        } else {
            session_parent
        }
    };

    let title_raw = title.map(str::trim).filter(|s| !s.is_empty());
    let title = title_raw
        .map(decode_connector_title)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            url.and_then(|u| {
                Path::new(u)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .map(|s| s.replace('%', " "))
            })
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "PDF".into());
    let base_id = crate::features::import::slug_from_stem(&title);
    let mut meta = crate::features::import::local_pdf_meta_for_import(base_id, title.clone());
    meta.meta_source = Some("zotero-connector".into());
    if let Some(u) = url.map(str::trim).filter(|s| !s.is_empty()) {
        meta.source_url = Some(u.to_string());
        meta.pdf_url = Some(u.to_string());
    }

    // Session must exist for later updateSession / progress; create if new.
    let progress_item = ProgressItem {
        id: Value::String(url.unwrap_or("standalone").to_string()),
        title: title.clone(),
        item_type: "attachment".into(),
        attachments: Vec::new(),
    };
    match ctrl.create_session(session_id, vec![progress_item]) {
        Ok(()) => {}
        Err(e) if e.to_string().contains("SESSION_EXISTS") => {
            // Official rejects SESSION_EXISTS; allow reuse so a retry after a
            // partial failure can still land the PDF.
        }
        Err(e) => return Err(e),
    }

    let result = if let Some(sid) = parse_remote_handle(&vault_handle) {
        let reg = ctrl
            .remote_registry()
            .ok_or_else(|| AppError::message("remote registry unavailable"))?;
        let session = reg.get(sid).await?;
        import_standalone_remote(
            session,
            &parent_dir,
            meta,
            bytes,
            note_mode_from_ctrl(&ctrl),
        )
        .await?
    } else {
        import_standalone_local(
            Path::new(&vault_handle),
            &parent_dir,
            meta,
            bytes,
            ctrl.app_handle().as_ref(),
            note_mode_from_ctrl(&ctrl),
        )
        .await?
    };

    let item_key = url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&result.id);
    let saved = crate::features::connector::ConnectorItemSaved {
        path: result.path.clone(),
        id: result.id.clone(),
        title: result.title.clone(),
        deduped: result.deduped,
        session_id: session_id.to_string(),
    };
    ctrl.record_session_import(session_id, item_key, saved.clone(), false)?;
    // Official standalone saves may address the item by URL or resolved id.
    if let Some(u) = url.map(str::trim).filter(|value| !value.is_empty()) {
        ctrl.record_session_item_paper(session_id, u, &result.path);
    }
    ctrl.record_session_item_paper(session_id, &result.id, &result.path);
    ctrl.mark_session_done(session_id);
    if result.deduped {
        ctrl.emit_item_saved(saved);
    } else {
        ctrl.finalize_session_if_ready(session_id).await?;
    }
    Ok(result)
}

async fn import_standalone_local(
    vault: &Path,
    parent_dir: &str,
    meta: PaperMeta,
    bytes: &[u8],
    app: Option<&tauri::AppHandle>,
    note_mode: NoteShellMode,
) -> Result<ConnectorImportResult, AppError> {
    use crate::features::import::paper_import::{
        paper_commit, AssetsPolicy, CommitStatus, DedupePolicy, PaperCommitOptions,
    };

    // Keep commit deferred; parser jobs are requested after connector:item-saved.
    let title = meta.title.clone();
    let commit = paper_commit(
        meta,
        PaperCommitOptions {
            vault,
            parent_dir,
            dedupe: DedupePolicy::None,
            assets: AssetsPolicy::Deferred,
            translate_abstract: false,
            note_mode,
            fresh_timestamps: true,
            cache: None,
            app,
            defer_parse_jobs: false,
        },
    )
    .await?;
    if commit.status == CommitStatus::Deduped {
        return Ok(ConnectorImportResult {
            path: commit.path,
            id: commit.id,
            title: commit.title,
            deduped: true,
            connector_item_id: Value::Null,
            item_type: "attachment".into(),
        });
    }

    let paper_dir = PathBuf::from(&commit.paper_dir);
    fs::write(paper_dir.join(format!("{}.pdf", commit.id)), bytes)?;

    Ok(ConnectorImportResult {
        path: commit.path,
        id: commit.id,
        title,
        deduped: false,
        connector_item_id: Value::Null,
        item_type: "attachment".into(),
    })
}

async fn import_standalone_remote(
    session: Arc<RemoteSession>,
    parent_dir: &str,
    mut meta: PaperMeta,
    bytes: &[u8],
    note_mode: NoteShellMode,
) -> Result<ConnectorImportResult, AppError> {
    let parent_rel = normalize_parent_dir(parent_dir)?;
    let id = meta.id.clone();
    if id.is_empty() {
        return Err(AppError::message("resolved metadata has empty id"));
    }
    if let Ok(Some(existing)) = papers::get_by_id(&session.work_root, &id) {
        return Ok(ConnectorImportResult {
            path: existing.path,
            id: existing.id,
            title: existing.title,
            deduped: true,
            connector_item_id: Value::Null,
            item_type: "attachment".into(),
        });
    }

    let (folder_id, path_rel) =
        unique_remote_paper_path(session.fs.as_ref(), &parent_rel, &id).await?;
    meta.id = folder_id.clone();
    let now = crate::core::time::now_rfc3339_millis();
    meta.added_at = now.clone();
    meta.updated_at = now;
    let title = meta.title.clone();

    let staging = session.work_root.join(&path_rel);
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    fs::create_dir_all(&staging)?;
    fs::write(staging.join(format!("{folder_id}.pdf")), bytes)?;
    write_paper_shell_opts(&staging, &session.work_root, &meta, note_mode, false).await?;
    let record = paper_record_from_meta(&path_rel, &meta);
    papers::upsert_paper(&session.work_root, &record)?;
    upload_tree(session.fs.as_ref(), &staging, &path_rel).await?;
    {
        let mut cat = session.catalog.lock().await;
        cat.push(session.fs.clone()).await?;
    }

    Ok(ConnectorImportResult {
        path: path_rel,
        id: meta.id,
        title,
        deduped: false,
        connector_item_id: Value::Null,
        item_type: "attachment".into(),
    })
}

/// Whether an OA/crossref resolver might still obtain a PDF for this session item.
/// True when the paper has a DOI or arXiv id and no local PDF yet.
pub async fn session_has_attachment_resolvers(
    ctrl: &ConnectorController,
    session_id: &str,
    item_id: &str,
) -> Result<bool, AppError> {
    let paper_rel = match ctrl.session_item_paper_exact(session_id, item_id)? {
        Some(p) => p,
        // Session exists but this item was not mapped (or already deduped without record).
        None => return Ok(false),
    };
    let (doi, arxiv, has_pdf) = paper_resolver_hints(ctrl, &paper_rel).await?;
    Ok((doi.is_some() || arxiv.is_some()) && !has_pdf)
}

/// Download an OA/Crossref PDF into the paper for a session item (resolver path).
/// Returns a display title for the attachment (plain text body of HTTP 201).
pub async fn save_attachment_from_resolver(
    ctrl: Arc<ConnectorController>,
    session_id: &str,
    item_id: &str,
) -> Result<String, AppError> {
    let paper_rel = ctrl
        .session_item_paper_exact(session_id, item_id)?
        .ok_or_else(|| AppError::message("SESSION_NOT_FOUND"))?;

    let (vault_handle, _) = ctrl.vault_handle_and_parent()?;
    let (doi, arxiv, has_pdf) = paper_resolver_hints(ctrl.as_ref(), &paper_rel).await?;
    if has_pdf {
        return Ok("Full Text PDF".into());
    }
    if doi.is_none() && arxiv.is_none() {
        return Err(AppError::message("Failed to save an attachment"));
    }

    let id = paper_rel.rsplit('/').next().unwrap_or("paper").to_string();

    if let Some(sid) = parse_remote_handle(&vault_handle) {
        let reg = ctrl
            .remote_registry()
            .ok_or_else(|| AppError::message("remote registry unavailable"))?;
        let session = reg.get(sid).await?;
        let paper_dir = session.work_root.join(&paper_rel);
        fs::create_dir_all(&paper_dir)?;
        let assets = ensure_paper_assets_with_cookies(
            &paper_dir,
            &id,
            arxiv.as_deref(),
            None,
            doi.as_deref(),
            None,
        )
        .await?;
        if !assets.pdf && !crate::features::import::has_local_pdf(&paper_dir) {
            return Err(AppError::message("Failed to save an attachment"));
        }
        upload_tree(session.fs.as_ref(), &paper_dir, &paper_rel).await?;
        {
            let mut cat = session.catalog.lock().await;
            cat.push(session.fs.clone()).await?;
        }
        return Ok("Full Text PDF".into());
    }

    let vault = PathBuf::from(&vault_handle);
    let paper_dir = vault.join(&paper_rel);
    if !paper_dir.is_dir() {
        return Err(AppError::message("paper folder missing"));
    }
    let assets = ensure_paper_assets_with_cookies(
        &paper_dir,
        &id,
        arxiv.as_deref(),
        None,
        doi.as_deref(),
        None,
    )
    .await?;
    if !assets.pdf && !crate::features::import::has_local_pdf(&paper_dir) {
        return Err(AppError::message("Failed to save an attachment"));
    }
    Ok("Full Text PDF".into())
}

/// DOI / arXiv / local-PDF presence for resolver decisions.
async fn paper_resolver_hints(
    ctrl: &ConnectorController,
    paper_rel: &str,
) -> Result<(Option<String>, Option<String>, bool), AppError> {
    let handle = {
        let (h, _) = ctrl.vault_handle_and_parent()?;
        h
    };
    if let Some(sid) = parse_remote_handle(&handle) {
        let reg = ctrl
            .remote_registry()
            .ok_or_else(|| AppError::message("remote registry unavailable"))?;
        let session = reg.get(sid).await?;
        let row = papers::get_by_path(&session.work_root, paper_rel)?;
        let doi = row
            .as_ref()
            .and_then(|r| r.doi.clone())
            .filter(|s| !s.is_empty());
        let arxiv = row
            .as_ref()
            .and_then(|r| r.arxiv_id.clone())
            .filter(|s| !s.is_empty());
        let has_pdf = crate::features::import::has_local_pdf(&session.work_root.join(paper_rel))
            || session
                .fs
                .list(paper_rel)
                .await
                .ok()
                .map(|entries| {
                    entries.iter().any(|e| {
                        !e.is_dir
                            && e.name
                                .rsplit('.')
                                .next()
                                .map(|ext| ext.eq_ignore_ascii_case("pdf"))
                                .unwrap_or(false)
                    })
                })
                .unwrap_or(false);
        return Ok((doi, arxiv, has_pdf));
    }
    let vault = PathBuf::from(&handle);
    let row = papers::get_by_path(&vault, paper_rel)?;
    let doi = row
        .as_ref()
        .and_then(|r| r.doi.clone())
        .filter(|s| !s.is_empty());
    let arxiv = row
        .as_ref()
        .and_then(|r| r.arxiv_id.clone())
        .filter(|s| !s.is_empty());
    let has_pdf = crate::features::import::has_local_pdf(&vault.join(paper_rel));
    Ok((doi, arxiv, has_pdf))
}

/// Translate the abstract to Chinese and replace the leading `> ` blockquote in
/// NOTES.md. Skips when the file was edited after `created` (mtime guard) or the
/// blockquote was already changed, so user notes are never overwritten.
async fn translate_notes_abstract(
    notes_path: PathBuf,
    abstract_text: String,
    created: Option<SystemTime>,
) {
    // User edited the note after the shell was written → leave it alone.
    if let (Some(created), Ok(meta)) = (created, fs::metadata(&notes_path)) {
        if meta.modified().map(|m| m > created).unwrap_or(false) {
            return;
        }
    }

    let Some(translated) = free_mt_to_zh(&abstract_text).await else {
        return;
    };

    let Ok(content) = fs::read_to_string(&notes_path) else {
        return;
    };
    let original_q = format!("> {}", abstract_text.trim());
    let translated_q = format!("> {translated}");
    // Only swap the still-untouched abstract blockquote.
    if !content.contains(&original_q) || content.contains(&translated_q) {
        return;
    }
    let mut out = Vec::new();
    let mut replaced = false;
    for line in content.lines() {
        if !replaced && line.trim() == original_q.trim() {
            out.push(translated_q.clone());
            replaced = true;
        } else {
            out.push(line.to_string());
        }
    }
    if replaced {
        let _ = fs::write(&notes_path, out.join("\n"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn decode_connector_title_plain() {
        assert_eq!(decode_connector_title("Hello"), "Hello");
        assert_eq!(decode_connector_title("  spaced  "), "spaced");
    }

    #[test]
    fn decode_connector_title_rfc2047_b() {
        // "Attention" base64
        let enc = "=?UTF-8?B?QXR0ZW50aW9u?=";
        assert_eq!(decode_connector_title(enc), "Attention");
    }

    #[test]
    fn map_sample_arxiv_item() {
        let item = json!({
            "itemType": "preprint",
            "title": "Attention Is All You Need",
            "creators": [
                {"creatorType": "author", "firstName": "Ashish", "lastName": "Vaswani"}
            ],
            "url": "https://arxiv.org/abs/1706.03762",
            "DOI": "10.48550/arXiv.1706.03762",
            "abstractNote": "The dominant sequence transduction models…",
            "attachments": [{
                "title": "PDF",
                "mimeType": "application/pdf",
                "url": "https://arxiv.org/pdf/1706.03762"
            }],
            "tags": [{"tag": "survey"}, {"tag": "machine learning"}]
        });
        let meta = connector_paper_meta(&item, None).expect("map");
        assert!(meta.arxiv_id.is_some() || meta.doi.is_some());
        assert!(!meta.title.is_empty());
        assert_eq!(
            meta.tags,
            vec![
                "@zotero:survey".to_string(),
                "@zotero:machine learning".to_string()
            ]
        );
    }

    #[test]
    fn arxiv_category_tags_stay_arxiv_internal() {
        let item = json!({
            "itemType": "preprint",
            "title": "Attention Is All You Need",
            "url": "https://arxiv.org/abs/1706.03762",
            "tags": [
                {"tag": "Computer Science - Machine Learning"},
                {"tag": "survey"}
            ]
        });
        let meta = connector_paper_meta(&item, None).expect("map");
        assert_eq!(
            meta.tags,
            vec![
                "@arxiv:Computer Science - Machine Learning".to_string(),
                "@zotero:survey".to_string()
            ]
        );
    }
}
