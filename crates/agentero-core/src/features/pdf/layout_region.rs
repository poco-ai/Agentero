//! Region / sidecar model shared by the headless layout pipeline
//! ([`super::layout_analyze`]) and the sidebar index builder
//! ([`super::layout_sidebar`]).
//!
//! The JSON shapes below must stay byte-compatible with the desktop sidecar
//! readers/writers in `src/lib/pdf/layout/{types,io,layout-index}.ts`: a
//! `source/layout.json` written by the CLI has to load in the desktop viewer
//! (and vice versa). `schemaVersion` 3 is the only supported sidecar version.
//! A sidecar with an invalid region (missing geometry, unknown kind) is
//! rejected wholesale by the desktop parser, so this module is deliberately
//! strict about what it emits.

use serde::{Deserialize, Serialize};

/// Raw layout sidecar `schemaVersion`.
pub const LAYOUT_SIDECAR_SCHEMA_VERSION: u32 = 3;
/// Sidecar file name below `{paper}/source/`.
pub const LAYOUT_SIDECAR_FILE: &str = "layout.json";
/// Sidebar index file name below `{paper}/source/`.
pub const LAYOUT_INDEX_FILE: &str = "layout-index.json";
/// Sidebar gallery / hit-target confidence gate (mirrors TS constant).
pub const LAYOUT_SIDEBAR_MIN_SCORE: f64 = 0.3;

/// True when a page / geometry dimension is usable: finite and positive.
///
/// Spelled as a helper (not `!(value > 0.0)`) because `f32`/`f64` are only
/// partially ordered: `NaN` must fail the gate instead of slipping through a
/// negated comparison, and `clippy::neg_cmp_op_on_partial_ord` rejects the
/// negated form outright.
pub(crate) fn is_usable_dimension(value: impl Into<f64>) -> bool {
    let value = value.into();
    value.is_finite() && value > 0.0
}

/// True when a confidence score clears `min`; `NaN` (unset provider score)
/// fails the gate.
pub(crate) fn reaches_min_score(score: f64, min: f64) -> bool {
    score.is_finite() && score >= min
}

/// Normalized (`bbox`, 0–1 of the page) or point (`rect`) page geometry.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn new(x: f64, y: f64, w: f64, h: f64) -> Self {
        Self { x, y, w, h }
    }

    /// Page-area fraction (0–1) covered by this box.
    pub fn area(&self) -> f64 {
        (self.w.max(0.0)) * (self.h.max(0.0))
    }
}

/// Region kind (desktop `PdfLayoutKind`). Stored snake_case in JSON.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LayoutKind {
    Image,
    Table,
    Algorithm,
    Formula,
    FormulaNumber,
    Chart,
    FigureTitle,
    Header,
    /// Paper abstract block — debug only, never sidebar.
    Abstract,
    /// Paragraph / body text block.
    Text,
}

impl LayoutKind {
    /// Map a raw detection label to a stored kind (`labels.ts` table).
    /// Unmapped labels are dropped by the conversion step.
    pub fn from_label(label: &str) -> Option<Self> {
        let key = label.trim().to_ascii_lowercase();
        Some(match key.as_str() {
            "image" => Self::Image,
            "chart" => Self::Chart,
            "table" => Self::Table,
            "algorithm" => Self::Algorithm,
            "formula" => Self::Formula,
            "formula_number" => Self::FormulaNumber,
            "figure_title" => Self::FigureTitle,
            "header" => Self::Header,
            "abstract" => Self::Abstract,
            "text" | "aside_text" | "content" | "footer" | "footnote" | "number" | "reference"
            | "reference_content" | "seal" | "vision_footnote" => Self::Text,
            "doc_title" | "paragraph_title" => Self::Header,
            _ => return None,
        })
    }

    /// Sidebar "Figures" group (image + chart).
    pub fn is_figure(&self) -> bool {
        matches!(self, Self::Image | Self::Chart)
    }
    pub fn is_table(&self) -> bool {
        matches!(self, Self::Table)
    }
    pub fn is_algorithm(&self) -> bool {
        matches!(self, Self::Algorithm)
    }
    pub fn is_formula(&self) -> bool {
        matches!(self, Self::Formula)
    }
    /// Kinds listed in the Figures rail after the merge.
    pub fn is_sidebar(&self) -> bool {
        self.is_figure() || self.is_table() || self.is_algorithm() || self.is_formula()
    }
    /// Caption candidates merged into nearby hosts (`figure_title` + headers).
    pub fn is_caption(&self) -> bool {
        matches!(self, Self::FigureTitle | Self::Header)
    }
    /// Kinds whose text is bulk-translated (body, abstract, header, captions).
    pub fn is_translatable(&self) -> bool {
        matches!(
            self,
            Self::Text | Self::Abstract | Self::Header | Self::FigureTitle
        )
    }
    /// NMS group: image + chart compete as one "figure" class.
    pub fn dedupe_group(&self) -> &'static str {
        if self.is_figure() {
            "figure"
        } else {
            match self {
                Self::Table => "table",
                Self::Algorithm => "algorithm",
                Self::Formula => "formula",
                Self::FormulaNumber => "formula_number",
                Self::FigureTitle => "figure_title",
                Self::Header => "header",
                Self::Abstract => "abstract",
                Self::Text => "text",
                Self::Image | Self::Chart => "figure",
            }
        }
    }
    /// Stable string for the `kind` column of the sidebar index.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Table => "table",
            Self::Algorithm => "algorithm",
            Self::Formula => "formula",
            Self::FormulaNumber => "formula_number",
            Self::Chart => "chart",
            Self::FigureTitle => "figure_title",
            Self::Header => "header",
            Self::Abstract => "abstract",
            Self::Text => "text",
        }
    }
}

/// Semantic role of a caption box (desktop `captionRole`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptionRole {
    FigureMain,
    TableMain,
    AlgorithmMain,
    Subpanel,
    Other,
}

impl CaptionRole {
    pub fn host_kind(&self) -> Option<LayoutKind> {
        match self {
            Self::FigureMain => Some(LayoutKind::Image),
            Self::TableMain => Some(LayoutKind::Table),
            Self::AlgorithmMain => Some(LayoutKind::Algorithm),
            Self::Subpanel | Self::Other => None,
        }
    }
}

/// One detected region as stored in `source/layout.json`
/// (**pre-merge**: captions stay separate regions; the sidebar index is built
/// from the merged view).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutRegion {
    pub id: String,
    /// 0-based physical page index.
    pub page_index: u32,
    pub kind: LayoutKind,
    /// Raw provider label (`image`, `text`, `aside_text`, …).
    pub label: String,
    /// Detection confidence 0–1.
    pub score: f64,
    /// Reading order within the page (0-based, top-to-bottom). Integral for
    /// provider detections; the desktop `splitBodyRegionAtParagraphGaps`
    /// writes fractional values (e.g. `2.0005`), so this stays `f64` to keep
    /// desktop-authored sidecars loadable as a cache.
    pub reading_order: f64,
    /// Page geometry in PDF points.
    pub rect: Rect,
    /// Normalized 0–1 page box.
    pub bbox: Rect,
    /// PDF text layer inside this box (body / abstract / caption text).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Caption text attached to a host / own text for a caption region.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Caption box before union into `bbox`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_bbox: Option<Rect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption_role: Option<CaptionRole>,
    /// Caption geometry when the caption sits on another page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption_page_index: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption_bbox: Option<Rect>,
}

impl LayoutRegion {
    /// `bbox`-based intersection-over-union (normalized boxes, same page).
    pub fn bbox_iou(a: &Rect, b: &Rect) -> f64 {
        let inter = Self::bbox_intersection(a, b);
        let union = a.area() + b.area() - inter;
        if union > 0.0 {
            inter / union
        } else {
            0.0
        }
    }

    /// How much of the smaller box is covered by the larger (0–1).
    pub fn bbox_containment(a: &Rect, b: &Rect) -> f64 {
        let inter = Self::bbox_intersection(a, b);
        let smaller = a.area().min(b.area());
        if smaller > 0.0 {
            inter / smaller
        } else {
            0.0
        }
    }

    fn bbox_intersection(a: &Rect, b: &Rect) -> f64 {
        let w = ((a.x + a.w).min(b.x + b.w) - a.x.max(b.x)).max(0.0);
        let h = ((a.y + a.h).min(b.y + b.h) - a.y.max(b.y)).max(0.0);
        w * h
    }
}

/// Sidebar section key (desktop `LayoutIndexSection`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LayoutIndexSection {
    Figure,
    Table,
    Algorithm,
    Formula,
}

impl LayoutIndexSection {
    pub fn of(kind: LayoutKind) -> Self {
        match kind {
            LayoutKind::Image | LayoutKind::Chart => Self::Figure,
            LayoutKind::Table => Self::Table,
            LayoutKind::Algorithm => Self::Algorithm,
            LayoutKind::Formula | LayoutKind::FormulaNumber => Self::Formula,
            // Non-sidebar kinds never reach the index; keep the mapping total.
            LayoutKind::FigureTitle
            | LayoutKind::Header
            | LayoutKind::Abstract
            | LayoutKind::Text => Self::Figure,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Figure => "figure",
            Self::Table => "table",
            Self::Algorithm => "algorithm",
            Self::Formula => "formula",
        }
    }
}

/// One sidebar index item (desktop `LayoutIndexItem`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutIndexItem {
    /// CLI-friendly id (`figure-3`), may gain a `-2` collision suffix.
    pub id: String,
    /// Rebuild key: page + section + title or bbox fingerprint.
    pub stable_key: String,
    pub kind: LayoutKind,
    pub section: LayoutIndexSection,
    /// 1-based page (mark / user convention).
    pub page: u32,
    /// 0-based page index (layout / EmbedPDF).
    pub page_index: u32,
    /// Normalized 0–1 page box.
    pub bbox: Rect,
    pub score: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Post-merge `LayoutRegion.id`.
    pub layout_region_id: String,
}

/// `source` block of `layout.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutSidecarSource {
    /// Producer: `embedpdf-layout` | `paddle-layout` | `mineru-layout`.
    pub mode: String,
    /// ISO-8601 UTC timestamp (`2026-11-18T15:25:11.213Z`).
    pub generated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_layer_extracted: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub figure_captions_extracted: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_styles_extracted: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completeness: Option<LayoutCompleteness>,
}

/// `source/layout.json` payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutSidecar {
    pub schema_version: u32,
    pub source: LayoutSidecarSource,
    pub regions: Vec<LayoutRegion>,
}

/// One page's coverage stats (desktop `LayoutPageStats`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutPageStats {
    pub page_index: u32,
    pub region_count: u32,
    /// Characters found in this page's PDF text layer.
    pub text_chars: u32,
    /// Regions whose kind is bulk-translatable.
    pub translatable_region_count: u32,
    /// Detected text that intentionally stays in the source language.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excluded_text_chars: Option<u32>,
    /// Union-free visual coverage estimate (0–1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visual_area: Option<f64>,
}

/// Content-gap warning (desktop `LayoutCompletenessWarning`); `code` must stay
/// the literal `content-gap` or the desktop parser rejects the sidecar.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutCompletenessWarning {
    pub code: String,
    pub pages: Vec<u32>,
}

/// Verifiable page coverage (desktop `LayoutCompleteness`). Readiness
/// (`assessLayoutReadiness` in the renderer) decides whether the desktop
/// viewer trusts a sidecar: incomplete → re-analyze, warning without a repair
/// attempt → re-analyze, ready → cache hit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutCompleteness {
    pub page_count: u32,
    pub processed_pages: Vec<u32>,
    pub text_layer_complete: bool,
    pub page_stats: Vec<LayoutPageStats>,
    pub warnings: Vec<LayoutCompletenessWarning>,
    pub content_repair_attempted: bool,
}

/// Readiness verdict over a sidecar's [`LayoutCompleteness`] (mirror of the
/// desktop `assessLayoutReadiness`). `None` means the sidecar has no
/// completeness block (legacy / untrusted).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayoutReadiness {
    Ready,
    Warning { needs_content_repair: bool },
    Incomplete,
    Unknown,
}

impl LayoutReadiness {
    /// Whether an existing sidecar can stand in for a re-analysis.
    pub fn blocks_analysis(&self) -> bool {
        match self {
            Self::Ready => true,
            Self::Warning {
                needs_content_repair,
            } => !needs_content_repair,
            Self::Incomplete | Self::Unknown => false,
        }
    }
}

/// Assess a sidecar completeness block like the desktop renderer does.
pub fn assess_readiness(completeness: Option<&LayoutCompleteness>) -> LayoutReadiness {
    let Some(completeness) = completeness else {
        return LayoutReadiness::Unknown;
    };
    let expected: std::collections::HashSet<u32> = (0..completeness.page_count).collect();
    let processed: std::collections::HashSet<u32> =
        completeness.processed_pages.iter().copied().collect();
    let stats: std::collections::HashSet<u32> = completeness
        .page_stats
        .iter()
        .map(|page| page.page_index)
        .collect();
    let missing = expected
        .iter()
        .any(|page| !processed.contains(page) || !stats.contains(page));
    let warning = completeness
        .warnings
        .iter()
        .any(|warning| !warning.pages.is_empty());
    if !completeness.text_layer_complete || missing {
        LayoutReadiness::Incomplete
    } else if warning {
        LayoutReadiness::Warning {
            needs_content_repair: !completeness.content_repair_attempted,
        }
    } else {
        LayoutReadiness::Ready
    }
}
