//! Bidirectional Zotero sync (mapping layer, both data models stay intact).
//!
//! - Pull (read-only, safe while Zotero runs): metadata fill, user-written
//!   child notes → NOTES.md, PDF annotations → NOTES.md.
//! - Push (offline write, Zotero must be closed): NOTES.md → marked child
//!   note in `zotero.sqlite`, with mandatory backup and transaction rollback.
//!
//! See `docs/backend/identifier-lookup.md` §17.

pub mod commands;
pub mod link;
pub mod pull;
pub mod push;

use crate::core::error::AppError;
use crate::features::catalog::papers;
use crate::features::zotero::db::{copy_zotero_sqlite, read_sync_items};
use chrono::{DateTime, Utc};
use pull::{PullOptions, PullReport, SyncConflict};
use push::PushCandidate;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroSyncArgs {
    pub vault_path: String,
    pub zotero_dir: String,
    #[serde(default = "default_true")]
    pub pull_metadata: bool,
    #[serde(default = "default_true")]
    pub pull_notes: bool,
    #[serde(default = "default_true")]
    pub pull_annotations: bool,
    #[serde(default = "default_true")]
    pub push_notes: bool,
    /// Ignore watermarks and re-push every linked paper's NOTES.md (used to
    /// converge libraries damaged by earlier versions).
    #[serde(default)]
    pub force_push: bool,
}

fn default_true() -> bool {
    true
}

/// Progress event streamed to the UI while a sync runs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgress {
    pub current: usize,
    pub total: usize,
    pub phase: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroSyncResult {
    pub linked: usize,
    pub unlinked: usize,
    pub metadata_filled: usize,
    pub notes_pulled: usize,
    pub annotations_pulled: usize,
    pub notes_pushed: usize,
    pub linkage_backfilled: usize,
    pub conflicts: Vec<SyncConflict>,
    pub errors: Vec<String>,
}

/// Run one sync pass: pull from Zotero, then push vault notes back.
pub fn sync_zotero(
    args: ZoteroSyncArgs,
    progress: impl Fn(usize, usize, &str),
) -> Result<ZoteroSyncResult, AppError> {
    let vault = crate::core::fs::resolve_vault(&args.vault_path)?;
    let vault = vault.as_path();
    let zotero_dir = Path::new(args.zotero_dir.trim());
    if !zotero_dir.is_dir() {
        return Err(AppError::message(
            "selected Zotero folder is not a directory",
        ));
    }

    progress(0, 0, "read");
    // Push candidates must be chosen from the PRE-pull watermarks: pull
    // advances them during this same run, which would hide every note change.
    let mut push_candidates: Vec<PushCandidate> = Vec::new();
    if args.push_notes {
        for row in papers::list_all(vault)? {
            let Some(zid) = row.zotero_item_id else {
                continue;
            };
            let notes = vault.join(&row.path).join("NOTES.md");
            if !notes.is_file() {
                continue;
            }
            let never_synced = row.zotero_last_synced.is_none();
            if args.force_push
                || never_synced
                || file_newer_than(&notes, row.zotero_last_synced.as_deref())
            {
                push_candidates.push(PushCandidate {
                    zotero_item_id: zid,
                    paper_id: row.id.clone(),
                    path: row.path.clone(),
                });
            }
        }
    }

    let (conn, tmp_dir) = copy_zotero_sqlite(zotero_dir)?;
    let result = (|| -> Result<ZoteroSyncResult, AppError> {
        let items = read_sync_items(&conn)?;
        progress(0, items.len(), "pull");

        let pull_report: PullReport = pull::pull(
            vault,
            &items,
            &PullOptions {
                metadata: args.pull_metadata,
                notes: args.pull_notes,
                annotations: args.pull_annotations,
            },
            |current, total| progress(current, total, "pull"),
        )?;

        let mut out = ZoteroSyncResult {
            linked: pull_report.linked,
            unlinked: pull_report.unlinked,
            metadata_filled: pull_report.metadata_filled,
            notes_pulled: pull_report.notes_added,
            annotations_pulled: pull_report.annotations_added,
            linkage_backfilled: pull_report.linkage_backfilled,
            conflicts: pull_report.conflicts,
            ..Default::default()
        };

        if args.push_notes {
            progress(0, 0, "push");
            match push::push_notes(vault, zotero_dir, &push_candidates, |current, total| {
                progress(current, total, "push")
            }) {
                Ok(report) => {
                    out.notes_pushed = report.pushed;
                }
                Err(e) => out.errors.push(e.to_string()),
            }
        }
        Ok(out)
    })();
    let _ = std::fs::remove_dir_all(&tmp_dir);
    result
}

/// True when the file's mtime is newer than the ISO watermark.
pub(crate) fn file_newer_than(path: &Path, watermark: Option<&str>) -> bool {
    let Some(wm) = watermark.and_then(parse_dt) else {
        return false;
    };
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    let Ok(mtime) = meta.modified() else {
        return false;
    };
    let mtime_utc: DateTime<Utc> = mtime.into();
    mtime_utc > wm
}

/// Zotero stores `2026-01-02 03:04:05`; the vault stores RFC 3339. Accept both.
pub(crate) fn parse_dt(s: &str) -> Option<DateTime<Utc>> {
    let s = s.trim();
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Utc));
    }
    if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S") {
        return Some(naive.and_utc());
    }
    if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S") {
        return Some(naive.and_utc());
    }
    None
}
