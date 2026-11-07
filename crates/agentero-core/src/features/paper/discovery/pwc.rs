//! Papers with Code (paperswithcode.co) enrichment for the import pipeline.
//!
//! The 广场 panel embeds the site itself (Host proxy); this module only owns the
//! import-time metadata fill. It runs after a paper is committed and is strictly
//! best-effort: no arXiv id, no catalog record, a network failure, or a 404 all
//! leave the row untouched.
//!
//! Fill policy (empty fields only, never overwrite):
//! - `publication` ← `conference_name` (a confirmed acceptance in the catalog;
//!   absence only means "not catalogued", never "rejected")
//! - `code_repo` ← the official repository with the most stars, unless the user
//!   edited the field by hand (`code_repo_manual`)
//! - `citation_count` ← `citation_count`
//! - `summary` ← `tldr`
//!
//! @see docs/backend/academic-search-apis.md

use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::app_handle::AppHandle;
use crate::error::AppError;
use crate::features::catalog::{papers, CapsCache};
use crate::features::import::{AssetProgressContext, NoteShellMode};
use crate::features::paper::import::paper_import::{
    paper_commit, AssetsPolicy, DedupePolicy, PaperCommitOptions, PaperCommitResult,
};

const API_BASE: &str = "https://paperswithcode.co/api/v1";
const USER_AGENT: &str = concat!(
    "Agentero/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/poco-ai/agentero; mailto:agentero@users.noreply.github.com)"
);
const TIMEOUT: Duration = Duration::from_secs(12);

/// One catalog GET every 600 ms (≈100/min). The public catalog tier sustains
/// 120/min; a batch import would otherwise burst well past it.
const MIN_GAP: Duration = Duration::from_millis(600);

#[derive(Debug, Clone, Deserialize)]
pub struct PwcRepository {
    pub url: String,
    #[serde(default)]
    pub num_stars: i64,
    #[serde(default)]
    pub is_official: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct PwcPaper {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub citation_count: Option<i64>,
    #[serde(default)]
    pub tldr: Option<String>,
    /// Present only when the catalog ingested the paper's conference edition.
    #[serde(default)]
    pub conference_name: Option<String>,
    /// Legacy `"CVPR 2016 6"` / `"Preprint 2023 3"` string; kept for logging.
    #[serde(default)]
    pub proceeding: Option<String>,
    #[serde(default)]
    pub has_official_implementation: bool,
    #[serde(default)]
    pub repositories: Option<Vec<PwcRepository>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct PwcPaperDetail {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub authors: Vec<String>,
    #[serde(default)]
    pub arxiv_id: Option<String>,
    #[serde(default)]
    pub doi: Option<String>,
    #[serde(default, rename = "abstract")]
    pub abstract_text: Option<String>,
    /// `YYYY-MM-DD`.
    #[serde(default)]
    pub published: Option<String>,
    #[serde(default)]
    pub citation_count: Option<i64>,
    #[serde(default)]
    pub tldr: Option<String>,
    #[serde(default)]
    pub conference_name: Option<String>,
    #[serde(default)]
    pub url_pdf: Option<String>,
    #[serde(default)]
    pub url_abs: Option<String>,
    #[serde(default)]
    pub repositories: Option<Vec<PwcRepository>>,
}

/// Normalize an arXiv reference to the bare id the catalog expects.
///
/// PwC answers `400 Invalid ArXiv ID format` for `arXiv:2103.14030` and
/// `2103.14030v2`, so the version suffix and scheme prefix must go first.
pub fn normalize_arxiv_id(raw: &str) -> Option<String> {
    let value = raw.trim();
    let value = value
        .strip_prefix("arXiv:")
        .or_else(|| value.strip_prefix("arxiv:"))
        .unwrap_or(value)
        .trim()
        .trim_end_matches('/');
    // Old-style ids (`hep-th/9901001`) keep their slash; new-style ids end in a
    // version suffix. Only strip `vN` when it follows a digit.
    let value = match value.rfind('v') {
        Some(index)
            if index > 0
                && value[index + 1..].chars().all(|c| c.is_ascii_digit())
                && !value[index + 1..].is_empty()
                && value[..index].ends_with(|c: char| c.is_ascii_digit()) =>
        {
            &value[..index]
        }
        _ => value,
    };
    (!value.is_empty()).then(|| value.to_string())
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// Pick the repository worth storing: an official one, most stars first.
fn best_official_repository(repos: Option<&Vec<PwcRepository>>) -> Option<&str> {
    repos
        .into_iter()
        .flatten()
        .filter(|repo| repo.is_official)
        .max_by_key(|repo| repo.num_stars)
        .map(|repo| repo.url.trim())
        .filter(|url| !url.is_empty())
}

fn best_repository(pwc: &PwcPaper) -> Option<&str> {
    best_official_repository(pwc.repositories.as_ref())
}

/// Apply the empty-field policy. Returns the names of the fields written.
///
/// Pure so the policy is unit-testable without a catalog or a network.
pub fn apply_pwc_metadata(
    record: &mut papers::PaperRecord,
    pwc: &PwcPaper,
    code_repo_manual: bool,
) -> Vec<&'static str> {
    let mut changed = Vec::new();

    if non_empty(record.publication.as_deref()).is_none() {
        if let Some(name) = non_empty(pwc.conference_name.as_deref()) {
            record.publication = Some(name.to_string());
            changed.push("publication");
        }
    }

    if !code_repo_manual && non_empty(record.code_repo.as_deref()).is_none() {
        if let Some(url) = best_repository(pwc) {
            record.code_repo = Some(url.to_string());
            changed.push("code_repo");
        }
    }

    if record.citation_count.is_none() {
        if let Some(count) = pwc.citation_count {
            record.citation_count = Some(count);
            changed.push("citation_count");
        }
    }

    if non_empty(record.summary.as_deref()).is_none() {
        if let Some(tldr) = non_empty(pwc.tldr.as_deref()) {
            record.summary = Some(tldr.to_string());
            changed.push("summary");
        }
    }

    changed
}

async fn throttle() {
    static LAST: OnceLock<tokio::sync::Mutex<Option<Instant>>> = OnceLock::new();
    let mut guard = LAST
        .get_or_init(|| tokio::sync::Mutex::new(None))
        .lock()
        .await;
    if let Some(last) = *guard {
        let elapsed = last.elapsed();
        if elapsed < MIN_GAP {
            tokio::time::sleep(MIN_GAP - elapsed).await;
        }
    }
    *guard = Some(Instant::now());
}

/// Fetch one paper; `None` for an unknown id (PwC answers 400) or an empty body.
async fn fetch_paper(arxiv_id: &str) -> Result<Option<PwcPaper>, AppError> {
    throttle().await;
    fetch_json(&format!(
        "{API_BASE}/papers/arxiv/{}?include_resources=true",
        urlencoding::encode(arxiv_id)
    ))
    .await
}

/// Fetch one catalog paper by its numeric id or arXiv id.
async fn fetch_detail(paper_id: &str) -> Result<Option<PwcPaperDetail>, AppError> {
    throttle().await;
    fetch_json(&format!(
        "{API_BASE}/papers/{}?include_resources=true",
        urlencoding::encode(paper_id)
    ))
    .await
}

/// `None` for a missing paper; the catalog answers 400 for an invalid id.
async fn fetch_json<T: serde::de::DeserializeOwned>(url: &str) -> Result<Option<T>, AppError> {
    let client = crate::http::client_with(TIMEOUT, 3, USER_AGENT)?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| AppError::message(format!("papers with code request: {error}")))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND
        || response.status() == reqwest::StatusCode::BAD_REQUEST
    {
        return Ok(None);
    }
    let response = response
        .error_for_status()
        .map_err(|error| AppError::message(format!("papers with code response: {error}")))?;
    let value = response
        .json()
        .await
        .map_err(|error| AppError::message(format!("papers with code json: {error}")))?;
    Ok(Some(value))
}

/// Build the catalog row for a 广场 import.
///
/// arXiv papers keep the bare arXiv id as the folder id so identifier dedupe
/// and the later enrichment line up. Papers without an arXiv version get
/// `pwc-<catalog id>`; `PaperKind::Pdf` only when there is a PDF to fetch.
pub fn detail_to_record(detail: &PwcPaperDetail) -> papers::PaperRecord {
    let arxiv_id = detail.arxiv_id.as_deref().and_then(normalize_arxiv_id);
    let id = arxiv_id
        .clone()
        .unwrap_or_else(|| format!("pwc-{}", detail.id.trim()));
    let date = non_empty(detail.published.as_deref()).map(str::to_string);
    let year = date
        .as_deref()
        .and_then(|value| value.get(..4))
        .and_then(|value| value.parse::<i32>().ok());
    let pdf_url = arxiv_id
        .as_ref()
        .map(|id| format!("https://arxiv.org/pdf/{id}"))
        .or_else(|| non_empty(detail.url_pdf.as_deref()).map(str::to_string));
    let html_url = arxiv_id
        .as_ref()
        .map(|id| format!("https://arxiv.org/abs/{id}"))
        .or_else(|| non_empty(detail.url_abs.as_deref()).map(str::to_string));
    let paper_type = if arxiv_id.is_some() {
        papers::PaperKind::Arxiv
    } else if pdf_url.is_some() {
        papers::PaperKind::Pdf
    } else {
        papers::PaperKind::Other
    };

    let mut record = papers::PaperRecord::local_pdf(id, detail.title.trim().to_string());
    record.paper_type = paper_type;
    record.authors = detail.authors.clone();
    record.year = year;
    record.date = date;
    record.abstract_text = non_empty(detail.abstract_text.as_deref()).map(str::to_string);
    record.arxiv_id = arxiv_id;
    record.doi = non_empty(detail.doi.as_deref()).map(str::to_string);
    record.publication = non_empty(detail.conference_name.as_deref()).map(str::to_string);
    record.pdf_url = pdf_url;
    record.html_url = html_url;
    record.source_url = Some(format!(
        "https://paperswithcode.co/paper/{}",
        detail.id.trim()
    ));
    record.code_repo = best_official_repository(detail.repositories.as_ref()).map(str::to_string);
    record.citation_count = detail.citation_count;
    record.summary = non_empty(detail.tldr.as_deref()).map(str::to_string);
    record.meta_source = Some("paperswithcode".into());
    record
}

pub struct PwcImportRequest<'a> {
    pub vault: &'a Path,
    pub parent_dir: &'a str,
    /// Numeric catalog id or arXiv id, taken from the `/paper/<id>` URL.
    pub paper_id: &'a str,
    pub app: Option<&'a AppHandle>,
    pub task_id: Option<&'a str>,
    pub note_mode: NoteShellMode,
    pub cache: Option<&'a CapsCache>,
}

/// Import one 广场 row through the same commit pipeline as the 魔棒.
pub async fn import_paper(request: PwcImportRequest<'_>) -> Result<PaperCommitResult, AppError> {
    let paper_id = request.paper_id.trim();
    if paper_id.is_empty() {
        return Err(AppError::message("papers with code id is empty"));
    }
    let detail = fetch_detail(paper_id).await?.ok_or_else(|| {
        AppError::message(format!("paper {paper_id} not found in Papers with Code"))
    })?;
    let record = detail_to_record(&detail);
    paper_commit(
        record,
        PaperCommitOptions {
            vault: request.vault,
            parent_dir: request.parent_dir,
            dedupe: DedupePolicy::ByIdentifiers,
            assets: AssetsPolicy::SyncDownload {
                cookies: None,
                progress: AssetProgressContext {
                    app: request.app,
                    task_id: request.task_id,
                },
            },
            translate_abstract: true,
            note_mode: request.note_mode,
            fresh_timestamps: false,
            cache: request.cache,
            app: request.app,
            defer_parse_jobs: false,
        },
    )
    .await
}

/// Best-effort fill after an import. Errors are logged and swallowed.
pub async fn enrich_from_pwc(vault: &Path, path_rel: &str) {
    if let Err(error) = enrich_from_pwc_inner(vault, path_rel).await {
        log::debug!(
            target: "agentero::import",
            "papers with code enrichment skipped for {path_rel}: {error}"
        );
    }
}

async fn enrich_from_pwc_inner(vault: &Path, path_rel: &str) -> Result<(), AppError> {
    let Some(mut record) = papers::get_by_path(vault, path_rel)? else {
        return Ok(());
    };
    let Some(arxiv_id) = record.arxiv_id.as_deref().and_then(normalize_arxiv_id) else {
        return Ok(());
    };
    let Some(pwc) = fetch_paper(&arxiv_id).await? else {
        return Ok(());
    };
    let manual = papers::code_repo_is_manual(vault, path_rel).unwrap_or(false);
    let changed = apply_pwc_metadata(&mut record, &pwc, manual);
    if changed.is_empty() {
        return Ok(());
    }
    record.updated_at = crate::time::now_rfc3339_millis();
    papers::upsert_paper(vault, &record)?;
    log::info!(
        target: "agentero::import",
        "papers with code enriched {path_rel} ({arxiv_id}): {}",
        changed.join(", ")
    );
    Ok(())
}

/// Fire-and-forget wrapper so an import never waits on the network.
pub fn spawn_enrich(vault: &Path, path_rel: &str) {
    if path_rel.is_empty() {
        return;
    }
    let vault = vault.to_path_buf();
    let path_rel = path_rel.to_string();
    tokio::spawn(async move {
        enrich_from_pwc(&vault, &path_rel).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::catalog::papers::{PaperKind, PaperRecord};

    fn record() -> PaperRecord {
        PaperRecord {
            path: "papers/demo".into(),
            id: "2103.14030".into(),
            paper_type: PaperKind::Arxiv,
            title: "Swin Transformer".into(),
            arxiv_id: Some("2103.14030".into()),
            ..PaperRecord::local_pdf("2103.14030".into(), "Swin".into())
        }
    }

    #[test]
    fn normalizes_prefix_and_version() {
        assert_eq!(
            normalize_arxiv_id("2103.14030v2").as_deref(),
            Some("2103.14030")
        );
        assert_eq!(
            normalize_arxiv_id("arXiv:2103.14030").as_deref(),
            Some("2103.14030")
        );
        assert_eq!(
            normalize_arxiv_id(" 1706.03762 ").as_deref(),
            Some("1706.03762")
        );
        assert_eq!(
            normalize_arxiv_id("hep-th/9901001").as_deref(),
            Some("hep-th/9901001")
        );
        assert_eq!(normalize_arxiv_id("  "), None);
    }

    #[test]
    fn fills_only_empty_fields() {
        let mut row = record();
        row.publication = Some("NeurIPS 2024".into());
        row.citation_count = Some(7);
        let pwc = PwcPaper {
            conference_name: Some("CVPR 2026".into()),
            citation_count: Some(999),
            tldr: Some("A TL;DR".into()),
            repositories: Some(vec![PwcRepository {
                url: "https://github.com/official/repo".into(),
                num_stars: 10,
                is_official: true,
            }]),
            ..Default::default()
        };
        assert_eq!(
            apply_pwc_metadata(&mut row, &pwc, false),
            vec!["code_repo", "summary"]
        );
        assert_eq!(row.publication.as_deref(), Some("NeurIPS 2024"));
        assert_eq!(row.citation_count, Some(7));
        assert_eq!(row.summary.as_deref(), Some("A TL;DR"));
    }

    #[test]
    fn respects_manual_code_repo_and_skips_unofficial_only() {
        let mut row = record();
        let pwc = PwcPaper {
            repositories: Some(vec![PwcRepository {
                url: "https://github.com/someone/fork".into(),
                num_stars: 500,
                is_official: false,
            }]),
            ..Default::default()
        };
        assert!(apply_pwc_metadata(&mut row, &pwc, false).is_empty());

        let mut official = record();
        let pwc = PwcPaper {
            repositories: Some(vec![
                PwcRepository {
                    url: "https://github.com/a/small".into(),
                    num_stars: 1,
                    is_official: true,
                },
                PwcRepository {
                    url: "https://github.com/a/big".into(),
                    num_stars: 900,
                    is_official: true,
                },
            ]),
            ..Default::default()
        };
        assert_eq!(
            apply_pwc_metadata(&mut official, &pwc, true),
            Vec::<&str>::new()
        );
        assert!(official.code_repo.is_none());
    }

    #[test]
    fn builds_an_arxiv_record_from_a_plaza_row() {
        let detail = PwcPaperDetail {
            id: "63638".into(),
            title: " Native and Compact Structured Latents ".into(),
            authors: vec!["Jianfeng Xiang".into()],
            arxiv_id: Some("2512.14692".into()),
            published: Some("2025-12-16".into()),
            citation_count: Some(229),
            tldr: Some("A TL;DR.".into()),
            conference_name: Some("CVPR 2026".into()),
            repositories: Some(vec![PwcRepository {
                url: "https://github.com/microsoft/TRELLIS.2".into(),
                num_stars: 900,
                is_official: true,
            }]),
            ..Default::default()
        };
        let record = detail_to_record(&detail);
        assert_eq!(record.id, "2512.14692");
        assert_eq!(record.paper_type, PaperKind::Arxiv);
        assert_eq!(record.title, "Native and Compact Structured Latents");
        assert_eq!(record.year, Some(2025));
        assert_eq!(record.publication.as_deref(), Some("CVPR 2026"));
        assert_eq!(record.summary.as_deref(), Some("A TL;DR."));
        assert_eq!(
            record.code_repo.as_deref(),
            Some("https://github.com/microsoft/TRELLIS.2")
        );
        assert_eq!(
            record.pdf_url.as_deref(),
            Some("https://arxiv.org/pdf/2512.14692")
        );
        assert_eq!(
            record.source_url.as_deref(),
            Some("https://paperswithcode.co/paper/63638")
        );
    }

    #[test]
    fn builds_an_external_record_without_an_arxiv_version() {
        let detail = PwcPaperDetail {
            id: "131941".into(),
            title: "Introducing Inkling 2 Small".into(),
            published: Some("2026-11-05".into()),
            url_abs: Some("https://thinkingmachines.ai/news/inkling-2-small".into()),
            ..Default::default()
        };
        let record = detail_to_record(&detail);
        assert_eq!(record.id, "pwc-131941");
        assert_eq!(record.paper_type, PaperKind::Other);
        assert!(record.pdf_url.is_none());
        assert_eq!(
            record.html_url.as_deref(),
            Some("https://thinkingmachines.ai/news/inkling-2-small")
        );
    }
}
