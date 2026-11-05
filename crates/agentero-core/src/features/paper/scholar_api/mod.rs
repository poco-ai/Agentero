//! Academic metadata/identifier/metrics API abstraction layer.
//!
//! This module unifies external scholarly HTTP services (Semantic Scholar,
//! Crossref, arXiv, OpenAlex, Unpaywall, Zotero Recognizer, EasyScholar, and
//! the Translator Runtime) behind a small set of capability-based traits.
//!
//! It intentionally depends only on `crate::core` so that `features/import`,
//! `features/refs`, `features/recommend`, and other domains can all use it
//! without creating feature-to-feature cycles.

pub mod client;
pub mod identifiers;
pub mod references;
pub mod scoring;
pub mod search;
pub mod sources;
pub mod traits;
pub mod urls;

use bitflags::bitflags;
use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// Normalized identifier comparison key: trimmed, lowercased, with `-`, `_`
/// and spaces removed (`10.1000/ABC-1` == `10.1000/abc1`).
pub(crate) fn normalize_id(s: &str) -> String {
    s.trim().to_lowercase().replace(['-', '_', ' '], "")
}

/// A normalized query handed to an [`AcademicApi`](traits::AcademicApi) source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApiQuery {
    Title(String),
    Doi(String),
    ArxivId(String),
    Url(String),
    Isbn(String),
    Pmid(String),
}

impl ApiQuery {
    /// Human-readable query kind, useful for logs and error messages.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Title(_) => "title",
            Self::Doi(_) => "doi",
            Self::ArxivId(_) => "arxiv",
            Self::Url(_) => "url",
            Self::Isbn(_) => "isbn",
            Self::Pmid(_) => "pmid",
        }
    }
}

/// External identifiers returned or consumed by academic sources.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperIdentifiers {
    pub doi: Option<String>,
    pub arxiv_id: Option<String>,
    pub isbn: Option<String>,
    pub pmid: Option<String>,
}

/// URLs associated with a paper.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperUrls {
    pub pdf: Option<String>,
    pub html: Option<String>,
    pub landing: Option<String>,
}

/// A unified paper candidate produced by any [`AcademicApi`](traits::AcademicApi)
/// source. It intentionally does **not** contain storage-level fields such as
/// `status` or `added_at`; those belong to
/// [`PaperRecord`](crate::features::catalog::papers::PaperRecord).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiPaper {
    pub identifiers: PaperIdentifiers,
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<i32>,
    pub date: Option<String>,
    pub venue: Option<String>,
    pub volume: Option<String>,
    pub issue: Option<String>,
    pub pages: Option<String>,
    pub publisher: Option<String>,
    #[serde(rename = "abstract")]
    pub abstract_text: Option<String>,
    pub urls: PaperUrls,
    pub citation_count: Option<i64>,
    pub language: Option<String>,
    pub source: &'static str,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
}

bitflags! {
    /// Capabilities advertised by an [`AcademicApi`](traits::AcademicApi) source.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct ApiCapability: u32 {
        /// Free-form title or keyword search.
        const SEARCH_BY_TITLE = 1 << 0;
        /// Metadata lookup by DOI.
        const FETCH_BY_DOI = 1 << 1;
        /// Metadata lookup by arXiv id.
        const FETCH_BY_ARXIV = 1 << 2;
        /// Metadata lookup by ISBN.
        const FETCH_BY_ISBN = 1 << 3;
        /// Metadata lookup by PMID.
        const FETCH_BY_PMID = 1 << 4;
        /// Metadata lookup by arbitrary URL.
        const FETCH_BY_URL = 1 << 5;
        /// Can return an abstract.
        const PROVIDE_ABSTRACT = 1 << 6;
        /// Can return a paper-level citation count.
        const PROVIDE_CITATION_COUNT = 1 << 7;
        /// Can return venue/publication information.
        const PROVIDE_VENUE = 1 << 8;
        /// Can fetch outgoing references for a paper.
        const FETCH_REFERENCES = 1 << 9;
    }
}

/// Errors that can occur inside the `scholar_api` layer.
#[derive(Debug, Clone, thiserror::Error)]
pub enum ApiError {
    #[error("network: {0}")]
    Network(String),
    #[error("parse: {0}")]
    Parse(String),
    #[error("not found")]
    NotFound,
    #[error("rate limited")]
    RateLimited,
    #[error("unsupported query: {0:?}")]
    UnsupportedQuery(ApiQuery),
    #[error("cancelled")]
    Cancelled,
    /// Upstream answered, but the service cannot handle the request right now.
    /// `code` is a provider or CDN code parsed from the body (Cloudflare 1102
    /// is the worker resource-limit page that arrives as HTTP 503).
    #[error("{0}")]
    Unavailable(HttpUnavailable),
    #[error("other: {0}")]
    Other(String),
}

/// HTTP failure that is not a transport error. Display is the diagnosable
/// status line; `detail` keeps a short body snippet for logs.
#[derive(Debug, Clone)]
pub struct HttpUnavailable {
    pub status: u16,
    pub code: Option<u16>,
    pub detail: String,
}

impl std::fmt::Display for HttpUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "HTTP {}", self.status)?;
        if self.status == 503 {
            write!(f, " Service Unavailable")?;
        }
        if let Some(code) = self.code {
            write!(f, ", error code: {code}")?;
        }
        Ok(())
    }
}

impl From<ApiError> for AppError {
    fn from(value: ApiError) -> Self {
        match value {
            // Stable wire code so callers (e.g. PDF recognize) can branch on
            // arXiv / Crossref 429 without string-matching Display text.
            ApiError::RateLimited => AppError::domain("rate_limited", "rate limited"),
            ApiError::Cancelled => AppError::domain("cancelled", "cancelled"),
            ApiError::NotFound => AppError::domain("not_found", "not found"),
            ApiError::Unavailable(err) => AppError::domain("service_unavailable", err.to_string()),
            other => AppError::message(other.to_string()),
        }
    }
}

/// ISSN-style identifiers for a venue/source.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VenueIdentifiers {
    pub issn: Vec<String>,
    pub issn_l: Option<String>,
}

/// A single categorical rank/grade for a venue, e.g. SCI Q1 or CCF-A.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VenueRank {
    pub system: String,
    pub value: String,
    pub category: Option<String>,
}

/// Quantitative and qualitative metrics for a journal or conference.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VenueMetrics {
    pub venue_name: String,
    pub identifiers: VenueIdentifiers,
    pub impact_factor: Option<f64>,
    pub impact_factor_5yr: Option<f64>,
    pub jci: Option<f64>,
    pub h_index: Option<i64>,
    pub i10_index: Option<i64>,
    pub two_year_mean_citedness: Option<f64>,
    pub total_works: Option<i64>,
    pub total_citations: Option<i64>,
    pub ranks: Vec<VenueRank>,
    pub source: &'static str,
    pub source_detail: Option<String>,
}
