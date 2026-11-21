//! Text-layer enrichment of raw regions: captions, body text, caption roles,
//! and page coverage stats.
//!
//! Mirrors `enrichCaptionRegionsWithText` + `recoverCaptionsFromRuns` from the
//! desktop renderer (`src/lib/pdf/layout/title-text.ts`,
//! `src/lib/pdf/layout/captions-from-runs.ts`): the provider only returns
//! boxes, so the text that makes a figure title searchable comes from the PDF
//! text layer here.

use crate::features::pdf::layout_analyze::pdf_text::{PageChar, PageText, TextLine};
use crate::features::pdf::layout_region::{
    is_usable_dimension, reaches_min_score, CaptionRole, LayoutCompleteness,
    LayoutCompletenessWarning, LayoutKind, LayoutPageStats, LayoutRegion, Rect,
    LAYOUT_SIDEBAR_MIN_SCORE,
};
use std::collections::HashMap;

/// Visual coverage below which a text-heavy page is flagged as a content gap.
const VISUAL_PAGE_AREA: f64 = 0.45;
/// Uncovered text characters that make a content-gap page actionable.
const MIN_WARNING_TEXT_CHARS: u32 = 32;

/// Enrich every region with the PDF text layer and compute page stats.
///
/// * Caption kinds (`figure_title` / `header`): `title` + `text` from the
///   characters inside the box, plus a [`CaptionRole`] derived from the text
///   ("Table 2: …" labeled `figure_title` still becomes `table_main`) or
///   geometry (`(a) …` → `subpanel`).
/// * Body kinds (`text` / `abstract`): `text` from the characters inside.
/// * Numbered captions the provider missed are recovered from text lines
///   (`Figure 3: …`, `Table 1: …`), matching the desktop recovery pass.
/// * Algorithms / figures / tables / formulas keep detection `text` unset.
///
/// `page_count` is the document page count (not `pages.len()`), so a
/// `--pages` subset still reports the true coverage and its incompleteness.
pub fn enrich_regions(
    raw: Vec<LayoutRegion>,
    pages: &[PageText],
    page_count: u32,
) -> (Vec<LayoutRegion>, LayoutCompleteness) {
    let by_page: HashMap<u32, &PageText> = pages.iter().map(|page| (page.index, page)).collect();
    let mut page_indices: Vec<u32> = by_page.keys().copied().collect();
    page_indices.sort_unstable();

    let mut regions = raw;
    for page_index in &page_indices {
        if let Some(page) = by_page.get(page_index) {
            enrich_page(&mut regions, *page_index, page);
        }
    }
    for page_index in &page_indices {
        if let Some(page) = by_page.get(page_index) {
            recover_captions(&mut regions, *page_index, page);
        }
    }

    let completeness = build_completeness(&regions, &page_indices, &by_page, page_count);
    (regions, completeness)
}

/// Write text / titles / caption roles for one page's regions in place.
fn enrich_page(regions: &mut [LayoutRegion], page_index: u32, page: &PageText) {
    // Caption geometry fallback may look at neighbouring hosts; snapshot them
    // so the mutable walk below does not alias the slice.
    let hosts: Vec<(LayoutKind, Rect)> = regions
        .iter()
        .filter(|region| region.page_index == page_index)
        .filter(|region| {
            matches!(
                region.kind,
                LayoutKind::Image | LayoutKind::Chart | LayoutKind::Table | LayoutKind::Algorithm
            )
        })
        .map(|region| (region.kind, region.bbox))
        .collect();

    for region in regions
        .iter_mut()
        .filter(|region| region.page_index == page_index)
    {
        if region.kind.is_caption() {
            let extracted = page.text_in_rect(region.rect);
            let title = non_empty(extracted).or_else(|| non_empty_owned(region.title.clone()));
            let text = title
                .clone()
                .or_else(|| non_empty_owned(region.text.clone()));
            if title.is_some() {
                region.title = title.clone();
            }
            if text.is_some() {
                region.text = text.clone();
            }
            let role_source = title.as_deref().or(text.as_deref()).unwrap_or_default();
            let mut role = caption_role_from_text(role_source);
            if role == CaptionRole::Other {
                role = caption_role_from_geometry(region, &hosts);
            }
            region.caption_role = Some(role);
        } else if matches!(region.kind, LayoutKind::Text | LayoutKind::Abstract) {
            // A parsing nicety (splitting broad boxes at paragraph gaps) is
            // desktop-only; headless keeps one region per detection box.
            let fresh = page.text_in_rect(region.rect);
            if !fresh.trim().is_empty() {
                region.text = Some(fresh);
            }
        }
    }
}

/// Semantic role of a caption from its text. Mirrors `captionRoleFromText`.
fn caption_role_from_text(text: &str) -> CaptionRole {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return CaptionRole::Other;
    }
    if starts_with_numbered(trimmed, &["table", "tab"]) {
        return CaptionRole::TableMain;
    }
    if starts_with_numbered(trimmed, &["algorithm", "alg"]) {
        return CaptionRole::AlgorithmMain;
    }
    if starts_with_numbered(trimmed, &["figure", "fig"]) {
        return CaptionRole::FigureMain;
    }
    if looks_like_subpanel(trimmed) {
        return CaptionRole::Subpanel;
    }
    CaptionRole::Other
}

/// `Table 2`, `Tab. 2`, `Figure 3`, `Alg. 1`, … (case-insensitive).
fn starts_with_numbered(text: &str, words: &[&str]) -> bool {
    let lower = text.trim().to_ascii_lowercase();
    for word in words {
        let Some(rest) = lower.strip_prefix(word) else {
            continue;
        };
        // The prefix must end at a word boundary: `table2` is not `table 2`.
        if rest
            .chars()
            .next()
            .is_some_and(|next| next.is_ascii_alphanumeric())
        {
            continue;
        }
        let rest = rest.strip_prefix('.').unwrap_or(rest);
        let rest = rest.trim_start();
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        if digits.is_empty() {
            continue;
        }
        let after = rest[digits.len()..].chars().next();
        if after.is_some_and(|next| next.is_ascii_alphanumeric()) {
            continue;
        }
        return true;
    }
    false
}

/// `(a)`, `a)`, or a lone panel letter.
fn looks_like_subpanel(text: &str) -> bool {
    let trimmed = text.trim();
    let rest = trimmed.strip_prefix('(').unwrap_or(trimmed);
    let mut chars = rest.chars();
    match (chars.next(), chars.next()) {
        (Some(letter), Some(')')) => letter.is_ascii_alphabetic(),
        (Some(letter), None) => letter.is_ascii_alphabetic(),
        _ => false,
    }
}

/// Geometry fallback when the caption text is missing/ambiguous
/// (mirror of `captionRoleFromGeometry` plus a near-host heuristic).
fn caption_role_from_geometry(region: &LayoutRegion, hosts: &[(LayoutKind, Rect)]) -> CaptionRole {
    // Wide caption bar → likely a main figure/table title.
    if region.bbox.w >= 0.45 && region.bbox.h <= 0.2 {
        return if region.kind == LayoutKind::FigureTitle {
            CaptionRole::FigureMain
        } else {
            CaptionRole::Other
        };
    }
    // Directly above/below a compatible host on the same page.
    for (kind, host) in hosts {
        let role = match kind {
            LayoutKind::Image | LayoutKind::Chart => CaptionRole::FigureMain,
            LayoutKind::Table => CaptionRole::TableMain,
            LayoutKind::Algorithm => CaptionRole::AlgorithmMain,
            _ => continue,
        };
        let horizontally_overlaps =
            region.bbox.x < host.x + host.w && region.bbox.x + region.bbox.w > host.x;
        if !horizontally_overlaps {
            continue;
        }
        let below_gap = region.bbox.y - (host.y + host.h);
        let above_gap = host.y - (region.bbox.y + region.bbox.h);
        let max_gap = (region.bbox.h * 1.5).max(0.03);
        if (0.0..=max_gap).contains(&below_gap) || (0.0..=max_gap).contains(&above_gap) {
            return role;
        }
    }
    CaptionRole::Other
}

/// Existing figure_title region used to deduplicate recovered captions.
struct CaptionSnapshot {
    id: String,
    bbox: Rect,
    reading_order: f64,
    caption_key: Option<String>,
    text_len: usize,
}

/// Recover numbered captions the provider missed from the page text lines.
fn recover_captions(regions: &mut Vec<LayoutRegion>, page_index: u32, page: &PageText) {
    if !is_usable_dimension(page.width) || !is_usable_dimension(page.height) {
        return;
    }
    let lines = caption_lines(page);
    if lines.is_empty() {
        return;
    }
    let page_width = page.width as f64;
    let page_height = page.height as f64;

    let captions: Vec<CaptionSnapshot> = regions
        .iter()
        .filter(|region| region.page_index == page_index && region.kind == LayoutKind::FigureTitle)
        .map(|region| CaptionSnapshot {
            id: region.id.clone(),
            bbox: region.bbox,
            reading_order: region.reading_order,
            caption_key: numbered_caption_key(
                region
                    .title
                    .as_deref()
                    .or(region.text.as_deref())
                    .unwrap_or_default(),
            ),
            text_len: region
                .title
                .as_deref()
                .or(region.text.as_deref())
                .unwrap_or_default()
                .len(),
        })
        .collect();

    let next_order = regions
        .iter()
        .filter(|region| region.page_index == page_index)
        .map(|region| region.reading_order)
        .fold(f64::NEG_INFINITY, f64::max);
    let mut next_order = if next_order.is_finite() {
        next_order + 1.0
    } else {
        0.0
    };
    let mut seen: Vec<String> = Vec::new();

    for (line_index, line) in lines.iter().enumerate() {
        let Some(key) = numbered_caption_key(&line.text) else {
            continue;
        };
        if seen.contains(&key) {
            continue;
        }
        seen.push(key.clone());

        let existing = captions
            .iter()
            .find(|caption| caption.caption_key.as_deref() == Some(key.as_str()));
        let center = rect_center(&line.rect);
        let center_covered = captions.iter().any(|caption| {
            point_in_bbox(center.0 / page_width, center.1 / page_height, caption.bbox)
        });
        if existing.is_none() && center_covered {
            continue;
        }

        let selected = caption_paragraph(line_index, &lines, page_height * 0.65);
        let Some(rect) = union_rect(&selected) else {
            continue;
        };
        let title = selected
            .iter()
            .map(|line| line.text.trim())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if title.is_empty() {
            continue;
        }
        // Optional: publishers repeat the caption geometry; stop at page edges.
        if !is_usable_dimension(rect.w) || !is_usable_dimension(rect.h) {
            continue;
        }
        let recovered = LayoutRegion {
            id: existing
                .map(|caption| caption.id.clone())
                .unwrap_or_else(|| format!("pdf-caption-{page_index}-{key}")),
            page_index,
            kind: LayoutKind::FigureTitle,
            label: "figure_title".into(),
            score: 0.9,
            reading_order: existing
                .map(|caption| caption.reading_order)
                .unwrap_or(next_order),
            rect,
            bbox: Rect::new(
                clamp01(rect.x / page_width),
                clamp01(rect.y / page_height),
                clamp01(rect.w / page_width),
                clamp01(rect.h / page_height),
            ),
            text: Some(title.clone()),
            title: Some(title.clone()),
            title_bbox: None,
            caption_role: Some(caption_role_from_key(&key)),
            caption_page_index: None,
            caption_bbox: None,
        };

        match existing {
            None => {
                regions.push(recovered);
                next_order += 1.0;
            }
            Some(caption) => {
                // Keep the provider box unless the recovered caption is larger
                // and clearly lives inside it (same rule as the desktop pass).
                let (cx, cy) = rect_center(&Rect::new(
                    caption.bbox.x * page_width,
                    caption.bbox.y * page_height,
                    caption.bbox.w * page_width,
                    caption.bbox.h * page_height,
                ));
                let contained =
                    cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h;
                if title.len() > caption.text_len && contained {
                    if let Some(target) = regions
                        .iter_mut()
                        .find(|region| region.id == caption.id && region.page_index == page_index)
                    {
                        *target = recovered;
                    }
                }
            }
        }
    }
}

/// Visual lines for caption recovery, split at column gutters.
///
/// `PageText::lines()` groups by baseline only, so two side-by-side columns on
/// one baseline merge into a single line (e.g. page 7 of 2602.01326:
/// "…length-4 masks. Figure 3: Ablation on merging rate scheduler"). The
/// desktop `captionLines` splits each baseline at its physical gutter before
/// matching; this is that split, so a caption that starts a right column is
/// still seen as a line start.
fn caption_lines(page: &PageText) -> Vec<TextLine> {
    if page.chars.is_empty() {
        return Vec::new();
    }
    let median_width = median_char_width(&page.chars);
    let mut sorted: Vec<&PageChar> = page.chars.iter().collect();
    sorted.sort_by(|a, b| {
        a.rect
            .y
            .total_cmp(&b.rect.y)
            .then(a.rect.x.total_cmp(&b.rect.x))
    });

    // Baseline grouping, same tolerance as `PageText::lines`.
    let mut groups: Vec<Vec<&PageChar>> = Vec::new();
    for item in sorted {
        let joins_last = groups.last().is_some_and(|group| {
            let anchor = group[0].rect.y;
            let line_height = group
                .iter()
                .map(|member| member.rect.h)
                .fold(item.rect.h, f64::max)
                .max(1.0);
            (item.rect.y - anchor).abs() <= line_height * 0.5
        });
        if joins_last {
            groups.last_mut().expect("checked above").push(item);
        } else {
            groups.push(vec![item]);
        }
    }

    let mut lines: Vec<TextLine> = Vec::new();
    for group in &mut groups {
        group.sort_by(|a, b| a.rect.x.total_cmp(&b.rect.x));
        let mut current: Vec<&PageChar> = Vec::new();
        for item in group.iter().copied() {
            if item.ch.is_whitespace() {
                continue;
            }
            let is_gutter = current.last().is_some_and(|previous| {
                let gap = item.rect.x - (previous.rect.x + previous.rect.w);
                let min_height = previous.rect.h.min(item.rect.h).max(1.0);
                gap > (min_height * 0.75).max(8.0)
            });
            if is_gutter {
                if let Some(line) = caption_line(&current, median_width) {
                    lines.push(line);
                }
                current.clear();
            }
            current.push(item);
        }
        if let Some(line) = caption_line(&current, median_width) {
            lines.push(line);
        }
    }
    lines.sort_by(|a, b| {
        a.rect
            .y
            .total_cmp(&b.rect.y)
            .then(a.rect.x.total_cmp(&b.rect.x))
    });
    lines
}

/// Build one caption line from its characters (word gaps become single
/// spaces, whitespace glyphs are skipped; geometry is the visible-char union).
fn caption_line(chars: &[&PageChar], median_width: f64) -> Option<TextLine> {
    let gap_threshold = (median_width * 0.25).max(1.0);
    let mut text = String::new();
    let mut previous_right: Option<f64> = None;
    for item in chars {
        if !text.is_empty() {
            let gap = previous_right.map_or(0.0, |right| item.rect.x - right);
            if gap > gap_threshold {
                text.push(' ');
            }
        }
        text.push(item.ch);
        previous_right = Some(item.rect.x + item.rect.w);
    }
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return None;
    }
    let rect = union_rect_chars(chars)?;
    Some(TextLine { text, rect })
}

fn union_rect_chars(chars: &[&PageChar]) -> Option<Rect> {
    let first = chars.first()?;
    let mut left = first.rect.x;
    let mut top = first.rect.y;
    let mut right = first.rect.x + first.rect.w;
    let mut bottom = first.rect.y + first.rect.h;
    for item in chars.iter().skip(1) {
        left = left.min(item.rect.x);
        top = top.min(item.rect.y);
        right = right.max(item.rect.x + item.rect.w);
        bottom = bottom.max(item.rect.y + item.rect.h);
    }
    Some(Rect::new(
        left,
        top,
        (right - left).max(0.0),
        (bottom - top).max(0.0),
    ))
}

fn median_char_width(chars: &[PageChar]) -> f64 {
    let mut widths: Vec<f64> = chars
        .iter()
        .map(|item| item.rect.w)
        .filter(|width| *width > 0.0)
        .collect();
    if widths.is_empty() {
        return 0.0;
    }
    widths.sort_by(f64::total_cmp);
    widths[widths.len() / 2]
}

/// Caption lines that continue `start` (same left edge, small vertical gap,
/// no new numbered caption). Bounded like the desktop `paragraph()` walk.
fn caption_paragraph(start_index: usize, lines: &[TextLine], max_height: f64) -> Vec<TextLine> {
    let start = &lines[start_index];
    let mut selected = vec![start.clone()];
    let left_tolerance = (start.rect.h * 0.6).max(3.0);
    let height_tolerance = (start.rect.h * 0.25).max(1.5);
    for line in lines.iter().skip(start_index + 1) {
        let previous = selected.last().expect("non-empty");
        // Lines from another column (or another stacked element) are skipped,
        // not treated as the end of the paragraph — matching the desktop walk.
        if line.rect.y <= previous.rect.y || (line.rect.x - start.rect.x).abs() > left_tolerance {
            continue;
        }
        let vertical_gap = line.rect.y - (previous.rect.y + previous.rect.h);
        if line.rect.y - start.rect.y > max_height
            || vertical_gap > (start.rect.h * 0.75).max(2.0)
            || (line.rect.h - start.rect.h).abs() > height_tolerance
            || numbered_caption_key(&line.text).is_some()
            || starts_table_or_algorithm_number(&line.text)
        {
            break;
        }
        selected.push(line.clone());
        if selected.len() >= 64 {
            break;
        }
    }
    selected
}

/// Desktop `paragraph()` guard: `/^(?:table|algorithm)\s+\d/i` stops a caption
/// paragraph even when the line is body prose about a table/algorithm.
fn starts_table_or_algorithm_number(text: &str) -> bool {
    let lower = text.trim().to_ascii_lowercase();
    for word in ["table", "algorithm"] {
        let Some(rest) = lower.strip_prefix(word) else {
            continue;
        };
        let rest = rest.trim_start();
        if rest.len() == lower[word.len()..].len() {
            continue; // no whitespace after the word
        }
        if rest.chars().next().is_some_and(|ch| ch.is_ascii_digit()) {
            return true;
        }
    }
    false
}

/// Desktop `numberedCaptionKey` (`captions-from-runs.ts`): only numbered
/// Figure/Table starts that read like a caption. Body prose such as
/// "Table 1 shows …" or "Figure 4 shows …" is intentionally rejected, and
/// algorithms are never recovered from text lines (the desktop has no
/// algorithm alternative here).
fn numbered_caption_key(text: &str) -> Option<String> {
    let trimmed = text.trim();
    table_caption_key(trimmed).or_else(|| figure_caption_key(trimmed))
}

/// `^tab(?:le)?\.?\s*(\d+)\s*[:.|]\s+\S` — table captions require an
/// explicit separator, so "Table 2 Values …" stays body text.
fn table_caption_key(text: &str) -> Option<String> {
    let rest =
        take_prefix_ignore_case(text, "table").or_else(|| take_prefix_ignore_case(text, "tab"))?;
    let rest = rest.strip_prefix('.').unwrap_or(rest);
    let rest = rest.trim_start();
    let digits = leading_digits(rest)?;
    let rest = rest[digits.len()..].trim_start();
    let mut chars = rest.chars();
    let separator = chars.next()?;
    if !matches!(separator, ':' | '.' | '|') {
        return None;
    }
    let rest = &rest[separator.len_utf8()..];
    // `\s+\S`: separator-adjacent whitespace then a non-space character.
    let after_space = trim_ws(rest);
    if after_space.len() == rest.len() || after_space.is_empty() {
        return None;
    }
    Some(format!("table-{digits}"))
}

/// `^(extended\s+data\s+)?fig(?:ure)?\.?\s*(\d+)(tail)` where `tail` must
/// look like the start of a caption (see [`figure_tail_is_caption`]). Mirrors
/// `figureCaptionKey` in `src/lib/pdf/layout/figure-caption-text.ts`.
fn figure_caption_key(text: &str) -> Option<String> {
    let (extended, rest) = split_extended_data_prefix(text)?;
    let rest =
        take_prefix_ignore_case(rest, "figure").or_else(|| take_prefix_ignore_case(rest, "fig"))?;
    let rest = rest.strip_prefix('.').unwrap_or(rest);
    let rest = rest.trim_start();
    let digits = leading_digits(rest)?;
    let tail = &rest[digits.len()..];
    if !figure_tail_is_caption(tail) {
        return None;
    }
    let prefix = if extended {
        "extended-figure"
    } else {
        "figure"
    };
    Some(format!("{prefix}-{digits}"))
}

/// Split the optional `Extended Data ` prefix; `None` when the text starts
/// with "extended" but does not match `extended\s+data\s+` (the desktop
/// regex cannot match such a line either).
fn split_extended_data_prefix(text: &str) -> Option<(bool, &str)> {
    let Some(after_extended) = take_prefix_ignore_case(text, "extended") else {
        return Some((false, text));
    };
    let after_extended_ws = trim_ws(after_extended);
    if after_extended_ws.len() == after_extended.len() {
        return None; // no `\s+` after "extended"
    }
    let after_data = take_prefix_ignore_case(after_extended_ws, "data")?;
    let after_data_ws = trim_ws(after_data);
    if after_data_ws.len() == after_data.len() {
        return None; // no `\s+` after "data"
    }
    Some((true, after_data_ws))
}

/// Tail rule from `figureCaptionKey` (case-sensitive on purpose):
/// separator, whitespace + capitalized word, OCR-joined capitalized word
/// (3+ letters), or a subpanel marker + capitalized word.
fn figure_tail_is_caption(tail: &str) -> bool {
    if has_separator_tail(tail) {
        return true;
    }
    let after_space = trim_ws(tail);
    let had_space = after_space.len() < tail.len();
    if had_space && starts_capital_lower(after_space) {
        return true;
    }
    if starts_capital_lower2(tail) {
        return true;
    }
    had_space && paren_subpanel_tail(after_space)
}

/// `\s*[:.|]\s*\S`
fn has_separator_tail(tail: &str) -> bool {
    let rest = trim_ws(tail);
    let mut chars = rest.chars();
    let Some(separator) = chars.next() else {
        return false;
    };
    if !matches!(separator, ':' | '.' | '|') {
        return false;
    }
    let rest = trim_ws(&rest[separator.len_utf8()..]);
    !rest.is_empty()
}

/// `[A-Z][a-z]`
fn starts_capital_lower(text: &str) -> bool {
    let mut chars = text.chars();
    matches!(
        (chars.next(), chars.next()),
        (Some(first), Some(second))
            if first.is_ascii_uppercase() && second.is_ascii_lowercase()
    )
}

/// `[A-Z][a-z]{2}` (OCR-joined word right after the number)
fn starts_capital_lower2(text: &str) -> bool {
    let mut chars = text.chars();
    matches!(
        (chars.next(), chars.next(), chars.next()),
        (Some(first), Some(second), Some(third))
            if first.is_ascii_uppercase()
                && second.is_ascii_lowercase()
                && third.is_ascii_lowercase()
    )
}

/// `\(?[a-z]\)?\s+[A-Z][a-z]` for `(a) Concentration` style subpanels.
fn paren_subpanel_tail(text: &str) -> bool {
    let rest = text.strip_prefix('(').unwrap_or(text);
    let mut chars = rest.chars();
    let Some(letter) = chars.next() else {
        return false;
    };
    if !letter.is_ascii_lowercase() {
        return false;
    }
    let rest = &rest[letter.len_utf8()..];
    let rest = rest.strip_prefix(')').unwrap_or(rest);
    let after_space = trim_ws(rest);
    if after_space.len() == rest.len() || after_space.is_empty() {
        return false;
    }
    starts_capital_lower(after_space)
}

fn take_prefix_ignore_case<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let length = prefix.len();
    (text.len() >= length
        && text.is_char_boundary(length)
        && text[..length].eq_ignore_ascii_case(prefix))
    .then(|| &text[length..])
}

fn leading_digits(text: &str) -> Option<String> {
    let digits: String = text.chars().take_while(char::is_ascii_digit).collect();
    (!digits.is_empty()).then_some(digits)
}

fn trim_ws(text: &str) -> &str {
    text.trim_start_matches(char::is_whitespace)
}

fn caption_role_from_key(key: &str) -> CaptionRole {
    if key.starts_with("table-") {
        CaptionRole::TableMain
    } else {
        CaptionRole::FigureMain
    }
}

/// Page stats + completeness over the pages actually enriched.
fn build_completeness(
    regions: &[LayoutRegion],
    page_indices: &[u32],
    by_page: &HashMap<u32, &PageText>,
    page_count: u32,
) -> LayoutCompleteness {
    // A run is text-layer complete only when every document page was walked.
    let text_layer_complete =
        page_count > 0 && (0..page_count).all(|page| by_page.contains_key(&page));
    // Partial (`--pages`) runs report only the pages they actually processed;
    // that keeps the sidecar deliberately "incomplete" for the desktop cache.
    let stat_pages: Vec<u32> = if text_layer_complete {
        (0..page_count).collect()
    } else {
        page_indices.to_vec()
    };

    let page_stats: Vec<LayoutPageStats> = stat_pages
        .iter()
        .map(|page_index| {
            build_page_stats(
                regions,
                *page_index,
                by_page
                    .get(page_index)
                    .map(|page| page.text_chars)
                    .unwrap_or(0),
            )
        })
        .collect();

    // Mirror `buildLayoutCompleteness`: content-gap warnings only exist for a
    // complete text-layer walk.
    let mut warning_pages: Vec<u32> = Vec::new();
    if text_layer_complete {
        for stats in &page_stats {
            if stats.translatable_region_count > 0 {
                continue;
            }
            if stats.visual_area.unwrap_or(0.0) >= VISUAL_PAGE_AREA {
                continue;
            }
            let uncovered = stats
                .text_chars
                .saturating_sub(stats.excluded_text_chars.unwrap_or(0));
            if uncovered >= MIN_WARNING_TEXT_CHARS {
                warning_pages.push(stats.page_index);
            }
        }
    }
    let warnings = if warning_pages.is_empty() {
        Vec::new()
    } else {
        vec![LayoutCompletenessWarning {
            code: "content-gap".into(),
            pages: warning_pages,
        }]
    };

    LayoutCompleteness {
        page_count,
        processed_pages: stat_pages,
        text_layer_complete,
        page_stats,
        warnings,
        content_repair_attempted: false,
    }
}

/// One page's coverage row (mirror of `buildLayoutPageStats`).
fn build_page_stats(regions: &[LayoutRegion], page_index: u32, text_chars: u32) -> LayoutPageStats {
    let page_regions: Vec<&LayoutRegion> = regions
        .iter()
        .filter(|region| region.page_index == page_index)
        .collect();
    let mut translatable_region_count = 0u32;
    let mut excluded_text_chars = 0u32;
    let mut visual_area = 0.0f64;
    for region in &page_regions {
        let label = region.label.trim().to_ascii_lowercase();
        let is_visual = is_visual_kind(region.kind);
        let source_text = region
            .text
            .as_deref()
            .or(region.title.as_deref())
            .unwrap_or_default();
        let char_count = source_text.chars().filter(|ch| !ch.is_whitespace()).count() as u32;
        let preserved = is_visual
            || matches!(
                label.as_str(),
                "reference" | "reference_content" | "aside_text"
            )
            || is_algorithm_title_text(source_text);
        if preserved {
            excluded_text_chars += char_count;
        }
        if is_visual {
            visual_area += region.bbox.area();
        }
        if is_translatable_region(region, &label) {
            translatable_region_count += 1;
        }
    }
    LayoutPageStats {
        page_index,
        region_count: page_regions.len() as u32,
        text_chars,
        translatable_region_count,
        excluded_text_chars: Some(excluded_text_chars),
        visual_area: Some(visual_area.min(1.0)),
    }
}

/// Mirror of `listTranslatableLayoutRegions`: kind, score, text, and the
/// label/text exceptions that keep source-language-only content out.
fn is_translatable_region(region: &LayoutRegion, label: &str) -> bool {
    if !region.kind.is_translatable() {
        return false;
    }
    if !reaches_min_score(region.score, LAYOUT_SIDEBAR_MIN_SCORE) {
        return false;
    }
    if matches!(label, "aside_text" | "reference" | "reference_content") {
        return false;
    }
    let source_text = region
        .text
        .as_deref()
        .or(region.title.as_deref())
        .unwrap_or_default()
        .trim();
    if source_text.is_empty() {
        return false;
    }
    !is_algorithm_title_text(source_text)
}

fn is_visual_kind(kind: LayoutKind) -> bool {
    matches!(
        kind,
        LayoutKind::Image
            | LayoutKind::Chart
            | LayoutKind::Table
            | LayoutKind::Algorithm
            | LayoutKind::Formula
            | LayoutKind::FormulaNumber
    )
}

/// "Algorithm 1" / "Alg. 2" style titles stay in the source language.
fn is_algorithm_title_text(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    let rest = if let Some(rest) = lower.strip_prefix("algorithm") {
        rest
    } else if let Some(rest) = lower.strip_prefix("alg") {
        rest
    } else {
        return false;
    };
    let rest = rest.strip_prefix('.').unwrap_or(rest);
    let rest = rest.trim_start();
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    !digits.is_empty()
}

fn non_empty(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn non_empty_owned(value: Option<String>) -> Option<String> {
    value.and_then(non_empty)
}

fn rect_center(rect: &Rect) -> (f64, f64) {
    (rect.x + rect.w / 2.0, rect.y + rect.h / 2.0)
}

fn point_in_bbox(x: f64, y: f64, bbox: Rect) -> bool {
    x >= bbox.x && x <= bbox.x + bbox.w && y >= bbox.y && y <= bbox.y + bbox.h
}

fn union_rect(lines: &[TextLine]) -> Option<Rect> {
    let first = lines.first()?;
    let mut left = first.rect.x;
    let mut top = first.rect.y;
    let mut right = first.rect.x + first.rect.w;
    let mut bottom = first.rect.y + first.rect.h;
    for line in lines.iter().skip(1) {
        left = left.min(line.rect.x);
        top = top.min(line.rect.y);
        right = right.max(line.rect.x + line.rect.w);
        bottom = bottom.max(line.rect.y + line.rect.h);
    }
    Some(Rect::new(
        left,
        top,
        (right - left).max(0.0),
        (bottom - top).max(0.0),
    ))
}

fn clamp01(value: f64) -> f64 {
    value.clamp(0.0, 1.0)
}
