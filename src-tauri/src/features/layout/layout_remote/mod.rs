//! Remote PDF layout analysis: shared wire types, the progress event, and
//! the provider registry. Engine implementations live in per-provider files
//! (`paddle.rs`, `mineru.rs`); commands dispatch through [`engine::engine_for`].
//!
//! Engines return raw layout detection boxes; coordinate conversion stays in
//! the frontend.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

pub mod commands;
pub mod engine;
pub mod mineru;
pub mod openai_compatible;
pub mod paddle;

/// Cloud-job progress callback: `(phase, extracted_pages, total_pages)`.
pub(crate) type ProgressFn<'a> = &'a (dyn Fn(&str, Option<u64>, Option<u64>) + Send + Sync);
/// Cooperative-cancel check polled between cloud-job phases.
pub(crate) type CancelFn<'a> = &'a (dyn Fn() -> bool + Send + Sync);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutRemoteBox {
    pub cls_id: i64,
    pub label: String,
    pub score: f64,
    /// `[x1, y1, x2, y2]` in rendered-image pixels (top-left origin).
    pub coordinate: [f64; 4],
}

/// Map raw `layout_det_res.boxes` entries into the API shape.
pub fn parse_det_boxes(boxes: &[Value]) -> Vec<LayoutRemoteBox> {
    let mut out = Vec::with_capacity(boxes.len());
    for b in boxes {
        let Some(coordinate) = b.get("coordinate").and_then(Value::as_array) else {
            continue;
        };
        if coordinate.len() != 4 {
            continue;
        }
        let nums: Vec<f64> = coordinate.iter().filter_map(Value::as_f64).collect();
        if nums.len() != 4 {
            continue;
        }
        out.push(LayoutRemoteBox {
            cls_id: b.get("cls_id").and_then(Value::as_i64).unwrap_or(-1),
            label: b
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            score: b.get("score").and_then(Value::as_f64).unwrap_or(0.0),
            coordinate: [nums[0], nums[1], nums[2], nums[3]],
        });
    }
    out
}

/// Progress event consumed by the layout runner for the progress bar.
pub const CLOUD_PROGRESS_EVENT: &str = "layout-remote:progress";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutRemoteAnalyzePdfArgs {
    /// Base64-encoded PDF bytes.
    pub pdf_base64: String,
    /// Upload file name (default `paper.pdf`).
    #[serde(default)]
    pub file_name: Option<String>,
    /// Access-token override (probe flow); normally resolved from settings.
    #[serde(default)]
    pub api_key: Option<String>,
    /// Correlates `layout-remote:progress` when several API jobs run at once.
    #[serde(default)]
    pub request_id: Option<String>,
    /// Remote provider id (defaults to `paddle`).
    #[serde(default)]
    pub provider: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutRemotePageResult {
    pub boxes: Vec<LayoutRemoteBox>,
    /// Page size in the same units as box coordinates (paddle: rendered px,
    /// mineru: PDF points); null makes the frontend assume a 144 DPI render.
    pub width_px: Option<u32>,
    pub height_px: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutRemoteAnalyzePdfResult {
    pub pages: Vec<LayoutRemotePageResult>,
    /// Per-page rendered pixel sizes reported by the service
    /// (`dataInfo.pages[].width/height`); empty when absent.
    pub rendered_pages: Vec<(u32, u32)>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudProgressPayload {
    phase: String,
    extracted_pages: Option<u64>,
    total_pages: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
}

/// Emit one `layout-remote:progress` event (payload shared by all engines).
pub(crate) fn emit_cloud_progress(
    app: &AppHandle,
    phase: &str,
    extracted_pages: Option<u64>,
    total_pages: Option<u64>,
    request_id: Option<String>,
) {
    let _ = app.emit(
        CLOUD_PROGRESS_EVENT,
        CloudProgressPayload {
            phase: phase.to_string(),
            extracted_pages,
            total_pages,
            request_id,
        },
    );
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutRemoteProbeArgs {
    /// Base64-encoded tiny probe image (JPEG).
    pub image_base64: String,
    #[serde(default)]
    pub api_key: Option<String>,
    /// Remote provider id (defaults to `paddle`).
    #[serde(default)]
    pub provider: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutRemoteProbeResult {
    pub job_id: String,
}
