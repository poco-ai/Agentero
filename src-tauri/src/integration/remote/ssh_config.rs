//! Parse `~/.ssh/config` Host entries for the remote-connect dialog (#339).
//!
//! Connection itself already goes through system OpenSSH (see `sftp_fs.rs`),
//! so this module only surfaces aliases + known fields as suggestions.

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const MAX_INCLUDE_DEPTH: usize = 8;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigHost {
    pub alias: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
}

/// Host entries from `~/.ssh/config` (with `Include` expansion), in file order.
/// Wildcard-only patterns (`*`, `?`) are skipped; missing/unreadable files yield `[]`.
pub fn ssh_config_hosts() -> Vec<SshConfigHost> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let path = home.join(".ssh").join("config");
    let mut entries: Vec<(String, SshConfigHost)> = Vec::new();
    parse_file(&path, &home, 0, &mut entries);
    entries.into_iter().map(|(_, h)| h).collect()
}

fn parse_file(path: &Path, home: &Path, depth: usize, out: &mut Vec<(String, SshConfigHost)>) {
    if depth > MAX_INCLUDE_DEPTH {
        return;
    }
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    // First value wins per ssh semantics; track per alias across blocks.
    let mut seen: HashMap<String, (bool, bool, bool)> = HashMap::new();
    let mut aliases: Vec<String> = Vec::new();
    for raw in text.lines() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let (keyword, arg) = match split_keyword(line) {
            Some(kv) => kv,
            None => continue,
        };
        let kw = keyword.to_ascii_lowercase();
        match kw.as_str() {
            "include" => {
                for inc in resolve_include(arg, path, home) {
                    parse_file(&inc, home, depth + 1, out);
                }
            }
            "host" => {
                aliases = arg
                    .split_whitespace()
                    .filter(|p| !p.starts_with('!'))
                    .filter(|p| !p.contains('*') && !p.contains('?'))
                    .map(str::to_string)
                    .collect();
            }
            "user" | "hostname" | "port" => {
                for alias in &aliases {
                    let entry = find_or_insert(out, alias);
                    let flags = seen.entry(alias.clone()).or_insert((false, false, false));
                    match kw.as_str() {
                        "user" => {
                            if !flags.0 {
                                entry.user = Some(arg.to_string());
                                flags.0 = true;
                            }
                        }
                        "hostname" => {
                            if !flags.1 {
                                entry.hostname = Some(arg.to_string());
                                flags.1 = true;
                            }
                        }
                        _ => {
                            if !flags.2 {
                                if let Ok(p) = arg.parse() {
                                    entry.port = Some(p);
                                }
                                flags.2 = true;
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

fn find_or_insert<'a>(
    out: &'a mut Vec<(String, SshConfigHost)>,
    alias: &str,
) -> &'a mut SshConfigHost {
    if let Some(pos) = out.iter().position(|(a, _)| a == alias) {
        return &mut out[pos].1;
    }
    out.push((
        alias.to_string(),
        SshConfigHost {
            alias: alias.to_string(),
            user: None,
            hostname: None,
            port: None,
        },
    ));
    &mut out.last_mut().expect("just pushed").1
}

/// Split `Keyword arg` or `Keyword=arg` (both separators allowed by OpenSSH).
fn split_keyword(line: &str) -> Option<(&str, &str)> {
    if let Some(eq) = line.find('=') {
        let kw_end = line[..eq].trim_end().len();
        let kw = &line[..kw_end];
        if !kw.is_empty() && !kw.contains(char::is_whitespace) {
            return Some((kw, line[eq + 1..].trim()));
        }
        return None;
    }
    let kw_end = line.find(char::is_whitespace).unwrap_or(line.len());
    let kw = &line[..kw_end];
    if kw.is_empty() {
        return None;
    }
    Some((kw, line[kw_end..].trim()))
}

/// Resolve an `Include` argument: `~` expansion, relative-to-config-dir, and
/// simple `*`/`?` glob expansion against the parent directory.
fn resolve_include(arg: &str, config_path: &Path, home: &Path) -> Vec<PathBuf> {
    let expanded = if let Some(rest) = arg.strip_prefix("~/") {
        home.join(rest)
    } else if arg == "~" {
        return Vec::new();
    } else {
        let p = PathBuf::from(arg);
        if p.is_absolute() {
            p
        } else {
            match config_path.parent() {
                Some(dir) => dir.join(p),
                None => p,
            }
        }
    };
    let s = expanded.to_string_lossy();
    if !s.contains('*') && !s.contains('?') {
        return vec![expanded];
    }
    let Some(parent) = expanded.parent() else {
        return Vec::new();
    };
    let Some(name_pattern) = expanded.file_name().and_then(|n| n.to_str()) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(parent) else {
        return Vec::new();
    };
    let mut matches: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| glob_match(name_pattern, n))
        })
        .collect();
    matches.sort();
    matches
}

/// Minimal `*` / `?` wildcard match for Include file names.
fn glob_match(pattern: &str, name: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let n: Vec<char> = name.chars().collect();
    fn rec(p: &[char], n: &[char]) -> bool {
        match p.first() {
            None => n.is_empty(),
            Some('*') => {
                let rest = &p[1..];
                (0..=n.len()).any(|i| rec(rest, &n[i..]))
            }
            Some(&pc) => {
                if let Some(&nc) = n.first() {
                    if pc == '?' || pc == nc {
                        return rec(&p[1..], &n[1..]);
                    }
                }
                false
            }
        }
    }
    rec(&p, &n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("agentero-ssh-config-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, content: &str) {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    #[test]
    fn parses_hosts_with_fields() {
        let dir = temp_dir();
        let cfg = dir.join("config");
        write(
            &cfg,
            r#"
# comment
Host dgx
    HostName 10.0.1.5
    User phil
    Port 2222

Host lab-gpu lab-gpu2
    user=alice
    HostName lab.example.com

Host wild* ?ump
    User nobody
"#,
        );
        let mut out = Vec::new();
        parse_file(&cfg, &dir, 0, &mut out);
        let hosts: Vec<SshConfigHost> = out.into_iter().map(|(_, h)| h).collect();
        assert_eq!(
            hosts,
            vec![
                SshConfigHost {
                    alias: "dgx".into(),
                    user: Some("phil".into()),
                    hostname: Some("10.0.1.5".into()),
                    port: Some(2222),
                },
                SshConfigHost {
                    alias: "lab-gpu".into(),
                    user: Some("alice".into()),
                    hostname: Some("lab.example.com".into()),
                    port: None,
                },
                SshConfigHost {
                    alias: "lab-gpu2".into(),
                    user: Some("alice".into()),
                    hostname: Some("lab.example.com".into()),
                    port: None,
                },
            ]
        );
    }

    #[test]
    fn first_value_wins_across_blocks() {
        let dir = temp_dir();
        let cfg = dir.join("config");
        write(
            &cfg,
            "Host box\n  User first\n\nHost *\n  User fallback\n\nHost box\n  User second\n  Port 2200\n",
        );
        let mut out = Vec::new();
        parse_file(&cfg, &dir, 0, &mut out);
        assert_eq!(out.len(), 1);
        let (_, h) = &out[0];
        assert_eq!(h.user.as_deref(), Some("first"));
        assert_eq!(h.port, Some(2200));
    }

    #[test]
    fn expands_include_with_glob() {
        let dir = temp_dir();
        let ssh_dir = dir.join(".ssh");
        write(
            &ssh_dir.join("config"),
            "Host main\n  User root\nInclude config.d/*\n",
        );
        write(
            &ssh_dir.join("config.d/extra.conf"),
            "Host extra\n  HostName e.local\n",
        );
        write(&ssh_dir.join("config.d/README"), "not parsed\n");
        let mut out = Vec::new();
        parse_file(&ssh_dir.join("config"), &dir, 0, &mut out);
        let aliases: Vec<&str> = out.iter().map(|(a, _)| a.as_str()).collect();
        assert_eq!(aliases, vec!["main", "extra"]);
    }

    #[test]
    fn glob_match_basics() {
        assert!(glob_match("*", "anything"));
        assert!(glob_match("*.conf", "a.conf"));
        assert!(!glob_match("*.conf", "a.txt"));
        assert!(glob_match("c?nf", "conf"));
        assert!(!glob_match("c?nf", "coonf"));
    }
}
