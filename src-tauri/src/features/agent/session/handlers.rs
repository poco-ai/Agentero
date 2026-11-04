//! Shared ACP connection handlers for live turns and warm-idle pooled
//! connections.
//!
//! agent-client-protocol's typed handler types (`RequestHandler` /
//! `NotificationHandler`) are `pub(crate)` in the crate, so handlers cannot be
//! swapped at runtime. Instead every pooled connection installs this full
//! static handler set up front, and each handler consults the [`TurnRegistry`]:
//! - `Some(turn)` → a live run owns the connection: relay notifications and
//!   forward permission / elicitation / ask-user to that turn's gates;
//! - `None` → warm-idle behavior: deny permissions, cancel elicitation and
//!   ask-user (an unsupervised agent must never act), capture usage and
//!   forward commands / config so the Chat panel stays fresh between turns.

use crate::features::agent::acp::interaction::{
    await_user_permission, permission_response, PermissionPolicy,
};
use crate::features::agent::acp::updates::{
    emit_rich_session_update, emit_session_config_options, models_from_config_options,
    models_from_grok_update, store_richer_models,
};
use crate::features::agent::models::{AgentModelsEvent, AgentUsageEvent};
use crate::features::agent::runtime::events::AgentEventEmitter;
use crate::features::agent::runtime::gates::{AskUserGate, ElicitationGate, PermissionGate};
use crate::features::agent::session::run::RunOnceContext;
use agent_client_protocol::schema::v1::{
    RequestPermissionRequest, RequestPermissionResponse, SessionNotification, SessionUpdate,
};
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

/// Live turn installed into a pooled connection's [`TurnRegistry`] while a
/// `run_once` prompt is in flight. Cloned into every handler snapshot, so all
/// fields must be cheap-to-clone shared state.
#[derive(Clone)]
pub(crate) struct ActiveTurn {
    pub ctx: RunOnceContext,
    pub permission_policy: PermissionPolicy,
    pub permission_gate: PermissionGate,
    pub elicitation_gate: ElicitationGate,
    pub ask_user_gate: AskUserGate,
    /// Pool keepalive heartbeat: bumped on every routed notification so an
    /// active turn never looks idle. `None` on cold (non-pooled) connections.
    pub activity: Option<watch::Sender<u64>>,
}

/// The registry a pooled connection consults on every inbound message.
pub(crate) type TurnRegistry = Arc<Mutex<Option<ActiveTurn>>>;

pub(crate) fn new_registry() -> TurnRegistry {
    Arc::new(Mutex::new(None))
}

/// Clone out the currently installed turn, if any.
pub(crate) fn snapshot_turn(registry: &TurnRegistry) -> Option<ActiveTurn> {
    registry.lock().ok().and_then(|g| g.clone())
}

/// Install a turn, returning the previous one if the slot was not cleared.
pub(crate) fn install_turn(registry: &TurnRegistry, turn: ActiveTurn) -> Option<ActiveTurn> {
    registry.lock().ok().and_then(|mut g| g.replace(turn))
}

/// Remove the installed turn (every run exit path must call this so later
/// notifications route to warm-idle instead of a dead emitter).
pub(crate) fn clear_turn(registry: &TurnRegistry) -> Option<ActiveTurn> {
    registry.lock().ok().and_then(|mut g| g.take())
}

/// Nudge the pool keepalive so the idle TTL restarts.
pub(crate) fn bump_activity(activity: &Option<watch::Sender<u64>>) {
    if let Some(activity) = activity {
        activity.send_if_modified(|v| {
            *v += 1;
            true
        });
    }
}

/// Warm-idle notification behavior (extracted from the pre-pool warm path):
/// capture usage into the out-cell for `WarmResult`, forward commands /
/// config so a reopened Chat shows fresh state.
#[derive(Clone)]
pub(crate) struct WarmIdleHooks {
    pub app: AgentEventEmitter,
    pub session_id: String,
    pub agent_id: String,
    /// Captured `(used, size)` read by `warm_agent` when setup completes.
    pub usage: Arc<Mutex<Option<(u64, u64)>>>,
    /// Latest model catalog pushed while the connection idles. Reading this at
    /// setup end keeps the warm result from clobbering a richer
    /// `config_option_update` that arrived after `session/new` (#638).
    pub models: Arc<Mutex<Option<AgentModelsEvent>>>,
}

impl WarmIdleHooks {
    pub(crate) fn handle_notification(&self, notification: &SessionNotification) {
        if let SessionUpdate::UsageUpdate(u) = &notification.update {
            if let Ok(mut g) = self.usage.lock() {
                *g = Some((u.used, u.size));
            }
            let _ = self.app.emit(
                "agent:usage",
                AgentUsageEvent {
                    session_id: self.session_id.clone(),
                    used: u.used,
                    size: u.size,
                },
            );
        }
        if let SessionUpdate::AvailableCommandsUpdate(_) = &notification.update {
            emit_rich_session_update(&self.app, &self.session_id, &self.agent_id, notification);
        }
        if let SessionUpdate::ConfigOptionUpdate(upd) = &notification.update {
            // Keep the warm result's catalog in sync with the pushed one so the
            // result cannot overwrite it with a stale partial snapshot (#638).
            if let Some(ev) =
                models_from_config_options(&self.session_id, &self.agent_id, &upd.config_options)
            {
                if let Ok(mut g) = self.models.lock() {
                    store_richer_models(&mut g, ev);
                }
            }
            emit_session_config_options(
                &self.app,
                &self.session_id,
                &self.agent_id,
                &upd.config_options,
            );
        }
    }

    /// Grok Build pushes its refreshed model catalog with a vendor
    /// notification after `session/new`; keep the warm result and the Chat
    /// picker on the pushed catalog instead of the stale session snapshot.
    pub(crate) fn handle_grok_models_update(
        &self,
        params: &crate::features::agent::acp::grok_models::GrokModelsUpdateParams,
    ) {
        let Some(event) = models_from_grok_update(&self.session_id, &self.agent_id, params) else {
            return;
        };
        if let Ok(mut g) = self.models.lock() {
            store_richer_models(&mut g, event.clone());
        }
        let _ = self.app.emit("agent:models", event);
    }
}

/// Permission decision for a live turn (policy → deny / allow / ask the user).
pub(crate) async fn decide_permission(
    app: &AgentEventEmitter,
    session_id: &str,
    policy: &PermissionPolicy,
    gate: &PermissionGate,
    request: &RequestPermissionRequest,
) -> RequestPermissionResponse {
    match policy {
        PermissionPolicy::Restricted => permission_response(request, false),
        PermissionPolicy::Auto => permission_response(request, true),
        PermissionPolicy::Ask => await_user_permission(app, gate, session_id, request).await,
    }
}

/// Shared connection builder for both the cold one-shot path and pooled warm
/// connections: base client + terminal handler + the four registry-aware
/// handlers. `$idle` supplies the warm-idle notification behavior (`None` on
/// cold connections, where the registry is pre-filled for the whole run).
macro_rules! agentero_turn_builder {
    ($terminals:expr, $registry:expr, $idle:expr $(,)?) => {{
        let registry: $crate::features::agent::session::handlers::TurnRegistry = $registry;
        let idle: Option<$crate::features::agent::session::handlers::WarmIdleHooks> = $idle;
        $crate::features::agent::acp::client::agentero_acp_builder!($terminals)
            .on_receive_notification(
                {
                    let registry = registry.clone();
                    let idle = idle.clone();
                    async move |notification: agent_client_protocol::schema::v1::SessionNotification, _cx| {
                        match $crate::features::agent::session::handlers::snapshot_turn(&registry)
                        {
                            Some(turn) => {
                                $crate::features::agent::session::handlers::bump_activity(
                                    &turn.activity,
                                );
                                turn.ctx.relay_session_notification(&notification);
                            }
                            None => {
                                if let Some(idle) = idle.as_ref() {
                                    idle.handle_notification(&notification);
                                }
                            }
                        }
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_notification(
                {
                    let registry = registry.clone();
                    let idle = idle.clone();
                    async move |update: $crate::features::agent::acp::grok_models::GrokModelsUpdate, _cx| {
                        match $crate::features::agent::session::handlers::snapshot_turn(&registry)
                        {
                            Some(turn) => {
                                $crate::features::agent::session::handlers::bump_activity(
                                    &turn.activity,
                                );
                                turn.ctx.relay_grok_models_update(&update.0);
                            }
                            None => {
                                if let Some(idle) = idle.as_ref() {
                                    idle.handle_grok_models_update(&update.0);
                                }
                            }
                        }
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_request(
                {
                    let registry = registry.clone();
                    async move |request: agent_client_protocol::schema::v1::RequestPermissionRequest, responder, _cx| {
                        let response = match $crate::features::agent::session::handlers::snapshot_turn(&registry) {
                            Some(turn) => {
                                $crate::features::agent::session::handlers::decide_permission(
                                    &turn.ctx.app,
                                    &turn.ctx.session_id,
                                    &turn.permission_policy,
                                    &turn.permission_gate,
                                    &request,
                                )
                                .await
                            }
                            // Warm-idle: deny so an unsupervised agent never acts.
                            None => $crate::features::agent::acp::interaction::permission_response(&request, false),
                        };
                        let _ = responder.respond(response);
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let registry = registry.clone();
                    async move |request: agent_client_protocol::schema::v1::CreateElicitationRequest, responder, _cx| {
                        let response = match $crate::features::agent::session::handlers::snapshot_turn(&registry) {
                            Some(turn) => {
                                $crate::features::agent::acp::interaction::await_user_elicitation(
                                    &turn.ctx.app,
                                    &turn.elicitation_gate,
                                    &turn.ctx.session_id,
                                    &request,
                                )
                                .await
                            }
                            None => {
                                agent_client_protocol::schema::v1::CreateElicitationResponse::new(
                                    agent_client_protocol::schema::v1::ElicitationAction::Cancel,
                                )
                            }
                        };
                        let _ = responder.respond(response);
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let registry = registry.clone();
                    async move |request: $crate::features::agent::acp::ask_user::GrokAskUserRequest, responder, _cx| {
                        let response = match $crate::features::agent::session::handlers::snapshot_turn(&registry) {
                            Some(turn) => {
                                $crate::features::agent::acp::interaction::await_grok_ask_user(
                                    &turn.ctx.app,
                                    &turn.ask_user_gate,
                                    &turn.ctx.session_id,
                                    &request,
                                )
                                .await
                            }
                            None => $crate::features::agent::acp::ask_user::cancelled_response(),
                        };
                        let _ = responder.respond(response);
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
    }};
}
pub(crate) use agentero_turn_builder;
