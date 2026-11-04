//! Vault-wide preparation preview. Only local catalog projections are repaired.
use super::{papers, preparation_reason, reconcile_body, PreparationReason};
use crate::error::AppError;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BackfillPaper {
    pub path: String,
    pub title: String,
    pub reason: PreparationReason,
}

#[derive(Debug, Default, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BackfillPreview {
    pub papers: Vec<BackfillPaper>,
    pub download_source: u32,
    pub parse_body: u32,
    pub repair_state: u32,
}

/// No network or body writes; repairs only derived catalog state and its sidecar.
pub fn preview(vault: &Path) -> Result<BackfillPreview, AppError> {
    let mut result = BackfillPreview::default();
    for paper in papers::list_all(vault)? {
        let Some(reason) = preparation_reason(vault, &paper) else {
            continue;
        };
        match reason {
            PreparationReason::DownloadSource => result.download_source += 1,
            PreparationReason::ParseBody => result.parse_body += 1,
            PreparationReason::RepairState => {
                reconcile_body(vault, &paper.path)?;
                result.repair_state += 1;
            }
        }
        result.papers.push(BackfillPaper {
            path: paper.path,
            title: paper.title,
            reason,
        });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::paper::source::{record_state, SourceStatus};
    use std::fs;

    #[test]
    fn preview_classifies_four_cases_repairs_locally_and_preserves_empty_markdown() {
        let vault = tempfile::tempdir().unwrap();
        for id in ["tex", "arxiv", "pdf", "empty"] {
            let dir = vault.path().join("papers").join(id);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("paper.pdf"), b"%PDF").unwrap();
            let mut paper = papers::PaperRecord::local_pdf(id.into(), id.into())
                .at_path(&format!("papers/{id}"));
            if id == "tex" {
                fs::write(dir.join("main.tex"), "\\documentclass{article}").unwrap();
            } else if id == "arxiv" {
                paper.arxiv_id = Some("1706.03762v1".into());
            } else if id == "empty" {
                fs::write(dir.join("PAPER.md"), "").unwrap();
            }
            papers::upsert_paper(vault.path(), &paper).unwrap();
        }
        let result = preview(vault.path()).unwrap();
        assert_eq!(
            (
                result.download_source,
                result.parse_body,
                result.repair_state
            ),
            (1, 2, 1)
        );
        assert_eq!(result.papers.len(), 4);
        assert_eq!(
            papers::get_by_path(vault.path(), "papers/tex")
                .unwrap()
                .unwrap()
                .body_source
                .as_deref(),
            Some("latex")
        );
        assert!(!vault.path().join("papers/pdf/PAPER.md").exists());
        assert!(!vault.path().join("papers/arxiv/source").exists());
        assert_eq!(
            fs::read(vault.path().join("papers/empty/PAPER.md")).unwrap(),
            b""
        );
        assert_eq!(preview(vault.path()).unwrap().repair_state, 0);

        // The source backoff and unavailable terminal state still apply even
        // when OCR already provides a readable body.
        let dir = vault.path().join("papers/arxiv");
        fs::write(dir.join("PAPER.md"), "existing OCR").unwrap();
        record_state(&dir, "1706.03762v1", SourceStatus::RetryableError, None).unwrap();
        assert_eq!(preview(vault.path()).unwrap().download_source, 0);
        record_state(&dir, "1706.03762v1", SourceStatus::Unavailable, None).unwrap();
        assert_eq!(preview(vault.path()).unwrap().download_source, 0);
        fs::write(vault.path().join("papers/pdf/PAPER.md"), "parsed body").unwrap();
        fs::write(vault.path().join("papers/empty/PAPER.md"), "recovered body").unwrap();
        assert!(preview(vault.path()).unwrap().papers.is_empty());
    }
}
