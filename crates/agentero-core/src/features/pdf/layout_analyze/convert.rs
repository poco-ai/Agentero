//! Provider boxes → raw layout regions.
//!
//! Mirrors `paddlePageToRegions` in `src/lib/pdf/layout/paddle.ts`: provider
//! boxes come back in rendered-image pixels (Paddle) or page points (MinerU)
//! from a whole-document job; the result reports the rendered page size when
//! the service knows it, otherwise a 144 DPI render is assumed.

use crate::features::paper::analyze::layout::hosted::LayoutRemotePageResult;
use crate::features::pdf::layout_region::{
    is_usable_dimension, reaches_min_score, LayoutKind, LayoutRegion, Rect,
};

/// Fallback render DPI when the provider reports no rendered page size; only
/// the point `rect` (text enrichment) can drift, the normalized `bbox` is exact.
pub const ASSUMED_RENDER_DPI: f64 = 144.0;

/// Minimum provider score kept as a region (same gate as the local plugin).
pub const LAYOUT_MIN_SCORE: f64 = 0.3;

/// Convert one provider page's boxes into raw regions.
///
/// `page_size` is the PDF page viewport size in points, `page` carries the
/// provider boxes + rendered size. Boxes whose label maps to no kind, whose
/// score is below [`LAYOUT_MIN_SCORE`], or with non-positive area are dropped.
/// Reading order is assigned after sorting top-to-bottom / left-to-right.
pub fn page_to_regions(
    page: &LayoutRemotePageResult,
    page_index: u32,
    page_size: (f32, f32),
    id_prefix: &str,
) -> Vec<LayoutRegion> {
    let (page_width, page_height) = page_size;
    if !is_usable_dimension(page_width) || !is_usable_dimension(page_height) {
        return Vec::new();
    }
    // Provider boxes are in rendered-image pixels. The service reports the
    // rendered size for Paddle (and sometimes MinerU); without it assume a
    // 144 DPI render of the point size, which leaves `bbox` exact.
    let width_px = match page.width_px {
        Some(width) if width > 0 => width as f64,
        _ => page_width as f64 * ASSUMED_RENDER_DPI / 72.0,
    };
    let height_px = match page.height_px {
        Some(height) if height > 0 => height as f64,
        _ => page_height as f64 * ASSUMED_RENDER_DPI / 72.0,
    };
    if !is_usable_dimension(width_px) || !is_usable_dimension(height_px) {
        return Vec::new();
    }
    let scale_x = page_width as f64 / width_px;
    let scale_y = page_height as f64 / height_px;
    let page_width = page_width as f64;
    let page_height = page_height as f64;

    let mut regions: Vec<LayoutRegion> = Vec::new();
    for detection in &page.boxes {
        let Some(kind) = LayoutKind::from_label(&detection.label) else {
            continue;
        };
        if !reaches_min_score(detection.score, LAYOUT_MIN_SCORE) {
            continue;
        }
        let [x1, y1, x2, y2] = detection.coordinate;
        let left = x1.min(x2);
        let top = y1.min(y2);
        let w = (x2 - x1).abs();
        let h = (y2 - y1).abs();
        if !is_usable_dimension(w) || !is_usable_dimension(h) {
            continue;
        }
        let x = left * scale_x;
        let y = top * scale_y;
        let rect = Rect::new(x, y, w * scale_x, h * scale_y);
        let bbox = bbox_of(rect, (page_width as f32, page_height as f32));

        let text = detection
            .text
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        // Captions carry their own text; the model also puts the caption text
        // on `figure_title` boxes without a `caption` field.
        let title = detection
            .caption
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| {
                (kind == LayoutKind::FigureTitle)
                    .then(|| text.clone())
                    .flatten()
            });

        regions.push(LayoutRegion {
            // Index in the accepted order *before* the reading-order sort,
            // matching the desktop `regions.length` counter.
            id: format!("{id_prefix}-{page_index}-{}", regions.len()),
            page_index,
            kind,
            label: detection.label.clone(),
            score: clamp01(detection.score),
            reading_order: regions.len() as f64,
            rect,
            bbox,
            text,
            title,
            title_bbox: None,
            caption_role: None,
            caption_page_index: None,
            caption_bbox: None,
        });
    }

    // Provider order is score-descending; approximate reading order by
    // vertical position (column-aware ordering is out of scope here).
    regions.sort_by(|a, b| {
        a.rect
            .y
            .total_cmp(&b.rect.y)
            .then(a.rect.x.total_cmp(&b.rect.x))
    });
    for (order, region) in regions.iter_mut().enumerate() {
        region.reading_order = order as f64;
    }
    regions
}

/// Convert every provider page into raw regions (page order preserved).
///
/// `page_sizes[i]` is the viewport size for page `i`; `None` skips the page.
/// Unmapped labels are dropped exactly like the desktop converter.
pub fn regions_from_pages(
    pages: &[LayoutRemotePageResult],
    page_sizes: &[Option<(f32, f32)>],
    id_prefix: &str,
) -> Vec<LayoutRegion> {
    let mut regions = Vec::new();
    for (page_index, page) in pages.iter().enumerate() {
        let Some(Some((width, height))) = page_sizes.get(page_index) else {
            continue;
        };
        if !is_usable_dimension(*width) || !is_usable_dimension(*height) {
            continue;
        }
        regions.extend(page_to_regions(
            page,
            page_index as u32,
            (*width, *height),
            id_prefix,
        ));
    }
    regions
}

fn clamp01(value: f64) -> f64 {
    value.clamp(0.0, 1.0)
}

fn bbox_of(rect: Rect, page_size: (f32, f32)) -> Rect {
    let (width, height) = (page_size.0 as f64, page_size.1 as f64);
    Rect::new(
        clamp01(rect.x / width),
        clamp01(rect.y / height),
        clamp01(rect.w / width),
        clamp01(rect.h / height),
    )
}
