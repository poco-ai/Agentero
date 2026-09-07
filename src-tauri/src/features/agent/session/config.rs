//! Session model / mode / effort / fast-mode preference types.
//!
//! Preference *application* (`session/set_config_option`) currently lives on
//! `RunOnceContext` in `run.rs` because it is tightly coupled to cancellation
//! and `agent:completed` emission. Warm uses the same ACP helpers from
//! `acp::updates` directly.

/// User-selected session preferences applied after the session opens.
#[derive(Debug, Clone, Default)]
pub(crate) struct RunPreferences {
    pub model_id: Option<String>,
    pub collaboration_mode_id: Option<String>,
    pub reasoning_effort: Option<String>,
    pub prefer_highest_reasoning_effort: bool,
    pub fast_mode: Option<bool>,
}

impl RunPreferences {
    pub fn resolve_reasoning_effort(
        &self,
        choices: &[crate::features::agent::models::AgentEffortChoice],
    ) -> Option<String> {
        if self.reasoning_effort.is_some() {
            return self.reasoning_effort.clone();
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
}
