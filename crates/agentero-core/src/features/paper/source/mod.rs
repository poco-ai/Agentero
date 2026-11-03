//! Validated paper source and acquisition state, shared by import, parse and context.
pub mod tex;

use crate::{error::AppError, features::paper::catalog::papers};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeSet, HashMap},
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
};

pub const STATE_FILE: &str = "agentero-source.json";
const MAX_SOURCE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_FILES: usize = 512;
const RETRY_SECONDS: i64 = 15 * 60;

pub fn arxiv_request(paper: &papers::PaperRecord) -> Option<String> {
    asset_request(
        paper.arxiv_id.as_deref(),
        paper.pdf_url.as_deref(),
        paper.source_url.as_deref(),
    )
}

pub fn asset_request(
    id: Option<&str>,
    pdf_url: Option<&str>,
    source_url: Option<&str>,
) -> Option<String> {
    use super::scholar_api::identifiers::{extract_arxiv_request, strip_arxiv_version};
    let id = extract_arxiv_request(id?)?;
    let bare = strip_arxiv_version(&id);
    for candidate in [pdf_url, source_url, Some(id.as_str())]
        .into_iter()
        .flatten()
    {
        if let Some(request) = extract_arxiv_request(candidate) {
            if strip_arxiv_version(&request) == bare && request != bare {
                return Some(request);
            }
        }
    }
    Some(id)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SourceStatus {
    Ready,
    Unavailable,
    RetryableError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceState {
    pub arxiv_id: String,
    pub status: SourceStatus,
    pub attempted_at: i64,
    #[serde(default)]
    pub error: Option<String>,
}

pub fn matches_request(expected: &str, actual: &str) -> bool {
    let bare = super::scholar_api::identifiers::strip_arxiv_version(expected);
    expected == actual
        || (expected == bare
            && super::scholar_api::identifiers::strip_arxiv_version(actual) == bare)
}

/// Reuse the first-page native-text probe's arXiv stamp, retaining its version.
pub fn version_from_text(text: &str, bare: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    let mut rest = lower.as_str();
    while let Some(index) = rest.find("arxiv:") {
        rest = &rest[index + 6..];
        let candidate: String = rest
            .trim_start()
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '/' | '-'))
            .collect();
        if let Some(id) = super::scholar_api::identifiers::extract_arxiv_request(&candidate) {
            if id != bare && super::scholar_api::identifiers::strip_arxiv_version(&id) == bare {
                return Some(id);
            }
        }
    }
    None
}

pub fn state(paper_dir: &Path) -> Option<SourceState> {
    serde_json::from_slice(&fs::read(paper_dir.join("source").join(STATE_FILE)).ok()?).ok()
}

pub fn record_state(
    paper_dir: &Path,
    arxiv_id: &str,
    status: SourceStatus,
    error: Option<String>,
) -> Result<(), AppError> {
    let dir = paper_dir.join("source");
    fs::create_dir_all(&dir)?;
    crate::fs::json_store(
        &dir.join(STATE_FILE),
        &SourceState {
            arxiv_id: arxiv_id.into(),
            status,
            attempted_at: chrono::Utc::now().timestamp(),
            error,
        },
    )
}

/// Missing source assets stay visible independently of an OCR Markdown or the
/// automatic retry backoff. PDF-only is terminal for this version.
pub fn needs_source(paper_dir: &Path, arxiv_id: Option<&str>) -> bool {
    let Some(id) = arxiv_id.filter(|id| !id.trim().is_empty()) else {
        return false;
    };
    if read_tex(paper_dir).is_some() {
        return false;
    }
    !matches!(state(paper_dir).filter(|s| matches_request(id, &s.arxiv_id)), Some(s) if s.status == SourceStatus::Unavailable)
}

pub fn retry_due(paper_dir: &Path, arxiv_id: &str) -> bool {
    needs_source(paper_dir, Some(arxiv_id))
        && state(paper_dir).is_none_or(|s| {
            !matches_request(arxiv_id, &s.arxiv_id)
                || s.status != SourceStatus::RetryableError
                || chrono::Utc::now()
                    .timestamp()
                    .saturating_sub(s.attempted_at)
                    >= RETRY_SECONDS
        })
}

pub fn automatic_download_allowed(vault: &Path) -> bool {
    download_allowed_in(vault, crate::features::sync::config::list_all())
}

fn download_allowed_in(
    vault: &Path,
    configs: HashMap<String, crate::features::sync::config::SyncBackendConfig>,
) -> bool {
    let canonical = crate::fs::canonicalize_best_effort(vault);
    configs
        .into_iter()
        .find(|(path, _)| crate::fs::canonicalize_best_effort(Path::new(path)) == canonical)
        .is_none_or(|(_, config)| config.scope.source)
}

pub fn needs_preparation(vault: &Path, paper: &papers::PaperRecord) -> bool {
    let dir = vault.join(&paper.path);
    let caps = super::capabilities::probe_paper_caps(&dir);
    caps.needs_paper_md()
        || (automatic_download_allowed(vault)
            && arxiv_request(paper).is_some_and(|id| retry_due(&dir, &id)))
        || (caps.has_tex && paper.body_source.as_deref() != Some("latex"))
        || (!caps.has_tex
            && (paper.body_source.as_deref() == Some("latex")
                || (!caps.has_paper_md && paper.body_source.is_some())))
}

/// One lock covers source publication and body-result publication. Weak entries
/// do not retain every paper ever opened. Cancellation while waiting is polled.
pub async fn lock(
    paper_dir: &Path,
    task_id: Option<&str>,
) -> Result<tokio::sync::OwnedMutexGuard<()>, AppError> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let key = crate::fs::canonicalize_best_effort(paper_dir);
    let mutex = {
        let mut entries = LOCKS
            .get_or_init(Mutex::default)
            .lock()
            .expect("paper source locks poisoned");
        entries.retain(|_, value| value.strong_count() > 0);
        let mutex = entries
            .get(&key)
            .and_then(Weak::upgrade)
            .unwrap_or_else(|| Arc::new(tokio::sync::Mutex::new(())));
        entries.insert(key, Arc::downgrade(&mutex));
        mutex
    };
    loop {
        crate::features::paper::import::check_task_not_cancelled(task_id)?;
        tokio::select! {
            guard = mutex.clone().lock_owned() => return Ok(guard),
            _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {}
        }
    }
}

#[derive(Debug, Clone)]
pub struct TexSource {
    pub root: PathBuf,
    pub text: String,
}

fn read_text(path: &Path) -> Option<String> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(MAX_SOURCE_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_SOURCE_BYTES || bytes.contains(&0) {
        return None;
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    // An empty (or whitespace-only) file is valid TeX — e.g. a chapter file a
    // submission leaves blank. Root selection relies on `has_indicator`, not on
    // non-empty text, so this must not reject an `\input` of such a file.
    let trimmed = text.trim_start().to_ascii_lowercase();
    if trimmed.starts_with("<html")
        || trimmed.starts_with("<!doctype")
        || trimmed.starts_with("%pdf")
    {
        return None;
    }
    Some(text)
}

fn tex_files(dir: &Path, depth: usize, files: &mut Vec<PathBuf>) {
    if depth > 24 || files.len() >= MAX_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.starts_with('.') || name.eq_ignore_ascii_case("attachments") {
            continue;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            tex_files(&entry.path(), depth + 1, files);
        } else if kind.is_file()
            && entry
                .path()
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("tex") || e.eq_ignore_ascii_case("ltx"))
        {
            files.push(entry.path());
        }
        if files.len() >= MAX_FILES {
            break;
        }
    }
}

fn gather(
    file: &Path,
    project: &Path,
    boundary: &Path,
    seen: &mut BTreeSet<PathBuf>,
    text: &mut String,
    mut in_body: bool,
) -> Option<()> {
    let file = fs::canonicalize(file).ok()?;
    if !file.starts_with(boundary)
        || seen.len() >= MAX_FILES
        || file.strip_prefix(boundary).ok()?.components().any(|c| {
            c.as_os_str()
                .to_str()
                .is_some_and(|s| s.eq_ignore_ascii_case("attachments"))
        })
    {
        return None;
    }
    if !seen.insert(file.clone()) {
        return Some(());
    }
    let content = tex::strip_comments(&read_text(&file)?);
    if text.len() + content.len() > MAX_SOURCE_BYTES as usize {
        return None;
    }
    text.push_str(&format!(
        "\n% Source: {}\n",
        file.strip_prefix(boundary).ok()?.display()
    ));
    let mut cursor = 0;
    for (range, reference) in tex::input_commands(&content) {
        text.push_str(&content[cursor..range.start]);
        in_body |= content[cursor..range.start].contains("\\begin{document}");
        cursor = range.end;
        if reference.contains(['\\', '#', '{']) {
            text.push_str(&content[range]);
            continue;
        }
        let child = tex::resolve_input(file.parent()?, &reference)
            .or_else(|| tex::resolve_input(project, &reference));
        let Some(child) = child else {
            if in_body {
                return None;
            }
            // Preamble inputs may belong to the user's TeX distribution, e.g.
            // glyphtounicode. Reading the paper does not require that toolchain.
            text.push_str(&content[range]);
            continue;
        };
        gather(&child, project, boundary, seen, text, in_body)?;
    }
    text.push_str(&content[cursor..]);
    (text.len() <= MAX_SOURCE_BYTES as usize).then_some(())
}

pub fn contains_tex_files(dir: &Path) -> bool {
    let mut files = Vec::new();
    tex_files(dir, 0, &mut files);
    !files.is_empty()
}

/// Deterministic main document + literal input/include closure. Never executes
/// TeX, follows external symlinks, or reads attachments as the paper body.
pub fn read_tex(paper_dir: &Path) -> Option<TexSource> {
    let boundary = fs::canonicalize(paper_dir).ok()?;
    let mut files = Vec::new();
    tex_files(&boundary, 0, &mut files);
    files.sort_by_key(|p| {
        let main = p.file_stem().and_then(|s| s.to_str()).is_some_and(|s| {
            ["main", "paper", "manuscript", "article"]
                .iter()
                .any(|name| s.eq_ignore_ascii_case(name))
        });
        (!main, p.components().count(), p.clone())
    });
    for root in files {
        let Some(content) = read_text(&root) else {
            continue;
        };
        let content = tex::strip_comments(&content);
        if !tex::has_indicator(&content) {
            continue;
        }
        let mut text = String::new();
        if gather(
            &root,
            root.parent()?,
            &boundary,
            &mut BTreeSet::new(),
            &mut text,
            false,
        )
        .is_some()
        {
            return Some(TexSource { root, text });
        }
    }
    None
}

/// Derived catalog fields are projections of the selected body, never proof
/// that files still exist. Patch under the existing SQLite write reservation.
pub fn reconcile_body(vault: &Path, path: &str) -> Result<(), AppError> {
    let dir = vault.join(path);
    let Some(record) = papers::get_by_path(vault, path)? else {
        return Ok(());
    };
    let tex = read_tex(&dir).is_some();
    let markdown = dir.join("PAPER.md").is_file();
    if tex && record.body_source.as_deref() == Some("latex") {
        return Ok(());
    }
    let body = if tex {
        Some(("latex", "high"))
    } else if markdown && record.body_source.as_deref() != Some("latex") {
        return Ok(());
    } else {
        None
    };
    if body.is_none() && record.body_source.is_none() && record.body_quality.is_none() {
        return Ok(());
    }
    papers::set_body_source(vault, path, body)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const MAIN: &str = "\\documentclass{article}\\begin{document}\\section{Intro}\\input{parts/intro}\\section{Method}\\include{parts/method}\\end{document}";

    #[test]
    fn reads_valid_project_in_order_and_rejects_missing_or_fake_sources() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("source/parts")).unwrap();
        fs::write(dir.path().join("source/main.tex"), MAIN).unwrap();
        assert!(read_tex(dir.path()).is_none());
        fs::write(dir.path().join("source/parts/intro.tex"), "INTRO-SENTINEL").unwrap();
        fs::write(
            dir.path().join("source/parts/method.tex"),
            "METHOD-SENTINEL",
        )
        .unwrap();
        let source = read_tex(dir.path()).unwrap();
        assert!(
            source.text.find("INTRO-SENTINEL").unwrap()
                < source.text.find("\\section{Method}").unwrap()
        );
        assert!(source.text.contains("METHOD-SENTINEL"));
        fs::write(dir.path().join("source/main.tex"), "").unwrap();
        assert!(read_tex(dir.path()).is_none());
        fs::write(
            dir.path().join("source/main.tex"),
            "<html>\\documentclass{article}</html>",
        )
        .unwrap();
        assert!(read_tex(dir.path()).is_none());
    }

    #[test]
    fn blank_included_file_does_not_fail_the_project() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("source/chapters")).unwrap();
        fs::write(
            dir.path().join("source/main.tex"),
            "\\documentclass{article}\\begin{document}INTRO-SENTINEL\\input{chapters/blank}\\end{document}",
        )
        .unwrap();
        // arXiv submissions leave unedited chapter files blank; the whole
        // project must still read (Kimi Linear, 2510.26692).
        fs::write(dir.path().join("source/chapters/blank.tex"), "\n\n\n").unwrap();
        let source = read_tex(dir.path()).unwrap();
        assert!(source.text.contains("INTRO-SENTINEL"));
    }

    #[test]
    fn source_repair_is_independent_of_ocr_and_distinguishes_pdf_only_and_retry() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("PAPER.md"), "old OCR").unwrap();
        assert!(needs_source(dir.path(), Some("1706.03762v1")));
        record_state(dir.path(), "1706.03762v1", SourceStatus::Unavailable, None).unwrap();
        assert!(!needs_source(dir.path(), Some("1706.03762v1")));
        assert!(needs_source(dir.path(), Some("1706.03762v2")));
        record_state(
            dir.path(),
            "1706.03762v1",
            SourceStatus::RetryableError,
            Some("HTTP 429".into()),
        )
        .unwrap();
        assert!(needs_source(dir.path(), Some("1706.03762v1")));
        assert!(!retry_due(dir.path(), "1706.03762v1"));
        let mut state = state(dir.path()).unwrap();
        state.attempted_at -= RETRY_SECONDS + 1;
        crate::fs::json_store(&dir.path().join("source").join(STATE_FILE), &state).unwrap();
        assert!(needs_source(dir.path(), Some("1706.03762v1")));
    }

    #[test]
    fn ignores_attachment_roots_and_rejects_escaped_inputs() {
        let dir = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("attachments")).unwrap();
        fs::write(
            dir.path().join("attachments/main.tex"),
            "\\documentclass{article}",
        )
        .unwrap();
        assert!(read_tex(dir.path()).is_none());
        fs::write(other.path().join("private.tex"), "PRIVATE-SENTINEL").unwrap();
        // `Display` uses `\` on Windows, which the TeX scanner treats as an
        // escape and keeps verbatim. A slash-separated absolute path is still
        // outside the paper and must not be read.
        let outside = other
            .path()
            .join("private.tex")
            .to_string_lossy()
            .replace('\\', "/");
        fs::write(
            dir.path().join("main.tex"),
            format!("\\documentclass{{article}}\\input{{{outside}}}"),
        )
        .unwrap();
        assert!(read_tex(dir.path()).is_none());
    }

    #[tokio::test]
    async fn source_lock_serializes_publishers_and_waiting_can_be_cancelled() {
        let dir = tempfile::tempdir().unwrap();
        let first = lock(dir.path(), None).await.unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), lock(dir.path(), None))
                .await
                .is_err()
        );
        drop(first);
        assert!(lock(dir.path(), None).await.is_ok());
        let id = format!("source-lock-cancel-{}", uuid::Uuid::new_v4());
        crate::cancel::testing::cancel(&id);
        assert!(lock(dir.path(), Some(&id)).await.is_err());
        crate::cancel::testing::finish(&id);
    }

    #[test]
    fn pinned_pdf_identity_and_native_stamp_keep_arxiv_versions() {
        let mut paper = papers::PaperRecord::local_pdf("1706.03762".into(), "Title".into());
        paper.arxiv_id = Some("1706.03762".into());
        paper.pdf_url = Some("https://arxiv.org/pdf/1706.03762v1".into());
        assert_eq!(arxiv_request(&paper).as_deref(), Some("1706.03762v1"));
        assert_eq!(
            version_from_text("arXiv:1706.03762v3 [cs.CL]", "1706.03762").as_deref(),
            Some("1706.03762v3")
        );
        assert!(version_from_text("arXiv:2401.00001v3", "1706.03762").is_none());
        assert!(matches_request("1706.03762", "1706.03762v3"));
        assert!(!matches_request("1706.03762v1", "1706.03762v3"));
    }

    #[test]
    fn excluded_source_policy_survives_canonical_vault_path_aliases() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = crate::features::sync::config::SyncBackendConfig::default();
        config.scope.source = false;
        let configs =
            HashMap::from([(dir.path().join(".").to_string_lossy().into_owned(), config)]);
        assert!(!download_allowed_in(
            &fs::canonicalize(dir.path()).unwrap(),
            configs
        ));
    }

    #[test]
    fn body_projection_repairs_source_upgrade_and_removal_without_losing_metadata() {
        let vault = tempfile::tempdir().unwrap();
        let dir = vault.path().join("papers/p");
        fs::create_dir_all(dir.join("source")).unwrap();
        let mut paper =
            papers::PaperRecord::local_pdf("p".into(), "User title".into()).at_path("papers/p");
        paper.body_source = Some("ocr".into());
        papers::upsert_paper(vault.path(), &paper).unwrap();
        fs::write(dir.join("source/main.tex"), "\\documentclass{article}").unwrap();
        reconcile_body(vault.path(), "papers/p").unwrap();
        let row = papers::get_by_path(vault.path(), "papers/p")
            .unwrap()
            .unwrap();
        assert_eq!(row.body_source.as_deref(), Some("latex"));
        assert_eq!(row.title, "User title");
        fs::write(dir.join("PAPER.md"), "old OCR fallback").unwrap();
        fs::remove_file(dir.join("source/main.tex")).unwrap();
        assert!(needs_preparation(vault.path(), &row));
        reconcile_body(vault.path(), "papers/p").unwrap();
        assert!(papers::get_by_path(vault.path(), "papers/p")
            .unwrap()
            .unwrap()
            .body_source
            .is_none());
    }
}
