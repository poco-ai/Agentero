//! Fill an empty `code_repo` from the main PDF.
//!
//! Runs when a paper gains its main PDF, and once when an existing paper is
//! opened with the field still empty. A value already stored is left as-is.
//! Edit Metadata marks the field manual, including a clear, so a later scan
//! does not write it back. `meta_source` is not changed by the scan.

use std::path::Path;

#[cfg(not(any(target_os = "ios", target_os = "android")))]
use crate::error::AppError;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
use crate::features::catalog::{find_local_pdf, papers};

/// Best-effort. A missing PDF, an unreadable file, or no repository worth
/// storing leaves the row unchanged. Failures are logged and do not fail the import.
pub async fn fill_code_repo_from_pdf(vault: &Path, path_rel: &str) {
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        let _ = (vault, path_rel);
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    if let Err(error) = fill_code_repo_from_pdf_task(vault, path_rel).await {
        log::debug!(
            target: "agentero::import",
            "code repo scan skipped for {path_rel}: {error}"
        );
    }
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
async fn fill_code_repo_from_pdf_task(vault: &Path, path_rel: &str) -> Result<(), AppError> {
    let vault = vault.to_path_buf();
    let path_rel = path_rel.to_string();
    match tokio::task::spawn_blocking(move || fill_code_repo_from_pdf_sync(&vault, &path_rel)).await
    {
        Ok(result) => result,
        Err(error) => Err(AppError::message(format!("code repo scan failed: {error}"))),
    }
}

/// Open path. A paper whose PDF has no repository worth storing is remembered
/// for this process so later opens do not parse it again. A missing or
/// unreadable PDF is not remembered.
pub fn fill_code_repo_on_open(vault: &Path, path_rel: &str) {
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        let _ = (vault, path_rel);
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    if let Err(error) = fill_code_repo_on_open_sync(vault, path_rel) {
        log::debug!(
            target: "agentero::import",
            "code repo open scan skipped for {path_rel}: {error}"
        );
    }
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn fill_code_repo_on_open_sync(vault: &Path, path_rel: &str) -> Result<(), AppError> {
    let key = scan_key(vault, path_rel);
    if empty_scan_cache().contains(&key) {
        return Ok(());
    }
    if matches!(fill_once(vault, path_rel)?, Scan::NoRepo) {
        empty_scan_cache().insert(key);
    }
    Ok(())
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn fill_code_repo_from_pdf_sync(vault: &Path, path_rel: &str) -> Result<(), AppError> {
    fill_once(vault, path_rel).map(|_| ())
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
enum Scan {
    AlreadySet,
    NoPdf,
    Unreadable,
    NoRepo,
    Wrote,
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn fill_once(vault: &Path, path_rel: &str) -> Result<Scan, AppError> {
    let Some(mut record) = papers::get_by_path(vault, path_rel)? else {
        return Ok(Scan::AlreadySet);
    };
    if papers::code_repo_is_manual(vault, path_rel)?
        || record
            .code_repo
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
    {
        return Ok(Scan::AlreadySet);
    }
    let Some(pdf_path) = find_local_pdf(&vault.join(path_rel)) else {
        return Ok(Scan::NoPdf);
    };
    let bytes = match std::fs::read(&pdf_path) {
        Ok(bytes) => bytes,
        Err(error) => {
            log::debug!(
                target: "agentero::import",
                "code repo scan unreadable {}: {error}",
                pdf_path.display()
            );
            return Ok(Scan::Unreadable);
        }
    };
    let Some(found) = crate::features::pdf::github_repo::extract_github_repo(&bytes) else {
        return Ok(Scan::NoRepo);
    };
    let repo = found.url;
    record.code_repo = Some(repo.clone());
    record.updated_at = crate::time::now_rfc3339_millis();
    papers::upsert_paper(vault, &record)?;
    log::info!(
        target: "agentero::import",
        "code repo from PDF ({}, {}): {path_rel} -> {repo}",
        found.source,
        found.confidence
    );
    Ok(Scan::Wrote)
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn scan_key(vault: &Path, path_rel: &str) -> String {
    format!(
        "{}\0{path_rel}",
        crate::fs::canonicalize_best_effort(vault).display()
    )
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn empty_scan_cache() -> std::sync::MutexGuard<'static, std::collections::HashSet<String>> {
    use std::collections::HashSet;
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    CACHE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

#[cfg(all(test, not(any(target_os = "ios", target_os = "android"))))]
mod tests {
    use super::*;
    use crate::features::catalog::papers::{PaperMetaPatch, PaperRecord};
    use crate::features::pdf::tiny_pdf;

    #[tokio::test]
    async fn fills_empty_code_repo_and_keeps_a_hand_written_one() {
        let vault = tempfile::tempdir().unwrap();
        let paper_dir = vault.path().join("papers").join("demo");
        std::fs::create_dir_all(&paper_dir).unwrap();
        std::fs::write(
            paper_dir.join("demo.pdf"),
            tiny_pdf("Code: https://github.com/foo/bar"),
        )
        .unwrap();
        let record = PaperRecord::local_pdf("demo".into(), "Demo".into()).at_path("papers/demo");
        papers::upsert_paper(vault.path(), &record).unwrap();

        fill_code_repo_from_pdf(vault.path(), "papers/demo").await;
        let row = papers::get_by_path(vault.path(), "papers/demo")
            .unwrap()
            .unwrap();
        assert_eq!(row.code_repo.as_deref(), Some("https://github.com/foo/bar"));
        assert_eq!(row.meta_source.as_deref(), Some("local"));

        let mut handwritten = row;
        handwritten.code_repo = Some("https://github.com/kept/repo".into());
        papers::upsert_paper(vault.path(), &handwritten).unwrap();
        fill_code_repo_from_pdf(vault.path(), "papers/demo").await;
        let row = papers::get_by_path(vault.path(), "papers/demo")
            .unwrap()
            .unwrap();
        assert_eq!(
            row.code_repo.as_deref(),
            Some("https://github.com/kept/repo")
        );
    }

    #[test]
    fn open_scan_fills_an_empty_code_repo() {
        let vault = tempfile::tempdir().unwrap();
        let paper_dir = vault.path().join("papers").join("open");
        std::fs::create_dir_all(&paper_dir).unwrap();
        std::fs::write(
            paper_dir.join("open.pdf"),
            tiny_pdf("Code: https://github.com/open/scan"),
        )
        .unwrap();
        let record = PaperRecord::local_pdf("open".into(), "Open".into()).at_path("papers/open");
        papers::upsert_paper(vault.path(), &record).unwrap();

        fill_code_repo_on_open(vault.path(), "papers/open");
        let row = papers::get_by_path(vault.path(), "papers/open")
            .unwrap()
            .unwrap();
        assert_eq!(
            row.code_repo.as_deref(),
            Some("https://github.com/open/scan")
        );
    }

    #[test]
    fn a_cleared_code_repo_is_not_filled_again() {
        let vault = tempfile::tempdir().unwrap();
        let paper_dir = vault.path().join("papers").join("cleared");
        std::fs::create_dir_all(&paper_dir).unwrap();
        std::fs::write(
            paper_dir.join("cleared.pdf"),
            tiny_pdf("Code: https://github.com/auto/fill"),
        )
        .unwrap();
        let record =
            PaperRecord::local_pdf("cleared".into(), "Cleared".into()).at_path("papers/cleared");
        papers::upsert_paper(vault.path(), &record).unwrap();

        fill_code_repo_on_open(vault.path(), "papers/cleared");
        papers::update_meta(
            vault.path(),
            "papers/cleared",
            &PaperMetaPatch {
                code_repo: Some(String::new()),
                ..PaperMetaPatch::default()
            },
        )
        .unwrap();
        fill_code_repo_on_open(vault.path(), "papers/cleared");
        let row = papers::get_by_path(vault.path(), "papers/cleared")
            .unwrap()
            .unwrap();
        assert_eq!(row.code_repo, None);
        assert!(papers::code_repo_is_manual(vault.path(), "papers/cleared").unwrap());
    }
}
