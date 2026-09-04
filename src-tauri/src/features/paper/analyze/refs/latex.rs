//! Shared LaTeX/text helpers for reference parsing (no regex crate; hand-written scanners).

/// Strip TeX markup down to readable plain text: drops comments, commands,
/// braces; keeps command arguments and common escapes; collapses whitespace.
pub fn strip_tex(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i] as char;
        match c {
            '%' => {
                // Comment to end of line (escaped \% is handled in the '\\' arm).
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            '\\' => {
                i += 1;
                if i >= bytes.len() {
                    break;
                }
                let n = bytes[i] as char;
                if n.is_ascii_alphabetic() {
                    let start = i;
                    while i < bytes.len() && (bytes[i] as char).is_ascii_alphabetic() {
                        i += 1;
                    }
                    let cmd = &input[start..i];
                    // Optional star form.
                    if i < bytes.len() && bytes[i] == b'*' {
                        i += 1;
                    }
                    if cmd == "newblock" || cmd == "penalty" {
                        out.push(' ');
                        // \penalty0 style numeric argument.
                        while i < bytes.len() && (bytes[i] as char).is_ascii_digit() {
                            i += 1;
                        }
                    }
                } else {
                    // Escaped char (\%, \&, \_, \$, \#) or accent (\'e → e).
                    if matches!(n, '%' | '&' | '_' | '$' | '#' | '{' | '}') {
                        out.push(n);
                    } else if n == '~' || n == ' ' {
                        out.push(' ');
                    }
                    i += 1;
                }
            }
            '{' | '}' => i += 1,
            '~' => {
                out.push(' ');
                i += 1;
            }
            _ => {
                out.push(c);
                i += c.len_utf8();
            }
        }
    }
    collapse_ws(&out)
}

pub fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_space = true;
    for c in s.chars() {
        if c.is_whitespace() {
            if !last_space {
                out.push(' ');
                last_space = true;
            }
        } else {
            out.push(c);
            last_space = false;
        }
    }
    out.trim().to_string()
}

/// First plausible publication year (1900–2099, not embedded in a longer number).
pub fn extract_year(text: &str) -> Option<i32> {
    let b = text.as_bytes();
    for i in 0..b.len().saturating_sub(3) {
        if !(b[i] as char).is_ascii_digit() {
            continue;
        }
        if i > 0 && (b[i - 1] as char).is_ascii_digit() {
            continue;
        }
        if b.len() > i + 4 && (b[i + 4] as char).is_ascii_digit() {
            continue;
        }
        if b[i..i + 4].iter().all(|c| (*c as char).is_ascii_digit()) {
            let year: i32 = text[i..i + 4].parse().ok()?;
            if (1900..=2099).contains(&year) {
                return Some(year);
            }
        }
    }
    None
}

fn take_token(text: &str, start: usize, extra: fn(char) -> bool) -> String {
    let mut out = String::new();
    for c in text[start..].chars() {
        if c.is_ascii_alphanumeric() || extra(c) {
            out.push(c);
        } else {
            break;
        }
    }
    while out.ends_with(['.', ',', ';', ':', '}', ')']) {
        out.pop();
    }
    out
}

/// DOI from `doi.org/…`, `doi:…`, or a bare `10.xxxx/…` token.
pub fn extract_doi(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    for marker in ["doi.org/", "doi:", "doi: "] {
        if let Some(pos) = lower.find(marker) {
            let candidate = take_token(text, pos + marker.len(), |c| {
                matches!(c, '.' | '/' | '-' | '_' | '(' | ')' | ':' | ';' | '<' | '>')
            });
            if candidate.starts_with("10.") && candidate.contains('/') {
                return Some(candidate);
            }
        }
    }
    let mut search = 0;
    while let Some(rel) = lower[search..].find("10.") {
        let pos = search + rel;
        let boundary = pos == 0 || !(lower.as_bytes()[pos - 1] as char).is_ascii_alphanumeric();
        if boundary {
            let candidate = take_token(text, pos, |c| {
                matches!(c, '.' | '/' | '-' | '_' | '(' | ')' | ':' | ';')
            });
            if candidate.contains('/') && candidate.len() > 7 {
                return Some(candidate);
            }
        }
        search = pos + 3;
    }
    None
}

/// arXiv id from `arXiv:2101.00001v2` or `arxiv.org/abs/…` (version suffix kept).
pub fn extract_arxiv_id(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    for marker in ["arxiv.org/abs/", "arxiv.org/pdf/", "arxiv:"] {
        if let Some(pos) = lower.find(marker) {
            let candidate = take_token(text, pos + marker.len(), |c| matches!(c, '.' | '/' | '-'));
            if candidate.len() >= 7 {
                return Some(candidate);
            }
        }
    }
    None
}

/// `\url{…}` / `\href{…}{…}` target, else first `http(s)://…` token.
pub fn extract_url(text: &str) -> Option<String> {
    for marker in ["\\url{", "\\href{"] {
        if let Some(pos) = text.find(marker) {
            let start = pos + marker.len();
            if let Some(end_rel) = text[start..].find('}') {
                let url = text[start..start + end_rel].trim();
                if !url.is_empty() {
                    return Some(url.to_string());
                }
            }
        }
    }
    for scheme in ["https://", "http://"] {
        if let Some(pos) = text.find(scheme) {
            let url = take_token(text, pos, |c| {
                !c.is_whitespace() && !matches!(c, '}' | '{' | '"' | '\'' | '>' | '<')
            });
            if url.len() > scheme.len() {
                return Some(url);
            }
        }
    }
    None
}

/// Lowercased alphanumeric-only form for fuzzy title equality.
pub fn normalize_title(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// Drop a trailing `v3` style arXiv version suffix.
pub fn strip_arxiv_version(id: &str) -> &str {
    let id = id.trim();
    if let Some(pos) = id.rfind('v') {
        if pos > 0 && id[pos + 1..].chars().all(|c| c.is_ascii_digit()) && !id[pos + 1..].is_empty()
        {
            return &id[..pos];
        }
    }
    id
}

/// Family name of the first author ("Last, First" or "First Last" input).
pub fn first_author_family(authors: &[String]) -> Option<String> {
    let first = authors.first()?.trim();
    if first.is_empty() {
        return None;
    }
    if let Some((family, _)) = first.split_once(',') {
        return Some(family.trim().to_string());
    }
    first.split_whitespace().last().map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_tex_markup() {
        let s = strip_tex("\\emph{Attention} is {A}ll you \\newblock need % trailing");
        assert_eq!(s, "Attention is All you need");
    }

    #[test]
    fn extracts_identifiers() {
        let t =
            "A. Vaswani et al. Attention. In NeurIPS, 2017. doi:10.5555/3295222 arXiv:1706.03762v5";
        assert_eq!(extract_year(t), Some(2017));
        assert_eq!(extract_doi(t).as_deref(), Some("10.5555/3295222"));
        assert_eq!(extract_arxiv_id(t).as_deref(), Some("1706.03762v5"));
        assert_eq!(strip_arxiv_version("1706.03762v5"), "1706.03762");
    }

    #[test]
    fn extracts_url_from_tex() {
        assert_eq!(
            extract_url("see \\url{https://example.org/x} more").as_deref(),
            Some("https://example.org/x")
        );
        assert_eq!(
            extract_url("plain https://a.b/c, tail").as_deref(),
            Some("https://a.b/c")
        );
    }

    #[test]
    fn ignores_page_ranges_for_year() {
        assert_eq!(extract_year("pages 11731–11783, 2020."), Some(2020));
        assert_eq!(extract_year("pp. 123-145"), None);
    }
}
