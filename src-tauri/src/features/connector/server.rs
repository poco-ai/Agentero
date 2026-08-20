//! Minimal axum HTTP server compatible with Zotero Connector endpoints.

use super::import::{
    import_connector_item_remote_with_cookies, import_connector_item_with_cookies,
    import_standalone_attachment, save_attachment_from_resolver, session_has_attachment_resolvers,
    write_snapshot_html, write_snapshot_html_remote,
};
use super::state::{ConnectorController, ConnectorItemSaved, ProgressAttachment, ProgressItem};
use crate::core::error::AppError;
use crate::features::remote::parse_remote_handle;
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

/// Max uploaded attachment (browser PDF). axum's default 2 MiB is too small.
const MAX_ATTACHMENT_BYTES: usize = 200 * 1024 * 1024;

#[derive(Clone)]
struct AppState {
    ctrl: Arc<ConnectorController>,
}

pub async fn serve(
    listener: TcpListener,
    shutdown_rx: oneshot::Receiver<()>,
    ctrl: Arc<ConnectorController>,
) -> Result<(), AppError> {
    let state = AppState { ctrl };
    let app = Router::new()
        .route("/connector/ping", get(ping_get).post(ping_post))
        .route("/connector/saveItems", post(save_items))
        .route("/connector/saveSnapshot", post(save_snapshot))
        .route("/connector/saveSingleFile", post(save_single_file))
        .route(
            "/connector/saveAttachment",
            post(save_attachment).layer(DefaultBodyLimit::max(MAX_ATTACHMENT_BYTES)),
        )
        .route(
            "/connector/saveStandaloneAttachment",
            post(save_standalone_attachment).layer(DefaultBodyLimit::max(MAX_ATTACHMENT_BYTES)),
        )
        .route(
            "/connector/hasAttachmentResolvers",
            post(has_attachment_resolvers),
        )
        .route(
            "/connector/saveAttachmentFromResolver",
            post(save_attachment_from_resolver_handler),
        )
        .route("/connector/sessionProgress", post(session_progress))
        .route("/connector/attachmentProgress", post(attachment_progress))
        .route("/connector/detect", post(detect))
        .route("/connector/savePage", post(save_page))
        .route("/connector/selectItems", post(select_items))
        .route("/connector/getTranslators", post(get_translators))
        .route("/connector/proxies", post(proxies))
        .route(
            "/connector/getSelectedCollection",
            post(get_selected_collection),
        )
        .route("/connector/updateSession", post(update_session))
        .route("/connector/delaySync", post(delay_sync))
        .fallback(fallback)
        .with_state(state);

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        })
        .await
        .map_err(|e| AppError::message(format!("connector server: {e}")))
}

async fn fallback() -> Response {
    text_response(StatusCode::NOT_FOUND, "text/plain", "No endpoint found\n")
}

/// Normalize a Connector item `id` (string or number) to the map key used in sessions.
fn connector_item_key(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn text_response(status: StatusCode, content_type: &str, body: &str) -> Response {
    let mut res = Response::new(Body::from(body.to_string()));
    *res.status_mut() = status;
    if let Ok(v) = HeaderValue::from_str(content_type) {
        res.headers_mut().insert(header::CONTENT_TYPE, v);
    }
    add_zotero_headers(res.headers_mut());
    res
}

fn json_response(status: StatusCode, value: Value) -> Response {
    let body = value.to_string();
    let mut res = Response::new(Body::from(body));
    *res.status_mut() = status;
    res.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    add_zotero_headers(res.headers_mut());
    res
}

fn add_zotero_headers(headers: &mut HeaderMap) {
    for (k, v) in ConnectorController::response_headers() {
        if let (Ok(name), Ok(val)) = (header::HeaderName::try_from(k), HeaderValue::from_str(v)) {
            headers.insert(name, val);
        }
    }
}

/// Host must be localhost / 127.0.0.1 (DNS rebinding protection).
/// Returns `Some(response)` when the request must be rejected.
fn check_host(headers: &HeaderMap) -> Option<Response> {
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let host_only = host.split(':').next().unwrap_or(host);
    if host_only.eq_ignore_ascii_case("localhost") || host_only == "127.0.0.1" {
        None
    } else {
        Some(text_response(
            StatusCode::BAD_REQUEST,
            "text/plain",
            "Invalid Host header\n",
        ))
    }
}

/// Reject browser simple-requests without connector API version header.
fn check_browser_guard(headers: &HeaderMap, method: &Method) -> Option<Response> {
    if method == Method::GET || method == Method::HEAD || method == Method::OPTIONS {
        return None;
    }
    let has_api = headers.get("x-zotero-connector-api-version").is_some()
        || headers.get("zotero-allowed-request").is_some();
    if has_api {
        return None;
    }

    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let is_browser = ua.starts_with("Mozilla/") || headers.contains_key(header::ORIGIN);
    if !is_browser {
        return None;
    }

    let ct = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    // application/json triggers CORS preflight; simple content types are blocked.
    let simple = matches!(
        ct.as_str(),
        "application/x-www-form-urlencoded" | "multipart/form-data" | "text/plain" | ""
    );
    if simple {
        return Some(text_response(
            StatusCode::FORBIDDEN,
            "text/plain",
            "Request not allowed\n",
        ));
    }
    None
}

fn guard(headers: &HeaderMap, method: &Method) -> Option<Response> {
    check_host(headers).or_else(|| check_browser_guard(headers, method))
}

async fn ping_get(headers: HeaderMap) -> Response {
    if let Some(r) = check_host(&headers) {
        return r;
    }
    text_response(
        StatusCode::OK,
        "text/html",
        "<!DOCTYPE html><html><head>\
         <title>Zotero Connector Server is Available</title></head>\
         <body>Zotero Connector Server is Available</body></html>",
    )
}

async fn ping_post(headers: HeaderMap) -> Response {
    if let Some(r) = check_host(&headers) {
        return r;
    }
    json_response(
        StatusCode::OK,
        json!({
            "prefs": {
                "automaticSnapshots": false,
                "downloadAssociatedFiles": true,
                "supportsAttachmentUpload": true,
                "supportsTagsAutocomplete": false,
                "canUserAddNote": false,
                "reportActiveURL": false
            }
        }),
    )
}

#[derive(Debug, Deserialize)]
struct SaveItemsBody {
    /// Official Connector uses `sessionID` (capital ID).
    #[serde(default, alias = "sessionId", rename = "sessionID")]
    session_id: Option<String>,
    #[serde(default)]
    items: Vec<Value>,
    #[serde(default)]
    uri: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default, alias = "detailedCookies")]
    detailed_cookies: Option<String>,
}

async fn save_items(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SaveItemsBody>,
) -> Response {
    if let Some(r) = guard(&headers, &Method::POST) {
        return r;
    }

    let session_id = body
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("sess-{}", uuid::Uuid::new_v4()));

    let page_uri = body
        .uri
        .as_deref()
        .or(body.url.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty());

    if body.items.is_empty() {
        return json_response(StatusCode::BAD_REQUEST, json!({ "error": "NO_ITEMS" }));
    }

    let (vault_handle, _) = match state.ctrl.vault_handle_and_parent() {
        Ok(v) => v,
        Err(e) => {
            state.ctrl.emit_error(&e.to_string(), Some(&session_id));
            return json_response(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({ "error": e.to_string() }),
            );
        }
    };

    // Pre-register session skeleton so SESSION_EXISTS works for concurrent saves.
    let mut progress_items: Vec<ProgressItem> = Vec::new();
    for (idx, item) in body.items.iter().enumerate() {
        let id = item
            .get("id")
            .cloned()
            .unwrap_or_else(|| Value::from(idx as i64 + 1));
        let title = item
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("Untitled")
            .to_string();
        let item_type = item
            .get("itemType")
            .and_then(|v| v.as_str())
            .unwrap_or("journalArticle")
            .to_string();
        let mut attachments = Vec::new();
        if let Some(atts) = item.get("attachments").and_then(|v| v.as_array()) {
            for (ai, a) in atts.iter().enumerate() {
                attachments.push(ProgressAttachment {
                    id: format!("{ai}"),
                    title: a
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Attachment")
                        .to_string(),
                    content_type: a
                        .get("mimeType")
                        .or_else(|| a.get("contentType"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("application/pdf")
                        .to_string(),
                    progress: 0,
                });
            }
        }
        progress_items.push(ProgressItem {
            id,
            title,
            item_type,
            attachments,
        });
    }

    if let Err(e) = state
        .ctrl
        .create_session(&session_id, progress_items.clone())
    {
        if e.to_string().contains("SESSION_EXISTS") {
            return json_response(StatusCode::CONFLICT, json!({ "error": "SESSION_EXISTS" }));
        }
        return json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": e.to_string() }),
        );
    }

    // Session inherits controller parent_dir (last picker choice / default papers).
    let parent_dir = state.ctrl.session_parent_dir(&session_id);

    let mut out_items: Vec<Value> = Vec::new();
    for item in &body.items {
        let import_result = if let Some(sid) = parse_remote_handle(&vault_handle) {
            let reg = match state.ctrl.remote_registry() {
                Some(r) => r,
                None => {
                    let msg = "remote registry unavailable — restart Agentero after updating";
                    state.ctrl.emit_error(msg, Some(&session_id));
                    state.ctrl.mark_session_done(&session_id);
                    return json_response(StatusCode::SERVICE_UNAVAILABLE, json!({ "error": msg }));
                }
            };
            match reg.get(sid).await {
                Ok(session) => {
                    import_connector_item_remote_with_cookies(
                        state.ctrl.clone(),
                        &session_id,
                        session,
                        &parent_dir,
                        item,
                        page_uri,
                        body.detailed_cookies.as_deref(),
                    )
                    .await
                }
                Err(e) => {
                    // Session handle stale (e.g. reconnected remote without rebinding Connector).
                    Err(AppError::message(format!(
                        "remote vault session expired ({e}); reconnect the remote vault in Agentero, then save again"
                    )))
                }
            }
        } else {
            import_connector_item_with_cookies(
                state.ctrl.clone(),
                &session_id,
                std::path::Path::new(&vault_handle),
                &parent_dir,
                item,
                page_uri,
                body.detailed_cookies.as_deref(),
            )
            .await
        };

        match import_result {
            Ok(r) => {
                let item_key = connector_item_key(&r.connector_item_id);
                let saved = ConnectorItemSaved {
                    path: r.path.clone(),
                    id: r.id.clone(),
                    title: r.title.clone(),
                    deduped: r.deduped,
                    session_id: session_id.clone(),
                };
                if let Err(error) =
                    state
                        .ctrl
                        .record_session_import(&session_id, &item_key, saved.clone(), true)
                {
                    state.ctrl.emit_error(&error.to_string(), Some(&session_id));
                    state.ctrl.mark_session_done(&session_id);
                    return json_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        json!({ "error": error.to_string() }),
                    );
                }
                if r.deduped {
                    state.ctrl.emit_item_saved(saved);
                }
                let mut atts = Vec::new();
                if let Some(arr) = item.get("attachments").and_then(|v| v.as_array()) {
                    for (ai, a) in arr.iter().enumerate() {
                        atts.push(json!({
                            "id": format!("{session_id}_{ai}"),
                            "title": a.get("title").and_then(|v| v.as_str()).unwrap_or("Attachment"),
                            "contentType": a.get("mimeType").and_then(|v| v.as_str()).unwrap_or("application/pdf"),
                            "mimeType": a.get("mimeType").and_then(|v| v.as_str()).unwrap_or("application/pdf"),
                        }));
                    }
                }
                out_items.push(json!({
                    "id": r.connector_item_id,
                    "title": r.title,
                    "itemType": r.item_type,
                    "attachments": atts,
                }));
            }
            Err(e) => {
                state.ctrl.emit_error(&e.to_string(), Some(&session_id));
                state.ctrl.mark_session_done(&session_id);
                return json_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    json!({ "error": e.to_string() }),
                );
            }
        }
    }

    state.ctrl.mark_session_done(&session_id);

    json_response(
        StatusCode::CREATED,
        json!({
            "items": out_items,
            "singleFile": false
        }),
    )
}

#[derive(Debug, Deserialize)]
struct SessionIdBody {
    #[serde(default, alias = "sessionId", rename = "sessionID")]
    session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SnapshotBody {
    #[serde(default, alias = "sessionId", rename = "sessionID")]
    session_id: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    uri: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    title: Option<String>,
    #[serde(default)]
    html: Option<String>,
    #[serde(default, alias = "detailedCookies")]
    detailed_cookies: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SingleFileBody {
    #[serde(default, alias = "sessionId", rename = "sessionID")]
    session_id: Option<String>,
    #[serde(default)]
    url: Option<String>,
    /// Sent by the official Connector; unused today (paper already created in session).
    #[serde(default)]
    #[allow(dead_code)]
    title: Option<String>,
    #[serde(default, rename = "snapshotContent")]
    snapshot_content: Option<String>,
}

fn request_session_id(value: &Option<String>) -> Result<String, Box<Response>> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            json_response(
                StatusCode::BAD_REQUEST,
                json!({ "error": "SESSION_ID_NOT_PROVIDED" }),
            )
            .into()
        })
}

async fn save_snapshot(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SnapshotBody>,
) -> Response {
    if let Some(r) = guard(&headers, &Method::POST) {
        return r;
    }
    let session_id = match request_session_id(&body.session_id) {
        Ok(id) => id,
        Err(r) => return *r,
    };
    let url = body
        .url
        .as_deref()
        .or(body.uri.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("about:blank");
    let item = json!({
        "id": format!("snapshot-{}", uuid::Uuid::new_v4()),
        "itemType": "webpage",
        "title": body.title.as_deref().filter(|s| !s.trim().is_empty()).unwrap_or(url),
        "url": url,
        "accessDate": chrono::Utc::now().to_rfc3339(),
        "attachments": []
    });
    let (handle, _) = match state.ctrl.vault_handle_and_parent() {
        Ok(v) => v,
        Err(e) => {
            return json_response(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({ "error": e.to_string() }),
            )
        }
    };
    if let Err(e) = state.ctrl.create_session(
        &session_id,
        vec![ProgressItem {
            id: item["id"].clone(),
            title: item["title"].as_str().unwrap_or("Web page").to_string(),
            item_type: "webpage".into(),
            attachments: Vec::new(),
        }],
    ) {
        return json_response(StatusCode::CONFLICT, json!({ "error": e.to_string() }));
    }
    let parent = state.ctrl.session_parent_dir(&session_id);
    let result = if let Some(sid) = parse_remote_handle(&handle) {
        let Some(reg) = state.ctrl.remote_registry() else {
            return json_response(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({ "error": "remote registry unavailable" }),
            );
        };
        match reg.get(sid).await {
            Ok(session) => {
                import_connector_item_remote_with_cookies(
                    state.ctrl.clone(),
                    &session_id,
                    session,
                    &parent,
                    &item,
                    Some(url),
                    body.detailed_cookies.as_deref(),
                )
                .await
            }
            Err(e) => Err(AppError::message(e.to_string())),
        }
    } else {
        import_connector_item_with_cookies(
            state.ctrl.clone(),
            &session_id,
            std::path::Path::new(&handle),
            &parent,
            &item,
            Some(url),
            body.detailed_cookies.as_deref(),
        )
        .await
    };
    let result = match result {
        Ok(result) => result,
        Err(e) => {
            state.ctrl.mark_session_done(&session_id);
            return json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": e.to_string() }),
            );
        }
    };
    if let Some(html) = body.html.as_deref().filter(|s| !s.is_empty()) {
        let write_result = if let Some(sid) = parse_remote_handle(&handle) {
            match state.ctrl.remote_registry() {
                Some(reg) => match reg.get(sid).await {
                    Ok(session) => write_snapshot_html_remote(session, &result.path, html).await,
                    Err(e) => Err(AppError::message(e.to_string())),
                },
                None => Err(AppError::message("remote registry unavailable")),
            }
        } else {
            write_snapshot_html(std::path::Path::new(&handle), &result.path, html).await
        };
        if let Err(e) = write_result {
            state.ctrl.emit_error(&e.to_string(), Some(&session_id));
        }
    }
    state.ctrl.mark_session_done(&session_id);
    let saved = ConnectorItemSaved {
        path: result.path.clone(),
        id: result.id.clone(),
        title: result.title.clone(),
        deduped: result.deduped,
        session_id: session_id.clone(),
    };
    if let Err(error) = state.ctrl.record_session_import(
        &session_id,
        &connector_item_key(&item["id"]),
        saved.clone(),
        false,
    ) {
        return json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": error.to_string() }),
        );
    }
    if result.deduped {
        state.ctrl.emit_item_saved(saved);
    } else if let Err(error) = state.ctrl.finalize_session_if_ready(&session_id).await {
        return json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": error.to_string() }),
        );
    }
    json_response(StatusCode::CREATED, json!({ "singleFile": false }))
}

async fn save_single_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SingleFileBody>,
) -> Response {
    if let Some(r) = guard(&headers, &Method::POST) {
        return r;
    }
    let session_id = match request_session_id(&body.session_id) {
        Ok(id) => id,
        Err(r) => return *r,
    };
    let Some(html) = body.snapshot_content.as_deref() else {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "SNAPSHOT_NOT_PROVIDED" }),
        );
    };
    let (handle, _) = match state.ctrl.vault_handle_and_parent() {
        Ok(v) => v,
        Err(e) => {
            return json_response(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({ "error": e.to_string() }),
            )
        }
    };
    let Some(path) = state
        .ctrl
        .session_item_paper(&session_id, body.url.as_deref())
    else {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "SESSION_NOT_FOUND" }),
        );
    };
    let result = if let Some(sid) = parse_remote_handle(&handle) {
        let Some(reg) = state.ctrl.remote_registry() else {
            return json_response(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({ "error": "remote registry unavailable" }),
            );
        };
        match reg.get(sid).await {
            Ok(session) => write_snapshot_html_remote(session, &path, html).await,
            Err(e) => Err(AppError::message(e.to_string())),
        }
    } else {
        write_snapshot_html(std::path::Path::new(&handle), &path, html).await
    };
    match result {
        Ok(snapshot_path) => {
            state.ctrl.mark_session_done(&session_id);
            json_response(StatusCode::CREATED, json!({ "path": snapshot_path }))
        }
        Err(e) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": e.to_string() }),
        ),
    }
}

async fn session_progress(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SessionIdBody>,
) -> Response {
    if let Some(r) = guard(&headers, &Method::POST) {
        return r;
    }
    let Some(sid) = body
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "SESSION_ID_NOT_PROVIDED" }),
        );
    };
    match state.ctrl.session_progress_json(sid) {
        Ok(v) => json_response(StatusCode::OK, v),
        Err(_) => json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "SESSION_NOT_FOUND" }),
        ),
    }
}

async fn get_selected_collection(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(r) = guard(&headers, &Method::POST) {
        return r;
    }
    json_response(StatusCode::OK, state.ctrl.selected_collection_json().await)
}

#[derive(Debug, Deserialize)]
struct UpdateSessionBody {
    #[serde(default, alias = "sessionId", rename = "sessionID")]
    session_id: Option<String>,
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    tags: Option<Value>,
}

async fn update_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<UpdateSessionBody>,
) -> Response {
    if let Some(r) = guard(&headers, &Method::POST) {
        return r;
    }
    let Some(sid) = body
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "SESSION_ID_NOT_PROVIDED" }),
        );
    };
    if let Some(tags) = body.tags.as_ref() {
        let parsed: Vec<String> = match tags {
            Value::String(s) => s
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect(),
            Value::Array(values) => values
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect(),
            _ => Vec::new(),
        };
        if let Err(e) = state.ctrl.update_session_tags(sid, &parsed).await {
            return json_response(StatusCode::BAD_REQUEST, json!({ "error": e.to_string() }));
        }
    }
    let Some(target) = body
        .target
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        // No target change — still 200 (plugin may only send tags).
        return json_response(StatusCode::OK, json!({}));
    };
    match state.ctrl.update_session_target(sid, target).await {
        Ok(_) => json_response(StatusCode::OK, json!({})),
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("SESSION_NOT_FOUND") {
                json_response(
                    StatusCode::BAD_REQUEST,
                    json!({ "error": "SESSION_NOT_FOUND" }),
                )
            } else {
                json_response(StatusCode::BAD_REQUEST, json!({ "error": msg }))
            }
        }
    }
}

/// Browser-uploaded attachment (login-wall PDFs the Connector fetched with the
/// page's cookies). Body = raw bytes; `X-Metadata` header carries
/// `{ sessionID, parentItemID, title, url }`.
async fn save_attachment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<std::collections::HashMap<String, String>>,
    body: Bytes,
) -> Response {
    if let Some(r) = guard(&headers, &Method::POST) {
        return r;
    }

    let meta: Value = headers
        .get("x-metadata")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(Value::Null);

    let session_id = meta
        .get("sessionID")
        .or_else(|| meta.get("sessionId"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| query.get("sessionID").map(String::as_str))
        .unwrap_or("")
        .to_string();
    if session_id.is_empty() {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "SESSION_ID_NOT_PROVIDED" }),
        );
    }

    // parentItemID may be a string or a number depending on the Connector version.
    let parent_item_id = meta
        .get("parentItemID")
        .or_else(|| meta.get("parentItemId"))
        .map(|v| match v {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        })
        .filter(|s| !s.is_empty());

    if let Err(error) = state
        .ctrl
        .begin_browser_attachment(&session_id, parent_item_id.as_deref())
        .await
    {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": error.to_string() }),
        );
    }
    state.ctrl.emit_attachment_progress(
        &session_id,
        parent_item_id.as_deref(),
        "running",
        "Saving browser PDF",
        None,
    );
    let write_result = state
        .ctrl
        .write_attachment_pdf(&session_id, parent_item_id.as_deref(), &body)
        .await;
    match &write_result {
        Ok(_) => state.ctrl.emit_attachment_progress(
            &session_id,
            parent_item_id.as_deref(),
            "completed",
            "Browser PDF saved",
            None,
        ),
        Err(error) => state.ctrl.emit_attachment_progress(
            &session_id,
            parent_item_id.as_deref(),
            "failed",
            "Browser PDF save failed",
            Some(error.to_string()),
        ),
    }
    let finalize_result = state
        .ctrl
        .complete_attachment(
            &session_id,
            parent_item_id.as_deref(),
            write_result.is_ok(),
            true,
        )
        .await;
    let result = match (write_result, finalize_result) {
        (Ok(path), Ok(())) => Ok(state
            .ctrl
            .session_item_paper(&session_id, parent_item_id.as_deref())
            .unwrap_or(path)),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(write_error), Err(finalize_error)) => Err(AppError::message(format!(
            "{write_error}; finalizer: {finalize_error}"
        ))),
    };

    match result {
        Ok(path) => json_response(StatusCode::CREATED, json!({ "path": path })),
        Err(e) => {
            let msg = e.to_string();
            state.ctrl.emit_error(&msg, Some(&session_id));
            let status = if msg.contains("SESSION_NOT_FOUND") {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            json_response(status, json!({ "error": msg }))
        }
    }
}

/// Standalone PDF upload (no parent item). Body = raw PDF; `X-Metadata` has
/// `{ sessionID?, title, url }` and `sessionID` may also be a query param.
async fn save_standalone_attachment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<std::collections::HashMap<String, String>>,
    body: Bytes,
) -> Response {
    if let Some(r) = guard(&headers, &Method::POST) {
        return r;
    }

    if headers.get("x-metadata").is_none() {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "METADATA_NOT_PROVIDED" }),
        );
    }
    let meta: Value = headers
        .get("x-metadata")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(Value::Null);

    let session_id = meta
        .get("sessionID")
        .or_else(|| meta.get("sessionId"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| query.get("sessionID").map(String::as_str))
        .or_else(|| query.get("sessionId").map(String::as_str))
        .unwrap_or("")
        .to_string();
    if session_id.is_empty() {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "SESSION_ID_NOT_PROVIDED" }),
        );
    }

    let title = meta
        .get("title")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let url = meta
        .get("url")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());

    match import_standalone_attachment(state.ctrl.clone(), &session_id, title, url, &body).await {
        Ok(_) => {
            // Official: `{ canRecognize }`. We skip PDF recognition for now so
            // the extension will not poll `/connector/getRecognizedItem`.
            json_response(StatusCode::CREATED, json!({ "canRecognize": false }))
        }
        Err(e) => {
            let msg = e.to_string();
            state.ctrl.emit_error(&msg, Some(&session_id));
            let status = if msg.contains("No vault") {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            json_response(status, json!({ "error": msg }))
        }
    }
}

#[derive(Debug, Deserialize)]
struct ResolverBody {
    #[serde(default, alias = "sessionId", rename = "sessionID")]
    session_id: Option<String>,
    /// Connector item id (string or number from the translator payload).
    #[serde(default, alias = "itemId", rename = "itemID")]
    item_id: Option<Value>,
}

fn resolver_item_id(value: &Option<Value>) -> Option<String> {
    value.as_ref().and_then(|v| match v {
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
        Value::Number(n) => Some(n.to_string()),
        other if !other.is_null() => Some(other.to_string()),
        _ => None,
    })
}

async fn has_attachment_resolvers(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ResolverBody>,
) -> Response {
    if let Some(r) = guard(&headers, &Method::POST) {
        return r;
    }
    let Some(session_id) = body
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
    else {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "SESSION_ID_NOT_PROVIDED" }),
        );
    };
    let Some(item_id) = resolver_item_id(&body.item_id) else {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "ITEM_ID_NOT_PROVIDED" }),
        );
    };
    match session_has_attachment_resolvers(state.ctrl.as_ref(), &session_id, &item_id).await {
        Ok(has) => {
            if !has {
                state.ctrl.emit_attachment_progress(
                    &session_id,
                    Some(&item_id),
                    "failed",
                    "Browser PDF failed and no fallback resolver is available",
                    Some("Failed to save an attachment".into()),
                );
                if let Err(error) = state
                    .ctrl
                    .complete_attachment(&session_id, Some(&item_id), false, false)
                    .await
                {
                    state.ctrl.emit_error(&error.to_string(), Some(&session_id));
                }
            }
            json_response(StatusCode::OK, json!(has))
        }
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("SESSION_NOT_FOUND") {
                json_response(
                    StatusCode::BAD_REQUEST,
                    json!({ "error": "SESSION_NOT_FOUND" }),
                )
            } else {
                // Soft-fail: tell the extension there are no resolvers.
                state.ctrl.emit_attachment_progress(
                    &session_id,
                    Some(&item_id),
                    "failed",
                    "Fallback resolver check failed",
                    Some(msg),
                );
                if let Err(error) = state
                    .ctrl
                    .complete_attachment(&session_id, Some(&item_id), false, false)
                    .await
                {
                    state.ctrl.emit_error(&error.to_string(), Some(&session_id));
                }
                json_response(StatusCode::OK, json!(false))
            }
        }
    }
}

async fn save_attachment_from_resolver_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ResolverBody>,
) -> Response {
    if let Some(r) = guard(&headers, &Method::POST) {
        return r;
    }
    let Some(session_id) = body
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
    else {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "SESSION_ID_NOT_PROVIDED" }),
        );
    };
    let Some(item_id) = resolver_item_id(&body.item_id) else {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "ITEM_ID_NOT_PROVIDED" }),
        );
    };
    if let Err(error) = state
        .ctrl
        .begin_fallback_attachment(&session_id, &item_id)
        .await
    {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": error.to_string() }),
        );
    }
    state.ctrl.emit_attachment_progress(
        &session_id,
        Some(&item_id),
        "running",
        "Downloading PDF from DOI/arXiv fallback",
        None,
    );
    let save_result =
        save_attachment_from_resolver(state.ctrl.clone(), &session_id, &item_id).await;
    match &save_result {
        Ok(_) => state.ctrl.emit_attachment_progress(
            &session_id,
            Some(&item_id),
            "completed",
            "Fallback PDF saved",
            None,
        ),
        Err(error) => state.ctrl.emit_attachment_progress(
            &session_id,
            Some(&item_id),
            "failed",
            "Fallback PDF save failed",
            Some(error.to_string()),
        ),
    }
    let finalize_result = state
        .ctrl
        .complete_attachment(&session_id, Some(&item_id), save_result.is_ok(), true)
        .await;
    let result = match (save_result, finalize_result) {
        (Ok(title), Ok(())) => Ok(title),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(save_error), Err(finalize_error)) => Err(AppError::message(format!(
            "{save_error}; finalizer: {finalize_error}"
        ))),
    };

    match result {
        Ok(title) => text_response(StatusCode::CREATED, "text/plain", &title),
        Err(e) => {
            let msg = e.to_string();
            state.ctrl.emit_error(&msg, Some(&session_id));
            if msg.contains("SESSION_NOT_FOUND") {
                json_response(
                    StatusCode::BAD_REQUEST,
                    json!({ "error": "SESSION_NOT_FOUND" }),
                )
            } else {
                text_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "text/plain",
                    "Failed to save an attachment",
                )
            }
        }
    }
}

async fn attachment_progress(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SessionIdBody>,
) -> Response {
    session_progress(State(state), headers, Json(body)).await
}

async fn detect(
    State(_state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Some(r) = guard(&headers, &Method::POST) {
        return r;
    }
    // Translator execution remains in the configured Translator Runtime. The
    // local compatibility server cannot safely execute arbitrary translator JS.
    let has_page = body.get("uri").and_then(Value::as_str).is_some()
        || body.get("url").and_then(Value::as_str).is_some();
    json_response(
        StatusCode::OK,
        if has_page {
            json!([])
        } else {
            json!({ "error": "URI_NOT_PROVIDED" })
        },
    )
}

async fn save_page(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SnapshotBody>,
) -> Response {
    save_snapshot(State(state), headers, Json(body)).await
}

async fn select_items(headers: HeaderMap, Json(body): Json<Value>) -> Response {
    if let Some(r) = guard(&headers, &Method::POST) {
        return r;
    }
    let items = body.get("items").cloned().unwrap_or_else(|| json!([]));
    json_response(StatusCode::OK, items)
}

async fn get_translators(headers: HeaderMap) -> Response {
    if let Some(r) = guard(&headers, &Method::POST) {
        return r;
    }
    json_response(StatusCode::OK, json!([]))
}

async fn proxies(headers: HeaderMap) -> Response {
    if let Some(r) = guard(&headers, &Method::POST) {
        return r;
    }
    json_response(StatusCode::OK, json!([]))
}

async fn delay_sync(headers: HeaderMap) -> Response {
    if let Some(r) = check_host(&headers) {
        return r;
    }
    let mut res = Response::new(Body::empty());
    *res.status_mut() = StatusCode::NO_CONTENT;
    add_zotero_headers(res.headers_mut());
    res
}
