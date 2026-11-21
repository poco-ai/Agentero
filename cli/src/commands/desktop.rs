//! Execute an acknowledged command in the desktop process that owns the workspace.
use crate::error::{CliError, ExitCode};
use crate::resolve::{resolve_vault, GlobalOpts};
use agentero_core::features::context::{CLI_GRANT_ENV, TURN_ENV};
use agentero_core::features::open_request::desktop::{
    active_endpoint, private_dir, write_packet, WorkspaceReply, WorkspaceRequest,
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
    let dir = private_dir(Some(&endpoint), "request-")?;
    let id = dir
        .path()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let req = WorkspaceRequest {
        id: id.clone(),
        route: route.to_owned(),
        vault: vault.map(|p| p.display().to_string()),
        args,
    };
    write_packet(dir.path(), "request", &req)?;
    while Instant::now() < deadline {
        match std::fs::File::open(dir.path().join("reply")) {
            Ok(file) => {
                let reply: WorkspaceReply = serde_json::from_reader(file)?;
                if reply.id != id {
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
                return Ok(reply.value);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        tokio::time::sleep(Duration::from_millis(75)).await;
    }
    Err(unavailable(
        "desktop did not acknowledge the command before the timeout",
    ))
}
