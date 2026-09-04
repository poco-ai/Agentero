//! Append-only event writes, daily rollup, rename, and queries.

use crate::core::error::AppError;
use crate::features::usage::schema::{ensure_usage_at, paper_path_of};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::path::Path;

const MAX_BATCH: usize = 200;
const MAX_KIND: usize = 64;
const MAX_PATH: usize = 1024;
const MAX_VAULT: usize = 1024;
const MAX_MODE: usize = 64;
const MAX_FACET: usize = 64;
const MAX_STATUS: usize = 16;
const MAX_EXTRA_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecord {
    #[serde(default)]
    pub ts: Option<String>,
    #[serde(default)]
    pub vault: Option<String>,
    pub kind: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub dur_ms: Option<i64>,
    #[serde(default)]
    pub extra: Option<serde_json::Value>,
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
pub struct UsageKindCount {
    pub kind: String,
    pub count: i64,
    pub dur_ms: i64,
}

pub fn record_events(db_path: &Path, events: &[UsageRecord]) -> Result<usize, AppError> {
    if events.is_empty() {
        return Ok(0);
    }
    if events.len() > MAX_BATCH {
        return Err(AppError::message(format!(
            "too many usage events in one batch ({}); max {MAX_BATCH}",
            events.len()
        )));
    }
    let conn = ensure_usage_at(db_path)?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| AppError::message(format!("usage tx: {e}")))?;
    let mut inserted = 0usize;
    for raw in events {
        let event = normalize(raw)?;
        if let Some(vault) = event.vault.as_deref() {
            upsert_vault(&tx, vault, &event.ts)?;
        }
        tx.execute(
            "INSERT INTO usage_events
             (ts, vault, kind, path, paper_path, mode, facet, status, dur_ms, qty, extra)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                event.ts,
                event.vault,
                event.kind,
                event.path,
                event.paper_path,
                event.mode,
                event.facet,
                event.status,
                event.dur_ms,
                event.qty,
                event.extra,
            ],
        )
        .map_err(|e| AppError::message(format!("insert usage event: {e}")))?;
        upsert_daily(&tx, &event)?;
        inserted += 1;
    }
    tx.commit()
        .map_err(|e| AppError::message(format!("usage commit: {e}")))?;
    Ok(inserted)
}

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

struct Normalized {
    ts: String,
    vault: Option<String>,
    kind: String,
    path: Option<String>,
    paper_path: Option<String>,
    mode: Option<String>,
    facet: Option<String>,
    status: Option<String>,
    dur_ms: Option<i64>,
    qty: Option<i64>,
    extra: Option<String>,
}

fn normalize(raw: &UsageRecord) -> Result<Normalized, AppError> {
    let kind = raw.kind.trim().to_ascii_lowercase();
    if kind.is_empty() || kind.len() > MAX_KIND || !kind_ok(&kind) {
        return Err(AppError::message(format!(
            "invalid usage kind: {}",
            raw.kind
        )));
    }
    let vault = optional_trimmed(&raw.vault, MAX_VAULT);
    let path = raw
        .path
        .as_deref()
        .map(normalize_rel)
        .filter(|s| !s.is_empty());
    if path.as_ref().is_some_and(|p| p.len() > MAX_PATH) {
        return Err(AppError::message("usage path too long"));
    }
    let paper_path = path.as_deref().and_then(paper_path_of);
    let mode = optional_trimmed(&raw.mode, MAX_MODE);
    let (facet, status, qty) = project_extra(&kind, mode.as_deref(), raw.extra.as_ref());
    let dur_ms = raw.dur_ms.filter(|n| *n >= 0);
    let extra = match &raw.extra {
        None | Some(serde_json::Value::Null) => None,
        Some(value) => {
            let encoded = serde_json::to_string(value)?;
            if encoded.len() > MAX_EXTRA_BYTES {
                return Err(AppError::message("usage extra payload too large"));
            }
            Some(encoded)
        }
    };
    let ts = raw
        .ts
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(now_rfc3339);
    Ok(Normalized {
        ts,
        vault,
        kind,
        path,
        paper_path,
        mode,
        facet,
        status,
        dur_ms,
        qty,
        extra,
    })
}

fn project_extra(
    kind: &str,
    mode: Option<&str>,
    extra: Option<&serde_json::Value>,
) -> (Option<String>, Option<String>, Option<i64>) {
    let obj = extra.and_then(|v| v.as_object());
    let extra_str = |key: &str| -> Option<String> {
        obj.and_then(|m| m.get(key))
            .and_then(|v| {
                v.as_str().map(|s| s.to_string()).or_else(|| {
                    if v.is_boolean() || v.is_number() {
                        Some(v.to_string())
                    } else {
                        None
                    }
                })
            })
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(MAX_FACET).collect())
    };
    let extra_i64 = |keys: &[&str]| -> Option<i64> {
        let map = obj?;
        for key in keys {
            if let Some(n) = map.get(*key).and_then(|v| {
                v.as_i64()
                    .or_else(|| v.as_u64().map(|n| n as i64))
                    .or_else(|| v.as_f64().map(|n| n as i64))
                    .or_else(|| v.as_array().map(|a| a.len() as i64))
            }) {
                if n >= 0 {
                    return Some(n);
                }
            }
        }
        None
    };

    let facet = match kind {
        "paper.open" | "note.open" => mode.map(str::to_string),
        "paper.import" => extra_str("source"),
        "asset.download" => extra_str("asset").or_else(|| {
            if obj.and_then(|m| m.get("pdf")).and_then(|v| v.as_bool()) == Some(true) {
                Some("pdf".into())
            } else if obj.and_then(|m| m.get("tex")).and_then(|v| v.as_bool()) == Some(true) {
                Some("tex".into())
            } else {
                None
            }
        }),
        "agent.run" => extra_str("workflow"),
        k if k.starts_with("translate.") => {
            extra_str("providerFamily").or_else(|| extra_str("provider"))
        }
        "layout.analyze" => extra_str("trigger"),
        k if k.starts_with("skill.") => extra_str("sourceKind"),
        k if k.starts_with("mark.") => extra_str("type"),
        "paper.tag" => extra_str("op"),
        "paper.read" => extra_str("via").or_else(|| extra_str("isRead")),
        "app.started" | "app.exited" => extra_str("app_version"),
        k if k.starts_with("refs.") => extra_str("trigger"),
        k if k.starts_with("zotero.") => extra_str("direction").or_else(|| extra_str("source")),
        _ => extra_str("facet"),
    }
    .filter(|s| s.len() <= MAX_FACET);

    let status = extra_str("status").and_then(|s| {
        let s = s.to_ascii_lowercase();
        matches!(s.as_str(), "ok" | "fail" | "cancel").then_some(s)
    });
    let status = status.filter(|s| s.len() <= MAX_STATUS);
    let qty = extra_i64(&[
        "qty",
        "count",
        "hits",
        "region_count",
        "regionCount",
        "tagCount",
        "tag_count",
        "chars",
        "installed",
    ]);
    (facet, status, qty)
}

/// Sanitized PostHog projection of an activity event.
///
/// Only carries the fields already stripped of user content by [`normalize`]
/// (`facet` bucketed/truncated, `status`, `qty`) plus a coarse duration bucket.
/// Never includes `vault`, `path`, or raw `extra` (search query, skill names).
#[derive(Debug, Clone)]
pub struct ActivityProjection {
    pub name: &'static str,
    pub facet: Option<String>,
    pub status: Option<String>,
    pub qty: Option<i64>,
    pub dur_bucket: Option<&'static str>,
}

/// Map a local activity record to its PostHog projection, or `None` when the
/// kind is not on the out-bound allowlist (the safe default — nothing leaks).
pub fn telemetry_projection(raw: &UsageRecord) -> Option<ActivityProjection> {
    let normalized = normalize(raw).ok()?;
    let name = match normalized.kind.as_str() {
        "paper.open" => "paper_opened",
        "note.open" => "note_opened",
        "paper.session" => "paper_session",
        "asset.download" => "asset_downloaded",
        "paper.import" => "paper_imported",
        "search.query" => "search_performed",
        "agent.run" => "agent_run",
        "skill.install" => "skill_installed",
        "paper.tag" => "paper_tagged",
        "paper.read" => "paper_read_set",
        "vault.open" => "vault_opened",
        "onboarding.complete" => "onboarding_completed",
        _ => return None,
    };
    let dur_bucket = (normalized.kind == "paper.session")
        .then(|| normalized.dur_ms.map(bucket_duration))
        .flatten();
    Some(ActivityProjection {
        name,
        facet: normalized.facet,
        status: normalized.status,
        qty: normalized.qty,
        dur_bucket,
    })
}

fn bucket_duration(ms: i64) -> &'static str {
    match ms {
        _ if ms < 10_000 => "<10s",
        _ if ms < 60_000 => "10-60s",
        _ if ms < 300_000 => "1-5m",
        _ if ms < 1_800_000 => "5-30m",
        _ => "30m+",
    }
}

fn upsert_vault(tx: &rusqlite::Transaction<'_>, vault: &str, ts: &str) -> Result<(), AppError> {
    tx.execute(
        "INSERT INTO usage_vaults (path, created_at, last_seen)
         VALUES (?1, ?2, ?2)
         ON CONFLICT(path) DO UPDATE SET last_seen = excluded.last_seen",
        params![vault, ts],
    )
    .map_err(|e| AppError::message(format!("upsert usage_vaults: {e}")))?;
    Ok(())
}

fn upsert_daily(tx: &rusqlite::Transaction<'_>, event: &Normalized) -> Result<(), AppError> {
    let day = event.ts.get(..10).unwrap_or("1970-01-01");
    let vault = event.vault.as_deref().unwrap_or("");
    let paper = event
        .paper_path
        .as_deref()
        .or(event.path.as_deref())
        .unwrap_or("");
    let facet = event.facet.as_deref().unwrap_or("");
    let dur = event.dur_ms.unwrap_or(0);
    let qty = event.qty.unwrap_or(0);
    tx.execute(
        "INSERT INTO usage_daily (day, vault, kind, paper_path, facet, count, dur_ms, qty)
         VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7)
         ON CONFLICT(day, vault, kind, paper_path, facet) DO UPDATE SET
           count = count + 1,
           dur_ms = dur_ms + excluded.dur_ms,
           qty = qty + excluded.qty",
        params![day, vault, event.kind, paper, facet, dur, qty],
    )
    .map_err(|e| AppError::message(format!("upsert usage_daily: {e}")))?;
    Ok(())
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

fn kind_ok(kind: &str) -> bool {
    kind.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_' || c == '-')
}

fn optional_trimmed(value: &Option<String>, max: usize) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(max).collect())
}

fn normalize_rel(path: &str) -> String {
    path.trim().replace('\\', "/").trim_matches('/').to_string()
}

fn now_rfc3339() -> String {
    crate::core::time::now_rfc3339_millis()
}

pub fn since_rfc3339_days(days: u32) -> String {
    let days = i64::from(days.max(1));
    (chrono::Utc::now() - chrono::Duration::days(days))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(feature = "desktop")]
pub fn rename_path_best_effort(vault: &str, from: &str, to: &str) {
    match rename_path(&crate::features::usage::usage_db_path(), vault, from, to) {
        Ok(_) => {}
        Err(e) => {
            log::warn!(target: "agentero::usage", "rename usage paths {from} → {to}: {e}");
        }
    }
}

#[cfg(feature = "desktop")]
pub fn record_default(events: &[UsageRecord]) -> Result<usize, AppError> {
    record_events(&crate::features::usage::usage_db_path(), events)
}

#[cfg(feature = "desktop")]
pub fn list_default(filter: &ListFilter) -> Result<Vec<UsageEvent>, AppError> {
    list_events(&crate::features::usage::usage_db_path(), filter)
}

#[cfg(feature = "desktop")]
pub fn summarize_default(
    vault: Option<&str>,
    since: Option<&str>,
) -> Result<Vec<UsageKindCount>, AppError> {
    summarize(&crate::features::usage::usage_db_path(), vault, since)
}

#[cfg(feature = "desktop")]
pub fn clear_default(vault: Option<&str>) -> Result<u64, AppError> {
    let path = crate::features::usage::usage_db_path();
    match vault.map(str::trim).filter(|s| !s.is_empty()) {
        Some(v) => clear_vault(&path, v),
        None => clear_all(&path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_db() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agentero-usage-events-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir.join("usage.sqlite")
    }

    fn rec(kind: &str, path: &str) -> UsageRecord {
        UsageRecord {
            ts: Some("2026-08-14T10:00:00.000Z".into()),
            vault: Some("/vaults/demo".into()),
            kind: kind.into(),
            path: Some(path.into()),
            mode: Some("pdf".into()),
            dur_ms: Some(1200),
            extra: Some(serde_json::json!({ "source": "arxiv" })),
        }
    }

    #[test]
    fn records_lists_and_summarizes() {
        let db = temp_db();
        let n = record_events(
            &db,
            &[rec("paper.open", "papers/a"), rec("paper.open", "papers/b")],
        )
        .unwrap();
        assert_eq!(n, 2);
        let rows = list_events(
            &db,
            &ListFilter {
                vault: Some("/vaults/demo".into()),
                limit: 10,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].kind, "paper.open");
        assert_eq!(rows[0].paper_path.as_deref(), Some("papers/b"));
        assert_eq!(rows[0].facet.as_deref(), Some("pdf"));
        let summary = summarize(&db, Some("/vaults/demo"), None).unwrap();
        assert_eq!(summary[0].kind, "paper.open");
        assert_eq!(summary[0].count, 2);
        let _ = fs::remove_dir_all(db.parent().unwrap());
    }

    #[test]
    fn derives_paper_path_and_import_facet() {
        let db = temp_db();
        record_events(
            &db,
            &[UsageRecord {
                ts: Some("2026-08-14T10:00:00.000Z".into()),
                vault: Some("/vaults/demo".into()),
                kind: "paper.import".into(),
                path: Some("papers/1706.03762/1706.03762.pdf".into()),
                mode: None,
                dur_ms: None,
                extra: Some(serde_json::json!({ "source": "arxiv" })),
            }],
        )
        .unwrap();
        let rows = list_events(
            &db,
            &ListFilter {
                path_prefix: Some("papers/1706.03762".into()),
                limit: 5,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(rows[0].paper_path.as_deref(), Some("papers/1706.03762"));
        assert_eq!(rows[0].facet.as_deref(), Some("arxiv"));
        let _ = fs::remove_dir_all(db.parent().unwrap());
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
    fn records_app_lifecycle() {
        let db = temp_db();
        record_events(
            &db,
            &[UsageRecord {
                ts: Some("2026-08-14T10:00:00.000Z".into()),
                vault: None,
                kind: "app.started".into(),
                path: None,
                mode: None,
                dur_ms: None,
                extra: Some(serde_json::json!({
                    "app_version": "0.6.0",
                    "os_name": "Mac OS",
                    "session_id": "s1",
                })),
            }],
        )
        .unwrap();
        let rows = list_events(
            &db,
            &ListFilter {
                kind: Some("app.started".into()),
                limit: 5,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].facet.as_deref(), Some("0.6.0"));
        assert!(rows[0].path.is_none());
        let _ = fs::remove_dir_all(db.parent().unwrap());
    }

    #[test]
    fn rejects_bad_kind() {
        let db = temp_db();
        let err = record_events(
            &db,
            &[UsageRecord {
                kind: "DROP TABLE".into(),
                ..rec("paper.open", "papers/a")
            }],
        )
        .unwrap_err();
        assert!(err.to_string().contains("invalid usage kind"));
        let _ = fs::remove_dir_all(db.parent().unwrap());
    }

    fn proj_rec(kind: &str, extra: serde_json::Value) -> UsageRecord {
        UsageRecord {
            ts: None,
            vault: Some("/vaults/demo".into()),
            kind: kind.into(),
            path: Some("papers/secret-title".into()),
            mode: None,
            dur_ms: None,
            extra: Some(extra),
        }
    }

    #[test]
    fn projection_drops_search_query_text() {
        let p = telemetry_projection(&proj_rec(
            "search.query",
            serde_json::json!({ "q": "secret query", "hits": 3 }),
        ))
        .expect("search.query projects");
        assert_eq!(p.name, "search_performed");
        assert_eq!(p.qty, Some(3));
        assert_eq!(p.facet, None);
    }

    #[test]
    fn projection_drops_skill_names() {
        let p = telemetry_projection(&proj_rec(
            "skill.install",
            serde_json::json!({ "sourceKind": "github", "installed": ["pptx", "frontend"] }),
        ))
        .expect("skill.install projects");
        assert_eq!(p.name, "skill_installed");
        assert_eq!(p.facet.as_deref(), Some("github"));
        assert_eq!(p.qty, Some(2));
    }

    #[test]
    fn projection_maps_and_filters_kinds() {
        let open = telemetry_projection(&UsageRecord {
            mode: Some("pdf".into()),
            ..proj_rec("paper.open", serde_json::Value::Null)
        })
        .expect("paper.open projects");
        assert_eq!(open.name, "paper_opened");
        assert_eq!(open.facet.as_deref(), Some("pdf"));

        // Not on the out-bound allowlist.
        assert!(telemetry_projection(&proj_rec("paper.focus", serde_json::Value::Null)).is_none());
        assert!(
            telemetry_projection(&proj_rec("paper.edit-meta", serde_json::Value::Null)).is_none()
        );
    }

    #[test]
    fn projection_buckets_session_duration() {
        let p = telemetry_projection(&UsageRecord {
            dur_ms: Some(45_000),
            ..proj_rec("paper.session", serde_json::Value::Null)
        })
        .expect("paper.session projects");
        assert_eq!(p.name, "paper_session");
        assert_eq!(p.dur_bucket, Some("10-60s"));
    }
}
