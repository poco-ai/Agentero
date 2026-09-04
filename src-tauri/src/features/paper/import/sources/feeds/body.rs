//! Turn RSS excerpts / article HTML into Markdown for the plaza detail page.

use super::parse::strip_html;
use dom_smoothie::{Config, Readability};
use url::Url;

pub fn html_to_markdown(html: &str) -> String {
    let (processed, math_blocks) = extract_latex_math(html);
    let md = htmd::convert(&processed).unwrap_or_else(|_| strip_html(&processed));
    let restored = restore_latex_math(&md, &math_blocks);
    restored.replace('\u{200b}', "").trim().to_string()
}

/// LaTeX block environments to preserve (equation, align, aligned, etc.).
const LATEX_BLOCK_ENVS: &[&str] = &[
    "equation",
    "equation*",
    "align",
    "align*",
    "aligned",
    "gather",
    "gather*",
    "multline",
    "multline*",
    "alignat",
    "alignat*",
    "flalign",
    "flalign*",
];

/// Environments KaTeX cannot render (MathJax-only). Their wrappers are
/// stripped so the inner math still displays; supported envs (align, gather,
/// aligned, …) keep their wrappers inside `$$…$$`.
const KATEX_UNSUPPORTED_ENVS: &[&str] = &[
    "equation",
    "equation*",
    "multline",
    "multline*",
    "flalign",
    "flalign*",
];

/// Extract LaTeX math from HTML before htmd conversion.
///
/// htmd strips backslashes, turning `\boldsymbol` into `boldsymbol`.
/// We pull out `\begin{env}...\end{env}` blocks, `$$...$$` display math and
/// `$...$` inline math, replace them with text placeholders, then restore
/// them as `$$...$$` / `$...$` after conversion.
fn extract_latex_math(html: &str) -> (String, Vec<(String, String)>) {
    let mut out = String::with_capacity(html.len());
    let mut blocks: Vec<(String, String)> = Vec::new();
    let mut rest = html;

    while !rest.is_empty() {
        // Try to find the earliest LaTeX construct
        let mut earliest: Option<(usize, usize, String)> = None;

        // Find \begin{env}
        if let Some(idx) = rest.find("\\begin{") {
            let brace = idx + "\\begin{".len();
            if let Some(end_brace) = rest[brace..].find('}') {
                let env_name = &rest[brace..brace + end_brace];
                if LATEX_BLOCK_ENVS.contains(&env_name) {
                    let end_tag = format!("\\end{{{}}}", env_name);
                    if let Some(end_idx) = rest[idx..].find(&end_tag) {
                        let abs_end = idx + end_idx + end_tag.len();
                        let content = rest[idx..abs_end].to_string();
                        let pos = earliest.as_ref().is_none_or(|(p, _, _)| idx < *p);
                        if pos {
                            earliest = Some((idx, abs_end, content));
                        }
                    }
                }
            }
        }

        // Find $$...$$ display math (blogs that write display math without
        // \begin{equation}); left in place, htmd would markdown-escape it.
        if let Some(idx) = rest.find("$$") {
            if rest.as_bytes().get(idx + 2) != Some(&b'$') {
                if let Some(close) = rest[idx + 2..].find("$$") {
                    let abs_end = idx + 2 + close + 2;
                    let content = rest[idx..abs_end].to_string();
                    let pos = earliest.as_ref().is_none_or(|(p, _, _)| idx < *p);
                    if pos {
                        earliest = Some((idx, abs_end, content));
                    }
                }
            }
        }

        // Find $...$ inline math (not $$...$$)
        let mut search_from = 0;
        while let Some(dollar) = rest[search_from..].find('$') {
            let abs_dollar = search_from + dollar;
            // Skip $$ (display math delimiter)
            if abs_dollar + 1 < rest.len() && rest.as_bytes()[abs_dollar + 1] == b'$' {
                search_from = abs_dollar + 2;
                continue;
            }
            // Find closing $
            let after = abs_dollar + 1;
            if let Some(end_dollar) = rest[after..].find('$') {
                let abs_end = after + end_dollar + 1;
                // Make sure it's not $$ on the closing side either
                if abs_end < rest.len() && rest.as_bytes()[abs_end] == b'$' {
                    search_from = abs_end + 1;
                    continue;
                }
                let content = rest[abs_dollar..abs_end].to_string();
                let pos = earliest.as_ref().is_none_or(|(p, _, _)| abs_dollar < *p);
                if pos {
                    earliest = Some((abs_dollar, abs_end, content));
                }
                break;
            }
            break;
        }

        match earliest {
            Some((start, end, content)) => {
                out.push_str(&rest[..start]);
                // Fixed-width index: a bare `LATEXBLOCK1` placeholder would
                // prefix-match inside `LATEXBLOCK10` during restore.
                let placeholder = format!("LATEXBLOCK{:04}", blocks.len());
                let marker = block_math_marker(&content);
                blocks.push((placeholder.clone(), marker));
                out.push_str(&placeholder);
                rest = &rest[end..];
            }
            None => {
                out.push_str(rest);
                break;
            }
        }
    }

    (out, blocks)
}

/// Display-math marker for an extracted LaTeX construct. Inline `$…$` passes
/// through; `\begin{env}…\end{env}` becomes `$$…$$`, with the wrapper dropped
/// for environments KaTeX cannot render.
fn block_math_marker(content: &str) -> String {
    let Some(open) = content.strip_prefix("\\begin{") else {
        return sanitize_math_html(content);
    };
    let Some(env) = open.split('}').next() else {
        return format!("$$ {} $$", sanitize_math_html(content));
    };
    if KATEX_UNSUPPORTED_ENVS.contains(&env) {
        let open_len = "\\begin{".len() + env.len() + 1;
        let close_len = "\\end{".len() + env.len() + 1;
        let inner = &content[open_len..content.len().saturating_sub(close_len)];
        format!("$$ {} $$", sanitize_math_html(inner.trim()))
    } else {
        format!("$$ {} $$", sanitize_math_html(content))
    }
}

/// Blogs embed HTML artifacts inside raw LaTeX (`<br />` line breaks,
/// `&lt;` entities, stray tags). Extraction runs before htmd, so clean the
/// math content itself: br → space, drop residual tags, decode entities.
fn sanitize_math_html(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(lt) = rest.find('<') {
        let Some(gt) = rest[lt..].find('>') else {
            break;
        };
        let tag = &rest[lt..lt + gt + 1];
        out.push_str(&rest[..lt]);
        if tag.starts_with("<br") {
            out.push(' ');
        }
        rest = &rest[lt + gt + 1..];
    }
    out.push_str(rest);
    out.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Restore LaTeX math placeholders after htmd conversion.
fn restore_latex_math(md: &str, blocks: &[(String, String)]) -> String {
    let mut result = md.to_string();
    for (placeholder, marker) in blocks {
        result = result.replace(placeholder, marker);
    }
    result
}

/// Paper landing pages (arXiv abs / DOI) are not useful article HTML.
#[allow(dead_code)]
pub fn is_paper_landing_url(url: Option<&str>) -> bool {
    let Some(raw) = url.map(str::trim).filter(|s| !s.is_empty()) else {
        return false;
    };
    let Ok(parsed) = Url::parse(raw) else {
        return false;
    };
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    matches!(
        host.as_str(),
        "arxiv.org"
            | "www.arxiv.org"
            | "rss.arxiv.org"
            | "export.arxiv.org"
            | "doi.org"
            | "www.doi.org"
            | "dx.doi.org"
    ) || host.ends_with(".arxiv.org")
}

/// DOI scraped from an article page's `<meta>` tags: Highwire `citation_doi`
/// first, then `prism.doi` / `dc.identifier` (both tolerate a `doi:` prefix).
/// Used to backfill `items.paper_url` for feeds that never expose a DOI.
pub fn extract_paper_doi(html: &str) -> Option<String> {
    for name in ["citation_doi", "prism.doi", "dc.identifier"] {
        let Some(content) = meta_named(html, name) else {
            continue;
        };
        let doi = content
            .trim()
            .strip_prefix("doi:")
            .map(str::trim)
            .unwrap_or(content.trim());
        if looks_like_doi(doi) {
            return Some(doi.to_string());
        }
    }
    None
}

fn looks_like_doi(s: &str) -> bool {
    !s.is_empty() && s.starts_with("10.") && s.contains('/') && !s.contains(char::is_whitespace)
}

fn meta_named(html: &str, name: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut from = 0;
    while let Some(rel) = lower[from..].find("<meta") {
        let start = from + rel;
        let Some(gt) = lower[start..].find('>') else {
            break;
        };
        let end = start + gt + 1;
        let tag_l = &lower[start..end];
        if attr_value(tag_l, "name").as_deref() == Some(name) {
            // Read the content from the original slice: DOIs are
            // case-insensitive but some contain uppercase characters.
            if let Some(content) = attr_value(&html[start..end], "content") {
                if !content.trim().is_empty() {
                    return Some(content);
                }
            }
        }
        from = end;
    }
    None
}

pub fn is_fetchable_http_url(url: &str) -> bool {
    let Ok(parsed) = Url::parse(url.trim()) else {
        return false;
    };
    matches!(parsed.scheme(), "http" | "https") && parsed.host_str().is_some()
}

/// Find the main article content using dom_smoothie, a full port of Mozilla
/// Readability.  It keeps only the readable article, dropping comment sections,
/// sidebars and navigation.  Returns an empty string when Readability cannot
/// identify a readable article; callers treat empty Markdown as a fetch failure
/// and fall back to the RSS excerpt.
pub fn extract_article_html(html: &str, url: Option<&str>) -> String {
    let Ok(mut readability) = Readability::new(html.to_string(), url, Some(Config::default()))
    else {
        return String::new();
    };
    let Ok(article) = readability.parse() else {
        return String::new();
    };
    article.content.to_string()
}

/// Drop RSS “read more” tails (`[...]`, `…`) so the detail page is not a teaser.
pub fn strip_trailing_ellipsis(text: &str) -> String {
    let mut t = text.trim().to_string();
    loop {
        let lower = t.to_ascii_lowercase();
        let cut = if lower.ends_with("[...]") {
            t.len().checked_sub(5)
        } else if t.ends_with("[…]") {
            t.len().checked_sub("[…]".len())
        } else if lower.ends_with("[..]") {
            t.len().checked_sub(4)
        } else if t.ends_with("...") {
            t.len().checked_sub(3)
        } else if t.ends_with('…') {
            t.len().checked_sub('…'.len_utf8())
        } else if lower.ends_with("read more") {
            t.len().checked_sub("read more".len())
        } else if lower.ends_with("continue reading") {
            t.len().checked_sub("continue reading".len())
        } else {
            None
        };
        let Some(end) = cut.filter(|&n| t.is_char_boundary(n)) else {
            break;
        };
        t = t[..end].trim_end().to_string();
    }
    t
}

/// Make the article start with `# Title` so the detail page can render as one
/// Markdown document (no separate HTML heading).
pub fn ensure_heading(md: &str, title: &str) -> String {
    let title = title.trim();
    let md = strip_trailing_ellipsis(md);
    if title.is_empty() {
        return md;
    }
    let heading = format!("# {title}");
    if md.is_empty() {
        return heading;
    }
    let mut lines = md.lines();
    let first = lines.next().unwrap_or("").trim();
    let first_text = first.trim_start_matches('#').trim();
    if first_text.eq_ignore_ascii_case(title) {
        let rest = lines.collect::<Vec<_>>().join("\n").trim().to_string();
        if rest.is_empty() {
            return heading;
        }
        return format!("{heading}\n\n{rest}");
    }
    format!("{heading}\n\n{md}")
}

fn attr_value(open_lower: &str, name: &str) -> Option<String> {
    let needle = format!("{name}=");
    let idx = open_lower.find(&needle)?;
    let rest = &open_lower[idx + needle.len()..];
    let quote = rest.as_bytes().first().copied();
    if quote == Some(b'"') || quote == Some(b'\'') {
        let q = quote? as char;
        let end = rest[1..].find(q)?;
        Some(rest[1..1 + end].to_string())
    } else {
        let end = rest
            .find(|c: char| c.is_whitespace() || c == '/' || c == '>')
            .unwrap_or(rest.len());
        Some(rest[..end].to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paper_landing_hosts() {
        assert!(is_paper_landing_url(Some(
            "https://arxiv.org/abs/1706.03762"
        )));
        assert!(is_paper_landing_url(Some(
            "https://rss.arxiv.org/abs/1706.03762"
        )));
        assert!(is_paper_landing_url(Some("https://doi.org/10.1/xyz")));
        assert!(!is_paper_landing_url(Some(
            "https://example.com/geometry-of-truth"
        )));
    }

    #[test]
    fn extracts_doi_from_article_metadata() {
        // Shape of a nature.com article page (truncated to the metas that matter).
        let nature = r#"<html><head>
<meta name="citation_doi" content="10.1038/s41467-026-76837-1">
<meta name="prism.doi" content="doi:10.1038/s41467-026-76837-1">
<meta name="dc.identifier" content="doi:10.1038/s41467-026-76837-1">
</head><body><article><p>Body text long enough to matter.</p></article></body></html>"#;
        assert_eq!(
            extract_paper_doi(nature).as_deref(),
            Some("10.1038/s41467-026-76837-1")
        );
        // prism.doi / dc.identifier carry a `doi:` prefix that gets stripped.
        let prism_only = r#"<meta name="prism.doi" content="doi:10.1038/s41592-026-03201-y">"#;
        assert_eq!(
            extract_paper_doi(prism_only).as_deref(),
            Some("10.1038/s41592-026-03201-y")
        );
        // Blog pages without paper metadata stay non-papers.
        assert_eq!(extract_paper_doi("<html><head></head></html>"), None);
        // Garbage content that is not a DOI is ignored.
        let junk = r#"<meta name="citation_doi" content="not-a-doi">"#;
        assert_eq!(extract_paper_doi(junk), None);
    }

    /// Enough real-looking paragraphs for Readability to accept the page.
    fn article_paragraphs(n: usize) -> String {
        (0..n)
            .map(|i| {
                format!(
                    "<p>Paragraph {i} explores how the model maps inputs to labels, \
                     discussing curvature, generalization and optimization in enough \
                     detail to read like a genuine article body.</p>"
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn readability_extracts_article_and_keeps_math() {
        let html = format!(
            r#"<html><head><title>The Geometry of Truth</title></head><body>
            <nav><a href="/">Home</a> <a href="/blog">Blog</a></nav>
            <article>
              <h2>The Setup</h2>
              {}
              <p>We study a map $m$ from inputs to labels and its curvature.</p>
            </article>
            <div class="sidebar">Related posts and recommendations</div>
            <footer>Subscribe to the newsletter</footer>
            </body></html>"#,
            article_paragraphs(6)
        );
        let inner = extract_article_html(&html, Some("https://example.com/post"));
        assert!(inner.contains("The Setup"), "{inner}");
        assert!(inner.contains("Paragraph 0"), "{inner}");
        assert!(!inner.contains("Subscribe to the newsletter"), "{inner}");
        assert!(!inner.contains("Related posts"), "{inner}");
        let md = html_to_markdown(&inner);
        assert!(md.contains("The Setup"), "{md}");
        assert!(md.contains("$m$"), "{md}");
    }

    #[test]
    fn readability_extracts_div_based_content_and_drops_comments() {
        let html = format!(
            r#"<html><head><title>Post</title></head><body>
            <div class="site-wrap">
              <div class="entry-content">
                {}
              </div>
              <div class="comment-section">
                <p>Great post, thanks for sharing this with everyone!</p>
              </div>
            </div>
            </body></html>"#,
            article_paragraphs(6)
        );
        let inner = extract_article_html(&html, None);
        assert!(inner.contains("Paragraph 0"), "{inner}");
        assert!(!inner.contains("Great post"), "{inner}");
    }

    #[test]
    fn strips_trailing_ellipsis() {
        assert_eq!(strip_trailing_ellipsis("Hello world [...]"), "Hello world");
        assert_eq!(strip_trailing_ellipsis("Hello world…"), "Hello world");
        assert_eq!(
            strip_trailing_ellipsis("Complete sentence."),
            "Complete sentence."
        );
    }

    #[test]
    fn prefixes_markdown_title() {
        assert_eq!(
            ensure_heading("## The Setup\n\nHello [...]", "The Geometry of Truth"),
            "# The Geometry of Truth\n\n## The Setup\n\nHello"
        );
        assert_eq!(
            ensure_heading(
                "# The Geometry of Truth\n\n## The Setup",
                "The Geometry of Truth"
            ),
            "# The Geometry of Truth\n\n## The Setup"
        );
    }

    #[test]
    fn readability_prefers_article_over_link_heavy_nav() {
        let links: Vec<String> = (0..12)
            .map(|i| format!(r#"<li><a href="/p/{i}">Story {i}</a></li>"#))
            .collect();
        let html = format!(
            r#"<html><head><title>Index</title></head><body>
            <div class="nav-links"><ul>{}</ul></div>
            <div class="content">
              <h1>Featured story</h1>
              {}
            </div>
            </body></html>"#,
            links.join("\n"),
            article_paragraphs(6)
        );
        let inner = extract_article_html(&html, None);
        assert!(inner.contains("Featured story"), "{inner}");
        assert!(inner.contains("Paragraph 0"), "{inner}");
        assert!(!inner.contains("Story 7"), "{inner}");
    }

    #[test]
    fn readability_returns_empty_on_degenerate_input() {
        assert_eq!(extract_article_html("", None), "");
        assert_eq!(extract_article_html("<html><body></body></html>", None), "");
    }

    #[test]
    fn preserves_latex_inline_math() {
        let html = r#"<div><p>The function $f(x) = x^2$ maps reals to reals.</p></div>"#;
        let md = html_to_markdown(html);
        assert!(md.contains("$f(x) = x^2$"), "{md}");
    }

    #[test]
    fn preserves_latex_block_math() {
        let html = r#"<div><p>Before.</p><p>\begin{equation}E = mc^2\end{equation}</p><p>After.</p></div>"#;
        let md = html_to_markdown(html);
        assert!(md.contains("$$ E = mc^2 $$"), "{md}");
        assert!(!md.contains("\\begin{equation}"), "{md}");
    }

    #[test]
    fn keeps_katex_supported_env_wrappers() {
        let html = r#"<p>\begin{aligned}a &= b \\ c &= d\end{aligned}</p>"#;
        let md = html_to_markdown(html);
        assert!(
            md.contains("$$ \\begin{aligned}a &= b \\\\ c &= d\\end{aligned} $$"),
            "{md}"
        );
    }

    #[test]
    fn strips_html_artifacts_inside_math() {
        let html = "<p>\\begin{equation}\\begin{aligned}<br />\na =&\\, b \\\\<br />\n=&\\, c &lt; d<br />\n\\end{aligned}\\end{equation}</p>";
        let md = html_to_markdown(html);
        assert!(
            md.contains("$$ \\begin{aligned} a =&\\, b \\\\ =&\\, c < d \\end{aligned} $$"),
            "{md}"
        );
        assert!(!md.contains("<br"), "{md}");
    }

    #[test]
    fn preserves_latex_backslash_commands() {
        let html = r#"<div><p>We use $\boldsymbol{\alpha} + \frac{1}{2}$ here.</p></div>"#;
        let md = html_to_markdown(html);
        assert!(
            md.contains("$\\boldsymbol{\\alpha} + \\frac{1}{2}$"),
            "{md}"
        );
    }

    #[test]
    fn protects_display_dollar_math_from_htmd() {
        let html = r#"<p>x</p>$$\newcommand{\rs}{\rule[-1.2ex]{0pt}{3.5ex}} \rs\text{ok} \begin{array}{c} a \\ b \end{array}$$<p>z</p>"#;
        let md = html_to_markdown(html);
        assert!(md.contains("\\rule[-1.2ex]{0pt}{3.5ex}"), "{md}");
        assert!(md.contains("\\begin{array}"), "{md}");
        assert!(!md.contains("\\\\rule"), "{md}");
    }
}
