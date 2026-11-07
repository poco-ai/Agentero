//! Paper discovery sources and recommendations.

#[cfg(feature = "desktop")]
pub mod coolpapers;
pub use agentero_core::features::paper::discovery::discover;
pub use agentero_core::features::paper::discovery::embeddings;
pub use agentero_core::features::paper::discovery::pwc;
pub mod feeds;
#[cfg(feature = "desktop")]
pub mod proxy;
#[cfg(feature = "desktop")]
pub mod recommend;
pub mod scratch;
