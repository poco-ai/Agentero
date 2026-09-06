//! Identifier recognition, normalization and source routing for scholarly imports.
//!
//! This module sits above the concrete [`AcademicApi`](crate::features::scholar_api::traits::AcademicApi)
//! sources: it turns a raw user string into a normalized identifier, decides
//! which catalog column to use for dedup, and knows how to shape a Translator
//! Runtime request or fall back to a direct source when the Runtime is down.

pub mod kind;
pub mod parsers;

pub(crate) mod fallback;
pub(crate) mod resolver;

pub use kind::{ResolvedIdentifier, ADS, ARXIV, DOI, ISBN, PMID, URL};
pub use parsers::{
    clean_doi, clean_isbn, extract_arxiv_id, regex_ads, regex_pmid, strip_arxiv_version,
};

pub(crate) use fallback::fetch_direct_fallback;
pub(crate) use resolver::{extract, find};

// Direct-connect fallback fetchers exposed to the desktop host for commands
// that refresh metadata without importing.
pub use fallback::{fetch_arxiv_metadata, fetch_crossref_metadata};
