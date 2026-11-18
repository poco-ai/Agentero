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

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageDayStat {
    pub day: String,
    pub reading_ms: i64,
    pub agent_runs: i64,
    pub tokens: i64,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UsagePaperStat {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub reading_ms: i64,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageWorkflowStat {
    pub workflow: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageBoard {
    pub days: Vec<UsageDayStat>,
    pub papers: Vec<UsagePaperStat>,
    pub workflows: Vec<UsageWorkflowStat>,
    pub week_paper_count: i64,
}

#[derive(Debug, Clone)]
pub struct UsageBoardQuery {
    pub vault: String,
    pub start_day: String,
    pub end_day: String,
    pub week_start: String,
}

pub fn usage_board(db_path: &Path, query: &UsageBoardQuery) -> Result<UsageBoard, AppError> {
    if !is_day(&query.start_day) || !is_day(&query.end_day) || !is_day(&query.week_start) {
        return Err(AppError::message("usage board dates must be YYYY-MM-DD"));
    }
    let vault = query.vault.trim();
    if vault.is_empty() {
        return Ok(UsageBoard {
            days: Vec::new(),
            papers: Vec::new(),
            workflows: Vec::new(),
            week_paper_count: 0,
        });
    }
    let conn = ensure_usage_at(db_path)?;
    let days = board_days(&conn, vault, &query.start_day, &query.end_day)?;
    let papers = board_papers(&conn, vault, &query.week_start, &query.end_day)?;
    let workflows = board_workflows(&conn, vault, &query.week_start, &query.end_day)?;
    let week_paper_count = board_week_papers(&conn, vault, &query.week_start, &query.end_day)?;
    Ok(UsageBoard {
        days,
        papers,
        workflows,
        week_paper_count,
    })
}

fn is_day(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
}

fn board_days(
    conn: &rusqlite::Connection,
    vault: &str,
    start: &str,
    end: &str,
) -> Result<Vec<UsageDayStat>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT day,
                COALESCE(SUM(CASE WHEN kind = 'paper.session' THEN dur_ms ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN kind = 'agent.run' THEN count ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN kind = 'agent.usage' THEN qty ELSE 0 END), 0)
             FROM usage_daily
             WHERE vault = ?1 AND day >= ?2 AND day <= ?3
             GROUP BY day
             ORDER BY day ASC",
        )
        .map_err(|e| AppError::message(format!("usage board days prepare: {e}")))?;
    let mut rows = stmt
        .query(params![vault, start, end])
        .map_err(|e| AppError::message(format!("usage board days query: {e}")))?;
    let mut out = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|e| AppError::message(format!("usage board days row: {e}")))?
    {
        out.push(UsageDayStat {
            day: row.get(0)?,
            reading_ms: row.get(1)?,
            agent_runs: row.get(2)?,
            tokens: row.get(3)?,
        });
    }
    Ok(out)
}

fn board_papers(
    conn: &rusqlite::Connection,
    vault: &str,
    start: &str,
    end: &str,
) -> Result<Vec<UsagePaperStat>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT paper_path, COALESCE(SUM(dur_ms), 0)
             FROM usage_daily
             WHERE vault = ?1 AND kind = 'paper.session'
               AND day >= ?2 AND day <= ?3 AND paper_path <> ''
             GROUP BY paper_path
             ORDER BY SUM(dur_ms) DESC, paper_path ASC
             LIMIT 8",
        )
        .map_err(|e| AppError::message(format!("usage board papers prepare: {e}")))?;
    let mut rows = stmt
        .query(params![vault, start, end])
        .map_err(|e| AppError::message(format!("usage board papers query: {e}")))?;
    let mut out = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|e| AppError::message(format!("usage board papers row: {e}")))?
    {
        out.push(UsagePaperStat {
            path: row.get(0)?,
            title: None,
            reading_ms: row.get(1)?,
        });
    }
    Ok(out)
}

fn board_workflows(
    conn: &rusqlite::Connection,
    vault: &str,
    start: &str,
    end: &str,
) -> Result<Vec<UsageWorkflowStat>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT facet, COALESCE(SUM(count), 0)
             FROM usage_daily
             WHERE vault = ?1 AND kind = 'agent.run' AND day >= ?2 AND day <= ?3
             GROUP BY facet
             ORDER BY SUM(count) DESC, facet ASC",
        )
        .map_err(|e| AppError::message(format!("usage board workflows prepare: {e}")))?;
    let mut rows = stmt
        .query(params![vault, start, end])
        .map_err(|e| AppError::message(format!("usage board workflows query: {e}")))?;
    let mut out = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|e| AppError::message(format!("usage board workflows row: {e}")))?
    {
        out.push(UsageWorkflowStat {
            workflow: row.get(0)?,
            count: row.get(1)?,
        });
    }
    Ok(out)
}

fn board_week_papers(
    conn: &rusqlite::Connection,
    vault: &str,
    start: &str,
    end: &str,
) -> Result<i64, AppError> {
    conn.query_row(
        "SELECT COUNT(DISTINCT paper_path)
         FROM usage_daily
         WHERE vault = ?1 AND kind = 'paper.session'
           AND day >= ?2 AND day <= ?3 AND paper_path <> ''",
        params![vault, start, end],
        |row| row.get(0),
    )
    .map_err(|e| AppError::message(format!("usage board paper count: {e}")))
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
             WHERE vault = ?4 AND (
               path = ?1 OR path LIKE ?3 ESCAPE '!' OR paper_path = ?5 OR paper_path LIKE ?7 ESCAPE '!'
             )",
            params![from, to, like, vault, from_paper, to_paper, paper_like],
        )
        .map_err(|e| AppError::message(format!("rename usage_events: {e}")))?;
    let daily = if from_paper != to_paper {
        let merged = tx
            .execute(
                "INSERT INTO usage_daily (day, vault, kind, paper_path, facet, count, dur_ms, qty)
                 SELECT day, vault, kind,
                   CASE
                     WHEN paper_path = ?1 THEN ?2
                     WHEN paper_path LIKE ?4 ESCAPE '!' THEN ?2 || substr(paper_path, length(?1) + 1)
                     ELSE paper_path
                   END,
                   facet, count, dur_ms, qty
                 FROM usage_daily
                 WHERE vault = ?3 AND (paper_path = ?1 OR paper_path LIKE ?4 ESCAPE '!')
                 ON CONFLICT(day, vault, kind, paper_path, facet) DO UPDATE SET
                   count = usage_daily.count + excluded.count,
                   dur_ms = usage_daily.dur_ms + excluded.dur_ms,
                   qty = usage_daily.qty + excluded.qty",
                params![from_paper, to_paper, vault, paper_like],
            )
            .map_err(|e| AppError::message(format!("rename usage_daily: {e}")))?;
        let _ = tx.execute(
            "DELETE FROM usage_daily
             WHERE vault = ?2 AND (paper_path = ?1 OR paper_path LIKE ?3 ESCAPE '!')",
            params![from_paper, vault, paper_like],
        );
        merged
    } else {
        0
    };
    tx.commit()
        .map_err(|e| AppError::message(format!("usage rename commit: {e}")))?;
    Ok((events + daily) as u64)
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
