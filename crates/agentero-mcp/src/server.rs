//! Streamable HTTP MCP listener (loopback only).

use super::interface::ResearchServer;
use super::McpController;
use agentero_core::error::AppError;
use axum::{
    extract::Request,
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    Router,
};
use std::io::Write;
use subtle::ConstantTimeEq;

pub fn default_token_path() -> std::path::PathBuf {
    agentero_core::paths::agentero_config_dir().join("mcp.token")
}

pub fn default_token() -> Result<String, AppError> {
    token_at(&default_token_path())
}

pub fn ephemeral_token() -> Result<(String, tempfile::NamedTempFile), AppError> {
    let dir = agentero_core::paths::agentero_config_dir();
    std::fs::create_dir_all(&dir)?;
    let mut file = tempfile::Builder::new()
        .prefix("mcp-")
        .suffix(".token")
        .tempfile_in(dir)?;
    let token = generate_token();
    writeln!(file, "{token}")?;
    Ok((token, file))
}

fn generate_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

pub(super) fn token_at(path: &std::path::Path) -> Result<String, AppError> {
    let read = || -> Result<String, AppError> {
        let token = std::fs::read_to_string(path)?;
        let token = token.trim();
        if token.is_empty() {
            return Err(AppError::message("MCP token file is empty"));
        }
        Ok(token.to_owned())
    };
    if path.exists() {
        return read();
    }
    let dir = path.parent().expect("token config directory");
    std::fs::create_dir_all(dir)?;
    let mut file = tempfile::NamedTempFile::new_in(dir)?;
    let token = generate_token();
    writeln!(file, "{token}")?;
    match file.persist_noclobber(path) {
        Ok(_) => Ok(token),
        Err(err) if err.error.kind() == std::io::ErrorKind::AlreadyExists => read(),
        Err(err) => Err(err.error.into()),
    }
}

use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

/// Parse `127.0.0.1:8765` or `[::1]:8765`. Port zero requests an ephemeral port.
pub fn parse_loopback_listen(raw: &str) -> Result<SocketAddr, AppError> {
    let addr: SocketAddr = raw.parse().map_err(|_| {
        AppError::message("listen must be a loopback socket such as 127.0.0.1:8765 or [::1]:8765")
    })?;
    if !addr.ip().is_loopback() {
        return Err(AppError::message(
            "MCP listens on loopback only (127.0.0.1 or ::1)",
        ));
    }
    Ok(addr)
}

/// Serve `listener` until Ctrl-C, or SIGTERM on Unix. The caller binds the
/// socket so it can print the actual address before this future resolves.
pub async fn serve_until_signal(
    ctrl: Arc<McpController>,
    listener: TcpListener,
    token: String,
) -> Result<(), AppError> {
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    tokio::spawn(async move {
        shutdown_signal().await;
        let _ = shutdown_tx.send(());
    });
    serve(listener, shutdown_rx, ctrl, token).await
}

fn allowed_hosts(bound: SocketAddr) -> Vec<String> {
    let port = bound.port();
    let mut hosts = vec![
        "127.0.0.1".to_string(),
        "localhost".to_string(),
        format!("127.0.0.1:{port}"),
        format!("localhost:{port}"),
    ];
    hosts.push(bound.ip().to_string());
    hosts.push(bound.to_string());
    if bound.ip().is_ipv6() {
        hosts.push(format!("[{}]", bound.ip()));
    }
    hosts
}

async fn shutdown_signal() {
    #[cfg(all(unix, not(any(target_os = "ios", target_os = "android"))))]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = match signal(SignalKind::terminate()) {
            Ok(term) => term,
            Err(err) => {
                log::warn!(target: "agentero::mcp", "SIGTERM handler unavailable: {err}");
                let _ = tokio::signal::ctrl_c().await;
                return;
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(any(not(unix), target_os = "ios", target_os = "android"))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

pub async fn serve(
    listener: TcpListener,
    shutdown_rx: oneshot::Receiver<()>,
    ctrl: Arc<McpController>,
    token: String,
) -> Result<(), AppError> {
    let bound = listener
        .local_addr()
        .unwrap_or_else(|_| std::net::SocketAddr::from(([127, 0, 0, 1], ctrl.status().port)));
    let mut config = StreamableHttpServerConfig::default();
    config.allowed_hosts = allowed_hosts(bound);
    let mcp_service = StreamableHttpService::new(
        {
            let ctrl = Arc::clone(&ctrl);
            move || Ok(ResearchServer::new(Arc::clone(&ctrl)))
        },
        LocalSessionManager::default().into(),
        config,
    );
    if token.trim().is_empty() {
        return Err(AppError::message("HTTP bearer token is empty"));
    }
    let token = Arc::new(token);
    let stateless_key = crate::excerpts::ExcerptKey::new();
    let app = Router::new()
        .nest_service("/mcp", mcp_service)
        .layer(middleware::from_fn(move |mut req: Request, next: Next| {
            req.extensions_mut().insert(stateless_key.clone());
            let token = token.clone();
            async move {
                let supplied = req
                    .headers()
                    .get(header::AUTHORIZATION)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.split_once(' '))
                    .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
                    .map(|(_, token)| token);
                if !supplied
                    .is_some_and(|value| bool::from(value.as_bytes().ct_eq(token.as_bytes())))
                {
                    return (
                        StatusCode::UNAUTHORIZED,
                        [(header::WWW_AUTHENTICATE, "Bearer")],
                    )
                        .into_response();
                }
                let response: Response = next.run(req).await;
                response
            }
        }));
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        })
        .await
        .map_err(|e| AppError::message(format!("mcp server: {e}")))
}
