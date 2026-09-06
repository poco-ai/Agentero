use crate::features::agent::acp::client::{
    acp_err, client_initialize_request, to_acp_agent, ACP_INITIALIZE_TIMEOUT,
};
use crate::features::agent::acp::interaction::permission_response;
use crate::features::agent::acp::terminal::{AcpTerminalHandler, AcpTerminalManager};
use crate::features::agent::models::{AcpSessionCapabilities, AgentDescriptor, ProbeResult};
use agent_client_protocol::schema::v1::RequestPermissionRequest;
use agent_client_protocol::{Agent, ConnectionTo};
use std::sync::{Arc, Mutex};

/// Spawn agent, initialize ACP, report agent info. Does not send a user prompt.
/// When `remote` is set, the agent process is launched on the remote host (SSH).
pub async fn probe_agent(
    desc: &AgentDescriptor,
    remote: Option<&dyn crate::features::agent::remote_host::RemoteAgentLaunch>,
) -> ProbeResult {
    let agent_id = desc.id.clone();
    let acp = match to_acp_agent(desc, None, remote) {
        Ok(a) => a,
        Err(e) => {
            return ProbeResult {
                agent_id,
                available: false,
                agent_name: None,
                protocol_version: None,
                error: Some(e.to_string()),
                session_capabilities: None,
            };
        }
    };

    let captured: Arc<Mutex<Option<(String, String, AcpSessionCapabilities)>>> =
        Arc::new(Mutex::new(None));
    let captured_clone = captured.clone();
    let terminals = Arc::new(tokio::sync::Mutex::new(AcpTerminalManager::new()));

    let connect = agent_client_protocol::Client
        .builder()
        .name("agentero")
        .with_handler(AcpTerminalHandler::new(terminals))
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _cx| {
                let _ = responder.respond(permission_response(&request, false));
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(acp, {
            let captured = captured_clone;
            move |connection: ConnectionTo<Agent>| async move {
                let init = connection
                    .send_request(client_initialize_request())
                    .block_task()
                    .await
                    .map_err(|e| acp_err(format!("initialize failed: {e}")))?;

                let name = init
                    .agent_info
                    .as_ref()
                    .map(|i| i.name.clone())
                    .unwrap_or_else(|| "unknown".into());
                let version = format!("{:?}", init.protocol_version);
                let session_caps = {
                    let sc = &init.agent_capabilities.session_capabilities;
                    AcpSessionCapabilities {
                        list: sc.list.is_some(),
                        resume: sc.resume.is_some(),
                        load: init.agent_capabilities.load_session,
                        delete: sc.delete.is_some(),
                    }
                };
                if let Ok(mut g) = captured.lock() {
                    *g = Some((name, version, session_caps));
                }
                Ok(())
            }
        });

    let result = match tokio::time::timeout(ACP_INITIALIZE_TIMEOUT, connect).await {
        Ok(r) => r,
        Err(_) => {
            return ProbeResult {
                agent_id,
                available: false,
                agent_name: None,
                protocol_version: None,
                error: Some(format!(
                    "probe timed out after {}s (check Agent proxy / network)",
                    ACP_INITIALIZE_TIMEOUT.as_secs()
                )),
                session_capabilities: None,
            };
        }
    };

    match result {
        Ok(()) => {
            let info = captured.lock().ok().and_then(|g| g.clone());
            match info {
                Some((name, version, session_caps)) => ProbeResult {
                    agent_id,
                    available: true,
                    agent_name: Some(name),
                    protocol_version: Some(version),
                    error: None,
                    session_capabilities: Some(session_caps),
                },
                None => ProbeResult {
                    agent_id,
                    available: false,
                    agent_name: None,
                    protocol_version: None,
                    error: Some("no initialize response".into()),
                    session_capabilities: None,
                },
            }
        }
        Err(e) => ProbeResult {
            agent_id,
            available: false,
            agent_name: None,
            protocol_version: None,
            error: Some(e.to_string()),
            session_capabilities: None,
        },
    }
}
