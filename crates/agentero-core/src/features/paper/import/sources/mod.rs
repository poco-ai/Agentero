//! External bibliography/source integrations used by paper import.
//!
//! Also hosts the per-venue landing-page → PDF-URL resolvers (one file per
//! venue). The Zotero Translator returns these publishers' pages without a
//! PDF attachment (see `discovery::coolpapers::page` for the full list), but
//! each serves its PDFs at a URL that is fully determined by the landing
//! page. [`venue_pdf_url`] dispatches across all of them.
//!
//! Venues deliberately left out: NDSS (PDF file numbers are unrelated to the
//! landing-page slug) and OJS installs such as AAAI (the PDF galley id differs
//! from the article id) — neither has a derivable pattern.

pub mod zotero;

pub mod acl;
pub mod cvf;
pub mod ecva;
pub(crate) mod iclr;
pub mod ijcai;
pub mod neurips;
pub mod openreview;
pub mod pmlr;
pub mod springer;
pub mod usenix;

/// Derive a deterministic PDF URL from a venue landing page.
///
/// Resolvers are mutually exclusive by host, so the order is irrelevant.
/// Returns `None` when no venue matches — callers only invoke this to fill a
/// missing `pdf_url`, never to replace a PDF URL another source provided.
pub fn venue_pdf_url(url: &str) -> Option<String> {
    acl::pdf_url(url)
        .or_else(|| usenix::pdf_url(url))
        .or_else(|| neurips::pdf_url(url))
        .or_else(|| cvf::pdf_url(url))
        .or_else(|| ecva::pdf_url(url))
        .or_else(|| ijcai::pdf_url(url))
        .or_else(|| pmlr::pdf_url(url))
        .or_else(|| openreview::pdf_url(url))
        .or_else(|| springer::pdf_url(url))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatches_each_venue() {
        assert_eq!(
            venue_pdf_url("https://aclanthology.org/2026.acl-long.1248/"),
            Some("https://aclanthology.org/2026.acl-long.1248.pdf".to_string())
        );
        assert_eq!(
            venue_pdf_url("https://www.usenix.org/conference/atc24/presentation/liu-qingyuan"),
            Some("https://www.usenix.org/system/files/atc24-liu-qingyuan.pdf".to_string())
        );
        assert_eq!(
            venue_pdf_url("https://proceedings.mlr.press/v235/abad-rocamora24a.html"),
            Some("https://raw.githubusercontent.com/mlresearch/v235/main/assets/abad-rocamora24a/abad-rocamora24a.pdf".to_string())
        );
        assert_eq!(venue_pdf_url("https://example.com/paper"), None);
    }
}
