//! Session model / mode / effort / fast-mode preference types and warm helpers.
//!
//! Warm applies model + collaboration via [`apply_model_and_collaboration_prefs`].
//! Run's cancel-aware `apply_session_preferences` (model/collab/effort/fast) remains
//! on `RunOnceContext` in `run.rs` because it is tightly coupled to cancellation
//! and `agent:completed` emission.

use crate::features::agent::acp::client::{timed_acp_request, wait_for_cancellation};
use crate::features::agent::acp::updates::{
    collaboration_from_config_options, models_from_config_options,
};
use crate::features::agent::models::AgentModelsEvent;
use agent_client_protocol::v1::schema::{
    SessionConfigId, SessionConfigOption, SessionConfigOptionValue, SessionId,
    SetSessionConfigOptionRequest,
};
use agent_client_protocol::{v1::ConnectionTo, Agent};

/// User-selected session preferences applied after the session opens.
#[derive(Debug, Clone, Default)]
pub(crate) struct RunPreferences {
    pub model_id: Option<String>,
    /// Set for an explicit user pick: always send one `set_config_option` even
    /// when the agent reports the same model as current (Fix #1087).
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
        force_model: bool,
        collaboration_mode_id: Option<String>,
        reasoning_effort: Option<String>,
        prefer_highest_reasoning_effort: bool,
        fast_mode: Option<bool>,
    ) -> Self {
        let prefer_lowest = workflow == Some("translate") && reasoning_effort.is_none();
        Self {
            model_id,
            force_model,
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

/// Whether the model preference needs a `session/set_config_option` request.
///
/// `force` marks an explicit user pick. The agent's reported `current` is not
/// proof of the running model (claude-acp reports the settings-file model while
/// the process runs `env.ANTHROPIC_MODEL`, see #1087), so a pick — including
/// re-picking the model the agent claims is current — is always sent. Automatic
/// warm / restore keeps the dedupe. An unreported current is unknown and always
/// sends.
pub(crate) fn model_change_needed(current_id: &str, model_id: &str, force: bool) -> bool {
    let pref = model_id.trim();
    if pref.is_empty() {
        return false;
    }
    force || current_id.trim().is_empty() || pref != current_id.trim()
}

/// Result of applying the model preference to an open ACP session.
pub(crate) enum ModelApply {
    /// Nothing changed: the preference already matched, or the set failed.
    Unchanged,
    /// The agent returned fresh config options after a successful set.
    Updated(Vec<SessionConfigOption>),
    /// The caller's cancellation fired before the set settled.
    Cancelled,
}

/// Send the model preference through ACP when [`model_change_needed`] says so.
///
/// Shared by the warm and run paths so the "same model" decision, the attempt
/// for ids outside the advertised catalog, and the failure log cannot drift
/// apart. A rejected/timed-out set is logged as a warning and leaves the config
/// options unchanged; the caller decides whether that ends the turn.
pub(crate) async fn apply_model_preference(
    connection: &ConnectionTo<Agent>,
    agent_id: &str,
    acp_session_id: &SessionId,
    models: &AgentModelsEvent,
    model_id: &str,
    force: bool,
    cancellation: Option<&mut tokio::sync::watch::Receiver<bool>>,
) -> ModelApply {
    if !model_change_needed(&models.current_id, model_id, force) {
        return ModelApply::Unchanged;
    }
    let pref = model_id.trim().to_string();
    // Attempt the preferred model even when it is not in the advertised
    // catalog (third-party / gateway free-form ids).
    let listed = models.models.iter().any(|m| m.id == pref);
    let request = timed_acp_request(
        "set model",
        connection
            .send_request(SetSessionConfigOptionRequest::new(
                acp_session_id.clone(),
                SessionConfigId::new(models.config_id.as_str()),
                SessionConfigOptionValue::value_id(pref.clone()),
            ))
            .block_task(),
    );
    let response = match cancellation {
        Some(cancel) => tokio::select! {
            response = request => response,
            () = wait_for_cancellation(cancel) => return ModelApply::Cancelled,
        },
        None => request.await,
    };
    match response {
        Ok(response) => ModelApply::Updated(response.config_options),
        Err(error) => {
            log::warn!(
                target: "agentero::agent",
                "agent={} set model failed (listed={} force={}): pref={} err={}",
                agent_id,
                listed,
                force,
                pref,
                error
            );
            ModelApply::Unchanged
        }
    }
}

/// Apply preferred model (free-form) and collaboration mode after session/new.
/// Failures are logged and do not abort the warm path.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn apply_model_and_collaboration_prefs(
    connection: &ConnectionTo<Agent>,
    runtime_session_id: &str,
    agent_id: &str,
    acp_session_id: &SessionId,
    mut config_options: Vec<SessionConfigOption>,
    preferred_model: Option<String>,
    force_model: bool,
    preferred_collab: Option<String>,
) -> Vec<SessionConfigOption> {
    if let Some(ev) = models_from_config_options(runtime_session_id, agent_id, &config_options) {
        if let Some(pref) = preferred_model.as_deref() {
            match apply_model_preference(
                connection,
                agent_id,
                acp_session_id,
                &ev,
                pref,
                force_model,
                None,
            )
            .await
            {
                ModelApply::Updated(options) => config_options = options,
                // Warm has no cancellation source; Unchanged keeps the options.
                ModelApply::Unchanged | ModelApply::Cancelled => {}
            }
        }
    }
    if let Some(pref) = preferred_collab {
        if let Some(ev) =
            collaboration_from_config_options(runtime_session_id, agent_id, &config_options)
        {
            if pref != ev.current_id && ev.modes.iter().any(|mode| mode.id == pref) {
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
                            "agent={} warm set collaboration mode failed: pref={} err={}",
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
    use super::{model_change_needed, RunPreferences};
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
    fn changing_to_the_reported_current_is_skipped_unless_forced() {
        // Automatic warm / restore: the agent reports the same model.
        assert!(!model_change_needed("sonnet", "sonnet", false));
        // Explicit pick, including re-picking the reported current: always send.
        assert!(model_change_needed("sonnet", "sonnet", true));
        // Different model either way.
        assert!(model_change_needed("opus", "sonnet", false));
        // Unknown current (legacy payload without currentModelId) always sends.
        assert!(model_change_needed("", "sonnet", false));
        // No preference is never a request, forced or not.
        assert!(!model_change_needed("sonnet", "  ", true));
        // Whitespace is not a different model.
        assert!(!model_change_needed(" sonnet ", "sonnet", false));
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
        let prefs =
            RunPreferences::for_workflow(Some("translate"), None, false, None, None, true, None);
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
            false,
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
}
