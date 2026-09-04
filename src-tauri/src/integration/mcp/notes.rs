//! `{paper}/NOTES.md` get/write with YAML frontmatter protection.

use crate::core::error::AppError;
use crate::core::fs::{atomic_write, sanitize_vault_rel};
use std::fs;
use std::path::{Path, PathBuf};

pub fn notes_rel(paper_path: &str) -> Result<String, AppError> {
    let paper = sanitize_vault_rel(paper_path).map_err(AppError::message)?;
    Ok(format!("{paper}/NOTES.md"))
}

pub fn notes_abs(vault: &Path, paper_path: &str) -> Result<PathBuf, AppError> {
    let rel = notes_rel(paper_path)?;
    let mut abs = vault.to_path_buf();
    for part in rel.split('/') {
        abs.push(part);
    }
    Ok(abs)
}

pub fn read_notes(vault: &Path, paper_path: &str) -> Result<String, AppError> {
    let path = notes_abs(vault, paper_path)?;
    if !path.is_file() {
        return Ok(String::new());
    }
    Ok(fs::read_to_string(&path)?)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteMode {
    Replace,
    Append,
}

pub fn write_notes(
    vault: &Path,
    paper_path: &str,
    paper_id: &str,
    content: &str,
    mode: WriteMode,
) -> Result<(), AppError> {
    let path = notes_abs(vault, paper_path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let existing = if path.is_file() {
        fs::read_to_string(&path).unwrap_or_default()
    } else {
        String::new()
    };
    let next = match mode {
        WriteMode::Append => append_notes(&existing, paper_id, content),
        WriteMode::Replace => replace_notes(&existing, paper_id, content),
    };
    atomic_write(&path, next.as_bytes()).map_err(AppError::from)
}

fn default_frontmatter(paper_id: &str) -> String {
    let id = paper_id.trim();
    if id.is_empty() {
        "---\naliases: []\n---\n".into()
    } else {
        format!("---\naliases: [{id}]\n---\n")
    }
}

fn has_frontmatter(md: &str) -> bool {
    !split_off_frontmatter(md).0.is_empty()
}

fn replace_notes(existing: &str, paper_id: &str, content: &str) -> String {
    if has_frontmatter(content) {
        return normalize_trailing(content);
    }
    let (front, _) = split_off_frontmatter(existing);
    let front = if front.is_empty() {
        default_frontmatter(paper_id)
    } else {
        front
    };
    join_front_body(&front, content)
}

fn append_notes(existing: &str, paper_id: &str, content: &str) -> String {
    if existing.trim().is_empty() {
        return replace_notes("", paper_id, content);
    }
    let (front, body) = split_off_frontmatter(existing);
    let extra = content.trim_end();
    if extra.is_empty() {
        return existing.to_string();
    }
    let mut body = body.trim_end().to_string();
    if !body.is_empty() {
        body.push_str("\n\n");
    }
    body.push_str(extra);
    body.push('\n');
    if front.is_empty() {
        body
    } else {
        join_front_body(&front, &body)
    }
}

fn join_front_body(front: &str, body: &str) -> String {
    let front = front.trim_end();
    let body = body.trim_start_matches(['\r', '\n']);
    if body.is_empty() {
        format!("{front}\n")
    } else {
        format!("{front}\n\n{}\n", body.trim_end())
    }
}

fn normalize_trailing(md: &str) -> String {
    let mut s = md.to_string();
    if !s.ends_with('\n') {
        s.push('\n');
    }
    s
}

/// Split a document into (frontmatter including fences, rest). Empty front when
/// the file has no YAML block.
pub fn split_off_frontmatter(md: &str) -> (String, String) {
    let trimmed = md.trim_start_matches('\u{feff}');
    let lead_len = md.len() - trimmed.len();
    let Some(rest) = trimmed.strip_prefix("---") else {
        return (String::new(), md.to_string());
    };
    let Some(rest2) = rest.strip_prefix(['\n', '\r']) else {
        return (String::new(), md.to_string());
    };
    let mut search = rest2;
    loop {
        if let Some(after) = search.strip_prefix("---") {
            if after.is_empty() || after.starts_with('\n') || after.starts_with('\r') {
                let split = md.len() - after.len();
                let (front, body) = md.split_at(split);
                return (
                    format!("{}{front}", &md[..lead_len]),
                    body.trim_start_matches(['\r', '\n']).to_string(),
                );
            }
        }
        let Some(idx) = search.find("\n---") else {
            return (String::new(), md.to_string());
        };
        let after = &search[idx + 4..];
        if after.is_empty() || after.starts_with('\n') || after.starts_with('\r') {
            let split = md.len() - after.len();
            let (front, body) = md.split_at(split);
            return (
                format!("{}{front}", &md[..lead_len]),
                body.trim_start_matches(['\r', '\n']).to_string(),
            );
        }
        search = after;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn replace_keeps_existing_frontmatter() {
        let existing = "---\naliases: [old]\n---\n\n# Old\n";
        let out = replace_notes(existing, "x", "# New\n");
        assert!(out.starts_with("---\naliases: [old]\n---"), "{out}");
        assert!(out.contains("# New"), "{out}");
        assert!(!out.contains("# Old"), "{out}");
    }

    #[test]
    fn replace_with_frontmatter_wins() {
        let existing = "---\naliases: [old]\n---\n\n# Old\n";
        let out = replace_notes(existing, "x", "---\naliases: [new]\n---\n\n# New\n");
        assert!(out.contains("aliases: [new]"), "{out}");
        assert!(!out.contains("aliases: [old]"), "{out}");
    }

    #[test]
    fn append_keeps_frontmatter_and_body() {
        let existing = "---\naliases: [a]\n---\n\n# Keep\n";
        let out = append_notes(existing, "a", "more notes");
        assert!(out.contains("aliases: [a]"), "{out}");
        assert!(out.contains("# Keep"), "{out}");
        assert!(out.contains("more notes"), "{out}");
    }

    #[test]
    fn rejects_parent_escape() {
        let dir = tempdir().unwrap();
        let err = notes_abs(dir.path(), "../etc").unwrap_err();
        assert!(err.to_string().contains("escapes") || err.to_string().contains("path"));
    }

    #[test]
    fn write_roundtrip() {
        let dir = tempdir().unwrap();
        let paper = dir.path().join("papers").join("p1");
        fs::create_dir_all(&paper).unwrap();
        write_notes(dir.path(), "papers/p1", "p1", "# Hello", WriteMode::Replace).unwrap();
        let got = read_notes(dir.path(), "papers/p1").unwrap();
        assert!(got.contains("aliases: [p1]"), "{got}");
        assert!(got.contains("# Hello"), "{got}");
        write_notes(dir.path(), "papers/p1", "p1", "tail", WriteMode::Append).unwrap();
        let got = read_notes(dir.path(), "papers/p1").unwrap();
        assert!(got.contains("# Hello"), "{got}");
        assert!(got.contains("tail"), "{got}");
    }
}
