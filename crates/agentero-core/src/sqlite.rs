//! Shared SQLite plumbing for the app's local databases (catalog / usage / feeds).
//!
//! Each database owns its DDL and migration steps in its own `schema.rs`;
//! this module factors out the verbatim-shared skeleton: open + standard
//! PRAGMA batch + `schema_meta.schema_version` read/write + the table-driven
//! [`run_migrations`] ladder. Error-message wording grew independently per
//! database (catalog predates the `usage ` / `feeds ` prefixes) and is
//! preserved verbatim by [`DbMsgs`].

use crate::error::AppError;
use rusqlite::Connection;
use std::path::Path;

/// Standard PRAGMA batch applied right after every Agentero database open.
/// WAL lets readers proceed while the app writes; `busy_timeout` absorbs
/// short lock contention instead of failing commands immediately.
///
/// `busy_timeout` must come first: switching `journal_mode` can itself need a
/// lock, and a CLI process opening the shared feeds database while the desktop
/// app (or a second CLI) is migrating would otherwise fail immediately with
/// `database is locked` before the timeout is installed.
pub const STANDARD_PRAGMAS: &str = "PRAGMA busy_timeout = 5000;\n\
     PRAGMA journal_mode = WAL;\n\
     PRAGMA synchronous = NORMAL;\n\
     PRAGMA foreign_keys = ON;";

/// Pattern for descendants of a normalized relative path. Pair with
/// `LIKE ? ESCAPE '!'`; only the final `%` is a wildcard. This retains
/// SQLite LIKE's existing case rules and keeps the `/` component boundary.
pub fn descendant_path_pattern(path: &str) -> String {
    let mut pattern = String::with_capacity(path.len() + 2);
    for ch in path.chars() {
        if matches!(ch, '!' | '%' | '_') {
            pattern.push('!');
        }
        pattern.push(ch);
    }
    pattern.push_str("/%");
    pattern
}

/// Historical error-message wording of one database, kept stable so logs and
/// greps on the strings below do not break.
#[derive(Clone, Copy)]
pub struct DbMsgs {
    /// `open {name} <path>: …`
    pub name: &'static str,
    /// `{scope}pragma: …` and `write {scope}schema_version: …`
    /// (`""` for catalog, `"<name> "` for usage / feeds).
    pub scope: &'static str,
    /// `{read}schema_version: …` (`"read "` for catalog, else same as `scope`).
    pub read: &'static str,
    /// Suffix on the "schema version is newer than this app supports" error:
    /// catalog / usage point the user at upgrading Agentero, feeds shipped
    /// without that hint.
    pub upgrade_hint: &'static str,
}

impl DbMsgs {
    pub const CATALOG: Self = Self {
        name: "catalog",
        scope: "",
        read: "read ",
        upgrade_hint: "; upgrade Agentero",
    };
    pub const USAGE: Self = Self {
        name: "usage",
        scope: "usage ",
        read: "usage ",
        upgrade_hint: "; upgrade Agentero",
    };
    pub const FEEDS: Self = Self {
        name: "feeds",
        scope: "feeds ",
        read: "feeds ",
        upgrade_hint: "",
    };
}

/// Open `db_path` and apply [`STANDARD_PRAGMAS`].
pub fn open_standard(db_path: &Path, msgs: DbMsgs) -> Result<Connection, AppError> {
    let conn = Connection::open(db_path)
        .map_err(|e| AppError::message(format!("open {} {}: {e}", msgs.name, db_path.display())))?;
    conn.execute_batch(STANDARD_PRAGMAS)
        .map_err(|e| AppError::message(format!("{}pragma: {e}", msgs.scope)))?;
    Ok(conn)
}

/// Read `schema_meta.schema_version`; a missing table or row yields `Ok(0)`.
pub fn read_schema_version(conn: &Connection, msgs: DbMsgs) -> Result<i32, AppError> {
    // Table may not exist yet
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_meta'",
            [],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if !exists {
        return Ok(0);
    }
    conn.query_row(
        "SELECT value FROM schema_meta WHERE key = 'schema_version'",
        [],
        |row| {
            let v: String = row.get(0)?;
            Ok(v.parse::<i32>().unwrap_or(0))
        },
    )
    .map_err(|e| AppError::message(format!("{}schema_version: {e}", msgs.read)))
}

/// Upsert `schema_meta.schema_version`. The `schema_meta` table must already
/// exist (each database's v1 DDL creates it before the first version stamp).
pub fn write_schema_version(conn: &Connection, version: i32, msgs: DbMsgs) -> Result<(), AppError> {
    conn.execute(
        "INSERT INTO schema_meta(key, value) VALUES('schema_version', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [version.to_string()],
    )
    .map_err(|e| AppError::message(format!("write {}schema_version: {e}", msgs.scope)))?;
    Ok(())
}

/// One entry of a database's migration ladder, applied in ascending order by
/// [`run_migrations`]. Steps run in autocommit mode exactly like the
/// hand-written ladders did; a step that needs a transaction owns it
/// ([`MigrationStep::custom`]).
pub enum MigrationStep {
    /// Whole script via one `execute_batch` (the v1 create paths).
    Batch { version: i32, sql: &'static str },
    /// `;`-split script, one `execute_batch` per statement. SQLite aborts a
    /// multi-statement batch on the first error, so legacy `ADD COLUMN`
    /// ladders run statement-by-statement; `tolerate_duplicate_column` keeps
    /// idempotent re-runs / partially migrated databases going.
    Script {
        version: i32,
        sql: &'static str,
        tolerate_duplicate_column: bool,
    },
    /// Arbitrary logic (data migrations, transactions); owns its error wording.
    Custom {
        version: i32,
        apply: fn(&Connection) -> Result<(), AppError>,
    },
}

impl MigrationStep {
    pub const fn batch(version: i32, sql: &'static str) -> Self {
        Self::Batch { version, sql }
    }

    pub const fn script(version: i32, sql: &'static str) -> Self {
        Self::Script {
            version,
            sql,
            tolerate_duplicate_column: false,
        }
    }

    /// Per-statement script that skips `duplicate column name` errors
    /// (idempotent re-run / partial migrate of legacy `ADD COLUMN` ladders).
    pub const fn script_tolerant(version: i32, sql: &'static str) -> Self {
        Self::Script {
            version,
            sql,
            tolerate_duplicate_column: true,
        }
    }

    pub const fn custom(version: i32, apply: fn(&Connection) -> Result<(), AppError>) -> Self {
        Self::Custom { version, apply }
    }

    pub const fn version(&self) -> i32 {
        match self {
            Self::Batch { version, .. }
            | Self::Script { version, .. }
            | Self::Custom { version, .. } => *version,
        }
    }

    fn apply(&self, conn: &Connection, msgs: DbMsgs) -> Result<(), AppError> {
        match self {
            Self::Batch { version, sql } => conn
                .execute_batch(sql)
                .map_err(|e| migrate_error(msgs, *version, &e)),
            Self::Script {
                version,
                sql,
                tolerate_duplicate_column,
            } => {
                for stmt in sql.split(';') {
                    let s = stmt.trim();
                    if s.is_empty() {
                        continue;
                    }
                    match conn.execute_batch(&format!("{s};")) {
                        Ok(()) => {}
                        Err(e) => {
                            // Idempotent re-run / partial migrate
                            if *tolerate_duplicate_column
                                && e.to_string().contains("duplicate column name")
                            {
                                continue;
                            }
                            return Err(migrate_error(msgs, *version, &e));
                        }
                    }
                }
                Ok(())
            }
            Self::Custom { apply, .. } => apply(conn),
        }
    }
}

/// Historical step-failure wording: `{name} migrate v{version}: …`.
fn migrate_error(msgs: DbMsgs, version: i32, e: &rusqlite::Error) -> AppError {
    AppError::message(format!("{} migrate v{version}: {e}", msgs.name))
}

/// Run a database's migration ladder from the stored `schema_meta` version up
/// to `max_version`.
///
/// Preserves the hand-written ladders' contract, per step:
/// - a stored version above `max_version` fails immediately
///   (`{name} schema version … is newer than this app supports …`) without
///   touching the database;
/// - the stored version is re-read from the database before every step (not
///   tracked locally); a step runs only while the stored version is below its
///   own, then `stamp` records that version;
/// - a failing step stops the ladder with the version left at the last
///   successful step — there is no wrapping transaction.
///
/// `stamp` is the caller's version writer (catalog also records its
/// `agentero_app` marker there).
pub fn run_migrations(
    conn: &Connection,
    msgs: DbMsgs,
    max_version: i32,
    steps: &[MigrationStep],
    stamp: fn(&Connection, i32) -> Result<(), AppError>,
) -> Result<(), AppError> {
    // Maintenance invariants (debug only): steps ascend strictly by version
    // without duplicates, and the last step carries `max_version` — otherwise
    // a future version bump that forgets a step entry silently under-stamps
    // the database instead of failing loudly.
    debug_assert!(
        steps
            .windows(2)
            .all(|pair| pair[0].version() < pair[1].version()),
        "migration steps must be strictly ascending by version (no duplicates, no gaps)"
    );
    debug_assert!(
        steps.is_empty() || steps.last().is_some_and(|s| s.version() == max_version),
        "last migration step must carry version {max_version}"
    );

    let version = read_schema_version(conn, msgs).unwrap_or(0);
    if version > max_version {
        return Err(AppError::message(format!(
            "{} schema version {version} is newer than this app supports ({max_version}){}",
            msgs.name, msgs.upgrade_hint
        )));
    }
    for step in steps {
        let version = read_schema_version(conn, msgs).unwrap_or(0);
        if version < step.version() {
            step.apply(conn, msgs)?;
            stamp(conn, step.version())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The PRAGMA batch must stay verbatim: catalog / usage / feeds shipped
    /// with exactly this string and opening behavior must not drift. Order
    /// matters: `busy_timeout` is installed before the WAL switch.
    #[test]
    fn pragma_batch_is_verbatim() {
        assert_eq!(
            STANDARD_PRAGMAS,
            "PRAGMA busy_timeout = 5000;\nPRAGMA journal_mode = WAL;\nPRAGMA synchronous = NORMAL;\nPRAGMA foreign_keys = ON;"
        );
    }

    #[test]
    fn open_applies_pragmas_and_keeps_historical_error_wording() {
        let dir = std::env::temp_dir().join(format!(
            "agentero-core-sqlite-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("probe.sqlite");

        let conn = open_standard(&db, DbMsgs::CATALOG).expect("open");
        let mode: String = conn
            .query_row("PRAGMA journal_mode;", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        let fk: i64 = conn
            .query_row("PRAGMA foreign_keys;", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fk, 1);

        // Missing parent dir → historical per-database open error wording.
        let err = open_standard(&dir.join("no").join("such.sqlite"), DbMsgs::USAGE)
            .expect_err("open must fail");
        assert!(err.to_string().starts_with("open usage "), "{err}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn schema_version_roundtrip_and_missing_table_default() {
        let conn = Connection::open_in_memory().unwrap();
        for msgs in [DbMsgs::CATALOG, DbMsgs::USAGE, DbMsgs::FEEDS] {
            assert_eq!(read_schema_version(&conn, msgs).unwrap(), 0);
        }

        conn.execute_batch(
            "CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);",
        )
        .unwrap();
        write_schema_version(&conn, 3, DbMsgs::FEEDS).unwrap();
        assert_eq!(read_schema_version(&conn, DbMsgs::FEEDS).unwrap(), 3);
        write_schema_version(&conn, 7, DbMsgs::FEEDS).unwrap();
        assert_eq!(read_schema_version(&conn, DbMsgs::FEEDS).unwrap(), 7);

        // Historical per-database write error wording (no schema_meta table).
        let bare = Connection::open_in_memory().unwrap();
        let err = write_schema_version(&bare, 1, DbMsgs::CATALOG).expect_err("write must fail");
        assert!(
            err.to_string().starts_with("write schema_version: "),
            "{err}"
        );
        let err = write_schema_version(&bare, 1, DbMsgs::USAGE).expect_err("write must fail");
        assert!(
            err.to_string().starts_with("write usage schema_version: "),
            "{err}"
        );
    }

    /// Minimal ladder exercising every step kind. The SQL is intentionally
    /// non-idempotent (plain `CREATE TABLE`; the custom step consumes the
    /// column added by step 2) so a misplaced re-run or ordering bug fails.
    const TEST_STEPS: [MigrationStep; 3] = [
        MigrationStep::batch(1, "CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT);"),
        MigrationStep::script(2, "ALTER TABLE t ADD COLUMN c TEXT;"),
        MigrationStep::custom(3, insert_custom_row),
    ];

    fn insert_custom_row(conn: &Connection) -> Result<(), AppError> {
        conn.execute("INSERT INTO t (note, c) VALUES ('custom', 'x')", [])?;
        Ok(())
    }

    fn stamp_usage(conn: &Connection, version: i32) -> Result<(), AppError> {
        write_schema_version(conn, version, DbMsgs::USAGE)
    }

    fn create_schema_meta(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);",
        )
        .unwrap();
    }

    #[test]
    fn run_migrations_applies_ladder_ascending_and_skips_when_current() {
        let conn = Connection::open_in_memory().unwrap();
        create_schema_meta(&conn);

        run_migrations(&conn, DbMsgs::USAGE, 3, &TEST_STEPS, stamp_usage).unwrap();
        assert_eq!(read_schema_version(&conn, DbMsgs::USAGE).unwrap(), 3);
        // The custom step only succeeds if both earlier steps ran before it.
        let custom: i64 = conn
            .query_row("SELECT COUNT(*) FROM t WHERE note = 'custom'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(custom, 1);

        // Re-running at the current version must skip every step: the plain
        // CREATE TABLE would error if replayed.
        run_migrations(&conn, DbMsgs::USAGE, 3, &TEST_STEPS, stamp_usage).unwrap();
        assert_eq!(read_schema_version(&conn, DbMsgs::USAGE).unwrap(), 3);
    }

    #[test]
    fn run_migrations_resumes_from_stored_version_and_tolerates_duplicate_columns() {
        let conn = Connection::open_in_memory().unwrap();
        create_schema_meta(&conn);
        // Partially migrated database: the step-2 column already exists.
        conn.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT, c TEXT);")
            .unwrap();
        write_schema_version(&conn, 1, DbMsgs::USAGE).unwrap();

        // Strict script: the duplicate column fails with the historical step
        // wording and leaves the stored version untouched.
        let strict = [MigrationStep::script(2, "ALTER TABLE t ADD COLUMN c TEXT;")];
        let err = run_migrations(&conn, DbMsgs::USAGE, 2, &strict, stamp_usage)
            .expect_err("duplicate column must fail in a strict script");
        assert!(err.to_string().starts_with("usage migrate v2: "), "{err}");
        assert_eq!(read_schema_version(&conn, DbMsgs::USAGE).unwrap(), 1);

        // Tolerant script (the legacy ADD COLUMN path) skips the duplicate and
        // carries on; the v1 step stays skipped because it is below the stored
        // version (its CREATE would error if replayed).
        let tolerant = [
            MigrationStep::batch(
                1,
                "CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT, c TEXT);",
            ),
            MigrationStep::script_tolerant(2, "ALTER TABLE t ADD COLUMN c TEXT;"),
        ];
        run_migrations(&conn, DbMsgs::USAGE, 2, &tolerant, stamp_usage).unwrap();
        assert_eq!(read_schema_version(&conn, DbMsgs::USAGE).unwrap(), 2);
    }

    #[test]
    fn run_migrations_rejects_newer_version_before_any_step() {
        let conn = Connection::open_in_memory().unwrap();
        create_schema_meta(&conn);

        // Historical per-database wording, including feeds' missing hint.
        for (msgs, max, expected) in [
            (
                DbMsgs::CATALOG,
                8,
                "catalog schema version 9 is newer than this app supports (8); upgrade Agentero",
            ),
            (
                DbMsgs::FEEDS,
                4,
                "feeds schema version 9 is newer than this app supports (4)",
            ),
            (
                DbMsgs::USAGE,
                1,
                "usage schema version 9 is newer than this app supports (1); upgrade Agentero",
            ),
        ] {
            write_schema_version(&conn, 9, msgs).unwrap();
            // Per-case ladder ending exactly at `max` (the entry invariant);
            // its CREATE must not run because the guard fires first.
            let steps = [MigrationStep::batch(
                max,
                "CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT);",
            )];
            let err = run_migrations(&conn, msgs, max, &steps, stamp_usage)
                .expect_err("newer version must fail");
            assert_eq!(err.to_string(), expected);
            // The stamp is untouched and no step ran.
            assert_eq!(read_schema_version(&conn, msgs).unwrap(), 9);
        }

        let t: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 't'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(t, 0);
    }
}
