//! Prepare or refresh a paper’s layout analysis.
use crate::{
    dispatch::{required, string},
    error::CliError,
    resolve::{resolve_paper, resolve_vault, GlobalOpts},
};
use agentero_core::features::pdf::layout_analyze::{self, AnalyzeLayoutArgs, AnalyzeLayoutOutcome};
use serde_json::{json, Value};

pub async fn dispatch(a: &Value, g: &GlobalOpts) -> Result<Value, CliError> {
    let vault = resolve_vault(g)?;
    let paper = resolve_paper(&vault, required(a, "paper")?, g)?;
    let profile = string(a, "profile")
        .map(|name| {
            crate::config::load()?
                .extra
                .get("layout_profiles")
                .and_then(|p| p.get(name))
                .cloned()
                .ok_or_else(|| CliError::usage(format!("unknown layout profile {name}")))
        })
        .transpose()?;
    let field = |key: &str| {
        profile
            .as_ref()
            .and_then(|v| v.get(key))
            .and_then(toml::Value::as_str)
            .map(str::to_owned)
    };
    let mut options = AnalyzeLayoutArgs::new(vault, paper.path.clone());
    options.provider = string(a, "provider")
        .map(str::to_owned)
        .or_else(|| field("provider"));
    options.force = a["refresh"] == true;
    options.pages = string(a, "page")
        .map(agentero_core::features::evidence::parse_pages)
        .transpose()?
        .map(|pages| pages.into_iter().map(|n| n - 1).collect());
    options.api_key = field("api_key").or_else(|| std::env::var("AGENTERO_LAYOUT_API_KEY").ok());
    options.base_url = field("base_url");
    options.self_hosted = profile
        .as_ref()
        .and_then(|v| v.get("self_hosted"))
        .and_then(toml::Value::as_bool);
    let result = layout_analyze::analyze_paper_layout(options).await?;
    Ok(
        json!({"paper":paper.path,"assets":[{"id":"layout","path":result.sidecar_path,"outcome":"available"},{"id":"regions","path":result.index_path,"outcome":"available"}]}),
    )
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
