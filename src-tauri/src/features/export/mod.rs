//! Helpers for Markdown note export (desktop).
//!
//! Provides system UI fonts so exported PDFs can embed selectable CJK text.

use crate::core::error::{map_err, ApiResult, AppError};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::command;

/// Candidate TrueType / OpenType fonts with broad CJK coverage.
/// Prefer single-file `.ttf` / `.otf` (pdf-lib does not reliably load `.ttc`).
fn cjk_font_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();

    #[cfg(target_os = "macos")]
    {
        out.extend([
            PathBuf::from("/System/Library/Fonts/Supplemental/Arial Unicode.ttf"),
            PathBuf::from("/Library/Fonts/Arial Unicode.ttf"),
            PathBuf::from("/System/Library/Fonts/Supplemental/Songti.ttc"),
            PathBuf::from("/System/Library/Fonts/PingFang.ttc"),
            PathBuf::from("/System/Library/Fonts/STHeiti Light.ttc"),
            PathBuf::from("/System/Library/Fonts/Hiragino Sans GB.ttc"),
        ]);
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(windir) = std::env::var("WINDIR") {
            let fonts = PathBuf::from(windir).join("Fonts");
            out.extend([
                fonts.join("msyh.ttc"),
                fonts.join("msyh.ttf"),
                fonts.join("simhei.ttf"),
                fonts.join("simsun.ttc"),
                fonts.join("arialuni.ttf"),
                fonts.join("NotoSansSC-Regular.otf"),
            ]);
        }
    }

    #[cfg(target_os = "linux")]
    {
        out.extend([
            PathBuf::from("/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf"),
            PathBuf::from("/usr/share/fonts/truetype/noto/NotoSansSC-Regular.otf"),
            PathBuf::from("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
            PathBuf::from("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"),
            PathBuf::from("/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"),
            PathBuf::from("/usr/share/fonts/truetype/arphic/uming.ttc"),
        ]);
    }

    out
}

fn is_likely_font_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("ttf") | Some("otf") | Some("otc") | Some("ttc")
    )
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFontPayload {
    pub path: String,
    /// Standard base64 of font bytes (JSON-safe; avoid megabyte number arrays).
    pub bytes_base64: String,
}

/// Read a system font suitable for embedding selectable CJK text in PDF export.
#[command]
pub fn export_system_cjk_font() -> ApiResult<ExportFontPayload> {
    let mut last_err: Option<String> = None;
    let mut ordered = cjk_font_candidates();
    ordered.sort_by_key(|p| {
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        match ext.as_str() {
            "ttf" | "otf" => 0u8,
            "ttc" | "otc" => 1,
            _ => 2,
        }
    });

    for path in ordered {
        if !is_likely_font_file(&path) || !path.is_file() {
            continue;
        }
        match fs::read(&path) {
            Ok(bytes) if !bytes.is_empty() => {
                return ApiResult::ok(ExportFontPayload {
                    path: path.to_string_lossy().into_owned(),
                    bytes_base64: STANDARD.encode(bytes),
                });
            }
            Ok(_) => {
                last_err = Some(format!("empty font file: {}", path.display()));
            }
            Err(e) => {
                last_err = Some(format!("{}: {e}", path.display()));
            }
        }
    }

    map_err(AppError::message(format!(
        "No embeddable CJK system font found{}",
        last_err
            .map(|e| format!(" (last error: {e})"))
            .unwrap_or_default()
    )))
}
