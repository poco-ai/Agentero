//! Interactive prompts via `inquire` (Inquirer-style).
//!
//! Interaction rules:
//! - Never prompt in `--json` / machine mode.
//! - Destructive confirms: `-y` auto-approves; non-TTY without `-y` → `needs_confirmation`.
//! - Prompts only when stdin is a TTY.

use crate::error::CliError;
use crate::output::OutputFormat;
use crate::resolve::GlobalOpts;
use inquire::{Confirm, InquireError, Select};
use std::io::{stdin, IsTerminal};

/// True when interactive prompts are allowed.
pub fn allows_interactive(globals: &GlobalOpts) -> bool {
    !globals.no_input && !matches!(globals.format, OutputFormat::Json) && stdin().is_terminal()
}

/// Confirm a yes/no question.
///
/// - `globals.yes` → always true (no prompt)
/// - interactive TTY → `inquire::Confirm`
/// - otherwise → `needs_confirmation` error
pub fn confirm(globals: &GlobalOpts, message: &str, default: bool) -> Result<bool, CliError> {
    if globals.yes {
        return Ok(true);
    }
    if !allows_interactive(globals) {
        return Err(CliError::needs_confirmation(format!(
            "{message} (pass --yes to skip confirmation)"
        )));
    }
    Confirm::new(message)
        .with_default(default)
        .prompt()
        .map_err(map_inquire)
}

/// Select one option from a list (interactive only).
///
/// Returns `None` when interaction is not allowed (caller should fall back to error).
pub fn select_one(
    globals: &GlobalOpts,
    message: &str,
    options: Vec<String>,
) -> Result<Option<String>, CliError> {
    if options.is_empty() {
        return Ok(None);
    }
    if options.len() == 1 {
        return Ok(Some(options.into_iter().next().expect("len 1")));
    }
    if !allows_interactive(globals) {
        return Ok(None);
    }
    let choice = Select::new(message, options)
        .with_page_size(12)
        .prompt()
        .map_err(map_inquire)?;
    Ok(Some(choice))
}

fn map_inquire(err: InquireError) -> CliError {
    match err {
        InquireError::OperationCanceled | InquireError::OperationInterrupted => {
            CliError::needs_confirmation("operation cancelled")
        }
        InquireError::NotTTY => CliError::needs_confirmation(
            "interactive prompt requires a TTY (pass --yes or use --json)",
        ),
        other => CliError::message(format!("prompt failed: {other}")),
    }
}
