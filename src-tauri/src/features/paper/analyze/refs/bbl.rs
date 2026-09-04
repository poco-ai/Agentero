//! `.bbl` / inline `thebibliography` parser: `\bibitem` entries → raw text +
//! best-effort identifiers. Titles are not guessed from `.bbl` text.

use super::latex;
use super::RefDraft;

/// Parse a `.bbl` file (or a `thebibliography` body) into ordered drafts.
pub fn parse(input: &str) -> Vec<RefDraft> {
    let text = drop_comment_lines(input);
    let bytes = text.as_bytes();
    let mut items: Vec<(String, String)> = Vec::new(); // (key, body)
    let mut i = 0;
    while let Some(rel) = text[i..].find("\\bibitem") {
        let start = i + rel;
        let mut j = start + "\\bibitem".len();
        // Reject longer commands like \bibitemsep.
        if j < bytes.len() && (bytes[j] as char).is_ascii_alphabetic() {
            i = j;
            continue;
        }
        while j < bytes.len() && (bytes[j] as char).is_whitespace() {
            j += 1;
        }
        if j < bytes.len() && bytes[j] == b'[' {
            j = skip_group(bytes, j + 1, b'[', b']');
        }
        while j < bytes.len() && (bytes[j] as char).is_whitespace() {
            j += 1;
        }
        let key = if j < bytes.len() && bytes[j] == b'{' {
            let end = skip_group(bytes, j + 1, b'{', b'}');
            let key = text[j + 1..end.saturating_sub(1)].trim().to_string();
            j = end;
            key
        } else {
            String::new()
        };
        let body_end = text[j..]
            .find("\\bibitem")
            .map(|r| j + r)
            .or_else(|| text[j..].find("\\end{thebibliography}").map(|r| j + r))
            .unwrap_or(text.len());
        items.push((key, text[j..body_end].to_string()));
        i = body_end;
    }
    items
        .into_iter()
        .filter(|(key, body)| !key.is_empty() || !body.trim().is_empty())
        .map(|(key, body)| {
            let url = latex::extract_url(&body);
            let doi = latex::extract_doi(&body);
            let arxiv_id =
                latex::extract_arxiv_id(&body).map(|s| latex::strip_arxiv_version(&s).to_string());
            let mut raw = latex::strip_tex(&body);
            raw.truncate(
                raw.char_indices()
                    .nth(1200)
                    .map(|(i, _)| i)
                    .unwrap_or(raw.len()),
            );
            let year = latex::extract_year(&raw);
            RefDraft {
                key: (!key.is_empty()).then_some(key),
                raw: (!raw.is_empty()).then_some(raw),
                title: None,
                authors: Vec::new(),
                year,
                venue: None,
                doi,
                arxiv_id,
                url,
                source: "bbl",
            }
        })
        .collect()
}

/// Slice out the first `\begin{thebibliography}…\end{thebibliography}` body.
pub fn extract_thebibliography(tex: &str) -> Option<&str> {
    let start = tex.find("\\begin{thebibliography}")?;
    let end = tex[start..].find("\\end{thebibliography}")? + start;
    Some(&tex[start..end])
}

/// Skip a balanced group; `i` starts just after the opener. `[…]` groups also
/// balance nested `{…}` (labels like `[\protect\citeauthoryear{A}{B}]`).
fn skip_group(bytes: &[u8], mut i: usize, opener: u8, closer: u8) -> usize {
    let mut depth = 1usize;
    let mut brace = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'\\' {
            i += 2;
            continue;
        }
        if opener != b'{' {
            if b == b'{' {
                brace += 1;
            } else if b == b'}' {
                brace = brace.saturating_sub(1);
            }
        }
        if brace == 0 {
            if b == opener {
                depth += 1;
            } else if b == closer {
                depth -= 1;
                if depth == 0 {
                    return i + 1;
                }
            }
        }
        i += 1;
    }
    i
}

fn drop_comment_lines(input: &str) -> String {
    input
        .lines()
        .filter(|l| !l.trim_start().starts_with('%'))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
\begin{thebibliography}{10}
% comment line
\bibitem{vaswani2017}
A.~Vaswani, N.~Shazeer, et~al.
\newblock Attention is all you need.
\newblock In {\em NeurIPS}, 2017.
\newblock arXiv:1706.03762v5.

\bibitem[\protect\citeauthoryear{He}{2016}]{he2016}
K.~He, X.~Zhang.
\newblock Deep residual learning. doi:10.1109/CVPR.2016.90
\end{thebibliography}
"#;

    #[test]
    fn parses_bibitems_in_order() {
        let drafts = parse(SAMPLE);
        assert_eq!(drafts.len(), 2);
        assert_eq!(drafts[0].key.as_deref(), Some("vaswani2017"));
        assert_eq!(drafts[0].year, Some(2017));
        assert_eq!(drafts[0].arxiv_id.as_deref(), Some("1706.03762"));
        assert!(drafts[0]
            .raw
            .as_deref()
            .unwrap()
            .contains("Attention is all you need"));
        assert_eq!(drafts[1].key.as_deref(), Some("he2016"));
        assert_eq!(drafts[1].doi.as_deref(), Some("10.1109/CVPR.2016.90"));
    }

    #[test]
    fn extracts_inline_thebibliography() {
        let tex = format!("\\section{{x}} body {SAMPLE} tail");
        let body = extract_thebibliography(&tex).unwrap();
        assert!(body.contains("\\bibitem{vaswani2017}"));
        assert!(!body.contains("tail"));
    }
}
