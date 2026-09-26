//! Deferred metadata recognition: PDF probe → identifier resolution → apply.
//!
//! `pdf_recognize` + `apply` form the background two-stage pipeline wired in
//! `job_runners`; `chain_resolve` is the independent synchronous title-driven
//! resolver used by the interactive `paper_resolve_identifier` fallback.

#[cfg(feature = "desktop")]
pub(crate) mod apply;
#[cfg(feature = "desktop")]
pub(crate) mod chain_resolve;
#[cfg(feature = "desktop")]
pub use agentero_core::features::paper::import::recognize::*;
