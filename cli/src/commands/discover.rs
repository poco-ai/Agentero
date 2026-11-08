//! `agentero discover *` — query-first paper discovery.
//!
//! Headless, vault-free: fetch arXiv candidates for a topic/category/date
//! window and rank them with a deterministic lexical scorer. The pipeline
//! (and any external agent) can consume the JSON shortlist directly.

use crate::error::CliError;
use crate::output::to_value;
use crate::resolve::{resolve_vault, GlobalOpts};
use crate::style::{format_table, truncate_chars};
use agentero_core::features::paper::discovery::discover::{
    discover_arxiv, known_arxiv_ids, DiscoverQuery, KeywordMatch, DEFAULT_MAX_CANDIDATES,
    DEFAULT_TOP,
};
use agentero_core::features::paper::discovery::embeddings::EmbeddingConfig;
use clap::Subcommand;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Subcommand)]
pub enum DiscoverCmd {
    /// Rank the day's arXiv submissions for keywords / categories.
    ///
    /// Candidates come from the arXiv Atom API (newest submissions first) and
    /// are scored lexically: a title hit weighs more than an abstract hit.
    /// Provide at least one --keyword or --category.
    Arxiv {
        /// Topic term or phrase (repeatable). e.g. -k agent -k "world model".
        #[arg(short = 'k', long = "keyword", value_name = "TERM")]
        keywords: Vec<String>,
        /// Combine multiple keywords: `all` (AND, default) or `any` (OR).
        /// `any` broadens recall for multi-term radar sweeps (fewer/no hits).
        #[arg(
            long = "match",
            value_name = "MODE",
            default_value = "all",
            value_parser = parse_keyword_match
        )]
        keyword_match: KeywordMatch,
        /// arXiv category (repeatable), e.g. -c cs.AI.
        #[arg(short = 'c', long = "category", value_name = "CAT")]
        categories: Vec<String>,
        /// Only papers submitted on/after this date (YYYY-MM-DD).
        #[arg(long = "since", value_name = "DATE")]
        since: Option<String>,
        /// Only papers submitted on/before this date (YYYY-MM-DD).
        #[arg(long = "until", value_name = "DATE")]
        until: Option<String>,
        /// Shortlist size.
        #[arg(long = "top", value_name = "N", default_value_t = DEFAULT_TOP)]
        top: usize,
        /// Max candidates to fetch before ranking.
        #[arg(long = "max-candidates", value_name = "N", default_value_t = DEFAULT_MAX_CANDIDATES)]
        max_candidates: usize,
        /// Write the full shortlist JSON to this file (creation is idempotent).
        #[arg(long = "out", value_name = "FILE", value_hint = clap::ValueHint::FilePath)]
        out: Option<PathBuf>,
        /// Do not drop papers already in the library catalog.
        #[arg(long = "no-dedup")]
        no_dedup: bool,
        /// OpenAI-compatible embeddings base URL; enables optional semantic
        /// ranking. Key is read from AGENTERO_EMBEDDING_API_KEY.
        #[arg(long = "embed-base", value_name = "URL")]
        embed_base: Option<String>,
        /// Embeddings model id (required with --embed-base).
        #[arg(long = "embed-model", value_name = "MODEL")]
        embed_model: Option<String>,
        /// Cosine weight added to the lexical score (default 1.0).
        #[arg(long = "semantic-weight", value_name = "F")]
        semantic_weight: Option<f32>,
    },
}

pub async fn run(cmd: DiscoverCmd, globals: &GlobalOpts) -> Result<Value, CliError> {
    match cmd {
        DiscoverCmd::Arxiv {
            keywords,
            keyword_match,
            categories,
            since,
            until,
            top,
            max_candidates,
            out,
            no_dedup,
            embed_base,
            embed_model,
            semantic_weight,
        } => {
            run_arxiv(
                globals,
                ArxivInputs {
                    keywords,
                    keyword_match,
                    categories,
                    since,
                    until,
                    top,
                    max_candidates,
                    out,
                    no_dedup,
                    embed_base,
                    embed_model,
                    semantic_weight,
                },
            )
            .await
        }
    }
}

struct ArxivInputs {
    keywords: Vec<String>,
    keyword_match: KeywordMatch,
    categories: Vec<String>,
    since: Option<String>,
    until: Option<String>,
    top: usize,
    max_candidates: usize,
    out: Option<PathBuf>,
    no_dedup: bool,
    embed_base: Option<String>,
    embed_model: Option<String>,
    semantic_weight: Option<f32>,
}

async fn run_arxiv(globals: &GlobalOpts, inputs: ArxivInputs) -> Result<Value, CliError> {
    let query = DiscoverQuery {
        keywords: inputs.keywords,
        keyword_match: inputs.keyword_match,
        categories: inputs.categories,
        since: inputs.since,
        until: inputs.until,
        top: Some(inputs.top),
        max_candidates: Some(inputs.max_candidates),
        semantic_weight: inputs.semantic_weight,
    };
    let exclude = dedup_ids(globals, inputs.no_dedup)?;
    let embedding = embedding_config(inputs.embed_base.as_deref(), inputs.embed_model.as_deref());
    let data = discover_arxiv(&query, &exclude, embedding.as_ref()).await?;

    if let Some(path) = &inputs.out {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }
        fs::write(path, serde_json::to_string_pretty(&data)?)?;
    }

    let rows: Vec<Vec<String>> = data
        .items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            vec![
                (i + 1).to_string(),
                format!("{:.1}", item.score),
                item.arxiv_id.clone(),
                truncate_chars(&item.title, 72),
            ]
        })
        .collect();
    let mut lines = if data.items.is_empty() {
        vec![globals.style.dim("(no candidates)")]
    } else {
        format_table(globals.style, &["#", "SCORE", "arXiv ID", "TITLE"], &rows)
    };
    lines.push(globals.style.dim(&format!(
        "scanned {} · excluded {} · shortlisted {}",
        data.candidates_scanned,
        data.excluded,
        data.items.len()
    )));
    if let Some(err) = &data.semantic_error {
        lines.push(
            globals
                .style
                .dim(&format!("semantic ranking skipped: {err}")),
        );
    }

    let mut out = to_value(&data)?;
    if let Some(obj) = out.as_object_mut() {
        obj.insert("lines".into(), json!(lines));
    }
    Ok(out)
}

/// Parse the `--match` value into [`KeywordMatch`].
///
/// Accepts `any`/`or` (OR) and `all`/`and` (AND) so the flag reads naturally
/// against both spellings.
fn parse_keyword_match(value: &str) -> Result<KeywordMatch, String> {
    match value {
        "any" | "or" => Ok(KeywordMatch::Any),
        "all" | "and" => Ok(KeywordMatch::All),
        other => Err(format!("expected 'any' (OR) or 'all' (AND), got '{other}'")),
    }
}

/// Build an embedding config when both a base URL and a model are given.
/// The key is read from `AGENTERO_EMBEDDING_API_KEY` (never argv, to avoid
/// leaking into the process list).
fn embedding_config(base: Option<&str>, model: Option<&str>) -> Option<EmbeddingConfig> {
    let base = base?.trim();
    let model = model?.trim();
    if base.is_empty() || model.is_empty() {
        return None;
    }
    let api_key = std::env::var("AGENTERO_EMBEDDING_API_KEY")
        .ok()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty());
    Some(EmbeddingConfig {
        base_url: base.to_string(),
        api_key,
        model: model.to_string(),
    })
}

/// Library arXiv ids to drop from the shortlist.
///
/// Discovery is vault-free, so a resolvable vault enables novelty filtering but
/// its absence is not an error — unless the user explicitly passed `--vault`.
fn dedup_ids(globals: &GlobalOpts, no_dedup: bool) -> Result<HashSet<String>, CliError> {
    if no_dedup {
        return Ok(HashSet::new());
    }
    match resolve_vault(globals) {
        Ok(vault) => Ok(known_arxiv_ids(&vault)?),
        Err(err) => {
            if globals.vault_flag.is_some() {
                Err(err)
            } else {
                Ok(HashSet::new())
            }
        }
    }
}
