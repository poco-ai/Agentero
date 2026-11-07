//! In-memory `*.table.json` model.
//!
//! Mirrors `src/lib/research-table/model.ts`: strict keys, the same cell
//! rules, and a writer whose bytes `parseResearchTable` accepts.

use super::TableError;
use serde_json::{Map, Number, Value};

pub(super) const MAX_TABLE_ROWS: usize = 100_000;
pub(super) const MAX_TABLE_FIELDS: usize = 100;
const MAX_OPTIONS: usize = 200;
const MAX_APPLIED_KEYS: usize = 50;
const MAX_NAME_CHARS: usize = 120;
const MAX_UNIT_CHARS: usize = 40;
const MAX_PREFIX_CHARS: usize = 12;
const MAX_KEY_CHARS: usize = 80;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

const TABLE_KEYS: &[&str] = &[
    "format",
    "version",
    "id",
    "name",
    "kind",
    "revision",
    "idPrefix",
    "nextSequence",
    "schemaPath",
    "appliedKeys",
    "fields",
    "rows",
];
const FIELD_KEYS: &[&str] = &["id", "name", "type", "unit", "options", "target", "width"];
const ROW_KEYS: &[&str] = &[
    "id",
    "values",
    "registryId",
    "createdAt",
    "updatedAt",
    "archivedAt",
    "actor",
];
const FORBIDDEN_IDS: &[&str] = &["__proto__", "constructor", "prototype"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum FieldType {
    Text,
    Number,
    Boolean,
    Date,
    Select,
    Link,
}

impl FieldType {
    fn parse(raw: &str) -> Result<Self, TableError> {
        Ok(match raw {
            "text" => Self::Text,
            "number" => Self::Number,
            "boolean" => Self::Boolean,
            "date" => Self::Date,
            "select" => Self::Select,
            "link" => Self::Link,
            _ => return Err(TableError::new("invalid_table")),
        })
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Number => "number",
            Self::Boolean => "boolean",
            Self::Date => "date",
            Self::Select => "select",
            Self::Link => "link",
        }
    }
}

#[derive(Clone, Debug)]
pub(super) struct Field {
    pub id: String,
    pub name: String,
    pub type_: FieldType,
    pub unit: String,
    pub options: Vec<String>,
    pub target: Option<String>,
    pub width: Option<u32>,
}

#[derive(Clone, Debug)]
pub(super) struct Row {
    pub id: String,
    pub values: Map<String, Value>,
    pub registry_id: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub archived_at: Option<String>,
    pub actor: Option<String>,
}

#[derive(Clone, Debug)]
pub(super) struct Table {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub revision: u64,
    pub id_prefix: Option<String>,
    pub next_sequence: Option<u64>,
    pub schema_path: Option<String>,
    pub applied_keys: Vec<String>,
    pub fields: Vec<Field>,
    pub rows: Vec<Row>,
}

pub(super) struct CellEdit {
    pub registry_id: String,
    pub field: String,
    pub value: Value,
}

pub(super) struct UpsertRow {
    pub registry_id: Option<String>,
    pub values: Map<String, Value>,
}

#[derive(Clone)]
pub(super) struct Affected {
    pub id: String,
    pub registry_id: Option<String>,
    pub archived: bool,
}

pub(super) fn parse_table(source: &str) -> Result<Table, TableError> {
    let value: Value =
        serde_json::from_str(source).map_err(|_| TableError::new("invalid_table"))?;
    let obj = value
        .as_object()
        .ok_or_else(|| TableError::new("invalid_table"))?;
    reject_unknown(obj, TABLE_KEYS)?;
    if obj.get("format").and_then(Value::as_str) != Some("agentero-table") {
        return Err(TableError::new("invalid_table"));
    }
    if obj.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(TableError::new("invalid_table"));
    }
    let id = required_str(obj, "id")?;
    if id.is_empty() {
        return Err(TableError::new("invalid_table"));
    }
    let name = required_str(obj, "name")?.trim();
    if name.is_empty() {
        return Err(TableError::new("invalid_table"));
    }
    let kind = required_str(obj, "kind")?;
    if kind != "entity" && kind != "result" {
        return Err(TableError::new("invalid_table"));
    }
    let revision = required_u64(obj, "revision")?;
    let id_prefix = optional_prefix(obj)?;
    let next_sequence = optional_positive(obj, "nextSequence")?;
    let schema_path = optional_schema_path(obj)?;
    let applied_keys = optional_keys(obj)?;
    let fields = parse_fields(require(obj, "fields")?)?;
    let rows = parse_rows(require(obj, "rows")?, &fields)?;
    Ok(Table {
        id: id.to_string(),
        name: name.to_string(),
        kind: kind.to_string(),
        revision,
        id_prefix,
        next_sequence,
        schema_path,
        applied_keys,
        fields,
        rows,
    })
}

pub(super) fn encode_table(table: &Table) -> Result<Vec<u8>, TableError> {
    let mut root = Map::new();
    root.insert("format".into(), Value::String("agentero-table".into()));
    root.insert("version".into(), Value::from(1_u64));
    root.insert("id".into(), Value::String(table.id.clone()));
    root.insert("name".into(), Value::String(table.name.clone()));
    root.insert("kind".into(), Value::String(table.kind.clone()));
    root.insert("revision".into(), Value::from(table.revision));
    if let Some(prefix) = &table.id_prefix {
        root.insert("idPrefix".into(), Value::String(prefix.clone()));
    }
    if let Some(next) = table.next_sequence {
        root.insert("nextSequence".into(), Value::from(next));
    }
    if let Some(path) = &table.schema_path {
        root.insert("schemaPath".into(), Value::String(path.clone()));
    }
    if !table.applied_keys.is_empty() {
        root.insert(
            "appliedKeys".into(),
            Value::Array(
                table
                    .applied_keys
                    .iter()
                    .cloned()
                    .map(Value::String)
                    .collect(),
            ),
        );
    }
    root.insert(
        "fields".into(),
        Value::Array(table.fields.iter().map(field_value).collect()),
    );
    root.insert(
        "rows".into(),
        Value::Array(table.rows.iter().map(row_value).collect()),
    );
    let mut bytes = serde_json::to_vec_pretty(&Value::Object(root))
        .map_err(|_| TableError::new("invalid_table"))?;
    if !bytes.ends_with(b"\n") {
        bytes.push(b'\n');
    }
    Ok(bytes)
}

pub(super) fn shown_prefix(table: &Table) -> String {
    table.id_prefix.clone().unwrap_or_else(|| "ID".to_string())
}

pub(super) fn shown_sequence(table: &Table) -> u64 {
    table.next_sequence.unwrap_or(1)
}

pub(super) fn find_field<'a>(table: &'a Table, name: &str) -> Result<&'a Field, TableError> {
    let needle = unicode_lower(name.trim());
    if needle.is_empty() {
        return Err(TableError::new("unknown_field"));
    }
    let mut hits = table
        .fields
        .iter()
        .filter(|field| unicode_lower(&field.name) == needle);
    match (hits.next(), hits.next()) {
        (Some(field), None) => Ok(field),
        (Some(_), Some(_)) => Err(TableError::new("ambiguous_field")),
        (None, _) => Err(TableError::new("unknown_field")),
    }
}

pub(super) fn normalize_input(field: &Field, value: &Value) -> Result<Value, TableError> {
    let next = match value {
        Value::Null => Value::Null,
        Value::String(text) => cell_from_text(text, field)?,
        Value::Bool(bit) => {
            if field.type_ != FieldType::Boolean {
                return Err(TableError::new("invalid_cell"));
            }
            Value::Bool(*bit)
        }
        Value::Number(number) => {
            if field.type_ != FieldType::Number || !number_is_finite(number) {
                return Err(TableError::new("invalid_cell"));
            }
            Value::Number(number.clone())
        }
        _ => return Err(TableError::new("invalid_cell")),
    };
    if !valid_cell(&next, field) {
        return Err(TableError::new("invalid_cell"));
    }
    Ok(next)
}

pub(super) fn check_idempotency_key(key: &str) -> Result<(), TableError> {
    let len = key.chars().count();
    if !(1..=MAX_KEY_CHARS).contains(&len) || key.chars().any(char::is_whitespace) {
        return Err(TableError::new("invalid_table"));
    }
    Ok(())
}

pub(super) fn record_key(keys: &mut Vec<String>, key: &str) {
    keys.push(key.to_string());
    if keys.len() > MAX_APPLIED_KEYS {
        let overflow = keys.len() - MAX_APPLIED_KEYS;
        keys.drain(0..overflow);
    }
}

pub(super) fn update_cells(
    table: &mut Table,
    cells: &[CellEdit],
    include_archived: bool,
    now: &str,
) -> Result<Vec<Affected>, TableError> {
    let mut planned = Vec::with_capacity(cells.len());
    for cell in cells {
        let index = row_index(table, &cell.registry_id)?;
        if table.rows[index].archived_at.is_some() && !include_archived {
            return Err(TableError::new("archived"));
        }
        let field = find_field(table, &cell.field)?;
        let value = normalize_input(field, &cell.value)?;
        planned.push((index, field.id.clone(), value));
    }
    let mut touched = Vec::new();
    for (index, field_id, value) in planned {
        if assign_cell(&mut table.rows[index], &field_id, value, now) && !touched.contains(&index) {
            touched.push(index);
        }
    }
    Ok(affected_at(table, &indexes_in_request(table, cells)))
}

pub(super) fn upsert_rows(
    table: &mut Table,
    rows: &[UpsertRow],
    include_archived: bool,
    now: &str,
) -> Result<Vec<Affected>, TableError> {
    let mut seen = std::collections::HashSet::new();
    for row in rows {
        if let Some(id) = row.registry_id.as_deref() {
            if !seen.insert(id.to_string()) {
                return Err(TableError::new("invalid_table"));
            }
        }
    }
    let mut creating = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        for (name, value) in &row.values {
            let field = find_field(table, name)?;
            normalize_input(field, value)?;
        }
        match row.registry_id.as_deref() {
            Some(id) => match row_index(table, id) {
                Ok(existing) => {
                    if table.rows[existing].archived_at.is_some() && !include_archived {
                        return Err(TableError::new("archived"));
                    }
                }
                Err(_) => {
                    if !is_registry_id(id) {
                        return Err(TableError::new("invalid_table"));
                    }
                    creating.push(index);
                }
            },
            None => creating.push(index),
        }
    }
    if table.rows.len() + creating.len() > MAX_TABLE_ROWS {
        return Err(TableError::new("row_limit"));
    }

    let prefix = shown_prefix(table);
    let mut sequence = issue_start(table, &prefix);
    let reserved: std::collections::HashSet<&str> = creating
        .iter()
        .filter_map(|index| rows[*index].registry_id.as_deref())
        .collect();

    let mut affected = Vec::with_capacity(rows.len());
    let mut created_any = false;
    for row in rows {
        if let Some(id) = row.registry_id.as_deref() {
            if row_index(table, id).is_ok() {
                apply_named(table, id, &row.values, now)?;
                affected.push(snapshot(table, id));
                continue;
            }
        }
        created_any = true;
        let registry = if let Some(id) = row.registry_id.clone() {
            if let Some(used) = used_sequence(&prefix, &id) {
                if used >= sequence {
                    sequence = used.saturating_add(1);
                }
            }
            id
        } else {
            next_free(&prefix, &mut sequence, table, &reserved)?
        };
        let record = new_row(&registry, &row.values, table, now)?;
        let item = Affected {
            id: record.id.clone(),
            registry_id: record.registry_id.clone(),
            archived: false,
        };
        table.rows.push(record);
        affected.push(item);
    }
    if created_any {
        table.id_prefix = Some(prefix);
        table.next_sequence = Some(sequence);
    }
    Ok(affected)
}

fn next_free(
    prefix: &str,
    sequence: &mut u64,
    table: &Table,
    reserved: &std::collections::HashSet<&str>,
) -> Result<String, TableError> {
    for _ in 0..=MAX_TABLE_ROWS {
        let candidate = format_registry(prefix, *sequence);
        let advanced = sequence.saturating_add(1);
        if advanced == *sequence {
            break;
        }
        *sequence = advanced;
        let taken = table
            .rows
            .iter()
            .any(|row| row.registry_id.as_deref() == Some(candidate.as_str()))
            || reserved.contains(candidate.as_str());
        if !taken {
            return Ok(candidate);
        }
    }
    Err(TableError::new("row_limit"))
}

fn apply_named(
    table: &mut Table,
    registry_id: &str,
    values: &Map<String, Value>,
    now: &str,
) -> Result<(), TableError> {
    let index = row_index(table, registry_id)?;
    let mut normalized = Vec::new();
    for (name, value) in values {
        let field = find_field(table, name)?;
        normalized.push((field.id.clone(), normalize_input(field, value)?));
    }
    for (field_id, value) in normalized {
        assign_cell(&mut table.rows[index], &field_id, value, now);
    }
    Ok(())
}

fn new_row(
    registry_id: &str,
    values: &Map<String, Value>,
    table: &Table,
    now: &str,
) -> Result<Row, TableError> {
    let mut stored = Map::new();
    for (name, value) in values {
        let field = find_field(table, name)?;
        let next = normalize_input(field, value)?;
        if !next.is_null() {
            stored.insert(field.id.clone(), next);
        } else {
            stored.insert(field.id.clone(), Value::Null);
        }
    }
    let mut id = uuid::Uuid::new_v4().to_string();
    while table.rows.iter().any(|row| row.id == id) {
        id = uuid::Uuid::new_v4().to_string();
    }
    Ok(Row {
        id,
        values: stored,
        registry_id: Some(registry_id.to_string()),
        created_at: Some(now.to_string()),
        updated_at: Some(now.to_string()),
        archived_at: None,
        actor: Some("agent".into()),
    })
}

fn indexes_in_request(table: &Table, cells: &[CellEdit]) -> Vec<usize> {
    let mut indexes = Vec::new();
    for cell in cells {
        if let Ok(index) = row_index(table, &cell.registry_id) {
            if !indexes.contains(&index) {
                indexes.push(index);
            }
        }
    }
    indexes
}

fn affected_at(table: &Table, indexes: &[usize]) -> Vec<Affected> {
    indexes
        .iter()
        .map(|index| {
            let row = &table.rows[*index];
            Affected {
                id: row.id.clone(),
                registry_id: row.registry_id.clone(),
                archived: row.archived_at.is_some(),
            }
        })
        .collect()
}

fn snapshot(table: &Table, registry_id: &str) -> Affected {
    match table
        .rows
        .iter()
        .find(|row| row.registry_id.as_deref() == Some(registry_id))
    {
        Some(row) => Affected {
            id: row.id.clone(),
            registry_id: row.registry_id.clone(),
            archived: row.archived_at.is_some(),
        },
        None => Affected {
            id: String::new(),
            registry_id: None,
            archived: false,
        },
    }
}

fn assign_cell(row: &mut Row, field_id: &str, value: Value, now: &str) -> bool {
    let unchanged = row
        .values
        .get(field_id)
        .is_some_and(|existing| values_equal(existing, &value));
    if unchanged {
        return false;
    }
    row.values.insert(field_id.to_string(), value);
    row.updated_at = Some(now.to_string());
    row.actor = Some("agent".into());
    true
}

fn values_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(a), Value::Bool(b)) => a == b,
        (Value::String(a), Value::String(b)) => a == b,
        (Value::Number(a), Value::Number(b)) => numbers_equal(a, b),
        _ => false,
    }
}

fn numbers_equal(left: &Number, right: &Number) -> bool {
    match (left.as_f64(), right.as_f64()) {
        (Some(a), Some(b)) => a == b,
        _ => left.to_string() == right.to_string(),
    }
}

fn row_index(table: &Table, registry_id: &str) -> Result<usize, TableError> {
    table
        .rows
        .iter()
        .position(|row| row.registry_id.as_deref() == Some(registry_id))
        .ok_or_else(|| TableError::new("unknown_row"))
}

fn issue_start(table: &Table, prefix: &str) -> u64 {
    let mut next = table.next_sequence.unwrap_or(1).max(1);
    for row in &table.rows {
        let Some(id) = row.registry_id.as_deref() else {
            continue;
        };
        if let Some(used) = used_sequence(prefix, id) {
            if used >= next {
                next = used.saturating_add(1);
            }
        }
    }
    next
}

fn used_sequence(prefix: &str, registry_id: &str) -> Option<u64> {
    let (head, suffix) = registry_id.split_once('-')?;
    if head != prefix || suffix.len() < 4 || !suffix.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let significant = suffix.trim_start_matches('0');
    if significant.len() > 16 {
        return None;
    }
    let value = if significant.is_empty() {
        0
    } else {
        significant.parse().ok()?
    };
    if value > MAX_SAFE_INTEGER {
        return None;
    }
    Some(value)
}

fn format_registry(prefix: &str, sequence: u64) -> String {
    format!("{prefix}-{sequence:04}")
}

fn is_registry_id(value: &str) -> bool {
    let Some((prefix, suffix)) = value.split_once('-') else {
        return false;
    };
    let mut chars = prefix.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_alphabetic()
        && chars.all(|ch| ch.is_ascii_alphanumeric())
        && suffix.len() >= 4
        && suffix.bytes().all(|byte| byte.is_ascii_digit())
}

fn cell_from_text(text: &str, field: &Field) -> Result<Value, TableError> {
    if text.is_empty() {
        return Ok(Value::Null);
    }
    let value = match field.type_ {
        FieldType::Number => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                Value::Null
            } else if is_decimal(trimmed) {
                let number: f64 = trimmed
                    .parse()
                    .map_err(|_| TableError::new("invalid_cell"))?;
                if !number.is_finite() {
                    return Err(TableError::new("invalid_cell"));
                }
                json_number(number)
            } else {
                return Err(TableError::new("invalid_cell"));
            }
        }
        FieldType::Boolean => {
            let trimmed = text.trim();
            if is_bool_token(trimmed, true) {
                Value::Bool(true)
            } else if is_bool_token(trimmed, false) {
                Value::Bool(false)
            } else {
                return Err(TableError::new("invalid_cell"));
            }
        }
        FieldType::Link => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                Value::Null
            } else {
                Value::String(trimmed.to_string())
            }
        }
        FieldType::Text | FieldType::Date | FieldType::Select => Value::String(text.to_string()),
    };
    if !valid_cell(&value, field) {
        return Err(TableError::new("invalid_cell"));
    }
    Ok(value)
}

fn json_number(number: f64) -> Value {
    if number.is_finite() && number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER as f64 {
        Value::Number((number as i64).into())
    } else {
        Value::Number(Number::from_f64(number).expect("finite f64"))
    }
}

fn is_bool_token(text: &str, want_true: bool) -> bool {
    let lower = text.to_ascii_lowercase();
    if want_true {
        lower == "true" || lower == "1"
    } else {
        lower == "false" || lower == "0"
    }
}

fn valid_cell(value: &Value, field: &Field) -> bool {
    if value.is_null() {
        return true;
    }
    match field.type_ {
        FieldType::Text => value.is_string(),
        FieldType::Number => value.as_number().is_some_and(number_is_finite),
        FieldType::Boolean => value.is_boolean(),
        FieldType::Date => value.as_str().is_some_and(valid_date),
        FieldType::Select => value
            .as_str()
            .is_some_and(|text| field.options.iter().any(|option| option == text)),
        FieldType::Link => value.as_str().is_some_and(is_registry_id),
    }
}

fn number_is_finite(number: &Number) -> bool {
    number.as_f64().is_some_and(f64::is_finite)
}

/// `^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$`
fn is_decimal(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let mut index = 0;
    if bytes[index] == b'+' || bytes[index] == b'-' {
        index += 1;
        if index >= bytes.len() {
            return false;
        }
    }
    if bytes[index] == b'.' {
        index += 1;
        let start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        if index == start {
            return false;
        }
    } else {
        let start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        if index == start {
            return false;
        }
        if index < bytes.len() && bytes[index] == b'.' {
            index += 1;
            while index < bytes.len() && bytes[index].is_ascii_digit() {
                index += 1;
            }
        }
    }
    if index < bytes.len() && (bytes[index] == b'e' || bytes[index] == b'E') {
        index += 1;
        if index < bytes.len() && (bytes[index] == b'+' || bytes[index] == b'-') {
            index += 1;
        }
        let start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        if index == start {
            return false;
        }
    }
    index == bytes.len()
}

fn valid_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    if !bytes
        .iter()
        .enumerate()
        .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
    {
        return false;
    }
    let Ok(year) = value[0..4].parse::<i32>() else {
        return false;
    };
    let Ok(month) = value[5..7].parse::<u32>() else {
        return false;
    };
    let Ok(day) = value[8..10].parse::<u32>() else {
        return false;
    };
    chrono::NaiveDate::from_ymd_opt(year, month, day).is_some()
}

pub(super) fn valid_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 20 || bytes[10] != b'T' || !valid_date(&value[..10]) {
        return false;
    }
    let rest = &bytes[11..];
    if rest.len() < 9 || rest[2] != b':' || rest[5] != b':' {
        return false;
    }
    if !rest[..2].iter().all(u8::is_ascii_digit)
        || !rest[3..5].iter().all(u8::is_ascii_digit)
        || !rest[6..8].iter().all(u8::is_ascii_digit)
    {
        return false;
    }
    let hour: u32 = value[11..13].parse().unwrap_or(99);
    let minute: u32 = value[14..16].parse().unwrap_or(99);
    let second: u32 = value[17..19].parse().unwrap_or(99);
    if hour > 23 || minute > 59 || second > 59 {
        return false;
    }
    let tail = &rest[8..];
    if tail == b"Z" {
        return true;
    }
    if tail.first() != Some(&b'.') || tail.last() != Some(&b'Z') || tail.len() < 3 {
        return false;
    }
    tail[1..tail.len() - 1].iter().all(u8::is_ascii_digit)
}

fn unicode_lower(value: &str) -> String {
    value.chars().flat_map(char::to_lowercase).collect()
}

fn parse_fields(value: &Value) -> Result<Vec<Field>, TableError> {
    let items = value
        .as_array()
        .ok_or_else(|| TableError::new("invalid_table"))?;
    if items.is_empty() || items.len() > MAX_TABLE_FIELDS {
        return Err(TableError::new("invalid_table"));
    }
    let mut fields = Vec::with_capacity(items.len());
    for item in items {
        fields.push(parse_field(item)?);
    }
    if fields
        .iter()
        .map(|field| field.id.as_str())
        .collect::<std::collections::HashSet<_>>()
        .len()
        != fields.len()
    {
        return Err(TableError::new("invalid_table"));
    }
    let folded = fields
        .iter()
        .map(|field| unicode_lower(&field.name))
        .collect::<std::collections::HashSet<_>>();
    if folded.len() != fields.len() {
        return Err(TableError::new("invalid_table"));
    }
    Ok(fields)
}

fn parse_field(value: &Value) -> Result<Field, TableError> {
    let obj = value
        .as_object()
        .ok_or_else(|| TableError::new("invalid_table"))?;
    reject_unknown(obj, FIELD_KEYS)?;
    let id = required_str(obj, "id")?;
    if id.is_empty() || FORBIDDEN_IDS.contains(&id) {
        return Err(TableError::new("invalid_table"));
    }
    let name = required_str(obj, "name")?.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return Err(TableError::new("invalid_table"));
    }
    let type_ = FieldType::parse(required_str(obj, "type")?)?;
    let unit = match obj.get("unit") {
        None => String::new(),
        Some(value) => {
            let unit = value
                .as_str()
                .ok_or_else(|| TableError::new("invalid_table"))?;
            if unit.chars().count() > MAX_UNIT_CHARS {
                return Err(TableError::new("invalid_table"));
            }
            unit.to_string()
        }
    };
    let options = match obj.get("options") {
        None => Vec::new(),
        Some(value) => parse_options(value)?,
    };
    let target = match obj.get("target") {
        None => None,
        Some(Value::String(target)) => Some(target.clone()),
        Some(_) => return Err(TableError::new("invalid_table")),
    };
    let width = optional_width(obj)?;
    let field = Field {
        id: id.to_string(),
        name: name.to_string(),
        type_,
        unit,
        options,
        target,
        width,
    };
    assert_field_shape(&field)?;
    Ok(field)
}

fn parse_options(value: &Value) -> Result<Vec<String>, TableError> {
    let items = value
        .as_array()
        .ok_or_else(|| TableError::new("invalid_table"))?;
    if items.len() > MAX_OPTIONS {
        return Err(TableError::new("invalid_table"));
    }
    let mut options = Vec::with_capacity(items.len());
    for item in items {
        let option = item
            .as_str()
            .ok_or_else(|| TableError::new("invalid_table"))?;
        if option.is_empty() {
            return Err(TableError::new("invalid_table"));
        }
        options.push(option.to_string());
    }
    Ok(options)
}

fn assert_field_shape(field: &Field) -> Result<(), TableError> {
    if field
        .options
        .iter()
        .collect::<std::collections::HashSet<_>>()
        .len()
        != field.options.len()
        || (field.type_ == FieldType::Select && field.options.is_empty())
    {
        return Err(TableError::new("invalid_table"));
    }
    if field.type_ == FieldType::Link {
        if !field.options.is_empty() || !field.unit.trim().is_empty() {
            return Err(TableError::new("invalid_table"));
        }
        if let Some(target) = &field.target {
            if !target.is_empty() && !safe_table_reference(target) {
                return Err(TableError::new("invalid_table"));
            }
        }
        return Ok(());
    }
    if field.target.is_some() {
        return Err(TableError::new("invalid_table"));
    }
    Ok(())
}

fn parse_rows(value: &Value, fields: &[Field]) -> Result<Vec<Row>, TableError> {
    let items = value
        .as_array()
        .ok_or_else(|| TableError::new("invalid_table"))?;
    if items.len() > MAX_TABLE_ROWS {
        return Err(TableError::new("invalid_table"));
    }
    let mut rows = Vec::with_capacity(items.len());
    let mut registry_ids = Vec::new();
    for item in items {
        let row = parse_row(item, fields)?;
        if let Some(id) = &row.registry_id {
            registry_ids.push(id.clone());
        }
        rows.push(row);
    }
    if rows
        .iter()
        .map(|row| row.id.as_str())
        .collect::<std::collections::HashSet<_>>()
        .len()
        != rows.len()
        || registry_ids
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != registry_ids.len()
    {
        return Err(TableError::new("invalid_table"));
    }
    Ok(rows)
}

fn parse_row(value: &Value, fields: &[Field]) -> Result<Row, TableError> {
    let obj = value
        .as_object()
        .ok_or_else(|| TableError::new("invalid_table"))?;
    reject_unknown(obj, ROW_KEYS)?;
    let id = required_str(obj, "id")?;
    if id.is_empty() {
        return Err(TableError::new("invalid_table"));
    }
    let values = parse_values(require(obj, "values")?, fields)?;
    let registry_id = optional_registry(obj)?;
    let created_at = optional_timestamp(obj, "createdAt")?;
    let updated_at = optional_timestamp(obj, "updatedAt")?;
    let archived_at = optional_timestamp(obj, "archivedAt")?;
    let actor = match obj.get("actor") {
        None => None,
        Some(Value::String(actor)) if actor == "human" || actor == "agent" => Some(actor.clone()),
        Some(_) => return Err(TableError::new("invalid_table")),
    };
    Ok(Row {
        id: id.to_string(),
        values,
        registry_id,
        created_at,
        updated_at,
        archived_at,
        actor,
    })
}

fn parse_values(value: &Value, fields: &[Field]) -> Result<Map<String, Value>, TableError> {
    let obj = value
        .as_object()
        .ok_or_else(|| TableError::new("invalid_table"))?;
    let mut values = Map::new();
    for (id, cell) in obj {
        let field = fields
            .iter()
            .find(|field| field.id == *id)
            .ok_or_else(|| TableError::new("invalid_table"))?;
        if !valid_cell(cell, field) {
            return Err(TableError::new("invalid_table"));
        }
        values.insert(id.clone(), cell.clone());
    }
    Ok(values)
}

pub(super) fn safe_table_reference(path: &str) -> bool {
    !path.is_empty()
        && path.to_lowercase().ends_with(".table.json")
        && !path
            .chars()
            .any(|ch| ch == '\\' || ch == ':' || ch == '#' || (ch as u32) < 32)
        && path
            .split('/')
            .all(|part| !part.is_empty() && !part.starts_with('.'))
}

fn optional_schema_path(obj: &Map<String, Value>) -> Result<Option<String>, TableError> {
    match obj.get("schemaPath") {
        None => Ok(None),
        Some(Value::String(path)) if safe_table_reference(path) => Ok(Some(path.clone())),
        Some(_) => Err(TableError::new("invalid_table")),
    }
}

fn optional_prefix(obj: &Map<String, Value>) -> Result<Option<String>, TableError> {
    match obj.get("idPrefix") {
        None => Ok(None),
        Some(Value::String(prefix))
            if (1..=MAX_PREFIX_CHARS).contains(&prefix.chars().count()) && is_prefix(prefix) =>
        {
            Ok(Some(prefix.clone()))
        }
        Some(_) => Err(TableError::new("invalid_table")),
    }
}

fn is_prefix(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_alphabetic() && chars.all(|ch| ch.is_ascii_alphanumeric())
}

fn optional_keys(obj: &Map<String, Value>) -> Result<Vec<String>, TableError> {
    match obj.get("appliedKeys") {
        None => Ok(Vec::new()),
        Some(Value::Array(items)) if items.len() <= MAX_APPLIED_KEYS => {
            let mut keys = Vec::with_capacity(items.len());
            for item in items {
                let key = item
                    .as_str()
                    .ok_or_else(|| TableError::new("invalid_table"))?;
                let len = key.chars().count();
                if !(1..=MAX_KEY_CHARS).contains(&len) {
                    return Err(TableError::new("invalid_table"));
                }
                keys.push(key.to_string());
            }
            Ok(keys)
        }
        Some(_) => Err(TableError::new("invalid_table")),
    }
}

fn optional_registry(obj: &Map<String, Value>) -> Result<Option<String>, TableError> {
    match obj.get("registryId") {
        None => Ok(None),
        Some(Value::String(id)) if is_registry_id(id) => Ok(Some(id.clone())),
        Some(_) => Err(TableError::new("invalid_table")),
    }
}

fn optional_timestamp(obj: &Map<String, Value>, key: &str) -> Result<Option<String>, TableError> {
    match obj.get(key) {
        None => Ok(None),
        Some(Value::String(stamp)) if valid_timestamp(stamp) => Ok(Some(stamp.clone())),
        Some(_) => Err(TableError::new("invalid_table")),
    }
}

fn optional_width(obj: &Map<String, Value>) -> Result<Option<u32>, TableError> {
    match obj.get("width") {
        None => Ok(None),
        Some(Value::Number(number)) => {
            let value = number
                .as_u64()
                .ok_or_else(|| TableError::new("invalid_table"))?;
            if !(80..=480).contains(&value) {
                return Err(TableError::new("invalid_table"));
            }
            Ok(Some(
                u32::try_from(value).map_err(|_| TableError::new("invalid_table"))?,
            ))
        }
        Some(_) => Err(TableError::new("invalid_table")),
    }
}

fn optional_positive(obj: &Map<String, Value>, key: &str) -> Result<Option<u64>, TableError> {
    match obj.get(key) {
        None => Ok(None),
        Some(value) => {
            let number = value
                .as_u64()
                .filter(|number| *number >= 1)
                .ok_or_else(|| TableError::new("invalid_table"))?;
            Ok(Some(number))
        }
    }
}

fn field_value(field: &Field) -> Value {
    let mut obj = Map::new();
    obj.insert("id".into(), Value::String(field.id.clone()));
    obj.insert("name".into(), Value::String(field.name.clone()));
    obj.insert("type".into(), Value::String(field.type_.as_str().into()));
    obj.insert("unit".into(), Value::String(field.unit.clone()));
    obj.insert(
        "options".into(),
        Value::Array(field.options.iter().cloned().map(Value::String).collect()),
    );
    if field.type_ == FieldType::Link {
        if let Some(target) = field.target.as_ref().filter(|target| !target.is_empty()) {
            obj.insert("target".into(), Value::String(target.clone()));
        }
    }
    if let Some(width) = field.width {
        obj.insert("width".into(), Value::from(width));
    }
    Value::Object(obj)
}

fn row_value(row: &Row) -> Value {
    let mut obj = Map::new();
    obj.insert("id".into(), Value::String(row.id.clone()));
    obj.insert("values".into(), Value::Object(row.values.clone()));
    if let Some(id) = &row.registry_id {
        obj.insert("registryId".into(), Value::String(id.clone()));
    }
    if let Some(stamp) = &row.created_at {
        obj.insert("createdAt".into(), Value::String(stamp.clone()));
    }
    if let Some(stamp) = &row.updated_at {
        obj.insert("updatedAt".into(), Value::String(stamp.clone()));
    }
    if let Some(stamp) = &row.archived_at {
        obj.insert("archivedAt".into(), Value::String(stamp.clone()));
    }
    if let Some(actor) = &row.actor {
        obj.insert("actor".into(), Value::String(actor.clone()));
    }
    Value::Object(obj)
}

fn reject_unknown(obj: &Map<String, Value>, allowed: &[&str]) -> Result<(), TableError> {
    if obj.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(TableError::new("invalid_table"));
    }
    Ok(())
}

fn require<'a>(obj: &'a Map<String, Value>, key: &str) -> Result<&'a Value, TableError> {
    obj.get(key).ok_or_else(|| TableError::new("invalid_table"))
}

fn required_str<'a>(obj: &'a Map<String, Value>, key: &str) -> Result<&'a str, TableError> {
    require(obj, key)?
        .as_str()
        .ok_or_else(|| TableError::new("invalid_table"))
}

fn required_u64(obj: &Map<String, Value>, key: &str) -> Result<u64, TableError> {
    require(obj, key)?
        .as_u64()
        .ok_or_else(|| TableError::new("invalid_table"))
}

pub(super) fn values_by_name(table: &Table, row: &Row) -> Map<String, Value> {
    let mut values = Map::new();
    for field in &table.fields {
        if let Some(value) = row.values.get(&field.id) {
            values.insert(field.name.clone(), value.clone());
        }
    }
    values
}
