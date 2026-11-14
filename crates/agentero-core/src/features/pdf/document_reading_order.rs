//! Repair y-only provider order for columnar paragraph anchors. Keep in sync
//! with src/lib/pdf/layout/document-reading-order.ts.

use super::layout_index::RawLayoutRegion;
use std::cmp::Ordering;

fn stored_order(a: &RawLayoutRegion, b: &RawLayoutRegion) -> Ordering {
    a.reading_order
        .unwrap_or(u32::MAX)
        .cmp(&b.reading_order.unwrap_or(u32::MAX))
        .then_with(|| a.bbox.y.total_cmp(&b.bbox.y))
        .then_with(|| a.bbox.x.total_cmp(&b.bbox.x))
        .then_with(|| a.id.cmp(&b.id))
}

fn page_order<'a>(page: &[&'a RawLayoutRegion]) -> Vec<&'a RawLayoutRegion> {
    if page.iter().any(|r| {
        let b = &r.bbox;
        ![b.x, b.y, b.w, b.h].iter().all(|v| v.is_finite()) || b.w <= 0.0 || b.h <= 0.0
    }) {
        return page.to_vec();
    }
    // Body intervals establish columns; short/inset headings are not evidence
    // of a second column. Wide body blocks are horizontal band separators.
    let mut body: Vec<_> = page
        .iter()
        .copied()
        .filter(|r| {
            matches!(r.kind.as_str(), "text" | "paragraph" | "abstract")
                && r.text.as_deref().is_some_and(|s| !s.trim().is_empty())
                && r.bbox.w <= 0.6
        })
        .collect();
    body.sort_by(|a, b| a.bbox.x.total_cmp(&b.bbox.x));
    let mut gutter = None;
    let mut gap = 0.0;
    let mut support = 0;
    for row in &body {
        let mut intervals: Vec<(f64, f64)> = Vec::new();
        for r in &body {
            let b = &r.bbox;
            if (row.bbox.y + row.bbox.h).min(b.y + b.h) <= row.bbox.y.max(b.y) {
                continue;
            }
            if let Some(last) = intervals.last_mut().filter(|last| b.x - last.1 < 0.002) {
                last.1 = last.1.max(b.x + b.w);
            } else {
                intervals.push((b.x, b.x + b.w));
            }
        }
        for pair in intervals.windows(2) {
            let width = pair[1].0 - pair[0].1;
            let mid = (pair[0].1 + pair[1].0) / 2.0;
            let count = body
                .iter()
                .filter(|r| r.bbox.x + r.bbox.w <= mid || r.bbox.x >= mid)
                .count();
            if count < support || (count == support && width <= gap) {
                continue;
            }
            let overlaps = body.iter().filter(|a| a.bbox.x + a.bbox.w <= mid).any(|a| {
                body.iter().filter(|b| b.bbox.x >= mid).any(|b| {
                    (a.bbox.y + a.bbox.h).min(b.bbox.y + b.bbox.h) > a.bbox.y.max(b.bbox.y)
                })
            });
            if overlaps {
                gutter = Some(mid);
                gap = width;
                support = count;
            }
        }
    }
    let Some(mid) = gutter else {
        return page.to_vec();
    };
    let spans_gutter = |r: &&RawLayoutRegion| r.bbox.x < mid && r.bbox.x + r.bbox.w > mid;
    let mut spans: Vec<_> = page.iter().copied().filter(spans_gutter).collect();
    spans.sort_by(|a, b| {
        a.bbox
            .y
            .total_cmp(&b.bbox.y)
            .then_with(|| stored_order(a, b))
    });
    let mut remaining: Vec<_> = page.iter().copied().filter(|r| !spans_gutter(r)).collect();
    let columns = |a: &&RawLayoutRegion, b: &&RawLayoutRegion| {
        (a.bbox.x >= mid)
            .cmp(&(b.bbox.x >= mid))
            .then_with(|| a.bbox.y.total_cmp(&b.bbox.y))
            .then_with(|| stored_order(a, b))
    };
    let mut ordered = Vec::with_capacity(page.len());
    for span in spans {
        let (mut before, after): (Vec<_>, Vec<_>) =
            remaining.into_iter().partition(|r| r.bbox.y < span.bbox.y);
        before.sort_by(columns);
        ordered.extend(before);
        ordered.push(span);
        remaining = after;
    }
    remaining.sort_by(columns);
    ordered.extend(remaining);
    ordered
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::pdf::layout_index::Bbox;

    #[test]
    fn affiliations_precede_the_adjacent_abstract_column() {
        let regions: Vec<_> = [
            ("authors", "text", 0.08, 0.23, 0.7, 0.05),
            ("affiliation-1", "text", 0.08, 0.31, 0.28, 0.03),
            ("abstract-title", "header", 0.41, 0.32, 0.1, 0.02),
            ("abstract", "abstract", 0.41, 0.34, 0.5, 0.38),
            ("affiliation-2", "text", 0.08, 0.35, 0.28, 0.05),
            ("contact-title", "header", 0.08, 0.52, 0.1, 0.02),
            ("contact", "text", 0.08, 0.54, 0.28, 0.04),
        ]
        .into_iter()
        .enumerate()
        .map(|(order, (id, kind, x, y, w, h))| RawLayoutRegion {
            id: id.into(),
            page_index: 0,
            kind: kind.into(),
            text: Some(id.into()),
            title: None,
            bbox: Bbox { x, y, w, h },
            reading_order: Some(order as u32),
            score: 1.0,
        })
        .collect();
        assert_eq!(
            document_reading_order(&regions)
                .iter()
                .map(|r| r.id.as_str())
                .collect::<Vec<_>>(),
            [
                "authors",
                "affiliation-1",
                "affiliation-2",
                "contact-title",
                "contact",
                "abstract-title",
                "abstract"
            ]
        );
    }
}

pub(super) fn document_reading_order(regions: &[RawLayoutRegion]) -> Vec<&RawLayoutRegion> {
    let mut sorted: Vec<_> = regions.iter().collect();
    sorted.sort_by(|a, b| {
        a.page_index
            .cmp(&b.page_index)
            .then_with(|| stored_order(a, b))
    });
    let mut ordered = Vec::with_capacity(sorted.len());
    let mut start = 0;
    while start < sorted.len() {
        let end = start
            + sorted[start..]
                .iter()
                .take_while(|r| r.page_index == sorted[start].page_index)
                .count();
        ordered.extend(page_order(&sorted[start..end]));
        start = end;
    }
    ordered
}
