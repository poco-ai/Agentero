//! Headless `AppHandle` shim.
//!
//! Headless (CLI) builds keep emit-style function signatures aligned with the
//! desktop shape by pointing them at this empty stand-in; every event the
//! callers would emit is simply a no-op.

#[cfg(not(feature = "desktop"))]
pub struct AppHandle;
