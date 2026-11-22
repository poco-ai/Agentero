//! Paper domain: catalog metadata, import/discovery, citation analysis, and
//! paper-scoped filesystem operations (tauri-free subset).

pub mod alphaxiv;
pub mod analyze;
pub mod capabilities;
pub mod catalog;
pub mod discovery;
pub mod identity;
pub mod import;
pub mod notes;
pub mod scholar_api;
pub mod source;
pub(crate) mod util;
pub mod venue;
