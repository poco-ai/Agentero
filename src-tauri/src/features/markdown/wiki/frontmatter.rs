//! Minimal, byte-preserving support for Obsidian-style frontmatter `aliases`.
//!
//! Wiki indexing only needs to read aliases. Doctor additionally needs a safe
//! edit range so it can add or replace one simple property without reserializing
//! user-authored YAML, comments, key order, or unrelated whitespace.

use std::ops::Range;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AliasEdit {
    /// No frontmatter exists; prepend a new block.
    Prepend,
    /// Frontmatter exists but has no `aliases`; insert before its closing fence.
    Insert { offset: usize },
    /// Replace the exact simple `aliases` property.
    Replace { range: Range<usize> },
    /// The document can still be indexed, but Doctor must not rewrite it.
    Unsupported { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AliasFrontmatterInspection {
    pub frontmatter_end: usize,
    pub aliases: Vec<String>,
    pub edit: AliasEdit,
}

#[derive(Debug, Clone, Copy)]
struct SourceLine<'a> {
    start: usize,
    content: &'a str,
    end: usize,
}

fn source_lines(markdown: &str) -> Vec<SourceLine<'_>> {
    let mut lines = Vec::new();
    let mut offset = 0usize;
    for raw in markdown.split_inclusive('\n') {
        let without_lf = raw.strip_suffix('\n').unwrap_or(raw);
        let content = without_lf.strip_suffix('\r').unwrap_or(without_lf);
        let end = offset + raw.len();
        lines.push(SourceLine {
            start: offset,
            content,
            end,
        });
        offset = end;
    }
    if markdown.is_empty() {
        return lines;
    }
    if offset < markdown.len() {
        lines.push(SourceLine {
            start: offset,
            content: &markdown[offset..],
            end: markdown.len(),
        });
    }
    lines
}

fn normalize_alias(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn push_unique(out: &mut Vec<String>, value: String) {
    if value.trim().is_empty() {
        return;
    }
    let key = normalize_alias(&value);
    if out.iter().any(|current| normalize_alias(current) == key) {
        return;
    }
    out.push(value);
}

fn unquote_scalar(raw: &str) -> Result<String, String> {
    let value = raw.trim();
    if value.is_empty() {
        return Err("aliases contains an empty item".into());
    }
    if value.starts_with('"') {
        return serde_json::from_str::<String>(value)
            .map_err(|_| "aliases contains an unsupported quoted value".into());
    }
    if value.starts_with('\'') {
        if !value.ends_with('\'') || value.len() < 2 {
            return Err("aliases contains an unterminated quoted value".into());
        }
        return Ok(value[1..value.len() - 1].replace("''", "'"));
    }
    if value.contains(['#', '{', '}', '[', ']']) {
        return Err("aliases contains YAML syntax that requires manual review".into());
    }
    Ok(value.to_string())
}

fn split_inline_items(raw: &str) -> Result<Vec<String>, String> {
    let mut items = Vec::new();
    let mut start = 0usize;
    let mut quote = None;
    let mut escaped = false;
    for (index, ch) in raw.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if quote == Some('"') && ch == '\\' {
            escaped = true;
            continue;
        }
        match quote {
            Some(active) if ch == active => quote = None,
            Some(_) => {}
            None if ch == '\'' || ch == '"' => quote = Some(ch),
            None if ch == ',' => {
                items.push(unquote_scalar(&raw[start..index])?);
                start = index + ch.len_utf8();
            }
            None => {}
        }
    }
    if quote.is_some() {
        return Err("aliases inline list has an unterminated quote".into());
    }
    if !raw[start..].trim().is_empty() {
        items.push(unquote_scalar(&raw[start..])?);
    }
    Ok(items)
}

fn unsupported(frontmatter_end: usize, reason: impl Into<String>) -> AliasFrontmatterInspection {
    AliasFrontmatterInspection {
        frontmatter_end,
        aliases: Vec::new(),
        edit: AliasEdit::Unsupported {
            reason: reason.into(),
        },
    }
}

pub fn inspect_aliases(markdown: &str) -> AliasFrontmatterInspection {
    let lines = source_lines(markdown);
    let Some(first) = lines.first() else {
        return AliasFrontmatterInspection {
            frontmatter_end: 0,
            aliases: Vec::new(),
            edit: AliasEdit::Prepend,
        };
    };
    if first.content.trim() != "---" {
        return AliasFrontmatterInspection {
            frontmatter_end: 0,
            aliases: Vec::new(),
            edit: AliasEdit::Prepend,
        };
    }

    let Some((closing_index, closing)) = lines
        .iter()
        .enumerate()
        .skip(1)
        .find(|(_, line)| matches!(line.content.trim(), "---" | "..."))
    else {
        return unsupported(0, "frontmatter closing fence is missing");
    };
    let frontmatter_end = closing.end;

    let mut alias_index = None;
    for (index, line) in lines.iter().enumerate().take(closing_index).skip(1) {
        if line.content.starts_with(char::is_whitespace) {
            continue;
        }
        if line.content.starts_with("aliases:") {
            if alias_index.replace(index).is_some() {
                return unsupported(frontmatter_end, "frontmatter has duplicate aliases keys");
            }
            continue;
        }
        let lowered = line.content.to_lowercase();
        if lowered.starts_with("aliases")
            || lowered.starts_with("'aliases'")
            || lowered.starts_with("\"aliases\"")
        {
            return unsupported(frontmatter_end, "aliases key uses unsupported YAML syntax");
        }
    }

    let Some(index) = alias_index else {
        return AliasFrontmatterInspection {
            frontmatter_end,
            aliases: Vec::new(),
            edit: AliasEdit::Insert {
                offset: closing.start,
            },
        };
    };
    let alias_line = lines[index];
    let value = alias_line
        .content
        .strip_prefix("aliases:")
        .unwrap_or_default()
        .trim();

    if value.starts_with('[') {
        if !value.ends_with(']') {
            return unsupported(frontmatter_end, "aliases inline list is not closed");
        }
        let parsed = match split_inline_items(&value[1..value.len() - 1]) {
            Ok(values) => values,
            Err(reason) => return unsupported(frontmatter_end, reason),
        };
        let mut aliases = Vec::new();
        for item in parsed {
            push_unique(&mut aliases, item);
        }
        return AliasFrontmatterInspection {
            frontmatter_end,
            aliases,
            edit: AliasEdit::Replace {
                range: alias_line.start..alias_line.end,
            },
        };
    }
    if !value.is_empty() {
        return unsupported(
            frontmatter_end,
            "aliases must be a block list or inline list",
        );
    }

    let mut aliases = Vec::new();
    let mut range_end = alias_line.end;
    for line in lines.iter().take(closing_index).skip(index + 1) {
        if line.content.trim().is_empty() {
            break;
        }
        if !line.content.starts_with(char::is_whitespace) {
            break;
        }
        let trimmed = line.content.trim_start();
        let Some(raw_item) = trimmed.strip_prefix("- ") else {
            return unsupported(
                frontmatter_end,
                "aliases block contains unsupported YAML syntax",
            );
        };
        let item = match unquote_scalar(raw_item) {
            Ok(value) => value,
            Err(reason) => return unsupported(frontmatter_end, reason),
        };
        push_unique(&mut aliases, item);
        range_end = line.end;
    }

    AliasFrontmatterInspection {
        frontmatter_end,
        aliases,
        edit: AliasEdit::Replace {
            range: alias_line.start..range_end,
        },
    }
}

fn newline_for(markdown: &str) -> &'static str {
    if markdown.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

fn render_aliases(
    aliases: &[String],
    newline: &str,
    minimum_distinct: usize,
) -> Result<String, String> {
    if aliases.len() < minimum_distinct {
        return Err(format!("at least {minimum_distinct} aliases are required"));
    }
    let mut unique = Vec::new();
    for alias in aliases {
        let trimmed = alias.trim();
        if trimmed.is_empty() {
            return Err("aliases cannot be empty".into());
        }
        push_unique(&mut unique, trimmed.to_string());
    }
    if unique.len() < minimum_distinct {
        return Err(format!(
            "at least {minimum_distinct} distinct aliases are required"
        ));
    }
    let mut out = format!("aliases:{newline}");
    for alias in unique {
        let quoted = serde_json::to_string(&alias).map_err(|error| error.to_string())?;
        out.push_str(&format!("  - {quoted}{newline}"));
    }
    Ok(out)
}

pub fn patch_aliases(markdown: &str, aliases: &[String]) -> Result<String, String> {
    let newline = newline_for(markdown);
    let rendered = render_aliases(aliases, newline, 2)?;
    let inspection = inspect_aliases(markdown);
    match inspection.edit {
        AliasEdit::Prepend => Ok(format!("---{newline}{rendered}---{newline}{markdown}")),
        AliasEdit::Insert { offset } => {
            let mut insert = rendered;
            if offset > 0 && !markdown[..offset].ends_with(['\n', '\r']) {
                insert.insert_str(0, newline);
            }
            let mut out = markdown.to_string();
            out.insert_str(offset, &insert);
            Ok(out)
        }
        AliasEdit::Replace { range } => {
            let mut out = markdown.to_string();
            out.replace_range(range, &rendered);
            Ok(out)
        }
        AliasEdit::Unsupported { reason } => Err(reason),
    }
}

/// Add a frontmatter block to a newly generated note. Unlike Doctor repair,
/// this permits one safe title alias when metadata cannot yield a short alias;
/// Doctor will surface that rare note for manual completion later.
pub fn prepend_new_aliases(markdown: &str, aliases: &[String]) -> Result<String, String> {
    let newline = newline_for(markdown);
    let rendered = render_aliases(aliases, newline, 1)?;
    Ok(format!("---{newline}{rendered}---{newline}{markdown}"))
}

/// Compatibility projection used by the Wiki extractor.
pub fn parse_frontmatter_aliases(markdown: &str) -> (usize, Vec<String>) {
    let inspection = inspect_aliases(markdown);
    (inspection.frontmatter_end, inspection.aliases)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_inline_and_block_aliases() {
        let inline = inspect_aliases("---\naliases: [Full Title, \"Short\"]\n---\n# Body\n");
        assert_eq!(inline.aliases, vec!["Full Title", "Short"]);

        let block = inspect_aliases(
            "---\r\ntitle: Keep\r\naliases:\r\n  - 'Full Title'\r\n  - Short\r\ntags: [x]\r\n---\r\n",
        );
        assert_eq!(block.aliases, vec!["Full Title", "Short"]);
    }

    #[test]
    fn patches_only_the_alias_property() {
        let source =
            "---\ntitle: Keep\naliases: [Old, Alias]\n# keep comment\ntags: [x]\n---\n# Body\n";
        let patched = patch_aliases(source, &["Full: Title".into(), "FT".into()]).unwrap();
        assert_eq!(
            patched,
            "---\ntitle: Keep\naliases:\n  - \"Full: Title\"\n  - \"FT\"\n# keep comment\ntags: [x]\n---\n# Body\n"
        );
    }

    #[test]
    fn inserts_or_prepends_without_touching_the_body() {
        let inserted = patch_aliases(
            "---\ntitle: Keep\n---\nBody\n",
            &["Full".into(), "Short".into()],
        )
        .unwrap();
        assert_eq!(
            inserted,
            "---\ntitle: Keep\naliases:\n  - \"Full\"\n  - \"Short\"\n---\nBody\n"
        );

        let prepended = patch_aliases("# Body\n", &["Full".into(), "Short".into()]).unwrap();
        assert_eq!(
            prepended,
            "---\naliases:\n  - \"Full\"\n  - \"Short\"\n---\n# Body\n"
        );
    }

    #[test]
    fn rejects_complex_or_broken_yaml_for_writes() {
        let complex = inspect_aliases("---\naliases: &names\n  - A\n---\n");
        assert!(matches!(complex.edit, AliasEdit::Unsupported { .. }));
        let broken = inspect_aliases("---\naliases:\n  - A\n");
        assert!(matches!(broken.edit, AliasEdit::Unsupported { .. }));
    }
}
