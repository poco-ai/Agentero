//! papers table CRUD. Catalog is the authority for paper metadata.

use super::schema::with_catalog;
use crate::core::error::AppError;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

/// Apple system color–inspired tag color ids (frontend palette).
const TAG_COLOR_IDS: &[&str] = &[
    "red", "orange", "yellow", "green", "teal", "blue", "indigo", "purple",
];

/// Canonical `papers` column list shared by every SELECT / INSERT in this
/// module. Order MUST match `map_row`'s positional `row.get(i)` indexes.
const PAPER_COLUMNS: &str = "\
    path, id, type, title, authors_json, year, abstract, tags_json, \
    arxiv_id, doi, pdf_url, html_url, source_url, \
    body_source, body_quality, bibtex_key, citation_count, status, summary, \
    added_at, updated_at, \
    creators_json, date, isbn, issn, pmid, publication, volume, issue, pages, \
    publisher, place, series, language, zotero_item_type, meta_source, extra, \
    is_read, zotero_item_id, zotero_last_synced";

/// Prefix for Connector provenance tags (hidden from user-facing tag UI).
pub const ZOTERO_INTERNAL_TAG_PREFIX: &str = "@zotero:";
/// Prefix for arXiv subject-class tags imported from Translator.
pub const ARXIV_INTERNAL_TAG_PREFIX: &str = "@arxiv:";

/// Zotero arXiv translator writes `"Archive - Sub-Field"` subject tags
/// (`cs.LG` → `Computer Science - Machine Learning`). These prefixes match
/// that display form so we can hide them without a full category table.
const ARXIV_CATEGORY_PREFIXES: &[&str] = &[
    "computer science - ",
    "economics - ",
    "electrical engineering and systems science - ",
    "mathematics - ",
    "nonlinear sciences - ",
    "physics - ",
    "quantitative finance - ",
    "statistics - ",
    "astrophysics - ",
    "condensed matter - ",
    "quantitative biology - ",
    "high energy physics - ",
];

/// One catalog tag: display name + optional color id.
/// JSON: bare string when uncolored; `{"name","color"}` when colored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaperTag {
    pub name: String,
    pub color: Option<String>,
}

impl PaperTag {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            color: None,
        }
    }
}

impl From<&str> for PaperTag {
    fn from(s: &str) -> Self {
        PaperTag::new(s)
    }
}

impl From<String> for PaperTag {
    fn from(s: String) -> Self {
        PaperTag::new(s)
    }
}

/// Internal provenance tags (`@zotero:`, `@arxiv:`) plus legacy unprefixed
/// arXiv subject labels. Omitted from Library / Paper Info / CLI unless `--all`.
pub fn is_internal_tag_name(name: &str) -> bool {
    let n = name.trim();
    if n.is_empty() {
        return false;
    }
    let lower = n.to_ascii_lowercase();
    lower.starts_with(ZOTERO_INTERNAL_TAG_PREFIX)
        || lower.starts_with(ARXIV_INTERNAL_TAG_PREFIX)
        || is_arxiv_category_label(n)
}

/// Translator-style arXiv subject tag, e.g. `Computer Science - Machine Learning`.
pub fn is_arxiv_category_label(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return false;
    }
    ARXIV_CATEGORY_PREFIXES
        .iter()
        .any(|prefix| lower.starts_with(prefix))
}

/// Store an arXiv subject tag as hidden provenance (`@arxiv:…`).
/// Already-internal names are left unchanged.
pub fn hide_arxiv_category_tag(name: &str) -> String {
    let n = name.trim();
    if n.is_empty() {
        return String::new();
    }
    let lower = n.to_ascii_lowercase();
    if lower.starts_with(ZOTERO_INTERNAL_TAG_PREFIX) || lower.starts_with(ARXIV_INTERNAL_TAG_PREFIX)
    {
        return n.to_string();
    }
    if is_arxiv_category_label(n) {
        format!("{ARXIV_INTERNAL_TAG_PREFIX}{n}")
    } else {
        n.to_string()
    }
}

impl Serialize for PaperTag {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self
            .color
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
        {
            Some(color) => {
                use serde::ser::SerializeMap;
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("name", &self.name)?;
                map.serialize_entry("color", color)?;
                map.end()
            }
            None => self.name.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for PaperTag {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let v = serde_json::Value::deserialize(deserializer)?;
        match v {
            serde_json::Value::String(s) => Ok(PaperTag::new(s)),
            serde_json::Value::Object(map) => {
                let name = map
                    .get("name")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let color = map
                    .get("color")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string());
                Ok(PaperTag { name, color })
            }
            _ => Ok(PaperTag::new("")),
        }
    }
}

fn normalize_color(color: Option<&str>) -> Option<String> {
    let c = color?.trim().to_ascii_lowercase();
    if c.is_empty() {
        return None;
    }
    TAG_COLOR_IDS
        .iter()
        .find(|id| **id == c.as_str())
        .map(|id| (*id).to_string())
}

/// API / frontend shape (snake_case, matches PaperMetadata).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaperRecord {
    /// Vault-relative paper folder path (primary key).
    /// Defaults empty so sidecar files without `path` still parse; readers
    /// overwrite it with the on-disk location.
    #[serde(default)]
    pub path: String,
    pub id: String,
    #[serde(rename = "type")]
    pub paper_type: String,
    pub title: String,
    pub authors: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creators: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "abstract")]
    pub abstract_text: Option<String>,
    #[serde(default)]
    pub tags: Vec<PaperTag>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arxiv_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isbn: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issn: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pmid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publication: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pages: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub place: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub series: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pdf_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_quality: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bibtex_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub citation_count: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zotero_item_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub status: String,
    /// Whether paper-reader workflow has completed for this paper.
    #[serde(default)]
    pub is_read: bool,
    /// Zotero itemID this paper is linked to (bidirectional sync).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zotero_item_id: Option<i64>,
    /// ISO 8601 watermark of the last Zotero sync touching this paper.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zotero_last_synced: Option<String>,
    pub added_at: String,
    pub updated_at: String,
}

/// Upsert paper row to catalog and project it into the paper's sidecar.
pub fn upsert_paper(vault_root: &Path, record: &PaperRecord) -> Result<PaperRecord, AppError> {
    with_catalog(vault_root, |conn| upsert_conn(conn, record))?;
    super::sidecar::write_sidecar(vault_root, record);
    Ok(record.clone())
}

pub fn get_by_path(vault_root: &Path, path: &str) -> Result<Option<PaperRecord>, AppError> {
    let path = path.replace('\\', "/").trim_matches('/').to_string();
    with_catalog(vault_root, |conn| get_conn(conn, &path))
}

/// First paper with the given logical `id` (ordered by path). For ambiguity, use [`list_by_id`].
pub fn get_by_id(vault_root: &Path, id: &str) -> Result<Option<PaperRecord>, AppError> {
    Ok(list_by_id(vault_root, id)?.into_iter().next())
}

/// All catalog rows with the given logical `id` (may be multiple paths).
pub fn list_by_id(vault_root: &Path, id: &str) -> Result<Vec<PaperRecord>, AppError> {
    with_catalog(vault_root, |conn| {
        let mut stmt = conn
            .prepare(&format!(
                r#"
            SELECT {PAPER_COLUMNS}
            FROM papers
            WHERE id = ?1
            ORDER BY path ASC
            "#,
            ))
            .map_err(AppError::from)?;

        let rows = stmt
            .query_map(params![id], map_row)
            .map_err(AppError::from)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from)?;
        Ok(rows)
    })
}

/// Find a paper by one of its canonical identifier columns.
/// `column` must be one of: `arxiv_id`, `doi`, `isbn`, `pmid`, `id`.
pub fn find_by_identifier(
    vault_root: &Path,
    column: &str,
    value: &str,
) -> Result<Option<PaperRecord>, AppError> {
    let allowed = ["arxiv_id", "doi", "isbn", "pmid", "id"];
    if !allowed.contains(&column) {
        return Err(AppError::message(format!(
            "invalid identifier column: {column}"
        )));
    }
    let sql = format!(
        r#"
        SELECT {PAPER_COLUMNS}
        FROM papers
        WHERE {column} = ?1
        ORDER BY path ASC
        LIMIT 1
        "#
    );
    with_catalog(vault_root, |conn| {
        let mut stmt = conn.prepare(&sql).map_err(AppError::from)?;
        let row = stmt
            .query_row(params![value], map_row)
            .optional()
            .map_err(AppError::from)?;
        Ok(row)
    })
}

/// List all papers for library table (newest first).
pub fn list_all(vault_root: &Path) -> Result<Vec<PaperRecord>, AppError> {
    with_catalog(vault_root, list_all_conn)
}

/// List papers whose `publication` column is NULL or empty.
/// Used by the batch venue backfill workflow.
pub fn list_missing_publication(vault_root: &Path) -> Result<Vec<PaperRecord>, AppError> {
    with_catalog(vault_root, |conn| {
        let mut stmt = conn
            .prepare(&format!(
                r#"
                SELECT {PAPER_COLUMNS}
                FROM papers
                WHERE publication IS NULL OR TRIM(publication) = ''
                ORDER BY updated_at DESC
                "#,
            ))
            .map_err(AppError::from)?;

        let rows = stmt
            .query_map([], map_row)
            .map_err(AppError::from)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from)?;
        Ok(rows)
    })
}

/// Read all papers from an already-open Catalog connection.
///
/// Doctor opens the database read-only so diagnosis never creates or migrates
/// Catalog state as a side effect.
pub fn list_all_conn(conn: &Connection) -> Result<Vec<PaperRecord>, AppError> {
    let mut stmt = conn
        .prepare(&format!(
            r#"
            SELECT {PAPER_COLUMNS}
            FROM papers
            ORDER BY updated_at DESC, title COLLATE NOCASE ASC
            "#,
        ))
        .map_err(AppError::from)?;

    let rows = stmt
        .query_map([], map_row)
        .map_err(AppError::from)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppError::from)?;
    Ok(rows)
}

/// One row in a duplicate group (lightweight, for diagnostics / repair).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateRow {
    pub path: String,
    pub id: String,
    pub title: String,
    pub updated_at: String,
    pub path_exists: bool,
}

/// What kind of duplicate was detected.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DuplicateKind {
    Id,
    Path,
}

/// A set of catalog rows sharing the same `id` or `path`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    pub kind: DuplicateKind,
    pub key: String,
    pub rows: Vec<DuplicateRow>,
}

/// Report of duplicate rows in the catalog.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateReport {
    pub duplicate_ids: Vec<DuplicateGroup>,
    pub duplicate_paths: Vec<DuplicateGroup>,
    pub total_duplicate_rows: usize,
}

/// Scan the catalog for rows with duplicate `id` or `path`.
/// `path` duplicates are reported as a sanity check even though the schema
/// declares it PRIMARY KEY; older or damaged databases may contain them.
pub fn find_duplicates(vault_root: &Path) -> Result<DuplicateReport, AppError> {
    with_catalog(vault_root, |conn| find_duplicates_conn(vault_root, conn))
}

pub fn find_duplicates_conn(
    vault_root: &Path,
    conn: &Connection,
) -> Result<DuplicateReport, AppError> {
    let mut report = DuplicateReport::default();

    let mut stmt = conn
        .prepare("SELECT path, id, title, updated_at FROM papers ORDER BY id, updated_at DESC")
        .map_err(AppError::from)?;
    let raw_rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(AppError::from)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppError::from)?;

    let mut by_id: std::collections::BTreeMap<String, Vec<DuplicateRow>> =
        std::collections::BTreeMap::new();
    let mut by_path: std::collections::BTreeMap<String, Vec<DuplicateRow>> =
        std::collections::BTreeMap::new();
    for (path, id, title, updated_at) in raw_rows {
        let row = DuplicateRow {
            path: path.clone(),
            id,
            title,
            updated_at,
            path_exists: vault_root.join(&path).is_dir(),
        };
        by_id.entry(row.id.clone()).or_default().push(row.clone());
        by_path.entry(path).or_default().push(row);
    }

    for (key, group_rows) in by_id {
        if group_rows.len() > 1 {
            report.total_duplicate_rows += group_rows.len() - 1;
            report.duplicate_ids.push(DuplicateGroup {
                kind: DuplicateKind::Id,
                key,
                rows: group_rows,
            });
        }
    }
    for (key, group_rows) in by_path {
        if group_rows.len() > 1 {
            report.total_duplicate_rows += group_rows.len() - 1;
            report.duplicate_paths.push(DuplicateGroup {
                kind: DuplicateKind::Path,
                key,
                rows: group_rows,
            });
        }
    }

    Ok(report)
}

/// List papers keeping one row per logical `id`.
///
/// Tie-breaking (deterministic, stable):
/// 1. Path whose folder exists on disk wins.
/// 2. Newer `updated_at` wins.
/// 3. Shorter path wins.
/// 4. Lexicographically smaller path wins.
///
/// This is a defensive view for the Library table: it hides duplicate catalog
/// rows caused by old bugs or manual folder copies without deleting anything.
pub fn list_all_unique_by_id(vault_root: &Path) -> Result<Vec<PaperRecord>, AppError> {
    let rows = with_catalog(vault_root, list_all_conn)?;
    Ok(dedupe_records_by_id(vault_root, rows))
}

fn dedupe_records_by_id(vault_root: &Path, rows: Vec<PaperRecord>) -> Vec<PaperRecord> {
    use std::collections::HashMap;

    // Memoize per-path folder stats: duplicate groups re-check the current
    // best row's path for every contender, and on NTFS each stat is costly.
    let mut dir_exists: HashMap<String, bool> = HashMap::new();
    let mut path_exists = |path: &str| -> bool {
        *dir_exists
            .entry(path.to_string())
            .or_insert_with(|| vault_root.join(path).is_dir())
    };

    let mut best_by_id: HashMap<String, PaperRecord> = HashMap::new();
    for row in rows {
        let existing_path_exists = path_exists(&row.path);
        best_by_id
            .entry(row.id.clone())
            .and_modify(|best| {
                let best_path_exists = path_exists(&best.path);
                let replace = match (
                    existing_path_exists,
                    best_path_exists,
                    row.updated_at.cmp(&best.updated_at),
                ) {
                    (true, false, _) => true,
                    (false, true, _) => false,
                    (_, _, std::cmp::Ordering::Greater) => true,
                    (_, _, std::cmp::Ordering::Less) => false,
                    _ => {
                        let row_len = row.path.len();
                        let best_len = best.path.len();
                        if row_len != best_len {
                            row_len < best_len
                        } else {
                            row.path < best.path
                        }
                    }
                };
                if replace {
                    *best = row.clone();
                }
            })
            .or_insert(row);
    }

    let mut out: Vec<PaperRecord> = best_by_id.into_values().collect();
    out.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.title.cmp(&b.title))
    });
    out
}

/// Repair duplicate catalog rows.
///
/// For each duplicate `id` group, keeps the canonical row using the same rule
/// as `list_all_unique_by_id` and deletes the rest. `path` duplicates are
/// repaired by keeping the row with the newest `updated_at`.
///
/// Returns the number of rows removed. Deleted rows whose paper folders still
/// exist on disk are reported in `removed_paths` so the caller can follow up
/// manually.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateRepairResult {
    pub removed_rows: usize,
    pub removed_paths: Vec<String>,
    pub kept_paths: Vec<String>,
}

pub fn repair_duplicates(vault_root: &Path) -> Result<DuplicateRepairResult, AppError> {
    with_catalog(vault_root, |conn| {
        let tx = conn.unchecked_transaction().map_err(AppError::from)?;

        let mut stmt = tx
            .prepare("SELECT path, id, title, updated_at FROM papers ORDER BY id, updated_at DESC")
            .map_err(AppError::from)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(DuplicateRow {
                    path: r.get(0)?,
                    id: r.get(1)?,
                    title: r.get(2)?,
                    updated_at: r.get(3)?,
                    path_exists: false,
                })
            })
            .map_err(AppError::from)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from)?;
        drop(stmt);

        let mut by_id: std::collections::BTreeMap<String, Vec<DuplicateRow>> =
            std::collections::BTreeMap::new();
        let mut by_path: std::collections::BTreeMap<String, Vec<DuplicateRow>> =
            std::collections::BTreeMap::new();
        for row in rows {
            by_id.entry(row.id.clone()).or_default().push(row.clone());
            by_path.entry(row.path.clone()).or_default().push(row);
        }

        let mut removed_paths: Vec<String> = Vec::new();
        let mut kept_paths: Vec<String> = Vec::new();

        let choose_canonical = |group: &[DuplicateRow]| -> DuplicateRow {
            group
                .iter()
                .cloned()
                .max_by(|a, b| {
                    let a_exists = vault_root.join(&a.path).is_dir() as i32;
                    let b_exists = vault_root.join(&b.path).is_dir() as i32;
                    a_exists
                        .cmp(&b_exists)
                        .then_with(|| a.updated_at.cmp(&b.updated_at))
                        .then_with(|| b.path.len().cmp(&a.path.len()))
                        .then_with(|| b.path.cmp(&a.path))
                })
                .unwrap_or_else(|| group[0].clone())
        };

        for group in by_id.into_values().filter(|g| g.len() > 1) {
            let canonical = choose_canonical(&group);
            kept_paths.push(canonical.path.clone());
            for row in group {
                if row.path == canonical.path {
                    continue;
                }
                tx.execute("DELETE FROM papers WHERE path = ?1", params![row.path])
                    .map_err(AppError::from)?;
                removed_paths.push(row.path);
            }
        }

        for group in by_path.into_values().filter(|g| g.len() > 1) {
            let canonical = choose_canonical(&group);
            kept_paths.push(canonical.path.clone());
            for row in group {
                if row.path == canonical.path {
                    continue;
                }
                tx.execute("DELETE FROM papers WHERE path = ?1", params![row.path])
                    .map_err(AppError::from)?;
                removed_paths.push(row.path);
            }
        }

        tx.commit().map_err(AppError::from)?;

        removed_paths.sort();
        removed_paths.dedup();
        kept_paths.sort();
        kept_paths.dedup();

        Ok(DuplicateRepairResult {
            removed_rows: removed_paths.len(),
            removed_paths,
            kept_paths,
        })
    })
}

/// Rebuild catalog rows by scanning `papers/` on disk.
/// Detects paper folders by NOTES.md / metadata.json presence. Idempotent —
/// disk-only papers are re-added (sidecar metadata preferred over a minimal
/// folder-name record) and rows whose sidecar is newer are refreshed.
/// Returns the count of rows written.
pub fn rebuild_from_disk(vault_root: &Path) -> Result<usize, AppError> {
    let papers_dir = vault_root.join("papers");
    if !papers_dir.is_dir() {
        return Ok(0);
    }
    with_catalog(vault_root, |conn| {
        let mut count = 0usize;
        let mut stack = vec![papers_dir];
        while let Some(dir) = stack.pop() {
            if dir.join("NOTES.md").is_file() || dir.join(super::sidecar::SIDECAR_FILE).is_file() {
                // A paper folder is a leaf: reconcile and do not descend.
                let rel = dir
                    .strip_prefix(vault_root)
                    .ok()
                    .and_then(|p| p.to_str())
                    .map(|s| s.replace('\\', "/").trim_matches('/').to_string());
                if let Some(rel_path) = rel.filter(|r| !r.is_empty()) {
                    let existing = get_conn(conn, &rel_path).ok().flatten();
                    let sidecar = super::sidecar::read_sidecar(vault_root, &rel_path);
                    let next = match (existing, sidecar) {
                        // Sidecar newer than the row (e.g. pulled in by sync).
                        // Compare by parsed instant: legacy sidecars may carry
                        // second-precision timestamps that never lose (and
                        // re-pollute) under plain string compare.
                        (Some(row), Some(sc))
                            if crate::core::time::rfc3339_after(
                                &sc.updated_at,
                                &row.updated_at,
                            ) =>
                        {
                            Some(sc)
                        }
                        (Some(_), _) => None,
                        (None, Some(sc)) => Some(sc),
                        (None, None) => Some(minimal_record_for(&dir, &rel_path)),
                    };
                    if let Some(record) = next {
                        if upsert_conn(conn, &record).is_ok() {
                            count += 1;
                        }
                    }
                }
                continue;
            }
            if let Ok(read) = fs::read_dir(&dir) {
                for ent in read.flatten() {
                    let p = ent.path();
                    if p.is_dir() {
                        stack.push(p);
                    }
                }
            }
        }
        Ok(count)
    })
}

/// Ensure a catalog row exists for the paper folder at `rel_path`.
/// Single-path variant of [`rebuild_from_disk`]: missing rows are rebuilt
/// from the sidecar (preferred) or a minimal folder-name record, so orphaned
/// folders left behind by a failed import become visible to the Library again.
/// Returns the row (existing or freshly written).
pub fn ensure_row_for_path(
    vault_root: &Path,
    rel_path: &str,
) -> Result<Option<PaperRecord>, AppError> {
    with_catalog(vault_root, |conn| {
        if let Some(row) = get_conn(conn, rel_path)? {
            return Ok(Some(row));
        }
        let record = super::sidecar::read_sidecar(vault_root, rel_path)
            .unwrap_or_else(|| minimal_record_for(&vault_root.join(rel_path), rel_path));
        upsert_conn(conn, &record)?;
        Ok(Some(record))
    })
}

/// Fallback record when a paper folder has no sidecar: folder name as id/title.
fn minimal_record_for(dir: &Path, rel_path: &str) -> PaperRecord {
    let folder_name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(rel_path)
        .to_string();
    let now = crate::core::time::now_rfc3339_millis();
    PaperRecord {
        path: rel_path.to_string(),
        id: folder_name.clone(),
        paper_type: "pdf".to_string(),
        title: folder_name,
        authors: vec![],
        creators: None,
        year: None,
        date: None,
        abstract_text: None,
        tags: vec![],
        arxiv_id: None,
        doi: None,
        isbn: None,
        issn: None,
        pmid: None,
        publication: None,
        volume: None,
        issue: None,
        pages: None,
        publisher: None,
        place: None,
        series: None,
        language: None,
        pdf_url: None,
        html_url: None,
        source_url: None,
        body_source: None,
        body_quality: None,
        bibtex_key: None,
        citation_count: None,
        zotero_item_type: None,
        meta_source: None,
        extra: None,
        summary: None,
        status: "completed".to_string(),
        is_read: false,
        zotero_item_id: None,
        zotero_last_synced: None,
        added_at: now.clone(),
        updated_at: now,
    }
}

/// Manual metadata patch: `None` keeps the current value; a provided value is
/// trimmed and an empty string clears the column (stored as NULL).
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperMetaPatch {
    pub title: Option<String>,
    pub authors: Option<Vec<String>>,
    /// Year as text so an empty string can clear it; validated as 1000..=2100.
    pub year: Option<String>,
    pub doi: Option<String>,
    pub arxiv_id: Option<String>,
    pub publication: Option<String>,
    pub volume: Option<String>,
    pub issue: Option<String>,
    pub pages: Option<String>,
    pub publisher: Option<String>,
    #[serde(rename = "abstract")]
    pub abstract_text: Option<String>,
    pub pdf_url: Option<String>,
    pub html_url: Option<String>,
}

/// Apply a manual metadata patch; returns the updated row.
/// Marks `meta_source = "manual"` so sync/rescan flows know the user edited it.
/// A title change appends the new title to NOTES.md frontmatter aliases
/// (best-effort, old aliases kept for wiki-link compatibility).
pub fn update_meta(
    vault_root: &Path,
    path: &str,
    patch: &PaperMetaPatch,
) -> Result<PaperRecord, AppError> {
    let path = path.replace('\\', "/").trim_matches('/').to_string();
    let Some(mut row) = get_by_path(vault_root, &path)? else {
        return Err(AppError::message("paper not found in catalog"));
    };

    fn norm(value: &str) -> Option<String> {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    }

    let mut title_changed = false;
    if let Some(title) = patch.title.as_deref() {
        let title = title.trim();
        if title.is_empty() {
            return Err(AppError::message("title cannot be empty"));
        }
        title_changed = title != row.title;
        row.title = title.to_string();
    }
    if let Some(authors) = &patch.authors {
        row.authors = authors
            .iter()
            .map(|a| a.trim().to_string())
            .filter(|a| !a.is_empty())
            .collect();
    }
    if let Some(year) = patch.year.as_deref() {
        row.year = match norm(year) {
            None => None,
            Some(text) => {
                let parsed: i32 = text
                    .parse()
                    .map_err(|_| AppError::message("year must be a number"))?;
                if !(1000..=2100).contains(&parsed) {
                    return Err(AppError::message("year must be between 1000 and 2100"));
                }
                Some(parsed)
            }
        };
    }
    if let Some(v) = patch.doi.as_deref() {
        row.doi = norm(v);
    }
    if let Some(v) = patch.arxiv_id.as_deref() {
        row.arxiv_id = norm(v);
    }
    if let Some(v) = patch.publication.as_deref() {
        row.publication = norm(v);
    }
    if let Some(v) = patch.volume.as_deref() {
        row.volume = norm(v);
    }
    if let Some(v) = patch.issue.as_deref() {
        row.issue = norm(v);
    }
    if let Some(v) = patch.pages.as_deref() {
        row.pages = norm(v);
    }
    if let Some(v) = patch.publisher.as_deref() {
        row.publisher = norm(v);
    }
    if let Some(v) = patch.abstract_text.as_deref() {
        row.abstract_text = norm(v);
    }
    if let Some(v) = patch.pdf_url.as_deref() {
        row.pdf_url = norm(v);
    }
    if let Some(v) = patch.html_url.as_deref() {
        row.html_url = norm(v);
    }

    row.meta_source = Some("manual".to_string());
    row.updated_at = crate::core::time::now_rfc3339_millis();
    let updated = upsert_paper(vault_root, &row)?;
    if title_changed {
        crate::features::wiki::append_title_alias_best_effort(vault_root, &path, &updated.title);
    }
    Ok(updated)
}

/// Set `is_read` for a paper path; returns the updated row.
pub fn set_is_read(vault_root: &Path, path: &str, is_read: bool) -> Result<PaperRecord, AppError> {
    let path = path.replace('\\', "/").trim_matches('/').to_string();
    let Some(mut row) = get_by_path(vault_root, &path)? else {
        return Err(AppError::message("paper not found in catalog"));
    };
    row.is_read = is_read;
    row.updated_at = crate::core::time::now_rfc3339_millis();
    upsert_paper(vault_root, &row)
}

/// Replace tags for a paper path; returns the updated row.
/// Tags are trimmed, empty strings dropped, and de-duplicated case-insensitively
/// (first occurrence keeps its original casing).
pub fn set_tags(vault_root: &Path, path: &str, tags: &[PaperTag]) -> Result<PaperRecord, AppError> {
    let path = path.replace('\\', "/").trim_matches('/').to_string();
    let Some(mut row) = get_by_path(vault_root, &path)? else {
        return Err(AppError::message("paper not found in catalog"));
    };
    row.tags = normalize_tags(tags);
    row.updated_at = crate::core::time::now_rfc3339_millis();
    upsert_paper(vault_root, &row)
}

/// Append tags to a paper (trim + case-insensitive dedupe). Returns the updated row.
pub fn add_tags(vault_root: &Path, path: &str, tags: &[PaperTag]) -> Result<PaperRecord, AppError> {
    let path = path.replace('\\', "/").trim_matches('/').to_string();
    let Some(mut row) = get_by_path(vault_root, &path)? else {
        return Err(AppError::message("paper not found in catalog"));
    };
    let mut next = row.tags.clone();
    next.extend(tags.iter().cloned());
    row.tags = normalize_tags(&next);
    row.updated_at = crate::core::time::now_rfc3339_millis();
    upsert_paper(vault_root, &row)
}

/// Remove tags from a paper (case-insensitive). Returns the updated row.
pub fn remove_tags(
    vault_root: &Path,
    path: &str,
    tags: &[String],
) -> Result<PaperRecord, AppError> {
    let path = path.replace('\\', "/").trim_matches('/').to_string();
    let Some(mut row) = get_by_path(vault_root, &path)? else {
        return Err(AppError::message("paper not found in catalog"));
    };
    let drop: Vec<String> = tags
        .iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    row.tags
        .retain(|existing| !drop.iter().any(|d| d.eq_ignore_ascii_case(&existing.name)));
    row.updated_at = crate::core::time::now_rfc3339_millis();
    upsert_paper(vault_root, &row)
}

/// Catalog-wide tag inventory entry (name + optional color + count).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagCount {
    pub name: String,
    pub color: Option<String>,
    pub count: usize,
}

/// Unique tags across the catalog with occurrence counts (sorted by tag name).
/// First-seen casing is preserved; first non-empty color wins.
pub fn list_all_tags(vault_root: &Path) -> Result<Vec<TagCount>, AppError> {
    let rows = list_all(vault_root)?;
    // key = lowercase name → (display name, color, count)
    let mut map: std::collections::BTreeMap<String, (String, Option<String>, usize)> =
        std::collections::BTreeMap::new();
    for r in rows {
        for tag in r.tags {
            let key = tag.name.to_ascii_lowercase();
            map.entry(key)
                .and_modify(|(name, color, n)| {
                    *n += 1;
                    if color.is_none() {
                        *color = normalize_color(tag.color.as_deref());
                    }
                    let _ = name; // casing from first insert
                })
                .or_insert((tag.name, normalize_color(tag.color.as_deref()), 1));
        }
    }
    Ok(map
        .into_values()
        .map(|(name, color, count)| TagCount { name, color, count })
        .collect())
}

/// True if the paper has every tag in `required` (exact match, case-insensitive).
pub fn paper_has_all_tags(paper: &PaperRecord, required: &[String]) -> bool {
    required.iter().all(|need| {
        let n = need.trim();
        if n.is_empty() {
            return true;
        }
        paper.tags.iter().any(|t| t.name.eq_ignore_ascii_case(n))
    })
}

pub fn normalize_tags(tags: &[PaperTag]) -> Vec<PaperTag> {
    let mut out: Vec<PaperTag> = Vec::new();
    for raw in tags {
        let t = raw.name.trim();
        if t.is_empty() {
            continue;
        }
        if let Some(existing) = out
            .iter_mut()
            .find(|existing| existing.name.eq_ignore_ascii_case(t))
        {
            // First-seen casing wins; fill color if the earlier entry had none.
            if existing.color.is_none() {
                existing.color = normalize_color(raw.color.as_deref());
            }
            continue;
        }
        out.push(PaperTag {
            name: t.to_string(),
            color: normalize_color(raw.color.as_deref()),
        });
    }
    out
}

/// Snapshot the paper row at `path` and any papers nested under `path/`.
/// Used by the recycle bin so a delete can be undone (see `services::trash`).
pub fn list_under_path(vault_root: &Path, path: &str) -> Result<Vec<PaperRecord>, AppError> {
    let path = path.replace('\\', "/").trim_matches('/').to_string();
    if path.is_empty() {
        return Ok(Vec::new());
    }
    let like = format!("{path}/%");
    with_catalog(vault_root, |conn| {
        let mut stmt = conn
            .prepare(&format!(
                r#"
            SELECT {PAPER_COLUMNS}
            FROM papers
            WHERE path = ?1 OR path LIKE ?2
            ORDER BY path ASC
            "#,
            ))
            .map_err(AppError::from)?;
        let rows = stmt
            .query_map(params![path, like], map_row)
            .map_err(AppError::from)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from)?;
        Ok(rows)
    })
}

/// Delete a paper row and any papers nested under `path/` (org folder delete).
/// Returns the number of catalog rows removed.
pub fn delete_under_path(vault_root: &Path, path: &str) -> Result<usize, AppError> {
    let path = path.replace('\\', "/").trim_matches('/').to_string();
    if path.is_empty() {
        return Err(AppError::message("path is required"));
    }
    let like = format!("{path}/%");
    with_catalog(vault_root, |conn| {
        let n = conn
            .execute(
                "DELETE FROM papers WHERE path = ?1 OR path LIKE ?2",
                params![path, like],
            )
            .map_err(AppError::from)?;
        conn.execute(
            "DELETE FROM pdf_page_counts WHERE path = ?1 OR path LIKE ?2",
            params![path, like],
        )
        .map_err(AppError::from)?;
        Ok(n)
    })
}

/// Move a paper folder (and any papers nested under it) in the catalog by
/// rewriting the `from` path prefix to `to`. Returns the number of rows updated.
pub fn move_under_path(vault_root: &Path, from: &str, to: &str) -> Result<usize, AppError> {
    let from = from.replace('\\', "/").trim_matches('/').to_string();
    let to = to.replace('\\', "/").trim_matches('/').to_string();
    if from.is_empty() || to.is_empty() {
        return Err(AppError::message("from and to are required"));
    }
    let like = format!("{from}/%");
    let now = crate::core::time::now_rfc3339_millis();
    // Exact row -> `to`; nested rows -> `to` + the suffix after `from`.
    // substr uses a 1-based CHARACTER index so non-ASCII folder names are safe.
    let offset = from.chars().count() as i64 + 1;
    with_catalog(vault_root, |conn| {
        let n = conn
            .execute(
                "UPDATE papers SET path = ?1 || substr(path, ?2), updated_at = ?3 \
                 WHERE path = ?4 OR path LIKE ?5",
                params![to, offset, now, from, like],
            )
            .map_err(AppError::from)?;
        conn.execute(
            "UPDATE pdf_page_counts SET path = ?1 || substr(path, ?2) \
             WHERE path = ?3 OR path LIKE ?4",
            params![to, offset, from, like],
        )
        .map_err(AppError::from)?;
        Ok(n)
    })
}

/// Remove catalog rows whose paper folder no longer exists on disk (orphans left
/// by deleting folders outside the app). Returns the number of rows removed.
pub fn prune_missing(vault_root: &Path) -> Result<usize, AppError> {
    with_catalog(vault_root, |conn| {
        let mut stmt = conn
            .prepare("SELECT path FROM papers")
            .map_err(AppError::from)?;
        let paths = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(AppError::from)?
            .collect::<Result<Vec<String>, _>>()
            .map_err(AppError::from)?;
        drop(stmt);
        let mut removed = 0usize;
        for path in paths {
            if !vault_root.join(&path).is_dir() {
                removed += conn
                    .execute("DELETE FROM papers WHERE path = ?1", params![path])
                    .map_err(AppError::from)?;
            }
        }
        Ok(removed)
    })
}

/// Cached PDF page counts keyed by vault-relative paper path.
/// Lets the reading heatmap skip reopening every PDF just to count pages.
pub fn list_page_counts(
    vault_root: &Path,
) -> Result<std::collections::HashMap<String, i64>, AppError> {
    with_catalog(vault_root, |conn| {
        let mut stmt = conn
            .prepare("SELECT path, page_count FROM pdf_page_counts")
            .map_err(AppError::from)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(AppError::from)?
            .collect::<Result<std::collections::HashMap<_, _>, _>>()
            .map_err(AppError::from)?;
        Ok(rows)
    })
}

/// Batch-upsert cached page counts. Deliberately does not touch `papers`
/// (no `updated_at` bump) so caching never reorders the library.
pub fn set_page_counts(vault_root: &Path, counts: &[(String, i64)]) -> Result<(), AppError> {
    if counts.is_empty() {
        return Ok(());
    }
    with_catalog(vault_root, |conn| {
        let tx = conn.unchecked_transaction().map_err(AppError::from)?;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO pdf_page_counts (path, page_count) VALUES (?1, ?2) \
                     ON CONFLICT(path) DO UPDATE SET page_count = excluded.page_count",
                )
                .map_err(AppError::from)?;
            for (path, count) in counts {
                stmt.execute(params![path, count]).map_err(AppError::from)?;
            }
        }
        tx.commit().map_err(AppError::from)?;
        Ok(())
    })
}

fn upsert_conn(conn: &Connection, r: &PaperRecord) -> Result<(), AppError> {
    let mut r = r.clone();
    // Legacy sidecars may carry second-precision timestamps; normalize on the
    // write path so Secs/Millis never mix inside the string-ordered catalog.
    if let Some(fixed) = crate::core::time::normalize_rfc3339_millis(&r.updated_at) {
        r.updated_at = fixed;
    }
    if let Some(fixed) = crate::core::time::normalize_rfc3339_millis(&r.added_at) {
        r.added_at = fixed;
    }
    let authors_json =
        serde_json::to_string(&r.authors).map_err(|e| AppError::message(e.to_string()))?;
    let tags_json = serde_json::to_string(&r.tags).map_err(|e| AppError::message(e.to_string()))?;
    let creators_json = r
        .creators
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| AppError::message(e.to_string()))?;

    conn.execute(
        &format!(
            r#"
        INSERT INTO papers ({PAPER_COLUMNS}) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
            ?9, ?10, ?11, ?12, ?13,
            ?14, ?15, ?16, ?17, ?18, ?19,
            ?20, ?21,
            ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30,
            ?31, ?32, ?33, ?34, ?35, ?36, ?37,
            ?38, ?39, ?40
        )
        ON CONFLICT(path) DO UPDATE SET
            id = excluded.id,
            type = excluded.type,
            title = excluded.title,
            authors_json = excluded.authors_json,
            year = excluded.year,
            abstract = excluded.abstract,
            tags_json = excluded.tags_json,
            arxiv_id = excluded.arxiv_id,
            doi = excluded.doi,
            pdf_url = excluded.pdf_url,
            html_url = excluded.html_url,
            source_url = excluded.source_url,
            body_source = excluded.body_source,
            body_quality = excluded.body_quality,
            bibtex_key = excluded.bibtex_key,
            citation_count = excluded.citation_count,
            status = excluded.status,
            summary = excluded.summary,
            updated_at = excluded.updated_at,
            creators_json = excluded.creators_json,
            date = excluded.date,
            isbn = excluded.isbn,
            issn = excluded.issn,
            pmid = excluded.pmid,
            publication = excluded.publication,
            volume = excluded.volume,
            issue = excluded.issue,
            pages = excluded.pages,
            publisher = excluded.publisher,
            place = excluded.place,
            series = excluded.series,
            language = excluded.language,
            zotero_item_type = excluded.zotero_item_type,
            meta_source = excluded.meta_source,
            extra = excluded.extra,
            is_read = excluded.is_read,
            zotero_item_id = excluded.zotero_item_id,
            zotero_last_synced = excluded.zotero_last_synced
        "#,
        ),
        params![
            r.path,
            r.id,
            r.paper_type,
            r.title,
            authors_json,
            r.year,
            r.abstract_text,
            tags_json,
            r.arxiv_id,
            r.doi,
            r.pdf_url,
            r.html_url,
            r.source_url,
            r.body_source,
            r.body_quality,
            r.bibtex_key,
            r.citation_count,
            r.status,
            r.summary,
            r.added_at,
            r.updated_at,
            creators_json,
            r.date,
            r.isbn,
            r.issn,
            r.pmid,
            r.publication,
            r.volume,
            r.issue,
            r.pages,
            r.publisher,
            r.place,
            r.series,
            r.language,
            r.zotero_item_type,
            r.meta_source,
            r.extra,
            if r.is_read { 1i32 } else { 0i32 },
            r.zotero_item_id,
            r.zotero_last_synced,
        ],
    )
    .map_err(AppError::from)?;
    Ok(())
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PaperRecord> {
    let authors_json: String = row.get(4)?;
    let tags_json: String = row.get(7)?;
    let creators_json: Option<String> = row.get(21)?;
    let is_read_i: i32 = row.get(37)?;
    let zotero_item_id: Option<i64> = row.get(38)?;
    let zotero_last_synced: Option<String> = row.get(39)?;
    Ok(PaperRecord {
        path: row.get(0)?,
        id: row.get(1)?,
        paper_type: row.get(2)?,
        title: row.get(3)?,
        authors: serde_json::from_str(&authors_json).unwrap_or_default(),
        year: row.get(5)?,
        abstract_text: row.get(6)?,
        tags: serde_json::from_str(&tags_json).unwrap_or_default(),
        arxiv_id: row.get(8)?,
        doi: row.get(9)?,
        pdf_url: row.get(10)?,
        html_url: row.get(11)?,
        source_url: row.get(12)?,
        body_source: row.get(13)?,
        body_quality: row.get(14)?,
        bibtex_key: row.get(15)?,
        citation_count: row.get(16)?,
        status: row.get(17)?,
        summary: row.get(18)?,
        added_at: row.get(19)?,
        updated_at: row.get(20)?,
        creators: creators_json
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok()),
        date: row.get(22)?,
        isbn: row.get(23)?,
        issn: row.get(24)?,
        pmid: row.get(25)?,
        publication: row.get(26)?,
        volume: row.get(27)?,
        issue: row.get(28)?,
        pages: row.get(29)?,
        publisher: row.get(30)?,
        place: row.get(31)?,
        series: row.get(32)?,
        language: row.get(33)?,
        zotero_item_type: row.get(34)?,
        meta_source: row.get(35)?,
        extra: row.get(36)?,
        is_read: is_read_i != 0,
        zotero_item_id,
        zotero_last_synced,
    })
}

fn get_conn(conn: &Connection, path: &str) -> Result<Option<PaperRecord>, AppError> {
    let mut stmt = conn
        .prepare(&format!(
            r#"
            SELECT {PAPER_COLUMNS}
            FROM papers WHERE path = ?1
            "#,
        ))
        .map_err(AppError::from)?;

    let row = stmt
        .query_row(params![path], map_row)
        .optional()
        .map_err(AppError::from)?;

    Ok(row)
}

#[cfg(test)]
mod tests {
    use super::super::schema::{catalog_open_count, ensure_catalog};
    use super::*;
    use std::env;

    fn insert(conn: &Connection, path: &str) {
        conn.execute(
            "INSERT INTO papers (path, id, type, title, added_at, updated_at) \
             VALUES (?1, ?2, 'article', ?2, 't', 't')",
            params![path, path],
        )
        .unwrap();
    }

    #[test]
    fn move_under_path_rewrites_prefix() {
        let dir = env::temp_dir().join(format!("agentero-move-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        {
            let conn = ensure_catalog(&dir).unwrap();
            insert(&conn, "papers/a");
            insert(&conn, "papers/nlp/b");
            insert(&conn, "papers/other/c");
        }
        // Org folder move rewrites nested paper rows.
        assert_eq!(
            move_under_path(&dir, "papers/nlp", "papers/archive/nlp").unwrap(),
            1
        );
        // Leaf paper move rewrites the exact row.
        assert_eq!(
            move_under_path(&dir, "papers/a", "papers/archive/a").unwrap(),
            1
        );

        let conn = ensure_catalog(&dir).unwrap();
        let count = |p: &str| -> i64 {
            conn.query_row(
                "SELECT COUNT(*) FROM papers WHERE path = ?1",
                params![p],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(count("papers/archive/nlp/b"), 1);
        assert_eq!(count("papers/archive/a"), 1);
        assert_eq!(count("papers/other/c"), 1);
        assert_eq!(count("papers/nlp/b"), 0);
        assert_eq!(count("papers/a"), 0);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn update_meta_patches_fields_and_syncs_aliases() {
        let dir = env::temp_dir().join(format!("agentero-update-meta-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let paper_dir = dir.join("papers").join("x");
        fs::create_dir_all(&paper_dir).unwrap();
        fs::write(
            paper_dir.join("NOTES.md"),
            "---\naliases:\n  - \"Old Title\"\n---\n# Old Title\n",
        )
        .unwrap();
        {
            let conn = ensure_catalog(&dir).unwrap();
            conn.execute(
                "INSERT INTO papers (path, id, type, title, doi, added_at, updated_at) \
                 VALUES ('papers/x', 'x', 'article', 'Old Title', '10.1/old', 't', 't')",
                [],
            )
            .unwrap();
        }

        // Patch semantics: provided fields update, omitted fields stay.
        let row = update_meta(
            &dir,
            "papers/x",
            &PaperMetaPatch {
                title: Some("New Title".into()),
                authors: Some(vec![" A ".into(), "".into(), "B".into()]),
                year: Some("2024".into()),
                publication: Some("NeurIPS".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(row.title, "New Title");
        assert_eq!(row.authors, vec!["A".to_string(), "B".to_string()]);
        assert_eq!(row.year, Some(2024));
        assert_eq!(row.publication.as_deref(), Some("NeurIPS"));
        assert_eq!(row.doi.as_deref(), Some("10.1/old")); // untouched
        assert_eq!(row.meta_source.as_deref(), Some("manual"));

        // New title appended to aliases; old alias kept.
        let notes = fs::read_to_string(paper_dir.join("NOTES.md")).unwrap();
        assert!(notes.contains("Old Title"));
        assert!(notes.contains("New Title"));

        // Empty string clears a column; empty year clears year.
        let row = update_meta(
            &dir,
            "papers/x",
            &PaperMetaPatch {
                doi: Some("  ".into()),
                year: Some("".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(row.doi, None);
        assert_eq!(row.year, None);

        // Validation errors.
        assert!(update_meta(
            &dir,
            "papers/x",
            &PaperMetaPatch {
                title: Some("  ".into()),
                ..Default::default()
            },
        )
        .is_err());
        assert!(update_meta(
            &dir,
            "papers/x",
            &PaperMetaPatch {
                year: Some("99".into()),
                ..Default::default()
            },
        )
        .is_err());
        assert!(update_meta(&dir, "papers/missing", &PaperMetaPatch::default()).is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_missing_publication_filters_null_and_empty() {
        let dir = env::temp_dir().join(format!("agentero-missing-pub-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        {
            let conn = ensure_catalog(&dir).unwrap();
            conn.execute_batch(
                "INSERT INTO papers (path, id, type, title, publication, added_at, updated_at) VALUES \
                 ('papers/a', 'a', 'article', 'A', 'NeurIPS', 't', 't'), \
                 ('papers/b', 'b', 'article', 'B', NULL, 't', 't'), \
                 ('papers/c', 'c', 'article', 'C', '', 't', 't'), \
                 ('papers/d', 'd', 'article', 'D', '  ', 't', 't');",
            )
            .unwrap();
        }

        let rows = list_missing_publication(&dir).unwrap();
        let mut paths: Vec<_> = rows.iter().map(|r| r.path.as_str()).collect();
        paths.sort();
        assert_eq!(paths, vec!["papers/b", "papers/c", "papers/d"]);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn internal_arxiv_tags_are_hidden() {
        assert!(is_internal_tag_name("@zotero:imported"));
        assert!(is_internal_tag_name(
            "@arxiv:Computer Science - Machine Learning"
        ));
        assert!(is_internal_tag_name("Computer Science - Machine Learning"));
        assert!(is_internal_tag_name("Statistics - Machine Learning"));
        assert!(is_arxiv_category_label("High Energy Physics - Theory"));
        assert!(!is_internal_tag_name("survey"));
        assert!(!is_arxiv_category_label("Machine Learning"));
        assert_eq!(
            hide_arxiv_category_tag("Computer Science - Machine Learning"),
            "@arxiv:Computer Science - Machine Learning"
        );
        assert_eq!(hide_arxiv_category_tag("survey"), "survey");
        assert_eq!(hide_arxiv_category_tag("@arxiv:cs.LG"), "@arxiv:cs.LG");
        assert_eq!(
            hide_arxiv_category_tag("@zotero:Computer Science - Machine Learning"),
            "@zotero:Computer Science - Machine Learning"
        );
    }

    #[test]
    fn normalize_tags_trims_dedupes_case_insensitive() {
        let tags = normalize_tags(&[
            PaperTag {
                name: "  NLP ".into(),
                color: Some("green".into()),
            },
            "nlp".into(),
            "".into(),
            "  ".into(),
            "RL".into(),
            "rl".into(),
            "CV".into(),
        ]);
        assert_eq!(
            tags,
            vec![
                PaperTag {
                    name: "NLP".into(),
                    color: Some("green".into()),
                },
                PaperTag::new("RL"),
                PaperTag::new("CV"),
            ]
        );
    }

    #[test]
    fn paper_tag_json_roundtrip_string_and_object() {
        let raw = r#"["NLP",{"name":"survey","color":"red"},"x"]"#;
        let tags: Vec<PaperTag> = serde_json::from_str(raw).unwrap();
        assert_eq!(tags[0], PaperTag::new("NLP"));
        assert_eq!(
            tags[1],
            PaperTag {
                name: "survey".into(),
                color: Some("red".into()),
            }
        );
        let out = serde_json::to_string(&tags).unwrap();
        assert!(out.contains(r#""NLP""#));
        assert!(out.contains(r#""color":"red""#));
    }

    #[test]
    fn paper_has_all_tags_and_match() {
        let mut p = PaperRecord {
            path: "papers/x".into(),
            id: "x".into(),
            paper_type: "other".into(),
            title: "T".into(),
            authors: vec![],
            creators: None,
            year: None,
            date: None,
            abstract_text: None,
            tags: vec![PaperTag::new("NLP"), PaperTag::new("rl")],
            arxiv_id: None,
            doi: None,
            isbn: None,
            issn: None,
            pmid: None,
            publication: None,
            volume: None,
            issue: None,
            pages: None,
            publisher: None,
            place: None,
            series: None,
            language: None,
            pdf_url: None,
            html_url: None,
            source_url: None,
            body_source: None,
            body_quality: None,
            bibtex_key: None,
            citation_count: None,
            zotero_item_type: None,
            meta_source: None,
            extra: None,
            summary: None,
            status: "completed".into(),
            is_read: false,
            zotero_item_id: None,
            zotero_last_synced: None,
            added_at: "t".into(),
            updated_at: "t".into(),
        };
        assert!(paper_has_all_tags(&p, &["nlp".into(), "RL".into()]));
        assert!(!paper_has_all_tags(&p, &["nlp".into(), "cv".into()]));
        p.tags.clear();
        assert!(paper_has_all_tags(&p, &[]));
    }

    #[test]
    fn rebuild_from_disk_reimports_from_notes() {
        let dir = env::temp_dir().join(format!("agentero-rescan-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let paper_dir = dir.join("papers").join("x");
        fs::create_dir_all(&paper_dir).unwrap();
        // Catalog is authoritative; disk recovery keys off NOTES.md only.
        fs::write(paper_dir.join("NOTES.md"), "# notes\n").unwrap();
        let record = PaperRecord {
            path: "papers/x".into(),
            id: "x".into(),
            paper_type: "article".into(),
            title: "Attention".into(),
            authors: vec!["A".into()],
            creators: None,
            year: Some(2017),
            date: None,
            abstract_text: None,
            tags: vec![],
            arxiv_id: None,
            doi: None,
            isbn: None,
            issn: None,
            pmid: None,
            publication: None,
            volume: None,
            issue: None,
            pages: None,
            publisher: None,
            place: None,
            series: None,
            language: None,
            pdf_url: None,
            html_url: None,
            source_url: None,
            body_source: None,
            body_quality: None,
            bibtex_key: None,
            citation_count: None,
            zotero_item_type: None,
            meta_source: None,
            extra: None,
            summary: None,
            status: "completed".into(),
            is_read: false,
            zotero_item_id: None,
            zotero_last_synced: None,
            added_at: "t".into(),
            updated_at: "t".into(),
        };
        upsert_paper(&dir, &record).unwrap();
        // Simulate a lost catalog row (folder + NOTES.md + sidecar stay on disk).
        delete_under_path(&dir, "papers/x").unwrap();
        assert!(get_by_path(&dir, "papers/x").unwrap().is_none());

        // Rescan restores the full row from the metadata.json sidecar.
        assert_eq!(rebuild_from_disk(&dir).unwrap(), 1);
        let row = get_by_path(&dir, "papers/x").unwrap().unwrap();
        assert_eq!(row.path, "papers/x");
        assert_eq!(row.id, "x");
        assert_eq!(row.title, "Attention");
        assert_eq!(row.year, Some(2017));

        // Without a sidecar, rescan falls back to a minimal folder-name row.
        fs::remove_file(dir.join("papers/x/metadata.json")).unwrap();
        delete_under_path(&dir, "papers/x").unwrap();
        assert_eq!(rebuild_from_disk(&dir).unwrap(), 1);
        let row = get_by_path(&dir, "papers/x").unwrap().unwrap();
        assert_eq!(row.title, "x");
        assert_eq!(row.year, None);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ensure_row_for_path_heals_orphaned_folder() {
        let dir = env::temp_dir().join(format!("agentero-ensure-row-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let paper_dir = dir.join("papers").join("x");
        fs::create_dir_all(&paper_dir).unwrap();
        fs::write(paper_dir.join("NOTES.md"), "# notes\n").unwrap();
        let record = PaperRecord {
            path: "papers/x".into(),
            id: "x".into(),
            paper_type: "article".into(),
            title: "Attention".into(),
            authors: vec![],
            creators: None,
            year: Some(2017),
            date: None,
            abstract_text: None,
            tags: vec![],
            arxiv_id: None,
            doi: None,
            isbn: None,
            issn: None,
            pmid: None,
            publication: None,
            volume: None,
            issue: None,
            pages: None,
            publisher: None,
            place: None,
            series: None,
            language: None,
            pdf_url: None,
            html_url: None,
            source_url: None,
            body_source: None,
            body_quality: None,
            bibtex_key: None,
            citation_count: None,
            zotero_item_type: None,
            meta_source: None,
            extra: None,
            summary: None,
            status: "completed".into(),
            is_read: false,
            zotero_item_id: None,
            zotero_last_synced: None,
            added_at: "t".into(),
            updated_at: "t".into(),
        };
        upsert_paper(&dir, &record).unwrap();
        // Simulate a failed import's aftermath: folder + sidecar exist, row lost.
        delete_under_path(&dir, "papers/x").unwrap();

        // Heals from the metadata.json sidecar.
        let healed = ensure_row_for_path(&dir, "papers/x").unwrap().unwrap();
        assert_eq!(healed.title, "Attention");
        let row = get_by_path(&dir, "papers/x").unwrap().unwrap();
        assert_eq!(row.year, Some(2017));

        // Idempotent: existing rows pass through untouched.
        let again = ensure_row_for_path(&dir, "papers/x").unwrap().unwrap();
        assert_eq!(again.title, "Attention");

        // Without a sidecar, falls back to a minimal folder-name record.
        fs::remove_file(paper_dir.join("metadata.json")).unwrap();
        delete_under_path(&dir, "papers/x").unwrap();
        let minimal = ensure_row_for_path(&dir, "papers/x").unwrap().unwrap();
        assert_eq!(minimal.title, "x");
        assert_eq!(minimal.year, None);

        let _ = fs::remove_dir_all(&dir);
    }

    fn insert_with_id(conn: &Connection, path: &str, id: &str, updated_at: &str) {
        conn.execute(
            "INSERT INTO papers (path, id, type, title, added_at, updated_at) \
             VALUES (?1, ?2, 'article', ?2, 't', ?3)",
            params![path, id, updated_at],
        )
        .unwrap();
    }

    #[test]
    fn find_duplicates_reports_duplicate_ids_and_paths() {
        let dir = env::temp_dir().join(format!("agentero-dup-detect-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        {
            let conn = ensure_catalog(&dir).unwrap();
            insert_with_id(&conn, "papers/a", "shared", "2024-01-01T00:00:00Z");
            insert_with_id(&conn, "papers/b", "shared", "2024-01-02T00:00:00Z");
            insert_with_id(&conn, "papers/c", "other", "2024-01-03T00:00:00Z");
        }

        let report = find_duplicates(&dir).unwrap();
        assert_eq!(report.duplicate_ids.len(), 1);
        assert_eq!(report.duplicate_ids[0].key, "shared");
        assert_eq!(report.duplicate_ids[0].rows.len(), 2);
        assert!(report.duplicate_paths.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_by_identifier_returns_zotero_fields() {
        let dir = env::temp_dir().join(format!("agentero-find-id-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        {
            let conn = ensure_catalog(&dir).unwrap();
            conn.execute(
                "INSERT INTO papers (path, id, type, title, doi, added_at, updated_at, \
                 zotero_item_id, zotero_last_synced) VALUES \
                 ('papers/z', 'z', 'article', 'Zotero Paper', '10.1/z', 't', 't', 12345, \
                 '2024-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        }

        let row = find_by_identifier(&dir, "doi", "10.1/z").unwrap().unwrap();
        assert_eq!(row.zotero_item_id, Some(12345));
        assert_eq!(
            row.zotero_last_synced.as_deref(),
            Some("2024-01-01T00:00:00Z")
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_all_unique_by_id_prefers_existing_path_then_newest() {
        let dir = env::temp_dir().join(format!("agentero-dup-view-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::create_dir_all(dir.join("papers/a")).unwrap();
        fs::create_dir_all(dir.join("papers/b")).unwrap();
        {
            let conn = ensure_catalog(&dir).unwrap();
            insert_with_id(&conn, "papers/a", "shared", "2024-01-01T00:00:00Z");
            insert_with_id(&conn, "papers/b", "shared", "2024-01-02T00:00:00Z");
            insert_with_id(&conn, "papers/c", "other", "2024-01-03T00:00:00Z");
        }

        let rows = list_all_unique_by_id(&dir).unwrap();
        let shared = rows.iter().find(|r| r.id == "shared").unwrap();
        // Both paths exist; newer updated_at wins.
        assert_eq!(shared.path, "papers/b");
        assert_eq!(rows.len(), 2);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_all_unique_by_id_prefers_path_that_exists_on_disk() {
        let dir = env::temp_dir().join(format!("agentero-dup-exists-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::create_dir_all(dir.join("papers/old")).unwrap();
        {
            let conn = ensure_catalog(&dir).unwrap();
            insert_with_id(&conn, "papers/old", "shared", "2024-01-01T00:00:00Z");
            insert_with_id(&conn, "papers/ghost", "shared", "2024-01-03T00:00:00Z");
        }

        let rows = list_all_unique_by_id(&dir).unwrap();
        let shared = rows.iter().find(|r| r.id == "shared").unwrap();
        // Existing path wins even though it is older.
        assert_eq!(shared.path, "papers/old");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn repair_duplicates_removes_extra_rows() {
        let dir = env::temp_dir().join(format!("agentero-dup-repair-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::create_dir_all(dir.join("papers/keep")).unwrap();
        {
            let conn = ensure_catalog(&dir).unwrap();
            insert_with_id(&conn, "papers/keep", "shared", "2024-01-02T00:00:00Z");
            insert_with_id(&conn, "papers/drop", "shared", "2024-01-01T00:00:00Z");
        }

        let result = repair_duplicates(&dir).unwrap();
        assert_eq!(result.removed_rows, 1);
        assert!(result.removed_paths.contains(&"papers/drop".to_string()));
        assert!(result.kept_paths.contains(&"papers/keep".to_string()));

        let rows = list_all_conn(&ensure_catalog(&dir).unwrap()).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].path, "papers/keep");

        let _ = fs::remove_dir_all(&dir);
    }

    /// Quantifies the persistent-connection win: 200 `list_all` calls must
    /// reuse one cached connection instead of paying open + PRAGMAs +
    /// migrate() per call (the old behavior, timed here as the baseline).
    /// Prints both durations (`cargo test ... -- --nocapture`).
    #[test]
    fn list_all_reuses_persistent_connection() {
        let dir = env::temp_dir().join(format!("agentero-conn-cache-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        {
            let conn = ensure_catalog(&dir).unwrap();
            for i in 0..50 {
                insert(&conn, &format!("papers/p{i:02}"));
            }
        }

        // Baseline = old behavior: fresh connection + PRAGMAs + migrate per call.
        let fresh_start = std::time::Instant::now();
        for _ in 0..200 {
            let conn = ensure_catalog(&dir).unwrap();
            assert_eq!(list_all_conn(&conn).unwrap().len(), 50);
        }
        let fresh = fresh_start.elapsed();

        let opens_before = catalog_open_count(&dir);
        let cached_start = std::time::Instant::now();
        for _ in 0..200 {
            assert_eq!(list_all(&dir).unwrap().len(), 50);
        }
        let cached = cached_start.elapsed();
        let opens = catalog_open_count(&dir) - opens_before;

        eprintln!(
            "200x list_all (50 rows): fresh-open per call={fresh:?} cached-conn={cached:?} \
             ({:.1}x), physical opens={opens}",
            fresh.as_secs_f64() / cached.as_secs_f64().max(f64::EPSILON)
        );
        assert!(opens <= 1, "expected at most 1 physical open, got {opens}");
        assert!(
            cached < fresh,
            "cached connection ({cached:?}) should beat per-call opens ({fresh:?})"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn with_catalog_recovers_after_db_deleted_externally() {
        let dir = env::temp_dir().join(format!("agentero-conn-stale-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        // Populate through the cached connection.
        with_catalog(&dir, |conn| {
            insert(conn, "papers/a");
            Ok(())
        })
        .unwrap();
        assert_eq!(list_all(&dir).unwrap().len(), 1);

        // Simulate the vault's catalog being deleted externally. WAL keeps the
        // unlinked inode alive, so a stale handle would still "work" against a
        // ghost database; with_catalog must detect the missing file and reopen.
        fs::remove_dir_all(dir.join(".agentero")).unwrap();
        assert_eq!(list_all(&dir).unwrap().len(), 0);
        assert!(super::super::schema::catalog_db_path(&dir).is_file());

        let _ = fs::remove_dir_all(&dir);
    }
}
