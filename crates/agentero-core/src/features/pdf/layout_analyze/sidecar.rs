//! `{paper}/source/layout.json` read/write for headless analysis.
//!
//! Both directions share [`LayoutSidecar`], whose JSON shape matches the
//! desktop parser (`src/lib/pdf/layout/io.ts`) — a sidecar written here loads
//! in the viewer and vice versa. Writes are atomic (tmp file + rename) so a
//! concurrent desktop read never sees a truncated sidecar.

use crate::error::AppError;
use crate::features::pdf::layout_region::{
    LayoutCompleteness, LayoutRegion, LayoutSidecar, LayoutSidecarSource, LAYOUT_SIDECAR_FILE,
    LAYOUT_SIDECAR_SCHEMA_VERSION,
};
use std::path::{Path, PathBuf};

/// Sidecar path for a paper directory (`{paper}/source/layout.json`).
pub fn sidecar_path(paper_dir: &Path) -> PathBuf {
    paper_dir.join("source").join(LAYOUT_SIDECAR_FILE)
}

/// Read the existing sidecar, if any and if it parses.
pub fn read_layout_sidecar(paper_dir: &Path) -> Option<LayoutSidecar> {
    let raw = std::fs::read_to_string(sidecar_path(paper_dir)).ok()?;
    let sidecar: LayoutSidecar = serde_json::from_str(&raw).ok()?;
    // Only schemaVersion 3 carries the semantics the desktop trusts; older
    // versions are treated as "no cache" exactly like `parseLayoutSidecar`.
    (sidecar.schema_version == LAYOUT_SIDECAR_SCHEMA_VERSION).then_some(sidecar)
}

/// Write the raw sidecar. Returns the absolute path written.
pub fn write_layout_sidecar(
    paper_dir: &Path,
    regions: &[LayoutRegion],
    mode: &str,
    generated_at: &str,
    completeness: &LayoutCompleteness,
) -> Result<PathBuf, AppError> {
    let path = sidecar_path(paper_dir);
    if let Some(source_dir) = path.parent() {
        std::fs::create_dir_all(source_dir)?;
    }
    let sidecar = LayoutSidecar {
        schema_version: LAYOUT_SIDECAR_SCHEMA_VERSION,
        source: LayoutSidecarSource {
            mode: mode.to_string(),
            generated_at: generated_at.to_string(),
            text_layer_extracted: Some(true),
            figure_captions_extracted: Some(true),
            source_styles_extracted: None,
            completeness: Some(completeness.clone()),
        },
        regions: regions.to_vec(),
    };
    // Desktop style: `${JSON.stringify(sidecar, null, 2)}\n`. The shared
    // atomic writer stages through a unique sibling `.tmp` and renames it.
    let mut raw = serde_json::to_string_pretty(&sidecar)?;
    raw.push('\n');
    crate::fs::atomic_write(&path, raw.as_bytes())?;
    Ok(path)
}

/// ISO-8601 UTC timestamp with millis (`2026-11-18T15:25:11.213Z`), the exact
/// shape the desktop writes.
pub fn iso_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
