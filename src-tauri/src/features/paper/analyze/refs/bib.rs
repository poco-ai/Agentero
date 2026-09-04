//! Minimal brace-aware BibTeX parser (no full TeX; raw fields kept best-effort).

use super::latex;
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct BibEntry {
    pub key: String,
    pub kind: String,
    /// Lowercased field name → plain-text value (TeX markup stripped).
    pub fields: HashMap<String, String>,
}

pub fn parse(input: &str) -> Vec<BibEntry> {
    let bytes = input.as_bytes();
    let mut entries = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'@' {
            i += 1;
            continue;
        }
        i += 1;
        let kind_start = i;
        while i < bytes.len() && (bytes[i] as char).is_ascii_alphabetic() {
            i += 1;
        }
        let kind = input[kind_start..i].to_ascii_lowercase();
        while i < bytes.len() && (bytes[i] as char).is_whitespace() {
            i += 1;
        }
        if i >= bytes.len() || (bytes[i] != b'{' && bytes[i] != b'(') {
            continue;
        }
        let closer = if bytes[i] == b'{' { b'}' } else { b')' };
        i += 1;
        if kind == "comment" || kind == "preamble" || kind == "string" {
            i = skip_balanced(bytes, i, closer);
            continue;
        }
        // Entry key up to first comma.
        let key_start = i;
        while i < bytes.len() && bytes[i] != b',' && bytes[i] != closer {
            i += 1;
        }
        let key = input[key_start..i].trim().to_string();
        if i < bytes.len() && bytes[i] == b',' {
            i += 1;
        }
        let mut fields = HashMap::new();
        loop {
            while i < bytes.len() && ((bytes[i] as char).is_whitespace() || bytes[i] == b',') {
                i += 1;
            }
            if i >= bytes.len() || bytes[i] == closer {
                if i < bytes.len() {
                    i += 1;
                }
                break;
            }
            let name_start = i;
            while i < bytes.len() && bytes[i] != b'=' && bytes[i] != closer {
                i += 1;
            }
            if i >= bytes.len() || bytes[i] != b'=' {
                continue;
            }
            let name = input[name_start..i].trim().to_ascii_lowercase();
            i += 1;
            let (value, next) = parse_value(input, bytes, i, closer);
            i = next;
            if !name.is_empty() && !value.is_empty() {
                fields.insert(name, value);
            }
        }
        if !key.is_empty() {
            entries.push(BibEntry { key, kind, fields });
        }
    }
    entries
}

/// One field value, including `"a" # "b"` concatenation. Returns (plain text, next index).
fn parse_value(input: &str, bytes: &[u8], mut i: usize, closer: u8) -> (String, usize) {
    let mut parts: Vec<String> = Vec::new();
    loop {
        while i < bytes.len() && (bytes[i] as char).is_whitespace() {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        match bytes[i] {
            b'{' => {
                let start = i + 1;
                let end = skip_balanced(bytes, start, b'}');
                parts.push(input[start..end.saturating_sub(1)].to_string());
                i = end;
            }
            b'"' => {
                let start = i + 1;
                let mut depth = 0usize;
                let mut j = start;
                while j < bytes.len() {
                    match bytes[j] {
                        b'{' => depth += 1,
                        b'}' => depth = depth.saturating_sub(1),
                        b'"' if depth == 0 => break,
                        _ => {}
                    }
                    j += 1;
                }
                parts.push(input[start..j].to_string());
                i = (j + 1).min(bytes.len());
            }
            _ => {
                let start = i;
                while i < bytes.len()
                    && bytes[i] != b','
                    && bytes[i] != closer
                    && bytes[i] != b'#'
                    && !(bytes[i] as char).is_whitespace()
                {
                    i += 1;
                }
                parts.push(input[start..i].to_string());
            }
        }
        while i < bytes.len() && (bytes[i] as char).is_whitespace() {
            i += 1;
        }
        if i < bytes.len() && bytes[i] == b'#' {
            i += 1;
            continue;
        }
        break;
    }
    (latex::strip_tex(&parts.join("")), i)
}

/// Skip past a balanced `{…}` / `(…)` group; `i` starts just after the opener.
/// Returns the index just after the matching closer.
fn skip_balanced(bytes: &[u8], mut i: usize, closer: u8) -> usize {
    let opener = if closer == b'}' { b'{' } else { b'(' };
    let mut depth = 1usize;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'\\' {
            i += 2;
            continue;
        }
        if b == opener {
            depth += 1;
        } else if b == closer {
            depth -= 1;
            if depth == 0 {
                return i + 1;
            }
        }
        i += 1;
    }
    i
}

/// Split a BibTeX author field on `and`, normalizing "Last, First" → "First Last".
pub fn split_authors(field: &str) -> Vec<String> {
    field
        .split(" and ")
        .map(|a| {
            let a = a.trim();
            match a.split_once(',') {
                Some((last, first)) => {
                    let first = first.trim();
                    let last = last.trim();
                    if first.is_empty() {
                        last.to_string()
                    } else {
                        format!("{first} {last}")
                    }
                }
                None => a.to_string(),
            }
        })
        .filter(|a| !a.is_empty() && a != "others")
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
% a comment line
@comment{ignore me {nested}}
@article{vaswani2017,
  title   = {Attention Is {A}ll You Need},
  author  = {Vaswani, Ashish and Shazeer, Noam and others},
  year    = 2017,
  journal = "Advances in NeurIPS",
  doi     = {10.5555/3295222},
  eprint  = {1706.03762},
  archiveprefix = {arXiv},
}
@inproceedings{he2016deep,
  title={Deep Residual Learning},
  author={He, Kaiming},
  booktitle={CVPR},
  year={2016}
}
"#;

    #[test]
    fn parses_entries_and_fields() {
        let entries = parse(SAMPLE);
        assert_eq!(entries.len(), 2);
        let e = &entries[0];
        assert_eq!(e.key, "vaswani2017");
        assert_eq!(e.kind, "article");
        assert_eq!(e.fields["title"], "Attention Is All You Need");
        assert_eq!(e.fields["year"], "2017");
        assert_eq!(e.fields["journal"], "Advances in NeurIPS");
        assert_eq!(e.fields["eprint"], "1706.03762");
        assert_eq!(entries[1].key, "he2016deep");
        assert_eq!(entries[1].fields["booktitle"], "CVPR");
    }

    #[test]
    fn splits_authors() {
        let authors = split_authors("Vaswani, Ashish and Shazeer, Noam and others");
        assert_eq!(authors, vec!["Ashish Vaswani", "Noam Shazeer"]);
    }
}
