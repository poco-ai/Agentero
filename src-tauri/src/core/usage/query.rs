//! Reads, clears, and path renames over the activity log.

use crate::core::error::AppError;
use rusqlite::params;
use serde::Serialize;
use std::path::Path;

use super::record::normalize_rel;
use super::schema::{ensure_usage_at, paper_path_of};

#[derive(Debug, Clone, Default)]
pub struct ListFilter {
    pub vault: Option<String>,
    pub kind: Option<String>,
    pub path_prefix: Option<String>,
    pub since: Option<String>,
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize)]
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
    pub extra: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
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
    let like = if prefix.is_empty() {
        String::new()
    } else {
        format!("{prefix}/%")
    };
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
               AND (?3 = '' OR path = ?3 OR path LIKE ?4
                    OR paper_path = ?3 OR paper_path LIKE ?4)
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
    let from = normalize_rel(from);
    let to = normalize_rel(to);
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
    let like = format!("{from}/%");
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| AppError::message(format!("usage rename tx: {e}")))?;
    let events = tx
        .execute(
            "UPDATE usage_events
             SET path = CASE
               WHEN path = ?1 THEN ?2
               WHEN path LIKE ?3 THEN ?2 || substr(path, length(?1) + 1)
               ELSE path
             END,
             paper_path = CASE
               WHEN paper_path = ?5 THEN ?6
               WHEN paper_path LIKE ?5 || '/%' THEN ?6 || substr(paper_path, length(?5) + 1)
               ELSE paper_path
             END
             WHERE vault = ?4 AND (
               path = ?1 OR path LIKE ?3 OR paper_path = ?5 OR paper_path LIKE ?5 || '/%'
             )",
            params![from, to, like, vault, from_paper, to_paper],
        )
        .map_err(|e| AppError::message(format!("rename usage_events: {e}")))?;
    let daily = tx
        .execute(
            "UPDATE usage_daily
             SET paper_path = CASE
               WHEN paper_path = ?1 THEN ?2
               WHEN paper_path LIKE ?1 || '/%' THEN ?2 || substr(paper_path, length(?1) + 1)
               ELSE paper_path
             END
             WHERE vault = ?3 AND (paper_path = ?1 OR paper_path LIKE ?1 || '/%')",
            params![from_paper, to_paper, vault],
        )
        .map_err(|e| AppError::message(format!("rename usage_daily: {e}")))?;
    tx.commit()
        .map_err(|e| AppError::message(format!("usage rename commit: {e}")))?;
    Ok((events + daily) as u64)
}

/// RFC3339 UTC cutoff `days` ago, for `ListFilter::since`.
pub fn since_rfc3339_days(days: u32) -> String {
    let days = i64::from(days.max(1));
    (chrono::Utc::now() - chrono::Duration::days(days))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
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
    use crate::core::usage::{rec, record_events, temp_db};
    use std::fs;

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
}
