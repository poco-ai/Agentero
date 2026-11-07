//! `agentero table *` — row operations on `*.table.json`.

use crate::error::{CliError, ExitCode};
use crate::output::to_value;
use crate::resolve::{resolve_vault, GlobalOpts};
use agentero_core::features::research_table::{
    self, CellUpdate, QueryFilter, RowInput, TableError,
};
use clap::{Subcommand, ValueHint};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::io::{stdin, IsTerminal, Read};

#[derive(Debug, Subcommand)]
pub enum TableCmd {
    /// Read rows from a research table in stored order.
    Query {
        /// Vault-relative `*.table.json`.
        #[arg(value_hint = ValueHint::FilePath)]
        path: String,
        /// Match this registry id.
        #[arg(long = "registry-id")]
        registry_id: Option<String>,
        /// Field name. Requires `--equals`.
        #[arg(long = "field")]
        field: Option<String>,
        /// JSON scalar, or a raw string when it is not JSON.
        #[arg(long = "equals")]
        equals: Option<String>,
        /// Include archived rows.
        #[arg(long = "include-archived")]
        include_archived: bool,
        /// Page size (default 50, clamped to 1..=200).
        #[arg(long = "limit")]
        limit: Option<i64>,
        /// Rows to skip (default 0).
        #[arg(long = "offset")]
        offset: Option<i64>,
    },
    /// Create rows or patch fields on existing registry ids.
    Upsert {
        #[arg(value_hint = ValueHint::FilePath)]
        path: String,
        /// Current revision from `table query`.
        #[arg(long = "expected-revision")]
        expected_revision: Option<u64>,
        /// JSON body. Reads stdin when omitted.
        #[arg(long = "data")]
        data: Option<String>,
        /// 1..=80 characters, no whitespace.
        #[arg(long = "idempotency-key")]
        idempotency_key: Option<String>,
        #[arg(long = "include-archived")]
        include_archived: bool,
    },
    /// Patch cells addressed by registry id and field name.
    UpdateCells {
        #[arg(value_hint = ValueHint::FilePath)]
        path: String,
        #[arg(long = "expected-revision")]
        expected_revision: Option<u64>,
        #[arg(long = "data")]
        data: Option<String>,
        #[arg(long = "idempotency-key")]
        idempotency_key: Option<String>,
        #[arg(long = "include-archived")]
        include_archived: bool,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpsertBody {
    #[serde(default)]
    expected_revision: Option<u64>,
    #[serde(default)]
    idempotency_key: Option<String>,
    #[serde(default)]
    include_archived: bool,
    rows: Vec<UpsertBodyRow>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpsertBodyRow {
    #[serde(default)]
    registry_id: Option<String>,
    values: Map<String, Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CellsBody {
    #[serde(default)]
    expected_revision: Option<u64>,
    #[serde(default)]
    idempotency_key: Option<String>,
    #[serde(default)]
    include_archived: bool,
    cells: Vec<CellBody>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CellBody {
    registry_id: String,
    field: String,
    value: Value,
}

pub fn run(cmd: TableCmd, globals: &GlobalOpts) -> Result<Value, CliError> {
    match cmd {
        TableCmd::Query {
            path,
            registry_id,
            field,
            equals,
            include_archived,
            limit,
            offset,
        } => {
            let vault = resolve_vault(globals)?;
            let equals = match (&field, equals) {
                (None, None) => None,
                (Some(_), Some(raw)) => Some(parse_equals(&raw)),
                (None, Some(_)) | (Some(_), None) => {
                    return Err(CliError::usage(
                        "table query --field and --equals must be passed together",
                    ));
                }
            };
            let out = research_table::query(
                &vault,
                &path,
                &QueryFilter {
                    registry_id,
                    field,
                    equals,
                    include_archived,
                    limit,
                    offset,
                },
            )
            .map_err(map_table)?;
            let mut value = to_value(&out)?;
            if let Some(obj) = value.as_object_mut() {
                obj.insert(
                    "lines".into(),
                    json!([format!(
                        "{}  rev {}  {} match{}",
                        path,
                        out.revision,
                        out.match_count,
                        if out.truncated { " (truncated)" } else { "" }
                    )]),
                );
            }
            Ok(value)
        }
        TableCmd::Upsert {
            path,
            expected_revision,
            data,
            idempotency_key,
            include_archived,
        } => {
            let vault = resolve_vault(globals)?;
            let mut body: UpsertBody = serde_json::from_str(&read_body(data)?)
                .map_err(|err| CliError::usage(format!("invalid table upsert JSON: {err}")))?;
            if let Some(revision) = expected_revision {
                body.expected_revision = Some(revision);
            }
            if let Some(key) = idempotency_key {
                body.idempotency_key = Some(key);
            }
            if include_archived {
                body.include_archived = true;
            }
            let revision = body.expected_revision.ok_or_else(|| {
                CliError::usage("expectedRevision is required (--expected-revision or JSON)")
            })?;
            let rows = body
                .rows
                .into_iter()
                .map(|row| RowInput {
                    registry_id: row.registry_id,
                    values: row.values,
                })
                .collect::<Vec<_>>();
            let out = research_table::upsert(
                &vault,
                &path,
                revision,
                &rows,
                body.idempotency_key.as_deref(),
                body.include_archived,
            )
            .map_err(map_table)?;
            finish_mutation(&path, out)
        }
        TableCmd::UpdateCells {
            path,
            expected_revision,
            data,
            idempotency_key,
            include_archived,
        } => {
            let vault = resolve_vault(globals)?;
            let mut body: CellsBody = serde_json::from_str(&read_body(data)?).map_err(|err| {
                CliError::usage(format!("invalid table update-cells JSON: {err}"))
            })?;
            if let Some(revision) = expected_revision {
                body.expected_revision = Some(revision);
            }
            if let Some(key) = idempotency_key {
                body.idempotency_key = Some(key);
            }
            if include_archived {
                body.include_archived = true;
            }
            let revision = body.expected_revision.ok_or_else(|| {
                CliError::usage("expectedRevision is required (--expected-revision or JSON)")
            })?;
            let cells = body
                .cells
                .into_iter()
                .map(|cell| CellUpdate {
                    registry_id: cell.registry_id,
                    field: cell.field,
                    value: cell.value,
                })
                .collect::<Vec<_>>();
            let out = research_table::update_cells(
                &vault,
                &path,
                revision,
                &cells,
                body.idempotency_key.as_deref(),
                body.include_archived,
            )
            .map_err(map_table)?;
            finish_mutation(&path, out)
        }
    }
}

fn finish_mutation(path: &str, out: research_table::MutationOut) -> Result<Value, CliError> {
    let mut value = to_value(&out)?;
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "lines".into(),
            json!([format!(
                "{}  rev {}{}",
                path,
                out.revision,
                if out.replayed { "  replayed" } else { "" }
            )]),
        );
    }
    Ok(value)
}

fn read_body(data: Option<String>) -> Result<String, CliError> {
    if let Some(data) = data {
        return Ok(data);
    }
    if stdin().is_terminal() {
        return Err(CliError::usage(
            "pass --data or pipe the JSON mutation body on stdin",
        ));
    }
    let mut raw = String::new();
    stdin()
        .read_to_string(&mut raw)
        .map_err(|err| CliError::usage(format!("failed to read stdin: {err}")))?;
    Ok(raw)
}

fn parse_equals(raw: &str) -> Value {
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)) => {
            serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string()))
        }
        _ => Value::String(raw.to_string()),
    }
}

fn map_table(err: TableError) -> CliError {
    let details = match err.revision() {
        Some(revision) => json!({ "revision": revision }),
        None => Value::Null,
    };
    let code = err.stable_code();
    let message = if code == "io" {
        err.to_string()
    } else {
        code.to_string()
    };
    CliError::with_details(code, message, details, ExitCode::Business)
}
