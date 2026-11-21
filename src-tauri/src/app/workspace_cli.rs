//! Acknowledge CLI requests only after the owning desktop workspace has handled them.
use agentero_core::features::open_request::desktop::*;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tauri::{AppHandle, Emitter, EventTarget, Manager};

type ReplySender = (String, tokio::sync::oneshot::Sender<WorkspaceReply>);
static PENDING: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, ReplySender>>,
> = std::sync::LazyLock::new(std::sync::Mutex::default);

#[tauri::command]
#[specta::specta]
pub fn workspace_cli_reply(window: tauri::WebviewWindow, reply: WorkspaceReply) {
    let mut waiting = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    if waiting
        .get(&reply.id)
        .is_some_and(|(label, _)| label == window.label())
    {
        if let Some((_, tx)) = waiting.remove(&reply.id) {
            let _ = tx.send(reply);
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn workspace_open_source(
    app: AppHandle,
    vault: String,
    source: String,
) -> Result<(), String> {
    use agentero_core::features::context::present_files;
    use tauri_plugin_opener::OpenerExt;
    if !source.starts_with("agentero://cite/") {
        // Recheck at click time: the file might have moved since the turn ended.
        let root = Path::new(&vault);
        let files =
            present_files(root, std::slice::from_ref(&source), None).map_err(|e| e.to_string())?;
        if files[0].preview_kind().is_none() {
            return app
                .opener()
                .reveal_item_in_dir(root.join(&files[0].path))
                .map_err(|e| e.to_string());
        }
    }
    let request = WorkspaceRequest {
        id: uuid::Uuid::new_v4().to_string(),
        route: "app open".into(),
        vault: Some(vault),
        args: json!({"target": source}),
    };
    let value = dispatch(&app, request).await?;
    if let Some(message) = value.get("message").and_then(Value::as_str) {
        return Err(message.to_owned());
    }
    Ok(())
}

pub fn start(app: AppHandle) -> Result<(), crate::core::error::AppError> {
    use std::io::Write;
    let marker = endpoint_marker();
    let parent = marker.parent().unwrap();
    std::fs::create_dir_all(parent)?;
    let dir = private_dir(Some(parent), "workspace-")?;
    let mut ready = tempfile::NamedTempFile::new_in(parent)?;
    ready.write_all(dir.path().file_name().unwrap().to_string_lossy().as_bytes())?;
    let lease = acquire_endpoint_lease(dir.path())?;
    use notify_debouncer_full::notify::{self, RecursiveMode, Watcher};
    let wake = Arc::new(tokio::sync::Notify::new());
    let changes = wake.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if event.map_or(true, |ev| {
            ev.paths
                .iter()
                .any(|p| p.file_name().is_some_and(|n| n == "request"))
        }) {
            changes.notify_one();
        }
    })
    .map_err(|e| crate::core::error::AppError::message(e.to_string()))?;
    watcher
        .watch(dir.path(), RecursiveMode::Recursive)
        .map_err(|e| crate::core::error::AppError::message(e.to_string()))?;
    ready.persist(&marker).map_err(|e| e.error)?;
    tauri::async_runtime::spawn(async move {
        let _watcher = watcher;
        let _lease = lease;
        loop {
            // Periodic scan also recovers if the system drops a notification.
            let _ = tokio::time::timeout(Duration::from_secs(2), wake.notified()).await;
            let Ok(entries) = tokio::fs::read_dir(dir.path()).await else {
                break;
            };
            let mut entries = entries;
            while let Ok(Some(entry)) = entries.next_entry().await {
                if !entry.file_name().to_string_lossy().starts_with("request-")
                    || !entry.file_type().await.is_ok_and(|kind| kind.is_dir())
                {
                    continue;
                }
                let path = entry.path();
                let claimed = path.join("claimed");
                if tokio::fs::rename(path.join("request"), &claimed)
                    .await
                    .is_ok()
                {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        handle(app, path, claimed).await;
                    });
                }
            }
        }
    });
    Ok(())
}

async fn handle(app: AppHandle, dir: PathBuf, file: PathBuf) {
    let id = dir.file_name().unwrap().to_string_lossy().into_owned();
    let result = async {
        let info = tokio::fs::symlink_metadata(&file)
            .await
            .map_err(|e| e.to_string())?;
        if !info.is_file() || info.len() > 2_000_000 {
            return Err("invalid desktop request".into());
        }
        let bytes = tokio::fs::read(file).await.map_err(|e| e.to_string())?;
        let request: WorkspaceRequest =
            serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if request.id != id {
            return Err("request ID mismatch".into());
        }
        dispatch(&app, request).await
    }
    .await;
    let reply = match result {
        Ok(value) => WorkspaceReply {
            id,
            value,
            error: None,
        },
        Err(e) => WorkspaceReply {
            id,
            value: Value::Null,
            error: Some(e),
        },
    };
    let _ = write_packet(&dir, "reply", &reply);
}

fn host_error(e: agentero_core::error::AppError) -> Value {
    json!({"error_code":e.code(),"message":e.to_string(),"details":e.details().cloned().unwrap_or_else(||json!({}))})
}

async fn dispatch(app: &AppHandle, mut request: WorkspaceRequest) -> Result<Value, String> {
    if request.route == "turn call" {
        let response = async {
            use crate::features::agent::hosted_turn::HostedTurn;
            use agentero_core::error::AppError;
            let turn = HostedTurn::lookup(request.args["token"].as_str().unwrap_or(""))?;
            let op = request.args["operation"].as_str().unwrap_or("").to_owned();
            let input = request.args["input"].clone();
            if op.starts_with("delegate ") {
                let label = turn.window_label();
                return app
                    .state::<Arc<crate::features::agent::delegate::DelegateBridge>>()
                    .call(&label, &op, &input)
                    .await
                    .map_err(AppError::message);
            }
            tokio::task::spawn_blocking(move || {
                if op == "app present" {
                    turn.present(&input)
                } else {
                    turn.read(&op, input)
                }
            })
            .await
            .map_err(|e| AppError::message(e.to_string()))?
        }
        .await;
        return Ok(match response {
            Ok(data) => json!({"data":data}),
            Err(e) => host_error(e),
        });
    }
    if request.route.starts_with("delegate ") {
        return app
            .state::<Arc<crate::features::agent::delegate::DelegateBridge>>()
            .call("main", &request.route, &request.args)
            .await;
    }
    let explicit = request.args["window"].as_str().map(str::to_owned);
    let reference = match request.route.as_str() {
        "app close" => request.args["view"].as_str(),
        "app split" => request.args["beside"].as_str(),
        _ => None,
    }
    .map(str::to_owned);
    if request.route == "app views" || (explicit.is_none() && reference.is_some()) {
        let mut labels = app
            .webview_windows()
            .into_keys()
            .filter(|l| l == "main" || l.starts_with("doc-"))
            .collect::<Vec<_>>();
        if let Some(label) = &explicit {
            if !labels.contains(label) {
                return Err(format!("workspace window not found: {label}"));
            }
            labels.retain(|l| l == label);
        }
        labels.sort();
        let mut items = Vec::new();
        for label in labels {
            let mut query = request.clone();
            query.route = "app views".into();
            let result = ask_window(app, &label, query).await?;
            if let Some(rows) = result["items"].as_array() {
                items.extend(rows.iter().cloned());
            }
        }
        if request.route == "app views" {
            return Ok(json!({"items":items}));
        }
        let matches = items
            .iter()
            .filter(|row| row["view"].as_str() == reference.as_deref())
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            return Err("view not found or ambiguous; use app views and --window".into());
        }
        request.args["window"] = matches[0]["window"].clone();
    }
    if !matches!(
        request.route.as_str(),
        "app open" | "app split" | "app close" | "app window"
    ) {
        return Err("unknown desktop operation".into());
    }
    if let Some(target) = request.args["target"].as_str().map(str::to_owned) {
        let vault = Path::new(request.vault.as_deref().ok_or("select a vault")?);
        let (rel, loc) = if target.starts_with("agentero://cite/") {
            match agentero_core::features::evidence::resolve_citation(vault, &target) {
                Ok(loc) => loc,
                Err(error) => return Ok(host_error(error)),
            }
        } else if let Ok(rel) = agentero_core::features::open_request::normalize_vault_rel(&target)
        {
            if let Ok(actual) = vault.join(&rel).canonicalize() {
                if !actual.starts_with(vault.canonicalize().map_err(|e| e.to_string())?) {
                    return Err("target is outside the vault".into());
                }
                (rel, Value::Null)
            } else {
                let p = agentero_core::features::catalog::papers::lookup_paper_ref(vault, &target)
                    .map_err(|e| e.to_string())?;
                use agentero_core::features::catalog::papers::PaperRefLookup;
                match p {
                    PaperRefLookup::Found(p) => (p.path, Value::Null),
                    PaperRefLookup::Ambiguous(paths) => {
                        return Ok(host_error(
                            agentero_core::error::AppError::domain(
                                "paper_ambiguous",
                                "multiple papers match this target",
                            )
                            .with_details(json!({"candidates":paths})),
                        ))
                    }
                    PaperRefLookup::NotFound => {
                        return Ok(host_error(agentero_core::error::AppError::domain(
                            "source_not_found",
                            "target not found",
                        )))
                    }
                }
            }
        } else {
            return Err("target must be a vault-relative path, paper or cite".into());
        };
        request.args["target"] = Value::String(rel);
        request.args["locator"] = loc;
    }
    let label = request.args["window"]
        .as_str()
        .unwrap_or("main")
        .to_string();
    ask_window(app, &label, request).await
}

async fn ask_window(
    app: &AppHandle,
    label: &str,
    mut request: WorkspaceRequest,
) -> Result<Value, String> {
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| format!("workspace window not found: {label}"))?;
    if request.route == "app open" {
        crate::app::window::commands::raise_existing_window(&window);
    }
    request.id = uuid::Uuid::new_v4().to_string();
    let id = request.id.clone();
    let (sender, mut receiver) = tokio::sync::oneshot::channel();
    PENDING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.clone(), (label.to_string(), sender));
    let is_doc_close = request.route == "app close" && label.starts_with("doc-");
    let result = async {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(if request.route == "app open" { 45 } else { 10 });
        loop {
            app.emit_to(EventTarget::webview_window(window.label()), REQUEST, &request)
                .map_err(|e| e.to_string())?;
            let response = tokio::time::timeout(Duration::from_millis(300), &mut receiver).await;
            if let Ok(response) = response {
                let reply = response.map_err(|_| "workspace closed")?;
                if let Some(error) = reply.error {
                    return Err(error);
                }
                if !is_doc_close {
                    return Ok(reply.value);
                }
                // A close request can be vetoed after WebviewWindow.close() resolves.
                while tokio::time::Instant::now() < deadline {
                    if app.get_webview_window(label).is_none() {
                        return Ok(reply.value);
                    }
                    tokio::time::sleep(Duration::from_millis(40)).await;
                }
                return Err("document window refused to close".into());
            }
            if is_doc_close && app.get_webview_window(label).is_none() {
                return Ok(json!({"changed": true, "items":[{"id":request.args["view"], "outcome":"closed"}], "preview":false}));
            }
            if tokio::time::Instant::now() >= deadline {
                return Err("workspace did not acknowledge command".into());
            }
        }
    }
    .await;
    PENDING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
    result
}
