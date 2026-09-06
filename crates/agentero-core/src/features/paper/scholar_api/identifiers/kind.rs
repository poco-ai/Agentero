//! Identifier kinds and the normalized result of resolving a raw input string.

/// A recognized identifier: machine kind tag (e.g. `SkippedImport.kind`),
/// normalized value, and the catalog column used for batch dedup
/// (`None` → no column lookup).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedIdentifier {
    pub kind: &'static str,
    pub value: String,
    pub catalog_column: Option<&'static str>,
}

pub const URL: &str = "url";
pub const DOI: &str = "doi";
pub const ARXIV: &str = "arxiv";
pub const ISBN: &str = "isbn";
pub const PMID: &str = "pmid";
pub const ADS: &str = "ads";
