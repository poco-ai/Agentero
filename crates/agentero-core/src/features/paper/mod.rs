//! Paper domain: catalog metadata, import/discovery, citation analysis, and
//! paper-scoped filesystem operations (tauri-free subset).

pub mod analyze;
pub mod capabilities;
pub mod catalog;
pub mod discovery;
pub mod import;
pub mod notes;
pub mod reading;
pub mod scholar_api;
pub(crate) mod util;
pub mod venue;
