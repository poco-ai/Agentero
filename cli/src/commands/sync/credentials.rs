//! The OS credential entry stores the same JSON envelope used for stdin.
use serde_json::{json, Value};

pub(super) const SERVICE: &str = "app.agentero.sync";

pub(super) fn account(backend: &str, target: &str, identity: &str) -> String {
    json!([
        backend,
        target.trim().trim_end_matches('/'),
        identity.trim()
    ])
    .to_string()
}

pub(super) fn read(
    backend: &str,
    target: &str,
    identity: &str,
) -> serde_json::Result<Option<Value>> {
    let Ok(entry) = keyring::Entry::new(SERVICE, &account(backend, target, identity)) else {
        return Ok(None);
    };
    // A headless session can lack access to the OS credential store. In that
    // case the caller still has its saved vault binding and interactive input.
    let Ok(envelope) = entry.get_password() else {
        return Ok(None);
    };
    serde_json::from_str(&envelope).map(Some)
}
