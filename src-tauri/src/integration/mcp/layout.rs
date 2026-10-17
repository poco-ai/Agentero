//! MCP layout_list / layout_get helpers + schemars DTOs.

use crate::core::error::AppError;
use crate::features::pdf::layout_index::{
    self, LayoutGetResult, LayoutIndexItem, LayoutListResult,
};
use crate::integration::mcp::paper;
use serde::Serialize;
use std::path::Path;

use agentero_core::features::paper::reading::BboxOut;
pub use agentero_core::features::paper::reading::{read_page, PageReadOut};

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
