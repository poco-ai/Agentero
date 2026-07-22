//! ACP session enumeration and history replay (`session/list`, `session/load`).

use super::*;

/// List sessions from an ACP agent via `session/list`.
/// Returns `supported: false` if the agent does not advertise session.list capability.
pub async fn list_acp_sessions(
    desc: &AgentDescriptor,
    cwd: PathBuf,
    cursor: Option<String>,
    remote: Option<&crate::services::remote::RemoteAgentTarget>,
) -> Result<AcpListSessionsResult, AppError> {
    let acp = to_acp_agent(desc, remote)?;

    let result = agent_client_protocol::Client
        .builder()
        .name("agentero")
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _cx| {
                let _ = responder.respond(permission_response(&request, false));
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(acp, {
            move |connection: ConnectionTo<Agent>| async move {
                let init = timed_acp_request(
                    "initialize",
                    connection
                        .send_request(InitializeRequest::new(ProtocolVersion::V1))
                        .block_task(),
                )
                .await?;

                let supports_list = init.agent_capabilities.session_capabilities.list.is_some();

                if !supports_list {
                    return Ok(AcpListSessionsResult {
                        sessions: vec![],
                        next_cursor: None,
                        supported: false,
                    });
                }

                let mut req = ListSessionsRequest::new().cwd(cwd);
                if let Some(c) = cursor {
                    req = req.cursor(c);
                }

                let resp =
                    timed_acp_request("session/list", connection.send_request(req).block_task())
                        .await?;

                let sessions = resp
                    .sessions
                    .into_iter()
                    .map(|s| AcpSessionInfo {
                        session_id: s.session_id.to_string(),
                        cwd: s.cwd.to_string_lossy().to_string(),
                        title: s.title,
                        updated_at: s.updated_at,
                    })
                    .collect();

                Ok(AcpListSessionsResult {
                    sessions,
                    next_cursor: resp.next_cursor,
                    supported: true,
                })
            }
        })
        .await;

    match result {
        Ok(r) => Ok(r),
        Err(e) => Err(AppError::Acp(format!("list sessions: {e}"))),
    }
}

/// Load a session's history from an ACP agent via `session/load`.
/// The agent replays history as SessionNotification events which we accumulate.
pub async fn load_acp_session(
    desc: &AgentDescriptor,
    session_id: String,
    cwd: PathBuf,
    remote: Option<&crate::services::remote::RemoteAgentTarget>,
) -> Result<AcpLoadSessionResult, AppError> {
    let acp = to_acp_agent(desc, remote)?;

    let lines: Arc<Mutex<Vec<AcpHistoryLine>>> = Arc::new(Mutex::new(Vec::new()));
    let content_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let thought_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let line_counter: Arc<Mutex<u32>> = Arc::new(Mutex::new(0));

    let lines_for_notif = lines.clone();
    let content_for_notif = content_buf.clone();
    let thought_for_notif = thought_buf.clone();

    let result = agent_client_protocol::Client
        .builder()
        .name("agentero")
        .on_receive_notification(
            async move |notification: SessionNotification, _cx| {
                match &notification.update {
                    SessionUpdate::AgentMessageChunk(chunk) => {
                        if let Some(text) = text_from_content_block(&chunk.content) {
                            if let Ok(mut buf) = content_for_notif.lock() {
                                buf.push_str(&text);
                            }
                        }
                    }
                    SessionUpdate::AgentThoughtChunk(chunk) => {
                        if let Some(text) = text_from_content_block(&chunk.content) {
                            if let Ok(mut buf) = thought_for_notif.lock() {
                                buf.push_str(&text);
                            }
                        }
                    }
                    _ => {}
                }
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _cx| {
                let _ = responder.respond(permission_response(&request, false));
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(acp, {
            let sid = session_id.clone();
            move |connection: ConnectionTo<Agent>| async move {
                timed_acp_request(
                    "initialize",
                    connection
                        .send_request(InitializeRequest::new(ProtocolVersion::V1))
                        .block_task(),
                )
                .await?;

                timed_acp_request(
                    "session/load",
                    connection
                        .send_request(LoadSessionRequest::new(SessionId::new(sid.as_str()), cwd))
                        .block_task(),
                )
                .await?;

                // Brief settle so the agent can push replayed notifications.
                tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                Ok(())
            }
        })
        .await;

    match result {
        Ok(()) => {
            let content = content_buf.lock().map(|g| g.clone()).unwrap_or_default();
            let reasoning = thought_buf.lock().map(|g| g.clone()).unwrap_or_default();

            let mut result_lines = Vec::new();
            if !content.is_empty() {
                let id = {
                    let mut c = line_counter.lock().unwrap_or_else(|e| e.into_inner());
                    *c += 1;
                    format!("line-{c}")
                };
                result_lines.push(AcpHistoryLine {
                    id,
                    kind: "agent".to_string(),
                    text: content,
                    reasoning: if reasoning.is_empty() {
                        None
                    } else {
                        Some(reasoning)
                    },
                });
            }

            // Also include any lines accumulated via notification handler
            if let Ok(mut accumulated) = lines_for_notif.lock() {
                if !accumulated.is_empty() {
                    result_lines = std::mem::take(&mut accumulated);
                }
            }

            Ok(AcpLoadSessionResult {
                session_id,
                title: None,
                lines: result_lines,
            })
        }
        Err(e) => Err(AppError::Acp(format!("load session: {e}"))),
    }
}
