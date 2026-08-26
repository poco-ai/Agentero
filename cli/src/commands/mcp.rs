//! Model Context Protocol (MCP) server exposed by `agentero mcp`.
//!
//! The transport is newline-delimited JSON-RPC 2.0 over stdio. Stdout is
//! reserved exclusively for protocol messages so it can be used directly by
//! desktop MCP hosts and connector bridges.

use crate::commands::{import, paper};
use crate::error::{CliError, ExitCode};
use crate::resolve::{paper_dir, resolve_paper, resolve_vault, GlobalOpts};
use serde_json::{json, Map, Value};
use std::fs;
use std::io::{self, BufRead, Write};

const PROTOCOL_VERSION: &str = "2025-06-18";

/// Run the MCP stdio transport until the client closes stdin.
///
/// This deliberately bypasses the CLI success envelope: MCP clients require
/// each stdout line to be a JSON-RPC response (and notifications have none).
pub async fn serve(globals: &GlobalOpts) -> Result<(), CliError> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut output = stdout.lock();

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        let response = match serde_json::from_str::<Value>(&line) {
            Ok(request) => handle_request(request, globals).await,
            Err(error) => Some(json_rpc_error(
                Value::Null,
                -32700,
                "Parse error",
                Some(json!({ "message": error.to_string() })),
            )),
        };

        if let Some(response) = response {
            serde_json::to_writer(&mut output, &response)?;
            writeln!(output)?;
            output.flush()?;
        }
    }

    Ok(())
}

async fn handle_request(request: Value, globals: &GlobalOpts) -> Option<Value> {
    let Some(object) = request.as_object() else {
        return Some(json_rpc_error(
            Value::Null,
            -32600,
            "Invalid Request",
            Some(json!({ "message": "request must be an object" })),
        ));
    };

    let id = object.get("id").cloned();
    let respond = |result: Result<Value, JsonRpcFailure>| match (id.clone(), result) {
        (Some(id), Ok(value)) => Some(json_rpc_result(id, value)),
        (Some(id), Err(error)) => Some(json_rpc_error(id, error.code, error.message, error.data)),
        (None, _) => None,
    };

    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return respond(Err(JsonRpcFailure::invalid_request(
            "jsonrpc must equal '2.0'",
        )));
    }

    let Some(method) = object.get("method").and_then(Value::as_str) else {
        return respond(Err(JsonRpcFailure::invalid_request(
            "method must be a string",
        )));
    };

    let params = object.get("params");
    match method {
        "initialize" => respond(Ok(initialize_result(params))),
        "notifications/initialized" => None,
        "ping" => respond(Ok(json!({}))),
        "tools/list" => respond(Ok(json!({ "tools": tool_definitions() }))),
        "tools/call" => {
            let result = handle_tool_call(params, globals).await;
            respond(Ok(result))
        }
        _ => respond(Err(JsonRpcFailure {
            code: -32601,
            message: "Method not found",
            data: Some(json!({ "method": method })),
        })),
    }
}

fn initialize_result(params: Option<&Value>) -> Value {
    let client_version = params
        .and_then(|p| p.get("protocolVersion"))
        .and_then(Value::as_str);
    // MCP initialization is forward compatible: advertise the version this
    // server implements even when a client announces an older version.
    let protocol_version = if client_version == Some(PROTOCOL_VERSION) {
        client_version.unwrap_or(PROTOCOL_VERSION)
    } else {
        PROTOCOL_VERSION
    };

    json!({
        "protocolVersion": protocol_version,
        "capabilities": {
            "tools": { "listChanged": false }
        },
        "serverInfo": {
            "name": "agentero",
            "version": env!("CARGO_PKG_VERSION")
        },
        "instructions": "Use Agentero tools only with an explicitly selected local Vault. agentero_append_note only appends supplied Markdown and never replaces an existing note."
    })
}

async fn handle_tool_call(params: Option<&Value>, globals: &GlobalOpts) -> Value {
    let Some(params) = params.and_then(Value::as_object) else {
        return tool_error(CliError::usage("tools/call params must be an object"));
    };
    let Some(name) = params.get("name").and_then(Value::as_str) else {
        return tool_error(CliError::usage("tools/call requires a tool name"));
    };
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));

    match invoke_tool(name, &arguments, globals).await {
        Ok(value) => tool_success(value),
        Err(error) => tool_error(error),
    }
}

async fn invoke_tool(
    name: &str,
    arguments: &Value,
    globals: &GlobalOpts,
) -> Result<Value, CliError> {
    let args = arguments
        .as_object()
        .ok_or_else(|| CliError::usage("tool arguments must be an object"))?;

    match name {
        "agentero_import_paper" => {
            let identifier = required_string(args, "identifier")?;
            let parent = optional_string(args, "parent")?.unwrap_or_else(|| "papers".into());
            let value = import::run(
                import::ImportCmd::Id {
                    text: identifier,
                    parent,
                },
                globals,
            )
            .await?;
            Ok(strip_display_fields(value))
        }
        "agentero_list_papers" => {
            let query = optional_string(args, "query")?;
            let tags = optional_string_array(args, "tags")?;
            let unread = optional_bool(args, "unread")?.unwrap_or(false);
            let status = optional_string(args, "status")?;
            let include_internal_tags =
                optional_bool(args, "includeInternalTags")?.unwrap_or(false);
            let value = paper::run(
                paper::PaperCmd::List {
                    query,
                    tags,
                    unread,
                    status,
                    all: include_internal_tags,
                    full: false,
                    fields: Vec::new(),
                },
                globals,
            )
            .await?;
            Ok(strip_display_fields(value))
        }
        "agentero_get_paper" => {
            let paper_ref = required_string(args, "paper")?;
            let include_internal_tags =
                optional_bool(args, "includeInternalTags")?.unwrap_or(false);
            let value = paper::run(
                paper::PaperCmd::Get {
                    r#ref: paper_ref,
                    all: include_internal_tags,
                },
                globals,
            )
            .await?;
            Ok(strip_display_fields(value))
        }
        "agentero_append_note" => append_note(args, globals),
        _ => Err(CliError::with_details(
            "unknown_tool",
            format!("Unknown MCP tool '{name}'"),
            json!({ "available": tool_names() }),
            ExitCode::Usage,
        )),
    }
}

/// Append a complete Markdown block to a paper note without overwriting any
/// existing material. Exact duplicate blocks are treated as successful no-ops.
fn append_note(args: &Map<String, Value>, globals: &GlobalOpts) -> Result<Value, CliError> {
    let paper_ref = required_string(args, "paper")?;
    let content = required_string(args, "content")?;
    let content = content.trim();
    if content.is_empty() {
        return Err(CliError::usage("content must not be empty"));
    }

    let vault = resolve_vault(globals)?;
    let paper = resolve_paper(&vault, &paper_ref, globals)?;
    let notes_path = paper_dir(&vault, &paper.path).join("NOTES.md");
    let relative_path = format!("{}/NOTES.md", paper.path.trim_end_matches('/'));
    let existed = notes_path.is_file();
    let existing = if existed {
        fs::read_to_string(&notes_path)?
    } else {
        String::new()
    };

    if existing.contains(content) {
        return Ok(json!({
            "paper": paper.path,
            "path": relative_path,
            "appended": false,
            "reason": "The identical Markdown block is already present in NOTES.md."
        }));
    }

    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&notes_path)?;
    if !existing.trim().is_empty() {
        file.write_all(b"\n\n---\n\n")?;
    }
    file.write_all(content.as_bytes())?;
    file.write_all(b"\n")?;

    Ok(json!({
        "paper": paper.path,
        "path": relative_path,
        "appended": true,
        "created": !existed
    }))
}

fn required_string(args: &Map<String, Value>, name: &str) -> Result<String, CliError> {
    let Some(value) = args.get(name).and_then(Value::as_str) else {
        return Err(CliError::usage(format!("'{name}' must be a string")));
    };
    let value = value.trim();
    if value.is_empty() {
        return Err(CliError::usage(format!("'{name}' must not be empty")));
    }
    Ok(value.to_string())
}

fn optional_string(args: &Map<String, Value>, name: &str) -> Result<Option<String>, CliError> {
    match args.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            let value = value.trim();
            if value.is_empty() {
                Ok(None)
            } else {
                Ok(Some(value.to_string()))
            }
        }
        Some(_) => Err(CliError::usage(format!("'{name}' must be a string"))),
    }
}

fn optional_bool(args: &Map<String, Value>, name: &str) -> Result<Option<bool>, CliError> {
    match args.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(CliError::usage(format!("'{name}' must be a boolean"))),
    }
}

fn optional_string_array(args: &Map<String, Value>, name: &str) -> Result<Vec<String>, CliError> {
    let Some(value) = args.get(name) else {
        return Ok(Vec::new());
    };
    let Some(values) = value.as_array() else {
        return Err(CliError::usage(format!(
            "'{name}' must be an array of strings"
        )));
    };
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .ok_or_else(|| {
                    CliError::usage(format!("'{name}' must contain only non-empty strings"))
                })
        })
        .collect()
}

fn strip_display_fields(mut value: Value) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.remove("lines");
        object.remove("__paper_list");
    }
    value
}

fn tool_success(value: Value) -> Value {
    tool_result(value, false)
}

fn tool_error(error: CliError) -> Value {
    tool_result(
        json!({
            "error": {
                "code": error.code,
                "message": error.message,
                "details": error.details
            }
        }),
        true,
    )
}

fn tool_result(value: Value, is_error: bool) -> Value {
    let text = serde_json::to_string_pretty(&value)
        .unwrap_or_else(|_| "{\"error\":{\"code\":\"serialization\"}}".into());
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": is_error
    })
}

fn json_rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn json_rpc_error(id: Value, code: i32, message: &str, data: Option<Value>) -> Value {
    let mut error = Map::new();
    error.insert("code".into(), json!(code));
    error.insert("message".into(), json!(message));
    if let Some(data) = data {
        error.insert("data".into(), data);
    }
    json!({ "jsonrpc": "2.0", "id": id, "error": error })
}

struct JsonRpcFailure {
    code: i32,
    message: &'static str,
    data: Option<Value>,
}

impl JsonRpcFailure {
    fn invalid_request(message: impl Into<String>) -> Self {
        Self {
            code: -32600,
            message: "Invalid Request",
            data: Some(json!({ "message": message.into() })),
        }
    }
}

fn tool_names() -> Vec<String> {
    tool_definitions()
        .iter()
        .filter_map(|tool| tool.get("name").and_then(Value::as_str))
        .map(str::to_owned)
        .collect()
}

fn tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "agentero_import_paper",
            "description": "Import one scholarly paper into the selected Agentero Vault from an arXiv identifier, DOI, URL, or another supported identifier. It creates catalog metadata and the paper shell; it may download available source assets.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "identifier": {
                        "type": "string",
                        "description": "arXiv ID, DOI, paper URL, or another paper identifier."
                    },
                    "parent": {
                        "type": "string",
                        "description": "Vault-relative parent folder under papers/. Defaults to papers."
                    }
                },
                "required": ["identifier"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "agentero_list_papers",
            "description": "List paper metadata in the selected Agentero Vault. Use it to find an exact paper path before writing a note.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Case-insensitive title, author, identifier, path, or tag search." },
                    "tags": { "type": "array", "items": { "type": "string" }, "description": "Tags that every returned paper must have." },
                    "unread": { "type": "boolean", "description": "When true, return only unread papers." },
                    "status": { "type": "string", "description": "Filter by the catalog status field." },
                    "includeInternalTags": { "type": "boolean", "description": "Include internal @zotero: tags in results and filtering." }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "agentero_get_paper",
            "description": "Read structured metadata and local asset availability for one paper. This tool does not return full paper or note bodies.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "paper": { "type": "string", "description": "A vault-relative paper path or an unambiguous paper ID." },
                    "includeInternalTags": { "type": "boolean", "description": "Include internal @zotero: tags in metadata." }
                },
                "required": ["paper"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "agentero_append_note",
            "description": "Append a complete Markdown block to a paper's NOTES.md. It never replaces existing note text and treats an identical existing block as a no-op. Use only after the user approves the note content or explicitly asks to save it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "paper": { "type": "string", "description": "A vault-relative paper path or an unambiguous paper ID." },
                    "content": { "type": "string", "description": "Complete Markdown block to append verbatim." }
                },
                "required": ["paper", "content"],
                "additionalProperties": false
            }
        }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::OutputFormat;
    use crate::style::Style;
    use agentero_lib::features::catalog::papers::{self, PaperRecord};
    use agentero_lib::features::vault;
    use std::path::Path;
    use tempfile::tempdir;

    #[test]
    fn tool_definitions_expose_issue_scope() {
        let names = tool_names();
        assert!(names.iter().any(|name| name == "agentero_import_paper"));
        assert!(names.iter().any(|name| name == "agentero_append_note"));
    }

    #[test]
    fn tool_errors_are_mcp_content_results() {
        let value = tool_error(CliError::usage("invalid"));
        assert_eq!(value["isError"], true);
        assert_eq!(value["content"][0]["type"], "text");
        assert!(value["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("invalid"));
    }

    #[test]
    fn optional_string_array_rejects_non_strings() {
        let args = Map::from_iter([(String::from("tags"), json!(["ok", 1]))]);
        assert!(optional_string_array(&args, "tags").is_err());
    }

    #[test]
    fn append_note_preserves_existing_content_and_is_idempotent() {
        let temp = tempdir().unwrap();
        let vault_root = temp.path().join("vault");
        vault::create_vault(&vault_root, "en").unwrap();

        let paper_dir = vault_root.join("papers/example");
        std::fs::create_dir_all(&paper_dir).unwrap();
        std::fs::write(
            paper_dir.join("NOTES.md"),
            "# Existing note\n\nHuman-authored text.\n",
        )
        .unwrap();
        papers::upsert_paper(
            &vault_root,
            &paper_record("papers/example", "example-paper"),
        )
        .unwrap();

        let globals = test_globals(&vault_root);
        let args = Map::from_iter([
            (String::from("paper"), json!("example-paper")),
            (
                String::from("content"),
                json!("## Agent draft\n\nUseful synthesis."),
            ),
        ]);

        let first = append_note(&args, &globals).unwrap();
        assert_eq!(first["appended"], true);
        let notes = std::fs::read_to_string(paper_dir.join("NOTES.md")).unwrap();
        assert!(notes.contains("Human-authored text."));
        assert!(notes.contains("## Agent draft\n\nUseful synthesis."));

        let second = append_note(&args, &globals).unwrap();
        assert_eq!(second["appended"], false);
        assert_eq!(
            std::fs::read_to_string(paper_dir.join("NOTES.md")).unwrap(),
            notes
        );
    }

    fn test_globals(vault: &Path) -> GlobalOpts {
        GlobalOpts {
            vault_flag: Some(vault.to_path_buf()),
            yes: false,
            quiet: true,
            translator_url: None,
            format: OutputFormat::Json,
            pretty: false,
            style: Style::new(false),
        }
    }

    fn paper_record(path: &str, id: &str) -> PaperRecord {
        serde_json::from_value(json!({
            "path": path,
            "id": id,
            "type": "journalArticle",
            "title": "Example paper",
            "authors": [],
            "status": "inbox",
            "added_at": "2026-08-26T00:00:00Z",
            "updated_at": "2026-08-26T00:00:00Z"
        }))
        .unwrap()
    }
}
