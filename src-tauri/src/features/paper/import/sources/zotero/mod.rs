//! Zotero integration: local library scan/migration, catalog ↔ bibliography
//! file export/import via the Translator Runtime, and the sync-note codec.
//!
//! Bidirectional sync lives in the sibling [`crate::features::zotero_sync`]
//! feature, which builds on this feature's [`db`] readers and [`codec`].
//!
//! Boundary: the Zotero-item → `PaperMeta` mapping (`map_zotero_item`) and
//! the commit pipeline stay in [`crate::features::import`]; this feature is a
//! consumer of that stable top-level API (same contract as `zotero_sync`,
//! `connector`, `coolpapers`). The Translator `/import` client
//! (`translator_import_items`) also stays in `import` because the remote
//! import bridge needs it without depending on this feature.

pub mod codec;
#[cfg(feature = "desktop")]
pub mod commands;
#[cfg(feature = "desktop")]
pub mod db;
pub mod io;

#[cfg(feature = "desktop")]
pub use db::{
    migrate_zotero, scan_zotero, MigrateProgress, ZoteroMigrateArgs, ZoteroMigrateResult,
    ZoteroScan, ZoteroScanArgs,
};
pub use io::{
    export_catalog, import_catalog, import_catalog_with_mode, PaperExportArgs, PaperExportResult,
};

pub use crate::features::catalog::papers::ZOTERO_INTERNAL_TAG_PREFIX;
