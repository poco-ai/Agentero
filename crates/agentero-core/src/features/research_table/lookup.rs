//! Vault walks for research-table files and the notes that embed them.
//!
//! Listing reads `*.table.json` (at most 200 files, each at most 2 MiB).
//! Backlinks scan Markdown for `::research-table` directives and match either
//! the vault-relative `path` or the table `id`. Hidden directories are skipped.
//! Markdown larger than 2 MiB is skipped.

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::Path;

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_TABLES: usize = 200;
const MAX_DEPTH: usize = 16;

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResearchTableListArgs {
    pub vault_path: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResearchTableSummary {
    pub path: String,
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id_prefix: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResearchTableListResult {
    pub tables: Vec<ResearchTableSummary>,
    pub truncated: bool,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResearchTableBacklinkArgs {
    pub vault_path: String,
    pub path: String,
    #[serde(default)]
    pub id: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResearchTableBacklink {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResearchTableBacklinkResult {
    pub notes: Vec<ResearchTableBacklink>,
}

pub fn list_research_tables(
    args: ResearchTableListArgs,
) -> Result<ResearchTableListResult, AppError> {
    let vault = crate::fs::resolve_vault(&args.vault_path)?;
    let mut tables = Vec::new();
    let mut truncated = false;
    collect_tables(&vault, &vault, 0, &mut tables, &mut truncated);
    tables.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(ResearchTableListResult { tables, truncated })
}

pub fn research_table_backlinks(
    args: ResearchTableBacklinkArgs,
) -> Result<ResearchTableBacklinkResult, AppError> {
    let vault = crate::fs::resolve_vault(&args.vault_path)?;
    let table_path = args.path.trim().replace('\\', "/");
    let table_id = args.id.unwrap_or_default();
    let table_id = table_id.trim();
    let mut notes = Vec::new();
    collect_backlinks(&vault, &vault, 0, &table_path, table_id, &mut notes);
    notes.sort();
    notes.dedup();
    Ok(ResearchTableBacklinkResult {
        notes: notes
            .into_iter()
            .map(|path| ResearchTableBacklink { path })
            .collect(),
    })
}

fn collect_tables(
    vault: &Path,
    dir: &Path,
    depth: usize,
    out: &mut Vec<ResearchTableSummary>,
    truncated: &mut bool,
) {
    if depth > MAX_DEPTH || *truncated {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if *truncated {
            return;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_tables(vault, &path, depth + 1, out, truncated);
            continue;
        }
        if !file_type.is_file() || !is_table_name(&name) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.len() > MAX_FILE_BYTES {
            continue;
        }
        if out.len() >= MAX_TABLES {
            *truncated = true;
            return;
        }
        if let Some(summary) = read_summary(vault, &path) {
            out.push(summary);
        }
    }
}

fn collect_backlinks(
    vault: &Path,
    dir: &Path,
    depth: usize,
    table_path: &str,
    table_id: &str,
    out: &mut Vec<String>,
) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_backlinks(vault, &path, depth + 1, table_path, table_id, out);
            continue;
        }
        if !file_type.is_file() || !name.to_ascii_lowercase().ends_with(".md") {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.len() > MAX_FILE_BYTES {
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        if !directive_mentions(&content, table_path, table_id) {
            continue;
        }
        if let Some(rel) = vault_rel(vault, &path) {
            out.push(rel);
        }
    }
}

fn read_summary(vault: &Path, file: &Path) -> Option<ResearchTableSummary> {
    let rel = vault_rel(vault, file)?;
    let text = fs::read_to_string(file).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let id = value.get("id").and_then(Value::as_str).unwrap_or("").trim();
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if id.is_empty() || name.is_empty() {
        return None;
    }
    let id_prefix = value
        .get("idPrefix")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|prefix| !prefix.is_empty())
        .map(str::to_string);
    Some(ResearchTableSummary {
        path: rel,
        id: id.to_string(),
        name: name.to_string(),
        id_prefix,
    })
}

fn is_table_name(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(".table.json")
}

fn vault_rel(vault: &Path, file: &Path) -> Option<String> {
    let rel = file.strip_prefix(vault).ok()?;
    let text = rel.to_string_lossy().replace('\\', "/");
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn directive_mentions(content: &str, table_path: &str, table_id: &str) -> bool {
    let mut in_fence = false;
    for line in content.lines() {
        let content_line = line.strip_suffix('\r').unwrap_or(line);
        let indent = content_line
            .bytes()
            .take_while(|byte| *byte == b' ')
            .count();
        let trimmed = content_line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence || indent > 3 {
            continue;
        }
        let Some(inside) = directive_inside(content_line) else {
            continue;
        };
        let path = attribute_value(inside, "path");
        let id = attribute_value(inside, "id").or_else(|| directive_id_label(inside));
        if path.is_some_and(|value| value == table_path)
            || (!table_id.is_empty() && id.is_some_and(|value| value == table_id))
        {
            return true;
        }
    }
    false
}

fn directive_inside(line: &str) -> Option<&str> {
    let indent = line.bytes().take_while(|byte| *byte == b' ').count();
    let rest = line[indent..].trim_end_matches([' ', '\t']);
    let body = rest.strip_prefix("::research-table{")?;
    let end = body.find('}')?;
    if !body[end + 1..].is_empty() {
        return None;
    }
    Some(&body[..end])
}

/// Remark-directive writes a shortcut-safe id as `{#id ...}` instead of `id="..."`.
fn directive_id_label(inside: &str) -> Option<&str> {
    let hash = inside.find('#')?;
    if hash != 0 && !inside.as_bytes()[hash - 1].is_ascii_whitespace() {
        return None;
    }
    let rest = &inside[hash + 1..];
    let end = rest
        .find(|ch: char| ch.is_ascii_whitespace())
        .unwrap_or(rest.len());
    let value = &rest[..end];
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn attribute_value<'a>(inside: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("{key}=");
    let mut search = 0usize;
    while let Some(rel) = inside[search..].find(&needle) {
        let at = search + rel;
        let boundary = at == 0 || inside.as_bytes()[at - 1].is_ascii_whitespace();
        if boundary {
            let after = &inside[at + needle.len()..];
            let quote = after.chars().next()?;
            if quote == '"' || quote == '\'' {
                let quoted = &after[quote.len_utf8()..];
                if let Some(end_quote) = quoted.find(quote) {
                    return Some(&quoted[..end_quote]);
                }
            }
        }
        search = at + needle.len();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, rel: &str, body: &str) {
        let path = dir.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    #[test]
    fn lists_tables_and_finds_path_or_id_backlinks() {
        let root =
            std::env::temp_dir().join(format!("agentero-table-lookup-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        write(
            &root,
            "data/run.table.json",
            r#"{"id":"table-1","name":"Run","idPrefix":"EXP"}"#,
        );
        write(
            &root,
            ".hidden/skip.table.json",
            r#"{"id":"hidden","name":"Hidden"}"#,
        );
        write(
            &root,
            "notes/by-path.md",
            "::research-table{path=\"data/run.table.json\"}\n",
        );
        write(
            &root,
            "notes/by-id.md",
            "::research-table{id=\"table-1\" path=\"old/run.table.json\"}\n",
        );
        write(
            &root,
            "notes/by-label.md",
            "::research-table{#table-1 path=\"old/run.table.json\"}\n",
        );
        write(
            &root,
            "notes/other.md",
            "::research-table{path=\"data/other.table.json\"}\n",
        );
        write(
            &root,
            ".hidden/secret.md",
            "::research-table{id=\"table-1\" path=\"data/run.table.json\"}\n",
        );

        let listed = list_research_tables(ResearchTableListArgs {
            vault_path: root.to_string_lossy().to_string(),
        })
        .unwrap();
        assert_eq!(listed.tables.len(), 1);
        assert_eq!(listed.tables[0].path, "data/run.table.json");
        assert_eq!(listed.tables[0].id, "table-1");
        assert_eq!(listed.tables[0].name, "Run");
        assert_eq!(listed.tables[0].id_prefix.as_deref(), Some("EXP"));

        let notes = research_table_backlinks(ResearchTableBacklinkArgs {
            vault_path: root.to_string_lossy().to_string(),
            path: "data/run.table.json".into(),
            id: Some("table-1".into()),
        })
        .unwrap();
        let paths: Vec<_> = notes.notes.iter().map(|note| note.path.as_str()).collect();
        assert_eq!(
            paths,
            vec!["notes/by-id.md", "notes/by-label.md", "notes/by-path.md"]
        );
        let _ = fs::remove_dir_all(&root);
    }
}
