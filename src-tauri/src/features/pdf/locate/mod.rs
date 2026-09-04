//! Quote → on-page rects via the PDFium text engine.
//!
//! Mirrors the viewer's `searchInPage` semantics (EmbedPDF is the same PDFium
//! build) so a CLI-resolved rect lands where a hand-drawn selection would.
//! liteparse's layout reconstruction is deliberately not involved here — it
//! serves `PAPER.md`, not page geometry.
//!
//! @see docs/development/mark-cli-roadmap.md
//! @see src/components/viewer/pdf/coords.ts (the 0–1 normalization this matches)

use crate::core::error::AppError;
use liteparse_pdfium::{Library, RectF};
use serde::{Deserialize, Serialize};

pub mod annotations;

fn default_max_matches() -> usize {
    50
}

/// Shortest quote worth searching: single words match everywhere and would
/// silently highlight the wrong sentence.
const MIN_QUOTE_CHARS: usize = 4;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocateRequest {
    /// Empty means "measure only": report `measure_pages` sizes, search nothing.
    #[serde(default)]
    pub quote: String,
    /// 1-based page hint. When it yields a hit, other pages are not scanned.
    #[serde(default)]
    pub page: Option<u32>,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default = "default_max_matches")]
    pub max_matches: usize,
    /// 1-based pages whose point dimensions the caller needs.
    #[serde(default)]
    pub measure_pages: Vec<u32>,
}

impl LocateRequest {
    pub fn new(quote: impl Into<String>) -> Self {
        Self {
            quote: quote.into(),
            page: None,
            case_sensitive: false,
            max_matches: default_max_matches(),
            measure_pages: Vec::new(),
        }
    }

    /// Request page dimensions only.
    pub fn measure(pages: Vec<u32>) -> Self {
        Self {
            quote: String::new(),
            page: None,
            case_sensitive: false,
            max_matches: 0,
            measure_pages: pages,
        }
    }
}

/// Page box in points, in the same top-left viewport space as [`NormRect`].
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSize {
    pub page: u32,
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocateResult {
    pub matches: Vec<LocateMatch>,
    pub pages: Vec<PageSize>,
}

/// Rect normalized to 0–1 against the page box, top-left origin, y down —
/// identical to what the viewer persists for ask/translate marks.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct NormRect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocateMatch {
    /// 1-based, matching on-disk mark `page`.
    pub page: u32,
    pub char_index: i32,
    pub char_count: i32,
    /// One rect per visual line (PDFium already merges within a line).
    pub rects: Vec<NormRect>,
    /// Viewport page size in points, for callers that need unnormalized rects.
    pub page_width: f32,
    pub page_height: f32,
}

/// Page text with a folded-index → original-index map, so a whitespace-tolerant
/// match can be translated back into PDFium character offsets. Same trick as
/// Zotero's `_charMapping` in `pdf-find-controller.js`.
struct FoldedText {
    chars: Vec<char>,
    origin: Vec<i32>,
}

/// Collapse whitespace runs to one space, fold typographic variants to their
/// ASCII form, and drop leading/trailing padding.
///
/// The typographic folding is what makes an Agent-supplied quote usable: quotes
/// are copied from TeX / `PAPER.md` (ASCII `'`, `-`) while the PDF text layer
/// carries what the typesetter emitted (`’`, en/em dashes, `ﬁ`/`ﬂ` ligatures).
/// Without it, every possessive and every word containing "fi" would miss.
/// Both needle and page text go through this same function, so the two sides
/// always agree.
///
/// Lowercasing takes the first char of `to_lowercase()` to keep the index map
/// 1:1; the few multi-char expansions (e.g. `İ`) fall back to exact matching.
fn fold(raw: &str, case_sensitive: bool) -> FoldedText {
    let mut chars: Vec<char> = Vec::with_capacity(raw.len());
    let mut origin: Vec<i32> = Vec::with_capacity(raw.len());
    let mut pending_space: Option<usize> = None;
    for (i, ch) in raw.chars().enumerate() {
        if ch.is_whitespace() {
            if !chars.is_empty() && pending_space.is_none() {
                pending_space = Some(i);
            }
            continue;
        }
        if let Some(at) = pending_space.take() {
            chars.push(' ');
            origin.push(at as i32);
        }
        // A ligature is one PDF character but several source characters; they
        // all point back at it, which is what the boundary lookup needs.
        if let Some(expanded) = expand_ligature(ch) {
            for part in expanded.chars() {
                chars.push(if case_sensitive {
                    part
                } else {
                    part.to_lowercase().next().unwrap_or(part)
                });
                origin.push(i as i32);
            }
            continue;
        }
        let ch = normalize_punctuation(ch);
        let ch = if case_sensitive {
            ch
        } else {
            ch.to_lowercase().next().unwrap_or(ch)
        };
        chars.push(ch);
        origin.push(i as i32);
    }
    FoldedText { chars, origin }
}

fn expand_ligature(ch: char) -> Option<&'static str> {
    match ch {
        '\u{FB00}' => Some("ff"),
        '\u{FB01}' => Some("fi"),
        '\u{FB02}' => Some("fl"),
        '\u{FB03}' => Some("ffi"),
        '\u{FB04}' => Some("ffl"),
        '\u{FB05}' | '\u{FB06}' => Some("st"),
        _ => None,
    }
}

fn normalize_punctuation(ch: char) -> char {
    match ch {
        '\u{2018}' | '\u{2019}' | '\u{201B}' | '\u{02BC}' | '\u{00B4}' | '\u{2032}' => '\'',
        '\u{201C}' | '\u{201D}' | '\u{201F}' | '\u{2033}' => '"',
        '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}'
        | '\u{2212}' | '\u{00AD}' => '-',
        '\u{2026}' => '.',
        '\u{00A0}' | '\u{202F}' => ' ',
        other => other,
    }
}

/// All folded-space positions where `needle` occurs in `haystack`.
fn find_all(haystack: &[char], needle: &[char]) -> Vec<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return Vec::new();
    }
    let mut hits = Vec::new();
    for start in 0..=(haystack.len() - needle.len()) {
        if haystack[start..start + needle.len()] == *needle {
            hits.push(start);
        }
    }
    hits
}

/// Fold and additionally drop hyphens, spaces, and characters PDFium could not
/// decode.
///
/// Two things break a strict match on real papers: a compound split at a line
/// end reads back as `token-to- token` while the quote says `token-to-token`,
/// and a font with a broken `ToUnicode` map yields noncharacters (this paper
/// returns `U+FFFE` for one of those hyphens). Collapsing both sides to the
/// characters that can be trusted makes them agree. Used strictly as a
/// fallback, since ignoring word boundaries could otherwise match across them.
fn fold_loose(raw: &str, case_sensitive: bool) -> FoldedText {
    let folded = fold(raw, case_sensitive);
    let mut chars = Vec::with_capacity(folded.chars.len());
    let mut origin = Vec::with_capacity(folded.chars.len());
    for (i, ch) in folded.chars.iter().enumerate() {
        if *ch == '-' || *ch == ' ' || is_undecodable(*ch) {
            continue;
        }
        chars.push(*ch);
        origin.push(folded.origin[i]);
    }
    FoldedText { chars, origin }
}

/// A code point that carries no text: the replacement char, or a Unicode
/// noncharacter, which is what PDFium emits for a glyph it cannot map.
fn is_undecodable(ch: char) -> bool {
    let c = ch as u32;
    ch == '\u{FFFD}' || (c & 0xFFFE) == 0xFFFE || (0xFDD0..=0xFDEF).contains(&c)
}

/// The quote in both matching forms; `loose` is only consulted when `strict`
/// finds nothing on a page.
struct Needle {
    strict: FoldedText,
    loose: FoldedText,
}

fn clamp01(v: f32) -> f32 {
    v.clamp(0.0, 1.0)
}

/// Locate every occurrence of `req.quote`, and/or measure `req.measure_pages`.
/// Matches come back in page order, except that a satisfied `req.page` hint
/// short-circuits the rest of the document.
pub fn locate_in_pdf(pdf: &[u8], req: &LocateRequest) -> Result<LocateResult, AppError> {
    let needle = Needle {
        strict: fold(&req.quote, req.case_sensitive),
        loose: fold_loose(&req.quote, req.case_sensitive),
    };
    let searching = !needle.strict.chars.is_empty();
    if searching && needle.strict.chars.len() < MIN_QUOTE_CHARS {
        return Err(AppError::message(format!(
            "quote is too short to locate reliably (need at least {MIN_QUOTE_CHARS} non-space characters)"
        )));
    }

    let lib = Library::init();
    let doc = lib
        .load_document_from_bytes(pdf, None)
        .map_err(|e| AppError::message(format!("open pdf: {e:?}")))?;
    let page_count = doc.page_count();
    if page_count <= 0 {
        return Ok(LocateResult::default());
    }

    let hint = req
        .page
        .and_then(|p| i32::try_from(p).ok())
        .map(|p| p - 1)
        .filter(|p| *p >= 0 && *p < page_count);

    let mut matches: Vec<LocateMatch> = Vec::new();
    if searching {
        let hint_hits = match hint {
            Some(index) => {
                locate_in_page(&doc, index, &needle, req.case_sensitive, req.max_matches)?
            }
            None => Vec::new(),
        };
        if !hint_hits.is_empty() {
            matches = hint_hits;
        } else {
            for index in 0..page_count {
                if matches.len() >= req.max_matches {
                    break;
                }
                if Some(index) == hint {
                    continue; // already scanned, found nothing
                }
                let remaining = req.max_matches - matches.len();
                matches.extend(locate_in_page(
                    &doc,
                    index,
                    &needle,
                    req.case_sensitive,
                    remaining,
                )?);
            }
            matches.sort_by_key(|m| (m.page, m.char_index));
        }
    }

    let mut pages = Vec::new();
    for page in &req.measure_pages {
        let Ok(index) = i32::try_from(*page) else {
            continue;
        };
        let index = index - 1;
        if index < 0 || index >= page_count {
            continue;
        }
        if let Some((width, height)) = page_size(&doc, index) {
            pages.push(PageSize {
                page: *page,
                width,
                height,
            });
        }
    }

    Ok(LocateResult { matches, pages })
}

fn page_size(doc: &liteparse_pdfium::Document<'_>, page_index: i32) -> Option<(f32, f32)> {
    let page = doc.page(page_index).ok()?;
    let view_box = page.view_box()?;
    Some(page.viewport_size(&view_box))
}

fn locate_in_page(
    doc: &liteparse_pdfium::Document<'_>,
    page_index: i32,
    needle: &Needle,
    case_sensitive: bool,
    max_matches: usize,
) -> Result<Vec<LocateMatch>, AppError> {
    if max_matches == 0 {
        return Ok(Vec::new());
    }
    let page = doc
        .page(page_index)
        .map_err(|e| AppError::message(format!("load page {}: {e:?}", page_index + 1)))?;
    let Some(view_box) = page.view_box() else {
        return Ok(Vec::new());
    };
    let (page_width, page_height) = page.viewport_size(&view_box);
    if page_width <= 0.0 || page_height <= 0.0 {
        return Ok(Vec::new());
    }
    let text_page = page
        .text()
        .map_err(|e| AppError::message(format!("load text page {}: {e:?}", page_index + 1)))?;
    let total = text_page.char_count();
    if total <= 0 {
        return Ok(Vec::new());
    }
    let raw = text_page.get_text(0, total);
    let hay = fold(&raw, case_sensitive);
    let mut hits = find_all(&hay.chars, &needle.strict.chars);
    // Line-broken hyphenation only shows up in the loose form.
    let (hay, needle_len) = if hits.is_empty() {
        let loose = fold_loose(&raw, case_sensitive);
        hits = find_all(&loose.chars, &needle.loose.chars);
        let len = needle.loose.chars.len();
        (loose, len)
    } else {
        let len = needle.strict.chars.len();
        (hay, len)
    };
    if needle_len == 0 {
        return Ok(Vec::new());
    }

    let mut out = Vec::new();
    for start in hits.into_iter().take(max_matches) {
        let end = start + needle_len - 1;
        let char_index = hay.origin[start];
        let char_count = hay.origin[end] - char_index + 1;
        let rect_count = text_page.count_rects(char_index, char_count);
        let mut rects = Vec::new();
        for i in 0..rect_count {
            let Some(r) = text_page.rect(i) else { continue };
            let page_bounds = RectF {
                left: r.left as f32,
                top: r.top as f32,
                right: r.right as f32,
                bottom: r.bottom as f32,
            };
            // Crate-side conversion handles page rotation; never hand-flip y.
            let v = page.bounds_to_viewport(&view_box, &page_bounds);
            let w = (v.right - v.left) / page_width;
            let h = (v.bottom - v.top) / page_height;
            if w <= 0.0 || h <= 0.0 {
                continue;
            }
            rects.push(NormRect {
                x: clamp01(v.left / page_width),
                y: clamp01(v.top / page_height),
                w: clamp01(w),
                h: clamp01(h),
            });
        }
        if rects.is_empty() {
            continue;
        }
        out.push(LocateMatch {
            page: (page_index + 1) as u32,
            char_index,
            char_count,
            rects,
            page_width,
            page_height,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_whitespace_runs_and_maps_back() {
        let folded = fold("Hello\n  world", false);
        assert_eq!(folded.chars.iter().collect::<String>(), "hello world");
        // The space maps to the first whitespace char, `world` to its own index.
        assert_eq!(folded.origin[5], 5);
        assert_eq!(folded.origin[6], 8);
    }

    #[test]
    fn folds_typeset_punctuation_and_ligatures_to_ascii() {
        // Left: what PDFium reads out of a typeset page. Right: what an Agent
        // copies from TeX. They must fold to the same characters.
        let typeset = fold("the drafter\u{2019}s re\u{FB01}nement\u{2014}fast", false);
        let ascii = fold("the drafter's refinement-fast", false);
        assert_eq!(
            typeset.chars.iter().collect::<String>(),
            ascii.chars.iter().collect::<String>()
        );
        assert_eq!(
            typeset.chars.iter().collect::<String>(),
            "the drafter's refinement-fast"
        );
        // Both chars of an expanded ligature point back at the single source char.
        let lig = fold("re\u{FB01}ne", false);
        assert_eq!(lig.chars.iter().collect::<String>(), "refine");
        assert_eq!(lig.origin[2], 2);
        assert_eq!(lig.origin[3], 2);
    }

    #[test]
    fn loose_fold_bridges_line_broken_hyphenation() {
        // What PDFium reads when "token-to-token" is split at a line end.
        let page = fold_loose("restoring the token-to-\ntoken dependencies", false);
        let quote = fold_loose("token-to-token dependencies", false);
        assert_eq!(find_all(&page.chars, &quote.chars).len(), 1);
        // The strict pass genuinely cannot, which is why the fallback exists.
        let strict_page = fold("restoring the token-to-\ntoken dependencies", false);
        let strict_quote = fold("token-to-token dependencies", false);
        assert!(find_all(&strict_page.chars, &strict_quote.chars).is_empty());
    }

    #[test]
    fn loose_fold_bridges_undecodable_glyphs() {
        // Observed in the wild (arXiv 2608.02438 p13): a broken ToUnicode map
        // returns U+FFFE where the hyphen should be.
        let page = fold_loose("restoring the token\u{FFFE}to-token dependencies", false);
        let quote = fold_loose("restoring the token-to-token dependencies", false);
        assert_eq!(find_all(&page.chars, &quote.chars).len(), 1);
    }

    #[test]
    fn keeps_case_when_requested() {
        let folded = fold("Attention Is All", true);
        assert_eq!(folded.chars.iter().collect::<String>(), "Attention Is All");
    }

    #[test]
    fn finds_every_occurrence() {
        let hay: Vec<char> = "ab ab ab".chars().collect();
        let needle: Vec<char> = "ab".chars().collect();
        assert_eq!(find_all(&hay, &needle), vec![0, 3, 6]);
    }

    #[test]
    fn find_all_handles_oversized_needle() {
        let hay: Vec<char> = "ab".chars().collect();
        let needle: Vec<char> = "abc".chars().collect();
        assert!(find_all(&hay, &needle).is_empty());
    }

    #[test]
    fn rejects_short_quotes() {
        let err = locate_in_pdf(b"", &LocateRequest::new("a b")).unwrap_err();
        assert!(err.to_string().contains("too short"));
    }

    #[test]
    fn measure_only_requests_skip_the_length_guard() {
        let err = locate_in_pdf(b"not a pdf", &LocateRequest::measure(vec![1])).unwrap_err();
        assert!(err.to_string().contains("open pdf"), "got {err}");
    }

    /// Minimal one-page PDF with a real xref table, so PDFium loads it without
    /// falling back to reconstruction.
    fn tiny_pdf(text: &str) -> Vec<u8> {
        let content = format!("BT /F1 12 Tf 20 60 Td ({text}) Tj ET\n");
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R \
              /Resources << /Font << /F1 5 0 R >> >> >>"
                .to_string(),
            format!(
                "<< /Length {} >>\nstream\n{content}endstream",
                content.len()
            ),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
        ];

        let mut out = String::from("%PDF-1.4\n");
        let mut offsets = Vec::with_capacity(objects.len());
        for (i, body) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.push_str(&format!("{} 0 obj\n{body}\nendobj\n", i + 1));
        }
        let xref_at = out.len();
        out.push_str(&format!("xref\n0 {}\n", objects.len() + 1));
        out.push_str("0000000000 65535 f \n");
        for offset in &offsets {
            out.push_str(&format!("{offset:010} 00000 n \n"));
        }
        out.push_str(&format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n",
            objects.len() + 1
        ));
        out.into_bytes()
    }

    #[test]
    fn locates_a_sentence_in_top_left_space() {
        let pdf = tiny_pdf("Attention is all you need");
        let result = locate_in_pdf(&pdf, &LocateRequest::new("all you need")).expect("locate");
        assert_eq!(result.matches.len(), 1, "{:?}", result.matches);
        let hit = &result.matches[0];
        assert_eq!(hit.page, 1);
        assert!(!hit.rects.is_empty());
        assert!((hit.page_width - 200.0).abs() < 0.5, "w {}", hit.page_width);
        assert!(
            (hit.page_height - 100.0).abs() < 0.5,
            "h {}",
            hit.page_height
        );
        let r = hit.rects[0];
        // Text sits at PDF y=60 on a 100pt page, i.e. the upper third once the
        // origin flips to top-left. A missing flip would put y near 0.4+.
        assert!(r.y < 0.45, "expected a top-half rect, got y={}", r.y);
        assert!(
            r.x > 0.05,
            "expected the rect to start past the margin, got x={}",
            r.x
        );
        assert!(r.w > 0.1 && r.h > 0.05, "implausible rect {r:?}");

        // Independent check through a different PDFium API: the words must
        // actually live inside the rect we computed.
        let inside = text_inside(&pdf, hit, 0);
        assert!(
            inside.contains("all you need"),
            "rect does not cover the quote; PDFium read {inside:?}"
        );
    }

    /// Read the text PDFium finds inside a located rect, by converting back to
    /// PDF user space (bottom-left origin). Only valid for unrotated pages.
    fn text_inside(pdf: &[u8], hit: &LocateMatch, rect_index: usize) -> String {
        let r = hit.rects[rect_index];
        let lib = Library::init();
        let doc = lib
            .load_document_from_bytes(pdf, None)
            .expect("open pdf for round trip");
        let page = doc.page(hit.page as i32 - 1).expect("page");
        let text_page = page.text().expect("text page");
        let left = (r.x * hit.page_width) as f64;
        let right = ((r.x + r.w) * hit.page_width) as f64;
        let top = (hit.page_height - r.y * hit.page_height) as f64;
        let bottom = (hit.page_height - (r.y + r.h) * hit.page_height) as f64;
        text_page.bounded_text(left, top, right, bottom)
    }

    /// Check a real paper end to end:
    /// ```text
    /// AGENTERO_LOCATE_LIVE_PDF=/path/paper.pdf \
    /// AGENTERO_LOCATE_LIVE_QUOTE="…verbatim sentence…" \
    /// cargo test -p agentero --lib live_locate -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "requires AGENTERO_LOCATE_LIVE_PDF"]
    fn live_locate_round_trip() {
        let path = std::env::var("AGENTERO_LOCATE_LIVE_PDF").expect("set AGENTERO_LOCATE_LIVE_PDF");
        let quote =
            std::env::var("AGENTERO_LOCATE_LIVE_QUOTE").expect("set AGENTERO_LOCATE_LIVE_QUOTE");
        let pdf = std::fs::read(&path).expect("read pdf");
        let result = locate_in_pdf(&pdf, &LocateRequest::new(&quote)).expect("locate");
        let hit = result.matches.first().expect("no match");
        println!(
            "page {} chars {}..{} rects {:?} page {}x{}",
            hit.page,
            hit.char_index,
            hit.char_index + hit.char_count,
            hit.rects,
            hit.page_width,
            hit.page_height
        );
        for i in 0..hit.rects.len() {
            let inside = text_inside(&pdf, hit, i);
            println!("rect {i} covers: {inside:?}");
            assert!(!inside.trim().is_empty(), "rect {i} covers no text");
        }
        let first_word = quote.split_whitespace().next().unwrap_or_default();
        assert!(
            text_inside(&pdf, hit, 0).contains(first_word),
            "first rect does not cover the start of the quote"
        );
    }
}
