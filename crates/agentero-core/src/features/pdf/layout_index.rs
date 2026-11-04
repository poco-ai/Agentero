//! Sidebar layout index (`{paper}/source/layout-index.json`).
//!
//! Shared by CLI `layout` / `mark --region` and MCP `layout_*` tools.

use crate::error::AppError;
use crate::fs::sanitize_vault_rel;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

pub const LAYOUT_INDEX_FILE: &str = "layout-index.json";
pub const LAYOUT_RAW_FILE: &str = "layout.json";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutIndexItem {
    pub id: String,
    pub stable_key: String,
    pub kind: String,
    pub section: String,
    pub page: u32,
    pub page_index: u32,
    pub bbox: Bbox,
    pub score: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub layout_region_id: String,
    /// Copy this fragment verbatim onto the paper PDF path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section_anchor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paragraph_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Original section marker (`1`, `2.1`, `III`) for this section or the
    /// section that owns this paragraph. Internal disambiguation only.
    #[serde(skip)]
    pub section_marker: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct Bbox {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// A single region from the raw `source/layout.json` (schemaVersion 3).
///
/// Unlike [`LayoutIndexItem`] the raw layout keeps paragraph-level regions
/// (`kind` such as `paragraph` / `text`), each carrying its physical
/// `page_index` and the body `text`. This is the source of truth for reading
/// a paper by physical page and for mapping a Markdown hit back to a page.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RawLayoutRegion {
    pub id: String,
    /// 0-based physical page index into the PDF.
    pub page_index: u32,
    /// Region kind from `layout.json` (e.g. `text`, `paragraph`, `header`,
    /// `figure`, `table`). Kinds whose name contains `text` are paragraph-level.
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub bbox: Bbox,
    pub reading_order: Option<u32>,
    pub score: f64,
}

/// Ordered raw regions for a paper. Order follows document reading order
/// (page then top-to-bottom) so a caller can page through a paper naturally.
#[derive(Debug, Clone)]
pub struct RawLayout {
    pub regions: Vec<RawLayoutRegion>,
}

/// Read and parse `{paper}/source/layout.json`.
pub fn load_raw_layout(vault: &Path, paper_path: &str) -> Result<RawLayout, AppError> {
    let dir = paper_abs(vault, paper_path)?;
    let raw_path = dir.join("source").join(LAYOUT_RAW_FILE);
    if !raw_path.is_file() {
        return Err(AppError::domain(
            "layout_raw_missing",
            format!(
                "{paper_path}/source/{LAYOUT_RAW_FILE} not found; open the paper and run layout analysis first"
            ),
        ));
    }
    if let Some(cached) = cached_raw_layout(&raw_path) {
        return Ok(cached);
    }
    let text = std::fs::read_to_string(&raw_path)
        .map_err(|e| AppError::message(format!("failed to read raw layout: {e}")))?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|e| AppError::message(format!("invalid raw layout json: {e}")))?;
    let regions = parse_raw_regions(&value)?;
    let mut regions: Vec<RawLayoutRegion> = regions;
    regions.sort_by(|a, b| {
        a.page_index
            .cmp(&b.page_index)
            .then_with(|| {
                a.reading_order
                    .unwrap_or(u32::MAX)
                    .cmp(&b.reading_order.unwrap_or(u32::MAX))
            })
            .then_with(|| bbox_order(&a.bbox).total_cmp(&bbox_order(&b.bbox)))
            .then_with(|| a.id.cmp(&b.id))
    });
    let layout = RawLayout { regions };
    store_raw_layout(&raw_path, &layout);
    Ok(layout)
}

struct LayoutCacheEntry {
    modified: SystemTime,
    len: u64,
    layout: RawLayout,
    /// Anchors enumerated once per file stamp. Citation checks clone this
    /// `Arc` instead of parsing `layout.json` and walking every region again.
    anchors: Arc<Vec<LayoutIndexItem>>,
}

fn layout_cache() -> &'static Mutex<std::collections::HashMap<PathBuf, LayoutCacheEntry>> {
    static CACHE: OnceLock<Mutex<std::collections::HashMap<PathBuf, LayoutCacheEntry>>> =
        OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn layout_fingerprint(path: &Path) -> Option<(SystemTime, u64)> {
    let meta = fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

/// Tests rewrite fixtures in place; a process-wide cache would hide that.
fn cached_raw_layout(path: &Path) -> Option<RawLayout> {
    if cfg!(test) {
        return None;
    }
    let (modified, len) = layout_fingerprint(path)?;
    let guard = layout_cache().lock().ok()?;
    let hit = guard.get(path)?;
    if hit.modified == modified && hit.len == len {
        Some(hit.layout.clone())
    } else {
        None
    }
}

fn cached_anchors(path: &Path) -> Option<Arc<Vec<LayoutIndexItem>>> {
    if cfg!(test) {
        return None;
    }
    let (modified, len) = layout_fingerprint(path)?;
    let guard = layout_cache().lock().ok()?;
    let hit = guard.get(path)?;
    if hit.modified == modified && hit.len == len {
        Some(Arc::clone(&hit.anchors))
    } else {
        None
    }
}

fn store_raw_layout(path: &Path, layout: &RawLayout) {
    if cfg!(test) {
        return;
    }
    let Some((modified, len)) = layout_fingerprint(path) else {
        return;
    };
    if let Ok(mut guard) = layout_cache().lock() {
        guard.insert(
            path.to_path_buf(),
            LayoutCacheEntry {
                modified,
                len,
                layout: layout.clone(),
                anchors: Arc::new(enumerate_document_anchors(layout)),
            },
        );
    }
}

fn document_anchor_items(
    vault: &Path,
    paper_path: &str,
) -> Result<Arc<Vec<LayoutIndexItem>>, AppError> {
    let dir = paper_abs(vault, paper_path)?;
    let raw_path = dir.join("source").join(LAYOUT_RAW_FILE);
    if let Some(cached) = cached_anchors(&raw_path) {
        return Ok(cached);
    }
    let layout = load_raw_layout(vault, paper_path)?;
    if let Some(cached) = cached_anchors(&raw_path) {
        return Ok(cached);
    }
    Ok(Arc::new(enumerate_document_anchors(&layout)))
}

fn bbox_order(b: &Bbox) -> f64 {
    b.y * 100_000.0 + b.x
}

/// Regions on a 0-based physical `page_index`, in document reading order
/// (page then top-to-bottom). Paragraph-level regions carry `kind` `text`
/// or `paragraph` and their body in `text`.
pub fn page_regions(layout: &RawLayout, page_index: u32) -> Vec<&RawLayoutRegion> {
    layout
        .regions
        .iter()
        .filter(|r| r.page_index == page_index)
        .collect()
}

/// Highest physical page present (0-based index) + 1, or 0 when no regions.
pub fn page_count(layout: &RawLayout) -> u32 {
    layout
        .regions
        .iter()
        .map(|r| r.page_index)
        .max()
        .map(|p| p + 1)
        .unwrap_or(0)
}

/// Best-effort map of a Markdown body line back to its physical page.
///
/// The `PAPER.md` body of a LiteParse-derived paper closely mirrors
/// `layout.json` paragraph regions, so we normalize both sides and match on
/// equality / containment. Returns the 1-based physical page (`page_index + 1`)
/// only when every matching region resolves to a single distinct page;
/// otherwise `None` (ambiguous / absent) so callers never trust a guess.
pub fn page_map(layout: &RawLayout, text: &str) -> Option<u32> {
    let needle = normalize_text(text)?;
    if needle.is_empty() {
        return None;
    }
    let mut pages: Vec<u32> = Vec::new();
    for region in &layout.regions {
        let Some(body) = region.text.as_deref().and_then(normalize_text) else {
            continue;
        };
        let matches = body == needle || body.contains(&needle) || needle.contains(&body);
        if matches {
            pages.push(region.page_index);
        }
    }
    pages.sort_unstable();
    pages.dedup();
    if pages.len() == 1 {
        Some(pages[0] + 1)
    } else {
        None
    }
}

/// Lowercase and collapse all runs of whitespace to single ASCII spaces.
fn normalize_text(s: &str) -> Option<String> {
    let mut out = String::with_capacity(s.len());
    let mut pending_space = false;
    let mut seen = false;
    for c in s.trim().chars() {
        if c.is_whitespace() {
            pending_space = true;
        } else {
            if pending_space && seen {
                out.push(' ');
            }
            out.extend(c.to_lowercase());
            pending_space = false;
            seen = true;
        }
    }
    if seen {
        Some(out)
    } else {
        None
    }
}

fn parse_raw_regions(value: &Value) -> Result<Vec<RawLayoutRegion>, AppError> {
    let arr = value
        .get("regions")
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            AppError::domain("layout_raw_invalid", "layout.json missing regions array")
        })?;
    let mut regions = Vec::with_capacity(arr.len());
    for (i, entry) in arr.iter().enumerate() {
        match parse_raw_region(entry) {
            Some(region) => regions.push(region),
            None => {
                return Err(AppError::domain(
                    "layout_raw_invalid",
                    format!("invalid raw layout region at index {i}"),
                ));
            }
        }
    }
    Ok(regions)
}

fn parse_raw_region(v: &Value) -> Option<RawLayoutRegion> {
    let id = v.get("id")?.as_str()?.to_string();
    let page_index = v.get("pageIndex")?.as_u64()? as u32;
    let kind = v.get("kind")?.as_str()?.to_string();
    let title = v
        .get("title")
        .and_then(|x| x.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty());
    let text = v
        .get("text")
        .and_then(|x| x.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty());
    let bbox_v = v.get("bbox")?;
    let bbox = Bbox {
        x: bbox_v.get("x")?.as_f64()?,
        y: bbox_v.get("y")?.as_f64()?,
        w: bbox_v.get("w")?.as_f64()?,
        h: bbox_v.get("h")?.as_f64()?,
    };
    if id.is_empty() || kind.is_empty() {
        return None;
    }
    Some(RawLayoutRegion {
        id,
        page_index,
        kind,
        title,
        text,
        bbox,
        reading_order: v
            .get("readingOrder")
            .and_then(Value::as_u64)
            .and_then(|n| n.try_into().ok()),
        score: v.get("score").and_then(Value::as_f64).unwrap_or(1.0),
    })
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutCounts {
    pub total: usize,
    pub figure: usize,
    pub table: usize,
    pub algorithm: usize,
    pub formula: usize,
    pub section: usize,
    pub paragraph: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutListResult {
    pub paper_path: String,
    pub index_path: String,
    pub generated_at: String,
    pub min_score: f64,
    pub counts: LayoutCounts,
    pub items: Vec<LayoutIndexItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutGetResult {
    pub paper_path: String,
    pub index_path: String,
    pub generated_at: String,
    pub item: LayoutIndexItem,
}

struct LoadedIndex {
    index_path: String,
    generated_at: String,
    file_min_score: f64,
    items: Vec<LayoutIndexItem>,
}

fn paper_abs(vault: &Path, paper_path: &str) -> Result<PathBuf, AppError> {
    let rel = sanitize_vault_rel(paper_path).map_err(AppError::message)?;
    Ok(vault.join(rel))
}

/// Load and validate `source/layout-index.json` for a paper folder.
fn load_index(vault: &Path, paper_path: &str) -> Result<LoadedIndex, AppError> {
    let dir = paper_abs(vault, paper_path)?;
    let index_abs = dir.join("source").join(LAYOUT_INDEX_FILE);
    let rel_index = format!("{paper_path}/source/{LAYOUT_INDEX_FILE}");

    if !index_abs.is_file() {
        let raw = dir.join("source").join(LAYOUT_RAW_FILE);
        let hint = if raw.is_file() {
            "source/layout.json exists but layout-index.json is missing — open the paper in Agentero (or re-run layout analysis) to write the sidebar index"
        } else {
            "no source/layout-index.json — open the paper in Agentero and run layout analysis (Figures) first"
        };
        return Err(AppError::domain("layout_index_missing", hint));
    }

    let text = fs::read_to_string(&index_abs)
        .map_err(|e| AppError::message(format!("failed to read layout index: {e}")))?;
    let raw: Value = serde_json::from_str(&text).map_err(|e| {
        AppError::domain(
            "layout_index_invalid",
            format!("invalid layout-index.json: {e}"),
        )
    })?;

    parse_index_file(&raw, &rel_index)
}

fn parse_index_file(raw: &Value, rel_index: &str) -> Result<LoadedIndex, AppError> {
    let schema = raw.get("schemaVersion").and_then(|v| v.as_u64());
    if schema != Some(1) {
        return Err(AppError::domain(
            "layout_index_invalid",
            format!("unsupported layout-index schemaVersion (want 1, got {schema:?})"),
        ));
    }
    let source = raw.get("source").ok_or_else(|| {
        AppError::domain("layout_index_invalid", "layout-index.json missing source")
    })?;
    if source.get("mode").and_then(|v| v.as_str()) != Some("sidebar") {
        return Err(AppError::domain(
            "layout_index_invalid",
            "layout-index.json source.mode must be \"sidebar\"",
        ));
    }
    let generated_at = source
        .get("generatedAt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let file_min_score = source
        .get("minScore")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.3);

    let arr = raw.get("items").and_then(|v| v.as_array()).ok_or_else(|| {
        AppError::domain(
            "layout_index_invalid",
            "layout-index.json missing items array",
        )
    })?;

    let mut items = Vec::with_capacity(arr.len());
    for (i, entry) in arr.iter().enumerate() {
        match parse_item(entry) {
            Some(item) => items.push(item),
            None => {
                return Err(AppError::domain(
                    "layout_index_invalid",
                    format!("invalid layout index item at index {i}"),
                ));
            }
        }
    }

    Ok(LoadedIndex {
        index_path: rel_index.to_string(),
        generated_at,
        file_min_score,
        items,
    })
}

fn parse_item(v: &Value) -> Option<LayoutIndexItem> {
    let id = v.get("id")?.as_str()?.to_string();
    let stable_key = v
        .get("stableKey")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let kind = v.get("kind")?.as_str()?.to_string();
    let section = v.get("section")?.as_str()?.to_string();
    let page = v.get("page")?.as_u64()? as u32;
    let page_index = v.get("pageIndex")?.as_u64()? as u32;
    let score = v.get("score")?.as_f64()?;
    let layout_region_id = v
        .get("layoutRegionId")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let bbox_v = v.get("bbox")?;
    let bbox = Bbox {
        x: bbox_v.get("x")?.as_f64()?,
        y: bbox_v.get("y")?.as_f64()?,
        w: bbox_v.get("w")?.as_f64()?,
        h: bbox_v.get("h")?.as_f64()?,
    };
    let title = v
        .get("title")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());
    if id.is_empty() || kind.is_empty() || section.is_empty() {
        return None;
    }
    Some(LayoutIndexItem {
        id,
        stable_key,
        kind,
        section,
        page: page.max(1),
        page_index,
        bbox,
        score,
        title,
        layout_region_id,
        anchor: None,
        section_anchor: None,
        paragraph_index: None,
        text: None,
        section_marker: None,
    })
}

/// Normalize `--kind` / MCP `kind` filters. Empty input → no filter.
pub fn normalize_kind_filters(kinds: &[String]) -> Result<Vec<String>, AppError> {
    let mut out = Vec::new();
    for k in kinds {
        let t = k.trim().to_ascii_lowercase();
        if t.is_empty() {
            continue;
        }
        match t.as_str() {
            "figure" | "image" | "chart" | "table" | "algorithm" | "formula" | "section"
            | "paragraph" => out.push(t),
            other => {
                return Err(AppError::domain(
                    "usage",
                    format!(
                        "unknown kind '{other}' (use figure|image|chart|table|algorithm|formula|section|paragraph)"
                    ),
                ));
            }
        }
    }
    Ok(out)
}

fn item_matches_filters(item: &LayoutIndexItem, filters: &[String]) -> bool {
    filters.iter().any(|f| match f.as_str() {
        "figure" => item.section == "figure",
        "image" | "chart" | "table" | "algorithm" | "formula" => item.kind == *f,
        "section" | "paragraph" => item.section == *f,
        _ => false,
    })
}

fn count_items(items: &[LayoutIndexItem]) -> LayoutCounts {
    let mut c = LayoutCounts {
        total: items.len(),
        ..Default::default()
    };
    for i in items {
        match i.section.as_str() {
            "figure" => c.figure += 1,
            "table" => c.table += 1,
            "algorithm" => c.algorithm += 1,
            "formula" => c.formula += 1,
            "section" => c.section += 1,
            "paragraph" => c.paragraph += 1,
            _ => {}
        }
    }
    c
}

/// Numbered headings and directly-owned body blocks, before any score/UI filter.
/// Unnumbered headers still delimit ownership: their body must not leak into
/// the preceding numbered section. Subsections own their own counter.
fn enumerate_document_anchors(layout: &RawLayout) -> Vec<LayoutIndexItem> {
    let mut items = Vec::new();
    let mut section_anchor: Option<String> = None;
    let mut section_marker: Option<SectionMarker> = None;
    let mut paragraph_index = 0u32;
    for region in super::document_reading_order::document_reading_order(&layout.regions) {
        let (kind, anchor, ordinal) = if region.kind == "header" {
            let marker = region
                .title
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .or(region.text.as_deref())
                .and_then(section_marker_of);
            section_anchor = marker.as_ref().map(|marker| marker.canonical.clone());
            section_marker = marker;
            paragraph_index = 0;
            ("section", section_anchor.clone(), None)
        } else if matches!(region.kind.as_str(), "text" | "paragraph")
            && region.text.as_deref().is_some_and(|s| !s.trim().is_empty())
        {
            let Some(section) = section_anchor.as_ref() else {
                continue;
            };
            paragraph_index += 1;
            (
                "paragraph",
                Some(format!("{section}#p{paragraph_index}")),
                Some(paragraph_index),
            )
        } else {
            continue;
        };
        items.push(LayoutIndexItem {
            id: region.id.clone(),
            stable_key: region.id.clone(),
            kind: kind.into(),
            section: kind.into(),
            page: region.page_index + 1,
            page_index: region.page_index,
            bbox: region.bbox.clone(),
            score: region.score,
            title: region.title.clone(),
            layout_region_id: region.id.clone(),
            anchor: anchor.map(|s| format!("#{s}")),
            section_anchor: section_anchor.as_ref().map(|s| format!("#{s}")),
            paragraph_index: ordinal,
            text: region.text.clone(),
            section_marker: section_marker.as_ref().map(|marker| marker.raw.clone()),
        });
    }
    items
}

/// Only advertise fragments whose owning section is unique in this result.
/// Arabic `1` and Roman `I` stay distinct even though both canonicalize to `1`.
pub fn document_anchors(layout: &RawLayout) -> Vec<LayoutIndexItem> {
    let mut items = enumerate_document_anchors(layout);
    let mut counts: std::collections::HashMap<(String, SectionNotation), usize> =
        std::collections::HashMap::new();
    for item in &items {
        if item.kind == "section" {
            if let (Some(anchor), Some(notation)) = (
                &item.anchor,
                item.section_marker.as_deref().and_then(marker_notation),
            ) {
                *counts.entry((anchor.clone(), notation)).or_insert(0) += 1;
            }
        }
    }
    for item in &mut items {
        let Some(anchor) = item.section_anchor.clone() else {
            continue;
        };
        let notation = item.section_marker.as_deref().and_then(marker_notation);
        if notation.is_some_and(|notation| {
            counts
                .get(&(anchor.clone(), notation))
                .copied()
                .unwrap_or(0)
                > 1
        }) {
            item.anchor = None;
        }
    }
    items
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum SectionNotation {
    Arabic,
    Roman,
}

#[derive(Debug, Clone)]
struct SectionMarker {
    /// Marker as written in the heading (`1`, `2.1`, `III`).
    raw: String,
    /// Dotted Arabic form used by anchors (`1`, `2.1`, `3`).
    canonical: String,
}

fn roman_number(marker: &str) -> Option<String> {
    const ROMAN: [&str; 20] = [
        "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv",
        "xv", "xvi", "xvii", "xviii", "xix", "xx",
    ];
    ROMAN
        .iter()
        .position(|r| *r == marker.to_ascii_lowercase())
        .map(|n| (n + 1).to_string())
}

/// Canonical anchor marker for a fragment section (`1`, `2.1`, `I` -> `1`).
/// Fragments keep canonical anchors, so Roman requests must be rewritten
/// before lookup.
fn canonical_fragment_section(section: &str) -> String {
    let trimmed = section.trim();
    match section_marker_of(trimmed) {
        Some(marker) if marker.raw.eq_ignore_ascii_case(trimmed) => marker.canonical,
        _ => trimmed.to_string(),
    }
}

pub(crate) fn marker_notation(value: &str) -> Option<SectionNotation> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed
        .chars()
        .all(|c| matches!(c, 'i' | 'I' | 'v' | 'V' | 'x' | 'X'))
    {
        return Some(SectionNotation::Roman);
    }
    if trimmed.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        return Some(SectionNotation::Arabic);
    }
    None
}

/// Explicit Arabic hierarchy or an IEEE Roman top-level marker. Never fuzzy
/// match a numeric substring (2 must not resolve to 2.1, 12 or an arXiv id).
fn section_marker_of(title: &str) -> Option<SectionMarker> {
    let trimmed = title.trim_start();
    let numeric: String = trimmed
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let number = numeric.trim_end_matches('.');
    let boundary = trimmed.get(numeric.len()..).unwrap_or("");
    if !number.is_empty()
        && (boundary.is_empty()
            || boundary.starts_with(char::is_whitespace)
            || boundary.starts_with([':', ')'])
            || numeric.ends_with('.'))
        && number
            .split('.')
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
    {
        // OCR keeps numbered prompt list items as paragraph_title; they read
        // `<number>. ** ...` and must not shadow the real section.
        let rest = boundary.trim_start();
        if rest.starts_with('*') || rest.starts_with('_') {
            return None;
        }
        let canonical = number
            .split('.')
            .map(|p| p.parse::<u32>().ok().map(|n| n.to_string()))
            .collect::<Option<Vec<_>>>()?
            .join(".");
        return Some(SectionMarker {
            raw: number.to_string(),
            canonical,
        });
    }
    // Try compact dotted OCR markers, then a normal whitespace-delimited
    // marker. A later dot in the heading text is not a marker boundary.
    let compact: String = trimmed.chars().filter(|c| !c.is_whitespace()).collect();
    if let Some((marker, rest)) = compact.split_once('.') {
        if let Some(canonical) = roman_number(marker) {
            if rest.starts_with('*') || rest.starts_with('_') {
                return None;
            }
            return Some(SectionMarker {
                raw: marker.to_string(),
                canonical,
            });
        }
    }
    let marker = trimmed
        .split_whitespace()
        .next()?
        .trim_end_matches(['.', ':', ')']);
    Some(SectionMarker {
        raw: marker.to_string(),
        canonical: roman_number(marker)?,
    })
}

#[cfg(test)]
fn section_number(title: &str) -> Option<String> {
    section_marker_of(title).map(|marker| marker.canonical)
}

/// Resolve the exact, published fragment. Duplicate headings (including their
/// paragraphs) are ambiguous; no positional or confidence-based fallback.
pub fn resolve_document_anchor(
    vault: &Path,
    paper_path: &str,
    fragment: &str,
) -> Result<LayoutIndexItem, AppError> {
    let requested = fragment.strip_prefix('#').unwrap_or(fragment);
    let preferred = marker_notation(requested.split('#').next().unwrap_or(requested));
    resolve_document_anchor_preferring(vault, paper_path, fragment, preferred)
}

/// Resolve with an explicit section notation preference. Citations pass the
/// notation the author wrote (`1` vs `I`) so an appendix never shadows a
/// numbered section that canonicalizes to the same Arabic anchor.
pub(crate) fn resolve_document_anchor_preferring(
    vault: &Path,
    paper_path: &str,
    fragment: &str,
    preferred: Option<SectionNotation>,
) -> Result<LayoutIndexItem, AppError> {
    let items = document_anchor_items(vault, paper_path)?;
    let requested = fragment.strip_prefix('#').unwrap_or(fragment);
    let (requested_section, paragraph) = match requested.split_once("#p") {
        Some((section, ordinal)) if !section.is_empty() => (section, Some(ordinal)),
        _ => (requested, None),
    };
    let canonical_section = canonical_fragment_section(requested_section);
    let anchor = match paragraph {
        Some(ordinal) => format!("#{canonical_section}#p{ordinal}"),
        None => format!("#{canonical_section}"),
    };
    let section = format!("#{canonical_section}");
    let section_items: Vec<&LayoutIndexItem> = items
        .iter()
        .filter(|i| i.kind == "section" && i.anchor.as_deref() == Some(section.as_str()))
        .collect();
    let notation = match preferred {
        Some(preferred) => {
            let exact: Vec<&LayoutIndexItem> = section_items
                .iter()
                .copied()
                .filter(|i| {
                    i.section_marker.as_deref().and_then(marker_notation) == Some(preferred)
                })
                .collect();
            match exact.len() {
                1 => Some(preferred),
                // IEEE papers write `III.`; an Arabic request still resolves
                // when that is the only section with this number.
                0 if section_items.len() == 1 => section_items[0]
                    .section_marker
                    .as_deref()
                    .and_then(marker_notation),
                0 => None,
                _ => {
                    return Err(AppError::domain(
                        "citation_anchor_ambiguous",
                        format!("ambiguous PDF section `{section}`"),
                    ));
                }
            }
        }
        None if section_items.len() > 1 => {
            return Err(AppError::domain(
                "citation_anchor_ambiguous",
                format!("ambiguous PDF section `{section}`"),
            ));
        }
        None => section_items
            .first()
            .and_then(|i| i.section_marker.as_deref().and_then(marker_notation)),
    };
    let matches: Vec<_> = items
        .iter()
        .filter(|i| i.anchor.as_deref() == Some(anchor.as_str()))
        .filter(|i| {
            notation.is_none() || i.section_marker.as_deref().and_then(marker_notation) == notation
        })
        .cloned()
        .collect();
    match matches.len() {
        1 => Ok(matches.into_iter().next().unwrap()),
        0 => Err(AppError::domain(
            "citation_anchor_not_found",
            format!("no PDF anchor `{anchor}`"),
        )),
        _ => Err(AppError::domain(
            "citation_anchor_ambiguous",
            format!("ambiguous PDF anchor `{anchor}`"),
        )),
    }
}

fn load_document_anchors(vault: &Path, paper_path: &str) -> Result<Vec<LayoutIndexItem>, AppError> {
    Ok(document_anchors(&load_raw_layout(vault, paper_path)?))
}

/// List regions with optional kind filters and min score.
pub fn list_regions(
    vault: &Path,
    paper_path: &str,
    kinds: &[String],
    min_score: Option<f64>,
) -> Result<LayoutListResult, AppError> {
    let filters = normalize_kind_filters(kinds)?;
    let raw_only = !filters.is_empty()
        && filters
            .iter()
            .all(|f| matches!(f.as_str(), "section" | "paragraph"));
    let loaded = if raw_only {
        // Body anchors do not depend on the optional sidebar index.
        LoadedIndex {
            index_path: format!("{paper_path}/source/{LAYOUT_RAW_FILE}"),
            generated_at: String::new(),
            file_min_score: 0.3,
            items: Vec::new(),
        }
    } else {
        load_index(vault, paper_path)?
    };
    let threshold = min_score.unwrap_or(loaded.file_min_score);
    let mut items = loaded.items;
    if filters
        .iter()
        .any(|f| matches!(f.as_str(), "section" | "paragraph"))
    {
        items.extend(load_document_anchors(vault, paper_path)?);
    }
    // Enumeration always precedes filtering, so low confidence blocks still
    // reserve their paragraph ordinal.
    items.retain(|i| {
        i.score + f64::EPSILON >= threshold
            && (filters.is_empty() || item_matches_filters(i, &filters))
    });
    if filters
        .iter()
        .any(|f| matches!(f.as_str(), "section" | "paragraph"))
    {
        items.sort_by(|a, b| {
            a.page_index
                .cmp(&b.page_index)
                .then_with(|| a.bbox.y.total_cmp(&b.bbox.y))
        });
    }

    let counts = count_items(&items);
    Ok(LayoutListResult {
        paper_path: paper_path.to_string(),
        index_path: loaded.index_path,
        generated_at: loaded.generated_at,
        min_score: threshold,
        counts,
        items,
    })
}

/// Get one region by id.
pub fn get_region(
    vault: &Path,
    paper_path: &str,
    region_id: &str,
) -> Result<LayoutGetResult, AppError> {
    let (item, index_path, generated_at) = if region_id.starts_with('#') {
        (
            resolve_document_anchor(vault, paper_path, region_id)?,
            format!("{paper_path}/source/{LAYOUT_RAW_FILE}"),
            String::new(),
        )
    } else {
        match load_index(vault, paper_path) {
            Ok(loaded) if loaded.items.iter().any(|i| i.id == region_id) => {
                let item = loaded
                    .items
                    .into_iter()
                    .find(|i| i.id == region_id)
                    .unwrap();
                (item, loaded.index_path, loaded.generated_at)
            }
            result => {
                let raw_items = load_document_anchors(vault, paper_path);
                let item = raw_items?.into_iter().find(|i| i.id == region_id);
                let item = item.ok_or_else(|| match result {
                    Err(e) => e,
                    Ok(_) => AppError::domain(
                        "layout_region_not_found",
                        format!("no layout region id '{region_id}'"),
                    ),
                })?;
                (
                    item,
                    format!("{paper_path}/source/{LAYOUT_RAW_FILE}"),
                    String::new(),
                )
            }
        }
    };
    Ok(LayoutGetResult {
        paper_path: paper_path.to_string(),
        index_path,
        generated_at,
        item,
    })
}

/// Shared by `mark add --region` and `layout get`.
pub fn load_region(
    vault: &Path,
    paper_path: &str,
    region_id: &str,
) -> Result<LayoutIndexItem, AppError> {
    Ok(get_region(vault, paper_path, region_id)?.item)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn write_index(paper: &Path, body: &str) {
        let source = paper.join("source");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join(LAYOUT_INDEX_FILE), body).unwrap();
    }

    fn write_raw_layout(paper: &Path, body: &str) {
        let source = paper.join("source");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join(LAYOUT_RAW_FILE), body).unwrap();
    }

    #[test]
    fn missing_index_errors() {
        let dir = tempdir().unwrap();
        let vault = dir.path();
        let paper = vault.join("papers").join("p1");
        fs::create_dir_all(&paper).unwrap();
        let err = list_regions(vault, "papers/p1", &[], None).unwrap_err();
        assert_eq!(err.code(), "layout_index_missing");
    }

    #[test]
    fn list_filters_figure() {
        let dir = tempdir().unwrap();
        let vault = dir.path();
        let paper = vault.join("papers").join("p1");
        write_index(
            &paper,
            r#"{
              "schemaVersion": 1,
              "source": {"mode": "sidebar", "generatedAt": "t", "minScore": 0.3},
              "items": [
                {"id":"figure-1","stableKey":"a","kind":"image","section":"figure","page":1,"pageIndex":0,"bbox":{"x":0,"y":0,"w":1,"h":1},"score":0.9,"layoutRegionId":"r1"},
                {"id":"table-1","stableKey":"b","kind":"table","section":"table","page":1,"pageIndex":0,"bbox":{"x":0,"y":0,"w":1,"h":1},"score":0.9,"layoutRegionId":"r2"}
              ]
            }"#,
        );
        let listed = list_regions(vault, "papers/p1", &["figure".into()], None).unwrap();
        assert_eq!(listed.items.len(), 1);
        assert_eq!(listed.items[0].id, "figure-1");
        let got = get_region(vault, "papers/p1", "table-1").unwrap();
        assert_eq!(got.item.kind, "table");
    }

    #[test]
    fn section_kind_is_accepted() {
        assert_eq!(
            normalize_kind_filters(&["section".into()]).unwrap(),
            vec!["section"]
        );
    }

    #[test]
    fn list_merges_section_headers_from_raw_layout() {
        let dir = tempdir().unwrap();
        let vault = dir.path();
        let paper = vault.join("papers").join("p1");
        write_index(
            &paper,
            r#"{
              "schemaVersion": 1,
              "source": {"mode": "sidebar", "generatedAt": "t", "minScore": 0.3},
              "items": [
                {"id":"figure-1","stableKey":"a","kind":"image","section":"figure","page":2,"pageIndex":1,"bbox":{"x":0,"y":0,"w":1,"h":1},"score":0.9,"title":"Figure 1","layoutRegionId":"r1"}
              ]
            }"#,
        );
        write_raw_layout(
            &paper,
            r#"{
              "schemaVersion": 3,
              "source": {"mode": "embedpdf-layout", "generatedAt": "t"},
              "regions": [
                {"id":"h1","pageIndex":0,"kind":"header","score":0.95,"bbox":{"x":0.1,"y":0.1,"w":0.8,"h":0.05},"title":"1 Introduction"},
                {"id":"h2","pageIndex":1,"kind":"header","score":0.92,"bbox":{"x":0.1,"y":0.2,"w":0.8,"h":0.05},"title":"2 Method"},
                {"id":"p1","pageIndex":0,"kind":"paragraph","score":0.8,"bbox":{"x":0.1,"y":0.2,"w":0.8,"h":0.1},"text":"body text"}
              ]
            }"#,
        );

        // Default list does not include headers.
        let default = list_regions(vault, "papers/p1", &[], None).unwrap();
        assert_eq!(default.items.len(), 1);
        assert_eq!(default.counts.section, 0);

        // Explicit --kind section merges headers from layout.json.
        let sections = list_regions(vault, "papers/p1", &["section".into()], None).unwrap();
        assert_eq!(sections.items.len(), 2);
        assert_eq!(sections.counts.section, 2);
        assert_eq!(sections.items[0].id, "h1");
        assert_eq!(sections.items[0].page_index, 0);
        assert_eq!(sections.items[0].title.as_deref(), Some("1 Introduction"));
        assert_eq!(sections.items[1].id, "h2");
        assert_eq!(sections.items[1].page_index, 1);

        // Mixed filters keep sidebar items and merged headers, sorted by page.
        let mixed = list_regions(
            vault,
            "papers/p1",
            &["figure".into(), "section".into()],
            None,
        )
        .unwrap();
        assert_eq!(mixed.items.len(), 3);
        assert_eq!(mixed.items[0].id, "h1");
        assert_eq!(mixed.items[1].id, "figure-1");
        assert_eq!(mixed.items[2].id, "h2");
    }

    #[test]
    fn section_headers_honor_min_score() {
        let dir = tempdir().unwrap();
        let vault = dir.path();
        let paper = vault.join("papers").join("p1");
        write_index(
            &paper,
            r#"{
              "schemaVersion": 1,
              "source": {"mode": "sidebar", "generatedAt": "t", "minScore": 0.3},
              "items": []
            }"#,
        );
        write_raw_layout(
            &paper,
            r#"{
              "regions": [
                {"id":"h1","pageIndex":0,"kind":"header","score":0.95,"bbox":{"x":0,"y":0,"w":1,"h":1},"title":"High"},
                {"id":"h2","pageIndex":0,"kind":"header","score":0.2,"bbox":{"x":0,"y":0,"w":1,"h":1},"title":"Low"}
              ]
            }"#,
        );
        let listed = list_regions(vault, "papers/p1", &["section".into()], Some(0.5)).unwrap();
        assert_eq!(listed.items.len(), 1);
        assert_eq!(listed.items[0].id, "h1");
    }

    #[test]
    fn raw_layout_parses_pages_in_reading_order() {
        let dir = tempdir().unwrap();
        let vault = dir.path();
        let paper = vault.join("papers").join("p1");
        write_raw_layout(
            &paper,
            r#"{
              "schemaVersion": 3,
              "source": {"mode": "embedpdf-layout", "generatedAt": "t"},
              "regions": [
                {"id":"p1","pageIndex":0,"kind":"paragraph","score":0.8,"bbox":{"x":10,"y":40,"w":500,"h":20},"text":"Transformer attention test evidence."},
                {"id":"p2","pageIndex":0,"kind":"paragraph","score":0.8,"bbox":{"x":10,"y":70,"w":500,"h":20},"text":"second paragraph"},
                {"id":"p3","pageIndex":1,"kind":"paragraph","score":0.8,"bbox":{"x":510,"y":10,"w":500,"h":20},"text":"Transformer attention on page two."}
              ]
            }"#,
        );
        let layout = load_raw_layout(vault, "papers/p1").unwrap();
        assert_eq!(page_count(&layout), 2);
        let page1 = page_regions(&layout, 0);
        assert_eq!(page1.len(), 2);
        assert_eq!(page1[0].id, "p1");
        assert_eq!(page1[1].id, "p2");
        let page2 = page_regions(&layout, 1);
        assert_eq!(page2.len(), 1);
        assert_eq!(
            page2[0].text.as_deref(),
            Some("Transformer attention on page two.")
        );
    }

    #[test]
    fn raw_layout_missing_errors() {
        let dir = tempdir().unwrap();
        let vault = dir.path();
        let paper = vault.join("papers").join("p1");
        fs::create_dir_all(&paper).unwrap();
        let err = load_raw_layout(vault, "papers/p1").unwrap_err();
        assert_eq!(err.code(), "layout_raw_missing");
    }

    #[test]
    fn page_map_resolves_unique_page_and_abstains_on_ambiguity() {
        let dir = tempdir().unwrap();
        let vault = dir.path();
        let paper = vault.join("papers").join("p1");
        write_raw_layout(
            &paper,
            r#"{
              "regions": [
                {"id":"p1","pageIndex":0,"kind":"paragraph","bbox":{"x":10,"y":40,"w":500,"h":20},"text":"Transformer attention test evidence."},
                {"id":"p2","pageIndex":2,"kind":"paragraph","bbox":{"x":10,"y":40,"w":500,"h":20},"text":"another unique attention body"}
              ]
            }"#,
        );
        let layout = load_raw_layout(vault, "papers/p1").unwrap();
        // Exact normalized equality -> that region's page (1-based = index+1).
        assert_eq!(
            page_map(&layout, "  Transformer  ATTENTION test evidence. "),
            Some(1)
        );
        // Ambiguous: the needle is a substring of regions on multiple pages -> None.
        assert_eq!(page_map(&layout, "another unique attention body"), Some(3));
        assert_eq!(page_map(&layout, "attention"), None);
        // No match at all -> None.
        assert_eq!(page_map(&layout, "absent keyword"), None);
        assert_eq!(page_map(&layout, ""), None);
    }
    #[test]
    fn paragraph_anchors_follow_reading_order_and_survive_filtering() {
        let dir = tempdir().unwrap();
        let paper = dir.path().join("papers/p1");
        let region = |id: &str, kind: &str, order: u32, text: &str, score: f64| {
            serde_json::json!({
                "id": id, "pageIndex": 0, "readingOrder": order, "kind": kind,
                "text": text, "score": score, "bbox": {"x":0.1,"y":0.5,"w":0.3,"h":0.1}
            })
        };
        let regions = vec![
            region("subbody", "text", 4, "subsection body", 0.9),
            region("h", "header", 0, "2 Method", 0.9),
            region("p2", "text", 2, "second direct block", 0.9),
            region("p1", "text", 1, "low confidence first block", 0.1),
            region("sub", "header", 3, "2.1 Details", 0.9),
            region("next", "header", 5, "3 Results", 0.9),
            region("nextbody", "text", 6, "results body", 0.9),
            region("end", "header", 7, "References", 0.9),
            region("ref", "text", 8, "not section 3", 0.9),
        ];
        write_raw_layout(&paper, &serde_json::json!({"regions":regions}).to_string());
        let listed =
            list_regions(dir.path(), "papers/p1", &["paragraph".into()], Some(0.5)).unwrap();
        assert_eq!(listed.items.len(), 3);
        assert!(listed
            .items
            .iter()
            .any(|i| i.anchor.as_deref() == Some("#2#p2") && i.id == "p2"));
        assert!(!listed.items.iter().any(|i| i.id == "ref"));
        for (anchor, id) in [
            ("#2#p1", "p1"),
            ("#2#p2", "p2"),
            ("#2.1#p1", "subbody"),
            ("#3#p1", "nextbody"),
        ] {
            let first = get_region(dir.path(), "papers/p1", anchor).unwrap().item;
            let reopened = get_region(dir.path(), "papers/p1", anchor).unwrap().item;
            assert_eq!(first.id, id);
            assert_eq!(first.id, reopened.id);
            assert!(first.text.is_some());
        }
        assert!(get_region(dir.path(), "papers/p1", "#2#p3").is_err());
        assert!(get_region(dir.path(), "papers/p1", "#2.10").is_err());
    }

    #[test]
    fn duplicate_sections_fail_closed_even_for_unique_paragraph_ordinals() {
        let dir = tempdir().unwrap();
        let paper = dir.path().join("papers/p1");
        write_raw_layout(
            &paper,
            r#"{"regions":[
            {"id":"h1","pageIndex":0,"kind":"header","text":"2 Method","bbox":{"x":0,"y":0,"w":1,"h":0.1}},
            {"id":"p1","pageIndex":0,"kind":"text","text":"body","bbox":{"x":0,"y":0.1,"w":1,"h":0.1}},
            {"id":"h2","pageIndex":1,"kind":"header","text":"2 Other","bbox":{"x":0,"y":0,"w":1,"h":0.1}}
        ]}"#,
        );
        let err = resolve_document_anchor(dir.path(), "papers/p1", "2#p1").unwrap_err();
        assert_eq!(err.code(), "citation_anchor_ambiguous");
        let listed = list_regions(dir.path(), "papers/p1", &["paragraph".into()], None).unwrap();
        assert!(listed.items[0].anchor.is_none());
    }
    #[test]
    fn arabic_and_roman_section_markers_stay_distinct() {
        let dir = tempdir().unwrap();
        let paper = dir.path().join("papers/p1");
        write_raw_layout(
            &paper,
            r#"{"regions":[
            {"id":"intro","pageIndex":0,"kind":"header","text":"1 Introduction","bbox":{"x":0,"y":0,"w":1,"h":0.1}},
            {"id":"intro-body","pageIndex":0,"kind":"text","text":"intro body","bbox":{"x":0,"y":0.1,"w":1,"h":0.1}},
            {"id":"appendix","pageIndex":20,"kind":"header","text":"I Prompt Templates","bbox":{"x":0,"y":0,"w":1,"h":0.1}},
            {"id":"appendix-body","pageIndex":20,"kind":"text","text":"prompt body","bbox":{"x":0,"y":0.1,"w":1,"h":0.1}}
        ]}"#,
        );
        assert_eq!(
            get_region(dir.path(), "papers/p1", "#1").unwrap().item.id,
            "intro"
        );
        assert_eq!(
            get_region(dir.path(), "papers/p1", "#1#p1")
                .unwrap()
                .item
                .id,
            "intro-body"
        );
        assert_eq!(
            get_region(dir.path(), "papers/p1", "#I").unwrap().item.id,
            "appendix"
        );
        assert_eq!(
            get_region(dir.path(), "papers/p1", "#I#p1")
                .unwrap()
                .item
                .id,
            "appendix-body"
        );
    }

    #[test]
    fn numbered_prompt_list_items_do_not_shadow_sections() {
        let dir = tempdir().unwrap();
        let paper = dir.path().join("papers/p1");
        write_raw_layout(
            &paper,
            r#"{"regions":[
            {"id":"h4","pageIndex":4,"kind":"header","text":"4. Experiments","bbox":{"x":0,"y":0,"w":1,"h":0.1}},
            {"id":"body","pageIndex":4,"kind":"text","text":"section body","bbox":{"x":0,"y":0.1,"w":1,"h":0.1}},
            {"id":"prompt","pageIndex":13,"kind":"header","text":"4. ** Critical Rules: **","bbox":{"x":0,"y":0.2,"w":1,"h":0.1}},
            {"id":"prompt-body","pageIndex":13,"kind":"text","text":"prompt body","bbox":{"x":0,"y":0.3,"w":1,"h":0.1}}
        ]}"#,
        );
        assert_eq!(
            get_region(dir.path(), "papers/p1", "#4").unwrap().item.id,
            "h4"
        );
        assert_eq!(
            get_region(dir.path(), "papers/p1", "#4#p1")
                .unwrap()
                .item
                .id,
            "body"
        );
    }

    #[test]
    fn section_markers_preserve_compact_roman_ocr_without_prefix_collisions() {
        for title in ["III.Method", "III. M ETHOD", "I I I. Method", "III Method"] {
            assert_eq!(section_number(title).as_deref(), Some("3"), "{title}");
        }
        assert_eq!(
            section_number("I Preliminaries (e.g. notation)").as_deref(),
            Some("1")
        );
        assert_eq!(section_number("2.1 Method").as_deref(), Some("2.1"));
        assert_eq!(section_number("2.Method").as_deref(), Some("2"));
        assert_eq!(section_number("Introduction"), None);
        assert_eq!(section_number("arXiv:2504.16054v1"), None);
    }
}
