use crate::commands::{
    desktop, doctor, export, feed, import, layout, mcp, paper, sync, translate, vault,
};
use crate::error::{CliError, ExitCode};
use crate::interface::{Decode, Operation};
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

fn source_from_stdin() -> Result<Value, CliError> {
    let body = input_text("-")?;
    let mut lines = body.lines().filter(|s| !s.is_empty());
    let source = lines.next().ok_or_else(|| {
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
    Ok(json!(source))
}

fn normalize(operation: &Operation, mut a: Value) -> Result<Value, CliError> {
    let values = a.as_object_mut().expect("object parameters");
    for param in &operation.args {
        let Some(binding) = &param.binding else {
            continue;
        };
        let key = param.name.replace('-', "_");
        let Some(value) = values.remove(&key) else {
            continue;
        };
        let target = binding.field.unwrap_or(&key);
        let text = || {
            value
                .as_str()
                .ok_or_else(|| CliError::usage(format!("expected text for {}", param.name)))
        };
        let value = match binding.decode {
            Some(Decode::Omit) => continue,
            Some(Decode::SourceOrStdin) if value == "-" => source_from_stdin()?,
            Some(Decode::Pages) => json!(evidence::parse_pages(text()?)?),
            Some(Decode::FileContent)
                if values.get("encoding").and_then(Value::as_str) == Some("binary") =>
            {
                values.insert("encoding".into(), json!("base64"));
                json!(base64::engine::general_purpose::STANDARD.encode(input(text()?)?))
            }
            Some(Decode::FileContent | Decode::TextFile) => json!(input_text(text()?)?),
            Some(Decode::JsonMember) => {
                let mut payload: Value = serde_json::from_slice(&input(text()?)?)
                    .map_err(|e| CliError::usage(format!("invalid table input: {e}")))?;
                payload
                    .as_object_mut()
                    .and_then(|o| o.remove(target))
                    .ok_or_else(|| {
                        CliError::usage(format!("expected a JSON object containing {target}"))
                    })?
            }
            Some(Decode::SourceOrStdin) | None => value,
        };
        values.insert(target.into(), value);
    }
    let op = operation.tool.expect("shared operation");
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
            return desktop::run_granted(name, normalize(op, a)?, g).await;
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
        let mut normalized = normalize(op, a)?;
        if let Some(target) = string(&normalized, "to_vault") {
            normalized["to_vault"] = json!(crate::resolve::named_vault(Path::new(target))?);
        }
        return Ok(agentero_core::ops::execute::run_local(
            &vault,
            tool,
            normalized,
            g.translator_base_url(),
        )
        .await?);
    }
    use crate::interface::NativeCommand;
    let p = || required(&a, "paper").map(str::to_owned);
    match op.native.expect("local command was validated at startup") {
        NativeCommand::McpServe | NativeCommand::McpTools => mcp::run(op.path, a, g).await,
        NativeCommand::FeedList
        | NativeCommand::FeedAdd
        | NativeCommand::FeedRefresh
        | NativeCommand::FeedItemList
        | NativeCommand::FeedItemMark
        | NativeCommand::FeedRemove => feed::dispatch(op.path, &a, g).await,
        NativeCommand::SyncStatus
        | NativeCommand::SyncConnectS3
        | NativeCommand::SyncConnectWebdav
        | NativeCommand::SyncConnectGit
        | NativeCommand::SyncTest
        | NativeCommand::SyncRun
        | NativeCommand::SyncOverwrite
        | NativeCommand::SyncDisconnect => sync::dispatch(op.path, &a, g).await,
        NativeCommand::AppOpen
        | NativeCommand::AppViews
        | NativeCommand::AppSplit
        | NativeCommand::AppClose
        | NativeCommand::AppWindow
        | NativeCommand::AppPresent
        | NativeCommand::DelegateTargets
        | NativeCommand::DelegateRun
        | NativeCommand::DelegateResult
        | NativeCommand::DelegateCancel => {
            if op.path == "delegate run" && a["request_id"].is_null() {
                a["request_id"] = json!(uuid::Uuid::new_v4().to_string());
            }
            desktop::run(op.path, a, g).await
        }
        NativeCommand::VaultCreate => {
            vault::create_new(Path::new(required(&a, "directory")?), string(&a, "name"), g)
        }
        NativeCommand::VaultInfo => vault::info(g),
        NativeCommand::VaultCheck | NativeCommand::VaultRepair => doctor::dispatch(op.path, &a, g),
        NativeCommand::FileTrashPurge => purge(&a, g),
        NativeCommand::Translate => {
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
        NativeCommand::PaperImportPdf => {
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
        NativeCommand::PaperImportBib => {
            import::import_bib(
                g,
                required(&a, "input")?,
                required(&a, "into")?,
                string(&a, "format").unwrap_or("auto"),
            )
            .await
        }
        NativeCommand::PaperExport => export::selected(&a, g).await,
        NativeCommand::PaperNoteFetch => paper::fetch_notes(g, &p()?).await,
        NativeCommand::PaperDownload => paper::download_selected(&a, g).await,
        NativeCommand::PaperExtract => paper::parse(g, &p()?, a["refresh"] == true).await,
        NativeCommand::PaperAnalyze => layout::dispatch(&a, g).await,
        NativeCommand::PaperLink | NativeCommand::PaperCopy => {
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
        NativeCommand::Help => unreachable!("help is handled before dispatch"),
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
