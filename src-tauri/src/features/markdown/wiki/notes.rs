//! NOTES.md alias maintenance: title renames keep old `[[...]]` links
//! resolving by appending the new title to frontmatter aliases.

use std::fs;
use std::path::Path;

/// Append the new title to NOTES.md frontmatter aliases (best-effort; keeps
/// old aliases so existing `[[...]]` links keep resolving).
pub(crate) fn append_title_alias_best_effort(vault_root: &Path, rel_path: &str, title: &str) {
    use crate::features::wiki::frontmatter as fm;
    let notes_path = vault_root.join(rel_path).join("NOTES.md");
    let Ok(body) = fs::read_to_string(&notes_path) else {
        return;
    };
    let (frontmatter_end, existing) = fm::parse_frontmatter_aliases(&body);
    if existing.iter().any(|a| a == title) {
        return;
    }
    let mut merged = existing;
    merged.push(title.to_string());
    let next = if merged.len() >= 2 {
        fm::patch_aliases(&body, &merged)
    } else if frontmatter_end == 0 {
        fm::prepend_new_aliases(&body, &merged)
    } else {
        return;
    };
    if let Ok(next) = next {
        let _ = fs::write(&notes_path, next);
    }
}
