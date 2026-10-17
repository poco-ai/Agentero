//! Vault text operations shared with MCP.

use crate::error::CliError;
use crate::output::to_value;
use crate::resolve::{resolve_vault, GlobalOpts};
use agentero_core::features::vault::files::{self, WriteMode};
use clap::Subcommand;
use serde_json::Value;

#[derive(Debug, Subcommand)]
pub enum FileCmd {
    /// List one vault directory (default: vault root).
    List {
        #[arg(default_value = "")]
        path: String,
        #[arg(long, default_value_t = 200)]
        limit: usize,
    },
    /// Read one vault-relative UTF-8 text file (up to 2 MiB).
    Read { path: String },
    /// Write UTF-8 text atomically; use `paper notes write` for NOTES.md.
    Write {
        path: String,
        content: String,
        /// Append instead of replacing the file.
        #[arg(long)]
        append: bool,
    },
}

pub fn run(cmd: FileCmd, globals: &GlobalOpts) -> Result<Value, CliError> {
    let vault = resolve_vault(globals)?;
    match cmd {
        FileCmd::List { path, limit } => {
            to_value(&files::list_dir(&vault, &path, limit.clamp(1, 500))?)
        }
        FileCmd::Read { path } => to_value(&files::read_text(&vault, &path)?),
        FileCmd::Write {
            path,
            content,
            append,
        } => to_value(&files::write_text(
            &vault,
            &path,
            &content,
            if append {
                WriteMode::Append
            } else {
                WriteMode::Replace
            },
        )?),
    }
}
