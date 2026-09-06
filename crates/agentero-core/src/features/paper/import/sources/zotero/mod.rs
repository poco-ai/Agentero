//! Zotero integration: catalog ↔ bibliography file export/import via the
//! Translator Runtime, and the sync-note codec.
//!
//! Desktop-only parts live in the Host crate (`agentero_lib::features::zotero`):
//! the local-library reader (`db`: `zotero.sqlite` + `storage/` scan &
//! migration) and bidirectional sync (`zotero_sync`), which builds on this
//! feature's [`codec`].
//!
//! Boundary: the Zotero-item → `PaperRecord` mapping (`map_zotero_item_to_record`) and
//! the commit pipeline stay in [`crate::features::import`]; this feature is a
//! consumer of that stable top-level API (same contract as `zotero_sync`,
//! `connector`, `coolpapers`). The Translator `/import` client
//! (`translator_import_items`) also stays in `import` because the remote
//! import bridge needs it without depending on this feature.

pub mod codec;
pub mod io;

pub use io::{
    export_catalog, import_catalog, import_catalog_with_mode, PaperExportArgs, PaperExportResult,
};

pub use crate::features::catalog::papers::ZOTERO_INTERNAL_TAG_PREFIX;
