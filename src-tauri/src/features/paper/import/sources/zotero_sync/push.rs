//! Offline write-back: NOTES.md → Agentero-marked Zotero child note.
//!
//! Safety contract:
//! - Requires Zotero to be closed (write-lock probe via `BEGIN IMMEDIATE`).
//! - Mandatory timestamped backup of `zotero.sqlite` (+wal/shm) before any
//!   write; only the newest few backups are kept.
//! - Only creates/replaces Agentero-marked child notes (marker carries the
//!   paper id); user-written notes are never touched.
//! - One transaction for the whole pass; any failure rolls everything back.
//!
//! Known boundary (verified against a real Zotero 7 library): `items` /
//! `itemNotes` have no triggers feeding `syncQueue`, so pushed notes show up
//! in local Zotero but are not auto-queued for Zotero cloud sync until the
//! user edits them inside Zotero. Documented in identifier-lookup.md §17.

use crate::core::error::AppError;
use crate::features::zotero::codec;
use rusqlite::{params, Connection};
use std::fs;
use std::path::{Path, PathBuf};

/// Keep at most this many Agentero backups of zotero.sqlite.
const MAX_BACKUPS: usize = 5;

/// One paper whose NOTES.md should be pushed (selected from the pre-pull
/// catalog snapshot; pull advances watermarks during the same run).
#[derive(Debug, Clone)]
pub struct PushCandidate {
    pub zotero_item_id: i64,
    /// Agentero paper id embedded in the sync marker.
    pub paper_id: String,
    /// Vault-relative paper path (for NOTES.md + error reporting).
    pub path: String,
}

#[derive(Debug, Default)]
pub struct PushReport {
    pub pushed: usize,
    pub backup_path: Option<String>,
}

/// Push vault notes into Zotero. See module docs for the safety contract.
pub fn push_notes(
    vault: &Path,
    zotero_dir: &Path,
    candidates: &[PushCandidate],
    progress: impl Fn(usize, usize),
) -> Result<PushReport, AppError> {
    if candidates.is_empty() {
        progress(0, 0);
        return Ok(PushReport::default());
    }

    let db_path = zotero_dir.join("zotero.sqlite");
    if !db_path.is_file() {
        return Err(AppError::message(
            "zotero.sqlite not found in the selected folder",
        ));
    }

    // Write-lock probe: fails with SQLITE_BUSY while Zotero is running.
    let conn = Connection::open(&db_path)
        .map_err(|e| AppError::message(format!("open zotero.sqlite for writing: {e}")))?;
    conn.execute_batch("BEGIN IMMEDIATE; ROLLBACK;")
        .map_err(|e| {
            AppError::message(format!(
                "zotero.sqlite is locked — close Zotero and retry: {e}"
            ))
        })?;

    // Mandatory backup before touching anything.
    let backup = backup_zotero_db(zotero_dir)?;

    let total = candidates.len();
    let tx = conn.unchecked_transaction()?;
    let mut failures: Vec<String> = Vec::new();
    let mut pushed = 0usize;
    for (idx, cand) in candidates.iter().enumerate() {
        progress(idx, total);
        let notes_md =
            fs::read_to_string(vault.join(&cand.path).join("NOTES.md")).unwrap_or_default();
        if notes_md.trim().is_empty() {
            continue;
        }
        // Clean + drop blocks that already exist as the parent's own Zotero
        // notes (pull copied them into NOTES.md; mirroring them back would
        // show the same text twice).
        let existing = match existing_note_texts(&tx, cand.zotero_item_id) {
            Ok(v) => v,
            Err(e) => {
                failures.push(format!("{}: {e}", cand.path));
                continue;
            }
        };
        let cleaned = codec::clean_note_markdown_dedup(&notes_md, &existing);
        if cleaned.trim().is_empty() {
            // Truly nothing to mirror — leave Zotero untouched.
            continue;
        }
        // Shell-only notes (title + abstract, no reading notes yet) are not
        // worth mirroring. Only when the shell shape is actually detected is
        // it safe to reclaim a stale marked note.
        let beyond_shell = codec::strip_shell(&cleaned);
        if beyond_shell != cleaned && beyond_shell.trim().is_empty() {
            if let Err(e) = trash_marked_note(&tx, cand.zotero_item_id, &cand.paper_id) {
                failures.push(format!("{}: {e}", cand.path));
            }
            continue;
        }
        let html = codec::wrap_sync_html(&cand.paper_id, &codec::markdown_to_html(&cleaned));
        match upsert_marked_note(&tx, cand.zotero_item_id, &cand.paper_id, &html) {
            Ok(()) => pushed += 1,
            Err(e) => failures.push(format!("{}: {e}", cand.path)),
        }
    }

    if !failures.is_empty() {
        let _ = tx.rollback();
        progress(total, total);
        return Err(AppError::message(format!(
            "push rolled back (backup at {}): {}",
            backup.display(),
            failures.join("; ")
        )));
    }
    tx.commit()
        .map_err(|e| AppError::message(format!("commit zotero writes: {e}")))?;
    progress(total, total);
    Ok(PushReport {
        pushed,
        backup_path: Some(backup.to_string_lossy().to_string()),
    })
}

/// Create or replace this parent item's Agentero-marked child note.
///
/// Matching is deliberately loose (`agentero:sync paper=<id>` signature,
/// escaped or not): Zotero may have escaped an earlier, malformed push, and
/// the note must still be reclaimed instead of duplicated. When several
/// matches exist (damage from earlier versions), the first is updated and the
/// rest are moved to Zotero's trash. Identical content is left untouched.
fn upsert_marked_note(
    tx: &Connection,
    parent_item_id: i64,
    paper_id: &str,
    html: &str,
) -> Result<(), AppError> {
    // The note row must live in the parent's library.
    let library_id: i64 = tx
        .query_row(
            "SELECT libraryID FROM items WHERE itemID = ?1",
            params![parent_item_id],
            |r| r.get(0),
        )
        .map_err(|_| AppError::message(format!("Zotero parent item {parent_item_id} not found")))?;

    // Every Agentero note for exactly this paper under this parent — raw or
    // escaped marker forms alike. `_`/`%` in paper ids must not act as LIKE
    // wildcards (ids like `10_1016_j_neucom…` exist).
    let marker_like = format!(
        "%{}%",
        like_escape(&format!("agentero:sync paper={paper_id}"))
    );
    let mut stmt = tx
        .prepare(
            "SELECT n.itemID, n.note FROM itemNotes n
             WHERE n.parentItemID = ?1
               AND n.itemID NOT IN (SELECT itemID FROM deletedItems)
               AND n.note LIKE ?2 ESCAPE '\\'
             ORDER BY n.itemID",
        )
        .map_err(|e| AppError::message(format!("prepare note lookup: {e}")))?;
    let mut existing: Vec<(i64, String)> = stmt
        .query_map(params![parent_item_id, marker_like], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .map_err(|e| AppError::message(format!("lookup existing notes: {e}")))?
        .collect::<Result<_, _>>()
        .map_err(|e| AppError::message(format!("read existing notes: {e}")))?;
    drop(stmt);

    match existing.len() {
        0 => {
            let note_type_id: i64 = tx
                .query_row(
                    "SELECT itemTypeID FROM itemTypes WHERE typeName = 'note'",
                    [],
                    |r| r.get(0),
                )
                .map_err(|e| AppError::message(format!("note itemType missing: {e}")))?;
            let key = zotero_key();
            tx.execute(
                "INSERT INTO items (itemTypeID, libraryID, key, dateAdded, dateModified, clientDateModified)
                 VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
                params![note_type_id, library_id, key],
            )
            .map_err(|e| AppError::message(format!("insert note item: {e}")))?;
            let note_id: i64 = tx
                .query_row("SELECT last_insert_rowid()", [], |r| r.get(0))
                .map_err(|e| AppError::message(format!("note item id: {e}")))?;
            tx.execute(
                "INSERT INTO itemNotes (itemID, parentItemID, note) VALUES (?1, ?2, ?3)",
                params![note_id, parent_item_id, html],
            )
            .map_err(|e| AppError::message(format!("insert itemNotes row: {e}")))?;
        }
        _ => {
            let (keep_id, keep_note) = existing.remove(0);
            // Content unchanged → no write (avoids pointless churn each sync).
            if keep_note != html {
                tx.execute(
                    "UPDATE itemNotes SET note = ?2 WHERE itemID = ?1",
                    params![keep_id, html],
                )
                .map_err(|e| AppError::message(format!("update note {keep_id}: {e}")))?;
                tx.execute(
                    "UPDATE items SET dateModified = CURRENT_TIMESTAMP,
                                       clientDateModified = CURRENT_TIMESTAMP
                     WHERE itemID = ?1",
                    params![keep_id],
                )
                .map_err(|e| AppError::message(format!("touch note item {keep_id}: {e}")))?;
            }
            // Earlier versions could create duplicates; reclaim them into the
            // Zotero trash (recoverable), never hard-delete.
            for (dup_id, _) in &existing {
                tx.execute(
                    "INSERT OR IGNORE INTO deletedItems (itemID) VALUES (?1)",
                    params![dup_id],
                )
                .map_err(|e| AppError::message(format!("trash duplicate note {dup_id}: {e}")))?;
            }
        }
    }

    // Touch the parent so Zotero's item list shows an updated timestamp.
    tx.execute(
        "UPDATE items SET dateModified = CURRENT_TIMESTAMP,
                           clientDateModified = CURRENT_TIMESTAMP
         WHERE itemID = ?1",
        params![parent_item_id],
    )
    .map_err(|e| AppError::message(format!("touch parent item {parent_item_id}: {e}")))?;
    Ok(())
}

/// Escape LIKE wildcards so paper ids match literally.
fn like_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Normalized plain-text of this parent's non-Agentero child notes. Blocks
/// matching one of these are skipped by the push (they already show as their
/// own note under the item).
fn existing_note_texts(tx: &Connection, parent_item_id: i64) -> Result<Vec<String>, AppError> {
    let mut stmt = tx
        .prepare(
            "SELECT n.note FROM itemNotes n
             WHERE n.parentItemID = ?1
               AND n.itemID NOT IN (SELECT itemID FROM deletedItems)
               AND n.note NOT LIKE '%agentero:sync paper=%'",
        )
        .map_err(|e| AppError::message(format!("prepare sibling-note lookup: {e}")))?;
    let notes: Vec<String> = stmt
        .query_map(params![parent_item_id], |r| r.get::<_, String>(0))
        .map_err(|e| AppError::message(format!("lookup sibling notes: {e}")))?
        .collect::<Result<_, _>>()
        .map_err(|e| AppError::message(format!("read sibling notes: {e}")))?;
    Ok(notes
        .iter()
        .map(|html| codec::normalize_for_compare(&codec::html_to_markdown(html)))
        .collect())
}

/// Move this parent's Agentero-marked note (if any) into Zotero's trash —
/// used when the vault no longer has anything worth mirroring. Recoverable.
fn trash_marked_note(tx: &Connection, parent_item_id: i64, paper_id: &str) -> Result<(), AppError> {
    let marker_like = format!(
        "%{}%",
        like_escape(&format!("agentero:sync paper={paper_id}"))
    );
    tx.execute(
        "INSERT OR IGNORE INTO deletedItems (itemID)
         SELECT n.itemID FROM itemNotes n
         WHERE n.parentItemID = ?1
           AND n.itemID NOT IN (SELECT itemID FROM deletedItems)
           AND n.note LIKE ?2 ESCAPE '\\'",
        params![parent_item_id, marker_like],
    )
    .map_err(|e| AppError::message(format!("trash stale marked note: {e}")))?;
    Ok(())
}

/// Copy `zotero.sqlite` (+wal/shm) into `<zotero_dir>/agentero-backups/`,
/// keeping only the newest [`MAX_BACKUPS`] backups.
fn backup_zotero_db(zotero_dir: &Path) -> Result<PathBuf, AppError> {
    let backups_dir = zotero_dir.join("agentero-backups");
    fs::create_dir_all(&backups_dir)?;
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let dest = backups_dir.join(format!("zotero-{stamp}.sqlite"));
    fs::copy(zotero_dir.join("zotero.sqlite"), &dest)
        .map_err(|e| AppError::message(format!("backup zotero.sqlite: {e}")))?;
    for ext in ["-wal", "-shm"] {
        let src = zotero_dir.join(format!("zotero.sqlite{ext}"));
        if src.is_file() {
            let _ = fs::copy(
                &src,
                backups_dir.join(format!("zotero-{stamp}.sqlite{ext}")),
            );
        }
    }
    prune_old_backups(&backups_dir);
    Ok(dest)
}

fn prune_old_backups(backups_dir: &Path) {
    let Ok(entries) = fs::read_dir(backups_dir) else {
        return;
    };
    let mut bases: Vec<String> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.strip_prefix("zotero-")
                .and_then(|rest| rest.split(".sqlite").next())
                .map(str::to_string)
        })
        .collect();
    bases.sort();
    bases.dedup();
    if bases.len() <= MAX_BACKUPS {
        return;
    }
    for base in bases.iter().take(bases.len() - MAX_BACKUPS) {
        for suffix in ["", ".sqlite-wal", ".sqlite-shm"] {
            let p = backups_dir.join(format!("zotero-{base}.sqlite{suffix}"));
            if p.is_file() {
                let _ = fs::remove_file(&p);
            }
        }
        // The base file itself (pattern above covers it via suffix "").
        let main = backups_dir.join(format!("zotero-{base}.sqlite"));
        if main.is_file() {
            let _ = fs::remove_file(&main);
        }
    }
}

/// Fresh 8-char Zotero-style item key (base32 without 0/1/l/o).
fn zotero_key() -> String {
    const ALPHABET: &[u8; 32] = b"23456789abcdefghijkmnpqrstuvwxyz";
    uuid::Uuid::new_v4()
        .as_bytes()
        .iter()
        .take(8)
        .map(|b| ALPHABET[(b % 32) as usize] as char)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zotero_key_shape() {
        let key = zotero_key();
        assert_eq!(key.len(), 8);
        assert!(key
            .chars()
            .all(|c| "23456789abcdefghijkmnpqrstuvwxyz".contains(c)));
    }

    #[tokio::test]
    async fn push_creates_then_replaces_marked_note() {
        let base = std::env::temp_dir().join(format!(
            "motif-zpush-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        let zdir = base.join("zotero");
        fs::create_dir_all(&zdir).unwrap();
        // Minimal Zotero-shaped schema.
        {
            let conn = Connection::open(zdir.join("zotero.sqlite")).unwrap();
            conn.execute_batch(
                "CREATE TABLE itemTypes (itemTypeID INTEGER PRIMARY KEY, typeName TEXT);
                 CREATE TABLE items (itemID INTEGER PRIMARY KEY, itemTypeID INT NOT NULL,
                     libraryID INT NOT NULL, key TEXT NOT NULL,
                     dateAdded TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                     dateModified TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                     clientDateModified TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);
                 CREATE TABLE itemNotes (itemID INTEGER, parentItemID INT, note TEXT, title TEXT);
                 CREATE TABLE deletedItems (itemID INTEGER);
                 INSERT INTO itemTypes VALUES (14,'journalArticle'),(28,'note');
                 INSERT INTO items (itemID, itemTypeID, libraryID, key) VALUES (4, 14, 1, 'abcd2345');",
            )
            .unwrap();
        }
        let vault = base.join("vault");
        fs::create_dir_all(vault.join("papers/x")).unwrap();
        fs::write(vault.join("papers/x/NOTES.md"), "# My note\n\nhello world").unwrap();

        let cand = PushCandidate {
            zotero_item_id: 4,
            paper_id: "x".into(),
            path: "papers/x".into(),
        };

        // First push creates the marked child note.
        let r1 = push_notes(&vault, &zdir, std::slice::from_ref(&cand), |_, _| {}).unwrap();
        assert_eq!(r1.pushed, 1);
        assert!(r1.backup_path.is_some());
        let conn = Connection::open(zdir.join("zotero.sqlite")).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM itemNotes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
        let note: String = conn
            .query_row("SELECT note FROM itemNotes LIMIT 1", [], |r| r.get(0))
            .unwrap();
        assert!(note.contains("agentero:sync paper=x"));
        assert!(note.contains("hello world"));
        // Backup exists on disk.
        assert!(zdir.join("agentero-backups").is_dir());
        drop(conn);

        // Second push replaces in place (still exactly one note).
        fs::write(vault.join("papers/x/NOTES.md"), "# My note\n\nupdated body").unwrap();
        push_notes(&vault, &zdir, std::slice::from_ref(&cand), |_, _| {}).unwrap();
        let conn = Connection::open(zdir.join("zotero.sqlite")).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM itemNotes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
        let note: String = conn
            .query_row("SELECT note FROM itemNotes LIMIT 1", [], |r| r.get(0))
            .unwrap();
        assert!(note.contains("updated body"));

        // A user note without markers is never touched.
        conn.execute(
            "INSERT INTO items (itemID, itemTypeID, libraryID, key) VALUES (9, 28, 1, 'user1234')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO itemNotes VALUES (9, 4, 'user written', NULL)",
            [],
        )
        .unwrap();
        drop(conn);
        push_notes(&vault, &zdir, std::slice::from_ref(&cand), |_, _| {}).unwrap();
        let conn = Connection::open(zdir.join("zotero.sqlite")).unwrap();
        let user_note: String = conn
            .query_row("SELECT note FROM itemNotes WHERE itemID = 9", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(user_note, "user written");
        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM itemNotes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(total, 2, "marked note replaced, user note untouched");

        let _ = fs::remove_dir_all(&base);
    }

    /// Minimal Zotero-shaped schema for the push tests.
    fn setup_db(zdir: &std::path::Path) {
        let conn = Connection::open(zdir.join("zotero.sqlite")).unwrap();
        conn.execute_batch(
            "CREATE TABLE itemTypes (itemTypeID INTEGER PRIMARY KEY, typeName TEXT);
             CREATE TABLE items (itemID INTEGER PRIMARY KEY, itemTypeID INT NOT NULL,
                 libraryID INT NOT NULL, key TEXT NOT NULL,
                 dateAdded TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                 dateModified TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                 clientDateModified TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);
             CREATE TABLE itemNotes (itemID INTEGER, parentItemID INT, note TEXT, title TEXT);
             CREATE TABLE deletedItems (itemID INTEGER);
             INSERT INTO itemTypes VALUES (14,'journalArticle'),(28,'note');
             INSERT INTO items (itemID, itemTypeID, libraryID, key) VALUES (4, 14, 1, 'abcd2345')",
        )
        .unwrap();
    }

    #[tokio::test]
    async fn push_skips_blocks_already_in_zotero_notes() {
        let base = std::env::temp_dir().join(format!(
            "motif-zdedup-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        let zdir = base.join("zotero");
        fs::create_dir_all(&zdir).unwrap();
        setup_db(&zdir);
        // The parent already has its own (unmarked) note with this text.
        {
            let conn = Connection::open(zdir.join("zotero.sqlite")).unwrap();
            conn.execute(
                "INSERT INTO items (itemID, itemTypeID, libraryID, key) VALUES (9, 28, 1, 'user1234')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO itemNotes VALUES (9, 4, '<div class=\"zotero-note znv1\">Comment: already in zotero</div>', NULL)",
                [],
            )
            .unwrap();
        }
        let vault = base.join("vault");
        fs::create_dir_all(vault.join("papers/x")).unwrap();
        fs::write(
            vault.join("papers/x/NOTES.md"),
            "# T\n\n> a\n\n---\n\nComment: already in zotero\n\n---\n\nfresh thought",
        )
        .unwrap();
        let cand = PushCandidate {
            zotero_item_id: 4,
            paper_id: "x".into(),
            path: "papers/x".into(),
        };
        push_notes(&vault, &zdir, std::slice::from_ref(&cand), |_, _| {}).unwrap();
        let conn = Connection::open(zdir.join("zotero.sqlite")).unwrap();
        let note: String = conn
            .query_row(
                "SELECT note FROM itemNotes WHERE itemID != 9 LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        // The duplicated block is not mirrored; the fresh one is.
        assert!(!note.contains("already in zotero"), "got: {note}");
        assert!(note.contains("fresh thought"), "got: {note}");
        let _ = fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn push_trashes_stale_marked_note_when_nothing_to_mirror() {
        let base = std::env::temp_dir().join(format!(
            "motif-zstale-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        let zdir = base.join("zotero");
        fs::create_dir_all(&zdir).unwrap();
        setup_db(&zdir);
        // An existing marked note whose vault content is gone (shell-only).
        {
            let conn = Connection::open(zdir.join("zotero.sqlite")).unwrap();
            conn.execute(
                "INSERT INTO items (itemID, itemTypeID, libraryID, key) VALUES (7, 28, 1, 'mark1234')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO itemNotes VALUES (7, 4, '<!-- agentero:sync paper=x -->stale<!-- /agentero:sync -->', NULL)",
                [],
            )
            .unwrap();
        }
        let vault = base.join("vault");
        fs::create_dir_all(vault.join("papers/x")).unwrap();
        fs::write(
            vault.join("papers/x/NOTES.md"),
            "# Only shell\n\n> abstract and nothing else",
        )
        .unwrap();
        let cand = PushCandidate {
            zotero_item_id: 4,
            paper_id: "x".into(),
            path: "papers/x".into(),
        };
        push_notes(&vault, &zdir, std::slice::from_ref(&cand), |_, _| {}).unwrap();
        let conn = Connection::open(zdir.join("zotero.sqlite")).unwrap();
        let trashed: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM deletedItems WHERE itemID = 7",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(trashed, 1, "stale marked note reclaimed to trash");
        let _ = fs::remove_dir_all(&base);
    }
}
