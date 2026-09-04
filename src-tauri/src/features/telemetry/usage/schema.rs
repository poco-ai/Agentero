//! usage.sqlite schema and open/migrate helpers.
//!
//! First shipped shape: vaults + typed events + daily rollup + reserved memories.

use crate::core::error::AppError;
use crate::core::paths;
use rusqlite::Connection;
use std::fs;
use std::path::Path;

/// Current usage schema version written to `schema_meta`.
pub const SCHEMA_VERSION: i32 = 1;

/// Raw events older than this are pruned on open.
pub const EVENT_RETENTION_DAYS: i32 = 180;

/// Daily aggregates older than this are pruned on open.
pub const DAILY_RETENTION_DAYS: i32 = 730;

const DDL_V1: &str = r#"
CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_vaults (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    path       TEXT    NOT NULL UNIQUE,
    created_at TEXT    NOT NULL,
    last_seen  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         TEXT    NOT NULL,
    vault      TEXT,
    kind       TEXT    NOT NULL,
    path       TEXT,
    paper_path TEXT,
    mode       TEXT,
    facet      TEXT,
    status     TEXT,
    dur_ms     INTEGER,
    qty        INTEGER,
    extra      TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_events_ts     ON usage_events(ts);
CREATE INDEX IF NOT EXISTS idx_usage_events_vault  ON usage_events(vault, ts);
CREATE INDEX IF NOT EXISTS idx_usage_events_kind   ON usage_events(kind, ts);
CREATE INDEX IF NOT EXISTS idx_usage_events_path   ON usage_events(path, ts);
CREATE INDEX IF NOT EXISTS idx_usage_events_paper  ON usage_events(paper_path, ts);
CREATE INDEX IF NOT EXISTS idx_usage_events_facet  ON usage_events(kind, facet, ts);

CREATE TABLE IF NOT EXISTS usage_daily (
    day        TEXT    NOT NULL,
    vault      TEXT    NOT NULL DEFAULT '',
    kind       TEXT    NOT NULL,
    paper_path TEXT    NOT NULL DEFAULT '',
    facet      TEXT    NOT NULL DEFAULT '',
    count      INTEGER NOT NULL DEFAULT 0,
    dur_ms     INTEGER NOT NULL DEFAULT 0,
    qty        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, vault, kind, paper_path, facet)
);

CREATE TABLE IF NOT EXISTS usage_memories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    vault      TEXT,
    text       TEXT    NOT NULL,
    source     TEXT    NOT NULL DEFAULT 'user',
    enabled    INTEGER NOT NULL DEFAULT 1,
    created_at TEXT    NOT NULL,
    updated_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_memories_vault ON usage_memories(vault, enabled);
"#;

/// Default on-disk path: `$XDG_DATA_HOME/agentero/usage.sqlite`.
pub fn usage_db_path() -> std::path::PathBuf {
    paths::usage_db_path()
}

/// Open the process default usage database, creating it if needed.
pub fn ensure_usage() -> Result<Connection, AppError> {
    ensure_usage_at(&usage_db_path())
}

/// Open (or create) a usage database at `db_path`.
pub fn ensure_usage_at(db_path: &Path) -> Result<Connection, AppError> {
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let conn = crate::core::sqlite::open_standard(db_path, crate::core::sqlite::DbMsgs::USAGE)?;
    migrate(&conn)?;
    prune(&conn)?;
    Ok(conn)
}

pub fn schema_version(conn: &Connection) -> Result<i32, AppError> {
    crate::core::sqlite::read_schema_version(conn, crate::core::sqlite::DbMsgs::USAGE)
}

fn migrate(conn: &Connection) -> Result<(), AppError> {
    let version = schema_version(conn).unwrap_or(0);
    // Dev builds briefly stamped this same table shape as 2. Relabel only.
    if version == 2 {
        set_schema_version(conn, SCHEMA_VERSION)?;
        return Ok(());
    }
    if version > SCHEMA_VERSION {
        return Err(AppError::message(format!(
            "usage schema version {version} is newer than this app supports ({SCHEMA_VERSION}); upgrade Agentero"
        )));
    }
    if version < 1 {
        conn.execute_batch(DDL_V1)
            .map_err(|e| AppError::message(format!("usage migrate v1: {e}")))?;
        set_schema_version(conn, SCHEMA_VERSION)?;
    }
    Ok(())
}

fn set_schema_version(conn: &Connection, version: i32) -> Result<(), AppError> {
    crate::core::sqlite::write_schema_version(conn, version, crate::core::sqlite::DbMsgs::USAGE)
}

fn prune(conn: &Connection) -> Result<(), AppError> {
    conn.execute(
        "DELETE FROM usage_events WHERE substr(ts, 1, 10) < date('now', ?1)",
        [format!("-{EVENT_RETENTION_DAYS} days")],
    )
    .map_err(|e| AppError::message(format!("prune usage_events: {e}")))?;
    conn.execute(
        "DELETE FROM usage_daily WHERE day < date('now', ?1)",
        [format!("-{DAILY_RETENTION_DAYS} days")],
    )
    .map_err(|e| AppError::message(format!("prune usage_daily: {e}")))?;
    Ok(())
}

/// `papers/<id>/…` → `papers/<id>`; anything else stays `None`.
// Used by event writes and paper-level rollups.
pub fn paper_path_of(path: &str) -> Option<String> {
    let path = path.trim().replace('\\', "/");
    let path = path.trim_matches('/');
    let rest = path.strip_prefix("papers/")?;
    let id = rest.split('/').next().filter(|s| !s.is_empty())?;
    Some(format!("papers/{id}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agentero-usage-schema-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn paper_path_of_extracts_paper_folder() {
        assert_eq!(
            paper_path_of("papers/1706.03762/NOTES.md").as_deref(),
            Some("papers/1706.03762")
        );
        assert_eq!(
            paper_path_of("papers/1706.03762").as_deref(),
            Some("papers/1706.03762")
        );
        assert_eq!(paper_path_of("notes/weekly.md"), None);
        assert_eq!(paper_path_of(""), None);
    }

    #[test]
    fn ensure_usage_creates_schema() {
        let dir = temp_dir();
        let db = dir.join("usage.sqlite");
        let conn = ensure_usage_at(&db).expect("ensure");
        assert_eq!(schema_version(&conn).unwrap(), SCHEMA_VERSION);
        let tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table'
                 AND name IN ('usage_events','usage_daily','usage_vaults','usage_memories')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 4);
        let has_facet: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('usage_events') WHERE name = 'facet'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_facet, 1);
        drop(conn);
        let conn2 = ensure_usage_at(&db).expect("reopen");
        assert_eq!(schema_version(&conn2).unwrap(), SCHEMA_VERSION);
        let _ = fs::remove_dir_all(&dir);
    }
}
