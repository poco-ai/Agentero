//! External integrations: bridge, connector, MCP, remote vault, cloud sync.
//! These depend on the desktop runtime and are not available to the headless CLI.

#[cfg(feature = "desktop")]
pub mod bridge;
#[cfg(feature = "desktop")]
pub mod connector;
#[cfg(feature = "desktop")]
pub mod mcp;
#[cfg(feature = "desktop")]
pub mod remote;
#[cfg(feature = "desktop")]
pub mod sync;
