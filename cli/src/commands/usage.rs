//! `agentero usage *` — device-local activity log in XDG `usage.sqlite`.

use crate::error::CliError;
use crate::resolve::{resolve_vault, GlobalOpts};
use agentero_lib::core::usage::{
    clear_all, clear_vault, list_events, since_rfc3339_days, summarize, usage_db_path, ListFilter,
};
use clap::{Subcommand, ValueHint};
use serde_json::{json, Value};

#[derive(Debug, Subcommand)]
pub enum UsageCmd {
    /// Print the usage database path.
    Which,
    /// Recent events (newest first).
    Timeline {
        #[arg(long)]
        kind: Option<String>,
        /// Vault-relative path or prefix.
        #[arg(long, value_hint = ValueHint::AnyPath)]
        path: Option<String>,
        #[arg(long, default_value_t = 30)]
        days: u32,
        #[arg(long, default_value_t = 50)]
        limit: usize,
        /// Do not filter to the current vault.
        #[arg(long)]
        all_vaults: bool,
    },
    /// Counts by kind.
    Summary {
        #[arg(long, default_value_t = 30)]
        days: u32,
        #[arg(long)]
        all_vaults: bool,
    },
    /// Delete recorded events.
    Clear {
        /// Only this vault (default: current `--vault`).
        #[arg(long)]
        all: bool,
    },
}

pub fn run(cmd: UsageCmd, globals: &GlobalOpts) -> Result<Value, CliError> {
    match cmd {
        UsageCmd::Which => Ok(json!({
            "path": usage_db_path().display().to_string(),
            "lines": [usage_db_path().display().to_string()],
        })),
        UsageCmd::Timeline {
            kind,
            path,
            days,
            limit,
            all_vaults,
        } => timeline(globals, kind, path, days, limit, all_vaults),
        UsageCmd::Summary { days, all_vaults } => summary(globals, days, all_vaults),
        UsageCmd::Clear { all } => clear(globals, all),
    }
}

fn vault_filter(globals: &GlobalOpts, all_vaults: bool) -> Result<Option<String>, CliError> {
    if all_vaults {
        return Ok(None);
    }
    Ok(Some(resolve_vault(globals)?.to_string_lossy().into_owned()))
}

fn timeline(
    globals: &GlobalOpts,
    kind: Option<String>,
    path: Option<String>,
    days: u32,
    limit: usize,
    all_vaults: bool,
) -> Result<Value, CliError> {
    let vault = vault_filter(globals, all_vaults)?;
    let rows = list_events(
        &usage_db_path(),
        &ListFilter {
            vault,
            kind,
            path_prefix: path,
            since: Some(since_rfc3339_days(days)),
            limit,
        },
    )?;
    let lines: Vec<String> = rows
        .iter()
        .map(|row| {
            format!(
                "{}  {}  {}",
                globals.style.dim(&row.ts),
                row.kind,
                row.path.as_deref().unwrap_or("-")
            )
        })
        .collect();
    Ok(json!({ "events": rows, "lines": lines }))
}

fn summary(globals: &GlobalOpts, days: u32, all_vaults: bool) -> Result<Value, CliError> {
    let vault = vault_filter(globals, all_vaults)?;
    let rows = summarize(
        &usage_db_path(),
        vault.as_deref(),
        Some(&since_rfc3339_days(days)),
    )?;
    let lines: Vec<String> = rows
        .iter()
        .map(|row| format!("{:>5}  {}  {}ms", row.count, row.kind, row.dur_ms))
        .collect();
    Ok(json!({ "kinds": rows, "lines": lines }))
}

fn clear(globals: &GlobalOpts, all: bool) -> Result<Value, CliError> {
    let n = if all {
        if !crate::prompt::confirm(globals, "Delete all device activity history?", false)? {
            return Ok(json!({ "cleared": 0, "cancelled": true, "lines": ["cancelled"] }));
        }
        clear_all(&usage_db_path())?
    } else {
        let vault = resolve_vault(globals)?;
        let msg = format!("Delete activity history for {}?", vault.display());
        if !crate::prompt::confirm(globals, &msg, false)? {
            return Ok(json!({ "cleared": 0, "cancelled": true, "lines": ["cancelled"] }));
        }
        clear_vault(&usage_db_path(), &vault.to_string_lossy())?
    };
    Ok(json!({
        "cleared": n,
        "lines": [format!("cleared {n} events")],
    }))
}
