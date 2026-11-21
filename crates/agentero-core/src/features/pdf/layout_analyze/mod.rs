//! Headless PDF layout analysis: remote provider → `source/layout.json` +
//! `source/layout-index.json`, the same artifacts the desktop viewer writes.
//!
//! The desktop pipeline runs the provider through the Host
//! (`layout_remote_analyze_pdf`) and then enriches/merges in the renderer
//! (`src/lib/pdf/layout/run-analysis.ts`). Headless callers (CLI
//! `agentero layout analyze`, `import pdf --layout`) have no renderer, so this
//! module reimplements the renderer-independent part in Rust:
//!
//! 1. resolve the provider + credentials from the desktop `settings.json`
//! 2. run the shared [`super::super::super::paper::analyze::layout::hosted`]
//!    engine on the paper PDF
//! 3. convert provider boxes to raw regions ([`convert`])
//! 4. enrich regions with the PDF text layer ([`enrich`])
//! 5. write the raw sidecar ([`sidecar`]) and the sidebar index
//!    ([`crate::features::pdf::layout_sidebar`], which also merges captions)
//!
//! Local ONNX (PP-DocLayoutV3) analysis needs the WebView renderer and stays
//! desktop-only; `--provider` selects a remote engine explicitly.
//!
//! CLI options: `agentero layout analyze --help`.

use crate::error::AppError;
use crate::features::paper::analyze::layout::hosted::engine::{
    engine_for, HostedProviderCredentials, LayoutAnalyzeContext,
};
use crate::features::paper::analyze::layout::hosted::LayoutRemoteAnalyzePdfArgs;
use crate::features::pdf::layout_region::{
    self, LayoutRegion, LAYOUT_INDEX_FILE, LAYOUT_SIDECAR_FILE, LAYOUT_SIDECAR_SCHEMA_VERSION,
};
use base64::Engine;
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Instant;

pub mod convert;
pub mod enrich;
pub mod pdf_text;
pub mod settings;
pub mod sidecar;

/// One headless analyze request (CLI flags resolved by the caller).
#[derive(Debug, Clone, Default)]
pub struct AnalyzeLayoutArgs {
    pub vault: PathBuf,
    /// Vault-relative paper folder (`papers/demo`).
    pub paper_path: String,
    /// Explicit provider id override (`paddle` / `mineru`); `None` uses
    /// `settings.json` → `layout.backend`.
    pub provider: Option<String>,
    /// Access-token override; `None`/masked falls back to `settings.json`.
    pub api_key: Option<String>,
    /// Endpoint override (MinerU cloud relay / self-hosted server).
    pub base_url: Option<String>,
    /// MinerU `selfHosted` override: `Some` wins over the stored switch.
    pub self_hosted: Option<bool>,
    /// Re-run even when a complete cached sidecar exists.
    pub force: bool,
    /// Keep only these 0-based pages (provider still sees the whole PDF).
    /// `None` analyzes every page.
    pub pages: Option<Vec<u32>>,
}

impl AnalyzeLayoutArgs {
    pub fn new(vault: impl Into<PathBuf>, paper_path: impl Into<String>) -> Self {
        Self {
            vault: vault.into(),
            paper_path: paper_path.into(),
            ..Default::default()
        }
    }
}

/// Structured analyze result (rendered by the CLI's `--json`).
#[derive(Debug, Clone, Default)]
pub struct AnalyzeLayoutOutcome {
    /// Provider id that produced the regions (`paddle` / `mineru`).
    pub provider: String,
    /// Sidecar `source.mode` (`paddle-layout` / `mineru-layout`).
    pub sidecar_mode: String,
    /// A complete cached sidecar was reused; no provider call was made.
    pub from_cache: bool,
    pub region_count: usize,
    pub index_count: usize,
    pub page_count: u32,
    /// 0-based pages stored in the sidecar.
    pub analyzed_pages: Vec<u32>,
    pub elapsed_ms: u64,
    /// Vault-relative sidecar path.
    pub sidecar_path: String,
    /// Vault-relative sidebar index path.
    pub index_path: String,
}

impl AnalyzeLayoutOutcome {
    /// Flat JSON body for `--json` callers.
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "provider": self.provider,
            "sidecarMode": self.sidecar_mode,
            "fromCache": self.from_cache,
            "regionCount": self.region_count,
            "indexCount": self.index_count,
            "pageCount": self.page_count,
            "analyzedPages": self.analyzed_pages,
            "elapsedMs": self.elapsed_ms,
            "sidecarPath": self.sidecar_path,
            "indexPath": self.index_path,
        })
    }
}

/// Analyze one paper folder and write both layout sidecars.
///
/// Cache policy mirrors the desktop `layoutSidecarBlocksAnalysis`: a sidecar
/// whose completeness is `ready` (or `warning` after a content repair) is
/// reused unless `force` is set. A missing PDF / unconfigured provider is an
/// error with a readable message, never a silent skip.
pub async fn analyze_paper_layout(
    args: AnalyzeLayoutArgs,
) -> Result<AnalyzeLayoutOutcome, AppError> {
    let started = Instant::now();
    let paper_dir = paper_dir(&args.vault, &args.paper_path)?;
    let paper_label = args.paper_path.trim_matches(['/', '\\']);
    let sidecar_rel = vault_rel_path(paper_label, LAYOUT_SIDECAR_FILE);
    let index_rel = vault_rel_path(paper_label, LAYOUT_INDEX_FILE);

    // Cache hit: a complete sidecar already exists and `force` is unset.
    if !args.force {
        if let Some(cached) = sidecar::read_layout_sidecar(&paper_dir) {
            if cached.schema_version == LAYOUT_SIDECAR_SCHEMA_VERSION {
                let readiness =
                    layout_region::assess_readiness(cached.source.completeness.as_ref());
                if readiness.blocks_analysis() {
                    let index_count = match rebuild_index_if_stale(&paper_dir, &cached) {
                        Ok(count) => count,
                        Err(error) => {
                            // The sidecar is still valid; the CLI can rebuild
                            // the index on the next run.
                            log::warn!(
                                target: "agentero::layout_analyze",
                                "layout index rebuild failed for {paper_label}: {error}"
                            );
                            0
                        }
                    };
                    let page_count = cached
                        .source
                        .completeness
                        .as_ref()
                        .map(|completeness| completeness.page_count)
                        .filter(|count| *count > 0)
                        .unwrap_or_else(|| pages_from_regions(&cached.regions));
                    let analyzed_pages = cached
                        .source
                        .completeness
                        .as_ref()
                        .map(|completeness| sorted_pages(&completeness.processed_pages))
                        .unwrap_or_else(|| sorted_pages(&pages_from_region_list(&cached.regions)));
                    return Ok(AnalyzeLayoutOutcome {
                        provider: provider_for_mode(&cached.source.mode).to_string(),
                        sidecar_mode: cached.source.mode.clone(),
                        from_cache: true,
                        region_count: cached.regions.len(),
                        index_count,
                        page_count,
                        analyzed_pages,
                        elapsed_ms: started.elapsed().as_millis() as u64,
                        sidecar_path: sidecar_rel,
                        index_path: index_rel,
                    });
                }
            }
        }
    }

    // Fresh analysis: resolve provider + credentials (settings.json unless the
    // CLI overrides the key/base URL).
    let provider_settings = settings::resolve_provider_settings(
        args.provider.as_deref(),
        args.api_key.as_deref(),
        args.base_url.as_deref(),
        args.self_hosted,
    )?;
    let engine = engine_for(&provider_settings.provider).ok_or_else(|| {
        AppError::domain(
            "layout_provider_unknown",
            format!(
                "unknown layout provider: {} (expected paddle|mineru)",
                provider_settings.provider
            ),
        )
    })?;
    let pdf_path =
        crate::features::paper::capabilities::find_local_pdf(&paper_dir).ok_or_else(|| {
            AppError::domain(
                "layout_pdf_missing",
                format!("{paper_label} has no local PDF; import one first"),
            )
        })?;
    let pdf_bytes = std::fs::read(&pdf_path)
        .map_err(|error| AppError::message(format!("read pdf {}: {error}", pdf_path.display())))?;
    let pages = pdf_text::read_pdf_pages(&pdf_bytes)?;
    let page_count = pages.len() as u32;
    if page_count == 0 {
        return Err(AppError::domain(
            "layout_pdf_empty",
            format!("{paper_label} PDF has no pages"),
        ));
    }

    // 0-based page selection; validate against the real page count.
    if let Some(requested) = &args.pages {
        if let Some(out_of_range) = requested.iter().find(|page| **page >= page_count) {
            return Err(AppError::domain(
                "layout_pages_invalid",
                format!(
                    "page {} is out of range; valid pages are 1-{}",
                    out_of_range + 1,
                    page_count
                ),
            ));
        }
    }
    let selected_pages: Vec<u32> = match &args.pages {
        Some(requested) => requested
            .iter()
            .copied()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        None => (0..page_count).collect(),
    };

    let pdf_base64 = base64::engine::general_purpose::STANDARD.encode(&pdf_bytes);
    let file_name = pdf_path
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string);
    let request_id = uuid::Uuid::new_v4().to_string();
    log::info!(
        target: "agentero::layout_analyze",
        "layout analyze provider={} pages={} request_id={request_id}",
        provider_settings.provider,
        page_count,
    );

    let context = LayoutAnalyzeContext {
        app: crate::app_handle::AppHandle::headless(),
        credentials: HostedProviderCredentials {
            api_key: provider_settings.api_key.clone(),
            base_url: provider_settings.base_url.clone(),
            language: provider_settings.language.clone(),
            is_ocr: provider_settings.is_ocr,
            self_hosted: provider_settings.self_hosted,
        },
        args: LayoutRemoteAnalyzePdfArgs {
            pdf_base64,
            file_name,
            // The secret travels in credentials, never in Debug-derivable args.
            api_key: None,
            request_id: Some(request_id),
            provider: Some(provider_settings.provider.clone()),
        },
    };
    let result = engine.analyze_pdf(context).await?;
    if result.pages.len() as u32 != page_count {
        return Err(AppError::domain(
            "layout_provider_pages",
            format!(
                "layout provider returned {}/{} pages",
                result.pages.len(),
                page_count
            ),
        ));
    }

    // Page sizes in PDF points for the provider→region coordinate conversion.
    let page_sizes: Vec<Option<(f32, f32)>> = (0..page_count as usize)
        .map(|index| {
            pages
                .get(index)
                .map(|page| {
                    if page.width > 0.0 && page.height > 0.0 {
                        Some((page.width, page.height))
                    } else {
                        None
                    }
                })
                .unwrap_or(None)
        })
        .collect();

    let mut regions =
        convert::regions_from_pages(&result.pages, &page_sizes, &provider_settings.provider);
    if args.pages.is_some() {
        let keep: BTreeSet<u32> = selected_pages.iter().copied().collect();
        regions.retain(|region| keep.contains(&region.page_index));
    }
    // Enrich only the pages that stay in the sidecar: the completeness block
    // records exactly those as processed and marks the run incomplete.
    let selected_page_text: Vec<pdf_text::PageText> = pages
        .into_iter()
        .filter(|page| selected_pages.contains(&page.index))
        .collect();
    let (regions, completeness) = enrich::enrich_regions(regions, &selected_page_text, page_count);

    let generated_at = sidecar::iso_now();
    sidecar::write_layout_sidecar(
        &paper_dir,
        &regions,
        &provider_settings.sidecar_mode,
        &generated_at,
        &completeness,
    )?;
    // The CLI contract is both artifacts; an index failure must surface.
    let index_count = crate::features::pdf::layout_sidebar::write_layout_index(
        &paper_dir,
        &regions,
        &generated_at,
    )
    .map_err(|error| AppError::message(format!("write layout index for {paper_label}: {error}")))?;

    Ok(AnalyzeLayoutOutcome {
        provider: engine.id().to_string(),
        sidecar_mode: provider_settings.sidecar_mode.clone(),
        from_cache: false,
        region_count: regions.len(),
        index_count,
        page_count,
        analyzed_pages: selected_pages,
        elapsed_ms: started.elapsed().as_millis() as u64,
        sidecar_path: sidecar_rel,
        index_path: index_rel,
    })
}

/// Absolute paper directory inside `vault` (validated).
pub fn paper_dir(vault: &std::path::Path, paper_path: &str) -> Result<PathBuf, AppError> {
    let dir = vault.join(paper_path.trim_matches(['/', '\\']));
    if !dir.is_dir() {
        return Err(AppError::domain(
            "paper_missing",
            format!("paper folder not found: {paper_path}"),
        ));
    }
    Ok(dir)
}

/// Vault-relative artifact path (`papers/demo/source/layout.json`).
fn vault_rel_path(paper_label: &str, file_name: &str) -> String {
    format!("{paper_label}/source/{file_name}")
}

/// Sidecar `source.mode` → provider id. `embedpdf-layout` is the desktop-only
/// local ONNX producer; a cache hit on it reports `local` so callers can tell
/// "already analyzed in the app" from "unknown producer".
fn provider_for_mode(mode: &str) -> &'static str {
    match mode {
        "paddle-layout" => "paddle",
        "mineru-layout" => "mineru",
        "embedpdf-layout" => "local",
        _ => "",
    }
}

/// Reuse the cached regions: rebuild the sidebar index only when it is
/// missing or was generated from a different parse.
///
/// Returns the sidebar item count either way, so a warm cache still reports
/// how many figures/tables the index holds (the CLI renders it as the item
/// count, not as a write counter).
fn rebuild_index_if_stale(
    paper_dir: &Path,
    cached: &crate::features::pdf::layout_region::LayoutSidecar,
) -> Result<usize, AppError> {
    if let Some(items) = current_index_item_count(paper_dir, &cached.source.generated_at) {
        return Ok(items);
    }
    crate::features::pdf::layout_sidebar::write_layout_index(
        paper_dir,
        &cached.regions,
        &cached.source.generated_at,
    )
}

/// Item count of `source/layout-index.json` when it was generated by this
/// parse, `None` when it is missing, stale, or unparseable.
fn current_index_item_count(paper_dir: &Path, generated_at: &str) -> Option<usize> {
    let path = paper_dir.join("source").join(LAYOUT_INDEX_FILE);
    let raw = std::fs::read_to_string(path).ok()?;
    let index = serde_json::from_str::<Value>(&raw).ok()?;
    let matches_parse = index
        .pointer("/source/generatedAt")
        .and_then(Value::as_str)
        .is_some_and(|value| value == generated_at);
    if !matches_parse {
        return None;
    }
    Some(
        index
            .get("items")
            .and_then(Value::as_array)
            .map_or(0, Vec::len),
    )
}

fn sorted_pages(pages: &[u32]) -> Vec<u32> {
    let set: BTreeSet<u32> = pages.iter().copied().collect();
    set.into_iter().collect()
}

fn pages_from_region_list(regions: &[LayoutRegion]) -> Vec<u32> {
    regions.iter().map(|region| region.page_index).collect()
}

fn pages_from_regions(regions: &[LayoutRegion]) -> u32 {
    regions
        .iter()
        .map(|region| region.page_index + 1)
        .max()
        .unwrap_or(0)
}
