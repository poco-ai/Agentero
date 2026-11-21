//! PDFium page geometry + text layer for headless analysis.
//!
//! Reads the same text layer the desktop renderer sees, but without EmbedPDF:
//! per-character boxes in viewport points (top-left origin, 72 DPI) plus the
//! page viewport size, so the provider's normalized boxes and the PDF text
//! share one coordinate space.
//!
//! Uses the shared `liteparse-pdfium` binding (one process-global PDFium lock;
//! see `features::pdf::text` / `features::pdf::locate`). Desktop PDFium comes
//! from the app bundle, the CLI resolves the same dylib via `liteparse`.

use crate::error::AppError;
use crate::features::pdf::layout_region::{is_usable_dimension, Rect};

/// One text-layer character with its on-page box (viewport points).
#[derive(Debug, Clone, PartialEq)]
pub struct PageChar {
    pub ch: char,
    /// Viewport-space box, top-left origin.
    pub rect: Rect,
}

/// One visual text line (chars grouped by baseline); used for caption recovery
/// and region text assembly.
#[derive(Debug, Clone, PartialEq)]
pub struct TextLine {
    /// Line text with single spaces inserted at real word gaps.
    pub text: String,
    /// Union box in viewport points.
    pub rect: Rect,
}

/// One page's text layer + geometry.
#[derive(Debug, Clone, PartialEq)]
pub struct PageText {
    /// 0-based page index.
    pub index: u32,
    /// Viewport width in points.
    pub width: f32,
    /// Viewport height in points.
    pub height: f32,
    /// Text-layer characters in PDFium read order.
    pub chars: Vec<PageChar>,
    /// Whitespace-stripped text-layer character count for this page.
    pub text_chars: u32,
}

impl PageText {
    /// Group characters into visual lines (top-to-bottom, left-to-right).
    pub fn lines(&self) -> Vec<TextLine> {
        let median_width = self.median_char_width();
        let mut lines: Vec<TextLine> = Vec::new();
        for group in self.grouped_chars() {
            let text = assemble_text(&group, median_width);
            if text.is_empty() {
                continue;
            }
            let Some(rect) = union_rect(&group) else {
                continue;
            };
            lines.push(TextLine { text, rect });
        }
        lines.sort_by(|a, b| {
            a.rect
                .y
                .total_cmp(&b.rect.y)
                .then(a.rect.x.total_cmp(&b.rect.x))
        });
        lines
    }

    /// Text whose character centers fall inside `rect` (viewport points),
    /// assembled in reading order with word gaps as single spaces.
    pub fn text_in_rect(&self, rect: Rect) -> String {
        if rect.w <= 0.0 || rect.h <= 0.0 {
            return String::new();
        }
        let median_width = self.median_char_width();
        let mut parts: Vec<String> = Vec::new();
        for group in self.grouped_chars() {
            let inside: Vec<&PageChar> = group
                .iter()
                .copied()
                .filter(|item| char_center_in_rect(item, rect))
                .collect();
            let text = assemble_text(&inside, median_width);
            if !text.is_empty() {
                parts.push(text);
            }
        }
        parts.join(" ").trim().to_string()
    }

    /// Median glyph advance width; the word-gap threshold derives from it.
    fn median_char_width(&self) -> f64 {
        let mut widths: Vec<f64> = self
            .chars
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

    /// Characters grouped per visual line, each group sorted left-to-right and
    /// the groups ordered top-to-bottom then left-to-right.
    fn grouped_chars(&self) -> Vec<Vec<&PageChar>> {
        let mut sorted: Vec<&PageChar> = self.chars.iter().collect();
        sorted.sort_by(|a, b| {
            a.rect
                .y
                .total_cmp(&b.rect.y)
                .then(a.rect.x.total_cmp(&b.rect.x))
        });

        let mut groups: Vec<Vec<&PageChar>> = Vec::new();
        for item in sorted {
            let joins_last = groups.last().is_some_and(|group| {
                let anchor = group[0].rect.y;
                let line_height = group
                    .iter()
                    .map(|member| member.rect.h)
                    .fold(item.rect.h, f64::max)
                    .max(1.0);
                // Same baseline: tops differ by less than half a line.
                (item.rect.y - anchor).abs() <= line_height * 0.5
            });
            if joins_last {
                groups.last_mut().expect("checked above").push(item);
            } else {
                groups.push(vec![item]);
            }
        }
        for group in &mut groups {
            group.sort_by(|a, b| a.rect.x.total_cmp(&b.rect.x));
        }
        groups.sort_by(|a, b| {
            let a_top = a.iter().map(|item| item.rect.y).fold(f64::MAX, f64::min);
            let b_top = b.iter().map(|item| item.rect.y).fold(f64::MAX, f64::min);
            let a_left = a.iter().map(|item| item.rect.x).fold(f64::MAX, f64::min);
            let b_left = b.iter().map(|item| item.rect.x).fold(f64::MAX, f64::min);
            a_top.total_cmp(&b_top).then(a_left.total_cmp(&b_left))
        });
        groups
    }
}

/// Assemble one line of characters, inserting a single space at whitespace
/// characters and at real word gaps. Collapses runs; trims the result.
fn assemble_text(chars: &[&PageChar], median_width: f64) -> String {
    let gap_threshold = (median_width * 0.25).max(1.0);
    let mut out = String::new();
    let mut previous_right: Option<f64> = None;
    let mut pending_space = false;
    for item in chars {
        if item.ch.is_whitespace() {
            pending_space = true;
            continue;
        }
        if !out.is_empty() {
            let gap = previous_right.map_or(0.0, |right| item.rect.x - right);
            if pending_space || gap > gap_threshold {
                out.push(' ');
            }
        }
        out.push(item.ch);
        pending_space = false;
        previous_right = Some(item.rect.x + item.rect.w);
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// True when the character center lies inside `rect` (inclusive edges).
fn char_center_in_rect(item: &PageChar, rect: Rect) -> bool {
    let cx = item.rect.x + item.rect.w / 2.0;
    let cy = item.rect.y + item.rect.h / 2.0;
    cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h
}

/// Union of the characters' boxes, in viewport points.
fn union_rect(chars: &[&PageChar]) -> Option<Rect> {
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

/// Read every page's viewport size and text layer.
///
/// Returns one entry per page in document order. Pages without a text layer
/// yield an empty `chars` (never an error); only an unreadable PDF errors.
pub fn read_pdf_pages(bytes: &[u8]) -> Result<Vec<PageText>, AppError> {
    let lib = crate::features::pdf::open_library()?;
    let doc = lib
        .load_document_from_bytes(bytes, None)
        .map_err(|e| AppError::message(format!("open pdf: {e:?}")))?;
    let page_count = doc.page_count().max(0);
    let mut out = Vec::with_capacity(page_count.max(0) as usize);
    for index in 0..page_count {
        let page = doc
            .page(index)
            .map_err(|e| AppError::message(format!("load page {}: {e:?}", index + 1)))?;
        let Some(view_box) = page.view_box() else {
            // A page without a readable box still yields a (textless) row so
            // the page count stays trustworthy.
            out.push(PageText {
                index: index as u32,
                width: page.width().max(0.0),
                height: page.height().max(0.0),
                chars: Vec::new(),
                text_chars: 0,
            });
            continue;
        };
        let (width, height) = page.viewport_size(&view_box);

        let mut chars: Vec<PageChar> = Vec::new();
        let mut text_chars = 0u32;
        if let Ok(text_page) = page.text() {
            let total = text_page.char_count().max(0);
            if total > 0 {
                text_chars = text_page
                    .get_text(0, total)
                    .chars()
                    .filter(|c| !c.is_whitespace())
                    .count() as u32;
            }
            for item in text_page.chars() {
                let Some(ch) = char::from_u32(item.unicode()) else {
                    continue;
                };
                if ch == '\0' || ch.is_control() || ch == '\u{fffd}' {
                    continue;
                }
                // PDFium char boxes are in PDF page space (bottom-left origin);
                // viewport conversion applies rotation + `/UserUnit` and flips y.
                // Prefer the "loose" glyph box: it is the font em box, so
                // neighbouring advances stay contiguous and the word-gap
                // heuristic does not invent spaces inside words.
                let page_bounds = item.loose_char_box().or_else(|| {
                    item.char_box().map(|b| liteparse_pdfium::RectF {
                        left: b.left as f32,
                        top: b.top as f32,
                        right: b.right as f32,
                        bottom: b.bottom as f32,
                    })
                });
                let Some(page_bounds) = page_bounds else {
                    continue;
                };
                let viewport = page.bounds_to_viewport(&view_box, &page_bounds);
                let w = viewport.right - viewport.left;
                let h = viewport.bottom - viewport.top;
                if !is_usable_dimension(w) && !is_usable_dimension(h) {
                    continue;
                }
                chars.push(PageChar {
                    ch,
                    rect: Rect::new(
                        viewport.left as f64,
                        viewport.top as f64,
                        w as f64,
                        h as f64,
                    ),
                });
            }
        }
        out.push(PageText {
            index: index as u32,
            width,
            height,
            chars,
            text_chars,
        });
    }
    Ok(out)
}
