//! Shared paper reference resolution, PDF text and physical page reading.

use crate::error::AppError;
use crate::features::paper::catalog::papers::{self, PaperRecord, PaperRefLookup};
use serde::Serialize;
use std::path::Path;

/// Resolve a paper reference with MCP-flavoured error text.
pub fn resolve_paper(vault: &Path, ref_: &str) -> Result<PaperRecord, AppError> {
    let reference = ref_.trim();
    match papers::lookup_paper_ref(vault, reference)? {
        PaperRefLookup::Found(record) => Ok(*record),
        PaperRefLookup::NotFound => Err(AppError::message(format!("paper not found: {reference}"))),
        PaperRefLookup::Ambiguous(paths) => Err(AppError::message(format!(
            "paper id '{reference}' is ambiguous ({} matches): {}",
            paths.len(),
            paths.join(", ")
        ))),
    }
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct BboxOut {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// One page's text for `paper_text_get`.
#[derive(Debug, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct PaperTextPage {
    /// 1-based page number.
    pub page: u32,
    /// PDFium char count before truncation.
    pub char_count: usize,
    /// Page text, truncated to the per-page budget.
    pub text: String,
}

/// Full-text extraction result for `paper_text_get` (#676).
#[derive(Debug, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct PaperTextOut {
    /// Vault-relative paper path (same resolution as other paper tools).
    pub path: String,
    /// Total page count of the PDF.
    pub page_count: u32,
    /// Per-page extracted text.
    pub pages: Vec<PaperTextPage>,
}

/// Extract page text for a paper's main PDF. `pages` selects 1-based pages
/// (None = all); each page is truncated to `max_chars` characters.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub fn text(
    vault: &Path,
    ref_: &str,
    pages: Option<Vec<u32>>,
    max_chars: usize,
) -> Result<PaperTextOut, AppError> {
    let record = resolve_paper(vault, ref_)?;
    let folder_id = record
        .path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .to_string();
    let paper_dir = vault.join(&record.path);
    // paper_commit convention: `{folder-id}.pdf` beside NOTES.md.
    let mut pdf_path = paper_dir.join(format!("{folder_id}.pdf"));
    if !pdf_path.is_file() {
        // Fallback: first .pdf in the paper directory.
        pdf_path = std::fs::read_dir(&paper_dir)
            .map_err(|e| AppError::message(format!("read paper dir: {e}")))?
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .find(|p| {
                p.extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
                    && p.is_file()
            })
            .ok_or_else(|| AppError::message("no PDF in paper folder"))?;
    }
    let bytes =
        std::fs::read(&pdf_path).map_err(|e| AppError::message(format!("read pdf: {e}")))?;
    let out = crate::features::pdf::text::extract_text(&bytes, pages.as_deref(), max_chars)?;
    Ok(PaperTextOut {
        path: record.path,
        page_count: out.page_count,
        pages: out
            .pages
            .into_iter()
            .map(|p| PaperTextPage {
                page: p.page,
                char_count: p.char_count,
                text: p.text,
            })
            .collect(),
    })
}

/// Mobile targets have no PDFium binding, so `paper_text_get` cannot extract
/// page text; keep the command surface identical and fail at call time.
#[cfg(any(target_os = "ios", target_os = "android"))]
pub fn text(
    _vault: &Path,
    _ref_: &str,
    _pages: Option<Vec<u32>>,
    _max_chars: usize,
) -> Result<PaperTextOut, AppError> {
    Err(AppError::message(
        "paper text extraction is unavailable on this platform",
    ))
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
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

impl From<&crate::features::pdf::layout_index::RawLayoutRegion> for PageRegionOut {
    fn from(r: &crate::features::pdf::layout_index::RawLayoutRegion) -> Self {
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

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
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
    use crate::features::pdf::layout_index::{self, RawLayoutRegion};
    let paper = resolve_paper(vault, ref_)?;
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
