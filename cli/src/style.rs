//! ANSI styling for human text output.
//!
//! JSON mode never uses this module. Text mode only paints when
//! styling is true (`--color always`, or `auto` + TTY, and not
//! `NO_COLOR` / `--color never`).

use std::io::{self, IsTerminal};

/// Resolved paint switch for one CLI invocation.
#[derive(Debug, Clone, Copy)]
pub struct Style {
    enabled: bool,
}

impl Style {
    pub fn new(enabled: bool) -> Self {
        Self { enabled }
    }

    /// Resolve from CLI `--color` + env + whether stdout is a TTY.
    pub fn from_when(when: ColorWhen) -> Self {
        let enabled = match when {
            ColorWhen::Always => true,
            ColorWhen::Never => false,
            ColorWhen::Auto => {
                if std::env::var_os("NO_COLOR").is_some() {
                    false
                } else if matches!(
                    std::env::var("CLICOLOR_FORCE").as_deref(),
                    Ok(v) if v != "0" && !v.is_empty()
                ) {
                    true
                } else if matches!(std::env::var("CLICOLOR").as_deref(), Ok("0")) {
                    false
                } else {
                    io::stdout().is_terminal()
                }
            }
        };
        Self { enabled }
    }

    fn paint(self, code: &str, s: &str) -> String {
        if !self.enabled || s.is_empty() {
            return s.to_string();
        }
        format!("\x1b[{code}m{s}\x1b[0m")
    }

    pub fn bold(self, s: &str) -> String {
        self.paint("1", s)
    }

    pub fn dim(self, s: &str) -> String {
        self.paint("2", s)
    }

    pub fn cyan(self, s: &str) -> String {
        self.paint("36", s)
    }

    pub fn bright_red(self, s: &str) -> String {
        self.paint("91", s)
    }

    pub fn bright_green(self, s: &str) -> String {
        self.paint("92", s)
    }

    /// Vault-relative path (secondary).
    pub fn path(self, s: &str) -> String {
        self.cyan(s)
    }

    /// Success / ok line.
    pub fn ok(self, s: &str) -> String {
        self.bright_green(s)
    }

    /// Error prefix for stderr.
    pub fn error_label(self, s: &str) -> String {
        self.bright_red(&self.bold(s))
    }

    /// Key in `key=value` style lines.
    pub fn key(self, s: &str) -> String {
        self.dim(s)
    }
}

/// Mirrors CLI `--color` without depending on clap here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorWhen {
    Auto,
    Always,
    Never,
}
