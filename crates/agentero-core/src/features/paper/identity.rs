//! One-level paper identity shared by local and remote listings.
//!
//! [`classify_dir`] sees a single directory (the candidate paper folder). It
//! does not walk children: nested PDF/TeX under `source/` stays in
//! [`super::capabilities::probe_paper_caps`], which skips `attachments/`.
//! A directory named `attachments` is not an identity marker.

use url::Url;

use crate::features::paper::catalog::sidecar::SIDECAR_FILE;

/// Notes file that marks a paper folder.
const NOTES_FILE: &str = "NOTES.md";

/// One directory entry. `name` is the file name only, never a path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedEntry {
    pub name: String,
    pub is_dir: bool,
}

/// Classification of one directory level (the paper folder itself).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaperUnit {
    pub is_paper: bool,
    /// File name of the primary PDF at this level, if any.
    pub primary_pdf_name: Option<String>,
    pub has_tex: bool,
    pub has_paper_md: bool,
}

/// File name that marks a folder as a paper leaf: `NOTES.md` or the catalog sidecar.
///
/// Comparison is ASCII case-insensitive so a case-preserving volume
/// (`notes.md` on macOS or Windows) still matches `Path::join("NOTES.md").is_file()`.
/// Callers must apply it to files; a directory with the same name is not a paper.
pub fn is_paper_marker_file(name: &str) -> bool {
    name.eq_ignore_ascii_case(NOTES_FILE) || name.eq_ignore_ascii_case(SIDECAR_FILE)
}

/// Classify one directory listing. Local `read_dir` and a remote `list` with
/// the same names produce the same [`PaperUnit`].
pub fn classify_dir(entries: &[ListedEntry]) -> PaperUnit {
    let mut is_paper = false;
    let mut has_tex = false;
    let mut has_paper_md = false;
    let mut pdfs: Vec<&str> = Vec::new();

    for entry in entries {
        if entry.is_dir {
            continue;
        }
        if is_paper_marker_file(&entry.name) {
            is_paper = true;
        }
        if entry.name.eq_ignore_ascii_case("PAPER.md") {
            has_paper_md = true;
        }
        if file_ext_eq(&entry.name, "pdf") {
            pdfs.push(entry.name.as_str());
        } else if file_ext_eq(&entry.name, "tex") || file_ext_eq(&entry.name, "ltx") {
            has_tex = true;
        }
    }

    pdfs.sort_unstable();
    PaperUnit {
        is_paper,
        primary_pdf_name: pdfs.first().copied().map(str::to_string),
        has_tex,
        has_paper_md,
    }
}

/// Extension of a file name, compared without treating `\` or `/` as separators.
fn file_ext_eq(name: &str, ext: &str) -> bool {
    let Some((stem, found)) = name.rsplit_once('.') else {
        return false;
    };
    !stem.is_empty() && found.eq_ignore_ascii_case(ext)
}

/// Canonical spelling of a web page URL, for URL-based dedupe of webpage
/// entries (which carry no DOI/arXiv/PMID).
///
/// The `url` crate already lowercases scheme and host and drops default ports.
/// Beyond that, a `#fragment`, a trailing slash, and marketing/tracking query
/// parameters (`utm_*`, `fbclid`, `gclid`) do not change which page a URL
/// points at, so they are normalized away. `http` and `https` stay distinct.
pub fn canonical_page_url(raw: &str) -> Option<String> {
    let mut url = Url::parse(raw.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return None;
    }
    url.set_fragment(None);
    let path = url.path().to_string();
    if path.len() > 1 && path.ends_with('/') {
        url.set_path(path.trim_end_matches('/'));
    }
    if url.query().is_some() {
        let kept: Vec<(String, String)> = url
            .query_pairs()
            .filter(|(key, _)| !is_tracking_query_param(key))
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        url.set_query(None);
        for (key, value) in &kept {
            url.query_pairs_mut().append_pair(key, value);
        }
    }
    Some(url.to_string())
}

/// Query parameters used for campaign/click attribution, never page identity.
fn is_tracking_query_param(key: &str) -> bool {
    matches!(key, "fbclid" | "gclid" | "mc_cid" | "mc_eid" | "ref_src") || key.starts_with("utm_")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str) -> ListedEntry {
        ListedEntry {
            name: name.to_string(),
            is_dir: false,
        }
    }

    fn dir(name: &str) -> ListedEntry {
        ListedEntry {
            name: name.to_string(),
            is_dir: true,
        }
    }

    #[test]
    fn marker_file_names_are_notes_or_sidecar_only() {
        assert!(is_paper_marker_file("NOTES.md"));
        assert!(is_paper_marker_file("notes.md"));
        assert!(is_paper_marker_file(SIDECAR_FILE));
        assert!(is_paper_marker_file("metadata.JSON"));
        for name in ["PAPER.md", "highlights.md", "source", "attachments"] {
            assert!(!is_paper_marker_file(name), "{name}");
        }
    }

    #[test]
    fn notes_or_sidecar_mark_a_paper_body_and_buckets_do_not() {
        assert!(classify_dir(&[file("NOTES.md")]).is_paper);
        assert!(classify_dir(&[file("metadata.json")]).is_paper);
        assert!(classify_dir(&[file("NOTES.md"), file("metadata.json")]).is_paper);

        let body_only = classify_dir(&[file("paper.md")]);
        assert!(!body_only.is_paper);
        assert!(body_only.has_paper_md);

        let buckets = classify_dir(&[
            dir("source"),
            dir("assets"),
            dir("marks"),
            dir("attachments"),
            file("highlights.md"),
        ]);
        assert!(!buckets.is_paper);
        assert!(!buckets.has_paper_md);
        assert!(buckets.primary_pdf_name.is_none());
        assert!(!buckets.has_tex);

        let notes_dir = classify_dir(&[dir("NOTES.md"), dir("metadata.json")]);
        assert!(!notes_dir.is_paper);
    }

    #[test]
    fn root_pdf_and_tex_are_files_at_this_level_only() {
        let unit = classify_dir(&[
            file("b.pdf"),
            file("a.PDF"),
            dir("nested.pdf"),
            file("main.TEX"),
            file("other.ltx"),
            dir("skip.tex"),
            file("PAPER.md"),
        ]);
        assert_eq!(unit.primary_pdf_name.as_deref(), Some("a.PDF"));
        assert!(unit.has_tex);
        assert!(unit.has_paper_md);
        assert!(!unit.is_paper);

        let attachments_only = classify_dir(&[file("NOTES.md"), dir("attachments")]);
        assert!(attachments_only.is_paper);
        assert!(attachments_only.primary_pdf_name.is_none());
        assert!(!attachments_only.has_tex);
    }

    #[test]
    fn same_listing_classifies_once() {
        let entries = [
            file("NOTES.md"),
            file("PAPER.md"),
            file("highlights.md"),
            dir("source"),
            dir("assets"),
            dir("marks"),
            dir("attachments"),
            file("z.pdf"),
            file("a.pdf"),
            file("main.tex"),
        ];
        let first = classify_dir(&entries);
        let second = classify_dir(&entries);
        assert_eq!(first, second);
        assert!(first.is_paper);
        assert!(first.has_paper_md);
        assert!(first.has_tex);
        assert_eq!(first.primary_pdf_name.as_deref(), Some("a.pdf"));
    }

    #[test]
    fn page_urls_canonicalize_away_fragments_case_and_tracking() {
        let canonical = canonical_page_url("https://example.com/notes/post").unwrap();
        for spelling in [
            "https://example.com/notes/post/",
            "https://example.com/notes/post#section-2",
            "HTTPS://Example.COM/notes/post",
            "https://example.com/notes/post?utm_source=rss&fbclid=abc",
            "  https://example.com/notes/post  ",
        ] {
            assert_eq!(
                canonical_page_url(spelling).as_deref(),
                Some(canonical.as_str()),
                "{spelling}"
            );
        }
        // A meaningful query parameter still distinguishes pages…
        assert_ne!(
            canonical_page_url("https://example.com/post?id=1"),
            canonical_page_url("https://example.com/post?id=2")
        );
        // …and http/https stay distinct (redirects are resolved before import).
        assert_ne!(
            canonical_page_url("http://example.com/post"),
            canonical_page_url("https://example.com/post")
        );
        assert_eq!(
            canonical_page_url("https://example.com/").as_deref(),
            Some("https://example.com/")
        );
        assert_eq!(canonical_page_url("not a url"), None);
        assert_eq!(canonical_page_url("ftp://example.com/x"), None);
    }
}
