//! Domain features (feature-first layout, aligned with frontend `src/lib`).
//!
//! Each submodule owns its service logic and thin `commands` shells.
//! The headless CLI may import non-agent features; BYOA (`agent`) is desktop-only.

#[cfg(feature = "desktop")]
pub mod agent;
#[cfg(feature = "desktop")]
#[path = "agent/install/mod.rs"]
pub mod cli_install;
#[cfg(feature = "desktop")]
pub mod jobs;

#[cfg(feature = "desktop")]
#[path = "layout/layout_model/mod.rs"]
pub mod layout_model;
#[cfg(feature = "desktop")]
#[path = "layout/layout_remote/mod.rs"]
pub mod layout_remote;

pub mod lifecycle;

#[path = "../app/open_request/mod.rs"]
pub mod open_request;

pub mod translate;
pub mod vault;

// Moved into semantic directories while keeping the historical `features::`
// path stable for now. `#[path]` is a temporary shim until the refactor is
// complete and call-sites are migrated.

#[path = "vault/catalog/mod.rs"]
pub mod catalog;
#[path = "vault/doctor/mod.rs"]
pub mod doctor;
#[cfg(feature = "desktop")]
#[path = "pdf/export/mod.rs"]
pub mod export;
#[path = "paper/import/mod.rs"]
pub mod import;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
#[path = "pdf/locate/mod.rs"]
pub mod pdf_locate;
#[path = "paper/analyze/refs/mod.rs"]
pub mod refs;
#[path = "vault/rename/mod.rs"]
pub mod rename;
#[cfg(feature = "desktop")]
#[path = "markdown/search/mod.rs"]
pub mod search;
#[cfg(feature = "desktop")]
#[path = "vault/settings/mod.rs"]
pub mod settings;
#[path = "vault/trash/mod.rs"]
pub mod trash;
#[cfg(feature = "desktop")]
#[path = "vault/watcher/mod.rs"]
pub mod watcher;
#[path = "markdown/wiki/mod.rs"]
pub mod wiki;

#[path = "paper/scholar_api/mod.rs"]
pub mod scholar_api;

// Source/discovery modules physically grouped under `paper/discovery/`
// and `paper/import/` but kept at the historical `features::` level for now.

#[cfg(feature = "desktop")]
#[path = "paper/discovery/arxiv_proxy.rs"]
pub mod arxiv_proxy;
#[cfg(feature = "desktop")]
#[path = "paper/discovery/coolpapers/mod.rs"]
pub mod coolpapers;
#[path = "paper/discovery/feeds/mod.rs"]
pub mod feeds;
#[cfg(feature = "desktop")]
#[path = "paper/discovery/modelscope_proxy.rs"]
pub mod modelscope_proxy;
#[cfg(feature = "desktop")]
#[path = "paper/discovery/recommend/mod.rs"]
pub mod recommend;
#[cfg(feature = "desktop")]
#[path = "paper/import/site_proxy.rs"]
pub mod site_proxy;
#[path = "paper/import/sources/zotero/mod.rs"]
pub mod zotero;
#[cfg(feature = "desktop")]
#[path = "paper/import/sources/zotero_sync/mod.rs"]
pub mod zotero_sync;
