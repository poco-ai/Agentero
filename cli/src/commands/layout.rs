//! `agentero layout *` — sidebar-aligned layout index (figures / tables / …).

use crate::error::CliError;
use crate::output::to_value;
use crate::resolve::{resolve_paper, resolve_vault, GlobalOpts};
use crate::style::{format_table, truncate_chars, Style};
use agentero_core::features::layout_index::{self, LayoutIndexItem};
use agentero_core::features::pdf::layout_analyze::{self, AnalyzeLayoutArgs, AnalyzeLayoutOutcome};
use clap::{Subcommand, ValueHint};
use serde_json::{json, Value};

#[derive(Debug, Subcommand)]
pub enum LayoutCmd {
    /// List sidebar-aligned regions (figure / table / algorithm / formula).
    List {
        /// Vault-relative paper path or id.
        #[arg(value_hint = ValueHint::DirPath)]
        r#ref: String,
        /// Filter: figure (image+chart), image, chart, table, algorithm, formula, section, paragraph.
        /// Repeatable; OR semantics.
        #[arg(
            long = "kind",
            value_name = "KIND",
            value_parser = ["figure", "image", "chart", "table", "algorithm", "formula", "section", "paragraph"]
        )]
        kinds: Vec<String>,
        /// Minimum score (0–1). Default: index minScore or 0.3.
        #[arg(long = "min-score", value_name = "N")]
        min_score: Option<f64>,
    },
    /// Get one region by id (CLI id from `layout list`).
    Get {
        /// Vault-relative paper path or id.
        #[arg(value_hint = ValueHint::DirPath)]
        r#ref: String,
        /// Region id or exact anchor from layout list (e.g. figure-3 or '#2.1#p3').
        id: String,
    },
    /// Run headless layout analysis (remote provider) and write both sidecars.
    Analyze {
        /// Vault-relative paper path or id.
        #[arg(value_hint = ValueHint::DirPath)]
        r#ref: String,
        /// Remote provider: paddle (PP-StructureV3) or mineru.
        /// Default: settings.json `layout.backend`.
        #[arg(long = "provider", value_name = "PROVIDER", value_parser = ["paddle", "mineru"])]
        provider: Option<String>,
        /// Re-run even when a complete cached sidecar exists.
        #[arg(long = "force")]
        force: bool,
        /// 1-based pages to keep, e.g. `1-10`, `3`, `1-4,7`.
        /// The provider still processes the whole PDF; only these pages are kept.
        #[arg(long = "pages", value_name = "RANGE")]
        pages: Option<String>,
        /// Provider access token override (defaults to the stored settings key;
        /// prefer `AGENTERO_LAYOUT_API_KEY` on headless machines — the value is
        /// never echoed back).
        #[arg(
            long = "api-key",
            value_name = "KEY",
            env = "AGENTERO_LAYOUT_API_KEY",
            hide_env_values = true
        )]
        api_key: Option<String>,
        /// Provider endpoint override (MinerU cloud relay / self-hosted server).
        #[arg(long = "base-url", value_name = "URL", value_hint = ValueHint::Url)]
        base_url: Option<String>,
        /// Treat `--base-url` as a self-hosted MinerU deployment (MinerU only;
        /// overrides the stored `layout.providerConfigs.mineru.selfHosted`).
        #[arg(long = "self-hosted")]
        self_hosted: bool,
    },
}

pub async fn run(cmd: LayoutCmd, globals: &GlobalOpts) -> Result<Value, CliError> {
    match cmd {
        LayoutCmd::List {
            r#ref,
            kinds,
            min_score,
        } => list(globals, &r#ref, &kinds, min_score),
        LayoutCmd::Get { r#ref, id } => get(globals, &r#ref, &id),
        LayoutCmd::Analyze {
            r#ref,
            provider,
            force,
            pages,
            api_key,
            base_url,
            self_hosted,
        } => {
            analyze(
                globals,
                &r#ref,
                provider,
                force,
                pages,
                api_key,
                base_url,
                self_hosted,
            )
            .await
        }
    }
}

fn list(
    globals: &GlobalOpts,
    ref_: &str,
    kinds: &[String],
    min_score: Option<f64>,
) -> Result<Value, CliError> {
    let vault = resolve_vault(globals)?;
    let paper = resolve_paper(&vault, ref_, globals)?;
    let data = layout_index::list_regions(&vault, &paper.path, kinds, min_score)?;
    let style = globals.style;
    let table_rows: Vec<Vec<String>> = data
        .items
        .iter()
        .map(|i| {
            vec![
                i.id.clone(),
                i.section.clone(),
                i.kind.clone(),
                i.anchor.clone().unwrap_or_default(),
                i.page.to_string(),
                format!("{:.0}%", i.score * 100.0),
                truncate_chars(i.title.as_deref().unwrap_or(""), 48),
            ]
        })
        .collect();
    let lines = if data.items.is_empty() {
        vec![style.dim("(no layout regions)")]
    } else {
        format_table(
            style,
            &["ID", "SECTION", "KIND", "ANCHOR", "PAGE", "SCORE", "TITLE"],
            &table_rows,
        )
    };

    let mut out = to_value(&data)?;
    if let Some(obj) = out.as_object_mut() {
        obj.insert("lines".into(), json!(lines));
    }
    Ok(out)
}

fn get(globals: &GlobalOpts, ref_: &str, id: &str) -> Result<Value, CliError> {
    let vault = resolve_vault(globals)?;
    let paper = resolve_paper(&vault, ref_, globals)?;
    let data = layout_index::get_region(&vault, &paper.path, id.trim())?;
    let item = &data.item;
    let mut lines = vec![format!(
        "{}  {}  page {}  {}  score {:.0}%",
        item.id,
        item.section,
        item.page,
        item.kind,
        item.score * 100.0
    )];
    if let Some(t) = &item.title {
        lines.push(format!("title: {t}"));
    }
    lines.push(format!(
        "bbox: x={:.4} y={:.4} w={:.4} h={:.4}",
        item.bbox.x, item.bbox.y, item.bbox.w, item.bbox.h
    ));

    let mut out = to_value(&data)?;
    if let Some(obj) = out.as_object_mut() {
        obj.insert("lines".into(), json!(lines));
    }
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
async fn analyze(
    globals: &GlobalOpts,
    ref_: &str,
    provider: Option<String>,
    force: bool,
    pages: Option<String>,
    api_key: Option<String>,
    base_url: Option<String>,
    self_hosted: bool,
) -> Result<Value, CliError> {
    // Validate the page selection before any filesystem / network work.
    let pages = match pages.as_deref() {
        Some(raw) => Some(parse_page_range(raw)?),
        None => None,
    };

    let vault = resolve_vault(globals)?;
    let paper = resolve_paper(&vault, ref_, globals)?;

    let mut args = AnalyzeLayoutArgs::new(vault.clone(), paper.path.clone());
    args.provider = provider;
    args.force = force;
    args.pages = pages;
    args.api_key = api_key;
    args.base_url = base_url;
    args.self_hosted = self_hosted.then_some(true);

    // `From<AppError>` keeps domain codes (`layout_pdf_missing`, `usage`, …)
    // and their exit status; everything else becomes a readable business error.
    let outcome = layout_analyze::analyze_paper_layout(args).await?;

    let lines = format_outcome_lines(&paper.path, &outcome, globals.style);
    let mut out = outcome.to_json();
    if let Some(obj) = out.as_object_mut() {
        obj.insert("lines".into(), json!(lines));
    }
    Ok(out)
}

/// One-line human summary of a finished analysis (`cached …` / `analyzed …`).
pub(crate) fn outcome_headline(paper_path: &str, outcome: &AnalyzeLayoutOutcome) -> String {
    if outcome.from_cache {
        format!(
            "cached {} regions ({} figures)",
            outcome.region_count, outcome.index_count
        )
    } else {
        format!(
            "analyzed {paper_path} → {} ({} regions, {} figures, {} pages, {} ms)",
            outcome.provider,
            outcome.region_count,
            outcome.index_count,
            outcome.page_count,
            outcome.elapsed_ms
        )
    }
}

/// Human text lines for one analysis: headline + dim sidecar/index paths.
pub(crate) fn format_outcome_lines(
    paper_path: &str,
    outcome: &AnalyzeLayoutOutcome,
    style: Style,
) -> Vec<String> {
    vec![
        outcome_headline(paper_path, outcome),
        style.dim(&format!(
            "{} · {}",
            outcome.sidecar_path, outcome.index_path
        )),
    ]
}

/// One line for the `import pdf --layout` scan: always names the paper (the
/// cached headline omits it, which is ambiguous in a batch).
pub(crate) fn import_layout_line(paper_path: &str, outcome: &AnalyzeLayoutOutcome) -> String {
    if outcome.from_cache {
        format!(
            "layout: cached {paper_path} ({} regions, {} figures)",
            outcome.region_count, outcome.index_count
        )
    } else {
        format!("layout: {}", outcome_headline(paper_path, outcome))
    }
}

/// Hard cap on one `--pages` selection (guards `1-4294967295`).
const MAX_PAGE_SELECTION: u64 = 10_000;

/// Parse a 1-based page selection into sorted 0-based pages for the core.
///
/// Accepts single pages (`3`), inclusive ranges (`1-10`) and comma lists
/// (`1-4,7`). Pages must be ascending and non-overlapping, so a typo such as
/// `7,1-4` or `5-3` fails instead of silently reordering the caller's intent.
fn parse_page_range(input: &str) -> Result<Vec<u32>, CliError> {
    let input = input.trim();
    if input.is_empty() {
        return Err(CliError::usage(
            "--pages is empty (use e.g. `1-10`, `3`, or `1-4,7`)",
        ));
    }

    let mut pages: Vec<u32> = Vec::new();
    let mut prev_end: Option<u32> = None;
    for segment in input.split(',') {
        let segment = segment.trim();
        if segment.is_empty() {
            return Err(CliError::usage(format!(
                "invalid --pages '{input}': empty segment"
            )));
        }
        let (start, end) = match segment.split_once('-') {
            Some((a, b)) => (
                parse_page_number(a.trim(), input)?,
                parse_page_number(b.trim(), input)?,
            ),
            None => {
                let page = parse_page_number(segment, input)?;
                (page, page)
            }
        };
        if start > end {
            return Err(CliError::usage(format!(
                "invalid --pages '{segment}': start page {start} is after end page {end}"
            )));
        }
        if let Some(prev) = prev_end {
            if start <= prev {
                return Err(CliError::usage(format!(
                    "invalid --pages '{input}': ranges must be ascending and non-overlapping"
                )));
            }
        }
        let count = u64::from(end) - u64::from(start) + 1;
        if pages.len() as u64 + count > MAX_PAGE_SELECTION {
            return Err(CliError::usage(format!(
                "invalid --pages '{input}': selects more than {MAX_PAGE_SELECTION} pages"
            )));
        }
        pages.extend((start..=end).map(|page| page - 1));
        prev_end = Some(end);
    }
    Ok(pages)
}

fn parse_page_number(raw: &str, input: &str) -> Result<u32, CliError> {
    if raw.is_empty() {
        return Err(CliError::usage(format!(
            "invalid --pages '{input}': missing page number"
        )));
    }
    if !raw.bytes().all(|b| b.is_ascii_digit()) {
        return Err(CliError::usage(format!(
            "invalid --pages '{input}': '{raw}' is not a page number"
        )));
    }
    let page: u32 = raw.parse().map_err(|_| {
        CliError::usage(format!(
            "invalid --pages '{input}': page number '{raw}' is too large"
        ))
    })?;
    if page == 0 {
        return Err(CliError::usage(format!(
            "invalid --pages '{input}': pages are 1-based (0 is not a page)"
        )));
    }
    Ok(page)
}

/// Shared by `mark add --region`.
pub fn load_region(
    vault: &std::path::Path,
    paper_path: &str,
    region_id: &str,
) -> Result<LayoutIndexItem, CliError> {
    Ok(layout_index::load_region(vault, paper_path, region_id)?)
}
