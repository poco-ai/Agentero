//! Institution gateway support: gateway kinds, pure rewrites, cookie-aware
//! session fetches, custom-prefix detection, the PDF probe/fetch, and the
//! built-in school registry.
//!
//! Keep app-specific orchestration (settings UI, login webview, asset paths)
//! outside this module so the adapter boundary stays extractable.

mod detect;
mod kind;
mod probe;
mod registry;
mod rewrite;
mod session;

pub use detect::{detect_institution_proxy_kind, resolve_institution_proxy_kind};
pub use kind::{load_institution_proxy_from_settings, set_institution_proxy, InstitutionProxyKind};
pub use probe::{fetch_pdf, probe_institution_proxy, ProxyPdfOutcome};
pub use registry::{presets, InstitutionProxyPreset};
