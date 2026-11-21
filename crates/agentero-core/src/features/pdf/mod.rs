//! PDF features (tauri-free subset).

/// Use the same bundled library discovery as the isolated parsing worker.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn open_library() -> Result<liteparse_pdfium::Library, crate::error::AppError> {
    use crate::error::AppError;
    super::paper::analyze::parse::ensure_pdfium_loaded()
        .map_err(|message| AppError::domain("pdfium_unavailable", message))?;
    liteparse_pdfium::Library::try_init()
        .map_err(|e| AppError::domain("pdfium_unavailable", e.to_string()))
}

pub mod citation;
mod document_reading_order;
/// Headless layout analysis (remote provider → layout.json / layout-index.json).
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub mod layout_analyze;
pub mod layout_index;
/// Sidecar / index region model shared by headless analysis and the sidebar.
pub mod layout_region;
/// Sidebar index builder (caption merge + NMS + ids).
pub mod layout_sidebar;

/// Minimal one-page PDF with a real xref table, so PDFium loads it without
/// falling back to reconstruction. Shared by the `text` and `locate` tests.
#[cfg(all(test, not(any(target_os = "ios", target_os = "android"))))]
pub(crate) fn tiny_pdf(text: &str) -> Vec<u8> {
    let content = format!("BT /F1 12 Tf 20 60 Td ({text}) Tj ET\n");
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R \
          /Resources << /Font << /F1 5 0 R >> >> >>"
            .to_string(),
        format!(
            "<< /Length {} >>\nstream\n{content}endstream",
            content.len()
        ),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
    ];
    let mut out = String::from("%PDF-1.4\n");
    let mut offsets = Vec::with_capacity(objects.len());
    for (i, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.push_str(&format!("{} 0 obj\n{body}\nendobj\n", i + 1));
    }
    let xref_at = out.len();
    out.push_str(&format!("xref\n0 {}\n", objects.len() + 1));
    out.push_str("0000000000 65535 f \n");
    for offset in &offsets {
        out.push_str(&format!("{offset:010} 00000 n \n"));
    }
    out.push_str(&format!(
        "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n",
        objects.len() + 1
    ));
    out.into_bytes()
}
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub mod github_repo;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub mod locate;
pub mod marks;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub mod text;
