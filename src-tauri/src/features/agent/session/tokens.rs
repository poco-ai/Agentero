//! Turn the ACP end-of-turn usage snapshot into one local `agent.usage` row.
//!
//! `schema::v1::Usage` comments describe session totals, while `PromptResponse`
//! calls the same object "this turn". Compare against the previous snapshot
//! for this chat: a non-decreasing total is a cumulative counter and only the
//! difference is stored; a drop means the counter restarted, so the new value
//! is the whole turn.

use std::collections::HashMap;
use std::sync::Mutex;

use agentero_core::usage::{record_events, telemetry_projection, usage_db_path, UsageRecord};
use serde_json::json;
use tauri::{AppHandle, Manager};

static LAST_TOTAL: Mutex<Option<HashMap<String, u64>>> = Mutex::new(None);

pub(crate) fn observe_total(session_id: &str, total: u64) -> u64 {
    let mut guard = LAST_TOTAL.lock().unwrap_or_else(|err| err.into_inner());
    let seen = guard.get_or_insert_with(HashMap::new);
    let last = seen.get(session_id).copied().unwrap_or(0);
    let (delta, next) = if total >= last {
        (total - last, total)
    } else {
        (total, total)
    };
    seen.insert(session_id.to_string(), next);
    delta
}

pub(crate) fn record_turn_tokens(
    app: &AppHandle,
    session_id: &str,
    vault: Option<&str>,
    path: Option<&str>,
    workflow: &str,
    total: u64,
) {
    let delta = observe_total(session_id, total);
    let Ok(qty) = i64::try_from(delta) else {
        return;
    };
    if qty == 0 {
        return;
    }
    let event = UsageRecord {
        ts: None,
        vault: vault
            .map(str::trim)
            .filter(|vault| !vault.is_empty())
            .map(str::to_string),
        kind: "agent.usage".into(),
        path: path
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(str::to_string),
        mode: None,
        dur_ms: None,
        extra: Some(json!({
            "workflow": workflow,
            "totalTokens": qty,
        })),
    };
    if let Some(telemetry) = app.try_state::<std::sync::Arc<crate::core::telemetry::Telemetry>>() {
        if let Some(projection) = telemetry_projection(&event) {
            telemetry.capture_activity(std::slice::from_ref(&projection));
        }
    }
    if let Err(error) = record_events(&usage_db_path(), std::slice::from_ref(&event)) {
        log::warn!(target: "agentero::usage", "record agent.usage failed: {error}");
    }
}
