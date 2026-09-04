mod cache;
#[cfg(feature = "desktop")]
pub mod commands;
pub mod embed;
pub mod extract;
pub mod frontmatter;
#[cfg(feature = "desktop")]
mod heading_rename;
pub mod index;
pub mod models;
mod notes;
pub mod rename;
pub mod resolve;

pub use index::WikiIndexState;
pub(crate) use notes::append_title_alias_best_effort;
