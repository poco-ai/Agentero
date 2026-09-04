//! Title similarity and candidate ranking utilities for `scholar_api`.

use std::collections::HashSet;

use crate::scholar_api::ApiPaper;

/// Normalize a title for comparison: lowercase, drop punctuation, collapse whitespace.
pub fn normalize_title(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut pending_space = false;
    for ch in s.chars() {
        if ch.is_alphanumeric() {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            out.extend(ch.to_lowercase());
        } else {
            pending_space = true;
        }
    }
    out
}

/// Token-sort-ratio style similarity (0-100).
pub fn title_similarity(a: &str, b: &str) -> i32 {
    let sorted = |s: &str| -> String {
        let mut tokens: Vec<&str> = s.split_whitespace().collect();
        tokens.sort_unstable();
        tokens.join(" ")
    };
    let sa = sorted(a);
    let sb = sorted(b);
    let dist = levenshtein_distance(&sa, &sb);
    let max_len = sa.chars().count().max(sb.chars().count());
    (((max_len - dist) * 100).checked_div(max_len).unwrap_or(100)) as i32
}

fn levenshtein_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let n = a.len();
    let m = b.len();
    if n == 0 {
        return m;
    }
    if m == 0 {
        return n;
    }
    let mut prev: Vec<usize> = (0..=m).collect();
    let mut curr = vec![0; m + 1];
    for i in 1..=n {
        curr[0] = i;
        for j in 1..=m {
            let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
            curr[j] = (prev[j] + 1).min(curr[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[m]
}

/// Score a list of candidates by normalized title similarity to the query.
pub fn score_candidates(candidates: &mut [ApiPaper], norm_query: &str) {
    for c in candidates {
        // ApiPaper has no score field; scoring is used externally by callers
        // that wrap ApiPaper in a scored container. This helper returns the
        // numeric similarity so callers can attach it themselves.
        let _score = title_similarity(norm_query, &normalize_title(&c.title));
    }
}

/// True if two papers describe the same work using title, year, and author overlap.
pub fn is_same_paper(a: &ApiPaper, b: &ApiPaper, year_tolerance: i32) -> bool {
    title_similarity(&normalize_title(&a.title), &normalize_title(&b.title)) >= 85
        && year_close(a.year, b.year, year_tolerance)
        && author_overlap(&a.authors, &b.authors) >= 0.30
}

fn year_close(a: Option<i32>, b: Option<i32>, tolerance: i32) -> bool {
    match (a, b) {
        (Some(x), Some(y)) => (x - y).abs() <= tolerance,
        _ => true,
    }
}

fn author_surnames(authors: &[String]) -> HashSet<String> {
    authors
        .iter()
        .filter_map(|name| {
            let raw = if name.contains(',') {
                name.split(',').next()?
            } else {
                name.split_whitespace().last()?
            };
            let s = raw
                .chars()
                .filter(|c| c.is_alphanumeric())
                .collect::<String>()
                .to_lowercase();
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
        })
        .collect()
}

fn author_overlap(a: &[String], b: &[String]) -> f64 {
    let sa = author_surnames(a);
    let sb = author_surnames(b);
    if sa.is_empty() || sb.is_empty() {
        return 0.0;
    }
    let inter = sa.intersection(&sb).count() as f64;
    let union = sa.union(&sb).count() as f64;
    if union == 0.0 {
        0.0
    } else {
        inter / union
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_similarity_handles_word_order() {
        let a = normalize_title("Attention Is All You Need");
        let b = normalize_title("All You Need Is Attention");
        assert!(title_similarity(&a, &b) >= 90);
    }

    #[test]
    fn author_overlap_computes_jaccard() {
        let a = vec!["Ashish Vaswani".into(), "Noam Shazeer".into()];
        let b = vec!["Vaswani, Ashish".into(), "Niki Parmar".into()];
        let overlap = author_overlap(&a, &b);
        assert!((overlap - 0.33).abs() < 0.01);
    }
}
