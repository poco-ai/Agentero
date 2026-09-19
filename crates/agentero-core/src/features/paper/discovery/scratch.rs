//! Plaza paper scratch workspace — vault-external full-text copies backing
//! Agent `@` mentions, so discussing a paper never imports it into the Vault.
//!
//! Layout: `<cache>/agentero/plaza-scratch/{arxivId}/` holding `paper.pdf`
//! (downloaded from arxiv.org) and `PAPER.md` (liteparse conversion, same
//! engine as Vault paper parsing). Papers are immutable, so entries are
//! reused until the size cap evicts the least-recently-used ones.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use crate::error::AppError;
use crate::features::paper::analyze::parse::engines::parse_body_with_engine;
use crate::http;
use crate::paths;

/// Total cap for all scratch papers (PDF + markdown), oldest-first eviction.
/// Bounded at cap + one in-flight download (`MAX_PAPER_PDF_BYTES`).
const MAX_TOTAL_BYTES: u64 = 500 * 1024 * 1024;
/// Per-paper download cap: streaming aborts (and cleans the partial) beyond
/// this, so one pathological response cannot blow the memory or disk budget.
const MAX_PAPER_PDF_BYTES: u64 = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_SECS: u64 = 90;
/// Marker file rewritten on every use; mtime drives LRU eviction.
const LAST_USED_FILE: &str = ".last-used";

/// Serializes every cache mutation. Overlapping `plaza_scratch_prepare`
/// calls (e.g. a frontend-timeout retry while the host is still working)
/// would otherwise each protect only their own entry during LRU eviction,
/// letting one evict a directory the other is about to return; `clear`
/// races the same way.
static SCRATCH_MUTEX: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Clone, Default, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ScratchStats {
    pub papers: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ScratchClearResult {
    pub freed_bytes: u64,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ScratchPaper {
    pub arxiv_id: String,
    /// Absolute directory path (outside the Vault).
    pub dir: String,
    /// Absolute path of the full-text markdown the Agent should read.
    pub markdown_path: String,
    /// Absolute path of the cached source PDF.
    pub pdf_path: String,
    /// True when an existing scratch copy was reused (no download/parse).
    pub reused: bool,
}

pub fn scratch_root() -> PathBuf {
    paths::agentero_cache_dir().join("plaza-scratch")
}

/// New-style arXiv ids only (`2409.12345`, optional `v2`): a strict charset
/// keeps the id from ever escaping its cache subdirectory.
pub fn validate_arxiv_id(arxiv_id: &str) -> Result<(), AppError> {
    let invalid = || {
        AppError::message(format!(
            "invalid arXiv id: {arxiv_id:?} (expected 2409.12345[v2])"
        ))
    };
    let (base, version) = match arxiv_id.split_once('v') {
        Some((base, version)) => (base, Some(version)),
        None => (arxiv_id, None),
    };
    let mut parts = base.split('.');
    let yymm = parts.next().unwrap_or_default();
    let number = parts.next().unwrap_or_default();
    if parts.next().is_some() {
        return Err(invalid());
    }
    if yymm.len() != 4 || !yymm.bytes().all(|b| b.is_ascii_digit()) {
        return Err(invalid());
    }
    if !(4..=5).contains(&number.len()) || !number.bytes().all(|b| b.is_ascii_digit()) {
        return Err(invalid());
    }
    if let Some(version) = version {
        if version.is_empty() || version.len() > 3 || !version.bytes().all(|b| b.is_ascii_digit()) {
            return Err(invalid());
        }
    }
    Ok(())
}

fn touch_last_used(dir: &Path) {
    let _ = std::fs::write(dir.join(LAST_USED_FILE), b"");
}

/// Directory "last used" instant: the marker file's mtime, falling back to
/// the directory mtime for entries created before the marker existed.
fn dir_last_used(dir: &Path) -> std::time::SystemTime {
    dir.join(LAST_USED_FILE)
        .metadata()
        .and_then(|m| m.modified())
        .or_else(|_| dir.metadata().and_then(|m| m.modified()))
        .unwrap_or(std::time::UNIX_EPOCH)
}

fn dir_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    for entry in entries.flatten() {
        total += match entry.metadata() {
            Ok(meta) if meta.is_file() => meta.len(),
            Ok(meta) if meta.is_dir() => dir_size(&entry.path()),
            _ => 0,
        };
    }
    total
}

/// Delete oldest scratch papers until the total fits `cap`. The paper being
/// prepared right now (`keep`) is never evicted.
fn enforce_cap_in(root: &Path, keep: &Path, cap: u64) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut dirs: Vec<(PathBuf, u64, std::time::SystemTime)> = entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .map(|entry| {
            let path = entry.path();
            (path.clone(), dir_size(&path), dir_last_used(&path))
        })
        .collect();
    let mut total: u64 = dirs.iter().map(|(_, size, _)| *size).sum();
    if total <= cap {
        return;
    }
    dirs.sort_by_key(|(_, _, used)| *used);
    for (path, size, _) in dirs {
        if total <= cap {
            break;
        }
        if path == keep {
            continue;
        }
        if std::fs::remove_dir_all(&path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

/// Stream one arXiv PDF into `tmp`, enforcing the per-paper size cap so an
/// oversized response can never buffer in memory or blow past the cache
/// budget. The `%PDF-` magic is checked on the first chunk before anything
/// is written.
async fn stream_pdf_to_file(url: &str, tmp: &Path) -> Result<(), AppError> {
    use tokio::io::AsyncWriteExt;

    let client = http::client_builder()
        .timeout(Duration::from_secs(DOWNLOAD_TIMEOUT_SECS))
        .user_agent(http::BROWSER_USER_AGENT)
        .redirect(reqwest::redirect::Policy::limited(
            http::DEFAULT_REDIRECT_LIMIT,
        ))
        .build()
        .map_err(|e| AppError::message(format!("http client: {e}")))?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| AppError::message(format!("download {url}: {e}")))?;
    if !response.status().is_success() {
        return Err(AppError::message(format!(
            "download {url}: HTTP {}",
            response.status()
        )));
    }
    let mut file = tokio::fs::File::create(tmp)
        .await
        .map_err(|e| AppError::message(format!("create scratch pdf part: {e}")))?;
    let mut written: u64 = 0;
    let mut magic_checked = false;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| AppError::message(format!("download {url}: {e}")))?
    {
        if !magic_checked {
            if chunk.len() < 5 || &chunk[..5] != b"%PDF-" {
                return Err(AppError::message(format!(
                    "download {url}: response is not a PDF"
                )));
            }
            magic_checked = true;
        }
        written += chunk.len() as u64;
        if written > MAX_PAPER_PDF_BYTES {
            return Err(AppError::message(format!(
                "download {url}: exceeds the {MAX_PAPER_PDF_BYTES} byte per-paper cap"
            )));
        }
        file.write_all(&chunk)
            .await
            .map_err(|e| AppError::message(format!("write scratch pdf: {e}")))?;
    }
    if !magic_checked {
        return Err(AppError::message(format!("download {url}: empty response")));
    }
    file.flush()
        .await
        .map_err(|e| AppError::message(format!("write scratch pdf: {e}")))?;
    Ok(())
}

async fn download_pdf(arxiv_id: &str, pdf_path: &Path) -> Result<(), AppError> {
    let url = format!("https://arxiv.org/pdf/{arxiv_id}");
    let tmp = pdf_path.with_extension("pdf.part");
    if let Err(e) = stream_pdf_to_file(&url, &tmp).await {
        // Rejected / aborted downloads must not leave partials behind.
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, pdf_path)
        .map_err(|e| AppError::message(format!("finalize scratch pdf: {e}")))?;
    Ok(())
}

/// Ensure the scratch copy (PDF + full-text markdown) for one arXiv paper
/// under `root`. Downloads and parses only when missing; papers are
/// immutable afterwards.
async fn ensure_paper_in(root: &Path, arxiv_id: &str) -> Result<ScratchPaper, AppError> {
    let id = arxiv_id.trim();
    validate_arxiv_id(id)?;
    let dir = root.join(id);
    let pdf_path = dir.join("paper.pdf");
    let markdown_path = dir.join("PAPER.md");

    if markdown_path.is_file() && pdf_path.is_file() {
        touch_last_used(&dir);
        return Ok(ScratchPaper {
            arxiv_id: id.to_string(),
            dir: dir.to_string_lossy().into_owned(),
            markdown_path: markdown_path.to_string_lossy().into_owned(),
            pdf_path: pdf_path.to_string_lossy().into_owned(),
            reused: true,
        });
    }

    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::message(format!("create scratch dir: {e}")))?;

    if !pdf_path.is_file() {
        download_pdf(id, &pdf_path).await?;
    }

    let mut messages = Vec::new();
    let outcome = parse_body_with_engine(&pdf_path, None, &mut messages).await?;
    if outcome.markdown.trim().is_empty() {
        return Err(AppError::message(format!(
            "scratch parse produced no text ({})",
            messages.join("; ")
        )));
    }
    let tmp = markdown_path.with_extension("md.part");
    std::fs::write(&tmp, outcome.markdown)
        .map_err(|e| AppError::message(format!("write scratch markdown: {e}")))?;
    std::fs::rename(&tmp, &markdown_path)
        .map_err(|e| AppError::message(format!("finalize scratch markdown: {e}")))?;
    touch_last_used(&dir);
    enforce_cap_in(root, &dir, MAX_TOTAL_BYTES);

    Ok(ScratchPaper {
        arxiv_id: id.to_string(),
        dir: dir.to_string_lossy().into_owned(),
        markdown_path: markdown_path.to_string_lossy().into_owned(),
        pdf_path: pdf_path.to_string_lossy().into_owned(),
        reused: false,
    })
}

pub async fn ensure_paper(arxiv_id: &str) -> Result<ScratchPaper, AppError> {
    let _guard = SCRATCH_MUTEX.lock().await;
    ensure_paper_in(&scratch_root(), arxiv_id).await
}

pub fn stats() -> ScratchStats {
    stats_in(&scratch_root())
}

fn stats_in(root: &Path) -> ScratchStats {
    let Ok(entries) = std::fs::read_dir(root) else {
        return ScratchStats::default();
    };
    let mut papers = 0u64;
    let mut bytes = 0u64;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        bytes += dir_size(&path);
        if path.join("PAPER.md").is_file() {
            papers += 1;
        }
    }
    ScratchStats { papers, bytes }
}

pub async fn clear() -> Result<ScratchClearResult, AppError> {
    let _guard = SCRATCH_MUTEX.lock().await;
    clear_in(&scratch_root())
}

fn clear_in(root: &Path) -> Result<ScratchClearResult, AppError> {
    if !root.exists() {
        return Ok(ScratchClearResult { freed_bytes: 0 });
    }
    let freed = dir_size(root);
    std::fs::remove_dir_all(root)
        .map_err(|e| AppError::message(format!("clear scratch cache: {e}")))?;
    Ok(ScratchClearResult { freed_bytes: freed })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join("agentero-scratch-tests")
            .join(format!("{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn accepts_new_style_ids() {
        assert!(validate_arxiv_id("2409.12345").is_ok());
        assert!(validate_arxiv_id("2409.12345v2").is_ok());
        assert!(validate_arxiv_id("1512.03385").is_ok());
    }

    #[test]
    fn rejects_traversal_and_old_style_ids() {
        for bad in [
            "../etc",
            "2409.12345/../../x",
            "2409.123",
            "24091.12345",
            "2409.12345v",
            "2409.12345v9999",
            "",
            "hep-th/9901001",
            "a2409.1234",
        ] {
            assert!(validate_arxiv_id(bad).is_err(), "{bad:?} should be invalid");
        }
    }

    #[test]
    fn stats_and_clear_roundtrip() {
        let root = tmp_root("stats");
        let paper = root.join("2409.00001");
        std::fs::create_dir_all(&paper).unwrap();
        std::fs::write(paper.join("PAPER.md"), "x").unwrap();
        std::fs::write(paper.join("paper.pdf"), "0123456789").unwrap();

        let stats = stats_in(&root);
        assert_eq!(stats.papers, 1);
        assert_eq!(stats.bytes, 11);

        let freed = clear_in(&root).unwrap();
        assert_eq!(freed.freed_bytes, 11);
        assert!(!root.exists());
    }

    #[test]
    fn eviction_is_oldest_first_and_keeps_fresh_entry() {
        let root = tmp_root("evict");
        let old = root.join("2409.00001");
        let fresh = root.join("2409.00002");
        for dir in [&old, &fresh] {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(dir.join("paper.pdf"), vec![0u8; 300]).unwrap();
        }
        // LRU order comes from the `.last-used` marker mtime, not the pdf's:
        // backdate the old entry's marker by an hour, leave `fresh` at now.
        let past = std::time::SystemTime::now() - Duration::from_secs(3600);
        for dir in [&old, &fresh] {
            std::fs::write(dir.join(LAST_USED_FILE), b"").unwrap();
        }
        let marker = std::fs::OpenOptions::new()
            .write(true)
            .open(old.join(LAST_USED_FILE))
            .unwrap();
        marker
            .set_times(std::fs::FileTimes::new().set_modified(past))
            .unwrap();
        drop(marker);

        enforce_cap_in(&root, &fresh, 300);

        assert!(!old.exists(), "oldest entry should be evicted");
        assert!(fresh.exists(), "entry being prepared must survive");
    }
}
