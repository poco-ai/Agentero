//! Per-source identifier extraction and normalization.

/// Extract a canonical arXiv id from a wide variety of user-facing forms.
///
/// Handles plain IDs, `arXiv:` prefixes, and arxiv.org URL paths
/// (`/abs`, `/pdf`, `/html`, `/src`, `/e-print`). Strips version suffixes.
pub fn extract_arxiv_id(text: &str) -> Option<String> {
    let s = text.trim();
    // URL form
    let stripped = s
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_start_matches("export.arxiv.org/")
        .trim_start_matches("arxiv.org/");
    let after_path = if let Some(rest) = stripped.strip_prefix("abs/") {
        rest
    } else if let Some(rest) = stripped.strip_prefix("pdf/") {
        rest
    } else if let Some(rest) = stripped.strip_prefix("html/") {
        rest
    } else if let Some(rest) = stripped.strip_prefix("src/") {
        rest
    } else if let Some(rest) = stripped.strip_prefix("e-print/") {
        rest
    } else {
        s.trim_start_matches("arXiv:").trim_start_matches("arxiv:")
    };
    let id = after_path
        .split(['?', '#', '/'])
        .next()
        .unwrap_or(after_path)
        .trim_end_matches(".pdf");
    let id = id.trim().trim_end_matches('/');
    // new-style 1706.03762 or old-style hep-th/9901001
    let bare = strip_arxiv_version(id);
    if is_arxiv_id(&bare) {
        Some(bare)
    } else {
        None
    }
}

fn is_arxiv_id(s: &str) -> bool {
    // 1234.5678 or 1234.56789
    if s.len() >= 9 && s.as_bytes().get(4) == Some(&b'.') {
        let (a, b) = s.split_at(4);
        let b = &b[1..];
        return a.chars().all(|c| c.is_ascii_digit())
            && (b.len() == 4 || b.len() == 5)
            && b.chars().all(|c| c.is_ascii_digit());
    }
    // archive/YYMMNNN
    if let Some((arch, num)) = s.split_once('/') {
        return !arch.is_empty() && num.len() == 7 && num.chars().all(|c| c.is_ascii_digit());
    }
    false
}

/// Canonical arXiv id normalizer: trim, drop an `arXiv:` / `arxiv:` prefix
/// (re-trimming any whitespace behind the colon), then strip a trailing `vN`
/// version suffix (only when the `v` is not the first character, so ids like
/// `cs.CL/0101001` survive).
pub fn strip_arxiv_version(id: &str) -> String {
    let s = id
        .trim()
        .trim_start_matches("arXiv:")
        .trim_start_matches("arxiv:")
        .trim();
    if let Some(i) = s.rfind('v') {
        if s[i + 1..].chars().all(|c| c.is_ascii_digit()) && i > 0 {
            return s[..i].to_string();
        }
    }
    s.to_string()
}

pub fn clean_doi(s: &str) -> Option<String> {
    let mut x = s.trim().to_string();
    if x.starts_with("https://doi.org/") {
        x = x["https://doi.org/".len()..].to_string();
    } else if x.starts_with("http://doi.org/") {
        x = x["http://doi.org/".len()..].to_string();
    } else if x.starts_with("doi:") {
        x = x["doi:".len()..].trim().to_string();
    }
    // 10.xxxx/...
    if let Some(start) = x.find("10.") {
        let cand = &x[start..];
        let end = cand
            .find(|c: char| c.is_whitespace() || c == ',' || c == ';')
            .unwrap_or(cand.len());
        let doi = cand[..end].trim_end_matches(['.', ',', ')']).to_string();
        if doi.contains('/') {
            return Some(doi);
        }
    }
    None
}

pub fn clean_isbn(s: &str) -> Option<String> {
    let digits: String = s
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == 'X' || *c == 'x')
        .collect();
    let upper = digits.to_uppercase();
    if upper.len() == 13 && (upper.starts_with("978") || upper.starts_with("979")) {
        return Some(upper);
    }
    if upper.len() == 10 {
        return Some(upper);
    }
    None
}

pub fn regex_pmid(s: &str) -> Option<String> {
    let t = s
        .trim()
        .trim_start_matches("PMID:")
        .trim_start_matches("pmid:");
    let t = t.trim();
    if !t.is_empty() && t.len() <= 9 && t.chars().all(|c| c.is_ascii_digit()) {
        return Some(t.to_string());
    }
    None
}

/// DOI-safe folder slug: replace `/` and `.` with `_`.
pub fn doi_slug(doi: &str) -> String {
    doi.replace(['/', '.'], "_")
}

pub fn regex_ads(s: &str) -> Option<String> {
    // 2015ApJ...810...89S — 19 chars-ish
    let t = s.trim();
    if t.len() == 19
        && t.as_bytes()[0].is_ascii_digit()
        && t.as_bytes()[1].is_ascii_digit()
        && t.as_bytes()[2].is_ascii_digit()
        && t.as_bytes()[3].is_ascii_digit()
    {
        return Some(t.to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arxiv_id_new() {
        assert_eq!(
            extract_arxiv_id("1706.03762").as_deref(),
            Some("1706.03762")
        );
        assert_eq!(
            extract_arxiv_id("https://arxiv.org/abs/1706.03762v1").as_deref(),
            Some("1706.03762")
        );
        assert_eq!(
            extract_arxiv_id("https://arxiv.org/pdf/2508.05004.pdf?download=1").as_deref(),
            Some("2508.05004")
        );
    }

    #[test]
    fn strip_arxiv_version_normalizes_prefix_and_suffix() {
        assert_eq!(strip_arxiv_version("2608.13558v3"), "2608.13558");
        assert_eq!(strip_arxiv_version("arXiv:1706.03762v2"), "1706.03762");
        assert_eq!(strip_arxiv_version("arxiv:1706.03762"), "1706.03762");
        assert_eq!(strip_arxiv_version("  1706.03762  "), "1706.03762");
        // Old-style id without a version stays intact.
        assert_eq!(strip_arxiv_version("hep-th/9901001"), "hep-th/9901001");
        // A leading `v` is never treated as a version marker.
        assert_eq!(strip_arxiv_version("v2"), "v2");
    }

    #[test]
    fn arxiv_id_with_prefix_and_version() {
        assert_eq!(
            extract_arxiv_id("arXiv:1706.03762v2").as_deref(),
            Some("1706.03762")
        );
        assert_eq!(
            extract_arxiv_id("https://arxiv.org/abs/arXiv:2608.13558v1").as_deref(),
            Some("2608.13558")
        );
    }

    #[test]
    fn doi_clean() {
        assert_eq!(
            clean_doi("https://doi.org/10.1038/nature12373").as_deref(),
            Some("10.1038/nature12373")
        );
    }
}
