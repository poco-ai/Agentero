//! Session model / mode / effort / fast-mode preference types and warm helpers.
//!
//! Warm applies model + collaboration via [`apply_model_and_collaboration_prefs`].
//! Run wraps the same helper with cancellation before applying effort / fast mode.

use crate::features::agent::acp::client::timed_acp_request;
use crate::features::agent::acp::updates::{
    collaboration_from_config_options, models_from_config_options,
};
use agent_client_protocol::schema::v1::{
    SessionConfigId, SessionConfigOption, SessionConfigOptionValue, SessionId,
    SetSessionConfigOptionRequest,
};
use agent_client_protocol::{Agent, ConnectionTo};

/// User-selected session preferences applied after the session opens.
#[derive(Debug, Clone, Default)]
pub struct RunPreferences {
    pub model_id: Option<String>,
    pub force_model: bool,
    pub collaboration_mode_id: Option<String>,
    pub reasoning_effort: Option<String>,
    pub prefer_highest_reasoning_effort: bool,
    /// Translation turns pick the lowest advertised effort (`none` / `off` /
    /// `minimal` / `low`, …) so the agent does not spend a reasoning pass on
    /// a closed transform. Ignored when an explicit effort is set.
    pub prefer_lowest_reasoning_effort: bool,
    pub fast_mode: Option<bool>,
}

impl RunPreferences {
    /// Translation is a closed transform: do not request the agent's highest
    /// reasoning effort. An explicit user effort still wins.
    pub fn for_workflow(
        workflow: Option<&str>,
        model_id: Option<String>,
        collaboration_mode_id: Option<String>,
        reasoning_effort: Option<String>,
        prefer_highest_reasoning_effort: bool,
        fast_mode: Option<bool>,
    ) -> Self {
        let prefer_lowest = workflow == Some("translate") && reasoning_effort.is_none();
        Self {
            model_id,
            force_model: false,
            collaboration_mode_id,
            reasoning_effort,
            prefer_highest_reasoning_effort: prefer_highest_reasoning_effort && !prefer_lowest,
            prefer_lowest_reasoning_effort: prefer_lowest,
            fast_mode,
        }
    }

    pub fn resolve_reasoning_effort(
        &self,
        choices: &[crate::features::agent::models::AgentEffortChoice],
    ) -> Option<String> {
        if self.reasoning_effort.is_some() {
            return self.reasoning_effort.clone();
        }
        if self.prefer_lowest_reasoning_effort {
            return lowest_known_effort(choices);
        }
        if !self.prefer_highest_reasoning_effort {
            return None;
        }
        // ACP supplies no rank. Keep this known ordering in sync with reasoning-effort.ts.
        let order = [
            "none", "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
        ];
        let mut highest = None;
        for choice in choices {
            let rank = order
                .iter()
                .position(|id| *id == choice.id.to_ascii_lowercase())?;
            if highest.as_ref().is_none_or(|(best, _)| rank > *best) {
                highest = Some((rank, choice.id.clone()));
            }
        }
        highest.map(|(_, id)| id)
    }
}

/// Lowest id in the known effort order. An unrecognized id makes the whole
/// catalog unresolved, matching the highest-effort path, so we never invent
/// an effort the agent did not list under a name we understand.
fn lowest_known_effort(
    choices: &[crate::features::agent::models::AgentEffortChoice],
) -> Option<String> {
    let order = [
        "none", "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
    ];
    let mut lowest = None;
    for choice in choices {
        let rank = order
            .iter()
            .position(|id| *id == choice.id.to_ascii_lowercase())?;
        if lowest.as_ref().is_none_or(|(best, _)| rank < *best) {
            lowest = Some((rank, choice.id.clone()));
        }
    }
    lowest.map(|(_, id)| id)
}

/// Apply model and collaboration preferences, retaining the full ACP response.
/// Explicit model choices bypass current-value deduplication; automatic setup does not.
/// Failures are logged and do not abort setup.
pub(crate) async fn apply_model_and_collaboration_prefs(
    connection: &ConnectionTo<Agent>,
    runtime_session_id: &str,
    agent_id: &str,
    acp_session_id: &SessionId,
    mut config_options: Vec<SessionConfigOption>,
    prefs: &RunPreferences,
) -> Vec<SessionConfigOption> {
    if let Some(ev) = models_from_config_options(runtime_session_id, agent_id, &config_options) {
        // Attempt preferred model even when not in the advertised catalog
        // (third-party / gateway free-form ids).
        if let Some(pref) = prefs.model_id.as_ref() {
            if prefs.force_model || *pref != ev.current_id {
                let listed = ev.models.iter().any(|m| m.id == *pref);
                match timed_acp_request(
                    "set model",
                    connection
                        .send_request(SetSessionConfigOptionRequest::new(
                            acp_session_id.clone(),
                            SessionConfigId::new(ev.config_id.as_str()),
                            SessionConfigOptionValue::value_id(pref.clone()),
                        ))
                        .block_task(),
                )
                .await
                {
                    Ok(response) => {
                        config_options = response.config_options;
                    }
                    Err(e) => {
                        log::debug!(
                            target: "agentero::agent",
                            "agent={} set model failed (listed={}): pref={} err={}",
                            agent_id,
                            listed,
                            pref,
                            e
                        );
                    }
                }
            }
        }
    }
    if let Some(pref) = prefs.collaboration_mode_id.as_ref() {
        if let Some(ev) =
            collaboration_from_config_options(runtime_session_id, agent_id, &config_options)
        {
            if *pref != ev.current_id && ev.modes.iter().any(|mode| mode.id == *pref) {
                match timed_acp_request(
                    "set collaboration mode",
                    connection
                        .send_request(SetSessionConfigOptionRequest::new(
                            acp_session_id.clone(),
                            SessionConfigId::new(ev.config_id.as_str()),
                            SessionConfigOptionValue::value_id(pref.clone()),
                        ))
                        .block_task(),
                )
                .await
                {
                    Ok(response) => {
                        config_options = response.config_options;
                    }
                    Err(e) => {
                        log::debug!(
                            target: "agentero::agent",
                            "agent={} set collaboration mode failed: pref={} err={}",
                            agent_id,
                            pref,
                            e
                        );
                    }
                }
            }
        }
    }
    config_options
}

#[cfg(test)]
mod tests {
    use super::RunPreferences;
    use crate::features::agent::models::AgentEffortChoice;

    fn choices(ids: &[&str]) -> Vec<AgentEffortChoice> {
        ids.iter()
            .map(|id| AgentEffortChoice {
                id: id.to_string(),
                name: id.to_string(),
                description: None,
            })
            .collect()
    }

    #[test]
    fn resolves_highest_after_model_setup_without_warm_options() {
        let prefs = RunPreferences {
            prefer_highest_reasoning_effort: true,
            ..Default::default()
        };
        assert_eq!(
            prefs
                .resolve_reasoning_effort(&choices(&["xhigh", "low", "high"]))
                .as_deref(),
            Some("xhigh")
        );
        assert_eq!(
            prefs
                .resolve_reasoning_effort(&choices(&["low", "max", "xhigh"]))
                .as_deref(),
            Some("max")
        );
    }

    #[test]
    fn explicit_effort_takes_precedence_over_highest() {
        let prefs = RunPreferences {
            reasoning_effort: Some("medium".into()),
            prefer_highest_reasoning_effort: true,
            ..Default::default()
        };
        assert_eq!(
            prefs
                .resolve_reasoning_effort(&choices(&["low", "medium", "xhigh"]))
                .as_deref(),
            Some("medium")
        );
    }

    #[test]
    fn no_override_for_other_callers_or_unknown_orderings() {
        assert!(RunPreferences::default()
            .resolve_reasoning_effort(&choices(&["low", "high"]))
            .is_none());
        let prefs = RunPreferences {
            prefer_highest_reasoning_effort: true,
            ..Default::default()
        };
        assert!(prefs
            .resolve_reasoning_effort(&choices(&["deep", "high"]))
            .is_none());
        assert!(prefs.resolve_reasoning_effort(&[]).is_none());
    }

    #[test]
    fn translate_workflow_requests_the_lowest_advertised_effort() {
        let prefs = RunPreferences::for_workflow(Some("translate"), None, None, None, true, None);
        assert!(prefs.prefer_lowest_reasoning_effort);
        assert!(!prefs.prefer_highest_reasoning_effort);
        assert_eq!(
            prefs
                .resolve_reasoning_effort(&choices(&["high", "none", "low"]))
                .as_deref(),
            Some("none")
        );
        assert_eq!(
            prefs
                .resolve_reasoning_effort(&choices(&["high", "low"]))
                .as_deref(),
            Some("low")
        );
        // Unknown ordering: do not guess a value the session did not advertise
        // under a name we can rank.
        assert!(prefs
            .resolve_reasoning_effort(&choices(&["deep", "high"]))
            .is_none());
    }

    #[test]
    fn explicit_effort_beats_translate_lowest() {
        let prefs = RunPreferences::for_workflow(
            Some("translate"),
            None,
            None,
            Some("high".into()),
            false,
            None,
        );
        assert!(!prefs.prefer_lowest_reasoning_effort);
        assert_eq!(
            prefs
                .resolve_reasoning_effort(&choices(&["none", "low", "high"]))
                .as_deref(),
            Some("high")
        );
    }
    fn model_options(current: &str) -> Vec<agent_client_protocol::schema::v1::SessionConfigOption> {
        use agent_client_protocol::schema::v1::{
            SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelectOption,
        };
        vec![SessionConfigOption::select(
            "model",
            "Model",
            current.to_string(),
            vec![SessionConfigSelectOption::new("sonnet", "Sonnet")],
        )
        .category(SessionConfigOptionCategory::Model)]
    }

    #[tokio::test]
    async fn explicit_model_selection_corrects_a_misreported_current_model() {
        use super::apply_model_and_collaboration_prefs;
        use agent_client_protocol::schema::v1::{
            SessionConfigOption, SessionConfigOptionCategory, SessionConfigOptionValue,
            SessionConfigSelectOption, SessionId, SetSessionConfigOptionRequest,
            SetSessionConfigOptionResponse,
        };
        use agent_client_protocol::{Agent, Client};
        use std::sync::{Arc, Mutex};

        // Like the Claude ACP failure: advertised sonnet, actually running opus.
        let actual_model = Arc::new(Mutex::new("opus".to_string()));
        let observed = actual_model.clone();
        let agent = Agent.builder().on_receive_request(
            async move |request: SetSessionConfigOptionRequest, responder, _connection| {
                assert_eq!(request.session_id.to_string(), "provider-session");
                assert_eq!(request.config_id.to_string(), "model");
                let SessionConfigOptionValue::ValueId { value } = request.value else {
                    panic!("expected a model id");
                };
                *actual_model.lock().unwrap() = value.to_string();
                let mut options = model_options(&value.to_string());
                // Model changes can replace the effort catalog; retain the whole response.
                options.push(
                    SessionConfigOption::select(
                        "effort",
                        "Effort",
                        "high",
                        vec![SessionConfigSelectOption::new("high", "High")],
                    )
                    .category(SessionConfigOptionCategory::ThoughtLevel),
                );
                responder.respond(SetSessionConfigOptionResponse::new(options))
            },
            agent_client_protocol::on_receive_request!(),
        );
        Client
            .builder()
            .connect_with(agent, async |connection| {
                let session = SessionId::new("provider-session");
                let mut prefs = RunPreferences {
                    model_id: Some("sonnet".into()),
                    ..Default::default()
                };
                // Automatic warm/restore still deduplicates an equal reported value.
                let options = apply_model_and_collaboration_prefs(
                    &connection,
                    "runtime",
                    "claude",
                    &session,
                    model_options("sonnet"),
                    &prefs,
                )
                .await;
                assert_eq!(*observed.lock().unwrap(), "opus");
                assert_eq!(options.len(), 1);

                prefs.force_model = true;
                let options = apply_model_and_collaboration_prefs(
                    &connection,
                    "runtime",
                    "claude",
                    &session,
                    options,
                    &prefs,
                )
                .await;
                assert_eq!(*observed.lock().unwrap(), "sonnet");
                let effort = crate::features::agent::acp::updates::effort_from_config_options(
                    "runtime", "claude", &options,
                )
                .expect("the model response must retain the effort catalog");
                assert_eq!(effort.current_id, "high");

                // Free-form gateway ids remain supported by the shared warm/run helper.
                prefs.model_id = Some("gateway/custom-model".into());
                prefs.force_model = false;
                apply_model_and_collaboration_prefs(
                    &connection,
                    "runtime",
                    "claude",
                    &session,
                    options,
                    &prefs,
                )
                .await;
                assert_eq!(*observed.lock().unwrap(), "gateway/custom-model");
                Ok(())
            })
            .await
            .unwrap();
    }
}
