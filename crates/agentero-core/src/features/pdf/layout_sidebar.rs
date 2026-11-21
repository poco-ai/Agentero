//! Sidebar-aligned layout index (`{paper}/source/layout-index.json`).
//!
//! Mirrors `src/lib/pdf/layout/layout-index.ts`: merge captions into their
//! hosts, gate/NMS the sidebar kinds, then assign CLI-friendly ids. The CLI
//! `layout list|get` and `mark add --region` commands read this file through
//! [`super::layout_index`].
//!
//! # Reduced caption merge
//!
//! The desktop merge (`src/lib/pdf/layout/merge-captions.ts`, ~1750 lines) also
//! repairs figure rooms and resolves cross-page captions. The headless
//! pipeline needs a sidebar close to the desktop Figures rail, so
//! [`merge_regions`] implements three steps:
//!
//! 1. [`cluster_figure_panels`]: side-by-side / vertically aligned image+chart
//!    panels of one multi-panel float are merged into a single union host
//!    (transitive, but a group with 2+ distinct titles is left alone);
//! 2. [`merge_caption_attachments`]: main captions are attached to the
//!    compatible host on the same page:
//!    - candidates: `figure_title` / `header` regions whose `caption_role` is
//!      `figure_main` / `table_main` / `algorithm_main`, or unclassified
//!      captions whose text starts with `Figure|Fig.|Table|Tab.|Algorithm|Alg.`
//!      + number;
//!    - same-page geometry only (a caption on another page stays free — a
//!      documented limitation, unknown to the desktop viewer's richer merge);
//!    - the host's `bbox`/`rect` are **not** unioned with the caption box,
//!      unlike the desktop `buildFigureBboxWithFullTitle`: the sidebar index
//!      stays on the detected (or panel-union) geometry so
//!      `mark add --region` selects the visual region, not the text strip
//!      below it. The caption box is kept in `title_bbox`;
//! 3. [`merge_formulas_by_number`]: only formula bodies paired with a model
//!    `formula_number` box are kept (desktop `mergeFormulasByNumber`); bare
//!    unnumbered formulas are dropped from the sidebar index. The raw
//!    `source/layout.json` is never changed by this filter.
//!
//! Subpanel/other captions and cross-page captions stay separate; unattached
//! captions stay in the merged list (they are not sidebar kinds, so
//! [`build_index_items`] drops them).

use super::layout_region::{
    CaptionRole, LayoutIndexItem, LayoutIndexSection, LayoutKind, LayoutRegion, Rect,
    LAYOUT_INDEX_FILE, LAYOUT_SIDEBAR_MIN_SCORE,
};
use crate::error::AppError;
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

/// `layout-index.json` schema version (desktop `LAYOUT_INDEX_SCHEMA_VERSION`).
const LAYOUT_INDEX_SCHEMA_VERSION: u32 = 1;

// NMS thresholds (desktop `dedupe.ts` defaults).
const DEDUPE_IOU_THRESHOLD: f64 = 0.45;
const DEDUPE_CONTAINMENT_THRESHOLD: f64 = 0.85;
const DEDUPE_MIN_AREA: f64 = 0.002;
/// A whole figure must be at least this much larger than a nested fragment to
/// replace it during NMS (`preferCompleteFigure`).
const COMPLETE_FIGURE_MIN_AREA_RATIO: f64 = 1.4;
const COMPLETE_FIGURE_MAX_AREA_RATIO: f64 = 4.0;
const COMPLETE_FIGURE_MIN_SCORE_RATIO: f64 = 0.75;

// Caption attach geometry (desktop `captionAttachScore`).
const CAPTION_MIN_HORIZONTAL_OVERLAP: f64 = 0.2;
const CAPTION_MAX_HEIGHT: f64 = 0.2;
const CAPTION_GAP_BELOW_MIN: f64 = -0.02;
const CAPTION_GAP_BELOW_MAX: f64 = 0.12;
/// Tables/algorithms are captioned above; widened from the desktop 0.1 so tall
/// table headers still find their host.
const CAPTION_GAP_ABOVE_MIN: f64 = -0.02;
const CAPTION_GAP_ABOVE_MAX: f64 = 0.3;

// Multi-panel figure clustering (image/chart only). Mirrors the desktop
// `areFigureNeighbors` / `connectedPanelGroups` intent.
const CLUSTER_PANEL_MAX_Y_DELTA: f64 = 0.04;
const CLUSTER_PANEL_MIN_VERTICAL_OVERLAP: f64 = 0.8;
const CLUSTER_PANEL_MAX_HORIZONTAL_GAP: f64 = 0.03;
const CLUSTER_PANEL_MIN_HEIGHT_RATIO: f64 = 0.7;

// Number-anchored formula merging (desktop `selectFormulasForNumber` /
// `mergeFormulasByNumber` in `src/lib/pdf/layout/merge-captions.ts`,
// `LAYOUT_MERGE` thresholds). Only formulas paired with a `formula_number` box
// surface in the sidebar; bare formulas are index-time filtered out.
/// Min model score for a `formula_number` box to start a merge.
const FORMULA_NUMBER_MIN_SCORE: f64 = 0.3;
/// Min score for a formula body to be a merge seed.
const FORMULA_BODY_MIN_SCORE: f64 = 0.3;
/// Max horizontal gap between formula body right edge and the number box
/// (desktop `LAYOUT_MERGE.formulaNumberMaxGap`).
const FORMULA_NUMBER_MAX_GAP: f64 = 0.28;
/// The body may overlap the number box by at most this much (page width).
const FORMULA_NUMBER_MAX_OVERLAP: f64 = 0.12;
/// Vertical pad around the number box for same-line matching.
const FORMULA_NUMBER_BAND_PAD: f64 = 0.02;
/// Extra slack added to the half-height band around the number center; the
/// desktop doubles it from `formulaNumberBandPad` in `selectFormulasForNumber`.
const FORMULA_NUMBER_BAND_SLACK: f64 = 0.02;
/// Reject paragraph-tall "formula" mislabels / stacked inline math
/// (desktop `LAYOUT_MERGE.formulaMaxBodyHeight`).
const FORMULA_MAX_BODY_HEIGHT: f64 = 0.055;
/// Vertical overlap with the padded number box needed to share its line.
const FORMULA_NUMBER_MIN_VERTICAL_OVERLAP: f64 = 0.2;
/// Same-line fragments must overlap the best seed this much to join its host.
const FORMULA_SEED_MIN_VERTICAL_OVERLAP: f64 = 0.35;

/// Host family a caption can attach to (desktop `LayoutHostFamily`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HostFamily {
    Figure,
    Table,
    Algorithm,
}

/// Merge multi-panel figures, captions and numbered formulas into sidebar
/// hosts.
///
/// Pipeline: [`cluster_figure_panels`] (side-by-side / vertically aligned
/// image+chart panels of one float become a single union host),
/// [`merge_caption_attachments`] (the shared caption binds to that union), then
/// [`merge_formulas_by_number`] (only `formula_number`-paired formulas stay).
/// Reduced port of the desktop `mergeCaptionsIntoHosts`: subpanel captions and
/// cross-page captions stay separate (the desktop merge is richer).
pub fn merge_regions(raw: &[LayoutRegion]) -> Vec<LayoutRegion> {
    let clustered = cluster_figure_panels(raw);
    let captioned = merge_caption_attachments(&clustered);
    let mut merged = merge_formulas_by_number(&captioned);
    // Keep the merged list ordered by (page, reading order) for every consumer.
    sort_by_page_reading_order(&mut merged);
    merged
}

fn sort_by_page_reading_order(regions: &mut [LayoutRegion]) {
    // Stable: regions that keep the same order stay in input order.
    regions.sort_by(|a, b| {
        a.page_index
            .cmp(&b.page_index)
            .then(a.reading_order.total_cmp(&b.reading_order))
    });
}

/// Attach compatible captions to figure/table/algorithm hosts. Consumed
/// captions are removed; hosts keep their detected bbox (the caption box goes
/// to `title_bbox`). Output is stable-sorted by (page, reading order).
fn merge_caption_attachments(raw: &[LayoutRegion]) -> Vec<LayoutRegion> {
    struct Pair {
        host_index: usize,
        caption_index: usize,
        score: f64,
        gap: f64,
        overlap: f64,
    }

    let mut pairs: Vec<Pair> = Vec::new();
    for (caption_index, caption) in raw.iter().enumerate() {
        if !caption.kind.is_caption() {
            continue;
        }
        let Some(family) = caption_host_family(caption) else {
            // Subpanel / other captions are left in place.
            continue;
        };
        // Figures are captioned below, tables and algorithms above.
        let preferred_below = family == HostFamily::Figure;
        for (host_index, host) in raw.iter().enumerate() {
            if host.page_index != caption.page_index {
                continue;
            }
            if !host_matches_family(host.kind, family) {
                continue;
            }
            // A host the sidebar would drop must not consume a caption.
            if host.score < LAYOUT_SIDEBAR_MIN_SCORE {
                continue;
            }
            let Some((score, gap, overlap)) =
                caption_attach_score(&host.bbox, &caption.bbox, preferred_below)
            else {
                continue;
            };
            pairs.push(Pair {
                host_index,
                caption_index,
                score,
                gap,
                overlap,
            });
        }
    }

    // Best score first; ties prefer the tighter vertical gap, then the larger
    // horizontal overlap (deterministic on index).
    pairs.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| a.gap.abs().total_cmp(&b.gap.abs()))
            .then_with(|| b.overlap.total_cmp(&a.overlap))
            .then_with(|| a.caption_index.cmp(&b.caption_index))
            .then_with(|| a.host_index.cmp(&b.host_index))
    });

    // One-to-one: each host takes at most one caption, each caption is consumed
    // at most once.
    let mut host_taken: HashSet<usize> = HashSet::new();
    let mut caption_taken: HashSet<usize> = HashSet::new();
    let mut attached: HashMap<usize, usize> = HashMap::new();
    for pair in pairs {
        if host_taken.contains(&pair.host_index) || caption_taken.contains(&pair.caption_index) {
            continue;
        }
        host_taken.insert(pair.host_index);
        caption_taken.insert(pair.caption_index);
        attached.insert(pair.host_index, pair.caption_index);
    }

    let mut merged: Vec<LayoutRegion> = Vec::with_capacity(raw.len() - caption_taken.len());
    for (index, region) in raw.iter().enumerate() {
        if caption_taken.contains(&index) {
            continue;
        }
        let mut host = region.clone();
        if let Some(&caption_index) = attached.get(&index) {
            let caption = &raw[caption_index];
            host.title_bbox = Some(caption.bbox);
            if let Some(text) = caption_text(caption) {
                host.title = Some(collapse_whitespace(text.trim()));
            }
        }
        merged.push(host);
    }
    sort_by_page_reading_order(&mut merged);
    merged
}

/// Cluster the panels of one multi-panel figure into a single union region.
///
/// Mirrors the intent of the desktop `areFigureNeighbors` /
/// `connectedPanelGroups` (without its panel-room logic): same-page
/// image/chart boxes cluster when they are vertically aligned (`|Δy| <= 0.04`
/// or vertical overlap >= 0.8), horizontally adjacent or overlapping (gap <=
/// 0.03 or overlap, containment included), and have comparable heights
/// (±30%). Groups are transitive; a group carrying two or more distinct
/// non-empty titles is never merged so separately captioned figures stay
/// apart. The union keeps the best member's id/reading order/score (largest
/// area, then highest score) and any single title, so the caption pass can
/// bind the shared caption to it.
fn cluster_figure_panels(raw: &[LayoutRegion]) -> Vec<LayoutRegion> {
    let panel_indices: Vec<usize> = raw
        .iter()
        .enumerate()
        .filter(|(_, region)| region.kind.is_figure())
        .map(|(index, _)| index)
        .collect();
    if panel_indices.len() < 2 {
        return raw.to_vec();
    }

    // Connected components over the panel graph (union-find).
    let mut parent: Vec<usize> = (0..panel_indices.len()).collect();
    for a in 0..panel_indices.len() {
        for b in (a + 1)..panel_indices.len() {
            if panels_cluster_together(&raw[panel_indices[a]], &raw[panel_indices[b]]) {
                let root_a = union_find_root(&mut parent, a);
                let root_b = union_find_root(&mut parent, b);
                if root_a != root_b {
                    parent[root_a] = root_b;
                }
            }
        }
    }
    let mut groups: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for local in 0..panel_indices.len() {
        let root = union_find_root(&mut parent, local);
        groups.entry(root).or_default().push(local);
    }

    let mut merged_at: HashMap<usize, LayoutRegion> = HashMap::new();
    let mut skipped: HashSet<usize> = HashSet::new();
    for locals in groups.values() {
        if locals.len() < 2 {
            continue;
        }
        let members: Vec<&LayoutRegion> = locals
            .iter()
            .map(|local| &raw[panel_indices[*local]])
            .collect();
        // Two separately captioned figures never merge.
        let distinct_titles: HashSet<String> = members
            .iter()
            .copied()
            .filter_map(|member| member.title.as_deref())
            .map(|title| collapse_whitespace(title.trim()))
            .filter(|title| !title.is_empty())
            .collect();
        if distinct_titles.len() >= 2 {
            continue;
        }
        let best_index = locals
            .iter()
            .map(|local| panel_indices[*local])
            .max_by(|a, b| panel_rank(&raw[*a], &raw[*b]))
            .expect("cluster group is non-empty");
        merged_at.insert(best_index, merge_panel_cluster(&members, &raw[best_index]));
        for local in locals {
            let index = panel_indices[*local];
            if index != best_index {
                skipped.insert(index);
            }
        }
    }

    let mut out: Vec<LayoutRegion> = Vec::with_capacity(raw.len());
    for (index, region) in raw.iter().enumerate() {
        if let Some(merged) = merged_at.get(&index) {
            out.push(merged.clone());
        } else if !skipped.contains(&index) {
            out.push(region.clone());
        }
    }
    out
}

fn union_find_root(parent: &mut [usize], mut index: usize) -> usize {
    while parent[index] != index {
        parent[index] = parent[parent[index]];
        index = parent[index];
    }
    index
}

/// Geometry test for two panels of the same multi-panel figure.
fn panels_cluster_together(a: &LayoutRegion, b: &LayoutRegion) -> bool {
    if a.page_index != b.page_index {
        return false;
    }
    let (a_box, b_box) = (a.bbox, b.bbox);
    if a_box.w <= 0.0 || a_box.h <= 0.0 || b_box.w <= 0.0 || b_box.h <= 0.0 {
        return false;
    }
    let height_ratio = a_box.h.min(b_box.h) / a_box.h.max(b_box.h);
    if height_ratio < CLUSTER_PANEL_MIN_HEIGHT_RATIO {
        return false;
    }
    let y_delta = (a_box.y - b_box.y).abs();
    if y_delta > CLUSTER_PANEL_MAX_Y_DELTA
        && vertical_overlap_ratio(&a_box, &b_box) < CLUSTER_PANEL_MIN_VERTICAL_OVERLAP
    {
        return false;
    }
    let gap = horizontal_gap(&a_box, &b_box);
    // A large gap only separates stacked panels when they share no column.
    gap <= CLUSTER_PANEL_MAX_HORIZONTAL_GAP || horizontal_overlap_ratio(&a_box, &b_box) > 0.0
}

/// Deterministic "best panel" order: largest area, then highest score, then
/// earliest reading order, then id.
fn panel_rank(a: &LayoutRegion, b: &LayoutRegion) -> Ordering {
    a.bbox
        .area()
        .total_cmp(&b.bbox.area())
        .then_with(|| a.score.total_cmp(&b.score))
        .then_with(|| b.reading_order.total_cmp(&a.reading_order))
        .then_with(|| b.id.cmp(&a.id))
}

/// Build the union region for one panel cluster.
fn merge_panel_cluster(members: &[&LayoutRegion], best: &LayoutRegion) -> LayoutRegion {
    let bbox = members
        .iter()
        .copied()
        .map(|member| member.bbox)
        .reduce(union_bboxes)
        .expect("cluster has members");
    let rect = members
        .iter()
        .copied()
        .map(|member| member.rect)
        .reduce(union_rects)
        .expect("cluster has members");
    let kind = if members
        .iter()
        .any(|member| member.kind == LayoutKind::Image)
    {
        LayoutKind::Image
    } else {
        LayoutKind::Chart
    };
    let titled = members.iter().copied().find(|member| {
        member
            .title
            .as_deref()
            .is_some_and(|t| !t.trim().is_empty())
    });
    LayoutRegion {
        id: best.id.clone(),
        page_index: best.page_index,
        kind,
        label: kind.as_str().to_string(),
        score: best.score,
        reading_order: best.reading_order,
        rect,
        bbox,
        text: best.text.clone(),
        title: titled.and_then(|member| member.title.clone()),
        title_bbox: titled.map(|member| member.title_bbox.unwrap_or(member.bbox)),
        caption_role: None,
        caption_page_index: None,
        caption_bbox: None,
    }
}

fn union_rects(a: Rect, b: Rect) -> Rect {
    let x1 = a.x.min(b.x);
    let y1 = a.y.min(b.y);
    let x2 = (a.x + a.w).max(b.x + b.w);
    let y2 = (a.y + a.h).max(b.y + b.h);
    Rect::new(x1, y1, (x2 - x1).max(0.0), (y2 - y1).max(0.0))
}

/// Union of normalized page boxes, clamped into 0–1.
fn union_bboxes(a: Rect, b: Rect) -> Rect {
    let union = union_rects(a, b);
    Rect::new(
        union.x.clamp(0.0, 1.0),
        union.y.clamp(0.0, 1.0),
        union.w.clamp(0.0, 1.0),
        union.h.clamp(0.0, 1.0),
    )
}

/// Horizontal white space between two boxes (0 when they overlap).
fn horizontal_gap(a: &Rect, b: &Rect) -> f64 {
    (a.x - (b.x + b.w)).max(b.x - (a.x + a.w)).max(0.0)
}

/// Intersection height over the shorter box (desktop `verticalOverlapRatio`).
fn vertical_overlap_ratio(a: &Rect, b: &Rect) -> f64 {
    let top = a.y.max(b.y);
    let bottom = (a.y + a.h).min(b.y + b.h);
    let intersection = (bottom - top).max(0.0);
    let denominator = a.h.min(b.h);
    if denominator > 0.0 {
        intersection / denominator
    } else {
        0.0
    }
}

/// Keep only `formula_number`-paired formulas (desktop `mergeFormulasByNumber`).
///
/// Number-first aggregation: every confident `formula_number` box claims the
/// same-line formula bodies left of it; a bare formula without a model number
/// box is dropped from the merged view (it never reaches the sidebar index).
/// The raw `layout.json` keeps every region, so this is an index-time filter.
/// Formula bodies are unioned, but the number box stays out of the click box
/// (it only rides along as `title_bbox` for ordering): the sidebar index should
/// target the detected equation body, matching the caption-merge choice above.
fn merge_formulas_by_number(regions: &[LayoutRegion]) -> Vec<LayoutRegion> {
    let numbers: Vec<&LayoutRegion> = regions
        .iter()
        .filter(|region| {
            region.kind == LayoutKind::FormulaNumber && region.score >= FORMULA_NUMBER_MIN_SCORE
        })
        .collect();
    let formulas: Vec<&LayoutRegion> = regions
        .iter()
        .filter(|region| region.kind == LayoutKind::Formula)
        .collect();

    let mut used_names: HashSet<&str> = HashSet::new();
    let mut hosts: Vec<LayoutRegion> = Vec::new();
    // Process numbers in reading order so the equation sequence is stable on
    // two-column pages (desktop `compareLayoutReadingOrder` over numbers).
    let mut sorted_numbers = numbers;
    sorted_numbers.sort_by(|a, b| compare_formula_reading_order(a, b));
    for number in sorted_numbers {
        let free: Vec<&LayoutRegion> = formulas
            .iter()
            .copied()
            .filter(|formula| !used_names.contains(formula.id.as_str()))
            .collect();
        let Some((seed, bodies)) = select_formulas_for_number(number, &free) else {
            continue;
        };
        hosts.push(merge_formula_cluster(seed, &bodies, number));
        for body in &bodies {
            used_names.insert(body.id.as_str());
        }
    }

    let mut merged: Vec<LayoutRegion> = regions
        .iter()
        .filter(|region| {
            region.kind != LayoutKind::Formula && region.kind != LayoutKind::FormulaNumber
        })
        .cloned()
        .collect();
    merged.extend(hosts);
    merged
}

/// Same-line formula bodies for one number box (desktop
/// `selectFormulasForNumber`). Returns the best seed plus every fragment that
/// overlaps it on the same line.
fn select_formulas_for_number<'a>(
    number: &LayoutRegion,
    formulas: &[&'a LayoutRegion],
) -> Option<(&'a LayoutRegion, Vec<&'a LayoutRegion>)> {
    let num = number.bbox;
    let num_center_y = num.y + num.h / 2.0;
    // Band height locked to the number box — never scale with a tall body.
    let half_band = num.h.max(0.012) * 0.75 + FORMULA_NUMBER_BAND_SLACK;
    let padded_number = expand_bbox_y(&num, FORMULA_NUMBER_BAND_PAD);

    let mut seeds: Vec<&'a LayoutRegion> = formulas
        .iter()
        .copied()
        .filter(|formula| {
            if formula.page_index != number.page_index {
                return false;
            }
            // Confident formula bodies only (not score~0.02 dual-label scraps).
            if formula.score < FORMULA_BODY_MIN_SCORE {
                return false;
            }
            // Paragraph-tall "formula" mislabels / stacked inline math.
            if formula.bbox.h > FORMULA_MAX_BODY_HEIGHT {
                return false;
            }
            // Mostly left of the number: equation body, not another margin tag.
            if formula.bbox.x >= num.x + num.w * 0.5 {
                return false;
            }
            let right = formula.bbox.x + formula.bbox.w;
            let gap = num.x - right;
            if gap > FORMULA_NUMBER_MAX_GAP {
                return false;
            }
            if gap < -FORMULA_NUMBER_MAX_OVERLAP {
                return false;
            }
            let center_y = formula.bbox.y + formula.bbox.h / 2.0;
            let in_band = (center_y - num_center_y).abs() <= half_band;
            let vertical = vertical_overlap_ratio(&formula.bbox, &padded_number);
            vertical >= FORMULA_NUMBER_MIN_VERTICAL_OVERLAP || in_band
        })
        .collect();
    if seeds.is_empty() {
        return None;
    }

    // Prefer highest-confidence body, then largest, then closest to the number.
    seeds.sort_by(|a, b| {
        let a_center = a.bbox.y + a.bbox.h / 2.0;
        let b_center = b.bbox.y + b.bbox.h / 2.0;
        let a_gap = (num.x - (a.bbox.x + a.bbox.w)).abs();
        let b_gap = (num.x - (b.bbox.x + b.bbox.w)).abs();
        b.score
            .total_cmp(&a.score)
            .then_with(|| b.bbox.area().total_cmp(&a.bbox.area()))
            .then_with(|| {
                (a_center - num_center_y)
                    .abs()
                    .total_cmp(&(b_center - num_center_y).abs())
            })
            .then_with(|| a_gap.total_cmp(&b_gap))
    });
    let seed = seeds[0];

    // Same-line fragments only — never grow to lines above/below (body text).
    let chosen: HashSet<&str> = seeds
        .iter()
        .filter(|candidate| {
            candidate.id.as_str() == seed.id.as_str()
                || vertical_overlap_ratio(&candidate.bbox, &seed.bbox)
                    >= FORMULA_SEED_MIN_VERTICAL_OVERLAP
        })
        .map(|candidate| candidate.id.as_str())
        .collect();
    let bodies: Vec<&'a LayoutRegion> = formulas
        .iter()
        .copied()
        .filter(|formula| chosen.contains(formula.id.as_str()))
        .collect();
    if bodies.is_empty() {
        None
    } else {
        Some((seed, bodies))
    }
}

/// Merge the same-line bodies of one equation into a formula host.
///
/// `id` comes from the seed body (`layoutRegionId` keeps a real region id),
/// `title_bbox` is the number box (desktop `formulaSortAnchor`), and `title`
/// stays empty: the desktop does not parse equation-id text into a title, so
/// sidebar ids stay bbox-fingerprint based.
fn merge_formula_cluster(
    seed: &LayoutRegion,
    bodies: &[&LayoutRegion],
    number: &LayoutRegion,
) -> LayoutRegion {
    let bbox = bodies
        .iter()
        .copied()
        .map(|body| body.bbox)
        .reduce(union_bboxes)
        .expect("formula cluster has bodies");
    let rect = bodies
        .iter()
        .copied()
        .map(|body| body.rect)
        .reduce(union_rects)
        .expect("formula cluster has bodies");
    let mut score = number.score;
    let mut reading_order = number.reading_order;
    for body in bodies {
        score = score.max(body.score);
        reading_order = reading_order.min(body.reading_order);
    }
    LayoutRegion {
        id: seed.id.clone(),
        page_index: number.page_index,
        kind: LayoutKind::Formula,
        label: LayoutKind::Formula.as_str().to_string(),
        score,
        reading_order,
        rect,
        bbox,
        text: None,
        title: None,
        title_bbox: Some(number.bbox),
        caption_role: None,
        caption_page_index: None,
        caption_bbox: None,
    }
}

/// Grow a normalized box vertically by `pad` (desktop `expandBbox(box, 0, pad)`).
fn expand_bbox_y(bbox: &Rect, pad: f64) -> Rect {
    let top = (bbox.y - pad).clamp(0.0, 1.0);
    let bottom = (bbox.y + bbox.h + pad).clamp(0.0, 1.0);
    Rect::new(
        bbox.x.clamp(0.0, 1.0),
        top,
        bbox.w.clamp(0.0, 1.0),
        (bottom - top).max(0.0),
    )
}

/// Build sidebar index items from merged regions (same ordering/ids as the
/// desktop Figures rail).
pub fn build_index_items(merged: &[LayoutRegion]) -> Vec<LayoutIndexItem> {
    let sidebar: Vec<&LayoutRegion> = merged
        .iter()
        .filter(|region| region.kind.is_sidebar())
        .collect();
    let gallery = dedupe_layout_regions(&sidebar);

    let mut figures: Vec<&LayoutRegion> = gallery
        .iter()
        .copied()
        .filter(|region| region.kind.is_figure())
        .collect();
    figures.sort_by(|a, b| by_page_reading_order(a, b));
    let mut tables: Vec<&LayoutRegion> = gallery
        .iter()
        .copied()
        .filter(|region| region.kind.is_table())
        .collect();
    tables.sort_by(|a, b| by_page_reading_order(a, b));
    let mut algorithms: Vec<&LayoutRegion> = gallery
        .iter()
        .copied()
        .filter(|region| region.kind.is_algorithm())
        .collect();
    algorithms.sort_by(|a, b| by_page_reading_order(a, b));
    let mut formulas: Vec<&LayoutRegion> = gallery
        .iter()
        .copied()
        .filter(|region| region.kind.is_formula())
        .collect();
    formulas.sort_by(|a, b| compare_formula_reading_order(a, b));

    let ordered: Vec<&LayoutRegion> = figures
        .into_iter()
        .chain(tables)
        .chain(algorithms)
        .chain(formulas)
        .collect();

    let mut used_ids: HashSet<String> = HashSet::new();
    let mut items: Vec<LayoutIndexItem> = Vec::with_capacity(ordered.len());
    for region in ordered {
        let section = LayoutIndexSection::of(region.kind);
        let page = region.page_index.saturating_add(1);
        let title = region
            .title
            .as_deref()
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .map(str::to_string);

        let fingerprint = bbox_fingerprint(&region.bbox);
        let base_id = match title
            .as_deref()
            .and_then(|title| slug_from_title(title, section))
        {
            Some(slug) => sanitize_id(&slug),
            None => sanitize_id(&format!(
                "{}-p{}-{}",
                section.as_str(),
                page,
                fingerprint.replace('.', "")
            )),
        };
        let mut id = base_id.clone();
        let mut suffix = 2;
        while used_ids.contains(&id) {
            id = format!("{base_id}-{suffix}");
            suffix += 1;
        }
        used_ids.insert(id.clone());

        let stable_key = match &title {
            Some(title) => format!(
                "p{page}:{}:{}",
                section.as_str(),
                truncate_chars(&collapse_whitespace(title), 80)
            ),
            None => format!("p{page}:{}:{fingerprint}", section.as_str()),
        };

        items.push(LayoutIndexItem {
            id,
            stable_key,
            kind: region.kind,
            section,
            page,
            page_index: region.page_index,
            bbox: region.bbox,
            score: region.score,
            title,
            layout_region_id: region.id.clone(),
        });
    }
    items
}

/// Build and write `{paper}/source/layout-index.json` from RAW sidecar
/// regions (merge happens here). Returns the written item count.
pub fn write_layout_index(
    paper_dir: &Path,
    raw_regions: &[LayoutRegion],
    generated_at: &str,
) -> Result<usize, AppError> {
    let merged = merge_regions(raw_regions);
    let items = build_index_items(&merged);

    let payload = LayoutIndexFile {
        schema_version: LAYOUT_INDEX_SCHEMA_VERSION,
        source: LayoutIndexSource {
            mode: "sidebar",
            from: "layout.json",
            generated_at,
            min_score: LAYOUT_SIDEBAR_MIN_SCORE,
        },
        items: &items,
    };
    let mut body = serde_json::to_string_pretty(&payload)?;
    body.push('\n');

    let source_dir = paper_dir.join("source");
    std::fs::create_dir_all(&source_dir).map_err(|error| {
        AppError::message(format!(
            "failed to create {}: {error}",
            source_dir.display()
        ))
    })?;
    let path = source_dir.join(LAYOUT_INDEX_FILE);
    crate::fs::atomic_write(&path, body.as_bytes()).map_err(|error| {
        AppError::message(format!("failed to write {}: {error}", path.display()))
    })?;
    Ok(items.len())
}

/// `source` block of `layout-index.json` (desktop `LayoutIndexSidecar`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LayoutIndexSource<'a> {
    mode: &'a str,
    from: &'a str,
    generated_at: &'a str,
    min_score: f64,
}

/// `layout-index.json` payload.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LayoutIndexFile<'a> {
    schema_version: u32,
    source: LayoutIndexSource<'a>,
    items: &'a [LayoutIndexItem],
}

/// Host family a caption claims, or `None` when it must stay free.
fn caption_host_family(caption: &LayoutRegion) -> Option<HostFamily> {
    match caption.caption_role {
        Some(CaptionRole::FigureMain) => return Some(HostFamily::Figure),
        Some(CaptionRole::TableMain) => return Some(HostFamily::Table),
        Some(CaptionRole::AlgorithmMain) => return Some(HostFamily::Algorithm),
        // Explicit subpanel / other roles are never whole-figure captions.
        Some(CaptionRole::Subpanel) | Some(CaptionRole::Other) => return None,
        None => {}
    }
    let text = caption_text(caption)?;
    family_from_caption_text(text)
}

/// Classify unclassified caption text by its numbered prefix.
fn family_from_caption_text(text: &str) -> Option<HostFamily> {
    if numbered_after(text, &["figure", "fig.", "fig"]).is_some() {
        Some(HostFamily::Figure)
    } else if numbered_after(text, &["table", "tab.", "tab"]).is_some() {
        Some(HostFamily::Table)
    } else if numbered_after(text, &["algorithm", "alg.", "alg"]).is_some() {
        Some(HostFamily::Algorithm)
    } else {
        None
    }
}

fn host_matches_family(kind: LayoutKind, family: HostFamily) -> bool {
    match family {
        HostFamily::Figure => kind.is_figure(),
        HostFamily::Table => kind.is_table(),
        HostFamily::Algorithm => kind.is_algorithm(),
    }
}

/// Caption text from `title` (preferred) or body `text`; empty strings skipped.
fn caption_text(region: &LayoutRegion) -> Option<&str> {
    region
        .title
        .as_deref()
        .filter(|title| !title.trim().is_empty())
        .or_else(|| {
            region
                .text
                .as_deref()
                .filter(|text| !text.trim().is_empty())
        })
}

/// Spatial score for one caption/host pair (desktop `captionAttachScore`).
///
/// Returns `(score, vertical_gap, horizontal_overlap)` or `None` when the pair
/// is geometrically incompatible. `preferred_below` mirrors
/// `preferredCaptionPlacement`: figures are captioned below, tables and
/// algorithms above.
fn caption_attach_score(
    host: &Rect,
    caption: &Rect,
    preferred_below: bool,
) -> Option<(f64, f64, f64)> {
    let overlap = horizontal_overlap_ratio(host, caption);
    if overlap < CAPTION_MIN_HORIZONTAL_OVERLAP {
        return None;
    }
    if caption.h > CAPTION_MAX_HEIGHT {
        return None;
    }
    let gap = if preferred_below {
        let gap = caption.y - (host.y + host.h);
        if !(CAPTION_GAP_BELOW_MIN..=CAPTION_GAP_BELOW_MAX).contains(&gap) {
            return None;
        }
        gap
    } else {
        let gap = host.y - (caption.y + caption.h);
        if !(CAPTION_GAP_ABOVE_MIN..=CAPTION_GAP_ABOVE_MAX).contains(&gap) {
            return None;
        }
        gap
    };
    Some((overlap * 2.0 + 0.2 - gap.abs() * 8.0, gap, overlap))
}

/// Intersection width over the narrower box (desktop `horizontalOverlapRatio`).
fn horizontal_overlap_ratio(a: &Rect, b: &Rect) -> f64 {
    let left = a.x.max(b.x);
    let right = (a.x + a.w).min(b.x + b.w);
    let intersection = (right - left).max(0.0);
    let denominator = a.w.min(b.w);
    if denominator > 0.0 {
        intersection / denominator
    } else {
        0.0
    }
}

fn by_page_reading_order(a: &LayoutRegion, b: &LayoutRegion) -> Ordering {
    a.page_index
        .cmp(&b.page_index)
        .then_with(|| a.reading_order.total_cmp(&b.reading_order))
}

/// 0 = left column, 1 = right column (desktop `layoutReadingColumn`).
fn layout_reading_column(bbox: &Rect) -> u8 {
    if bbox.x + bbox.w / 2.0 < 0.5 {
        0
    } else {
        1
    }
}

/// Desktop `compareLayoutReadingOrder` with `formulaSortAnchor`
/// (`titleBbox ?? bbox`).
fn compare_formula_reading_order(a: &LayoutRegion, b: &LayoutRegion) -> Ordering {
    let anchor_a = a.title_bbox.as_ref().unwrap_or(&a.bbox);
    let anchor_b = b.title_bbox.as_ref().unwrap_or(&b.bbox);
    a.page_index
        .cmp(&b.page_index)
        .then_with(|| layout_reading_column(anchor_a).cmp(&layout_reading_column(anchor_b)))
        .then_with(|| anchor_a.y.total_cmp(&anchor_b.y))
        .then_with(|| anchor_a.x.total_cmp(&anchor_b.x))
        .then_with(|| a.reading_order.total_cmp(&b.reading_order))
}

/// Non-maximum suppression over sidebar candidates (desktop `dedupe.ts`).
fn dedupe_layout_regions<'a>(regions: &[&'a LayoutRegion]) -> Vec<&'a LayoutRegion> {
    let candidates: Vec<&LayoutRegion> = regions
        .iter()
        .copied()
        .filter(|region| {
            region.score >= LAYOUT_SIDEBAR_MIN_SCORE && region.bbox.area() >= DEDUPE_MIN_AREA
        })
        .collect();

    // Group by page + dedupe class (image + chart share the "figure" class).
    let mut groups: BTreeMap<(u32, &'static str), Vec<&'a LayoutRegion>> = BTreeMap::new();
    for region in candidates {
        groups
            .entry((region.page_index, region.kind.dedupe_group()))
            .or_default()
            .push(region);
    }

    let mut kept: Vec<&'a LayoutRegion> = Vec::new();
    for group in groups.values() {
        // Highest confidence first, then largest area, then reading order.
        let mut sorted = group.clone();
        sorted.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then_with(|| b.bbox.area().total_cmp(&a.bbox.area()))
                .then_with(|| a.reading_order.total_cmp(&b.reading_order))
        });

        let mut selected: Vec<&'a LayoutRegion> = Vec::new();
        for candidate in sorted {
            let mut suppressed = false;
            let mut replaced: HashSet<&str> = HashSet::new();
            for previous in &selected {
                if prefer_complete_figure(candidate, previous) {
                    replaced.insert(previous.id.as_str());
                    continue;
                }
                if prefer_complete_figure(previous, candidate) {
                    suppressed = true;
                    break;
                }
                if LayoutRegion::bbox_iou(&candidate.bbox, &previous.bbox) >= DEDUPE_IOU_THRESHOLD {
                    suppressed = true;
                    break;
                }
                if LayoutRegion::bbox_containment(&candidate.bbox, &previous.bbox)
                    >= DEDUPE_CONTAINMENT_THRESHOLD
                {
                    suppressed = true;
                    break;
                }
            }
            if !suppressed {
                selected.retain(|region| !replaced.contains(region.id.as_str()));
                selected.push(candidate);
            }
        }
        kept.extend(selected);
    }

    kept.sort_by(|a, b| {
        a.page_index
            .cmp(&b.page_index)
            .then_with(|| a.reading_order.total_cmp(&b.reading_order))
            .then_with(|| a.kind.as_str().cmp(b.kind.as_str()))
    });
    kept
}

/// A comparable-confidence whole figure must not be erased by a nested
/// fragment (desktop `preferCompleteFigure`).
fn prefer_complete_figure(outer: &LayoutRegion, inner: &LayoutRegion) -> bool {
    if !outer.kind.is_figure() || !inner.kind.is_figure() {
        return false;
    }
    // Title/caption-bearing boxes are intentional; never override them here.
    if has_title_box(outer)
        || has_title_box(inner)
        || outer.caption_bbox.is_some()
        || inner.caption_bbox.is_some()
        || has_non_empty_title(outer)
        || has_non_empty_title(inner)
    {
        return false;
    }
    let inner_area = inner.bbox.area();
    if inner_area <= 0.0 {
        return false;
    }
    let ratio = outer.bbox.area() / inner_area;
    (COMPLETE_FIGURE_MIN_AREA_RATIO..=COMPLETE_FIGURE_MAX_AREA_RATIO).contains(&ratio)
        && outer.score >= inner.score * COMPLETE_FIGURE_MIN_SCORE_RATIO
        && LayoutRegion::bbox_containment(&outer.bbox, &inner.bbox) >= DEDUPE_CONTAINMENT_THRESHOLD
}

fn has_title_box(region: &LayoutRegion) -> bool {
    region.title_bbox.is_some()
}

fn has_non_empty_title(region: &LayoutRegion) -> bool {
    region
        .title
        .as_deref()
        .is_some_and(|title| !title.is_empty())
}

/// CLI-friendly id slug from numbered caption text (desktop `slugFromTitle`).
fn slug_from_title(title: &str, section: LayoutIndexSection) -> Option<String> {
    let title = title.trim();
    if title.is_empty() {
        return None;
    }
    match section {
        LayoutIndexSection::Figure => {
            numbered_after(title, &["figure", "fig.", "fig"]).map(|n| format!("figure-{n}"))
        }
        LayoutIndexSection::Table => {
            numbered_after(title, &["table"]).map(|n| format!("table-{n}"))
        }
        LayoutIndexSection::Algorithm => {
            numbered_after(title, &["algorithm", "alg.", "alg"]).map(|n| format!("algorithm-{n}"))
        }
        LayoutIndexSection::Formula => formula_number_slug(title),
    }
}

/// `^\(?(\d{1,3})\)?$` — a bare equation number.
fn formula_number_slug(title: &str) -> Option<String> {
    let trimmed = title.trim();
    let inner = trimmed.strip_prefix('(').unwrap_or(trimmed);
    let inner = inner.strip_suffix(')').unwrap_or(inner);
    if !inner.is_empty() && inner.len() <= 3 && inner.bytes().all(|byte| byte.is_ascii_digit()) {
        Some(format!("formula-{inner}"))
    } else {
        None
    }
}

/// Read `digits` after one of the `prefixes` (desktop regex prefix + `\s*` +
/// `(\d+)\b`). Case-insensitive; the boundary keeps `Figure 3a` from matching.
fn numbered_after(text: &str, prefixes: &[&str]) -> Option<String> {
    for prefix in prefixes {
        let Some(head) = text.get(..prefix.len()) else {
            continue;
        };
        if !head.eq_ignore_ascii_case(prefix) {
            continue;
        }
        let rest = text[prefix.len()..].trim_start();
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        if digits.is_empty() {
            continue;
        }
        let boundary = rest[digits.len()..]
            .chars()
            .next()
            .is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'));
        if boundary {
            return Some(digits);
        }
    }
    None
}

/// Desktop `sanitizeId`.
fn sanitize_id(raw: &str) -> String {
    let lower = raw.trim().to_lowercase();
    let mut out = String::with_capacity(lower.len());
    let mut previous_dash = false;
    for c in lower.chars() {
        let keep = c.is_ascii_alphanumeric() || c == '_' || c == '-';
        if keep && c != '-' {
            out.push(c);
            previous_dash = false;
        } else if !previous_dash {
            out.push('-');
            previous_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "region".to_string()
    } else {
        trimmed.to_string()
    }
}

/// `x_y_w_h` with three decimals (desktop `bboxFingerprint`).
fn bbox_fingerprint(bbox: &Rect) -> String {
    fn component(value: f64) -> String {
        if value.is_finite() {
            // JS `toFixed` renders negative zero as "0.000".
            format!("{:.3}", if value == 0.0 { 0.0 } else { value })
        } else {
            "0".to_string()
        }
    }
    format!(
        "{}_{}_{}_{}",
        component(bbox.x),
        component(bbox.y),
        component(bbox.w),
        component(bbox.h)
    )
}

/// Collapse every whitespace run to a single ASCII space.
fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// First `max` scalar values (JS `slice` works on UTF-16 units; close enough
/// for the ASCII-ish caption text we store).
fn truncate_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}
