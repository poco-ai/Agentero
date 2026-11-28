//! Execute an acknowledged command in the desktop process that owns the workspace.
use crate::error::{CliError, ExitCode};
use crate::resolve::{resolve_vault, GlobalOpts};
use agentero_core::error::AppError;
use agentero_core::features::context::{CLI_GRANT_ENV, TURN_ENV};
use agentero_core::features::open_request::desktop::{
    active_endpoint, private_dir, write_packet, PrivateDir, WorkspaceReply, WorkspaceRequest,
};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

fn unavailable(message: &str) -> CliError {
    CliError::new("host_unavailable", message, ExitCode::Unavailable)
}

pub async fn run(route: &str, mut args: Value, globals: &GlobalOpts) -> Result<Value, CliError> {
    let vault = if matches!(route, "app open" | "app split") || globals.vault_flag.is_some() {
        Some(resolve_vault(globals)?)
    } else {
        None
    };
    if route == "delegate run" && args["prompt"].is_null() {
        use std::io::Read;
        let input = args["input"]
            .as_str()
            .ok_or_else(|| CliError::usage("provide --input FILE or --input -"))?;
        let prompt = if input == "-" {
            let mut s = String::new();
            std::io::stdin().read_to_string(&mut s)?;
            s
        } else {
            std::fs::read_to_string(input)?
        };
        args["prompt"] = json!(prompt);
    }
    let wait = args["wait"].as_u64().unwrap_or(0).min(300);
    let token = std::env::var(CLI_GRANT_ENV)
        .or_else(|_| std::env::var(TURN_ENV))
        .ok();
    if route == "app present" || (route.starts_with("delegate ") && token.is_some()) {
        if globals.vault_flag.is_some() {
            return Err(CliError::new(
                "scope_denied",
                "hosted calls select their vault",
                ExitCode::NeedsConfirmation,
            ));
        }
        let token =
            token.ok_or_else(|| unavailable("app present requires a live desktop agent turn"))?;
        return send(
            "turn call",
            json!({"token":token,"operation":route,"input":args}),
            None,
            globals,
            wait,
        )
        .await;
    }
    send(route, args, vault, globals, wait).await
}

pub async fn run_granted(name: &str, args: Value, globals: &GlobalOpts) -> Result<Value, CliError> {
    let token = std::env::var(CLI_GRANT_ENV).map_err(|_| {
        CliError::new(
            "scope_denied",
            "missing turn handle",
            ExitCode::NeedsConfirmation,
        )
    })?;
    send(
        "turn call",
        json!({"token":token,"operation":name,"input":args}),
        None,
        globals,
        0,
    )
    .await
}

async fn send(
    route: &str,
    args: Value,
    vault: Option<std::path::PathBuf>,
    globals: &GlobalOpts,
    wait: u64,
) -> Result<Value, CliError> {
    // Cold desktop startup may load the PDF backend and restore a workspace.
    let deadline = Instant::now() + Duration::from_secs(65 + wait);
    let mut endpoint = active_endpoint();
    if endpoint.is_none() && route == "app open" {
        let vault = vault
            .as_deref()
            .ok_or_else(|| CliError::usage("select a vault to open"))?;
        super::open::run(vault, globals)?;
        while endpoint.is_none() && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(100)).await;
            endpoint = active_endpoint();
        }
    }
    let endpoint = endpoint.ok_or_else(|| unavailable("open Agentero desktop and retry"))?;
    let mut request = WorkspaceRequest {
        id: String::new(),
        route: route.to_owned(),
        vault: vault.map(|p| p.display().to_string()),
        args,
    };
    let reply = match publish(&endpoint, &mut request) {
        Ok(dir) => wait_for_file_reply(dir.path(), deadline).await?,
        // A publish error occurs before the atomic rename to `request`.
        // Once published, a timeout or reply error must never cause a resend.
        #[cfg(target_os = "macos")]
        Err(error) if file_access_denied(&error) => {
            request.id = uuid::Uuid::new_v4().to_string();
            socket_reply(&endpoint, &request, deadline).await?
        }
        Err(error) => return Err(error.into()),
    };
    if reply.id != request.id {
        return Err(CliError::message("unexpected desktop response"));
    }
    if let Some(error) = reply.error {
        return Err(CliError::message(error));
    }
    if let Some(code) = reply.value["error_code"].as_str() {
        return Err(CliError::domain(
            code,
            reply.value["message"].as_str().unwrap_or(code),
            reply.value["details"].clone(),
        ));
    }
    if route == "turn call" {
        return Ok(reply.value["data"].clone());
    }
    Ok(reply.value)
}

fn publish(
    endpoint: &std::path::Path,
    request: &mut WorkspaceRequest,
) -> Result<PrivateDir, AppError> {
    let dir = private_dir(Some(endpoint), "request-")?;
    request.id = dir
        .path()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    write_packet(dir.path(), "request", request)?;
    Ok(dir)
}

async fn wait_for_file_reply(
    dir: &std::path::Path,
    deadline: Instant,
) -> Result<WorkspaceReply, CliError> {
    while Instant::now() < deadline {
        match std::fs::File::open(dir.join("reply")) {
            Ok(file) => return Ok(serde_json::from_reader(file)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        tokio::time::sleep(Duration::from_millis(75)).await;
    }
    Err(reply_timeout())
}

fn reply_timeout() -> CliError {
    unavailable("desktop did not acknowledge the command before the timeout")
}

#[cfg(target_os = "macos")]
fn file_access_denied(error: &AppError) -> bool {
    use std::io::ErrorKind::{PermissionDenied, ReadOnlyFilesystem};

    let kind = match error {
        AppError::Io(error) => Some(error.kind()),
        AppError::Json(error) => error.io_error_kind(),
        _ => None,
    };
    matches!(kind, Some(PermissionDenied | ReadOnlyFilesystem))
}

#[cfg(target_os = "macos")]
async fn socket_reply(
    endpoint: &std::path::Path,
    request: &WorkspaceRequest,
    deadline: Instant,
) -> Result<WorkspaceReply, CliError> {
    use agentero_core::features::open_request::desktop::{MAX_REQUEST_BYTES, SOCKET_NAME};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let bytes = serde_json::to_vec(request)?;
    if bytes.len() as u64 > MAX_REQUEST_BYTES {
        return Err(CliError::usage("desktop request exceeds 2000000 bytes"));
    }
    tokio::time::timeout_at(deadline.into(), async {
        let mut stream = tokio::net::UnixStream::connect(endpoint.join(SOCKET_NAME))
            .await
            .map_err(|error| {
                unavailable(&format!(
                    "desktop request directory is not writable and the socket connection failed: {error}"
                ))
            })?;
        stream.write_all(&bytes).await?;
        stream.shutdown().await?;
        let mut reply = Vec::new();
        stream.read_to_end(&mut reply).await?;
        Ok(serde_json::from_slice(&reply)?)
    })
    .await
    .map_err(|_| reply_timeout())?
}
