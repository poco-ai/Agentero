//! Capability-based traits for scholarly HTTP services.

use async_trait::async_trait;
use serde_json::Value;

use crate::scholar_api::{
    ApiCapability, ApiError, ApiPaper, ApiQuery, VenueIdentifiers, VenueMetrics,
};

/// Abstracts a service that can return paper metadata candidates.
#[async_trait]
pub trait AcademicApi: Send + Sync {
    /// Machine-readable source name, e.g. `"s2"`, `"crossref"`, `"arxiv"`.
    fn name(&self) -> &'static str;

    /// Capabilities advertised by this source.
    fn capabilities(&self) -> ApiCapability;

    /// Whether this source can handle `query`. The default implementation maps
    /// query variants to capability flags.
    fn supports(&self, query: &ApiQuery) -> bool {
        let caps = self.capabilities();
        match query {
            ApiQuery::Title(_) => caps.contains(ApiCapability::SEARCH_BY_TITLE),
            ApiQuery::Doi(_) => caps.contains(ApiCapability::FETCH_BY_DOI),
            ApiQuery::ArxivId(_) => caps.contains(ApiCapability::FETCH_BY_ARXIV),
            ApiQuery::Url(_) => caps.contains(ApiCapability::FETCH_BY_URL),
            ApiQuery::Isbn(_) => caps.contains(ApiCapability::FETCH_BY_ISBN),
            ApiQuery::Pmid(_) => caps.contains(ApiCapability::FETCH_BY_PMID),
        }
    }

    /// Fetch candidates for `query`.
    ///
    /// Returns a `Vec` so that single-result lookups (DOI/arXiv) and
    /// multi-result title searches share the same interface. A service that
    /// cannot satisfy a supported query should return an empty vector rather
    /// than an error when the upstream simply has no record.
    async fn fetch(&self, query: &ApiQuery) -> Result<Vec<ApiPaper>, ApiError>;
}

/// Abstracts a service that can return journal/venue metrics and rankings.
#[async_trait]
pub trait VenueMetricsSource: Send + Sync {
    fn name(&self) -> &'static str;

    /// Whether this source can look up metrics for the given venue.
    /// `identifiers` may be empty if only the name is known.
    fn supports(&self, venue: &str, identifiers: &VenueIdentifiers) -> bool;

    /// Fetch metrics for a venue/publication.
    async fn fetch_metrics(
        &self,
        venue: &str,
        identifiers: &VenueIdentifiers,
    ) -> Result<VenueMetrics, ApiError>;
}

/// Abstracts a service that can resolve an open-access PDF URL.
#[async_trait]
pub trait PdfUrlSource: Send + Sync {
    fn name(&self) -> &'static str;

    /// Resolve a direct PDF URL for the given query, if available.
    /// Returns `Ok(None)` when the service has no OA record.
    async fn pdf_url(&self, query: &ApiQuery) -> Result<Option<String>, ApiError>;
}

/// Abstracts a service that can import/export bibliography files.
#[async_trait]
pub trait BibliographySource: Send + Sync {
    fn name(&self) -> &'static str;

    /// Parse a bibliography string (BibTeX, RIS, …) into Zotero-shaped items.
    async fn import_items(&self, content: &str) -> Result<Vec<Value>, ApiError>;

    /// Export Zotero-shaped items to a bibliography string.
    async fn export_items(&self, items: &[Value], format: &str) -> Result<String, ApiError>;
}
