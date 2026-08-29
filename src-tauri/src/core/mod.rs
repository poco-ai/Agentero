//! Cross-cutting foundations shared by Host features and the headless CLI.

pub mod app_handle;
pub mod background_tasks;
#[cfg(feature = "desktop")]
pub mod blocking;
pub mod error;
pub mod frontmatter;
pub mod fs;
pub mod http;
pub mod install_dirs;
pub mod log_util;
pub mod paths;
pub mod sqlite;
pub mod time;
