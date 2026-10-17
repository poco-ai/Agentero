//! `agentero layout *` — sidebar-aligned layout index (figures / tables / …).

use crate::error::CliError;
use crate::output::to_value;
use crate::resolve::{resolve_paper, resolve_vault, GlobalOpts};
use crate::style::{format_table, truncate_chars};
use agentero_core::features::layout_index::{self, LayoutIndexItem};
use clap::{Subcommand, ValueHint};
use serde_json::{json, Value};

#[derive(Debug, Subcommand)]
pub enum LayoutCmd {
    /// Read every layout region of a 1-based physical page (same as MCP page_read).
    Page { r#ref: String, page: u32 },
    /// List sidebar-aligned regions (figure / table / algorithm / formula).
    List {
        /// Vault-relative paper path or id.
        #[arg(value_hint = ValueHint::DirPath)]
        r#ref: String,
        /// Filter: figure (image+chart), image, chart, table, algorithm, formula.
        /// Repeatable; OR semantics.
        #[arg(
            long = "kind",
            value_name = "KIND",
            value_parser = ["figure", "image", "chart", "table", "algorithm", "formula", "section"]
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
        /// Region id (e.g. figure-3).
        id: String,
    },
}

pub fn run(cmd: LayoutCmd, globals: &GlobalOpts) -> Result<Value, CliError> {
    match cmd {
        LayoutCmd::Page { r#ref, page } => {
            let vault = resolve_vault(globals)?;
            let paper = resolve_paper(&vault, &r#ref, globals)?;
            to_value(&agentero_core::features::paper::reading::read_page(
                &vault,
                &paper.path,
                page,
            )?)
        }
        LayoutCmd::List {
            r#ref,
            kinds,
            min_score,
        } => list(globals, &r#ref, &kinds, min_score),
        LayoutCmd::Get { r#ref, id } => get(globals, &r#ref, &id),
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
            &["ID", "SECTION", "KIND", "PAGE", "SCORE", "TITLE"],
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

/// Shared by `mark add --region`.
pub fn load_region(
    vault: &std::path::Path,
    paper_path: &str,
    region_id: &str,
) -> Result<LayoutIndexItem, CliError> {
    Ok(layout_index::load_region(vault, paper_path, region_id)?)
}
