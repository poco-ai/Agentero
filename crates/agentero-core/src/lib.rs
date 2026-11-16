//! Tauri-independent foundations shared by the desktop Host and the headless CLI.
//!
//! Nothing in this crate may depend on `tauri` / `wry` / `tao`; the desktop
//! shell re-exports these modules as `agentero_lib::core::*` so both binaries
//! share one storage/plumbing layer. [`features`] holds the tauri-free domain
//! services (catalog, vault, import, wiki, …), re-exported by the Host as
//! `agentero_lib::features::*`; host-side effects (event emit, job spawns)
//! route through [`app_handle::HostHooks`].

pub mod app_handle;
pub mod blocking;
pub mod cancel;
pub mod decision;
pub mod error;
pub mod features;
pub mod frontmatter;
pub mod fs;
pub mod http;
pub mod install_dirs;
pub mod json;
pub mod log_util;
pub mod ops;
pub mod paths;
pub mod perf;
pub mod process;
pub mod remote;
pub mod sqlite;
pub mod time;
pub mod usage;
