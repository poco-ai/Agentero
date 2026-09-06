//! Canonical URL derivation for well-known scholarly repositories.

/// Canonical arXiv preview URLs for a bare arXiv id.
pub struct ArxivUrls {
    pub pdf: String,
    pub html: String,
    pub abs: String,
}

/// Build canonical `https://arxiv.org/{pdf,html,abs}` URLs for a bare id.
/// The caller is responsible for stripping any `arXiv:` prefix and version
/// suffix beforehand (see `scholar_api::identifiers::strip_arxiv_version`).
pub fn arxiv_canonical_urls(bare_id: &str) -> ArxivUrls {
    let bare = bare_id.trim();
    ArxivUrls {
        pdf: format!("https://arxiv.org/pdf/{bare}"),
        html: format!("https://arxiv.org/html/{bare}"),
        abs: format!("https://arxiv.org/abs/{bare}"),
    }
}

/// DOI resolver landing page.
pub fn doi_landing_url(doi: &str) -> String {
    format!("https://doi.org/{doi}")
}

/// Derive the canonical ACL Anthology PDF URL from a paper landing page.
/// ACL Anthology paper URLs look like:
///   https://aclanthology.org/2026.acl-long.1248/
/// and the PDF is always:
///   https://aclanthology.org/2026.acl-long.1248.pdf
pub fn acl_anthology_pdf_url(url: &str) -> Option<String> {
    let lower = url.to_ascii_lowercase();
    if !lower.contains("aclanthology.org/") {
        return None;
    }
    // Already a PDF.
    if lower.ends_with(".pdf") {
        return Some(url.trim().to_string());
    }
    let trimmed = url.trim_end_matches('/');
    let slug = trimmed.rsplit('/').next()?;
    // Expect: YYYY.venue-type.number (e.g. 2026.acl-long.1248)
    let parts: Vec<&str> = slug.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    if parts[0].len() != 4 || !parts[0].chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if !parts[1].contains('-') {
        return None;
    }
    if !parts[2].chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(format!("{}.pdf", trimmed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arxiv_canonical_urls_use_bare_id() {
        let urls = arxiv_canonical_urls("1706.03762");
        assert_eq!(urls.pdf, "https://arxiv.org/pdf/1706.03762");
        assert_eq!(urls.html, "https://arxiv.org/html/1706.03762");
        assert_eq!(urls.abs, "https://arxiv.org/abs/1706.03762");
    }

    #[test]
    fn doi_landing_url_is_https_doi_org() {
        assert_eq!(doi_landing_url("10.1/abc"), "https://doi.org/10.1/abc");
    }

    #[test]
    fn acl_anthology_pdf_url_derivation() {
        assert_eq!(
            acl_anthology_pdf_url("https://aclanthology.org/2026.acl-long.1248/"),
            Some("https://aclanthology.org/2026.acl-long.1248.pdf".to_string())
        );
        assert_eq!(
            acl_anthology_pdf_url("https://aclanthology.org/2026.acl-long.1248.pdf"),
            Some("https://aclanthology.org/2026.acl-long.1248.pdf".to_string())
        );
        assert_eq!(
            acl_anthology_pdf_url("https://www.aclanthology.org/2025.emnlp-main.42/"),
            Some("https://www.aclanthology.org/2025.emnlp-main.42.pdf".to_string())
        );
        assert!(acl_anthology_pdf_url("https://aclanthology.org/venues/acl/").is_none());
        assert!(acl_anthology_pdf_url("https://example.com/2026.acl-long.1248/").is_none());
    }
}
