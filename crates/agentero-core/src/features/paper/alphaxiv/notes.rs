use serde::Deserialize;
use uuid::Uuid;

use crate::error::AppError;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperNotes {
    pub body: String,
    pub highlights: Vec<Highlight>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Highlight {
    pub id: Uuid,
    pub body: String,
    pub date: String,
    pub canonical_id: String,
    pub version_label: String,
    #[serde(flatten)]
    pub anchor: HighlightAnchor,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HighlightAnchor {
    Pdf {
        annotation: PdfAnchor,
    },
    Prose {
        target: String,
        annotation: ProseAnchor,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfAnchor {
    pub selected_text: String,
    pub highlight_color: Option<String>,
    pub highlight_rects: Vec<PageRects>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRects {
    pub page_index: i32,
    pub rects: Vec<PdfRect>,
}

#[derive(Deserialize)]
pub struct PdfRect {
    pub x1: f32,
    pub y1: f32,
    pub x2: f32,
    pub y2: f32,
}

#[derive(Deserialize)]
pub struct ProseAnchor {
    pub exact: String,
}

pub async fn fetch_paper_notes(api_key: &str, group: Uuid) -> Result<PaperNotes, AppError> {
    let value = super::get_json(&format!("/papers/v3/groups/{group}/notes"), api_key).await?;
    serde_json::from_value(value).map_err(|_| {
        AppError::domain(
            "alphaxiv_parse",
            "AlphaXiv returned an unsupported notes response",
        )
    })
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub mod import;
