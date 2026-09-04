//! Catalog SQLite schema and ensure/open helpers.
//!
//! - v1: initial papers table
//! - v2: Translator / magic-wand fields (publication, volume, isbn, …)
//! - v3: `is_read` for paper-reader workflow
//! - v4: Zotero sync linkage (`zotero_item_id`, `zotero_last_synced`)
//! - v5: list-order indexes (`updated_at`, `added_at`, `title`) + `pdf_page_counts`
//! - v6: arXiv recommendation caches (`embed_cache`, `arxiv_rec_state`)
//! - v7: data migration — normalize timestamp columns to canonical RFC 3339
//!   millis (string `ORDER BY updated_at` breaks on mixed precision/offsets)

use crate::core::error::AppError;
use rusqlite::Connection;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

/// Current catalog schema version written to `schema_meta`.
pub const SCHEMA_VERSION: i32 = 7;

const DDL_V1: &str = r#"
CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS papers (
    path            TEXT PRIMARY KEY NOT NULL,
    id              TEXT NOT NULL,
    type            TEXT NOT NULL,
    title           TEXT NOT NULL,
    authors_json    TEXT NOT NULL DEFAULT '[]',
    year            INTEGER,
    abstract        TEXT,
    tags_json       TEXT NOT NULL DEFAULT '[]',
    arxiv_id        TEXT,
    doi             TEXT,
    pdf_url         TEXT,
    html_url        TEXT,
    source_url      TEXT,
    body_source     TEXT,
    body_quality    TEXT,
    bibtex_key      TEXT,
    citation_count  INTEGER,
    status          TEXT NOT NULL DEFAULT 'completed',
    summary         TEXT,
    added_at        TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_papers_id ON papers(id);
CREATE INDEX IF NOT EXISTS idx_papers_year ON papers(year);
CREATE INDEX IF NOT EXISTS idx_papers_type ON papers(type);
CREATE INDEX IF NOT EXISTS idx_papers_status ON papers(status);
CREATE INDEX IF NOT EXISTS idx_papers_arxiv ON papers(arxiv_id);
CREATE INDEX IF NOT EXISTS idx_papers_doi ON papers(doi);
CREATE INDEX IF NOT EXISTS idx_papers_bibtex ON papers(bibtex_key);
"#;

/// Columns added in schema v2 (Translator → PaperMetadata).
const MIGRATE_V1_TO_V2: &str = r#"
ALTER TABLE papers ADD COLUMN creators_json TEXT;
ALTER TABLE papers ADD COLUMN date TEXT;
ALTER TABLE papers ADD COLUMN isbn TEXT;
ALTER TABLE papers ADD COLUMN issn TEXT;
ALTER TABLE papers ADD COLUMN pmid TEXT;
ALTER TABLE papers ADD COLUMN publication TEXT;
ALTER TABLE papers ADD COLUMN volume TEXT;
ALTER TABLE papers ADD COLUMN issue TEXT;
ALTER TABLE papers ADD COLUMN pages TEXT;
ALTER TABLE papers ADD COLUMN publisher TEXT;
ALTER TABLE papers ADD COLUMN place TEXT;
ALTER TABLE papers ADD COLUMN series TEXT;
ALTER TABLE papers ADD COLUMN language TEXT;
ALTER TABLE papers ADD COLUMN zotero_item_type TEXT;
ALTER TABLE papers ADD COLUMN meta_source TEXT;
ALTER TABLE papers ADD COLUMN extra TEXT;
CREATE INDEX IF NOT EXISTS idx_papers_pmid ON papers(pmid);
CREATE INDEX IF NOT EXISTS idx_papers_isbn ON papers(isbn);
"#;

/// Columns added in schema v3 (paper-reader read flag).
const MIGRATE_V2_TO_V3: &str = r#"
ALTER TABLE papers ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_papers_is_read ON papers(is_read);
"#;

/// Columns added in schema v4 (Zotero bidirectional sync linkage).
const MIGRATE_V3_TO_V4: &str = r#"
ALTER TABLE papers ADD COLUMN zotero_item_id INTEGER;
ALTER TABLE papers ADD COLUMN zotero_last_synced TEXT;
CREATE INDEX IF NOT EXISTS idx_papers_zotero_item_id ON papers(zotero_item_id);
"#;

/// Schema v5: list-order indexes + persistent PDF page-count cache.
/// `title COLLATE NOCASE` matches the library's default ORDER BY.
const MIGRATE_V4_TO_V5: &str = r#"
CREATE INDEX IF NOT EXISTS idx_papers_updated_at ON papers(updated_at);
CREATE INDEX IF NOT EXISTS idx_papers_added_at ON papers(added_at);
CREATE INDEX IF NOT EXISTS idx_papers_title ON papers(title COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS pdf_page_counts (
    path       TEXT PRIMARY KEY NOT NULL,
    page_count INTEGER NOT NULL
);
"#;

/// Schema v6: arXiv recommendation caches.
/// `embed_cache` keys abstract vectors by (sha256 of the text, model) so the
/// library corpus is embedded once and later runs only pay for new abstracts.
/// `vector` is little-endian f32; `arxiv_rec_state` is a single row holding the
/// last run so opening the page (or the vault) can skip the network entirely.
const MIGRATE_V5_TO_V6: &str = r#"
CREATE TABLE IF NOT EXISTS embed_cache (
    text_hash TEXT NOT NULL,
    model     TEXT NOT NULL,
    dim       INTEGER NOT NULL,
    vector    BLOB NOT NULL,
    PRIMARY KEY (text_hash, model)
);
CREATE TABLE IF NOT EXISTS arxiv_rec_state (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    computed_at     TEXT NOT NULL,
    categories_json TEXT NOT NULL,
    results_json    TEXT NOT NULL
);
"#;

/// Absolute path to `{vault}/.agentero/catalog.sqlite`.
pub fn catalog_db_path(vault_root: &Path) -> std::path::PathBuf {
    vault_root.join(".agentero").join("catalog.sqlite")
}

/// Ensure `.agentero/` exists, create/open catalog.sqlite, apply migrations.
pub fn ensure_catalog(vault_root: &Path) -> Result<Connection, AppError> {
    let agentero_dir = vault_root.join(".agentero");
    fs::create_dir_all(&agentero_dir)?;

    let db_path = catalog_db_path(vault_root);
    let conn = crate::core::sqlite::open_standard(&db_path, crate::core::sqlite::DbMsgs::CATALOG)?;

    migrate(&conn)?;
    Ok(conn)
}

/// Process-wide cache of one persistent catalog connection per vault.
///
/// Every catalog API used to call [`ensure_catalog`], paying a fresh
/// `Connection::open` + 4 PRAGMAs + full `migrate()` walk per call — a real
/// cost on Windows/NTFS where opening `catalog.sqlite` stats the file and
/// replays the WAL. Commands run on the `spawn_blocking` pool, so the shared
/// connection is guarded by a `Mutex`; WAL + `busy_timeout` are already set at
/// open. Keyed by canonicalized vault root so `/vault` and its symlinked
/// aliases share one handle.
type ConnCache = HashMap<PathBuf, Arc<Mutex<Connection>>>;

static CONN_CACHE: OnceLock<Mutex<ConnCache>> = OnceLock::new();
/// Physical opens per vault key (diagnostics; asserted by perf tests).
static OPEN_COUNTS: OnceLock<Mutex<HashMap<PathBuf, u64>>> = OnceLock::new();

fn conn_cache() -> &'static Mutex<ConnCache> {
    CONN_CACHE.get_or_init(Default::default)
}

fn conn_cache_key(vault_root: &Path) -> PathBuf {
    fs::canonicalize(vault_root).unwrap_or_else(|_| vault_root.to_path_buf())
}

/// How many times `with_catalog` physically opened the catalog for this vault.
/// Test-only observer; the counter itself is always maintained.
#[cfg(test)]
pub fn catalog_open_count(vault_root: &Path) -> u64 {
    let key = conn_cache_key(vault_root);
    let counts = OPEN_COUNTS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    counts.get(&key).copied().unwrap_or(0)
}

/// Drop the cached connection for a vault (e.g. before deleting the vault, or
/// after an operation reported the handle as broken).
pub fn evict_catalog_conn(vault_root: &Path) {
    let key = conn_cache_key(vault_root);
    let mut cache = conn_cache().lock().unwrap_or_else(|p| p.into_inner());
    cache.remove(&key);
}

/// Run `f` against the vault's persistent catalog connection.
///
/// Opens (and migrates) the database only on the first call per vault; later
/// calls reuse the cached handle. If the database file disappeared since the
/// handle was cached — vault deleted or recreated externally — the stale
/// handle is dropped and a fresh one is opened, re-running `ensure_catalog`.
/// A failing statement while the file is gone also evicts the handle so the
/// next call recovers instead of failing forever.
pub fn with_catalog<T>(
    vault_root: &Path,
    f: impl FnOnce(&Connection) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let key = conn_cache_key(vault_root);
    let conn = {
        let mut cache = conn_cache().lock().unwrap_or_else(|p| p.into_inner());
        // Stale handle: the file was deleted (vault removed / recreated). WAL
        // keeps the unlinked inode alive, so without this check writes would
        // silently go to a ghost database.
        if cache.contains_key(&key) && !catalog_db_path(vault_root).is_file() {
            cache.remove(&key);
        }
        match cache.get(&key) {
            Some(conn) => Arc::clone(conn),
            None => {
                let conn = Arc::new(Mutex::new(ensure_catalog(vault_root)?));
                cache.insert(key.clone(), Arc::clone(&conn));
                let mut counts = OPEN_COUNTS
                    .get_or_init(Default::default)
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                *counts.entry(key.clone()).or_insert(0) += 1;
                conn
            }
        }
    };
    let guard = conn.lock().unwrap_or_else(|p| p.into_inner());
    let result = f(&guard);
    drop(guard);
    if result.is_err() && !catalog_db_path(vault_root).is_file() {
        evict_catalog_conn(vault_root);
    }
    result
}

fn migrate(conn: &Connection) -> Result<(), AppError> {
    let version = schema_version(conn).unwrap_or(0);

    if version > SCHEMA_VERSION {
        return Err(AppError::message(format!(
            "catalog schema version {version} is newer than this app supports ({SCHEMA_VERSION}); upgrade Agentero"
        )));
    }

    if version < 1 {
        conn.execute_batch(DDL_V1)
            .map_err(|e| AppError::message(format!("catalog migrate v1: {e}")))?;
        set_schema_version(conn, 1)?;
    }

    let version = schema_version(conn).unwrap_or(0);
    if version < 2 {
        // SQLite ADD COLUMN is not fully batch-safe across existing cols; run one-by-one ignore dupes
        for stmt in MIGRATE_V1_TO_V2.split(';') {
            let s = stmt.trim();
            if s.is_empty() {
                continue;
            }
            match conn.execute_batch(&format!("{s};")) {
                Ok(()) => {}
                Err(e) => {
                    let msg = e.to_string();
                    // Idempotent re-run / partial migrate
                    if msg.contains("duplicate column name") {
                        continue;
                    }
                    return Err(AppError::message(format!("catalog migrate v2: {e}")));
                }
            }
        }
        set_schema_version(conn, 2)?;
    }

    let version = schema_version(conn).unwrap_or(0);
    if version < 3 {
        for stmt in MIGRATE_V2_TO_V3.split(';') {
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
                    return Err(AppError::message(format!("catalog migrate v3: {e}")));
                }
            }
        }
        set_schema_version(conn, 3)?;
    }

    let version = schema_version(conn).unwrap_or(0);
    if version < 4 {
        for stmt in MIGRATE_V3_TO_V4.split(';') {
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
                    return Err(AppError::message(format!("catalog migrate v4: {e}")));
                }
            }
        }
        set_schema_version(conn, 4)?;
    }

    let version = schema_version(conn).unwrap_or(0);
    if version < 5 {
        for stmt in MIGRATE_V4_TO_V5.split(';') {
            let s = stmt.trim();
            if s.is_empty() {
                continue;
            }
            conn.execute_batch(&format!("{s};"))
                .map_err(|e| AppError::message(format!("catalog migrate v5: {e}")))?;
        }
        set_schema_version(conn, 5)?;
    }

    let version = schema_version(conn).unwrap_or(0);
    if version < 6 {
        for stmt in MIGRATE_V5_TO_V6.split(';') {
            let s = stmt.trim();
            if s.is_empty() {
                continue;
            }
            conn.execute_batch(&format!("{s};"))
                .map_err(|e| AppError::message(format!("catalog migrate v6: {e}")))?;
        }
        set_schema_version(conn, 6)?;
    }

    let version = schema_version(conn).unwrap_or(0);
    if version < 7 {
        // Data-only migration: legacy writers emitted second precision
        // (`…:00Z`) and bare `to_rfc3339()` (`…+00:00`, variable fractions);
        // those do not string-sort against the canonical millis form
        // (`'+' < '.' < 'Z'`). Rewrite to canonical form; already-canonical
        // and unparseable values pass through untouched (idempotent).
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| AppError::message(format!("catalog migrate v7 tx: {e}")))?;
        crate::core::time::normalize_timestamp_columns(
            &tx,
            "papers",
            "path",
            &["updated_at", "added_at"],
        )
        .map_err(|e| AppError::message(format!("catalog migrate v7 papers: {e}")))?;
        crate::core::time::normalize_timestamp_columns(
            &tx,
            "arxiv_rec_state",
            "id",
            &["computed_at"],
        )
        .map_err(|e| AppError::message(format!("catalog migrate v7 rec state: {e}")))?;
        tx.commit()
            .map_err(|e| AppError::message(format!("catalog migrate v7 commit: {e}")))?;
        set_schema_version(conn, 7)?;
    }

    Ok(())
}

pub fn schema_version(conn: &Connection) -> Result<i32, AppError> {
    crate::core::sqlite::read_schema_version(conn, crate::core::sqlite::DbMsgs::CATALOG)
}

fn set_schema_version(conn: &Connection, version: i32) -> Result<(), AppError> {
    crate::core::sqlite::write_schema_version(conn, version, crate::core::sqlite::DbMsgs::CATALOG)?;
    conn.execute(
        "INSERT INTO schema_meta(key, value) VALUES('agentero_app', 'agentero')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [],
    )
    .map_err(|e| AppError::message(format!("write agentero_app: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn ensure_catalog_creates_schema_current() {
        let dir = env::temp_dir().join(format!("agentero-catalog-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let conn = ensure_catalog(&dir).expect("ensure");
        assert_eq!(schema_version(&conn).unwrap(), SCHEMA_VERSION);

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM papers", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);

        // v2 columns exist
        let has_pub: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('papers') WHERE name = 'publication'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_pub, 1);

        // v3 is_read exists
        let has_read: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('papers') WHERE name = 'is_read'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_read, 1);

        // v4 Zotero sync columns exist
        let has_zotero: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('papers') WHERE name IN ('zotero_item_id', 'zotero_last_synced')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_zotero, 2);

        // v6 recommendation cache tables exist
        let has_rec_tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('embed_cache', 'arxiv_rec_state')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_rec_tables, 2);

        // Idempotent second open
        drop(conn);
        let conn2 = ensure_catalog(&dir).expect("reopen");
        assert_eq!(schema_version(&conn2).unwrap(), SCHEMA_VERSION);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrate_v7_normalizes_legacy_timestamps() {
        let dir = env::temp_dir().join(format!(
            "agentero-catalog-v7-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();

        {
            let conn = ensure_catalog(&dir).expect("ensure");
            conn.execute_batch(
                "INSERT INTO papers (path, id, type, title, added_at, updated_at) VALUES
                 ('papers/legacy-secs', 'a', 'article', 'A',
                  '2026-08-20T09:00:00Z', '2026-08-21T10:00:00Z'),
                 ('papers/legacy-bare', 'b', 'article', 'B',
                  '2026-08-20T09:00:00.123456+00:00', '2026-08-21T10:00:00.999999+00:00'),
                 ('papers/canonical', 'c', 'article', 'C',
                  '2026-08-20T09:00:00.100Z', '2026-08-21T10:00:00.500Z'),
                 ('papers/garbage', 'd', 'article', 'D', 'not-a-date', 'also not a date');
                 INSERT INTO arxiv_rec_state (id, computed_at, categories_json, results_json)
                 VALUES (1, '2026-08-21T09:00:00+00:00', '[]', '[]');",
            )
            .unwrap();
            // Force a v6 database so the next open replays the v7 migration.
            conn.execute(
                "UPDATE schema_meta SET value = '6' WHERE key = 'schema_version'",
                [],
            )
            .unwrap();
        }

        let conn = ensure_catalog(&dir).expect("migrate v7");
        assert_eq!(schema_version(&conn).unwrap(), 7);

        let get = |path: &str, col: &str| {
            let sql = format!("SELECT {col} FROM papers WHERE path = '{path}'");
            conn.query_row(&sql, [], |r| r.get::<_, String>(0)).unwrap()
        };
        // Secs precision → zero-padded millis.
        assert_eq!(
            get("papers/legacy-secs", "updated_at"),
            "2026-08-21T10:00:00.000Z"
        );
        // Bare to_rfc3339 (+00:00, 6-digit fraction) → millis + Z.
        assert_eq!(
            get("papers/legacy-bare", "updated_at"),
            "2026-08-21T10:00:00.999Z"
        );
        assert_eq!(
            get("papers/legacy-bare", "added_at"),
            "2026-08-20T09:00:00.123Z"
        );
        // Already canonical → untouched.
        assert_eq!(
            get("papers/canonical", "updated_at"),
            "2026-08-21T10:00:00.500Z"
        );
        // Unparseable → untouched.
        assert_eq!(get("papers/garbage", "updated_at"), "also not a date");

        let computed: String = conn
            .query_row(
                "SELECT computed_at FROM arxiv_rec_state WHERE id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(computed, "2026-08-21T09:00:00.000Z");

        // String ORDER BY is now correct: 10:00:00.999Z > 10:00:00.500Z > 10:00:00.000Z.
        let order: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT path FROM papers WHERE path != 'papers/garbage' ORDER BY updated_at DESC")
                .unwrap();
            stmt.query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(
            order,
            vec![
                "papers/legacy-bare",
                "papers/canonical",
                "papers/legacy-secs"
            ]
        );

        // Idempotent: re-running the migration must not touch anything.
        conn.execute(
            "UPDATE schema_meta SET value = '6' WHERE key = 'schema_version'",
            [],
        )
        .unwrap();
        drop(conn);
        let conn = ensure_catalog(&dir).expect("re-migrate");
        assert_eq!(schema_version(&conn).unwrap(), 7);
        let get = |path: &str, col: &str| {
            let sql = format!("SELECT {col} FROM papers WHERE path = '{path}'");
            conn.query_row(&sql, [], |r| r.get::<_, String>(0)).unwrap()
        };
        assert_eq!(
            get("papers/legacy-secs", "updated_at"),
            "2026-08-21T10:00:00.000Z"
        );
        assert_eq!(get("papers/garbage", "updated_at"), "also not a date");

        let _ = fs::remove_dir_all(&dir);
    }
}
