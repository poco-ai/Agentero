//! MCP layout_list / layout_get helpers + schemars DTOs.

use crate::core::error::AppError;
use crate::features::pdf::layout_index::{
    self, LayoutGetResult, LayoutIndexItem, LayoutListResult,
};
use crate::integration::mcp::paper;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct BboxOut {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LayoutItemOut {
    pub id: String,
    pub stable_key: String,
    pub kind: String,
    pub section: String,
    pub page: u32,
    pub page_index: u32,
    pub bbox: BboxOut,
    pub score: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub layout_region_id: String,
}

impl From<&LayoutIndexItem> for LayoutItemOut {
    fn from(i: &LayoutIndexItem) -> Self {
        Self {
            id: i.id.clone(),
            stable_key: i.stable_key.clone(),
            kind: i.kind.clone(),
            section: i.section.clone(),
            page: i.page,
            page_index: i.page_index,
            bbox: BboxOut {
                x: i.bbox.x,
                y: i.bbox.y,
                w: i.bbox.w,
                h: i.bbox.h,
            },
            score: i.score,
            title: i.title.clone(),
            layout_region_id: i.layout_region_id.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LayoutCountsOut {
    pub total: usize,
    pub figure: usize,
    pub table: usize,
    pub algorithm: usize,
    pub formula: usize,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LayoutListOut {
    pub paper_path: String,
    pub index_path: String,
    pub generated_at: String,
    pub min_score: f64,
    pub counts: LayoutCountsOut,
    pub items: Vec<LayoutItemOut>,
}

impl From<LayoutListResult> for LayoutListOut {
    fn from(r: LayoutListResult) -> Self {
        Self {
            paper_path: r.paper_path,
            index_path: r.index_path,
            generated_at: r.generated_at,
            min_score: r.min_score,
            counts: LayoutCountsOut {
                total: r.counts.total,
                figure: r.counts.figure,
                table: r.counts.table,
                algorithm: r.counts.algorithm,
                formula: r.counts.formula,
            },
            items: r.items.iter().map(LayoutItemOut::from).collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LayoutGetOut {
    pub paper_path: String,
    pub index_path: String,
    pub generated_at: String,
    pub item: LayoutItemOut,
}

impl From<LayoutGetResult> for LayoutGetOut {
    fn from(r: LayoutGetResult) -> Self {
        Self {
            paper_path: r.paper_path,
            index_path: r.index_path,
            generated_at: r.generated_at,
            item: LayoutItemOut::from(&r.item),
        }
    }
}

pub fn list(
    vault: &Path,
    ref_: &str,
    kinds: &[String],
    min_score: Option<f64>,
) -> Result<LayoutListOut, AppError> {
    let paper = paper::resolve_paper(vault, ref_)?;
    Ok(LayoutListOut::from(layout_index::list_regions(
        vault,
        &paper.path,
        kinds,
        min_score,
    )?))
}

pub fn get(vault: &Path, ref_: &str, id: &str) -> Result<LayoutGetOut, AppError> {
    let paper = paper::resolve_paper(vault, ref_)?;
    Ok(LayoutGetOut::from(layout_index::get_region(
        vault,
        &paper.path,
        id.trim(),
    )?))
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PageRegionOut {
    pub id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub bbox: BboxOut,
}

impl From<&agentero_core::features::pdf::layout_index::RawLayoutRegion> for PageRegionOut {
    fn from(r: &agentero_core::features::pdf::layout_index::RawLayoutRegion) -> Self {
        Self {
            id: r.id.clone(),
            kind: r.kind.clone(),
            title: r.title.clone(),
            text: r.text.clone(),
            bbox: BboxOut {
                x: r.bbox.x,
                y: r.bbox.y,
                w: r.bbox.w,
                h: r.bbox.h,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PageReadOut {
    /// Resolved vault-relative paper folder.
    pub paper_path: String,
    /// 1-based physical page requested.
    pub page: u32,
    /// Total physical pages present in the raw layout (0 when none).
    pub page_count: u32,
    /// Number of regions on the requested page, in reading order.
    pub region_count: usize,
    /// Paragraph-level (kind contains `text`) regions on the page.
    pub text_regions: Vec<PageRegionOut>,
    /// All regions on the page, including headers / figures / tables.
    pub regions: Vec<PageRegionOut>,
}

/// Read every layout region on a 1-based physical page of a paper.
///
/// Requires `{paper}/source/layout.json` (schemaVersion 3, produced by the
/// desktop layout analysis). `page` is the 1-based page number shown in the
/// PDF viewer; it is mapped to the 0-based `pageIndex` stored in the layout.
pub fn read_page(vault: &Path, ref_: &str, page: u32) -> Result<PageReadOut, AppError> {
    use agentero_core::features::pdf::layout_index::{self, RawLayoutRegion};
    let paper = paper::resolve_paper(vault, ref_)?;
    if page == 0 {
        return Err(AppError::message(format!(
            "page must be 1-based, got {page} (first page is 1)"
        )));
    }
    let layout = layout_index::load_raw_layout(vault, &paper.path)?;
    let page_index = page - 1;
    let page_regions: Vec<&RawLayoutRegion> = layout_index::page_regions(&layout, page_index);
    let to_out = |r: &RawLayoutRegion| PageRegionOut::from(r);
    let regions: Vec<PageRegionOut> = page_regions.iter().copied().map(to_out).collect();
    // Paragraph-level regions: anything carrying body text that is not a
    // figure/table/formula/algorithm. layout.json tags text with kinds
    // like paragraph / header / title, so a plain contains("text") test
    // is too narrow; exclude the non-text kinds instead.
    const NON_TEXT_KINDS: [&str; 6] = ["figure", "image", "chart", "table", "formula", "algorithm"];
    let text_regions: Vec<PageRegionOut> = page_regions
        .iter()
        .filter(|r| {
            r.text.as_deref().is_some_and(|t| !t.trim().is_empty())
                && !NON_TEXT_KINDS
                    .iter()
                    .any(|k| r.kind.to_ascii_lowercase().contains(k))
        })
        .copied()
        .map(to_out)
        .collect();
    Ok(PageReadOut {
        paper_path: paper.path,
        page,
        page_count: layout_index::page_count(&layout),
        region_count: regions.len(),
        text_regions,
        regions,
    })
}
