//! Reference (citation) parsing for paper units.
//!
//! Priority: online structured references (Semantic Scholar → Crossref) →
//! local `source/` BibTeX / `.bbl` / inline `thebibliography` fallback.
//! Results persist to the rebuildable sidecar `{paper}/source/agentero-cite.json`.
//!
//! @see docs/backend/citation-parsing.md

pub mod bbl;
pub mod bib;
pub mod citing;
#[cfg(feature = "desktop")]
pub mod commands;
pub mod latex;
pub mod online;

use crate::core::error::AppError;
use crate::features::catalog::papers::{self, PaperRecord};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
#[cfg(feature = "desktop")]
use tauri::Manager;
use tokio::sync::{Mutex, Notify};

pub const SIDECAR_FILE: &str = "agentero-cite.json";
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CiteSidecar {
    pub schema_version: u32,
    pub source: CiteSource,
    pub citations: Vec<Citation>,
    #[serde(default)]
    pub messages: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CiteSource {
    /// Winning pipeline, e.g. `"s2"`, `"bbl"`, `"bbl+s2"`, `"none"`.
    pub mode: String,
    pub generated_at: String,
    /// Input fingerprint; unchanged inputs skip re-parse (and re-fetch).
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Citation {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_key: Option<String>,
    /// In-text marker like `"[12]"` when bibliography order is known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
    pub metadata: CitationMeta,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_match: Option<LocalMatch>,
    /// Where the metadata came from, e.g. `"bbl"`, `"bib"`, `"s2"`, `"bbl+s2"`.
    pub source: String,
    /// `"resolved"` (has title) or `"unresolved"` (raw text only).
    pub status: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CitationMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub authors: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub venue: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arxiv_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMatch {
    /// Vault-relative path of the matched library paper.
    pub paper_path: String,
    /// `"doi"` | `"arxiv"` | `"title"`.
    pub match_by: String,
}

/// Intermediate entry produced by every parser layer before merging.
#[derive(Debug, Clone)]
pub struct RefDraft {
    pub key: Option<String>,
    pub raw: Option<String>,
    pub title: Option<String>,
    pub authors: Vec<String>,
    pub year: Option<i32>,
    pub venue: Option<String>,
    pub doi: Option<String>,
    pub arxiv_id: Option<String>,
    pub url: Option<String>,
    pub source: &'static str,
}

struct PreparedParseRefs {
    vault: PathBuf,
    path_rel: String,
    doi: Option<String>,
    arxiv: Option<String>,
    files: Vec<PathBuf>,
    fingerprint: String,
    sidecar_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ParseRefsKey {
    vault: PathBuf,
    path_rel: String,
    online_enabled: bool,
}

type SharedParseRefsResult = Result<CiteSidecar, String>;

struct ParseRefsWaiter {
    result: Mutex<Option<SharedParseRefsResult>>,
    notify: Notify,
}

impl ParseRefsWaiter {
    fn new() -> Self {
        Self {
            result: Mutex::new(None),
            notify: Notify::new(),
        }
    }

    async fn wait(&self) -> SharedParseRefsResult {
        loop {
            let notified = self.notify.notified();
            if let Some(result) = self.result.lock().await.clone() {
                return result;
            }
            notified.await;
        }
    }
}

struct ParseRefsInflight {
    entries: Mutex<HashMap<ParseRefsKey, Arc<ParseRefsWaiter>>>,
}

fn refs_inflight() -> &'static ParseRefsInflight {
    static INFLIGHT: OnceLock<ParseRefsInflight> = OnceLock::new();
    INFLIGHT.get_or_init(|| ParseRefsInflight {
        entries: Mutex::new(HashMap::new()),
    })
}

/// Parse references for one paper folder and persist the sidecar.
/// Never fails on "no references found" — that is an empty, valid sidecar.
pub async fn parse_paper_refs(
    vault: &Path,
    path_raw: &str,
    online_enabled: bool,
    force: bool,
) -> Result<CiteSidecar, AppError> {
    let prepared = prepare_parse_refs(vault, path_raw, online_enabled)?;
    if !force {
        if let Some(existing) = read_sidecar(&prepared.sidecar_path) {
            if existing.schema_version == SCHEMA_VERSION
                && existing.source.fingerprint == prepared.fingerprint
            {
                return Ok(existing);
            }
        }
    }

    let key = ParseRefsKey {
        vault: prepared.vault.clone(),
        path_rel: prepared.path_rel.clone(),
        online_enabled,
    };
    run_parse_refs_singleflight(key, prepared, online_enabled).await
}

fn prepare_parse_refs(
    vault: &Path,
    path_raw: &str,
    online_enabled: bool,
) -> Result<PreparedParseRefs, AppError> {
    let path_rel = crate::core::fs::sanitize_vault_rel(path_raw)
        .map_err(|_| AppError::message("invalid paper path"))?;
    let paper_dir = vault.join(&path_rel);
    if !paper_dir.is_dir() {
        return Err(AppError::message("paper folder not found"));
    }
    let record = papers::get_by_path(vault, &path_rel).ok().flatten();
    let doi = record
        .as_ref()
        .and_then(|r| r.doi.clone())
        .filter(|s| !s.trim().is_empty());
    let arxiv = record
        .as_ref()
        .and_then(|r| r.arxiv_id.clone())
        .filter(|s| !s.trim().is_empty());

    let files = collect_ref_files(&paper_dir);
    let fingerprint = fingerprint(doi.as_deref(), arxiv.as_deref(), online_enabled, &files);
    let sidecar_path = paper_dir.join("source").join(SIDECAR_FILE);
    Ok(PreparedParseRefs {
        vault: vault.to_path_buf(),
        path_rel,
        doi,
        arxiv,
        files,
        fingerprint,
        sidecar_path,
    })
}

async fn run_parse_refs_singleflight(
    key: ParseRefsKey,
    prepared: PreparedParseRefs,
    online_enabled: bool,
) -> Result<CiteSidecar, AppError> {
    let (waiter, should_run) = {
        let inflight = refs_inflight();
        let mut entries = inflight.entries.lock().await;
        if let Some(existing) = entries.get(&key) {
            (existing.clone(), false)
        } else {
            let waiter = Arc::new(ParseRefsWaiter::new());
            entries.insert(key.clone(), waiter.clone());
            (waiter, true)
        }
    };

    if should_run {
        let worker_waiter = waiter.clone();
        tokio::spawn(async move {
            let shared_result = parse_paper_refs_prepared(prepared, online_enabled)
                .await
                .map_err(|e| e.to_string());
            *worker_waiter.result.lock().await = Some(shared_result);
            worker_waiter.notify.notify_waiters();

            let inflight = refs_inflight();
            let mut entries = inflight.entries.lock().await;
            if entries
                .get(&key)
                .is_some_and(|current| Arc::ptr_eq(current, &worker_waiter))
            {
                entries.remove(&key);
            }
        });
    }

    waiter.wait().await.map_err(AppError::message)
}

async fn parse_paper_refs_prepared(
    prepared: PreparedParseRefs,
    online_enabled: bool,
) -> Result<CiteSidecar, AppError> {
    let mut messages = Vec::new();
    let (mut drafts, local_mode, numbered) = parse_local(&prepared.files, &mut messages);

    let mut provider: Option<&'static str> = None;
    let mut enriched: Vec<usize> = Vec::new();
    let mut online_only = false;
    if online_enabled && (prepared.doi.is_some() || prepared.arxiv.is_some()) {
        let outcome =
            online::fetch_references(prepared.doi.as_deref(), prepared.arxiv.as_deref()).await;
        messages.extend(outcome.messages);
        if let Some(p) = outcome.provider {
            provider = Some(p);
            if drafts.is_empty() {
                drafts = outcome.refs;
                online_only = true;
            } else {
                enriched = merge_online(&mut drafts, &outcome.refs);
                messages.push(format!(
                    "merged: {} of {} enriched online",
                    enriched.len(),
                    drafts.len()
                ));
            }
        }
    }

    let mode = match (local_mode, provider) {
        (_, Some(p)) if online_only => p.to_string(),
        (Some(l), Some(p)) if !enriched.is_empty() => format!("{l}+{p}"),
        (Some(l), _) => l.to_string(),
        (None, Some(p)) => p.to_string(),
        (None, None) => "none".to_string(),
    };

    let enriched_set: std::collections::HashSet<usize> = enriched.into_iter().collect();
    let mut citations: Vec<Citation> = drafts
        .iter()
        .enumerate()
        .map(|(i, d)| {
            let source = if enriched_set.contains(&i) {
                format!("{}+{}", d.source, provider.unwrap_or("online"))
            } else {
                d.source.to_string()
            };
            citation_from_draft(d, i, numbered, source)
        })
        .collect();

    let catalog = papers::list_all(&prepared.vault).unwrap_or_default();
    attach_local_matches(&mut citations, &catalog, &prepared.path_rel);

    let sidecar = CiteSidecar {
        schema_version: SCHEMA_VERSION,
        source: CiteSource {
            mode,
            generated_at: crate::core::time::now_rfc3339_millis(),
            fingerprint: prepared.fingerprint,
        },
        citations,
        messages,
    };
    write_sidecar(&prepared.sidecar_path, &sidecar)?;
    Ok(sidecar)
}

/// Register the refs job runner + backfill probe with the JobCenter at app
/// startup. Dependency inversion: the scheduler dispatches, refs owns the
/// execution (no jobs→refs edge).
#[cfg(feature = "desktop")]
pub fn register_job_runners(center: &crate::features::jobs::JobCenter) {
    use crate::features::jobs::JobKind;
    center.register_runner(JobKind::ParseRefs, Arc::new(parse_refs_runner));
    // Reconcile backfill: a paper needs ParseRefs when its cite sidecar is absent.
    center.register_backfill_probe(JobKind::ParseRefs, |vault, path| {
        !vault.join(path).join("source").join(SIDECAR_FILE).is_file()
    });
}

/// Runner for [`crate::features::jobs::JobKind::ParseRefs`]: parse the cite
/// sidecar; online reference lookup is always enabled.
#[cfg(feature = "desktop")]
fn parse_refs_runner(
    center: crate::features::jobs::JobCenter,
    app: tauri::AppHandle,
    started: crate::features::jobs::StartedJob,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    use crate::features::jobs::{RunOutcome, StartedJob};
    center.run_job(app, started, |_center, _app, started| async move {
        let StartedJob {
            vault_path: vault,
            paper_path: path,
            force,
            ..
        } = started;
        match parse_paper_refs(&vault, &path, true, force).await {
            Ok(_) => RunOutcome::Succeeded,
            Err(e) => RunOutcome::Failed(Some(e.to_string())),
        }
    })
}

/// Fire-and-forget refs parse after an import/download finished.
/// Online reference lookup is always on; all failures are logged, never surfaced.
#[cfg(feature = "desktop")]
pub fn spawn_parse_after_import(app: Option<&tauri::AppHandle>, vault: &Path, path_rel: &str) {
    let vault = vault.to_path_buf();
    let path_rel = path_rel.to_string();

    if let Some(app) = app {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let center = app.state::<crate::features::jobs::JobCenter>().handle();
            let snapshot = center
                .enqueue_parse_refs(
                    &vault,
                    &path_rel,
                    crate::features::jobs::JobLane::Normal,
                    false,
                )
                .await;
            crate::features::jobs::emit_job_changed(&app, snapshot.clone());
            match center.try_start(&snapshot.id).await {
                crate::features::jobs::StartOutcome::Started(started) => {
                    center.run_started(&app, started).await;
                }
                crate::features::jobs::StartOutcome::Skipped(skipped) => {
                    crate::features::jobs::emit_job_changed(&app, skipped);
                }
                crate::features::jobs::StartOutcome::Waiting => {}
            }
        });
        return;
    }

    tokio::spawn(async move {
        match parse_paper_refs(&vault, &path_rel, true, false).await {
            Ok(s) => log::info!(
                "op=paper_refs_parse status=ok path={path_rel} mode={} count={}",
                s.source.mode,
                s.citations.len()
            ),
            Err(e) => log::warn!("op=paper_refs_parse status=err path={path_rel} error={e}"),
        }
    });
}

#[cfg(not(feature = "desktop"))]
pub fn spawn_parse_after_import(
    _app: Option<&crate::core::app_handle::AppHandle>,
    vault: &Path,
    path_rel: &str,
) {
    let vault = vault.to_path_buf();
    let path_rel = path_rel.to_string();
    tokio::spawn(async move {
        match parse_paper_refs(&vault, &path_rel, true, false).await {
            Ok(s) => log::info!(
                "op=paper_refs_parse status=ok path={path_rel} mode={} count={}",
                s.source.mode,
                s.citations.len()
            ),
            Err(e) => log::warn!("op=paper_refs_parse status=err path={path_rel} error={e}"),
        }
    });
}

pub fn read_sidecar(path: &Path) -> Option<CiteSidecar> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_sidecar(path: &Path, sidecar: &CiteSidecar) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    // Plain write, no tmp+rename: FSEvents reports that rename without a
    // verified from/to pair, which the vault watcher surfaces as an
    // "unverified rename" toast. The sidecar is rebuildable, so atomicity
    // is not worth that noise.
    fs::write(path, serde_json::to_string_pretty(sidecar)?)?;
    Ok(())
}

/// All `.bib` / `.bbl` / `.tex` / `.ltx` under the paper folder (skips dotfiles
/// and `agentero-*` derived files), sorted for deterministic fingerprints.
fn collect_ref_files(paper_dir: &Path) -> Vec<PathBuf> {
    fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
        if depth > 16 {
            return;
        }
        let Ok(rd) = fs::read_dir(dir) else {
            return;
        };
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name.starts_with("agentero-") {
                continue;
            }
            let p = entry.path();
            if p.is_dir() {
                walk(&p, depth + 1, out);
            } else if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
                if matches!(
                    ext.to_ascii_lowercase().as_str(),
                    "bib" | "bbl" | "tex" | "ltx"
                ) {
                    out.push(p);
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(paper_dir, 0, &mut out);
    out.sort();
    out
}

fn fingerprint(doi: Option<&str>, arxiv: Option<&str>, online: bool, files: &[PathBuf]) -> String {
    let mut h = Sha256::new();
    h.update(
        format!(
            "v{SCHEMA_VERSION}|{}|{}|{online}",
            doi.unwrap_or(""),
            arxiv.unwrap_or("")
        )
        .as_bytes(),
    );
    for f in files {
        let (len, mtime) = fs::metadata(f)
            .map(|m| {
                let mtime = m
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                (m.len(), mtime)
            })
            .unwrap_or((0, 0));
        h.update(format!("|{}|{len}|{mtime}", f.to_string_lossy()).as_bytes());
    }
    hex::encode(h.finalize())
}

/// L2: local `.bbl` (preferred: bibliography order) enriched from `.bib` by key,
/// else `.bib` alone, else inline `thebibliography` in `.tex`.
/// Returns (drafts, mode label, numbered = order matches in-text `[n]`).
fn parse_local(
    files: &[PathBuf],
    messages: &mut Vec<String>,
) -> (Vec<RefDraft>, Option<&'static str>, bool) {
    let read = |p: &PathBuf| fs::read_to_string(p).ok();

    let mut bib_entries: Vec<bib::BibEntry> = Vec::new();
    for f in files.iter().filter(|f| has_ext(f, "bib")) {
        if let Some(s) = read(f) {
            bib_entries.extend(bib::parse(&s));
        }
    }

    let mut bbl_drafts: Vec<RefDraft> = Vec::new();
    let mut mode: Option<&'static str> = None;
    for f in files.iter().filter(|f| has_ext(f, "bbl")) {
        if let Some(s) = read(f) {
            bbl_drafts.extend(bbl::parse(&s));
        }
    }
    if !bbl_drafts.is_empty() {
        mode = Some("bbl");
    } else {
        for f in files
            .iter()
            .filter(|f| has_ext(f, "tex") || has_ext(f, "ltx"))
        {
            if let Some(s) = read(f) {
                if let Some(body) = bbl::extract_thebibliography(&s) {
                    let mut drafts = bbl::parse(body);
                    for d in &mut drafts {
                        d.source = "tex";
                    }
                    if !drafts.is_empty() {
                        bbl_drafts = drafts;
                        mode = Some("tex");
                        break;
                    }
                }
            }
        }
    }

    if !bbl_drafts.is_empty() {
        dedupe_by_key(&mut bbl_drafts);
        let bib_by_key: HashMap<String, &bib::BibEntry> = bib_entries
            .iter()
            .map(|e| (e.key.to_lowercase(), e))
            .collect();
        for d in &mut bbl_drafts {
            if let Some(entry) = d
                .key
                .as_ref()
                .and_then(|k| bib_by_key.get(&k.to_lowercase()))
            {
                enrich_from_bib(d, entry);
            }
        }
        messages.push(format!(
            "local: {} entries ({})",
            bbl_drafts.len(),
            mode.unwrap_or("bbl")
        ));
        return (bbl_drafts, mode, true);
    }

    if !bib_entries.is_empty() {
        let drafts: Vec<RefDraft> = bib_entries.iter().map(draft_from_bib).collect();
        messages.push(format!("local: {} entries (bib)", drafts.len()));
        return (drafts, Some("bib"), false);
    }

    (Vec::new(), None, false)
}

fn has_ext(p: &Path, ext: &str) -> bool {
    p.extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case(ext))
        .unwrap_or(false)
}

fn dedupe_by_key(drafts: &mut Vec<RefDraft>) {
    let mut seen = std::collections::HashSet::new();
    drafts.retain(|d| match &d.key {
        Some(k) => seen.insert(k.to_lowercase()),
        None => true,
    });
}

fn draft_from_bib(e: &bib::BibEntry) -> RefDraft {
    let f = &e.fields;
    let nonempty = |s: &String| !s.trim().is_empty();
    RefDraft {
        key: Some(e.key.clone()),
        raw: None,
        title: f.get("title").filter(|s| nonempty(s)).cloned(),
        authors: f
            .get("author")
            .map(|a| bib::split_authors(a))
            .unwrap_or_default(),
        year: f.get("year").and_then(|y| latex::extract_year(y)),
        venue: f
            .get("journal")
            .or_else(|| f.get("booktitle"))
            .or_else(|| f.get("journaltitle"))
            .filter(|s| nonempty(s))
            .cloned(),
        doi: f.get("doi").filter(|s| nonempty(s)).cloned(),
        arxiv_id: arxiv_from_bib(f),
        url: f.get("url").filter(|s| nonempty(s)).cloned(),
        source: "bib",
    }
}

fn arxiv_from_bib(f: &HashMap<String, String>) -> Option<String> {
    let prefix_is_arxiv = f
        .get("archiveprefix")
        .or_else(|| f.get("eprinttype"))
        .map(|v| v.to_ascii_lowercase().contains("arxiv"))
        .unwrap_or(false);
    if prefix_is_arxiv {
        if let Some(eprint) = f.get("eprint").filter(|s| !s.trim().is_empty()) {
            return Some(latex::strip_arxiv_version(eprint).to_string());
        }
    }
    for field in ["journal", "note", "url", "howpublished"] {
        if let Some(v) = f.get(field) {
            if let Some(id) = latex::extract_arxiv_id(v) {
                return Some(latex::strip_arxiv_version(&id).to_string());
            }
        }
    }
    None
}

fn enrich_from_bib(d: &mut RefDraft, e: &bib::BibEntry) {
    let from = draft_from_bib(e);
    if d.title.is_none() {
        d.title = from.title;
    }
    if d.authors.is_empty() {
        d.authors = from.authors;
    }
    if d.year.is_none() {
        d.year = from.year;
    }
    if d.venue.is_none() {
        d.venue = from.venue;
    }
    if d.doi.is_none() {
        d.doi = from.doi;
    }
    if d.arxiv_id.is_none() {
        d.arxiv_id = from.arxiv_id;
    }
    if d.url.is_none() {
        d.url = from.url;
    }
}

/// Enrich ordered local drafts from online entries (L1 metadata wins).
/// Match by DOI → arXiv id → normalized title (exact or contained in raw) →
/// year + first-author family in raw. Returns enriched base indexes.
fn merge_online(base: &mut [RefDraft], online: &[RefDraft]) -> Vec<usize> {
    let mut by_doi: HashMap<String, usize> = HashMap::new();
    let mut by_arxiv: HashMap<String, usize> = HashMap::new();
    let mut by_title: HashMap<String, usize> = HashMap::new();
    let norm_raws: Vec<String> = base
        .iter()
        .map(|d| {
            d.raw
                .as_deref()
                .map(latex::normalize_title)
                .unwrap_or_default()
        })
        .collect();
    for (i, d) in base.iter().enumerate() {
        if let Some(doi) = &d.doi {
            by_doi.entry(doi.to_lowercase()).or_insert(i);
        }
        if let Some(a) = &d.arxiv_id {
            by_arxiv
                .entry(latex::strip_arxiv_version(a).to_lowercase())
                .or_insert(i);
        }
        if let Some(t) = &d.title {
            let n = latex::normalize_title(t);
            if n.len() >= 10 {
                by_title.entry(n).or_insert(i);
            }
        }
    }

    let mut used = vec![false; base.len()];
    let mut matched = Vec::new();
    for o in online {
        let idx = o
            .doi
            .as_ref()
            .and_then(|d| by_doi.get(&d.to_lowercase()).copied())
            .or_else(|| {
                o.arxiv_id.as_ref().and_then(|a| {
                    by_arxiv
                        .get(&latex::strip_arxiv_version(a).to_lowercase())
                        .copied()
                })
            })
            .or_else(|| {
                let n = o.title.as_deref().map(latex::normalize_title)?;
                if n.len() < 10 {
                    return None;
                }
                by_title.get(&n).copied().or_else(|| {
                    if n.len() < 15 {
                        return None;
                    }
                    norm_raws
                        .iter()
                        .enumerate()
                        .find(|(i, r)| !used[*i] && r.contains(&n))
                        .map(|(i, _)| i)
                })
            })
            .or_else(|| fuzzy_match(base, &used, o));
        if let Some(i) = idx {
            if used[i] {
                continue;
            }
            used[i] = true;
            apply_online(&mut base[i], o);
            matched.push(i);
        }
    }
    matched
}

fn fuzzy_match(base: &[RefDraft], used: &[bool], o: &RefDraft) -> Option<usize> {
    let year = o.year?;
    let family = latex::first_author_family(&o.authors)?.to_lowercase();
    if family.len() < 3 {
        return None;
    }
    base.iter()
        .enumerate()
        .find(|(i, d)| {
            !used[*i]
                && d.year == Some(year)
                && d.raw
                    .as_ref()
                    .map(|r| r.to_lowercase().contains(&family))
                    .unwrap_or(false)
        })
        .map(|(i, _)| i)
}

fn apply_online(d: &mut RefDraft, o: &RefDraft) {
    if o.title.is_some() {
        d.title = o.title.clone();
    }
    if !o.authors.is_empty() {
        d.authors = o.authors.clone();
    }
    if o.year.is_some() {
        d.year = o.year;
    }
    if o.venue.is_some() {
        d.venue = o.venue.clone();
    }
    if d.doi.is_none() {
        d.doi = o.doi.clone();
    }
    if d.arxiv_id.is_none() {
        d.arxiv_id = o.arxiv_id.clone();
    }
    if d.url.is_none() {
        d.url = o.url.clone();
    }
}

fn citation_from_draft(d: &RefDraft, idx: usize, numbered: bool, source: String) -> Citation {
    let id = match &d.key {
        Some(k) => format!("cite-{}", sanitize_id(k)),
        None => format!("ref-{}", idx + 1),
    };
    Citation {
        id,
        raw_key: d.key.clone(),
        display: numbered.then(|| format!("[{}]", idx + 1)),
        raw: d.raw.clone(),
        metadata: CitationMeta {
            title: d.title.clone(),
            authors: d.authors.clone(),
            year: d.year,
            venue: d.venue.clone(),
            doi: d.doi.clone(),
            arxiv_id: d.arxiv_id.clone(),
            url: d.url.clone(),
        },
        local_match: None,
        source,
        status: if d.title.is_some() {
            "resolved".to_string()
        } else {
            "unresolved".to_string()
        },
    }
}

fn sanitize_id(key: &str) -> String {
    key.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':') {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// Match citations against library papers by DOI → arXiv id → normalized title.
fn attach_local_matches(citations: &mut [Citation], catalog: &[PaperRecord], self_path: &str) {
    let mut by_doi: HashMap<String, &str> = HashMap::new();
    let mut by_arxiv: HashMap<String, &str> = HashMap::new();
    let mut by_title: HashMap<String, &str> = HashMap::new();
    for r in catalog {
        if r.path == self_path {
            continue;
        }
        if let Some(doi) = r.doi.as_deref().filter(|s| !s.trim().is_empty()) {
            by_doi.entry(doi.trim().to_lowercase()).or_insert(&r.path);
        }
        if let Some(a) = r.arxiv_id.as_deref().filter(|s| !s.trim().is_empty()) {
            by_arxiv
                .entry(latex::strip_arxiv_version(a).to_lowercase())
                .or_insert(&r.path);
        }
        let n = latex::normalize_title(&r.title);
        if n.len() >= 15 {
            by_title.entry(n).or_insert(&r.path);
        }
    }
    for c in citations.iter_mut() {
        let m = &c.metadata;
        let hit = m
            .doi
            .as_ref()
            .and_then(|d| by_doi.get(&d.trim().to_lowercase()))
            .map(|p| (*p, "doi"))
            .or_else(|| {
                m.arxiv_id.as_ref().and_then(|a| {
                    by_arxiv
                        .get(&latex::strip_arxiv_version(a).to_lowercase())
                        .map(|p| (*p, "arxiv"))
                })
            })
            .or_else(|| {
                m.title.as_ref().and_then(|t| {
                    let n = latex::normalize_title(t);
                    if n.len() < 15 {
                        return None;
                    }
                    by_title.get(&n).map(|p| (*p, "title"))
                })
            });
        if let Some((path, match_by)) = hit {
            c.local_match = Some(LocalMatch {
                paper_path: path.to_string(),
                match_by: match_by.to_string(),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_vault(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("agentero-refs-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("papers/demo/source")).unwrap();
        dir
    }

    const BBL: &str = r#"
\begin{thebibliography}{2}
\bibitem{vaswani2017}
A.~Vaswani et~al.
\newblock Attention is all you need.
\newblock In {\em NeurIPS}, 2017. arXiv:1706.03762.
\bibitem{he2016}
K.~He.
\newblock Deep residual learning, 2016. doi:10.1109/CVPR.2016.90
\end{thebibliography}
"#;

    #[tokio::test]
    async fn parses_local_bbl_offline_and_caches() {
        let vault = temp_vault("bbl");
        fs::write(vault.join("papers/demo/source/main.bbl"), BBL).unwrap();

        let sidecar = parse_paper_refs(&vault, "papers/demo", false, false)
            .await
            .unwrap();
        assert_eq!(sidecar.source.mode, "bbl");
        assert_eq!(sidecar.citations.len(), 2);
        assert_eq!(sidecar.citations[0].display.as_deref(), Some("[1]"));
        assert_eq!(sidecar.citations[0].raw_key.as_deref(), Some("vaswani2017"));
        assert_eq!(
            sidecar.citations[0].metadata.arxiv_id.as_deref(),
            Some("1706.03762")
        );
        assert!(vault
            .join("papers/demo/source")
            .join(SIDECAR_FILE)
            .is_file());

        // Unchanged inputs → cached sidecar (same generatedAt).
        let again = parse_paper_refs(&vault, "papers/demo", false, false)
            .await
            .unwrap();
        assert_eq!(again.source.generated_at, sidecar.source.generated_at);
        let _ = fs::remove_dir_all(&vault);
    }

    #[tokio::test]
    async fn bib_enriches_bbl_by_key() {
        let vault = temp_vault("bib");
        fs::write(vault.join("papers/demo/source/main.bbl"), BBL).unwrap();
        fs::write(
            vault.join("papers/demo/source/refs.bib"),
            r#"@article{vaswani2017, title={Attention Is All You Need},
                author={Vaswani, Ashish}, year={2017}, journal={NeurIPS}}"#,
        )
        .unwrap();

        let sidecar = parse_paper_refs(&vault, "papers/demo", false, false)
            .await
            .unwrap();
        let first = &sidecar.citations[0];
        assert_eq!(
            first.metadata.title.as_deref(),
            Some("Attention Is All You Need")
        );
        assert_eq!(first.status, "resolved");
        assert_eq!(sidecar.citations[1].status, "unresolved");
        let _ = fs::remove_dir_all(&vault);
    }

    #[test]
    fn merges_online_metadata_into_local_order() {
        let mut base = bbl::parse(BBL);
        let online = vec![RefDraft {
            key: None,
            raw: None,
            title: Some("Attention Is All You Need".into()),
            authors: vec!["Ashish Vaswani".into()],
            year: Some(2017),
            venue: Some("NeurIPS".into()),
            doi: None,
            arxiv_id: Some("1706.03762".into()),
            url: None,
            source: "s2",
        }];
        let matched = merge_online(&mut base, &online);
        assert_eq!(matched, vec![0]);
        assert_eq!(base[0].title.as_deref(), Some("Attention Is All You Need"));
        assert_eq!(
            base[0].raw.as_deref().map(|r| r.contains("Attention")),
            Some(true)
        );
        assert!(base[1].title.is_none());
    }
}
