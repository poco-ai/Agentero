//! Remember source-scope fingerprints across ACP sessions.

use crate::error::AppError;
use std::fs;
use std::path::{Path, PathBuf};

const SESSIONS_REL: &str = ".agentero/context-sessions";
const FINGERPRINTS_FILE: &str = "fingerprints.json";

/// Resume only when the stored fingerprint is exactly this turn's fingerprint.
/// A missing record is a refusal: an older session must not gain a new grant.
pub fn resume_allowed(stored: Option<&str>, next: &str) -> bool {
    stored == Some(next)
}

pub fn session_fingerprint(vault: &Path, provider_session_id: &str) -> Option<String> {
    let map = read_fingerprints(vault);
    map.get(provider_session_id).cloned()
}

pub fn remember_session_fingerprint(
    vault: &Path,
    provider_session_id: &str,
    fingerprint: &str,
) -> Result<(), AppError> {
    if provider_session_id.trim().is_empty() || fingerprint.is_empty() {
        return Ok(());
    }
    static WRITER: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _writer = WRITER.lock().unwrap_or_else(|e| e.into_inner());
    let mut map = read_fingerprints(vault);
    map.insert(provider_session_id.to_string(), fingerprint.to_string());
    let path = fingerprint_file(vault);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut tmp = tempfile::NamedTempFile::new_in(path.parent().expect("fingerprint directory"))?;
    serde_json::to_writer(tmp.as_file_mut(), &map)?;
    tmp.persist(path).map_err(|e| e.error)?;
    Ok(())
}

fn fingerprint_file(vault: &Path) -> PathBuf {
    vault.join(SESSIONS_REL).join(FINGERPRINTS_FILE)
}

fn read_fingerprints(vault: &Path) -> std::collections::BTreeMap<String, String> {
    let Ok(body) = fs::read_to_string(fingerprint_file(vault)) else {
        return std::collections::BTreeMap::new();
    };
    serde_json::from_str(&body).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_fingerprint_does_not_resume() {
        assert!(!resume_allowed(None, "abc"));
        assert!(!resume_allowed(Some("old"), "abc"));
        assert!(resume_allowed(Some("abc"), "abc"));
    }
}
