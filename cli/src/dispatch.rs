use crate::commands::{
    desktop, doctor, export, feed, import, layout, mcp, paper, sync, translate, vault,
};
use crate::error::{CliError, ExitCode};
use crate::interface::Operation;
use crate::resolve::{resolve_vault, GlobalOpts};
use agentero_core::features::evidence;
use base64::Engine;
use serde_json::{json, Value};
use std::io::{self, IsTerminal, Read};
use std::path::{Path, PathBuf};

pub(crate) fn string<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args[key].as_str()
}
pub(crate) fn strings(args: &Value, key: &str) -> Vec<String> {
    args[key]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}
pub(crate) fn required<'a>(args: &'a Value, key: &str) -> Result<&'a str, CliError> {
    string(args, key).ok_or_else(|| CliError::usage(format!("missing {key}")))
}
pub(crate) fn input(path: &str) -> Result<Vec<u8>, CliError> {
    if path == "-" {
        if io::stdin().is_terminal() {
            return Err(CliError::usage(
                "connect stdin to a pipe or provide an input file",
            ));
        }
        let mut buf = Vec::new();
        io::stdin().lock().read_to_end(&mut buf)?;
        Ok(buf)
    } else {
        Ok(std::fs::read(path)?)
    }
}
pub(crate) fn input_text(path: &str) -> Result<String, CliError> {
    String::from_utf8(input(path)?).map_err(|_| CliError::usage("expected UTF-8 input"))
}

fn normalize(op: &str, mut a: Value) -> Result<Value, CliError> {
    let values = a.as_object_mut().expect("object parameters");
    values.remove("plain");
    if op == "evidence_read" {
        if values.get("source").and_then(Value::as_str) == Some("-") {
            let body = input_text("-")?;
            let mut lines = body.lines().filter(|s| !s.is_empty());
            let first = lines.next().ok_or_else(|| {
                CliError::new(
                    "source_not_found",
                    "stdin contains no source",
                    ExitCode::Vault,
                )
            })?;
            if lines.next().is_some() {
                return Err(CliError::new(
                    "expected_one_source",
                    "pass exactly one source; add --limit 1 to the upstream search",
                    ExitCode::Usage,
                ));
            }
            values.insert("source".into(), json!(first));
        }
        if let Some(raw) = values.remove("page") {
            values.insert(
                "pages".into(),
                json!(evidence::parse_pages(raw.as_str().unwrap_or_default())?),
            );
        }
    }
    if let Some(color) = values.remove("mark_color") {
        values.insert("color".into(), color);
    }
    if let Some(file) = values.remove("input") {
        let path = file
            .as_str()
            .ok_or_else(|| CliError::usage("input must be a path"))?;
        match op {
            "file_write" if values.get("encoding").and_then(Value::as_str) == Some("binary") => {
                let body = input(path)?;
                values.insert("encoding".into(), json!("base64"));
                values.insert(
                    "content".into(),
                    json!(base64::engine::general_purpose::STANDARD.encode(body)),
                );
            }
            "table_upsert" | "table_patch" => {
                let payload: Value = serde_json::from_slice(&input(path)?)
                    .map_err(|e| CliError::usage(format!("invalid table input: {e}")))?;
                let key = if op == "table_upsert" {
                    "rows"
                } else {
                    "cells"
                };
                let value = payload.get(key).ok_or_else(|| {
                    CliError::usage(format!("expected a JSON object containing {key}"))
                })?;
                values.insert(key.into(), value.clone());
            }
            _ => {
                values.insert("content".into(), json!(input_text(path)?));
            }
        }
    }
    if matches!(
        op,
        "table_upsert" | "table_patch" | "paper_note_append" | "annotation_add"
    ) || (op == "file_write" && values.get("mode") == Some(&json!("append")))
    {
        values
            .entry("request_id")
            .or_insert_with(|| json!(uuid::Uuid::new_v4().to_string()));
    }
    Ok(a)
}

pub async fn run(op: &Operation, mut a: Value, g: &GlobalOpts) -> Result<Value, CliError> {
    if std::env::var_os("AGENTERO_CONTEXT_GRANT").is_some() {
        if matches!(
            op.tool,
            Some("evidence_read" | "evidence_search" | "paper_relations")
        ) {
            if g.vault_flag.is_some() {
                return Err(CliError::new(
                    "context_scope",
                    "a hosted turn selects its vault",
                    ExitCode::NeedsConfirmation,
                ));
            }
            let name = op.tool.unwrap();
            return desktop::run_granted(name, normalize(name, a)?, g).await;
        }
        if op.path != "app present" && !op.path.starts_with("delegate ") {
            return Err(CliError::new(
                "context_scope",
                "operation is outside the current turn grant",
                ExitCode::NeedsConfirmation,
            ));
        }
    }
    if op.path == "vault list" {
        return vault::inventory(g);
    }
    if let Some(tool) = op.tool {
        let vault = if tool == "paper_discover"
            && g.vault_flag.is_none()
            && std::env::var_os("AGENTERO_VAULT").is_none()
        {
            resolve_vault(g).unwrap_or_default()
        } else {
            resolve_vault(g)?
        };
        let mut normalized = normalize(tool, a)?;
        if let Some(target) = string(&normalized, "to_vault") {
            normalized["to_vault"] = json!(crate::resolve::named_vault(Path::new(target))?);
        }
        return Ok(agentero_mcp::execute_local(&vault, tool, normalized).await?);
    }
    if op.path.starts_with("mcp ") {
        return mcp::run(op.path, a, g).await;
    }
    if op.path.starts_with("app ") || op.path.starts_with("delegate ") {
        if op.path == "delegate run" && a["request_id"].is_null() {
            a["request_id"] = json!(uuid::Uuid::new_v4().to_string());
        }
        return desktop::run(op.path, a, g).await;
    }
    if op.path.starts_with("feed ") {
        return feed::dispatch(op.path, &a, g).await;
    }
    if op.path.starts_with("sync ") {
        return sync::dispatch(op.path, &a, g).await;
    }
    let p = || required(&a, "paper").map(str::to_owned);
    match op.path {
        "vault create" => {
            vault::create_new(Path::new(required(&a, "directory")?), string(&a, "name"), g)
        }
        "vault info" => vault::info(g),
        "vault check" | "vault repair" => doctor::dispatch(op.path, &a, g),
        "file trash purge" => purge(&a, g),
        "translate" => {
            let body = match (string(&a, "text"), string(&a, "input")) {
                (Some(t), None) => t.to_string(),
                (None, Some(i)) => input_text(i)?,
                _ => return Err(CliError::usage("provide TEXT or --input FILE")),
            };
            let dest = required(&a, "to")?;
            let src = string(&a, "from").unwrap_or("auto");
            let text = translate::run_raw(&body, dest, src, string(&a, "profile")).await?;
            Ok(json!({"text":text,"from":src,"to":dest}))
        }
        "paper import pdf" => {
            import::import_pdf(
                g,
                &strings(&a, "inputs")
                    .into_iter()
                    .map(PathBuf::from)
                    .collect::<Vec<_>>(),
                required(&a, "into")?,
                a["no_recognize"] == true,
                a["analyze"] == true,
            )
            .await
        }
        "paper import bib" => {
            import::import_bib(
                g,
                required(&a, "input")?,
                required(&a, "into")?,
                string(&a, "format").unwrap_or("auto"),
            )
            .await
        }
        "paper export" => export::selected(&a, g).await,
        "paper note fetch" => paper::fetch_notes(g, &p()?).await,
        "paper download" => paper::download_selected(&a, g).await,
        "paper extract" => paper::parse(g, &p()?, a["refresh"] == true).await,
        "paper analyze" => layout::dispatch(&a, g).await,
        "paper link" | "paper copy" => {
            let dest = agentero_core::fs::sanitize_vault_rel(required(&a, "into")?)
                .map_err(CliError::usage)?;
            let vault = resolve_vault(g)?;
            let target = if op.path == "paper copy" {
                let dst = crate::resolve::named_vault(Path::new(required(&a, "to_vault")?))?;
                if dst == vault {
                    return Err(CliError::usage("paper copy requires another vault"));
                }
                dst
            } else {
                vault
            };
            paper::organize(g, &p()?, &target, &dest)
        }
        _ => Err(CliError::usage(format!("unknown command {}", op.path))),
    }
}

fn purge(a: &Value, g: &GlobalOpts) -> Result<Value, CliError> {
    use agentero_core::features::vault::trash;
    let vault = resolve_vault(g)?;
    let id = required(a, "id")?;
    let list = trash::list_trash(&vault)?;
    let (batch, stored) = id
        .split_once("::")
        .ok_or_else(|| CliError::usage("use a recovery ID from file trash list"))?;
    let entry = list
        .iter()
        .find(|e| e.batch_id == batch && e.stored == stored)
        .ok_or_else(|| CliError::new("not_found", "unknown trash entry", ExitCode::Vault))?;
    let preview = a["dry_run"] == true;
    if !preview {
        if !crate::prompt::confirm(g, &format!("Permanently remove {}?", entry.rel), false)? {
            return Err(CliError::needs_confirmation("purge cancelled"));
        }
        trash::purge_item(&vault, batch, stored)?;
    }
    Ok(
        json!({"changed":!preview,"preview":preview,"items":[{"id":id,"path":entry.rel,"outcome":if preview{"planned"}else{"purged"}}]}),
    )
}
