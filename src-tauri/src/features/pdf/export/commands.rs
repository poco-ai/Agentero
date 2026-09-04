use crate::core::blocking::run_blocking;
use crate::core::error::{map_err, ApiResult};

use super::{load_system_cjk_font, ExportFontPayload};

/// Read a system font suitable for PDF export and PDFium's local CJK fallback.
///
/// Async + `run_blocking`: reading a multi-megabyte font file must not run on
/// the main thread (Windows UI message pump).
#[tauri::command]
pub async fn export_system_cjk_font() -> ApiResult<ExportFontPayload> {
    run_blocking(|| match load_system_cjk_font() {
        Ok(payload) => ApiResult::ok(payload),
        Err(e) => map_err(e),
    })
    .await
}
