//! Identifier resolver table: one [`PaperResolver`] per import source.
//!
//! Adding a source = implement the trait + register it in [`TABLE`]. The
//! table drives detection order ([`PaperResolver::priority`]), the machine
//! kind tag and catalog dedup column ([`ResolvedIdentifier`]) and the
//! Translator Runtime request shaping ([`PaperResolver::translator_target`]).

use super::kind::{ResolvedIdentifier, ADS, ARXIV, DOI, ISBN, PMID, URL};
use super::parsers::{clean_doi, clean_isbn, extract_arxiv_id, regex_ads, regex_pmid};

/// Detection order when probing a text; lower runs first. The table is
/// listed in this order (enforced by `table_is_priority_ordered`).
pub(crate) trait PaperResolver: Send + Sync {
    #[cfg_attr(not(test), allow(dead_code))]
    fn priority(&self) -> u8;
    /// Machine kind tag surfaced to `SkippedImport` and the frontend.
    fn kind(&self) -> &'static str;
    /// Catalog column for batch dedup; `None` skips the lookup.
    fn catalog_column(&self) -> Option<&'static str>;
    /// Recognize the identifier in `text` (already trimmed, non-empty).
    fn extract(&self, text: &str) -> Option<ResolvedIdentifier>;
    /// Translator Runtime request for a resolved value. Default:
    /// `{base}/search` + value.
    fn translator_target(&self, value: &str, base: &str) -> (String, String) {
        (format!("{base}/search"), value.to_string())
    }
}

struct UrlResolver;
impl PaperResolver for UrlResolver {
    fn priority(&self) -> u8 {
        10
    }
    fn kind(&self) -> &'static str {
        URL
    }
    fn catalog_column(&self) -> Option<&'static str> {
        None
    }
    fn extract(&self, text: &str) -> Option<ResolvedIdentifier> {
        (text.starts_with("http://") || text.starts_with("https://")).then(|| ResolvedIdentifier {
            kind: self.kind(),
            value: text.to_string(),
            catalog_column: self.catalog_column(),
        })
    }
    fn translator_target(&self, value: &str, base: &str) -> (String, String) {
        (format!("{base}/web"), value.to_string())
    }
}

struct DoiResolver;
impl PaperResolver for DoiResolver {
    fn priority(&self) -> u8 {
        20
    }
    fn kind(&self) -> &'static str {
        DOI
    }
    fn catalog_column(&self) -> Option<&'static str> {
        Some("doi")
    }
    fn extract(&self, text: &str) -> Option<ResolvedIdentifier> {
        clean_doi(text).map(|value| ResolvedIdentifier {
            kind: self.kind(),
            value,
            catalog_column: self.catalog_column(),
        })
    }
}

struct ArxivResolver;
impl PaperResolver for ArxivResolver {
    fn priority(&self) -> u8 {
        30
    }
    fn kind(&self) -> &'static str {
        ARXIV
    }
    fn catalog_column(&self) -> Option<&'static str> {
        Some("arxiv_id")
    }
    fn extract(&self, text: &str) -> Option<ResolvedIdentifier> {
        extract_arxiv_id(text).map(|value| ResolvedIdentifier {
            kind: self.kind(),
            value,
            catalog_column: self.catalog_column(),
        })
    }
    /// arXiv PDF endpoints are binary resources the Runtime cannot parse as
    /// web pages; every recognized form is canonicalized to its abstract
    /// page (direct IDs and URLs get the same metadata path).
    fn translator_target(&self, value: &str, base: &str) -> (String, String) {
        (
            format!("{base}/web"),
            format!("https://arxiv.org/abs/{value}"),
        )
    }
}

struct IsbnResolver;
impl PaperResolver for IsbnResolver {
    fn priority(&self) -> u8 {
        40
    }
    fn kind(&self) -> &'static str {
        ISBN
    }
    fn catalog_column(&self) -> Option<&'static str> {
        Some("isbn")
    }
    fn extract(&self, text: &str) -> Option<ResolvedIdentifier> {
        clean_isbn(text).map(|value| ResolvedIdentifier {
            kind: self.kind(),
            value,
            catalog_column: self.catalog_column(),
        })
    }
}

struct PmidResolver;
impl PaperResolver for PmidResolver {
    fn priority(&self) -> u8 {
        50
    }
    fn kind(&self) -> &'static str {
        PMID
    }
    fn catalog_column(&self) -> Option<&'static str> {
        Some("pmid")
    }
    fn extract(&self, text: &str) -> Option<ResolvedIdentifier> {
        // PMID: 1–9 digits
        regex_pmid(text).map(|value| ResolvedIdentifier {
            kind: self.kind(),
            value,
            catalog_column: self.catalog_column(),
        })
    }
}

struct AdsResolver;
impl PaperResolver for AdsResolver {
    fn priority(&self) -> u8 {
        60
    }
    fn kind(&self) -> &'static str {
        ADS
    }
    /// ADS bibcodes are folder ids; dedup happens on the primary `id` column.
    fn catalog_column(&self) -> Option<&'static str> {
        Some("id")
    }
    fn extract(&self, text: &str) -> Option<ResolvedIdentifier> {
        regex_ads(text).map(|value| ResolvedIdentifier {
            kind: self.kind(),
            value,
            catalog_column: self.catalog_column(),
        })
    }
}

/// Compile-time static table, listed in [`PaperResolver::priority`] order
/// (guarded by `table_is_priority_ordered`).
const TABLE: &[&dyn PaperResolver] = &[
    &UrlResolver,
    &DoiResolver,
    &ArxivResolver,
    &IsbnResolver,
    &PmidResolver,
    &AdsResolver,
];

pub(crate) fn resolvers() -> &'static [&'static dyn PaperResolver] {
    TABLE
}

/// Look a resolver up by its machine kind tag (e.g. for the arXiv
/// canonicalization that runs ahead of the generic probe).
pub(crate) fn find(kind: &str) -> Option<&'static dyn PaperResolver> {
    resolvers().iter().copied().find(|r| r.kind() == kind)
}

/// Probe `text` against the table in priority order; first hit wins.
pub(crate) fn extract(text: &str) -> Option<ResolvedIdentifier> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    resolvers().iter().find_map(|r| r.extract(t))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_is_priority_ordered_with_unique_kinds() {
        let priorities: Vec<u8> = TABLE.iter().map(|r| r.priority()).collect();
        let mut sorted = priorities.clone();
        sorted.sort_unstable();
        assert_eq!(priorities, sorted, "TABLE must be listed by priority");
        let mut kinds: Vec<_> = TABLE.iter().map(|r| r.kind()).collect();
        let count = kinds.len();
        kinds.sort_unstable();
        kinds.dedup();
        assert_eq!(kinds.len(), count, "kind tags must be unique");
    }

    #[test]
    fn catalog_columns_match_kinds() {
        // ADS bibcode reuses the primary `id` column; URL has no column.
        let cols: Vec<(&str, Option<&'static str>)> = TABLE
            .iter()
            .map(|r| (r.kind(), r.catalog_column()))
            .collect();
        assert_eq!(
            cols,
            vec![
                (URL, None),
                (DOI, Some("doi")),
                (ARXIV, Some("arxiv_id")),
                (ISBN, Some("isbn")),
                (PMID, Some("pmid")),
                (ADS, Some("id")),
            ]
        );
    }

    #[test]
    fn translator_targets_per_kind() {
        let base = "https://t.example";
        assert_eq!(
            find(URL)
                .unwrap()
                .translator_target("https://a.com/p", base),
            (
                "https://t.example/web".to_string(),
                "https://a.com/p".to_string(),
            )
        );
        // Default target: /search + value.
        assert_eq!(
            find(DOI).unwrap().translator_target("10.1038/x", base),
            (
                "https://t.example/search".to_string(),
                "10.1038/x".to_string(),
            )
        );
        assert_eq!(
            find(PMID).unwrap().translator_target("24297125", base),
            (
                "https://t.example/search".to_string(),
                "24297125".to_string(),
            )
        );
        // arXiv canonicalizes every form to the abstract page.
        assert_eq!(
            find(ARXIV).unwrap().translator_target("1706.03762", base),
            (
                "https://t.example/web".to_string(),
                "https://arxiv.org/abs/1706.03762".to_string(),
            )
        );
    }
}
