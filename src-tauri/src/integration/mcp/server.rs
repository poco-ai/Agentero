//! Streamable HTTP MCP listener (loopback only).

use super::tools::AgenteroMcp;
use super::McpController;
use crate::core::error::AppError;
use axum::Router;
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

pub async fn serve(
    listener: TcpListener,
    shutdown_rx: oneshot::Receiver<()>,
    ctrl: Arc<McpController>,
) -> Result<(), AppError> {
    let port = listener
        .local_addr()
        .map(|a| a.port())
        .unwrap_or(ctrl.status().port);
    let mut config = StreamableHttpServerConfig::default();
    config.allowed_hosts = vec![
        "127.0.0.1".into(),
        "localhost".into(),
        format!("127.0.0.1:{port}"),
        format!("localhost:{port}"),
    ];
    let mcp_service = StreamableHttpService::new(
        {
            let ctrl = Arc::clone(&ctrl);
            move || Ok(AgenteroMcp::new(Arc::clone(&ctrl)))
        },
        LocalSessionManager::default().into(),
        config,
    );
    let app = Router::new().nest_service("/mcp", mcp_service);
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        })
        .await
        .map_err(|e| AppError::message(format!("mcp server: {e}")))
}
