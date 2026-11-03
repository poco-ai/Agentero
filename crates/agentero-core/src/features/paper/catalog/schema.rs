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
//! - v8: multi-row discovery runs (`discovery_runs`) keyed by
//!   source/model/categories/top_n, superseding the single-row
//!   `arxiv_rec_state` (kept for old DBs; no longer written)
//! - v9: `code_repo` link (filled from the PDF when empty; a manual edit sticks)
//! - v10: manually maintained `openreview_url` link
//! - v11: `custom_properties` table + `papers.custom_props_json`
//! - v12: durable pending metadata sidecar paths
//! - v13: `code_repo_manual` — set when Edit Metadata writes `code_repo`, so a
//!   cleared value is not filled again from the PDF

use crate::error::AppError;
use crate::sqlite::MigrationStep;
use rusqlite::Connection;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

/// Current catalog schema version written to `schema_meta`.
pub const SCHEMA_VERSION: i32 = 13;

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

/// Schema v8: multi-row discovery runs.
///
/// One row per `(source, model, categories, top_n)` combination so different
/// queries coexist instead of overwriting each other. `key` is a stable hash of
/// those inputs; `params_json` stores them verbatim for cache reads (and for
/// "last run" fallbacks). Supersedes the single-row `arxiv_rec_state`, which is
/// left in place for old databases but no longer written.
const MIGRATE_V7_TO_V8: &str = r#"
CREATE TABLE IF NOT EXISTS discovery_runs (
    key          TEXT PRIMARY KEY NOT NULL,
    source       TEXT NOT NULL,
    computed_at  TEXT NOT NULL,
    params_json  TEXT NOT NULL,
    results_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discovery_runs_computed_at ON discovery_runs(computed_at DESC);
"#;

/// Schema v9: code-repository link, filled from the PDF when still empty.
const MIGRATE_V8_TO_V9: &str = r#"
ALTER TABLE papers ADD COLUMN code_repo TEXT;
"#;

/// Schema v13: the user edited `code_repo` (including clearing it).
/// Kept off `PaperRecord` so a later upsert does not clear the flag.
const MIGRATE_V12_TO_V13: &str = r#"
ALTER TABLE papers ADD COLUMN code_repo_manual INTEGER NOT NULL DEFAULT 0;
"#;

/// Schema v10: manually maintained OpenReview link.
const MIGRATE_V9_TO_V10: &str = r#"
ALTER TABLE papers ADD COLUMN openreview_url TEXT;
"#;

/// Schema v11: custom properties table and paper custom properties JSON column.
const MIGRATE_V10_TO_V11: &str = r#"
CREATE TABLE IF NOT EXISTS custom_properties (
    id           TEXT PRIMARY KEY NOT NULL,
    name         TEXT NOT NULL,
    type         TEXT NOT NULL DEFAULT 'select',
    options_json TEXT NOT NULL DEFAULT '[]',
    order_index  INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
ALTER TABLE papers ADD COLUMN custom_props_json TEXT NOT NULL DEFAULT '{}';
"#;

// Triggers keep direct SQL updates, moves and deletes in the same contract.
const MIGRATE_V11_TO_V12: &str = r#"
CREATE TABLE IF NOT EXISTS pending_sidecars (path TEXT PRIMARY KEY NOT NULL);
INSERT OR IGNORE INTO pending_sidecars SELECT path FROM papers;
CREATE TRIGGER IF NOT EXISTS paper_sidecar_insert AFTER INSERT ON papers BEGIN
    INSERT OR REPLACE INTO pending_sidecars(path) VALUES (NEW.path);
END;
CREATE TRIGGER IF NOT EXISTS paper_sidecar_update AFTER UPDATE ON papers BEGIN
    DELETE FROM pending_sidecars WHERE path = OLD.path;
    INSERT OR REPLACE INTO pending_sidecars(path) VALUES (NEW.path);
END;
CREATE TRIGGER IF NOT EXISTS paper_sidecar_delete AFTER DELETE ON papers BEGIN
    DELETE FROM pending_sidecars WHERE path = OLD.path;
END;
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
    let conn = crate::sqlite::open_standard(&db_path, crate::sqlite::DbMsgs::CATALOG)?;

    migrate(&conn)?;
    super::sidecar::retry_pending(vault_root, &conn, None);
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
#[cfg(test)]
static OPEN_COUNTS: OnceLock<Mutex<HashMap<PathBuf, u64>>> = OnceLock::new();

fn conn_cache() -> &'static Mutex<ConnCache> {
    CONN_CACHE.get_or_init(Default::default)
}

fn conn_cache_key(vault_root: &Path) -> PathBuf {
    crate::fs::canonicalize_best_effort(vault_root)
}

/// How many times `with_catalog` physically opened the catalog for this vault.
/// Test-only observer; no counters are maintained in production.
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
                #[cfg(test)]
                {
                    let mut counts = OPEN_COUNTS
                        .get_or_init(Default::default)
                        .lock()
                        .unwrap_or_else(|p| p.into_inner());
                    *counts.entry(key.clone()).or_insert(0) += 1;
                }
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

/// Migration ladder, applied by [`crate::sqlite::run_migrations`] (per-step
/// version re-read, stamping, `newer than app` guard).
const MIGRATION_STEPS: [MigrationStep; 13] = [
    MigrationStep::batch(1, DDL_V1),
    // SQLite ADD COLUMN is not fully batch-safe across existing cols; the
    // v2–v4 entries run one-by-one and ignore duplicate-column errors.
    MigrationStep::script_tolerant(2, MIGRATE_V1_TO_V2),
    MigrationStep::script_tolerant(3, MIGRATE_V2_TO_V3),
    MigrationStep::script_tolerant(4, MIGRATE_V3_TO_V4),
    MigrationStep::script(5, MIGRATE_V4_TO_V5),
    MigrationStep::script(6, MIGRATE_V5_TO_V6),
    MigrationStep::custom(7, migrate_v7),
    MigrationStep::script(8, MIGRATE_V7_TO_V8),
    MigrationStep::script_tolerant(9, MIGRATE_V8_TO_V9),
    MigrationStep::script_tolerant(10, MIGRATE_V9_TO_V10),
    MigrationStep::script_tolerant(11, MIGRATE_V10_TO_V11),
    MigrationStep::batch(12, MIGRATE_V11_TO_V12),
    MigrationStep::script_tolerant(13, MIGRATE_V12_TO_V13),
];

fn migrate(conn: &Connection) -> Result<(), AppError> {
    crate::sqlite::run_migrations(
        conn,
        crate::sqlite::DbMsgs::CATALOG,
        SCHEMA_VERSION,
        &MIGRATION_STEPS,
        set_schema_version,
    )
}

/// v7: data-only migration inside one transaction. Legacy writers emitted
/// second precision (`…:00Z`) and bare `to_rfc3339()` (`…+00:00`, variable
/// fractions); those do not string-sort against the canonical millis form
/// (`'+' < '.' < 'Z'`). Rewrite to canonical form; already-canonical and
/// unparseable values pass through untouched (idempotent).
fn migrate_v7(conn: &Connection) -> Result<(), AppError> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| AppError::message(format!("catalog migrate v7 tx: {e}")))?;
    crate::time::normalize_timestamp_columns(&tx, "papers", "path", &["updated_at", "added_at"])
        .map_err(|e| AppError::message(format!("catalog migrate v7 papers: {e}")))?;
    crate::time::normalize_timestamp_columns(&tx, "arxiv_rec_state", "id", &["computed_at"])
        .map_err(|e| AppError::message(format!("catalog migrate v7 rec state: {e}")))?;
    tx.commit()
        .map_err(|e| AppError::message(format!("catalog migrate v7 commit: {e}")))?;
    Ok(())
}

pub fn schema_version(conn: &Connection) -> Result<i32, AppError> {
    crate::sqlite::read_schema_version(conn, crate::sqlite::DbMsgs::CATALOG)
}

fn set_schema_version(conn: &Connection, version: i32) -> Result<(), AppError> {
    crate::sqlite::write_schema_version(conn, version, crate::sqlite::DbMsgs::CATALOG)?;
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

        // v9 manual code-repo column exists
        let has_code_repo: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('papers') WHERE name = 'code_repo'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_code_repo, 1);

        // v6 recommendation caches + v8 multi-row discovery runs exist
        let has_rec_tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('embed_cache', 'arxiv_rec_state', 'discovery_runs')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_rec_tables, 3);

        let discovery_runs_ok: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('discovery_runs') WHERE name IN ('key', 'source', 'params_json', 'results_json')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(discovery_runs_ok, 4);

        // Idempotent second open
        drop(conn);
        let conn2 = ensure_catalog(&dir).expect("reopen");
        assert_eq!(schema_version(&conn2).unwrap(), SCHEMA_VERSION);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrates_v9_without_changing_manual_metadata() {
        let conn = Connection::open_in_memory().unwrap();
        crate::sqlite::run_migrations(
            &conn,
            crate::sqlite::DbMsgs::CATALOG,
            9,
            &MIGRATION_STEPS[..9],
            set_schema_version,
        )
        .unwrap();
        conn.execute(
            "INSERT INTO papers (path, id, type, title, code_repo, added_at, updated_at)
             VALUES ('papers/x', 'x', 'pdf', 'Title', 'https://github.com/foo/bar', 't', 't')",
            [],
        )
        .unwrap();

        migrate(&conn).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), SCHEMA_VERSION);
        let links: (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT code_repo, openreview_url FROM papers WHERE path = 'papers/x'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(links, (Some("https://github.com/foo/bar".into()), None));
        migrate(&conn).unwrap();
    }

    #[test]
    fn migrates_v10_to_v11_adds_custom_properties() {
        let conn = Connection::open_in_memory().unwrap();
        crate::sqlite::run_migrations(
            &conn,
            crate::sqlite::DbMsgs::CATALOG,
            10,
            &MIGRATION_STEPS[..10],
            set_schema_version,
        )
        .unwrap();
        conn.execute(
            "INSERT INTO papers (path, id, type, title, added_at, updated_at)
             VALUES ('papers/x', 'x', 'pdf', 'Title', 't', 't')",
            [],
        )
        .unwrap();

        migrate(&conn).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), SCHEMA_VERSION);
        let custom_props: String = conn
            .query_row(
                "SELECT custom_props_json FROM papers WHERE path = 'papers/x'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(custom_props, "{}");
        let has_table: bool = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='custom_properties'",
                [],
                |_| Ok(true),
            )
            .unwrap_or(false);
        assert!(has_table);
    }

    /// v1 databases predate the whole migration ladder: build one by hand
    /// (v1 DDL + version stamp + legacy-shaped row) and walk it through every
    /// step — v2…v10 must all land.
    #[test]
    fn migrates_v1_to_current_through_full_ladder() {
        let dir = env::temp_dir().join(format!(
            "agentero-catalog-v1-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(dir.join(".agentero")).unwrap();

        {
            let conn = Connection::open(catalog_db_path(&dir)).unwrap();
            conn.execute_batch(DDL_V1).unwrap();
            conn.execute(
                "INSERT INTO schema_meta(key, value) VALUES('schema_version', '1')",
                [],
            )
            .unwrap();
            // Legacy row: v1 column shape, legacy timestamp spellings (secs
            // precision + bare to_rfc3339) that v7 must normalize.
            conn.execute_batch(
                "INSERT INTO papers (path, id, type, title, added_at, updated_at) VALUES
                 ('papers/1706.03762', '1706.03762', 'article', 'Attention Is All You Need',
                  '2026-08-20T09:00:00Z', '2026-08-21T10:00:00.123456+00:00');",
            )
            .unwrap();
        }

        let conn = ensure_catalog(&dir).expect("migrate v1 to current");
        assert_eq!(schema_version(&conn).unwrap(), SCHEMA_VERSION);

        // v2 Translator columns exist (spot-check a few of the 16).
        let has_v2: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('papers')
                 WHERE name IN ('creators_json', 'publication', 'volume', 'meta_source')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_v2, 4);
        // v3 read flag + v4 Zotero linkage + v9/v10 links + v11 custom props.
        let has_later_columns: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('papers')
                 WHERE name IN ('is_read', 'zotero_item_id', 'zotero_last_synced', 'code_repo', 'openreview_url', 'custom_props_json')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_later_columns, 6);
        let has_code_repo_manual: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('papers') WHERE name = 'code_repo_manual'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_code_repo_manual, 1);
        // v5 page-count cache + v6 recommendation caches + v8 discovery runs + v11 custom_properties.
        let tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN
                 ('pdf_page_counts', 'embed_cache', 'arxiv_rec_state', 'discovery_runs', 'custom_properties')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 5);

        // v7 normalized the legacy timestamps in place; the row itself and its
        // legacy `type` spelling survive the data-only migration.
        let (added, updated, title): (String, String, String) = conn
            .query_row(
                "SELECT added_at, updated_at, title FROM papers WHERE path = 'papers/1706.03762'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(added, "2026-08-20T09:00:00.000Z");
        assert_eq!(updated, "2026-08-21T10:00:00.123Z");
        assert_eq!(title, "Attention Is All You Need");

        // Both stamps: current version plus the agentero_app marker.
        let app: String = conn
            .query_row(
                "SELECT value FROM schema_meta WHERE key = 'agentero_app'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(app, "agentero");

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

        // Reopening from v6 replays the remaining migrations (v7 normalization,
        // then v8 discovery_runs) up to current.
        let conn = ensure_catalog(&dir).expect("migrate past v6");
        assert_eq!(schema_version(&conn).unwrap(), SCHEMA_VERSION);

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
        assert_eq!(schema_version(&conn).unwrap(), SCHEMA_VERSION);
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
