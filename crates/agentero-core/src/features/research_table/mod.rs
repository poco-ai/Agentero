//! Row operations for `*.table.json`.
//!
//! The desktop grid keeps editing the file through `src/lib/research-table/model.ts`.
//! These functions are the agent/CLI path: same schema, revision compare-and-swap,
//! no SQLite index.

pub mod lookup;

mod model;

use model::{
    encode_table, find_field, normalize_input, parse_table, record_key, shown_prefix,
    shown_sequence, update_cells as apply_cells, upsert_rows, values_by_name, CellEdit, Table,
    UpsertRow,
};
use serde::Serialize;
use serde_json::{Map, Value};
use std::io;
use std::path::{Path, PathBuf};

/// Read cap for row operations. Intentionally above the 2 MiB `file_read` limit.
pub const MAX_TABLE_BYTES: u64 = 32 * 1024 * 1024;

/// Stable failure for a research-table row operation.
///
/// `stable_code()` is the wire code. Its display text is that same code, except
/// for `io`, which displays the filesystem error. `revision` is set only for
/// `revision_conflict`.
#[derive(Debug)]
pub struct TableError {
    code: &'static str,
    revision: Option<u64>,
    source: Option<io::Error>,
}

impl TableError {
    pub fn new(code: &'static str) -> Self {
        Self {
            code,
            revision: None,
            source: None,
        }
    }

    pub(crate) fn conflict(revision: u64) -> Self {
        Self {
            code: "revision_conflict",
            revision: Some(revision),
            source: None,
        }
    }

    fn io(err: io::Error) -> Self {
        Self {
            code: "io",
            revision: None,
            source: Some(err),
        }
    }

    pub fn stable_code(&self) -> &'static str {
        self.code
    }

    pub fn revision(&self) -> Option<u64> {
        self.revision
    }
}

impl std::fmt::Display for TableError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Some(err) = &self.source {
            write!(f, "{err}")
        } else {
            f.write_str(self.code)
        }
    }
}

impl std::error::Error for TableError {}

#[derive(Debug, Clone, Default)]
pub struct QueryFilter {
    pub registry_id: Option<String>,
    /// Field name. Set together with [`QueryFilter::equals`].
    pub field: Option<String>,
    /// Comparison value. JSON null matches an empty cell. `None` means the
    /// caller did not send `equals`.
    pub equals: Option<Value>,
    pub include_archived: bool,
    /// Default 50, clamped to 1..=200.
    pub limit: Option<i64>,
    /// Default 0. Negative is `invalid_table`.
    pub offset: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct CellUpdate {
    pub registry_id: String,
    pub field: String,
    pub value: Value,
}

#[derive(Debug, Clone)]
pub struct RowInput {
    pub registry_id: Option<String>,
    pub values: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueryFieldOut {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub field_type: String,
    pub unit: String,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueryRowOut {
    pub id: String,
    pub registry_id: Option<String>,
    pub archived: bool,
    pub values: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueryOut {
    pub revision: u64,
    pub id: String,
    pub name: String,
    pub id_prefix: String,
    pub next_sequence: u64,
    pub fields: Vec<QueryFieldOut>,
    pub match_count: u64,
    pub truncated: bool,
    pub rows: Vec<QueryRowOut>,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AffectedRow {
    pub id: String,
    pub registry_id: Option<String>,
    pub archived: bool,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MutationOut {
    pub revision: u64,
    pub replayed: bool,
    pub id: String,
    pub name: String,
    pub id_prefix: String,
    pub next_sequence: u64,
    pub rows: Vec<AffectedRow>,
}

/// Accept a document that [`parse_table`](crate::features::research_table) would keep.
/// Used by `file_write` when creating a missing `*.table.json`.
pub fn validate_table_json(source: &str) -> Result<(), TableError> {
    parse_table(source).map(|_| ())
}

/// Read matching rows in stored order. Does not write.
pub fn query(vault: &Path, path: &str, filter: &QueryFilter) -> Result<QueryOut, TableError> {
    let (_rel, _path, table, _bytes) = open_table(vault, path)?;
    query_table(&table, filter)
}

pub fn update_cells(
    vault: &Path,
    path: &str,
    expected_revision: u64,
    cells: &[CellUpdate],
    idempotency_key: Option<&str>,
    include_archived: bool,
) -> Result<MutationOut, TableError> {
    mutate(vault, path, expected_revision, idempotency_key, |table| {
        let edits = cells
            .iter()
            .map(|cell| CellEdit {
                registry_id: cell.registry_id.clone(),
                field: cell.field.clone(),
                value: cell.value.clone(),
            })
            .collect::<Vec<_>>();
        apply_cells(
            table,
            &edits,
            include_archived,
            &crate::time::now_rfc3339_millis(),
        )
    })
}

pub fn upsert(
    vault: &Path,
    path: &str,
    expected_revision: u64,
    rows: &[RowInput],
    idempotency_key: Option<&str>,
    include_archived: bool,
) -> Result<MutationOut, TableError> {
    mutate(vault, path, expected_revision, idempotency_key, |table| {
        let inputs = rows
            .iter()
            .map(|row| UpsertRow {
                registry_id: row.registry_id.clone(),
                values: row.values.clone(),
            })
            .collect::<Vec<_>>();
        upsert_rows(
            table,
            &inputs,
            include_archived,
            &crate::time::now_rfc3339_millis(),
        )
    })
}

fn query_table(table: &Table, filter: &QueryFilter) -> Result<QueryOut, TableError> {
    if filter.field.is_some() != filter.equals.is_some() {
        return Err(TableError::new("invalid_table"));
    }
    let limit = clamp_limit(filter.limit);
    let offset = match filter.offset.unwrap_or(0) {
        value if value < 0 => return Err(TableError::new("invalid_table")),
        value => value as usize,
    };
    let wanted = match (filter.field.as_deref(), filter.equals.as_ref()) {
        (Some(name), Some(equals)) => {
            let field = find_field(table, name)?;
            Some((field.id.clone(), normalize_input(field, equals)?))
        }
        _ => None,
    };
    let mut matched = Vec::new();
    for (index, row) in table.rows.iter().enumerate() {
        if row.archived_at.is_some() && !filter.include_archived {
            continue;
        }
        if let Some(id) = filter.registry_id.as_deref() {
            if row.registry_id.as_deref() != Some(id) {
                continue;
            }
        }
        if let Some((field_id, equals)) = &wanted {
            let stored = row.values.get(field_id);
            let empty = stored.is_none() || stored.is_some_and(Value::is_null);
            let same = if equals.is_null() {
                empty
            } else {
                stored.is_some_and(|value| values_match(value, equals))
            };
            if !same {
                continue;
            }
        }
        matched.push(index);
    }
    let match_count = matched.len() as u64;
    let page: Vec<_> = matched.into_iter().skip(offset).take(limit).collect();
    let truncated = (offset + page.len()) < match_count as usize;
    let rows = page
        .into_iter()
        .map(|index| {
            let row = &table.rows[index];
            QueryRowOut {
                id: row.id.clone(),
                registry_id: row.registry_id.clone(),
                archived: row.archived_at.is_some(),
                values: values_by_name(table, row),
            }
        })
        .collect();
    Ok(QueryOut {
        revision: table.revision,
        id: table.id.clone(),
        name: table.name.clone(),
        id_prefix: shown_prefix(table),
        next_sequence: shown_sequence(table),
        fields: table
            .fields
            .iter()
            .map(|field| QueryFieldOut {
                id: field.id.clone(),
                name: field.name.clone(),
                field_type: field_type_name(field),
                unit: field.unit.clone(),
            })
            .collect(),
        match_count,
        truncated,
        rows,
    })
}

fn values_match(stored: &Value, wanted: &Value) -> bool {
    match (stored, wanted) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(left), Value::Bool(right)) => left == right,
        (Value::String(left), Value::String(right)) => left == right,
        (Value::Number(left), Value::Number(right)) => match (left.as_f64(), right.as_f64()) {
            (Some(left), Some(right)) => left == right,
            _ => left.to_string() == right.to_string(),
        },
        _ => false,
    }
}

fn field_type_name(field: &model::Field) -> String {
    match field.type_ {
        model::FieldType::Text => "text",
        model::FieldType::Number => "number",
        model::FieldType::Boolean => "boolean",
        model::FieldType::Date => "date",
        model::FieldType::Select => "select",
        model::FieldType::Link => "link",
    }
    .to_string()
}

fn clamp_limit(limit: Option<i64>) -> usize {
    let value = limit.unwrap_or(50);
    if value < 1 {
        1
    } else if value > 200 {
        200
    } else {
        value as usize
    }
}

fn mutate(
    vault: &Path,
    path: &str,
    expected_revision: u64,
    idempotency_key: Option<&str>,
    op: impl FnOnce(&mut Table) -> Result<Vec<model::Affected>, TableError>,
) -> Result<MutationOut, TableError> {
    let (_rel, file, mut table, original) = open_table(vault, path)?;
    if let Some(key) = idempotency_key {
        model::check_idempotency_key(key)?;
        if table.applied_keys.iter().any(|existing| existing == key) {
            return Ok(mutation_out(&table, true, Vec::new()));
        }
    }
    if table.revision != expected_revision {
        return Err(TableError::conflict(table.revision));
    }
    let affected = op(&mut table)?;
    if let Some(key) = idempotency_key {
        record_key(&mut table.applied_keys, key);
    }
    if table.revision == u64::MAX {
        return Err(TableError::new("invalid_table"));
    }
    table.revision += 1;
    commit(&file, &original, &table)?;
    Ok(mutation_out(
        &table,
        false,
        affected
            .into_iter()
            .map(|row| AffectedRow {
                id: row.id,
                registry_id: row.registry_id,
                archived: row.archived,
            })
            .collect(),
    ))
}

fn mutation_out(table: &Table, replayed: bool, rows: Vec<AffectedRow>) -> MutationOut {
    MutationOut {
        revision: table.revision,
        replayed,
        id: table.id.clone(),
        name: table.name.clone(),
        id_prefix: shown_prefix(table),
        next_sequence: shown_sequence(table),
        rows,
    }
}

fn commit(path: &Path, original: &[u8], table: &Table) -> Result<(), TableError> {
    let current = std::fs::read(path).map_err(TableError::io)?;
    if current != original {
        let revision = std::str::from_utf8(&current)
            .ok()
            .and_then(|text| parse_table(text).ok())
            .map(|table| table.revision);
        return Err(match revision {
            Some(revision) => TableError::conflict(revision),
            None => TableError::new("revision_conflict"),
        });
    }
    atomic_write_table(path, table)
}

fn atomic_write_table(path: &Path, table: &Table) -> Result<(), TableError> {
    let bytes = encode_table(table)?;
    crate::fs::atomic_write(path, &bytes).map_err(TableError::io)
}

fn open_table(vault: &Path, rel: &str) -> Result<(String, PathBuf, Table, Vec<u8>), TableError> {
    let rel = table_rel(rel)?;
    let root = canonical_root(vault)?;
    let candidate = root.join(&rel);
    if !candidate.exists() {
        return Err(TableError::new("not_found"));
    }
    let resolved = candidate.canonicalize().map_err(TableError::io)?;
    if !resolved.starts_with(&root) || !resolved.is_file() {
        return Err(TableError::new("invalid_table"));
    }
    let bytes = read_limited(&resolved)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| TableError::new("invalid_table"))?;
    if text.contains('\0') {
        return Err(TableError::new("invalid_table"));
    }
    let table = parse_table(text)?;
    Ok((rel, resolved, table, bytes))
}

fn read_limited(path: &Path) -> Result<Vec<u8>, TableError> {
    let meta = std::fs::metadata(path).map_err(TableError::io)?;
    if meta.len() > MAX_TABLE_BYTES {
        return Err(TableError::new("invalid_table"));
    }
    let bytes = std::fs::read(path).map_err(TableError::io)?;
    if bytes.len() as u64 > MAX_TABLE_BYTES {
        return Err(TableError::new("invalid_table"));
    }
    Ok(bytes)
}

fn table_rel(raw: &str) -> Result<String, TableError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(TableError::new("invalid_table"));
    }
    let slashed = trimmed.replace('\\', "/");
    if slashed.starts_with('/') || Path::new(trimmed).is_absolute() {
        return Err(TableError::new("invalid_table"));
    }
    let rel =
        crate::fs::sanitize_vault_rel(trimmed).map_err(|_| TableError::new("invalid_table"))?;
    if !rel.to_ascii_lowercase().ends_with(".table.json") {
        return Err(TableError::new("invalid_table"));
    }
    Ok(rel)
}

fn canonical_root(vault: &Path) -> Result<PathBuf, TableError> {
    if !vault.is_dir() {
        return Err(TableError::io(io::Error::new(
            io::ErrorKind::NotFound,
            "vault path is not a directory",
        )));
    }
    vault.canonicalize().map_err(TableError::io)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> &'static str {
        r#"{
  "format": "agentero-table",
  "version": 1,
  "id": "t1",
  "name": " Measurements ",
  "kind": "result",
  "revision": 3,
  "idPrefix": "EXP",
  "nextSequence": 3,
  "fields": [
    {"id":"sample","name":"Sample","type":"text","unit":"","options":[]},
    {"id":"capacity","name":"Capacity","type":"number","unit":"mAh","options":[]},
    {"id":"ok","name":"Ok","type":"boolean","unit":"","options":[]},
    {"id":"when","name":"When","type":"date","unit":"","options":[]},
    {"id":"grade","name":"Grade","type":"select","unit":"","options":["low","high"]},
    {"id":"link","name":"Link","type":"link","unit":"","options":[],"target":"other/cells.table.json"}
  ],
  "rows": [
    {
      "id": "r1",
      "registryId": "EXP-0001",
      "createdAt": "2026-11-07T00:00:00.000Z",
      "updatedAt": "2026-11-07T00:00:00.000Z",
      "actor": "human",
      "values": {"sample":"A","capacity":1}
    },
    {
      "id": "r2",
      "registryId": "EXP-0002",
      "archivedAt": "2026-11-07T01:00:00.000Z",
      "values": {"sample":"old","capacity":null}
    }
  ]
}"#
    }

    fn write_sample(dir: &Path) -> PathBuf {
        let path = dir.join("data").join("run.table.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, sample()).unwrap();
        path
    }

    #[test]
    fn parse_rejects_unknown_keys_and_bad_cells() {
        let table = parse_table(sample()).unwrap();
        assert_eq!(table.name, "Measurements");
        assert!(parse_table(&sample().replace("\"kind\"", "\"kind\",\"extra\":1")).is_err());
        assert!(parse_table(&sample().replace("\"version\": 1", "\"version\": 2")).is_err());
        assert!(parse_table(&sample().replace("\"capacity\":1", "\"capacity\":\"0x10\"")).is_err());
        assert!(parse_table(&sample().replace("cells.table.json", "../x.table.json")).is_err());
        assert!(parse_table(&sample().replace(
            "\"target\":\"other/cells.table.json\"",
            "\"target\":\"other/cells.table.json\",\"nope\":1"
        ))
        .is_err());
        let mut dup = sample().replace("\"name\":\"Capacity\"", "\"name\":\"sample\"");
        dup = dup.replace("\"name\":\"sample\"", "\"name\":\"Sample\"");
        // Two fields folding together is invalid even when the file is otherwise shaped.
        let folded = sample().replace("\"name\":\"Capacity\"", "\"name\":\"sample\"");
        assert_eq!(
            parse_table(&folded).unwrap_err().stable_code(),
            "invalid_table"
        );
        let _ = dup;
    }

    #[test]
    fn writer_omits_empty_optionals_and_round_trips() {
        let mut table = parse_table(sample()).unwrap();
        table.schema_path = None;
        table.applied_keys.clear();
        table.rows[0].actor = Some("agent".into());
        let bytes = encode_table(&table).unwrap();
        let text = String::from_utf8(bytes.clone()).unwrap();
        assert!(text.ends_with('\n'));
        assert!(!text.contains("appliedKeys"));
        assert!(!text.contains("schemaPath"));
        assert!(text.contains("\"unit\": \"\""));
        assert!(text.contains("\"options\": []"));
        assert!(text.contains("\"actor\": \"agent\""));
        assert!(text.contains("2026-11-07T00:00:00.000Z"));
        let again = parse_table(&text).unwrap();
        assert_eq!(again.rows[0].registry_id.as_deref(), Some("EXP-0001"));
        assert!(again.applied_keys.is_empty());
    }

    #[test]
    fn query_skips_archived_rows_and_matches_field_names() {
        let dir = tempfile::tempdir().unwrap();
        write_sample(dir.path());
        let out = query(
            dir.path(),
            "data/run.table.json",
            &QueryFilter {
                field: Some("sample".into()),
                equals: Some(json!("A")),
                ..QueryFilter::default()
            },
        )
        .unwrap();
        assert_eq!(out.revision, 3);
        assert_eq!(out.id_prefix, "EXP");
        assert_eq!(out.match_count, 1);
        assert!(!out.truncated);
        assert_eq!(out.rows[0].registry_id.as_deref(), Some("EXP-0001"));
        assert_eq!(
            out.rows[0].values.get("Sample").and_then(Value::as_str),
            Some("A")
        );
        assert_eq!(out.rows[0].values.get("Capacity"), Some(&json!(1)));
        assert!(!out.rows[0].archived);
        assert!(out
            .fields
            .iter()
            .any(|field| field.name == "Capacity" && field.unit == "mAh"));

        let all = query(
            dir.path(),
            "data/run.table.json",
            &QueryFilter {
                include_archived: true,
                ..QueryFilter::default()
            },
        )
        .unwrap();
        assert_eq!(all.match_count, 2);
        assert!(all.rows[1].archived);
    }

    #[test]
    fn update_is_atomic_and_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_sample(dir.path());
        let before = std::fs::read(&path).unwrap();
        let conflict = update_cells(
            dir.path(),
            "data/run.table.json",
            1,
            &[CellUpdate {
                registry_id: "EXP-0001".into(),
                field: "Capacity".into(),
                value: json!(2.5),
            }],
            None,
            false,
        )
        .unwrap_err();
        assert_eq!(conflict.stable_code(), "revision_conflict");
        assert_eq!(conflict.revision(), Some(3));
        assert_eq!(std::fs::read(&path).unwrap(), before);

        let archived = update_cells(
            dir.path(),
            "data/run.table.json",
            3,
            &[CellUpdate {
                registry_id: "EXP-0002".into(),
                field: "Sample".into(),
                value: json!("nope"),
            }],
            None,
            false,
        )
        .unwrap_err();
        assert_eq!(archived.stable_code(), "archived");
        assert_eq!(std::fs::read(&path).unwrap(), before);

        let hex = update_cells(
            dir.path(),
            "data/run.table.json",
            3,
            &[CellUpdate {
                registry_id: "EXP-0001".into(),
                field: "Capacity".into(),
                value: json!("0x10"),
            }],
            Some("bad"),
            false,
        )
        .unwrap_err();
        assert_eq!(hex.stable_code(), "invalid_cell");
        assert_eq!(std::fs::read(&path).unwrap(), before);

        let updated = update_cells(
            dir.path(),
            "data/run.table.json",
            3,
            &[CellUpdate {
                registry_id: "EXP-0001".into(),
                field: "Capacity".into(),
                value: json!("2.5"),
            }],
            Some("batch-1"),
            false,
        )
        .unwrap();
        assert!(!updated.replayed);
        assert_eq!(updated.revision, 4);
        assert_eq!(updated.rows[0].registry_id.as_deref(), Some("EXP-0001"));
        let text = std::fs::read_to_string(&path).unwrap();
        let stored = parse_table(&text).unwrap();
        assert_eq!(stored.revision, 4);
        assert_eq!(stored.rows[0].values.get("capacity"), Some(&json!(2.5)));
        assert_eq!(stored.rows[0].actor.as_deref(), Some("agent"));
        assert!(stored.rows[0].updated_at.as_deref().unwrap().ends_with('Z'));
        assert!(stored.rows[0].updated_at.as_deref().unwrap().contains('.'));
        assert_eq!(
            stored.rows[1].values.get("sample").and_then(Value::as_str),
            Some("old")
        );
        assert_eq!(stored.applied_keys, vec!["batch-1".to_string()]);

        let replay = update_cells(
            dir.path(),
            "data/run.table.json",
            99,
            &[CellUpdate {
                registry_id: "EXP-0001".into(),
                field: "Capacity".into(),
                value: json!(9),
            }],
            Some("batch-1"),
            false,
        )
        .unwrap();
        assert!(replay.replayed);
        assert_eq!(replay.revision, 4);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);

        let unknown = update_cells(
            dir.path(),
            "data/run.table.json",
            4,
            &[
                CellUpdate {
                    registry_id: "EXP-0001".into(),
                    field: "Capacity".into(),
                    value: json!(3),
                },
                CellUpdate {
                    registry_id: "EXP-9999".into(),
                    field: "Capacity".into(),
                    value: json!(3),
                },
            ],
            None,
            false,
        )
        .unwrap_err();
        assert_eq!(unknown.stable_code(), "unknown_row");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
    }

    #[test]
    fn update_cells_keeps_column_width() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_sample(dir.path());
        let widened = std::fs::read_to_string(&path)
            .unwrap()
            .replace(
                r#"{"id":"sample","name":"Sample","type":"text","unit":"","options":[]}"#,
                r#"{"id":"sample","name":"Sample","type":"text","unit":"","options":[],"width":200}"#,
            )
            .replace(
                r#"{"id":"capacity","name":"Capacity","type":"number","unit":"mAh","options":[]}"#,
                r#"{"id":"capacity","name":"Capacity","type":"number","unit":"mAh","options":[],"width":320}"#,
            );
        assert!(parse_table(&widened.replace("\"width\":320", "\"width\":40")).is_err());
        assert!(parse_table(&widened.replace("\"width\":320", "\"width\":481")).is_err());
        std::fs::write(&path, &widened).unwrap();
        let updated = update_cells(
            dir.path(),
            "data/run.table.json",
            3,
            &[CellUpdate {
                registry_id: "EXP-0001".into(),
                field: "Sample".into(),
                value: json!("B"),
            }],
            None,
            false,
        )
        .unwrap();
        assert_eq!(updated.revision, 4);
        let text = std::fs::read_to_string(&path).unwrap();
        let stored = parse_table(&text).unwrap();
        assert_eq!(
            stored
                .fields
                .iter()
                .find(|field| field.id == "sample")
                .unwrap()
                .width,
            Some(200)
        );
        assert_eq!(
            stored
                .fields
                .iter()
                .find(|field| field.id == "capacity")
                .unwrap()
                .width,
            Some(320)
        );
        assert!(stored
            .fields
            .iter()
            .find(|field| field.id == "ok")
            .unwrap()
            .width
            .is_none());
        assert!(text.contains("\"width\": 200"));
        assert!(text.contains("\"width\": 320"));
    }

    #[test]
    fn upsert_issues_ids_and_rejects_duplicates() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_sample(dir.path());
        let before = std::fs::read_to_string(&path).unwrap();
        let dup = upsert(
            dir.path(),
            "data/run.table.json",
            3,
            &[
                RowInput {
                    registry_id: Some("EXP-0009".into()),
                    values: Map::from_iter([("Sample".into(), json!("x"))]),
                },
                RowInput {
                    registry_id: Some("EXP-0009".into()),
                    values: Map::from_iter([("Sample".into(), json!("y"))]),
                },
            ],
            None,
            false,
        )
        .unwrap_err();
        assert_eq!(dup.stable_code(), "invalid_table");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);

        let out = upsert(
            dir.path(),
            "data/run.table.json",
            3,
            &[
                RowInput {
                    registry_id: None,
                    values: Map::from_iter([("Sample".into(), json!("new"))]),
                },
                RowInput {
                    registry_id: Some("EXP-0010".into()),
                    values: Map::from_iter([("Capacity".into(), json!("4"))]),
                },
                RowInput {
                    registry_id: Some("EXP-0001".into()),
                    values: Map::from_iter([("Ok".into(), json!("TRUE"))]),
                },
            ],
            Some("issued"),
            false,
        )
        .unwrap();
        assert_eq!(out.revision, 4);
        assert_eq!(out.next_sequence, 11);
        let ids: Vec<_> = out
            .rows
            .iter()
            .map(|row| row.registry_id.clone().unwrap())
            .collect();
        assert_eq!(ids, vec!["EXP-0003", "EXP-0010", "EXP-0001"]);
        let stored = parse_table(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(stored.next_sequence, Some(11));
        assert_eq!(stored.rows.len(), 4);
        assert_eq!(stored.rows[2].registry_id.as_deref(), Some("EXP-0003"));
        assert_eq!(stored.rows[2].actor.as_deref(), Some("agent"));
        assert_eq!(stored.rows[3].values.get("capacity"), Some(&json!(4)));
        assert_eq!(stored.rows[0].values.get("ok"), Some(&json!(true)));
        assert_eq!(stored.rows[0].actor.as_deref(), Some("agent"));
        assert!(stored.rows[1].actor.is_none());
    }

    #[test]
    fn rejects_escape_paths_and_oversize_files() {
        let dir = tempfile::tempdir().unwrap();
        write_sample(dir.path());
        assert_eq!(
            query(dir.path(), "../run.table.json", &QueryFilter::default())
                .unwrap_err()
                .stable_code(),
            "invalid_table"
        );
        assert_eq!(
            query(dir.path(), "/tmp/run.table.json", &QueryFilter::default())
                .unwrap_err()
                .stable_code(),
            "invalid_table"
        );
        assert_eq!(
            query(dir.path(), "missing.table.json", &QueryFilter::default())
                .unwrap_err()
                .stable_code(),
            "not_found"
        );
        let huge = dir.path().join("huge.table.json");
        let file = std::fs::File::create(&huge).unwrap();
        file.set_len(MAX_TABLE_BYTES + 1).unwrap();
        assert_eq!(
            query(dir.path(), "huge.table.json", &QueryFilter::default())
                .unwrap_err()
                .stable_code(),
            "invalid_table"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_that_leaves_the_vault() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).unwrap();
        std::fs::write(outside.path().join("run.table.json"), sample()).unwrap();
        let err = query(dir.path(), "link/run.table.json", &QueryFilter::default()).unwrap_err();
        assert_eq!(err.stable_code(), "invalid_table");
    }

    #[test]
    fn row_limit_refuses_the_write() {
        let dir = tempfile::tempdir().unwrap();
        let mut table = parse_table(sample()).unwrap();
        table.rows.clear();
        table.next_sequence = Some(1);
        for index in 0..model::MAX_TABLE_ROWS {
            table.rows.push(model::Row {
                id: format!("r{index}"),
                values: Map::new(),
                registry_id: Some(format!("EXP-{index:04}")),
                created_at: None,
                updated_at: None,
                archived_at: None,
                actor: None,
            });
        }
        table.next_sequence = Some((model::MAX_TABLE_ROWS as u64) + 1);
        let path = dir.path().join("full.table.json");
        std::fs::write(&path, encode_table(&table).unwrap()).unwrap();
        let err = upsert(
            dir.path(),
            "full.table.json",
            table.revision,
            &[RowInput {
                registry_id: None,
                values: Map::new(),
            }],
            None,
            false,
        )
        .unwrap_err();
        assert_eq!(err.stable_code(), "row_limit");
        let stored = parse_table(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(stored.rows.len(), model::MAX_TABLE_ROWS);
        assert_eq!(stored.revision, table.revision);
    }

    #[test]
    fn timestamp_matches_javascript_utc_form() {
        assert!(model::valid_timestamp("2026-11-07T00:00:00.000Z"));
        assert!(model::valid_timestamp("2026-11-07T00:00:00Z"));
        assert!(model::valid_timestamp("2026-11-07T00:00:00.1234567890Z"));
        assert!(!model::valid_timestamp("2026-02-30T00:00:00.000Z"));
        assert!(!model::valid_timestamp("2026-11-07T00:00:00+00:00"));
        assert!(crate::time::now_rfc3339_millis().ends_with('Z'));
    }
}
