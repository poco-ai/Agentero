//! Built-in gateway registry. The data lives in `presets.json` next to this
//! module so adding an institution does not require touching Rust or the UI.
//!
//! `protocolVerifiedAt` only records that the entry shape was fingerprinted;
//! it is not a claim that the institution's subscription can fetch a given
//! publisher PDF. Real-account PDF verification is tracked in #848.

use super::kind::InstitutionProxyKind;
use reqwest::Url;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InstitutionProxyPreset {
    pub id: String,
    pub prefix: String,
    /// `ezproxy` | `wengine` | `subdomain` (never `auto`: a preset states its
    /// known shape).
    pub kind: String,
    /// Date the unauthenticated gateway fingerprint was captured (ISO 8601),
    /// or empty when unknown.
    #[serde(default)]
    pub protocol_verified_at: String,
    /// True only after an authorized account downloaded a paywalled PDF.
    #[serde(default)]
    pub subscription_verified: bool,
}

const PRESETS_JSON: &str = include_str!("presets.json");

#[derive(Deserialize)]
struct PresetEntry {
    #[serde(flatten)]
    preset: InstitutionProxyPreset,
    #[serde(rename = "campusProbe")]
    campus_probe: Option<CampusProbe>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CampusProbe {
    pub(super) url: String,
    pub(super) body_marker: String,
}

fn entries() -> Vec<PresetEntry> {
    serde_json::from_str(PRESETS_JSON).unwrap_or_default()
}

/// Parse the embedded registry. The unit test below keeps malformed data from
/// reaching the UI; callers still get an empty list instead of a panic if a
/// release somehow ships broken JSON.
pub fn presets() -> Vec<InstitutionProxyPreset> {
    entries().into_iter().map(|entry| entry.preset).collect()
}

/// Only the configured gateway receives the credential for its campus probe.
pub(super) fn campus_probe(kind: InstitutionProxyKind, prefix: &str) -> Option<CampusProbe> {
    if !matches!(
        kind,
        InstitutionProxyKind::Wengine | InstitutionProxyKind::Auto
    ) {
        return None;
    }
    let gateway = Url::parse(prefix).ok()?;
    entries().into_iter().find_map(|entry| {
        let probe = entry.campus_probe?;
        (entry.preset.kind == "wengine" && Url::parse(&entry.preset.prefix).ok()? == gateway)
            .then_some(probe)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_presets_parse_and_use_known_kinds() {
        let presets = presets();
        assert!(!presets.is_empty());
        assert!(presets.iter().any(|preset| preset.id == "zju"));
        assert!(presets.iter().any(|preset| preset.kind == "subdomain"));
        for preset in &presets {
            assert!(!preset.id.is_empty(), "preset id is required");
            assert!(
                preset.prefix.starts_with("https://"),
                "{} must use an HTTPS gateway",
                preset.id
            );
            assert!(
                matches!(preset.kind.as_str(), "ezproxy" | "wengine" | "subdomain"),
                "{} has unknown kind {}",
                preset.id,
                preset.kind
            );
        }
    }
}
