//! Append-only event writes: normalization, facet/qty derivation, daily rollup.

use crate::core::error::AppError;
use rusqlite::params;
use serde::Deserialize;
use std::path::Path;

use super::schema::{ensure_usage_at, paper_path_of};

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

pub(super) struct Normalized {
    pub(super) ts: String,
    pub(super) vault: Option<String>,
    pub(super) kind: String,
    pub(super) path: Option<String>,
    pub(super) paper_path: Option<String>,
    pub(super) mode: Option<String>,
    pub(super) facet: Option<String>,
    pub(super) status: Option<String>,
    pub(super) dur_ms: Option<i64>,
    pub(super) qty: Option<i64>,
    pub(super) extra: Option<String>,
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

pub(super) fn normalize(raw: &UsageRecord) -> Result<Normalized, AppError> {
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

pub(super) fn normalize_rel(path: &str) -> String {
    path.trim().replace('\\', "/").trim_matches('/').to_string()
}

fn now_rfc3339() -> String {
    crate::core::time::now_rfc3339_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::usage::{list_events, rec, summarize, temp_db, ListFilter};
    use std::fs;

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
}
