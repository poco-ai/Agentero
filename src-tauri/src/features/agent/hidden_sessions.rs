use crate::core::error::AppError;
use crate::features::agent::models::{AcpListSessionsResult, AgentResultPayload};
use rusqlite::{params, Connection};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const DATABASE_FILE: &str = "hidden-agent-sessions.sqlite";

/// Persistent index of provider sessions created by non-Composer Agent runs.
///
/// ACP providers own their session history, so Agentero records only the
/// provider ids that must be hidden. The agent and cwd columns keep identical
/// provider ids isolated across configured agents and Vaults.
#[derive(Clone)]
pub struct HiddenAgentSessionStore {
    path: Arc<PathBuf>,
    access: Arc<Mutex<()>>,
}

impl HiddenAgentSessionStore {
    pub fn load() -> Self {
        let store = Self::at_path(crate::core::paths::agentero_config_dir().join(DATABASE_FILE));
        if let Err(error) = store.ensure_schema() {
            log::warn!(
                target: "agentero::agent",
                "failed to initialize hidden Agent session index: {error}"
            );
        }
        store
    }

    fn at_path(path: PathBuf) -> Self {
        Self {
            path: Arc::new(path),
            access: Arc::new(Mutex::new(())),
        }
    }

    pub fn scope(&self, agent_id: String, cwd: PathBuf) -> HiddenSessionScope {
        HiddenSessionScope {
            store: self.clone(),
            agent_id,
            cwd,
        }
    }

    pub fn filter(
        &self,
        agent_id: &str,
        cwd: &Path,
        mut result: AcpListSessionsResult,
    ) -> Result<AcpListSessionsResult, AppError> {
        let hidden = self.provider_session_ids(agent_id, cwd)?;
        result
            .sessions
            .retain(|session| !hidden.contains(&session.session_id));
        Ok(result)
    }

    /// Return the next cursor only when this filtered page contains no
    /// visible sessions. A cursor is consumed at most once so a malformed
    /// provider response cannot make the Host loop forever.
    pub fn next_cursor_after_hidden_page(
        &self,
        result: &AcpListSessionsResult,
        seen_cursors: &mut HashSet<String>,
    ) -> Option<String> {
        if !result.supported || !result.sessions.is_empty() {
            return None;
        }
        let next_cursor = result.next_cursor.clone()?;
        seen_cursors
            .insert(next_cursor.clone())
            .then_some(next_cursor)
    }

    fn record(
        &self,
        agent_id: &str,
        cwd: &Path,
        provider_session_id: &str,
    ) -> Result<(), AppError> {
        let agent_id = agent_id.trim();
        let provider_session_id = provider_session_id.trim();
        if agent_id.is_empty() || provider_session_id.is_empty() {
            return Err(AppError::message(
                "hidden Agent session requires agent and provider session ids",
            ));
        }

        let _guard = self
            .access
            .lock()
            .map_err(|_| AppError::message("hidden Agent session index lock poisoned"))?;
        let mut connection = self.open_connection()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "INSERT OR IGNORE INTO hidden_agent_sessions
             (agent_id, cwd, provider_session_id) VALUES (?1, ?2, ?3)",
            params![agent_id, cwd_key(cwd), provider_session_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    fn provider_session_ids(
        &self,
        agent_id: &str,
        cwd: &Path,
    ) -> Result<HashSet<String>, AppError> {
        let _guard = self
            .access
            .lock()
            .map_err(|_| AppError::message("hidden Agent session index lock poisoned"))?;
        let connection = self.open_connection()?;
        let mut statement = connection.prepare(
            "SELECT provider_session_id FROM hidden_agent_sessions
             WHERE agent_id = ?1 AND cwd = ?2",
        )?;
        let ids = statement
            .query_map(params![agent_id.trim(), cwd_key(cwd)], |row| row.get(0))?
            .collect::<Result<HashSet<String>, _>>()?;
        Ok(ids)
    }

    fn ensure_schema(&self) -> Result<(), AppError> {
        let _guard = self
            .access
            .lock()
            .map_err(|_| AppError::message("hidden Agent session index lock poisoned"))?;
        self.open_connection().map(|_| ())
    }

    fn open_connection(&self) -> Result<Connection, AppError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(self.path.as_ref())?;
        connection.busy_timeout(Duration::from_secs(2))?;
        connection.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             CREATE TABLE IF NOT EXISTS hidden_agent_sessions (
                 agent_id TEXT NOT NULL,
                 cwd TEXT NOT NULL,
                 provider_session_id TEXT NOT NULL,
                 PRIMARY KEY (agent_id, cwd, provider_session_id)
             ) WITHOUT ROWID;",
        )?;

        #[cfg(all(unix, not(target_os = "ios")))]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(self.path.as_ref(), fs::Permissions::from_mode(0o600))?;
        }

        Ok(connection)
    }
}

#[derive(Clone)]
pub struct HiddenSessionScope {
    store: HiddenAgentSessionStore,
    agent_id: String,
    cwd: PathBuf,
}

impl HiddenSessionScope {
    pub fn record_provider_session(&self, provider_session_id: &str) -> Result<(), AppError> {
        self.store
            .record(&self.agent_id, &self.cwd, provider_session_id)
    }

    pub fn record_completed(&self, payload: &AgentResultPayload) -> Result<(), AppError> {
        let Some(provider_session_id) = payload.provider_session_id.as_deref() else {
            return Ok(());
        };
        self.record_provider_session(provider_session_id)
    }
}

fn cwd_key(cwd: &Path) -> String {
    let normalized = cwd.components().collect::<PathBuf>();
    let key = normalized.to_string_lossy();
    if key.is_empty() {
        ".".to_string()
    } else {
        key.into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::agent::models::AcpSessionInfo;
    use uuid::Uuid;

    fn test_store() -> (PathBuf, HiddenAgentSessionStore) {
        let dir =
            std::env::temp_dir().join(format!("agentero-hidden-agent-sessions-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create test directory");
        let store = HiddenAgentSessionStore::at_path(dir.join(DATABASE_FILE));
        (dir, store)
    }

    fn sessions(ids: &[&str]) -> AcpListSessionsResult {
        AcpListSessionsResult {
            sessions: ids
                .iter()
                .map(|id| AcpSessionInfo {
                    session_id: (*id).to_string(),
                    cwd: "/vault-a".to_string(),
                    title: None,
                    updated_at: None,
                })
                .collect(),
            next_cursor: Some("next-page".to_string()),
            supported: true,
        }
    }

    #[test]
    fn filters_only_matching_agent_cwd_and_provider_session() {
        let (dir, store) = test_store();
        store
            .record("agent-a", Path::new("/vault-a"), "provider-hidden")
            .expect("record hidden session");

        let filtered = store
            .filter(
                "agent-a",
                Path::new("/vault-a"),
                sessions(&["provider-visible", "provider-hidden"]),
            )
            .expect("filter matching scope");
        assert_eq!(filtered.sessions.len(), 1);
        assert_eq!(filtered.sessions[0].session_id, "provider-visible");
        assert_eq!(filtered.next_cursor.as_deref(), Some("next-page"));
        assert!(filtered.supported);

        let other_agent = store
            .filter(
                "agent-b",
                Path::new("/vault-a"),
                sessions(&["provider-hidden"]),
            )
            .expect("filter other agent");
        assert_eq!(other_agent.sessions.len(), 1);

        let other_vault = store
            .filter(
                "agent-a",
                Path::new("/vault-b"),
                sessions(&["provider-hidden"]),
            )
            .expect("filter other vault");
        assert_eq!(other_vault.sessions.len(), 1);

        fs::remove_dir_all(dir).expect("remove test directory");
    }

    #[test]
    fn hidden_sessions_survive_store_restart() {
        let (dir, store) = test_store();
        let path = store.path.as_ref().clone();
        store
            .record("agent-a", Path::new("/vault-a/./"), "provider-hidden")
            .expect("record hidden session");
        drop(store);

        let reloaded = HiddenAgentSessionStore::at_path(path);
        let filtered = reloaded
            .filter(
                "agent-a",
                Path::new("/vault-a"),
                sessions(&["provider-hidden", "provider-visible"]),
            )
            .expect("filter after restart");
        assert_eq!(filtered.sessions.len(), 1);
        assert_eq!(filtered.sessions[0].session_id, "provider-visible");

        fs::remove_dir_all(dir).expect("remove test directory");
    }

    #[test]
    fn duplicate_records_are_idempotent() {
        let (dir, store) = test_store();
        for _ in 0..2 {
            store
                .record("agent-a", Path::new("/vault-a"), "provider-hidden")
                .expect("record hidden session");
        }

        let ids = store
            .provider_session_ids("agent-a", Path::new("/vault-a"))
            .expect("read hidden sessions");
        assert_eq!(ids.len(), 1);
        assert!(ids.contains("provider-hidden"));

        fs::remove_dir_all(dir).expect("remove test directory");
    }

    #[test]
    fn scope_records_provider_session_before_a_run_completes() {
        let (dir, store) = test_store();
        let scope = store.scope("agent-a".into(), PathBuf::from("/vault-a"));
        scope
            .record_provider_session("provider-in-progress")
            .expect("record in-progress provider session");

        let filtered = store
            .filter(
                "agent-a",
                Path::new("/vault-a"),
                sessions(&["provider-in-progress", "provider-visible"]),
            )
            .expect("filter in-progress session");
        assert_eq!(filtered.sessions.len(), 1);
        assert_eq!(filtered.sessions[0].session_id, "provider-visible");

        fs::remove_dir_all(dir).expect("remove test directory");
    }

    #[test]
    fn hidden_page_can_advance_once_to_reveal_visible_history() {
        let (dir, store) = test_store();
        store
            .record("agent-a", Path::new("/vault-a"), "provider-hidden")
            .expect("record hidden session");

        let first_page = store
            .filter(
                "agent-a",
                Path::new("/vault-a"),
                AcpListSessionsResult {
                    sessions: vec![AcpSessionInfo {
                        session_id: "provider-hidden".to_string(),
                        cwd: "/vault-a".to_string(),
                        title: None,
                        updated_at: None,
                    }],
                    next_cursor: Some("page-2".to_string()),
                    supported: true,
                },
            )
            .expect("filter first page");
        assert!(first_page.sessions.is_empty());

        let mut seen = HashSet::new();
        assert_eq!(
            store.next_cursor_after_hidden_page(&first_page, &mut seen),
            Some("page-2".to_string())
        );

        let visible_page = store
            .filter(
                "agent-a",
                Path::new("/vault-a"),
                sessions(&["provider-visible"]),
            )
            .expect("filter visible page");
        assert_eq!(
            store.next_cursor_after_hidden_page(&visible_page, &mut seen),
            None
        );

        fs::remove_dir_all(dir).expect("remove test directory");
    }

    #[test]
    fn repeated_hidden_page_cursor_stops_pagination() {
        let (dir, store) = test_store();
        let hidden_page = AcpListSessionsResult {
            sessions: vec![],
            next_cursor: Some("same-page".to_string()),
            supported: true,
        };
        let mut seen = HashSet::from(["same-page".to_string()]);

        assert_eq!(
            store.next_cursor_after_hidden_page(&hidden_page, &mut seen),
            None
        );
        fs::remove_dir_all(dir).expect("remove test directory");
    }
}
