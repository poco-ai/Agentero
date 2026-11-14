//! Reads, clears, and path renames over the activity log.

use crate::error::AppError;
use crate::fs::normalize_rel_separators;
use crate::sqlite::descendant_path_pattern;
use rusqlite::params;
use serde::Serialize;
use std::path::Path;

use super::schema::{ensure_usage_at, paper_path_of};

#[derive(Debug, Clone, Default)]
pub struct ListFilter {
    pub vault: Option<String>,
    pub kind: Option<String>,
    pub path_prefix: Option<String>,
    pub since: Option<String>,
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageEvent {
    pub id: i64,
    pub ts: String,
    pub vault: Option<String>,
    pub kind: String,
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paper_path: Option<String>,
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub facet: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub dur_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qty: Option<i64>,
    #[specta(type = Option<crate::json::Json>)]
    pub extra: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageKindCount {
    pub kind: String,
    pub count: i64,
    pub dur_ms: i64,
}

pub fn list_events(db_path: &Path, filter: &ListFilter) -> Result<Vec<UsageEvent>, AppError> {
    let conn = ensure_usage_at(db_path)?;
    let limit = filter.limit.clamp(1, 1000) as i64;
    let vault = filter
        .vault
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("");
    let kind = filter
        .kind
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("");
    let prefix = filter
        .path_prefix
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("");
    let prefix = normalize_rel_separators(prefix);
    let like = descendant_path_pattern(&prefix);
    let since = filter
        .since
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("");
    let mut stmt = conn
        .prepare(
            "SELECT id, ts, vault, kind, path, paper_path, mode, facet, status, dur_ms, qty, extra
             FROM usage_events
             WHERE (?1 = '' OR vault = ?1)
               AND (?2 = '' OR kind = ?2)
               AND (?3 = '' OR path = ?3 OR path LIKE ?4 ESCAPE '!'
                    OR paper_path = ?3 OR paper_path LIKE ?4 ESCAPE '!')
               AND (?5 = '' OR ts >= ?5)
             ORDER BY ts DESC, id DESC
             LIMIT ?6",
        )
        .map_err(|e| AppError::message(format!("list usage prepare: {e}")))?;
    let mut rows = stmt
        .query(params![vault, kind, prefix, like, since, limit])
        .map_err(|e| AppError::message(format!("list usage query: {e}")))?;
    let mut out = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|e| AppError::message(format!("list usage row: {e}")))?
    {
        out.push(row_to_event(row)?);
    }
    Ok(out)
}

pub fn summarize(
    db_path: &Path,
    vault: Option<&str>,
    since: Option<&str>,
) -> Result<Vec<UsageKindCount>, AppError> {
    let conn = ensure_usage_at(db_path)?;
    let vault = vault.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("");
    let since = since.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("");
    let mut stmt = conn
        .prepare(
            "SELECT kind, COUNT(*), COALESCE(SUM(dur_ms), 0)
             FROM usage_events
             WHERE (?1 = '' OR vault = ?1)
               AND (?2 = '' OR ts >= ?2)
             GROUP BY kind
             ORDER BY COUNT(*) DESC, kind ASC",
        )
        .map_err(|e| AppError::message(format!("usage summary prepare: {e}")))?;
    let mut rows = stmt
        .query(params![vault, since])
        .map_err(|e| AppError::message(format!("usage summary query: {e}")))?;
    let mut out = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|e| AppError::message(format!("usage summary row: {e}")))?
    {
        out.push(UsageKindCount {
            kind: row.get(0)?,
            count: row.get(1)?,
            dur_ms: row.get(2)?,
        });
    }
    Ok(out)
}

/// Cumulative effective reading milliseconds, scoped to one device-local vault.
/// `paper.session` duplicates blur durations and must never enter this sum.
pub fn reading_durations(
    db_path: &Path,
    vault: &str,
) -> Result<std::collections::HashMap<String, i64>, AppError> {
    let vault = vault.trim();
    if vault.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let conn = ensure_usage_at(db_path)?;
    let mut stmt = conn
        .prepare(
            "SELECT paper_path, SUM(dur_ms) FROM usage_daily
         WHERE vault = ?1 AND kind = 'paper.blur' AND paper_path != ''
         GROUP BY paper_path",
        )
        .map_err(|e| AppError::message(format!("reading durations prepare: {e}")))?;
    let rows = stmt
        .query_map([vault], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|e| AppError::message(format!("reading durations query: {e}")))?;
    rows.collect::<Result<std::collections::HashMap<_, _>, _>>()
        .map_err(|e| AppError::message(format!("reading durations row: {e}")))
}

pub fn clear_all(db_path: &Path) -> Result<u64, AppError> {
    let conn = ensure_usage_at(db_path)?;
    let n = conn
        .execute("DELETE FROM usage_events", [])
        .map_err(|e| AppError::message(format!("clear usage_events: {e}")))?;
    conn.execute("DELETE FROM usage_daily", [])
        .map_err(|e| AppError::message(format!("clear usage_daily: {e}")))?;
    conn.execute("DELETE FROM usage_memories", [])
        .map_err(|e| AppError::message(format!("clear usage_memories: {e}")))?;
    conn.execute("DELETE FROM usage_vaults", [])
        .map_err(|e| AppError::message(format!("clear usage_vaults: {e}")))?;
    Ok(n as u64)
}

pub fn clear_vault(db_path: &Path, vault: &str) -> Result<u64, AppError> {
    let vault = vault.trim();
    if vault.is_empty() {
        return Ok(0);
    }
    let conn = ensure_usage_at(db_path)?;
    let n = conn
        .execute("DELETE FROM usage_events WHERE vault = ?1", [vault])
        .map_err(|e| AppError::message(format!("clear vault usage_events: {e}")))?;
    conn.execute("DELETE FROM usage_daily WHERE vault = ?1", [vault])
        .map_err(|e| AppError::message(format!("clear vault usage_daily: {e}")))?;
    conn.execute("DELETE FROM usage_memories WHERE vault = ?1", [vault])
        .map_err(|e| AppError::message(format!("clear vault usage_memories: {e}")))?;
    Ok(n as u64)
}

/// Rewrite stored `path` / `paper_path` prefixes after a paper or note moves.
/// Returns the number of touched rows across `usage_events` and `usage_daily`.
pub fn rename_path(db_path: &Path, vault: &str, from: &str, to: &str) -> Result<u64, AppError> {
    let from = normalize_rel_separators(from.trim());
    let to = normalize_rel_separators(to.trim());
    if from.is_empty() || to.is_empty() || from == to {
        return Ok(0);
    }
    let vault = vault.trim();
    if vault.is_empty() {
        return Ok(0);
    }
    let from_paper = paper_path_of(&from).unwrap_or_else(|| from.clone());
    let to_paper = paper_path_of(&to).unwrap_or_else(|| to.clone());
    let conn = ensure_usage_at(db_path)?;
    let like = descendant_path_pattern(&from);
    let paper_like = descendant_path_pattern(&from_paper);
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| AppError::message(format!("usage rename tx: {e}")))?;
    let reading_events = tx
        .execute(
            "UPDATE usage_events SET
           path = CASE WHEN path = ?1 THEN ?2 ELSE ?2 || substr(path, length(?1) + 1) END,
           paper_path = CASE
             WHEN paper_path = ?1 THEN ?2
             WHEN paper_path LIKE ?3 ESCAPE '!' THEN ?2 || substr(paper_path, length(?1) + 1)
             ELSE paper_path END
         WHERE vault = ?4 AND kind = 'paper.blur' AND (path = ?1 OR path LIKE ?3 ESCAPE '!')",
            params![from, to, like, vault],
        )
        .map_err(|e| AppError::message(format!("rename reading events: {e}")))?;
    let reading_daily = rename_daily_totals(&tx, vault, &from, &to, true)?;
    let events = tx
        .execute(
            "UPDATE usage_events
             SET path = CASE
               WHEN path = ?1 THEN ?2
               WHEN path LIKE ?3 ESCAPE '!' THEN ?2 || substr(path, length(?1) + 1)
               ELSE path
             END,
             paper_path = CASE
               WHEN paper_path = ?5 THEN ?6
               WHEN paper_path LIKE ?7 ESCAPE '!' THEN ?6 || substr(paper_path, length(?5) + 1)
               ELSE paper_path
             END
             WHERE vault = ?4 AND kind != 'paper.blur' AND (
               path = ?1 OR path LIKE ?3 ESCAPE '!' OR paper_path = ?5 OR paper_path LIKE ?7 ESCAPE '!'
             )",
            params![from, to, like, vault, from_paper, to_paper, paper_like],
        )
        .map_err(|e| AppError::message(format!("rename usage_events: {e}")))?;
    let daily = rename_daily_totals(&tx, vault, &from_paper, &to_paper, false)?;
    tx.commit()
        .map_err(|e| AppError::message(format!("usage rename commit: {e}")))?;
    Ok((reading_events + reading_daily + events + daily) as u64)
}

fn rename_daily_totals(
    tx: &rusqlite::Transaction<'_>,
    vault: &str,
    from: &str,
    to: &str,
    reading: bool,
) -> Result<usize, AppError> {
    if from == to {
        return Ok(0);
    }
    let like = descendant_path_pattern(from);
    let merged = tx
        .execute(
            "INSERT INTO usage_daily (day, vault, kind, paper_path, facet, count, dur_ms, qty)
         SELECT day, vault, kind,
           CASE WHEN paper_path = ?1 THEN ?2 ELSE ?2 || substr(paper_path, length(?1) + 1) END,
           facet, count, dur_ms, qty FROM usage_daily
         WHERE vault = ?3 AND (paper_path = ?1 OR paper_path LIKE ?4 ESCAPE '!')
           AND (kind = 'paper.blur') = ?5
         ON CONFLICT(day, vault, kind, paper_path, facet) DO UPDATE SET
           count = usage_daily.count + excluded.count,
           dur_ms = usage_daily.dur_ms + excluded.dur_ms,
           qty = usage_daily.qty + excluded.qty",
            params![from, to, vault, like, reading],
        )
        .map_err(|e| AppError::message(format!("rename usage_daily: {e}")))?;
    tx.execute(
        "DELETE FROM usage_daily WHERE vault = ?2
         AND (paper_path = ?1 OR paper_path LIKE ?3 ESCAPE '!')
         AND (kind = 'paper.blur') = ?4",
        params![from, vault, like, reading],
    )
    .map_err(|e| AppError::message(format!("rename usage_daily source: {e}")))?;
    Ok(merged)
}

fn row_to_event(row: &rusqlite::Row<'_>) -> Result<UsageEvent, AppError> {
    let extra_raw: Option<String> = row.get(11)?;
    let extra = match extra_raw.as_deref() {
        None | Some("") => None,
        Some(raw) => Some(serde_json::from_str(raw)?),
    };
    Ok(UsageEvent {
        id: row.get(0)?,
        ts: row.get(1)?,
        vault: row.get(2)?,
        kind: row.get(3)?,
        path: row.get(4)?,
        paper_path: row.get(5)?,
        mode: row.get(6)?,
        facet: row.get(7)?,
        status: row.get(8)?,
        dur_ms: row.get(9)?,
        qty: row.get(10)?,
        extra,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::{rec, record_events, temp_db};
    use std::fs;

    #[test]
    fn reading_durations_sum_blur_only_across_reopens_and_preserve_old_rollups() {
        let root = tempfile::tempdir().unwrap();
        let db = root.path().join("usage.sqlite");
        let mut first = rec("paper.blur", "papers/demo");
        first.ts = None;
        first.dur_ms = Some(50_000);
        let mut second = first.clone();
        second.path = Some("papers/demo".into());
        second.dur_ms = Some(10_000);
        let mut session = first.clone();
        session.kind = "paper.session".into();
        let mut other_vault = first.clone();
        other_vault.vault = Some("/other".into());
        record_events(&db, &[first, second, session, other_vault]).unwrap();
        assert_eq!(
            reading_durations(&db, "/vaults/demo").unwrap()["papers/demo"],
            60_000
        );
        let conn = ensure_usage_at(&db).unwrap();
        conn.execute("INSERT INTO usage_daily (day,vault,kind,paper_path,dur_ms) VALUES ('2000-01-01','/vaults/demo','paper.blur','papers/old',5000)", []).unwrap();
        conn.execute("INSERT INTO usage_daily (day,vault,kind,paper_path,dur_ms) VALUES ('2000-01-01','/vaults/demo','paper.session','papers/old',5000)", []).unwrap();
        drop(conn);
        let totals = reading_durations(&db, "/vaults/demo").unwrap();
        assert_eq!(totals["papers/demo"], 60_000);
        assert_eq!(totals["papers/old"], 5000);
        assert!(reading_durations(&db, "").unwrap().is_empty());
        let mut nested = rec("paper.blur", "papers/topic/nested");
        nested.ts = None;
        nested.dur_ms = Some(3000);
        record_events(&db, &[nested]).unwrap();
        assert_eq!(
            reading_durations(&db, "/vaults/demo").unwrap()["papers/topic/nested"],
            3000
        );
    }

    #[test]
    fn reading_duration_rename_moves_only_the_nested_paper_and_merges_target() {
        let root = tempfile::tempdir().unwrap();
        let db = root.path().join("usage.sqlite");
        let records = [
            ("papers/topic/old", 50_000),
            ("papers/topic/new", 10_000),
            ("papers/topic/sibling", 7000),
        ]
        .map(|(path, duration)| {
            let mut record = rec("paper.blur", path);
            record.ts = None;
            record.dur_ms = Some(duration);
            record
        });
        record_events(&db, &records).unwrap();
        rename_path(&db, "/vaults/demo", "papers/topic/old", "papers/topic/new").unwrap();
        let totals = reading_durations(&db, "/vaults/demo").unwrap();
        assert_eq!(totals["papers/topic/new"], 60_000);
        assert_eq!(totals["papers/topic/sibling"], 7000);
        assert!(!totals.contains_key("papers/topic/old"));
    }

    #[test]
    fn literal_path_prefix_filters_and_renames_only_its_subtree() {
        let root = tempfile::tempdir().unwrap();
        let db = root.path().join("usage.sqlite");
        let conn = ensure_usage_at(&db).unwrap();
        let from = "papers/a%_!论文";
        let to = "papers/moved%_!论文";
        let matching = [
            from.to_string(),
            format!("{from}/child"),
            format!("{from}/child/deep"),
        ];
        let siblings = [
            "papers/aXY!论文/child",
            "papers/a%_!论文-more/child",
            "papers/a%_论文/child",
            "papers/other/a%_!论文/child",
        ];
        for path in matching.iter().map(String::as_str).chain(siblings) {
            conn.execute("INSERT INTO usage_events (ts,vault,kind,path,paper_path) VALUES (datetime('now'),'/vault','paper.open',?1,?1)", [path]).unwrap();
            conn.execute("INSERT INTO usage_daily (day,vault,kind,paper_path,count) VALUES (date('now'),'/vault','paper.open',?1,1)", [path]).unwrap();
        }
        // Same path in another vault must not move.
        conn.execute("INSERT INTO usage_events (ts,vault,kind,path,paper_path) VALUES (datetime('now'),'/other','paper.open',?1,?1)", [from]).unwrap();
        let rows = list_events(
            &db,
            &ListFilter {
                vault: Some("/vault".into()),
                path_prefix: Some(from.replace('/', "\\")),
                limit: 100,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(rows.len(), 3);
        assert!(rows
            .iter()
            .all(|row| matching.iter().any(|path| row.path.as_ref() == Some(path))));
        assert_eq!(
            rename_path(
                &db,
                "/vault",
                &from.replace('/', "\\"),
                &to.replace('/', "\\")
            )
            .unwrap(),
            6
        );
        for path in &matching {
            let moved = path.replacen(from, to, 1);
            assert_eq!(conn.query_row("SELECT count(*) FROM usage_events WHERE vault='/vault' AND path=?1 AND paper_path=?1", [&moved], |r| r.get::<_, i64>(0)).unwrap(), 1);
            assert_eq!(
                conn.query_row(
                    "SELECT count FROM usage_daily WHERE vault='/vault' AND paper_path=?1",
                    [&moved],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                1
            );
        }
        for path in siblings {
            assert_eq!(conn.query_row("SELECT count(*) FROM usage_events WHERE vault='/vault' AND path=?1 AND paper_path=?1", [path], |r| r.get::<_, i64>(0)).unwrap(), 1);
            assert_eq!(
                conn.query_row(
                    "SELECT count FROM usage_daily WHERE vault='/vault' AND paper_path=?1",
                    [path],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                1
            );
        }
        assert_eq!(
            conn.query_row(
                "SELECT path FROM usage_events WHERE vault='/other'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            from
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM usage_daily", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            7
        );
    }

    #[test]
    fn rename_updates_prefix() {
        let db = temp_db();
        record_events(
            &db,
            &[
                rec("paper.open", "papers/old"),
                rec("note.open", "papers/old/NOTES.md"),
            ],
        )
        .unwrap();
        let n = rename_path(&db, "/vaults/demo", "papers/old", "papers/new").unwrap();
        assert!(n >= 2);
        let rows = list_events(
            &db,
            &ListFilter {
                path_prefix: Some("papers/new".into()),
                limit: 10,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows
            .iter()
            .all(|r| r.paper_path.as_deref() == Some("papers/new")));
        let _ = fs::remove_dir_all(db.parent().unwrap());
    }

    #[test]
    fn rename_merges_when_target_already_exists() {
        let db = temp_db();
        record_events(
            &db,
            &[
                rec("paper.open", "papers/old"),
                rec("paper.open", "papers/new"),
            ],
        )
        .unwrap();
        let res = rename_path(&db, "/vaults/demo", "papers/old", "papers/new");
        assert!(res.is_ok());
        let _ = fs::remove_dir_all(db.parent().unwrap());
    }
}
