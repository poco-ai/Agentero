use super::*;
use crate::features::research_table as table;
use std::collections::HashSet;
fn err(e: table::TableError) -> AppError {
    AppError::domain(
        e.stable_code(),
        match e.revision() {
            Some(r) => format!("Current table revision: {r}"),
            None => e.to_string(),
        },
    )
}
pub(super) fn execute(vault: &Path, name: &str, a: &Value, full_text: bool) -> Result<Value> {
    let normalized = files::relative_path(text(a, "path")?)?;
    let path = normalized.as_str();
    files::reject_segments(path)?;
    files::reject_managed(path)?;
    let root = vault.canonicalize()?;
    files::require_canonical(&root, path, &root.join(path).canonicalize()?)?;
    if !full_text && evidence::source_kind(&root, path)? == "body" {
        return Err(AppError::domain(
            "full_text_required",
            "Tables inside a paper require full-text access",
        ));
    }
    if name == "table_query" {
        let mut filter = table::QueryFilter {
            registry_id: a["row"].as_str().map(str::to_owned),
            field: a["field"].as_str().map(str::to_owned),
            equals: a.get("equals").cloned(),
            include_archived: flag(a, "archived"),
            limit: a["limit"].as_i64(),
            offset: None,
        };
        let mut out = table::query(vault, path, &filter).map_err(err)?;
        let rev = out.revision.to_string();
        let start = offset(vault, a, &rev)?;
        if start > 0 {
            filter.offset = Some(i64::try_from(start).map_err(|_| usage("Invalid cursor offset"))?);
            out = table::query(vault, path, &filter).map_err(err)?;
            if rev != out.revision.to_string() {
                return Err(AppError::domain(
                    "stale_cursor",
                    "Table changed during query",
                ));
            }
        }
        let cursor = if start.saturating_add(out.rows.len()) < (out.match_count as usize) {
            Some(next(vault, a, &rev, start + out.rows.len())?)
        } else {
            None
        };
        let columns = out
            .fields
            .into_iter()
            .map(|f| json!({"name":f.name,"type":f.field_type}))
            .collect::<Vec<_>>();
        let items = out
            .rows
            .into_iter()
            .map(|r| json!({"id":r.public_id,"fields":r.values,"archived":r.archived}))
            .collect::<Vec<_>>();
        return Ok(json!({"revision":rev,"columns":columns,"items":items,"next_cursor":cursor}));
    }
    let rev = text(a, "if_revision")?
        .parse::<u64>()
        .map_err(|_| usage("Use the revision returned by table_query"))?;
    let write_error = |e: table::TableError| {
        let actual = e.revision();
        let error = err(e);
        if let Some(actual) = actual {
            error.with_details(json!({"expected":rev.to_string(),"actual":actual.to_string()}))
        } else {
            error
        }
    };
    let key = hash(&serde_json::to_vec(&(name, a))?);
    let key = Some(key.as_str());
    let mut coords = HashSet::new();
    let (out, changed_cells) = if name == "table_patch" {
        let mut cells = Vec::new();
        for item in a["cells"]
            .as_array()
            .ok_or_else(|| usage("Missing cells"))?
        {
            let id = text(item, "id")?;
            let field = text(item, "field")?;
            if !coords.insert((id, field)) {
                return Err(usage("Duplicate cell coordinate"));
            }
            cells.push(table::CellUpdate {
                registry_id: id.into(),
                field: field.into(),
                value: item["value"].clone(),
            });
        }
        (
            table::update_cells(vault, path, rev, &cells, key, false).map_err(write_error)?,
            cells.len(),
        )
    } else {
        let mut rows = Vec::new();
        let mut count = 0;
        for item in a["rows"].as_array().ok_or_else(|| usage("Missing rows"))? {
            let fields = item["fields"]
                .as_object()
                .ok_or_else(|| usage("Expected row fields"))?;
            count += fields.len();
            rows.push(table::RowInput {
                registry_id: Some(text(item, "id")?.into()),
                values: fields.clone(),
            });
        }
        (
            table::upsert(vault, path, rev, &rows, key, false).map_err(write_error)?,
            count,
        )
    };
    let mut rows = Vec::new();
    for item in a[if name == "table_patch" {
        "cells"
    } else {
        "rows"
    }]
    .as_array()
    .unwrap()
    {
        let id = text(item, "id")?;
        if !rows.contains(&id) {
            rows.push(id);
        }
    }
    let applied_revision = if out.replayed {
        rev.checked_add(1)
            .ok_or_else(|| usage("Invalid revision"))?
    } else {
        out.revision
    };
    Ok(
        json!({"path":path,"revision":applied_revision.to_string(),"changed_rows":rows,"changed_cells":changed_cells}),
    )
}
