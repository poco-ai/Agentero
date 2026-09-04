//! Paper analysis: citation refs, PDF layout, and PAPER.md body parse.

pub mod refs;

#[cfg(feature = "desktop")]
pub mod layout;

#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub mod parse;
