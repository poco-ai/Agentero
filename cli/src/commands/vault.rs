//! `agentero vault *`

use crate::config;
use crate::error::CliError;
use crate::output::to_value;
use crate::resolve::{resolve_vault, GlobalOpts};
use agentero_core::features::vault as vault_svc;
use clap::{Subcommand, ValueHint};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Debug, Subcommand)]
pub enum VaultCmd {
    /// Search Markdown with MCP ranking, page mapping and metadata filters.
    Search {
        query: String,
        #[arg(long)]
        limit: Option<usize>,
        #[arg(long)]
        year: Option<i32>,
        #[arg(long)]
        publication: Option<String>,
        #[arg(long)]
        doi: Option<String>,
        #[arg(long, value_name = "BOOL")]
        is_read: Option<bool>,
    },
    /// Scaffold a new vault (catalog + dirs + AGENTS.md). Does not overwrite existing files.
    Create {
        /// Directory to create / scaffold.
        #[arg(value_hint = ValueHint::DirPath)]
        path: PathBuf,
        /// Also print absolute path suitable for shell cd (text: path only).
        #[arg(long = "open")]
        open: bool,
    },
    /// List known vaults recorded by `vault create`.
    List,
}

pub async fn run(cmd: VaultCmd, globals: &GlobalOpts) -> Result<Value, CliError> {
    match cmd {
        VaultCmd::Search {
            query,
            limit,
            year,
            publication,
            doi,
            is_read,
        } => {
            let vault = resolve_vault(globals)?;
            to_value(&vault_svc::files::search(
                &vault,
                query,
                limit,
                year,
                publication,
                doi,
                is_read,
            )?)
        }
        VaultCmd::Create { path, open } => create(&path, open, globals),
        VaultCmd::List => list(globals),
    }
}

fn detect_cli_locale() -> String {
    let env = std::env::var("LC_ALL")
        .or_else(|_| std::env::var("LANG"))
        .unwrap_or_default()
        .to_lowercase();
    if env.starts_with("zh") {
        "zh-CN".into()
    } else {
        "en".into()
    }
}

fn create(path: &Path, open: bool, globals: &GlobalOpts) -> Result<Value, CliError> {
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let locale = detect_cli_locale();
    let result = vault_svc::create_vault(&abs, &locale)?;
    let _ = config::record_vault(Path::new(&result.path));
    let mut v = to_value(&result)?;
    if open {
        if let Some(obj) = v.as_object_mut() {
            obj.insert("openPath".into(), json!(result.open_path));
        }
    }
    let style = globals.style;
    if let Some(obj) = v.as_object_mut() {
        let mut lines = vec![format!(
            "{} {}",
            style.ok("created"),
            style.path(&result.path)
        )];
        if !result.created.is_empty() {
            lines.push(format!(
                "{} {}",
                style.key("new"),
                result.created.join(", ")
            ));
        } else {
            lines.push(style.dim("Already scaffolded (nothing new)"));
        }
        obj.insert("lines".into(), json!(lines));
    }
    Ok(v)
}

fn list(globals: &GlobalOpts) -> Result<Value, CliError> {
    let default = config::load().ok().and_then(|c| c.default_vault);
    let known = config::list_known_vaults()?;
    let style = globals.style;

    let mut lines = Vec::new();
    let items: Vec<Value> = known
        .iter()
        .map(|p| {
            let is_default = default.as_ref().is_some_and(|d| d == p);
            let exists = Path::new(p).is_dir();
            let marker = if is_default {
                style.bright_yellow("*")
            } else {
                style.dim(" ")
            };
            let path_styled = if exists { style.path(p) } else { style.dim(p) };
            lines.push(format!("{marker} {path_styled}"));
            json!({
                "path": p,
                "exists": exists,
                "default": is_default,
            })
        })
        .collect();

    if lines.is_empty() {
        lines.push(
            style
                .dim("No known vaults. Use `agentero vault create <PATH>` to record one.")
                .to_string(),
        );
    }

    let mut v = json!({ "vaults": items });
    if let Some(obj) = v.as_object_mut() {
        obj.insert("lines".into(), json!(lines));
        obj.insert("count".into(), json!(items.len()));
    }
    Ok(v)
}
