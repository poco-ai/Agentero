//! papers table CRUD. Catalog is the authority for paper metadata.
//! `metadata.json` is a projection written after SQLite upsert.

use super::schema::ensure_catalog;
use crate::core::error::AppError;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

/// Apple system color–inspired tag color ids (frontend palette).
const TAG_COLOR_IDS: &[&str] = &[
    "red", "orange", "yellow", "green", "teal", "blue", "indigo", "purple",
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
    pub added_at: String,
    pub updated_at: String,
}

/// Upsert paper row, then sync `metadata.json` under the paper folder.
pub fn upsert_paper(vault_root: &Path, record: &PaperRecord) -> Result<PaperRecord, AppError> {
    let conn = ensure_catalog(vault_root)?;
    upsert_conn(&conn, record)?;
    sync_metadata_json(vault_root, record)?;
    Ok(record.clone())
}

pub fn get_by_path(vault_root: &Path, path: &str) -> Result<Option<PaperRecord>, AppError> {
    let conn = ensure_catalog(vault_root)?;
    let path = path.replace('\\', "/").trim_matches('/').to_string();
    get_conn(&conn, &path)
}

/// First paper with the given logical `id` (ordered by path). For ambiguity, use [`list_by_id`].
pub fn get_by_id(vault_root: &Path, id: &str) -> Result<Option<PaperRecord>, AppError> {
    Ok(list_by_id(vault_root, id)?.into_iter().next())
}

/// All catalog rows with the given logical `id` (may be multiple paths).
pub fn list_by_id(vault_root: &Path, id: &str) -> Result<Vec<PaperRecord>, AppError> {
    let conn = ensure_catalog(vault_root)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT
                path, id, type, title, authors_json, year, abstract, tags_json,
                arxiv_id, doi, pdf_url, html_url, source_url,
                body_source, body_quality, bibtex_key, citation_count, status, summary,
                added_at, updated_at,
                creators_json, date, isbn, issn, pmid, publication, volume, issue, pages,
                publisher, place, series, language, zotero_item_type, meta_source, extra,
                is_read
            FROM papers
            WHERE id = ?1
            ORDER BY path ASC
            "#,
        )
        .map_err(AppError::from)?;

    let rows = stmt
        .query_map(params![id], map_row)
        .map_err(AppError::from)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppError::from)?;
    Ok(rows)
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
    let conn = ensure_catalog(vault_root)?;
    let sql = format!(
        r#"
        SELECT
            path, id, type, title, authors_json, year, abstract, tags_json,
            arxiv_id, doi, pdf_url, html_url, source_url,
            body_source, body_quality, bibtex_key, citation_count, status, summary,
            added_at, updated_at,
            creators_json, date, isbn, issn, pmid, publication, volume, issue, pages,
            publisher, place, series, language, zotero_item_type, meta_source, extra,
            is_read
        FROM papers
        WHERE {column} = ?1
        ORDER BY path ASC
        LIMIT 1
        "#
    );
    let mut stmt = conn.prepare(&sql).map_err(AppError::from)?;
    let row = stmt
        .query_row(params![value], map_row)
        .optional()
        .map_err(AppError::from)?;
    Ok(row)
}

/// List all papers for library table (newest first).
pub fn list_all(vault_root: &Path) -> Result<Vec<PaperRecord>, AppError> {
    let conn = ensure_catalog(vault_root)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT
                path, id, type, title, authors_json, year, abstract, tags_json,
                arxiv_id, doi, pdf_url, html_url, source_url,
                body_source, body_quality, bibtex_key, citation_count, status, summary,
                added_at, updated_at,
                creators_json, date, isbn, issn, pmid, publication, volume, issue, pages,
                publisher, place, series, language, zotero_item_type, meta_source, extra,
                is_read
            FROM papers
            ORDER BY updated_at DESC, title COLLATE NOCASE ASC
            "#,
        )
        .map_err(AppError::from)?;

    let rows = stmt
        .query_map([], map_row)
        .map_err(AppError::from)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppError::from)?;
    Ok(rows)
}

/// Rebuild missing catalog rows by scanning `papers/` on disk and re-importing
/// each folder's `metadata.json` (the projection). Idempotent — existing rows
/// are refreshed and disk-only papers are re-added. Returns the count imported.
pub fn rebuild_from_disk(vault_root: &Path) -> Result<usize, AppError> {
    let papers_dir = vault_root.join("papers");
    if !papers_dir.is_dir() {
        return Ok(0);
    }
    let conn = ensure_catalog(vault_root)?;
    let mut count = 0usize;
    let mut stack = vec![papers_dir];
    while let Some(dir) = stack.pop() {
        if dir.join("metadata.json").is_file() {
            // A paper folder is a leaf: re-import it and do not descend.
            if let Some(mut record) = record_from_metadata(vault_root, &dir) {
                // When body_source is unknown, scan the local folder for TeX files
                // so papers with TeX in lazy‑loaded source/ don't show a false
                // "download TeX" indicator in the frontend.
                if record.body_source.is_none() && has_local_tex_in_tree(&dir) {
                    record.body_source = Some("latex".to_string());
                    if record.body_quality.is_none() {
                        record.body_quality = Some("high".to_string());
                    }
                }
                if upsert_conn(&conn, &record).is_ok() {
                    count += 1;
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
}

/// True when a paper folder (or its source/ subdirectory) contains at least one
/// .tex or .ltx file. Scans the filesystem directly, so it works for lazy‑loaded
/// directories that the file tree skips.
fn has_local_tex_in_tree(dir: &Path) -> bool {
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        if !current.is_dir() {
            continue;
        }
        if let Ok(entries) = fs::read_dir(&current) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    if stack.len() < 64 {
                        stack.push(path);
                    }
                } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    let lower = ext.to_ascii_lowercase();
                    if lower == "tex" || lower == "ltx" {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// Read a paper folder's `metadata.json`, re-injecting the folder path (which
/// the projection omits) so it deserializes into a full [`PaperRecord`].
fn record_from_metadata(vault_root: &Path, dir: &Path) -> Option<PaperRecord> {
    let rel = dir
        .strip_prefix(vault_root)
        .ok()?
        .to_str()?
        .replace('\\', "/")
        .trim_matches('/')
        .to_string();
    if rel.is_empty() {
        return None;
    }
    let raw = fs::read_to_string(dir.join("metadata.json")).ok()?;
    let mut val: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let obj = val.as_object_mut()?;
    obj.insert("path".to_string(), serde_json::Value::String(rel));
    serde_json::from_value::<PaperRecord>(val).ok()
}

/// Set `is_read` for a paper path; returns the updated row.
pub fn set_is_read(vault_root: &Path, path: &str, is_read: bool) -> Result<PaperRecord, AppError> {
    let path = path.replace('\\', "/").trim_matches('/').to_string();
    let Some(mut row) = get_by_path(vault_root, &path)? else {
        return Err(AppError::message("paper not found in catalog"));
    };
    row.is_read = is_read;
    row.updated_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
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
    row.updated_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
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
    row.updated_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
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
    row.updated_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
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
    let conn = ensure_catalog(vault_root)?;
    let path = path.replace('\\', "/").trim_matches('/').to_string();
    if path.is_empty() {
        return Ok(Vec::new());
    }
    let like = format!("{path}/%");
    let mut stmt = conn
        .prepare(
            r#"
            SELECT
                path, id, type, title, authors_json, year, abstract, tags_json,
                arxiv_id, doi, pdf_url, html_url, source_url,
                body_source, body_quality, bibtex_key, citation_count, status, summary,
                added_at, updated_at,
                creators_json, date, isbn, issn, pmid, publication, volume, issue, pages,
                publisher, place, series, language, zotero_item_type, meta_source, extra,
                is_read
            FROM papers
            WHERE path = ?1 OR path LIKE ?2
            ORDER BY path ASC
            "#,
        )
        .map_err(AppError::from)?;
    let rows = stmt
        .query_map(params![path, like], map_row)
        .map_err(AppError::from)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppError::from)?;
    Ok(rows)
}

/// Delete a paper row and any papers nested under `path/` (org folder delete).
/// Returns the number of catalog rows removed.
pub fn delete_under_path(vault_root: &Path, path: &str) -> Result<usize, AppError> {
    let conn = ensure_catalog(vault_root)?;
    let path = path.replace('\\', "/").trim_matches('/').to_string();
    if path.is_empty() {
        return Err(AppError::message("path is required"));
    }
    let like = format!("{path}/%");
    let n = conn
        .execute(
            "DELETE FROM papers WHERE path = ?1 OR path LIKE ?2",
            params![path, like],
        )
        .map_err(AppError::from)?;
    Ok(n)
}

/// Move a paper folder (and any papers nested under it) in the catalog by
/// rewriting the `from` path prefix to `to`. Returns the number of rows updated.
pub fn move_under_path(vault_root: &Path, from: &str, to: &str) -> Result<usize, AppError> {
    let conn = ensure_catalog(vault_root)?;
    let from = from.replace('\\', "/").trim_matches('/').to_string();
    let to = to.replace('\\', "/").trim_matches('/').to_string();
    if from.is_empty() || to.is_empty() {
        return Err(AppError::message("from and to are required"));
    }
    let like = format!("{from}/%");
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    // Exact row -> `to`; nested rows -> `to` + the suffix after `from`.
    // substr uses a 1-based CHARACTER index so non-ASCII folder names are safe.
    let offset = from.chars().count() as i64 + 1;
    let n = conn
        .execute(
            "UPDATE papers SET path = ?1 || substr(path, ?2), updated_at = ?3 \
             WHERE path = ?4 OR path LIKE ?5",
            params![to, offset, now, from, like],
        )
        .map_err(AppError::from)?;
    Ok(n)
}

/// Remove catalog rows whose paper folder no longer exists on disk (orphans left
/// by deleting folders outside the app). Returns the number of rows removed.
pub fn prune_missing(vault_root: &Path) -> Result<usize, AppError> {
    let conn = ensure_catalog(vault_root)?;
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
}

fn upsert_conn(conn: &Connection, r: &PaperRecord) -> Result<(), AppError> {
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
        r#"
        INSERT INTO papers (
            path, id, type, title, authors_json, year, abstract, tags_json,
            arxiv_id, doi, pdf_url, html_url, source_url,
            body_source, body_quality, bibtex_key, citation_count, status, summary,
            added_at, updated_at,
            creators_json, date, isbn, issn, pmid, publication, volume, issue, pages,
            publisher, place, series, language, zotero_item_type, meta_source, extra,
            is_read
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
            ?9, ?10, ?11, ?12, ?13,
            ?14, ?15, ?16, ?17, ?18, ?19,
            ?20, ?21,
            ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30,
            ?31, ?32, ?33, ?34, ?35, ?36, ?37,
            ?38
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
            is_read = excluded.is_read
        "#,
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
        ],
    )
    .map_err(AppError::from)?;
    Ok(())
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PaperRecord> {
    let authors_json: String = row.get(4)?;
    let tags_json: String = row.get(7)?;
    let creators_json: Option<String> = row.get(21)?;
    let is_read_i: i32 = row.get(37).unwrap_or(0);
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
    })
}

fn get_conn(conn: &Connection, path: &str) -> Result<Option<PaperRecord>, AppError> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT
                path, id, type, title, authors_json, year, abstract, tags_json,
                arxiv_id, doi, pdf_url, html_url, source_url,
                body_source, body_quality, bibtex_key, citation_count, status, summary,
                added_at, updated_at,
                creators_json, date, isbn, issn, pmid, publication, volume, issue, pages,
                publisher, place, series, language, zotero_item_type, meta_source, extra,
                is_read
            FROM papers WHERE path = ?1
            "#,
        )
        .map_err(AppError::from)?;

    let row = stmt
        .query_row(params![path], map_row)
        .optional()
        .map_err(AppError::from)?;

    Ok(row)
}

/// Projection: write metadata.json next to NOTES after catalog change.
pub fn sync_metadata_json(vault_root: &Path, record: &PaperRecord) -> Result<(), AppError> {
    let paper_dir = vault_root.join(&record.path);
    if !paper_dir.exists() {
        fs::create_dir_all(&paper_dir)?;
    }
    // Omit vault-relative path from file copy (folder identity is the path itself)
    let mut file_copy =
        serde_json::to_value(record).map_err(|e| AppError::message(e.to_string()))?;
    if let Some(obj) = file_copy.as_object_mut() {
        obj.remove("path");
    }
    let json =
        serde_json::to_string_pretty(&file_copy).map_err(|e| AppError::message(e.to_string()))?;
    fs::write(paper_dir.join("metadata.json"), format!("{json}\n"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
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
            added_at: "t".into(),
            updated_at: "t".into(),
        };
        assert!(paper_has_all_tags(&p, &["nlp".into(), "RL".into()]));
        assert!(!paper_has_all_tags(&p, &["nlp".into(), "cv".into()]));
        p.tags.clear();
        assert!(paper_has_all_tags(&p, &[]));
    }

    #[test]
    fn rebuild_from_disk_reimports_metadata() {
        let dir = env::temp_dir().join(format!("agentero-rescan-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("papers").join("x")).unwrap();
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
            added_at: "t".into(),
            updated_at: "t".into(),
        };
        // upsert writes both the catalog row and metadata.json.
        upsert_paper(&dir, &record).unwrap();
        // Simulate a lost catalog row (folder + metadata.json stay on disk).
        delete_under_path(&dir, "papers/x").unwrap();
        assert!(get_by_path(&dir, "papers/x").unwrap().is_none());

        // Rescan re-imports it from metadata.json.
        assert_eq!(rebuild_from_disk(&dir).unwrap(), 1);
        let row = get_by_path(&dir, "papers/x").unwrap().unwrap();
        assert_eq!(row.title, "Attention");
        assert_eq!(row.year, Some(2017));

        let _ = fs::remove_dir_all(&dir);
    }
}
