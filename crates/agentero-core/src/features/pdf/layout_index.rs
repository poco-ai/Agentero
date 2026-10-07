//! Sidebar layout index (`{paper}/source/layout-index.json`).
//!
//! Shared by CLI `layout` / `mark --region` and MCP `layout_*` tools.

use crate::error::AppError;
use crate::fs::sanitize_vault_rel;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

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
}

/// Ordered raw regions for a paper. Order follows document reading order
/// (page then top-to-bottom) so a caller can page through a paper naturally.
#[derive(Debug)]
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
                bbox_order(&a.bbox)
                    .partial_cmp(&bbox_order(&b.bbox))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(RawLayout { regions })
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
            "figure" | "image" | "chart" | "table" | "algorithm" | "formula" | "section" => {
                out.push(t)
            }
            other => {
                return Err(AppError::domain(
                    "usage",
                    format!(
                        "unknown kind '{other}' (use figure|image|chart|table|algorithm|formula|section)"
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
        "section" => item.section == "section",
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
            _ => {}
        }
    }
    c
}

/// Load paragraph/section title regions from the raw `layout.json`.
///
/// These are not stored in `layout-index.json` (which only keeps figures /
/// tables / algorithms / formulas), but they are useful for citations and
/// navigation, so we merge them on demand when `--kind section` is requested.
fn load_section_headers(vault: &Path, paper_path: &str) -> Result<Vec<LayoutIndexItem>, AppError> {
    let dir = paper_abs(vault, paper_path)?;
    let raw_path = dir.join("source").join(LAYOUT_RAW_FILE);
    if !raw_path.is_file() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&raw_path)
        .map_err(|e| AppError::message(format!("failed to read raw layout: {e}")))?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|e| AppError::message(format!("invalid raw layout json: {e}")))?;
    let arr = value
        .get("regions")
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            AppError::domain("layout_raw_invalid", "layout.json missing regions array")
        })?;

    let mut items = Vec::new();
    for entry in arr.iter() {
        let kind = entry.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        if kind != "header" {
            continue;
        }
        let id = entry.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if id.is_empty() {
            continue;
        }
        let page_index = entry.get("pageIndex").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        let score = entry.get("score").and_then(|v| v.as_f64()).unwrap_or(1.0);
        let title = entry
            .get("title")
            .or_else(|| entry.get("text"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty());
        let Some(bbox_v) = entry.get("bbox") else {
            continue;
        };
        let bbox = Bbox {
            x: bbox_v.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0),
            y: bbox_v.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0),
            w: bbox_v.get("w").and_then(|v| v.as_f64()).unwrap_or(0.0),
            h: bbox_v.get("h").and_then(|v| v.as_f64()).unwrap_or(0.0),
        };
        items.push(LayoutIndexItem {
            id: id.to_string(),
            stable_key: id.to_string(),
            kind: "section".to_string(),
            section: "section".to_string(),
            page: page_index + 1,
            page_index,
            bbox,
            score,
            title,
            layout_region_id: id.to_string(),
        });
    }
    Ok(items)
}

/// List regions with optional kind filters and min score.
pub fn list_regions(
    vault: &Path,
    paper_path: &str,
    kinds: &[String],
    min_score: Option<f64>,
) -> Result<LayoutListResult, AppError> {
    let loaded = load_index(vault, paper_path)?;
    let threshold = min_score.unwrap_or(loaded.file_min_score);
    let filters = normalize_kind_filters(kinds)?;
    let mut items = loaded.items;
    items.retain(|i| i.score + f64::EPSILON >= threshold);
    if !filters.is_empty() {
        items.retain(|i| item_matches_filters(i, &filters));
    }

    // Merge section headers from layout.json when explicitly requested.
    if filters.iter().any(|f| f == "section") {
        let mut headers = load_section_headers(vault, paper_path)?;
        headers.retain(|i| i.score + f64::EPSILON >= threshold);
        items.append(&mut headers);
        items.sort_by(|a, b| {
            a.page_index.cmp(&b.page_index).then_with(|| {
                a.bbox
                    .y
                    .partial_cmp(&b.bbox.y)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
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
    let loaded = load_index(vault, paper_path)?;
    let item = loaded
        .items
        .into_iter()
        .find(|i| i.id == region_id)
        .ok_or_else(|| {
            AppError::domain(
                "layout_region_not_found",
                format!("no layout region id '{region_id}'"),
            )
        })?;
    Ok(LayoutGetResult {
        paper_path: paper_path.to_string(),
        index_path: loaded.index_path,
        generated_at: loaded.generated_at,
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
}
