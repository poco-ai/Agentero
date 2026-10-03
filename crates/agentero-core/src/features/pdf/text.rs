//! Page-level text extraction for opt-in MCP full-text access (#676).
//!
//! Sits on the same shared PDFium binding as [`super::locate`], so the host
//! needs no extra runtime. Output is bounded per page (`max_chars`, in
//! `char_indices` terms so UTF-8 is never split) to keep connector responses
//! small; clients page through with `pages`.

use crate::error::AppError;

/// One page's extracted text, truncated to the per-page budget.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct PageText {
    /// 1-based page number.
    pub page: u32,
    /// Characters extracted before truncation (PDFium char units).
    pub char_count: usize,
    /// Page text, possibly truncated to `max_chars` chars.
    pub text: String,
}

/// Extracted text for the requested pages of one document.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct PagesText {
    pub pages: Vec<PageText>,
    /// Total page count of the document.
    pub page_count: u32,
}

/// Extract text for `pages` (1-based, deduplicated in given order) or all
/// pages when `None`, truncating each page to `max_chars` characters.
pub fn extract_text(
    pdf: &[u8],
    pages: Option<&[u32]>,
    max_chars: usize,
) -> Result<PagesText, AppError> {
    let lib = liteparse_pdfium::Library::init();
    let doc = lib
        .load_document_from_bytes(pdf, None)
        .map_err(|e| AppError::message(format!("open pdf: {e:?}")))?;
    let page_count = doc.page_count().max(0) as u32;
    if page_count == 0 {
        return Ok(PagesText::default());
    }

    let indices: Vec<u32> = match pages {
        None => (1..=page_count).collect(),
        Some(requested) => {
            let mut seen = std::collections::HashSet::new();
            requested
                .iter()
                .copied()
                .filter(|p| *p >= 1 && *p <= page_count && seen.insert(*p))
                .collect()
        }
    };

    let mut out = PagesText {
        page_count,
        pages: Vec::with_capacity(indices.len()),
    };
    for page_no in indices {
        let page = doc
            .page(i32::try_from(page_no).map_err(|_| AppError::message("page index"))? - 1)
            .map_err(|e| AppError::message(format!("load page {page_no}: {e:?}")))?;
        let text_page = page
            .text()
            .map_err(|e| AppError::message(format!("load text page {page_no}: {e:?}")))?;
        let total = text_page.char_count().max(0) as usize;
        let text = if total > 0 {
            text_page.get_text(0, total as i32)
        } else {
            String::new()
        };
        let truncated: String = if text.chars().count() > max_chars {
            text.chars().take(max_chars).collect()
        } else {
            text
        };
        out.pages.push(PageText {
            page: page_no,
            char_count: total,
            text: truncated,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal single-page PDF with one text object (same construction as
    /// `pdf::locate` tests, kept local because theirs is private).
    fn tiny_pdf(text: &str) -> Vec<u8> {
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

    #[test]
    fn extracts_full_text_of_a_page() {
        let pdf = tiny_pdf("Attention is all you need");
        let out = extract_text(&pdf, None, 10_000).expect("extract");
        assert_eq!(out.page_count, 1);
        assert_eq!(out.pages.len(), 1);
        assert!(out.pages[0].text.contains("Attention is all you need"));
        assert!(out.pages[0].char_count > 0);
    }

    #[test]
    fn truncates_to_max_chars_without_panicking_on_utf8() {
        let pdf = tiny_pdf("Attention is all you need");
        let out = extract_text(&pdf, None, 5).expect("extract");
        assert_eq!(out.pages[0].text.chars().count(), 5);
        assert!(out.pages[0].char_count > 5, "reports untruncated count");
    }

    #[test]
    fn filters_and_deduplicates_requested_pages() {
        let pdf = tiny_pdf("x"); // single page
        let out = extract_text(&pdf, Some(&[2, 1, 1, 9]), 100).expect("extract");
        let pages: Vec<u32> = out.pages.iter().map(|p| p.page).collect();
        // pages 2 and 9 are out of range (page_count = 1) and drop out;
        // the duplicate 1 collapses to one entry.
        assert_eq!(pages, vec![1], "out-of-range dropped, dedup kept order");
    }
}
