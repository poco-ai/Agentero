//! XDG `feeds.sqlite`: subscriptions + cached items.

use crate::core::error::AppError;
use crate::core::paths;
use rusqlite::Connection;
use std::fs;
use std::path::Path;

pub const SCHEMA_VERSION: i32 = 4;
pub const ITEMS_PER_FEED: i64 = 200;

const DDL_V1: &str = r#"
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id              TEXT PRIMARY KEY,
  url             TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  added_at        TEXT NOT NULL,
  last_fetched_at TEXT,
  last_error      TEXT,
  etag            TEXT,
  last_modified   TEXT
);

CREATE TABLE IF NOT EXISTS items (
  id               TEXT PRIMARY KEY,
  subscription_id  TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  guid             TEXT NOT NULL,
  title            TEXT NOT NULL,
  url              TEXT,
  published_at     TEXT,
  summary_text     TEXT,
  content_html     TEXT,
  paper_url        TEXT,
  imported_at      TEXT,
  first_seen_at    TEXT NOT NULL,
  UNIQUE (subscription_id, guid)
);

CREATE INDEX IF NOT EXISTS items_timeline
  ON items (published_at DESC, first_seen_at DESC);
"#;

const MIGRATE_V1_TO_V2: &str = r#"
ALTER TABLE subscriptions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN pinned_at TEXT;
ALTER TABLE items ADD COLUMN body_markdown TEXT;
"#;

// Schema v3: data migration — normalize timestamp columns to canonical RFC
// 3339 millis. Legacy `now` stamps used bare `to_rfc3339()` (`+00:00`, 0/3/6/9
// fraction digits) which breaks the string `ORDER BY` on `pinned_at`,
// `added_at` and `COALESCE(published_at, first_seen_at)`.

pub fn feeds_db_path() -> std::path::PathBuf {
    paths::feeds_db_path()
}

pub fn ensure_feeds() -> Result<Connection, AppError> {
    ensure_feeds_at(&feeds_db_path())
}

pub fn ensure_feeds_at(db_path: &Path) -> Result<Connection, AppError> {
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let conn = crate::core::sqlite::open_standard(db_path, crate::core::sqlite::DbMsgs::FEEDS)?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<(), AppError> {
    let version = schema_version(conn).unwrap_or(0);
    if version > SCHEMA_VERSION {
        return Err(AppError::message(format!(
            "feeds schema version {version} is newer than this app supports ({SCHEMA_VERSION})"
        )));
    }
    if version < 1 {
        conn.execute_batch(DDL_V1)
            .map_err(|e| AppError::message(format!("feeds migrate v1: {e}")))?;
        set_schema_version(conn, 1)?;
    }
    let version = schema_version(conn).unwrap_or(0);
    if version < 2 {
        for stmt in MIGRATE_V1_TO_V2.split(';') {
            let s = stmt.trim();
            if s.is_empty() {
                continue;
            }
            match conn.execute_batch(&format!("{s};")) {
                Ok(()) => {}
                Err(e) => {
                    let msg = e.to_string();
                    if msg.contains("duplicate column name") {
                        continue;
                    }
                    return Err(AppError::message(format!("feeds migrate v2: {e}")));
                }
            }
        }
        set_schema_version(conn, 2)?;
    }
    let version = schema_version(conn).unwrap_or(0);
    if version < 3 {
        // Data-only: rewrite legacy timestamp values to canonical millis form.
        // Idempotent — canonical values pass through, unparseable ones are kept.
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| AppError::message(format!("feeds migrate v3 tx: {e}")))?;
        crate::core::time::normalize_timestamp_columns(
            &tx,
            "subscriptions",
            "id",
            &["added_at", "pinned_at", "last_fetched_at"],
        )
        .map_err(|e| AppError::message(format!("feeds migrate v3 subs: {e}")))?;
        crate::core::time::normalize_timestamp_columns(
            &tx,
            "items",
            "id",
            &["first_seen_at", "imported_at", "published_at"],
        )
        .map_err(|e| AppError::message(format!("feeds migrate v3 items: {e}")))?;
        tx.commit()
            .map_err(|e| AppError::message(format!("feeds migrate v3 commit: {e}")))?;
        set_schema_version(conn, 3)?;
    }
    let version = schema_version(conn).unwrap_or(0);
    if version < 4 {
        // Article→Markdown math conversion changed (env unwrapping, HTML
        // artifact cleanup, placeholder restore fix); cached bodies from
        // older versions may show broken math. Re-resolve on next open.
        conn.execute("UPDATE items SET body_markdown = NULL", [])
            .map_err(|e| AppError::message(format!("feeds migrate v4: {e}")))?;
        set_schema_version(conn, 4)?;
    }
    Ok(())
}

fn schema_version(conn: &Connection) -> Result<i32, AppError> {
    crate::core::sqlite::read_schema_version(conn, crate::core::sqlite::DbMsgs::FEEDS)
}

fn set_schema_version(conn: &Connection, version: i32) -> Result<(), AppError> {
    crate::core::sqlite::write_schema_version(conn, version, crate::core::sqlite::DbMsgs::FEEDS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_schema() {
        let dir = std::env::temp_dir().join(format!(
            "agentero-feeds-schema-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let db = dir.join("feeds.sqlite");
        let conn = ensure_feeds_at(&db).expect("ensure");
        assert_eq!(schema_version(&conn).unwrap(), SCHEMA_VERSION);
        drop(conn);
        let conn2 = ensure_feeds_at(&db).expect("reopen");
        assert_eq!(schema_version(&conn2).unwrap(), SCHEMA_VERSION);
        conn2
            .execute_batch(
                "SELECT pinned, pinned_at FROM subscriptions; SELECT body_markdown FROM items;",
            )
            .expect("v2 columns");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrates_v1_to_v2() {
        let dir = std::env::temp_dir().join(format!(
            "agentero-feeds-schema-v1-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let db = dir.join("feeds.sqlite");
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(DDL_V1).unwrap();
            conn.execute(
                "INSERT INTO schema_meta(key, value) VALUES('schema_version', '1')",
                [],
            )
            .unwrap();
        }
        let conn = ensure_feeds_at(&db).expect("migrate");
        assert_eq!(schema_version(&conn).unwrap(), SCHEMA_VERSION);
        conn.execute(
            "INSERT INTO subscriptions (id, url, title, added_at, pinned) VALUES ('a', 'https://ex.com/f', 't', 'now', 1)",
            [],
        )
        .unwrap();
        let pinned: i64 = conn
            .query_row("SELECT pinned FROM subscriptions WHERE id = 'a'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(pinned, 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrates_v2_to_v3_timestamps() {
        let dir = std::env::temp_dir().join(format!(
            "agentero-feeds-schema-v2-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let db = dir.join("feeds.sqlite");
        {
            let conn = ensure_feeds_at(&db).expect("ensure");
            conn.execute_batch(
                "INSERT INTO subscriptions (id, url, title, added_at, pinned, pinned_at) VALUES
                 ('s1', 'https://ex.com/a', 'A', '2026-08-01T08:00:00Z', 1, '2026-08-02T08:00:00.123456+00:00'),
                 ('s2', 'https://ex.com/b', 'B', '2026-08-01T09:00:00.250Z', 0, NULL);
                 INSERT INTO items (id, subscription_id, guid, title, published_at, first_seen_at, imported_at)
                 VALUES
                 ('i1', 's1', 'g1', 'one', '2026-08-03T10:00:00+00:00', '2026-08-03T10:00:01Z', NULL),
                 ('i2', 's1', 'g2', 'two', 'garbage-date', '2026-08-03T11:00:00.500Z', '2026-08-03T12:00:00Z');",
            )
            .unwrap();
            conn.execute(
                "UPDATE schema_meta SET value = '2' WHERE key = 'schema_version'",
                [],
            )
            .unwrap();
        }
        let conn = ensure_feeds_at(&db).expect("migrate v3");
        assert_eq!(schema_version(&conn).unwrap(), 4);

        let sub: (String, Option<String>) = conn
            .query_row(
                "SELECT added_at, pinned_at FROM subscriptions WHERE id = 's1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(sub.0, "2026-08-01T08:00:00.000Z");
        assert_eq!(sub.1, Some("2026-08-02T08:00:00.123Z".to_string()));

        // Canonical + NULL stay untouched.
        let sub2: (String, Option<String>) = conn
            .query_row(
                "SELECT added_at, pinned_at FROM subscriptions WHERE id = 's2'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(sub2.0, "2026-08-01T09:00:00.250Z");
        assert_eq!(sub2.1, None);

        let item: (Option<String>, String, Option<String>) = conn
            .query_row(
                "SELECT published_at, first_seen_at, imported_at FROM items WHERE id = 'i1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(item.0, Some("2026-08-03T10:00:00.000Z".to_string()));
        assert_eq!(item.1, "2026-08-03T10:00:01.000Z");
        assert_eq!(item.2, None);

        // Unparseable published_at is kept as-is.
        let bad: Option<String> = conn
            .query_row("SELECT published_at FROM items WHERE id = 'i2'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(bad, Some("garbage-date".to_string()));
        let imported: Option<String> = conn
            .query_row("SELECT imported_at FROM items WHERE id = 'i2'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(imported, Some("2026-08-03T12:00:00.000Z".to_string()));

        // Timeline string ORDER BY: i2 first_seen 11:00 sorts above i1's 10:00 published.
        let order: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT id FROM items ORDER BY COALESCE(published_at, first_seen_at) DESC, id DESC")
                .unwrap();
            stmt.query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(order, vec!["i2", "i1"]);

        // Idempotent re-run.
        conn.execute(
            "UPDATE schema_meta SET value = '2' WHERE key = 'schema_version'",
            [],
        )
        .unwrap();
        drop(conn);
        let conn = ensure_feeds_at(&db).expect("re-migrate");
        assert_eq!(schema_version(&conn).unwrap(), 4);
        let added: String = conn
            .query_row(
                "SELECT added_at FROM subscriptions WHERE id = 's1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(added, "2026-08-01T08:00:00.000Z");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrates_v3_to_v4_clears_body_cache() {
        let dir = std::env::temp_dir().join(format!(
            "agentero-feeds-schema-v4-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let db = dir.join("feeds.sqlite");
        {
            let conn = ensure_feeds_at(&db).expect("ensure");
            conn.execute_batch(
                "INSERT INTO subscriptions (id, url, title, added_at, pinned) VALUES
                 ('s1', 'https://ex.com/a', 'A', '2026-08-01T08:00:00.000Z', 0);
                 INSERT INTO items (id, subscription_id, guid, title, first_seen_at, body_markdown, paper_url)
                 VALUES ('i1', 's1', 'g1', 'one', '2026-08-03T10:00:01.000Z', '# old body', 'https://doi.org/10.1/x');",
            )
            .unwrap();
            conn.execute(
                "UPDATE schema_meta SET value = '3' WHERE key = 'schema_version'",
                [],
            )
            .unwrap();
        }
        let conn = ensure_feeds_at(&db).expect("migrate v4");
        assert_eq!(schema_version(&conn).unwrap(), 4);
        let (body, paper_url): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT body_markdown, paper_url FROM items WHERE id = 'i1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(body, None);
        assert_eq!(paper_url.as_deref(), Some("https://doi.org/10.1/x"));
        let _ = fs::remove_dir_all(&dir);
    }
}
