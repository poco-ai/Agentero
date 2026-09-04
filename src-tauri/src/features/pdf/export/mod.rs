//! Helpers for local system CJK fonts (desktop).
//!
//! Provides system UI font bytes for searchable PDF export and the PDFium
//! viewer's missing-font fallback.

use crate::core::error::AppError;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::fs;
use std::path::{Path, PathBuf};

pub mod commands;

/// Candidate TrueType / OpenType fonts with broad CJK coverage.
///
/// These are deliberately platform-specific: macOS protects some font
/// directories but allows reads from the system locations below, Windows
/// keeps user/system fonts under `%WINDIR%\\Fonts`, and Linux distributions
/// install CJK fonts in several different Noto/WQY/Arphic paths.
/// Prefer single-file `.ttf` / `.otf` (pdf-lib does not reliably load `.ttc`),
/// while keeping collections as a fallback for systems that only ship them.
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
        if let Some(windir) = std::env::var_os("WINDIR").or_else(|| std::env::var_os("SystemRoot"))
        {
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
            PathBuf::from("/usr/share/fonts/opentype/noto/NotoSansSC-Regular.otf"),
            PathBuf::from("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
            PathBuf::from("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"),
            PathBuf::from("/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"),
            PathBuf::from("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"),
            PathBuf::from("/usr/share/fonts/truetype/arphic/uming.ttc"),
            PathBuf::from("/usr/share/fonts/truetype/arphic/ukai.ttc"),
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

/// Reject aliases, broken symlinks, and placeholder files before sending
/// their contents to PDFium. This matters on macOS where an old font alias
/// can have a `.ttf` suffix but contain only a short metadata stub.
fn is_font_data(bytes: &[u8]) -> bool {
    if bytes.len() < 12 {
        return false;
    }
    matches!(
        &bytes[..4],
        [0x00, 0x01, 0x00, 0x00] | b"OTTO" | b"true" | b"typ1" | b"ttcf"
    )
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFontPayload {
    pub path: String,
    /// Standard base64 of font bytes (JSON-safe; avoid megabyte number arrays).
    pub bytes_base64: String,
}

pub(crate) fn load_system_cjk_font() -> Result<ExportFontPayload, AppError> {
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
            Ok(bytes) if is_font_data(&bytes) => {
                return Ok(ExportFontPayload {
                    path: path.to_string_lossy().into_owned(),
                    bytes_base64: STANDARD.encode(bytes),
                });
            }
            Ok(_) => {
                last_err = Some(format!("invalid font file: {}", path.display()));
            }
            Err(e) => {
                last_err = Some(format!("{}: {e}", path.display()));
            }
        }
    }

    Err(AppError::message(format!(
        "No embeddable CJK system font found{}",
        last_err
            .map(|e| format!(" (last error: {e})"))
            .unwrap_or_default()
    )))
}
