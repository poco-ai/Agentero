//! Vault-wide full-text search over Markdown files.
//!
//! Walk-based (always fresh, no index): scans `*.md` under the Vault (skipping
//! hidden / system dirs), requires all query terms (AND), and returns ranked
//! hits with a snippet + line number. Hits inside a `papers/<…>` folder carry
//! `paper_path` so the UI can open the paper instead of the raw file.

use crate::core::error::AppError;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024; // skip very large md files
const MAX_DEPTH: usize = 16;
const MAX_FILES: usize = 20_000;
const SNIPPET_CHARS: usize = 200;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSearchArgs {
    pub vault_path: String,
    pub query: String,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// Vault-relative md file, e.g. `papers/x/NOTES.md`.
    pub path: String,
    /// Vault-relative paper folder when the hit is inside `papers/…`; else omitted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paper_path: Option<String>,
    pub title: String,
    pub snippet: String,
    /// 1-based line of the first matching line (0 when unknown).
    pub line: u32,
    pub score: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSearchResult {
    pub hits: Vec<SearchHit>,
    /// True when more hits existed than `limit`.
    pub truncated: bool,
}

/// Search the Vault's Markdown files for all whitespace-separated terms (AND).
pub fn vault_search(args: VaultSearchArgs) -> Result<VaultSearchResult, AppError> {
    let vault = crate::core::fs::resolve_vault(&args.vault_path)?;

    let terms: Vec<String> = args
        .query
        .to_lowercase()
        .split_whitespace()
        .map(str::to_string)
        .collect();
    if terms.is_empty() {
        return Ok(VaultSearchResult {
            hits: Vec::new(),
            truncated: false,
        });
    }
    let limit = args.limit.unwrap_or(60).clamp(1, 200);

    let mut files: Vec<PathBuf> = Vec::new();
    collect_md_files(&vault, 0, &mut files);

    let mut hits: Vec<SearchHit> = Vec::new();
    for file in &files {
        if let Some(hit) = search_file(&vault, file, &terms) {
            hits.push(hit);
        }
    }
    hits.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
    let truncated = hits.len() > limit;
    hits.truncate(limit);
    Ok(VaultSearchResult { hits, truncated })
}

fn collect_md_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > MAX_DEPTH || out.len() >= MAX_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if path.is_dir() {
            // Skip hidden (.agentero/.git/.trash), deps, and LaTeX/e-print source.
            if name.starts_with('.') || name == "node_modules" || name == "source" {
                continue;
            }
            collect_md_files(&path, depth + 1, out);
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("md"))
        {
            out.push(path);
            if out.len() >= MAX_FILES {
                return;
            }
        }
    }
}

fn search_file(vault: &Path, file: &Path, terms: &[String]) -> Option<SearchHit> {
    let meta = fs::metadata(file).ok()?;
    if meta.len() > MAX_FILE_BYTES {
        return None;
    }
    let content = fs::read_to_string(file).ok()?;
    let lower = content.to_lowercase();
    // AND semantics: every term must appear somewhere in the file.
    if !terms.iter().all(|t| lower.contains(t.as_str())) {
        return None;
    }

    let rel = file
        .strip_prefix(vault)
        .ok()?
        .to_string_lossy()
        .replace('\\', "/");

    let title = content
        .lines()
        .find_map(|l| l.trim().strip_prefix("# ").map(|s| s.trim().to_string()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            file.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string()
        });

    // First matching line → snippet + 1-based line number.
    let mut line = 0u32;
    let mut snippet = String::new();
    for (i, raw) in content.lines().enumerate() {
        let ll = raw.to_lowercase();
        if terms.iter().any(|t| ll.contains(t.as_str())) {
            line = (i + 1) as u32;
            snippet = make_snippet(raw, terms);
            break;
        }
    }

    let title_lower = title.to_lowercase();
    let mut score: i64 = 0;
    for t in terms {
        if title_lower.contains(t.as_str()) {
            score += 50;
        }
        let occ = lower.matches(t.as_str()).count().min(20) as i64;
        score += occ;
    }
    let fname = file.file_name().and_then(|s| s.to_str()).unwrap_or("");
    if fname.eq_ignore_ascii_case("NOTES.md") || fname.eq_ignore_ascii_case("PAPER.md") {
        score += 5;
    }

    Some(SearchHit {
        paper_path: paper_folder_of(&rel),
        path: rel,
        title,
        snippet,
        line,
        score,
    })
}

/// Center a snippet on the earliest matching term, trimmed to [`SNIPPET_CHARS`].
fn make_snippet(raw: &str, terms: &[String]) -> String {
    // Strip common leading Markdown markers for a cleaner preview.
    let cleaned = raw
        .trim()
        .trim_start_matches(['#', '>', '-', '*', ' '])
        .trim();
    let chars: Vec<char> = cleaned.chars().collect();
    if chars.len() <= SNIPPET_CHARS {
        return cleaned.to_string();
    }

    let lower = cleaned.to_lowercase();
    let byte_pos = terms
        .iter()
        .filter_map(|t| lower.find(t.as_str()))
        .min()
        .unwrap_or(0);
    let char_pos = cleaned[..byte_pos].chars().count();

    let mut start = char_pos.saturating_sub(SNIPPET_CHARS / 3);
    let end = (start + SNIPPET_CHARS).min(chars.len());
    start = end.saturating_sub(SNIPPET_CHARS);
    let mut s: String = chars[start..end].iter().collect();
    if start > 0 {
        s = format!("…{s}");
    }
    if end < chars.len() {
        s = format!("{s}…");
    }
    s
}

/// Vault-relative paper folder for a md path under `papers/…`, else None.
fn paper_folder_of(rel: &str) -> Option<String> {
    if !rel.starts_with("papers/") {
        return None;
    }
    let (parent, _file) = rel.rsplit_once('/')?;
    if parent == "papers" {
        // md directly under papers/ (not a paper folder) → open the file itself.
        return None;
    }
    Some(parent.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, rel: &str, body: &str) {
        let p = dir.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    #[test]
    fn finds_terms_and_maps_paper_folder() {
        let root = std::env::temp_dir().join(format!("agentero-search-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        write(
            &root,
            "papers/attention/NOTES.md",
            "# Attention Is All You Need\n\nThe transformer uses self-attention.\n",
        );
        write(&root, "notes/idea.md", "Random note about cats.\n");
        write(&root, ".agentero/skip.md", "attention transformer hidden\n");

        let out = vault_search(VaultSearchArgs {
            vault_path: root.to_string_lossy().to_string(),
            query: "transformer attention".into(),
            limit: None,
        })
        .unwrap();

        assert_eq!(out.hits.len(), 1, "only the NOTES.md matches both terms");
        let hit = &out.hits[0];
        assert_eq!(hit.path, "papers/attention/NOTES.md");
        assert_eq!(hit.paper_path.as_deref(), Some("papers/attention"));
        assert_eq!(hit.title, "Attention Is All You Need");
        assert!(hit.line >= 1);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_query_returns_nothing() {
        let root = std::env::temp_dir().join(format!("agentero-search-e-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let out = vault_search(VaultSearchArgs {
            vault_path: root.to_string_lossy().to_string(),
            query: "   ".into(),
            limit: None,
        })
        .unwrap();
        assert!(out.hits.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    /// Quantified regression guard for the async command migration: build a
    /// few-hundred-file vault, record the direct-call timing baseline, then run
    /// the identical search through `run_blocking` (the async command path) and
    /// assert the heavy IO executed off the calling thread — on Windows the
    /// calling thread of a sync command is the UI message pump.
    #[test]
    fn vault_search_runs_off_the_calling_thread_with_timing_baseline() {
        let root =
            std::env::temp_dir().join(format!("agentero-search-bench-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        const FILES: usize = 300;
        for i in 0..FILES {
            let needle = if i % 3 == 0 { "transformer" } else { "cats" };
            write(
                &root,
                &format!("notes/note-{i}.md"),
                &format!(
                    "# Note {i}\n\nBody line about {needle}.\n{}\n",
                    "filler line for realistic file size.\n".repeat(40)
                ),
            );
        }

        // Baseline: direct implementation call on this thread.
        let started = std::time::Instant::now();
        let direct = vault_search(VaultSearchArgs {
            vault_path: root.to_string_lossy().to_string(),
            query: "transformer".into(),
            limit: Some(200),
        })
        .expect("direct search");
        let direct_ms = started.elapsed().as_millis();
        eprintln!(
            "bench vault_search direct: files={FILES} hits={} truncated={} elapsed_ms={direct_ms}",
            direct.hits.len(),
            direct.truncated
        );
        assert_eq!(direct.hits.len(), 100, "every third file matches");

        // Async command path: same work, must run on a blocking-pool thread.
        let caller = std::thread::current().id();
        let vault_path = root.to_string_lossy().to_string();
        let result = tauri::async_runtime::block_on(crate::core::blocking::run_blocking(
            move || {
                let worker = std::thread::current();
                let off_thread = worker.id() != caller;
                let started = std::time::Instant::now();
                let out = vault_search(VaultSearchArgs {
                    vault_path,
                    query: "transformer".into(),
                    limit: Some(200),
                })
                .expect("blocking search");
                eprintln!(
                    "bench vault_search run_blocking: worker id={:?} name={:?} hits={} elapsed_ms={}",
                    worker.id(),
                    worker.name(),
                    out.hits.len(),
                    started.elapsed().as_millis()
                );
                crate::core::error::ApiResult::ok((off_thread, out.hits.len()))
            },
        ));
        let (off_thread, hits) = result.data.expect("search result data");
        assert!(
            off_thread,
            "vault_search must execute on the blocking pool, not the calling thread"
        );
        assert_eq!(hits, direct.hits.len(), "same results through both paths");
        let _ = fs::remove_dir_all(&root);
    }
}

/// Tauri command shells for this feature.
pub mod commands;
