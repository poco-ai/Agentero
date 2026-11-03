//! The paper's own GitHub repository, taken from the PDF.
//!
//! Search order is the abstract (and the lines around it), first-page
//! footnotes, then the last page before the bibliography. The rest of the
//! paper is only a fallback, and a hit there has to read like this paper's
//! code. Reference entries and other projects' repositories are not stored.
//! A link annotation counts even when its visible text is not the URL.

use std::path::PathBuf;

/// Where a candidate was found. Earlier variants outrank later ones on a tie.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Region {
    Abstract,
    Footnote,
    Closing,
    Body,
}

/// Site sections that share `github.com/{name}` with user accounts.
const RESERVED_OWNERS: &[&str] = &[
    "about",
    "account",
    "apps",
    "codespaces",
    "collections",
    "copilot",
    "customer-stories",
    "education",
    "enterprise",
    "events",
    "explore",
    "features",
    "github",
    "issues",
    "join",
    "login",
    "logout",
    "marketplace",
    "new",
    "nonprofit",
    "notifications",
    "open-source",
    "organizations",
    "orgs",
    "pricing",
    "pulls",
    "readme",
    "search",
    "security",
    "sessions",
    "settings",
    "signup",
    "site",
    "solutions",
    "sponsors",
    "team",
    "topics",
    "trending",
    "watching",
];

/// Viewport y (top = 0) above this fraction is a first-page footnote.
const FOOTNOTE_Y: f32 = 0.80;

/// Below this, a candidate is not confident enough to write into `code_repo`.
const MIN_SCORE: i32 = 60;

/// One chosen repository. `source` is `abstract`, `footnote`, `closing`, or `body`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubRepo {
    pub url: String,
    pub source: &'static str,
    pub confidence: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Root,
    Tree,
    Subpage,
}

struct Hit {
    url: String,
    region: Region,
    kind: Kind,
    official: bool,
    other_work: bool,
    reference_line: bool,
}

struct PageText {
    body: String,
    footnote: String,
    /// Body character byte index → viewport y fraction.
    marks: Vec<(usize, f32)>,
    /// Link URI and the viewport y fraction of its annotation.
    links: Vec<(String, f32)>,
}

/// Repository link for this paper, or `None` when the file has none worth storing.
pub fn extract_github_repo(pdf: &[u8]) -> Option<GithubRepo> {
    ensure_pdfium_search_path();
    let lib = liteparse_pdfium::Library::try_init().ok()?;
    let doc = lib.load_document_from_bytes(pdf, None).ok()?;
    let count = doc.page_count();
    if count < 1 {
        return None;
    }
    let first = read_page(&doc, 0)?;
    let mut hits = Vec::new();
    let abstract_span = abstract_span(&first.body);
    if let Some((start, end)) = abstract_span {
        hits.extend(hits_in_region(&first.body[start..end], Region::Abstract));
    }
    hits.extend(hits_in_region(&first.footnote, Region::Footnote));
    let abstract_ys = abstract_span.and_then(|(start, end)| y_span(&first.marks, start, end));
    for (uri, y) in &first.links {
        let region = if *y >= FOOTNOTE_Y {
            Region::Footnote
        } else if abstract_ys.is_some_and(|(lo, hi)| *y >= lo - 0.06 && *y <= hi + 0.03) {
            Region::Abstract
        } else {
            continue;
        };
        hits.extend(hits_in_region(uri, region));
    }

    let closing = closing_text(&doc, count, &first.body);
    hits.extend(hits_in_region(&closing, Region::Closing));
    if count > 1 {
        if let Some(last) = read_page(&doc, count - 1) {
            let heading = references_heading_y(&doc, count - 1);
            for (uri, y) in last.links {
                if heading.is_some_and(|heading_y| y > heading_y + 0.02) {
                    continue;
                }
                hits.extend(hits_in_region(&uri, Region::Closing));
            }
        }
    }

    let mut in_refs = false;
    for index in 0..count {
        if in_refs {
            break;
        }
        let text = if index == 0 {
            first.body.clone()
        } else if let Some(page) = read_page(&doc, index) {
            page.body
        } else {
            continue;
        };
        let before = before_references(&text);
        if before.len() != text.len() {
            in_refs = true;
        }
        // The last page is already the closing region. A one-page paper still
        // needs its body scanned, because that body is the whole document.
        if count > 1 && index + 1 == count {
            continue;
        }
        let body = if index == 0 {
            outside_abstract(&text, abstract_span)
        } else {
            before
        };
        hits.extend(hits_in_region(body, Region::Body));
    }
    select(hits)
}

fn outside_abstract(text: &str, span: Option<(usize, usize)>) -> &str {
    match span {
        Some((_, end)) if end < text.len() => &text[end..],
        Some(_) => "",
        None => text,
    }
}

fn closing_text(doc: &liteparse_pdfium::Document<'_>, count: i32, first_body: &str) -> String {
    if count <= 1 {
        return tail_str(first_body, 600).to_string();
    }
    let Some(last) = read_page(doc, count - 1) else {
        return String::new();
    };
    let before = before_references(&last.body);
    if meaningful(before) {
        return before.to_string();
    }
    if count >= 2 {
        if let Some(prev) = read_page(doc, count - 2) {
            return tail_str(before_references(&prev.body), 1500).to_string();
        }
    }
    String::new()
}

fn meaningful(text: &str) -> bool {
    text.chars().filter(|c| !c.is_whitespace()).count() >= 40
}

fn read_page(doc: &liteparse_pdfium::Document<'_>, index: i32) -> Option<PageText> {
    let page = doc.page(index).ok()?;
    let view = page.view_box()?;
    let (_, height) = page.viewport_size(&view);
    let links = page
        .links(&view)
        .into_iter()
        .map(|link| {
            let y = if height <= f32::EPSILON {
                0.0
            } else {
                (link.rect.top + link.rect.bottom) * 0.5 / height
            };
            (link.uri, y)
        })
        .collect();
    let text_page = page.text().ok()?;
    let mut body = String::new();
    let mut footnote = String::new();
    let mut marks = Vec::new();
    let mut body_y: Option<f32> = None;
    let mut note_y: Option<f32> = None;
    for ch in text_page.chars() {
        let Some(c) = char::from_u32(ch.unicode()).filter(|c| *c != '\0' && *c != '\r') else {
            continue;
        };
        let glyph = glyph_y(&page, &view, height, &ch);
        let y_norm = glyph.map(|item| item.norm).unwrap_or(0.0);
        let y_points = glyph.map(|item| item.points).unwrap_or(0.0);
        let bucket_is_note = y_norm >= FOOTNOTE_Y;
        let buf = if bucket_is_note {
            &mut footnote
        } else {
            &mut body
        };
        let prev = if bucket_is_note {
            &mut note_y
        } else {
            &mut body_y
        };
        if c == '\n' {
            if !buf.ends_with('\n') {
                buf.push('\n');
            }
            continue;
        }
        // Glyph centers on one line differ (a period sits lower than a capital).
        // Compare in points against the font size, not a fraction of the page.
        if new_text_line(*prev, y_points, ch.font_size()) && !buf.ends_with('\n') && !buf.is_empty()
        {
            buf.push('\n');
        }
        if !bucket_is_note {
            marks.push((buf.len(), y_norm));
        }
        buf.push(c);
        *prev = Some(y_points);
    }
    Some(PageText {
        body,
        footnote,
        marks,
        links,
    })
}

#[derive(Clone, Copy)]
struct GlyphY {
    norm: f32,
    points: f32,
}

fn glyph_y(
    page: &liteparse_pdfium::Page<'_, '_>,
    view: &liteparse_pdfium::RectF,
    height: f32,
    ch: &liteparse_pdfium::TextChar<'_>,
) -> Option<GlyphY> {
    if height <= f32::EPSILON {
        return None;
    }
    let box_ = ch.char_box()?;
    let (_, points) = page.page_to_viewport(
        view,
        box_.left as f32,
        ((box_.top + box_.bottom) / 2.0) as f32,
    );
    Some(GlyphY {
        norm: points / height,
        points,
    })
}

/// A new visual line, ignoring the smaller vertical shift between `.` and `H`
/// on the same baseline.
fn new_text_line(prev_points: Option<f32>, y_points: f32, font_size: f64) -> bool {
    let size = if font_size.is_finite() && font_size > 1.0 {
        font_size as f32
    } else {
        12.0
    };
    prev_points.is_some_and(|prev| (y_points - prev).abs() > size * 0.55)
}

fn y_span(marks: &[(usize, f32)], start: usize, end: usize) -> Option<(f32, f32)> {
    let mut lo = f32::MAX;
    let mut hi = f32::MIN;
    for (index, y) in marks {
        if *index >= start && *index < end {
            lo = lo.min(*y);
            hi = hi.max(*y);
        }
    }
    (lo <= hi).then_some((lo, hi))
}

fn references_heading_y(doc: &liteparse_pdfium::Document<'_>, index: i32) -> Option<f32> {
    let page = doc.page(index).ok()?;
    let view = page.view_box()?;
    let (_, height) = page.viewport_size(&view);
    let text_page = page.text().ok()?;
    let mut line = String::new();
    let mut line_y = None;
    let mut line_points = None;
    for ch in text_page.chars() {
        let Some(c) = char::from_u32(ch.unicode()).filter(|c| *c != '\0' && *c != '\r') else {
            continue;
        };
        let glyph = glyph_y(&page, &view, height, &ch);
        let y_norm = glyph.map(|item| item.norm).unwrap_or(0.0);
        let y_points = glyph.map(|item| item.points).unwrap_or(0.0);
        if c == '\n' || new_text_line(line_points, y_points, ch.font_size()) {
            if is_references_heading(&line) {
                return line_y;
            }
            line.clear();
            if c == '\n' {
                line_y = None;
                line_points = None;
                continue;
            }
        }
        line.push(c);
        line_y = Some(y_norm);
        line_points = Some(y_points);
    }
    is_references_heading(&line).then_some(line_y).flatten()
}

fn hits_in_region(text: &str, region: Region) -> Vec<Hit> {
    let mut hits = Vec::new();
    for line in logical_lines(text) {
        let reference_line = is_reference_entry(&line);
        let lower = line.to_ascii_lowercase();
        let needle = "github.com/";
        let mut from = 0;
        while let Some(rel) = lower[from..].find(needle) {
            let at = from + rel;
            if let Some((url, kind)) = repo_at(&line, at) {
                let window = context_window(&line, at);
                hits.push(Hit {
                    url,
                    region,
                    kind,
                    official: has_any_cue(&window, OFFICIAL_CUES),
                    other_work: has_any_cue(&window, OTHER_WORK_CUES),
                    reference_line,
                });
            }
            from = at + needle.len();
        }
    }
    hits
}

const OFFICIAL_CUES: &[&str] = &[
    "code is available",
    "code available",
    "source code",
    "our code",
    "our implementation",
    "our repository",
    "we release",
    "project page",
    "project homepage",
    "available at",
    "open-source",
    "open source",
    "code:",
    "repository:",
    "代码",
    "项目主页",
    "开源",
];

const OTHER_WORK_CUES: &[&str] = &[
    "et al",
    "prior work",
    "previous work",
    "their code",
    "their implementation",
];

fn select(mut hits: Vec<Hit>) -> Option<GithubRepo> {
    hits.sort_by(|a, b| {
        score(b)
            .cmp(&score(a))
            .then(region_rank(a.region).cmp(&region_rank(b.region)))
            .then(kind_rank(a.kind).cmp(&kind_rank(b.kind)))
    });
    let hit = hits.into_iter().find(|hit| score(hit) >= MIN_SCORE)?;
    let confidence = score(&hit);
    Some(GithubRepo {
        url: hit.url,
        source: region_name(hit.region),
        confidence,
    })
}

fn score(hit: &Hit) -> i32 {
    if hit.reference_line {
        return 0;
    }
    let mut score = match hit.region {
        Region::Abstract => 80,
        Region::Footnote => 72,
        Region::Closing => 64,
        Region::Body => 28,
    };
    score += match hit.kind {
        Kind::Root => 14,
        Kind::Tree => 10,
        Kind::Subpage => 0,
    };
    if hit.official {
        score += 22;
    }
    if hit.other_work && !hit.official {
        score -= 36;
    }
    score
}

fn region_rank(region: Region) -> u8 {
    match region {
        Region::Abstract => 0,
        Region::Footnote => 1,
        Region::Closing => 2,
        Region::Body => 3,
    }
}

fn kind_rank(kind: Kind) -> u8 {
    match kind {
        Kind::Root => 0,
        Kind::Tree => 1,
        Kind::Subpage => 2,
    }
}

fn region_name(region: Region) -> &'static str {
    match region {
        Region::Abstract => "abstract",
        Region::Footnote => "footnote",
        Region::Closing => "closing",
        Region::Body => "body",
    }
}

fn abstract_span(body: &str) -> Option<(usize, usize)> {
    let lower = body.to_ascii_lowercase();
    let start = find_cue(&lower, "abstract").or_else(|| body.find("摘要"))?;
    let rel = following_section(&lower[start..]).unwrap_or_else(|| (lower.len() - start).min(2500));
    let end = (start + rel).min(body.len());
    let nearby = body[..start]
        .char_indices()
        .rev()
        .nth(400)
        .map(|(index, _)| index)
        .unwrap_or(0);
    (nearby < end).then_some((nearby, end))
}

fn following_section(lower_from_abstract: &str) -> Option<usize> {
    let mut offset = 0;
    for line in lower_from_abstract.split_inclusive('\n') {
        if offset > 0 && is_body_heading(line) {
            return Some(offset);
        }
        offset += line.len();
        if offset >= 2500 {
            return Some(2500.min(lower_from_abstract.len()));
        }
    }
    None
}

fn before_references(text: &str) -> &str {
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        if is_references_heading(line) {
            return &text[..offset];
        }
        offset += line.len();
    }
    text
}

fn is_references_heading(line: &str) -> bool {
    matches!(
        heading_core(&line.to_ascii_lowercase()).as_str(),
        "references" | "bibliography" | "works cited" | "参考文献"
    )
}

fn is_body_heading(line: &str) -> bool {
    matches!(
        heading_core(line).as_str(),
        "introduction" | "related work" | "background" | "preliminaries" | "引言" | "简介"
    )
}

fn heading_core(line: &str) -> String {
    let trimmed = line.trim().trim_end_matches([':', '.']).trim();
    let Some((head, rest)) = trimmed.split_once(|c: char| c.is_whitespace()) else {
        return trimmed.to_string();
    };
    let token = head.trim_end_matches(['.', ')']);
    if !token.is_empty()
        && (token.chars().all(|c| c.is_ascii_digit() || c == '.') || is_roman(token))
    {
        return rest.trim().trim_end_matches([':', '.']).trim().to_string();
    }
    trimmed.to_string()
}

fn is_roman(token: &str) -> bool {
    (1..=4).contains(&token.len()) && token.chars().all(|c| matches!(c, 'i' | 'v' | 'x'))
}

fn logical_lines(text: &str) -> Vec<String> {
    let raw: Vec<&str> = text.split_inclusive(['\n', '\r']).collect();
    let mut lines = Vec::new();
    let mut buf = String::new();
    for piece in raw {
        let part = piece.trim_matches(['\n', '\r']).trim();
        if part.is_empty() {
            if !buf.is_empty() {
                lines.push(std::mem::take(&mut buf));
            }
            continue;
        }
        if buf.is_empty() {
            buf = part.to_string();
            continue;
        }
        if continues_url(&buf, part) {
            buf.push_str(part);
        } else {
            lines.push(std::mem::take(&mut buf));
            buf = part.to_string();
        }
    }
    if !buf.is_empty() {
        lines.push(buf);
    }
    lines
}

fn continues_url(buf: &str, next: &str) -> bool {
    if !buf.to_ascii_lowercase().contains("github.com") {
        return false;
    }
    let tail = buf.trim_end().chars().next_back();
    let head = next.trim_start().chars().next();
    matches!(tail, Some('/' | '-' | '.'))
        || matches!(head, Some('/' | '-' | '.' | '?' | '#'))
        || buf.to_ascii_lowercase().trim_end().ends_with("github.com")
}

fn is_reference_entry(line: &str) -> bool {
    let trimmed = line.trim_start();
    if let Some(rest) = trimmed.strip_prefix('[') {
        return rest.chars().next().is_some_and(|c| c.is_ascii_digit());
    }
    let mut digits = 0;
    for c in trimmed.chars() {
        if c.is_ascii_digit() {
            digits += 1;
            if digits > 3 {
                return false;
            }
            continue;
        }
        return digits > 0 && c == '.';
    }
    false
}

fn context_window(line: &str, at: usize) -> String {
    let start = line[..at]
        .char_indices()
        .rev()
        .nth(160)
        .map(|(index, _)| index)
        .unwrap_or(0);
    let end = line[at..]
        .char_indices()
        .nth(80)
        .map(|(index, _)| at + index)
        .unwrap_or(line.len());
    line[start..end].to_ascii_lowercase()
}

fn has_any_cue(window: &str, cues: &[&str]) -> bool {
    cues.iter().any(|cue| find_cue(window, cue).is_some())
}

fn find_cue(haystack: &str, cue: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(rel) = haystack[from..].find(cue) {
        let at = from + rel;
        let before = haystack[..at].chars().next_back();
        let after = haystack[at + cue.len()..].chars().next();
        let boundary_before = before.is_none_or(|c| !c.is_ascii_alphanumeric());
        let boundary_after = cue.ends_with(':') || after.is_none_or(|c| !c.is_ascii_alphanumeric());
        if boundary_before && boundary_after {
            return Some(at);
        }
        from = at + cue.len().max(1);
    }
    None
}

fn tail_str(text: &str, max_chars: usize) -> &str {
    let count = text.chars().count();
    if count <= max_chars {
        return text;
    }
    let start = text
        .char_indices()
        .rev()
        .nth(max_chars - 1)
        .map(|(index, _)| index)
        .unwrap_or(0);
    &text[start..]
}

fn repo_at(text: &str, at: usize) -> Option<(String, Kind)> {
    if !host_boundary(text, at) {
        return None;
    }
    let after = text.get(at + "github.com/".len()..)?;
    let owner_end = after.find(['/', '?', '#']).unwrap_or(after.len());
    let owner = &after[..owner_end];
    let rest = &after[owner_end..];
    if !rest.starts_with('/') {
        return None;
    }
    let repo_src = &rest[1..];
    let repo_end = repo_src.find(['/', '?', '#']).unwrap_or(repo_src.len());
    let mut repo = trim_trailing_punct(&repo_src[..repo_end]).to_string();
    if let Some(stripped) = strip_dot_git(&repo) {
        repo = trim_trailing_punct(stripped).to_string();
    }
    if !valid_owner(owner) || !valid_repo(&repo) {
        return None;
    }
    let kind = path_kind(&repo_src[repo_end..]);
    Some((format!("https://github.com/{owner}/{repo}"), kind))
}

fn path_kind(rest: &str) -> Kind {
    let trimmed = rest.trim_start_matches('/');
    if trimmed.is_empty() || trimmed.starts_with(['?', '#']) {
        return Kind::Root;
    }
    let seg = trimmed.split(['/', '?', '#']).next().unwrap_or("");
    let seg = trim_trailing_punct(seg);
    match seg.to_ascii_lowercase().as_str() {
        "" | "git" => Kind::Root,
        "tree" | "blob" => Kind::Tree,
        _ => Kind::Subpage,
    }
}

fn host_boundary(text: &str, at: usize) -> bool {
    let before = text[..at].to_ascii_lowercase();
    let before_host = before.strip_suffix("www.").unwrap_or(&before);
    if before_host.ends_with("https://") || before_host.ends_with("http://") {
        return true;
    }
    // `gist.github.com` / `api.github.com`, not a repository URL.
    if before.ends_with('.') {
        return false;
    }
    match before.chars().next_back() {
        None => true,
        Some(c) => !c.is_ascii_alphanumeric() && c != '@',
    }
}

fn strip_dot_git(repo: &str) -> Option<&str> {
    let bytes = repo.as_bytes();
    let start = repo.len().checked_sub(4)?;
    if repo.is_char_boundary(start) && bytes[start..].eq_ignore_ascii_case(b".git") {
        Some(&repo[..start])
    } else {
        None
    }
}

fn trim_trailing_punct(value: &str) -> &str {
    value.trim_end_matches(|c: char| {
        matches!(
            c,
            '.' | ',' | ';' | ':' | ')' | ']' | '>' | '\'' | '"' | '!'
        )
    })
}

fn valid_owner(owner: &str) -> bool {
    let len = owner.len();
    if !(1..=39).contains(&len) {
        return false;
    }
    let bytes = owner.as_bytes();
    if bytes[0] == b'-' || bytes[len - 1] == b'-' {
        return false;
    }
    if !owner.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return false;
    }
    let lower = owner.to_ascii_lowercase();
    RESERVED_OWNERS.binary_search(&lower.as_str()).is_err()
}

fn valid_repo(repo: &str) -> bool {
    if repo.is_empty() || repo == "." || repo == ".." || repo.len() > 100 {
        return false;
    }
    repo.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Point in-process PDFium at the library shipped beside the app. The worker
/// already does this; `load_default` otherwise only sees the build machine's
/// cache path. Mirrors `paper::analyze::parse` candidate dirs.
fn ensure_pdfium_search_path() {
    if std::env::var_os("PDFIUM_LIB_PATH").is_some() {
        return;
    }
    if let Some(dir) = bundled_pdfium_dir() {
        std::env::set_var("PDFIUM_LIB_PATH", dir);
    }
}

fn bundled_pdfium_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    let name = if cfg!(target_os = "macos") {
        "libpdfium.dylib"
    } else if cfg!(target_os = "windows") {
        "pdfium.dll"
    } else {
        "libpdfium.so"
    };
    let mut candidates = Vec::new();
    if cfg!(target_os = "macos") {
        candidates.push(exe_dir.join("../Frameworks"));
    }
    candidates.push(exe_dir.join("pdfium"));
    candidates.push(exe_dir.join("../lib/agentero/pdfium"));
    candidates.push(exe_dir.join("../lib/Agentero/pdfium"));
    candidates.push(exe_dir.to_path_buf());
    candidates.into_iter().find(|dir| dir.join(name).is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url_in(region: Region, text: &str) -> Option<String> {
        select(hits_in_region(text, region)).map(|hit| hit.url)
    }

    #[test]
    fn reserved_owners_stay_sorted() {
        let mut sorted = RESERVED_OWNERS.to_vec();
        sorted.sort_unstable();
        assert_eq!(sorted, RESERVED_OWNERS);
    }

    #[test]
    fn normalizes_a_repository_and_prefers_its_homepage_over_a_subpage() {
        assert_eq!(
            url_in(
                Region::Abstract,
                "see https://github.com/Foo/Bar.git/tree/main."
            )
            .as_deref(),
            Some("https://github.com/Foo/Bar")
        );
        let hits = hits_in_region(
            "https://github.com/other/lib/issues/3 https://github.com/ours/code",
            Region::Abstract,
        );
        assert_eq!(
            select(hits).map(|hit| hit.url).as_deref(),
            Some("https://github.com/ours/code")
        );
        assert_eq!(
            url_in(
                Region::Abstract,
                "https://www.github.com/acme/widget/blob/main/README.md"
            )
            .as_deref(),
            Some("https://github.com/acme/widget")
        );
    }

    #[test]
    fn joins_a_url_broken_across_lines() {
        assert_eq!(
            url_in(Region::Abstract, "https://github.com/foo/\nbar-repo").as_deref(),
            Some("https://github.com/foo/bar-repo")
        );
    }

    #[test]
    fn skips_other_hosts_user_pages_and_an_empty_page() {
        assert_eq!(
            url_in(
                Region::Abstract,
                "https://gist.github.com/foo/bar https://notgithub.com/foo/bar https://github.com/foo contact user@github.com/inbox"
            ),
            None
        );
        assert_eq!(url_in(Region::Abstract, "no repository here"), None);
        assert_eq!(
            url_in(Region::Abstract, "https://github.com/topics/rust"),
            None
        );
    }

    #[test]
    fn prefers_this_papers_repo_over_a_citation_or_a_reference_entry() {
        let mut hits = hits_in_region(
            "following Smith et al. https://github.com/other/lib",
            Region::Abstract,
        );
        hits.extend(hits_in_region(
            "Code is available at https://github.com/ours/repo",
            Region::Footnote,
        ));
        let chosen = select(hits).unwrap();
        assert_eq!(chosen.url, "https://github.com/ours/repo");
        assert_eq!(chosen.source, "footnote");

        assert_eq!(
            url_in(
                Region::Closing,
                "[1] A. Author. https://github.com/other/paper"
            ),
            None
        );
        assert_eq!(
            url_in(Region::Body, "https://github.com/somewhere/unrelated"),
            None
        );
        assert_eq!(
            url_in(
                Region::Body,
                "Our code is available at https://github.com/ours/release"
            )
            .as_deref(),
            Some("https://github.com/ours/release")
        );
    }

    #[test]
    fn reads_a_footnote_link_whose_visible_text_is_not_the_url() {
        let content = "BT /F1 12 Tf 20 320 Td (Abstract We study widgets.) Tj ET\n\
             BT /F1 9 Tf 20 28 Td (Code is available here.) Tj ET\n";
        let content_obj = format!(
            "<< /Length {} >>\nstream\n{content}endstream",
            content.len()
        );
        let pdf = pdf_with_objects(&[
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 4 0 R \
              /Resources << /Font << /F1 5 0 R >> >> /Annots [6 0 R] >>",
            &content_obj,
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
            "<< /Type /Annot /Subtype /Link /Rect [10 18 180 42] /Border [0 0 0] \
              /A << /S /URI /URI (https://github.com/acme/widget) >> >>",
        ]);
        let found = extract_github_repo(&pdf).unwrap();
        assert_eq!(found.url, "https://github.com/acme/widget");
        assert_eq!(found.source, "footnote");
    }

    #[test]
    fn reads_a_github_url_printed_in_the_abstract() {
        let content = "BT /F1 12 Tf 20 260 Td (Abstract) Tj ET\n\
             BT /F1 12 Tf 20 240 Td (Code: https://github.com/acme/abstract-repo.) Tj ET\n\
             BT /F1 12 Tf 20 180 Td (Introduction) Tj ET\n\
             BT /F1 12 Tf 20 160 Td (See Smith et al. https://github.com/other/cited.) Tj ET\n";
        let content_obj = format!(
            "<< /Length {} >>\nstream\n{content}endstream",
            content.len()
        );
        let pdf = pdf_with_objects(&[
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 4 0 R \
              /Resources << /Font << /F1 5 0 R >> >> >>",
            &content_obj,
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        ]);
        let found = extract_github_repo(&pdf).unwrap();
        assert_eq!(found.url, "https://github.com/acme/abstract-repo");
        assert_eq!(found.source, "abstract");
    }

    #[test]
    fn reads_the_last_page_and_ignores_a_bibliography_only_repository() {
        let conclusion =
            "BT /F1 12 Tf 20 60 Td (We conclude. Code: https://github.com/ours/repo) Tj ET\n";
        let conclusion_obj = format!(
            "<< /Length {} >>\nstream\n{conclusion}endstream",
            conclusion.len()
        );
        let intro = "BT /F1 12 Tf 20 60 Td (Introduction) Tj ET\n";
        let intro_obj = format!("<< /Length {} >>\nstream\n{intro}endstream", intro.len());
        let found = extract_github_repo(&pdf_with_objects(&[
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R \
              /Resources << /Font << /F1 5 0 R >> >> >>",
            &intro_obj,
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 7 0 R \
              /Resources << /Font << /F1 5 0 R >> >> >>",
            &conclusion_obj,
        ]))
        .unwrap();
        assert_eq!(found.url, "https://github.com/ours/repo");
        assert_eq!(found.source, "closing");

        let refs = "BT /F1 12 Tf 20 80 Td (References) Tj ET\n\
             BT /F1 12 Tf 20 60 Td ([1] A. https://github.com/other/paper) Tj ET\n";
        let refs_obj = format!("<< /Length {} >>\nstream\n{refs}endstream", refs.len());
        assert_eq!(
            extract_github_repo(&pdf_with_objects(&[
                "<< /Type /Catalog /Pages 2 0 R >>",
                "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R \
                  /Resources << /Font << /F1 5 0 R >> >> >>",
                &intro_obj,
                "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 7 0 R \
                  /Resources << /Font << /F1 5 0 R >> >> >>",
                &refs_obj,
            ])),
            None
        );
    }

    #[test]
    fn keeps_the_abstract_repository_when_the_bibliography_has_another() {
        let first = "BT /F1 12 Tf 20 240 Td (Abstract https://github.com/ours/paper) Tj ET\n\
             BT /F1 12 Tf 20 180 Td (Introduction) Tj ET\n";
        let first_obj = format!("<< /Length {} >>\nstream\n{first}endstream", first.len());
        let refs = "BT /F1 12 Tf 20 80 Td (References) Tj ET\n\
             BT /F1 12 Tf 20 60 Td ([1] https://github.com/other/paper) Tj ET\n";
        let refs_obj = format!("<< /Length {} >>\nstream\n{refs}endstream", refs.len());
        let found = extract_github_repo(&pdf_with_objects(&[
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 4 0 R \
              /Resources << /Font << /F1 5 0 R >> >> >>",
            &first_obj,
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 7 0 R \
              /Resources << /Font << /F1 5 0 R >> >> >>",
            &refs_obj,
        ]))
        .unwrap();
        assert_eq!(found.url, "https://github.com/ours/paper");
        assert_eq!(found.source, "abstract");
    }

    fn pdf_with_objects(objects: &[&str]) -> Vec<u8> {
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::with_capacity(objects.len());
        for (index, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend_from_slice(format!("{} 0 obj\n{object}\nendobj\n", index + 1).as_bytes());
        }
        let xref = pdf.len();
        pdf.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
        pdf.extend_from_slice(b"0000000000 65535 f \n");
        for offset in offsets {
            pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        pdf.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
                objects.len() + 1
            )
            .as_bytes(),
        );
        pdf
    }
}
