//! Pre-parse rewrite: `agentero <dir>` → `agentero open <dir>`.
//!
//! Known subcommands always win. Only a single bare path-like argument (not a
//! known command name) is rewritten so clap keeps normal parsing for everything
//! else.

use std::ffi::{OsStr, OsString};
use std::path::Path;

/// Subcommand names accepted by the CLI (must stay in sync with `Commands`).
const KNOWN_COMMANDS: &[&str] = &[
    "file",
    "vault",
    "tree",
    "paper",
    "import",
    "export",
    "doctor",
    "layout",
    "mark",
    "translate",
    "open",
    "help",
];

/// Rewrite `agentero <path>` into `agentero open <path>` when safe.
///
/// `args` is the full argv including program name at index 0.
pub fn rewrite_path_shorthand(args: Vec<OsString>) -> Vec<OsString> {
    if args.len() < 2 {
        return args;
    }
    let Some(first_pos) = first_positional_index(&args[1..]) else {
        return args;
    };
    // first_pos is relative to args[1..]
    let abs_idx = first_pos + 1;
    let candidate = &args[abs_idx];
    let Some(text) = candidate.to_str() else {
        return args;
    };
    if is_known_command(text) {
        return args;
    }
    if !looks_like_path(text) {
        return args;
    }
    // Only rewrite when this is the sole positional (no extra bare words).
    // Flags after the path are fine (`agentero . --json`).
    if has_extra_positionals(&args[1..], first_pos) {
        return args;
    }
    let mut out = Vec::with_capacity(args.len() + 1);
    out.extend_from_slice(&args[..abs_idx]);
    out.push(OsString::from("open"));
    out.extend_from_slice(&args[abs_idx..]);
    out
}

fn is_known_command(name: &str) -> bool {
    KNOWN_COMMANDS.iter().any(|c| c.eq_ignore_ascii_case(name))
}

fn looks_like_path(text: &str) -> bool {
    if text.is_empty() {
        return false;
    }
    if text == "." || text == ".." || text == "~" {
        return true;
    }
    if text.starts_with("./")
        || text.starts_with("../")
        || text.starts_with("~/")
        || text.starts_with('/')
        || text.starts_with('\\')
    {
        return true;
    }
    // Windows drive path
    let bytes = text.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        return true;
    }
    if text.contains('/') || text.contains('\\') {
        return true;
    }
    // Bare name that already exists as a directory (e.g. `agentero myvault`).
    Path::new(text).is_dir()
}

/// Index of the first non-option argument in `args` (slice without program name).
fn first_positional_index(args: &[OsString]) -> Option<usize> {
    let mut i = 0;
    while i < args.len() {
        let s = args[i].to_string_lossy();
        if s == "--" {
            return Some(i + 1).filter(|&j| j < args.len());
        }
        if s.starts_with('-') {
            if takes_value_flag(OsStr::new(s.as_ref())) {
                // `--flag=value` consumes one slot; bare `--flag` may take next.
                if !s.contains('=') {
                    i += 2;
                    continue;
                }
            }
            i += 1;
            continue;
        }
        return Some(i);
    }
    None
}

fn takes_value_flag(flag: &OsStr) -> bool {
    let s = flag.to_string_lossy();
    matches!(
        s.as_ref(),
        "-v" | "--vault" | "--output" | "--color" | "--translator-url" | "-C" // reserved
    ) || s.starts_with("--vault=")
        || s.starts_with("--output=")
        || s.starts_with("--color=")
        || s.starts_with("--translator-url=")
}

fn has_extra_positionals(args: &[OsString], first_pos: usize) -> bool {
    let mut i = first_pos + 1;
    while i < args.len() {
        let s = args[i].to_string_lossy();
        if s == "--" {
            return i + 1 < args.len();
        }
        if s.starts_with('-') {
            if takes_value_flag(OsStr::new(s.as_ref())) && !s.contains('=') {
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(args: &[&str]) -> Vec<OsString> {
        args.iter().map(OsString::from).collect()
    }

    fn as_str(args: &[OsString]) -> Vec<String> {
        args.iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn rewrites_dot_to_open() {
        let out = rewrite_path_shorthand(os(&["agentero", "."]));
        assert_eq!(as_str(&out), vec!["agentero", "open", "."]);
    }

    #[test]
    fn rewrites_absolute_path() {
        let out = rewrite_path_shorthand(os(&["agentero", "/tmp/research"]));
        assert_eq!(as_str(&out), vec!["agentero", "open", "/tmp/research"]);
    }

    #[test]
    fn leaves_known_subcommands() {
        let out = rewrite_path_shorthand(os(&["agentero", "paper", "list"]));
        assert_eq!(as_str(&out), vec!["agentero", "paper", "list"]);
    }

    #[test]
    fn leaves_translate_subcommand() {
        let out = rewrite_path_shorthand(os(&["agentero", "translate", "hello"]));
        assert_eq!(as_str(&out), vec!["agentero", "translate", "hello"]);
    }

    #[test]
    fn leaves_vault_flag_then_command() {
        let out = rewrite_path_shorthand(os(&["agentero", "--vault", "/v", "paper", "list"]));
        assert_eq!(
            as_str(&out),
            vec!["agentero", "--vault", "/v", "paper", "list"]
        );
    }

    #[test]
    fn rewrites_path_with_trailing_json_flag() {
        let out = rewrite_path_shorthand(os(&["agentero", "./vault", "--json"]));
        assert_eq!(as_str(&out), vec!["agentero", "open", "./vault", "--json"]);
    }

    #[test]
    fn does_not_rewrite_multi_positionals() {
        let out = rewrite_path_shorthand(os(&["agentero", "./a", "extra"]));
        assert_eq!(as_str(&out), vec!["agentero", "./a", "extra"]);
    }

    #[test]
    fn does_not_rewrite_bare_unknown_word() {
        let out = rewrite_path_shorthand(os(&["agentero", "notacommand"]));
        assert_eq!(as_str(&out), vec!["agentero", "notacommand"]);
    }
}
