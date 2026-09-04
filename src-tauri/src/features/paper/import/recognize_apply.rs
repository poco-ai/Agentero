//! Apply a deferred PDF-recognition result to an already-committed paper.
//!
//! Local PDF imports commit instantly with filename-derived metadata and a
//! placeholder folder id; the `RecognizeMetadata` job then resolves real
//! metadata and calls into this module to land it:
//!
//! - identifier hit → rename the paper folder to the canonical id through
//!   the link-aware wiki rename transaction (`papers/<slug>` →
//!   `papers/1706.03762`), including the `{id}.pdf` file and catalog paths;
//! - canonical entry already in the library → merge the placeholder into it
//!   (PDF becomes the main/attachment file, placeholder removed);
//! - title-only hit / no match → catalog metadata upsert in place.
//!
//! Every failure degrades to the metadata upsert — a paper is never lost or
//! left half-renamed because recognition could not be applied.

use super::AppHandle;
use crate::core::error::AppError;
use crate::features::catalog::papers::{self, PaperRecord};
use crate::features::catalog::CapsCache;
use crate::features::import::pdf_recognize::PdfIdentProbe;
use crate::features::import::{map, slug_from_stem};
use crate::features::lifecycle::{emit_paper_renamed, PaperRenamedEvent};
use crate::features::rename::{run_local_rename_transaction, WikiIndex};
use std::path::Path;
use std::sync::{Arc, Mutex};

/// Outcome of applying one recognition result.
#[derive(Debug)]
pub(crate) enum RecognizeApply {
    /// Folder renamed to the canonical id (`from` → `to`, vault-relative).
    Renamed { from: String, to: String },
    /// Canonical entry already existed; the placeholder was merged into it.
    Merged { into: String },
    /// Catalog metadata updated in place (no folder rename).
    MetaUpdated,
    /// Result not applied (paper gone, user edited meanwhile, unsafe rename).
    Skipped(&'static str),
}

/// Folder-safe canonical base id from a resolved probe: bare arXiv id or
/// DOI slug (mirrors identifier-import naming, e.g. `papers/1706.03762`).
fn canonical_base_id(probe: &PdfIdentProbe) -> Option<String> {
    probe
        .arxiv_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(slug_from_stem)
        .or_else(|| {
            probe
                .doi
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(map::doi_slug)
        })
        .filter(|s| !s.is_empty())
}

/// Copy the recognized fields onto a catalog row. Only `Some`/non-empty
/// probe values overwrite; placeholders start empty so this never discards
/// information. `meta_source` records the provenance (`recognize` /
/// `local-unresolved`).
fn apply_probe_fields(record: &mut PaperRecord, probe: &PdfIdentProbe, meta_source: &str) {
    fn take(slot: &mut Option<String>, incoming: &Option<String>) {
        if let Some(v) = incoming.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
            *slot = Some(v.to_string());
        }
    }
    if let Some(title) = probe
        .title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        record.title = title.to_string();
    }
    if !probe.authors.is_empty() {
        record.authors = probe.authors.clone();
    }
    if let Some(year) = probe.year {
        record.year = Some(year);
    }
    take(&mut record.doi, &probe.doi);
    take(&mut record.arxiv_id, &probe.arxiv_id);
    take(&mut record.abstract_text, &probe.abstract_text);
    take(&mut record.publication, &probe.publication);
    take(&mut record.volume, &probe.volume);
    take(&mut record.issue, &probe.issue);
    take(&mut record.pages, &probe.pages);
    take(&mut record.publisher, &probe.publisher);
    record.meta_source = Some(meta_source.to_string());
    record.updated_at = crate::core::time::now_rfc3339_millis();
}

/// Upsert recognized metadata without touching the folder; a changed title
/// also appends the new title to NOTES.md frontmatter aliases (same
/// convention as the Edit-Metadata flow).
fn meta_update_in_place(
    vault: &Path,
    record: &mut PaperRecord,
    probe: &PdfIdentProbe,
    meta_source: &str,
) -> Result<(), AppError> {
    let old_title = record.title.clone();
    let path = record.path.clone();
    apply_probe_fields(record, probe, meta_source);
    papers::upsert_paper(vault, record)?;
    if record.title != old_title {
        crate::features::wiki::append_title_alias_best_effort(vault, &path, &record.title);
    }
    Ok(())
}

/// Shared handle bundle threaded through the apply paths.
struct ApplyCtx<'a> {
    app: Option<&'a AppHandle>,
    vault: &'a Path,
    cache: Option<&'a CapsCache>,
}

/// Apply one recognition probe to the paper at `path_rel`.
pub(crate) async fn apply_probe_result(
    app: Option<&AppHandle>,
    vault: &Path,
    cache: Option<&CapsCache>,
    index: Arc<Mutex<WikiIndex>>,
    path_rel: &str,
    probe: &PdfIdentProbe,
) -> Result<RecognizeApply, AppError> {
    let ctx = ApplyCtx { app, vault, cache };
    let path_rel = path_rel.replace('\\', "/");
    let Some(mut record) = papers::get_by_path(vault, &path_rel)? else {
        return Ok(RecognizeApply::Skipped("paper-missing"));
    };
    // The user edited metadata (Edit-Metadata marks `manual`) before
    // recognition finished — their values win, skip entirely.
    if record.meta_source.as_deref().is_some_and(|s| s != "local") {
        return Ok(RecognizeApply::Skipped("user-edited"));
    }

    let Some(base) = canonical_base_id(probe) else {
        // No identifiers: a `title` hit still counts as recognized metadata;
        // anything else leaves the placeholder marked unresolved.
        let source = if probe.status == "ok" || probe.status == "title" {
            "recognize"
        } else {
            "local-unresolved"
        };
        meta_update_in_place(vault, &mut record, probe, source)?;
        return Ok(RecognizeApply::MetaUpdated);
    };

    let parent = Path::new(&path_rel)
        .parent()
        .and_then(|p| p.to_str())
        .unwrap_or("papers")
        .replace('\\', "/");
    let new_rel = format!("{parent}/{base}");
    if new_rel == path_rel {
        meta_update_in_place(vault, &mut record, probe, "recognize")?;
        return Ok(RecognizeApply::MetaUpdated);
    }

    // The canonical entry may already be in the library (imported earlier by
    // identifier, or the same PDF dropped twice) → merge instead of rename.
    let existing = match papers::get_by_path(vault, &new_rel)? {
        Some(target) if target.path != path_rel => Some(target),
        _ => match papers::get_by_id(vault, &base)? {
            Some(target) if target.path != path_rel => Some(target),
            _ => None,
        },
    };
    if let Some(target) = existing {
        return merge_placeholder_into(&ctx, &mut record, target, &path_rel, probe);
    }

    // A folder exists at the target without a catalog row (orphan) — never
    // clobber it; keep the placeholder and just land the metadata.
    if vault.join(&new_rel).exists() {
        log::warn!(target: "agentero::import",
            "recognize rename target exists without catalog row: {new_rel}");
        meta_update_in_place(vault, &mut record, probe, "recognize")?;
        return Ok(RecognizeApply::MetaUpdated);
    }

    rename_to_canonical(&ctx, index, record, &path_rel, &new_rel, base, probe).await
}

/// Rename the paper dir onto the link-aware wiki transaction:
/// `{dir}/{old}.pdf` → `{dir}/{base}.pdf`, then `papers/<old>` →
/// `papers/<base>` with catalog path rewrite inside the transaction and the
/// full metadata upsert after it. Any failure rolls the pdf rename back and
/// degrades to the in-place metadata update.
async fn rename_to_canonical(
    ctx: &ApplyCtx<'_>,
    index: Arc<Mutex<WikiIndex>>,
    mut record: PaperRecord,
    from_rel: &str,
    to_rel: &str,
    base: String,
    probe: &PdfIdentProbe,
) -> Result<RecognizeApply, AppError> {
    let (app, vault, cache) = (ctx.app, ctx.vault, ctx.cache);
    let dir = vault.join(from_rel);
    let old_pdf = dir.join(format!("{}.pdf", record.id));
    let new_pdf = dir.join(format!("{base}.pdf"));
    if !old_pdf.is_file() {
        meta_update_in_place(vault, &mut record, probe, "recognize")?;
        return Ok(RecognizeApply::MetaUpdated);
    }
    if let Err(e) = std::fs::rename(&old_pdf, &new_pdf) {
        // Typically the viewer holds the file open (Windows); metadata only.
        log::warn!(target: "agentero::import", "recognize pdf rename failed: {e}");
        meta_update_in_place(vault, &mut record, probe, "recognize")?;
        return Ok(RecognizeApply::MetaUpdated);
    }

    let vault_owned = vault.to_path_buf();
    let from_owned = from_rel.to_string();
    let to_owned = to_rel.to_string();
    let result = tokio::task::spawn_blocking(move || {
        let mut guard = index.lock().map_err(|e| e.to_string())?;
        run_local_rename_transaction(
            &vault_owned,
            &mut guard,
            &from_owned,
            &to_owned,
            &[],
            || {
                papers::move_under_path(&vault_owned, &from_owned, &to_owned)
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            },
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| AppError::message(format!("blocking task failed: {e}")))?;

    match result {
        Ok(rename_result) => {
            record.path = to_rel.to_string();
            record.id = base.clone();
            let old_title = record.title.clone();
            apply_probe_fields(&mut record, probe, "recognize");
            if let Err(e) = papers::upsert_paper(vault, &record) {
                // Paths are already consistent; stale metadata is recoverable
                // (Edit Metadata / re-recognition) — never fail the job.
                log::warn!(target: "agentero::import",
                    "post-rename metadata upsert failed: {e}");
            }
            if record.title != old_title {
                crate::features::wiki::append_title_alias_best_effort(vault, to_rel, &record.title);
            }
            if let Some(c) = cache {
                c.invalidate(vault, from_rel);
                c.invalidate(vault, to_rel);
            }
            #[cfg(feature = "desktop")]
            crate::features::usage::events::rename_path_best_effort(
                &vault.to_string_lossy(),
                from_rel,
                to_rel,
            );
            emit_paper_renamed(
                app,
                vault,
                PaperRenamedEvent {
                    old_paper_id: placeholder_id_from_path(from_rel),
                    new_paper_id: base,
                    old_path: from_rel.to_string(),
                    new_path: to_rel.to_string(),
                    outcome: "renamed".into(),
                    updated_sources: rename_result.updated_sources.clone(),
                },
            );
            Ok(RecognizeApply::Renamed {
                from: from_rel.to_string(),
                to: to_rel.to_string(),
            })
        }
        Err(message) => {
            // Roll the pre-rename pdf back so `{id}.pdf` stays consistent.
            let _ = std::fs::rename(&new_pdf, &old_pdf);
            log::warn!(target: "agentero::import",
                "recognize rename transaction failed, keeping placeholder: {message}");
            meta_update_in_place(vault, &mut record, probe, "recognize")?;
            Ok(RecognizeApply::MetaUpdated)
        }
    }
}

/// Merge the placeholder into an existing canonical entry: the PDF becomes
/// the entry's main `{id}.pdf` (when it has none) or lands in `attachments/`;
/// identifiers are backfilled, the placeholder row + folder are removed.
fn merge_placeholder_into(
    ctx: &ApplyCtx<'_>,
    record: &mut PaperRecord,
    mut target: PaperRecord,
    path_rel: &str,
    probe: &PdfIdentProbe,
) -> Result<RecognizeApply, AppError> {
    let (app, vault, cache) = (ctx.app, ctx.vault, ctx.cache);
    let placeholder_dir = vault.join(path_rel);
    let pdf = placeholder_dir.join(format!("{}.pdf", record.id));
    if !pdf.is_file() {
        meta_update_in_place(vault, record, probe, "recognize")?;
        return Ok(RecognizeApply::MetaUpdated);
    }

    let target_dir = vault.join(&target.path);
    let main_pdf = target_dir.join(format!("{}.pdf", target.id));
    let dest = if !main_pdf.is_file() {
        main_pdf
    } else {
        let attachments = target_dir.join("attachments");
        std::fs::create_dir_all(&attachments)?;
        crate::features::import::paper_import::unique_attachment_path(&attachments, &pdf)
    };
    if let Err(e) = std::fs::rename(&pdf, &dest) {
        log::warn!(target: "agentero::import", "merge pdf move failed: {e}");
        meta_update_in_place(vault, record, probe, "recognize")?;
        return Ok(RecognizeApply::MetaUpdated);
    }

    for (slot, incoming) in [
        (&mut target.arxiv_id, &probe.arxiv_id),
        (&mut target.doi, &probe.doi),
    ] {
        if slot.is_none() {
            if let Some(v) = incoming.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
                *slot = Some(v.to_string());
            }
        }
    }
    target.updated_at = crate::core::time::now_rfc3339_millis();
    papers::upsert_paper(vault, &target)?;

    papers::delete_under_path(vault, path_rel)?;
    if let Err(e) = std::fs::remove_dir_all(&placeholder_dir) {
        log::warn!(target: "agentero::import",
            "placeholder folder removal failed: {e} ({path_rel})");
    }

    if let Some(c) = cache {
        c.invalidate(vault, path_rel);
        c.invalidate(vault, &target.path);
    }

    emit_paper_renamed(
        app,
        vault,
        PaperRenamedEvent {
            old_paper_id: record.id.clone(),
            new_paper_id: target.id.clone(),
            old_path: path_rel.to_string(),
            new_path: target.path.clone(),
            outcome: "merged".into(),
            updated_sources: Vec::new(),
        },
    );

    Ok(RecognizeApply::Merged { into: target.path })
}

fn placeholder_id_from_path(path_rel: &str) -> String {
    Path::new(path_rel)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::import::map::local_pdf_meta;
    use crate::features::import::paper_record_from_meta;
    use std::path::PathBuf;

    fn temp_vault() -> PathBuf {
        let vault =
            std::env::temp_dir().join(format!("agentero-recognize-apply-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&vault).expect("create vault");
        vault
    }

    fn commit_placeholder(vault: &Path, id: &str) -> PaperRecord {
        let dir = vault.join(format!("papers/{id}"));
        std::fs::create_dir_all(&dir).expect("create paper dir");
        std::fs::write(dir.join(format!("{id}.pdf")), b"%PDF-1.4 fake").expect("write pdf");
        std::fs::write(dir.join("NOTES.md"), "# Placeholder\n").expect("write notes");
        let meta = local_pdf_meta(id.to_string(), "Placeholder Title".into());
        let record = paper_record_from_meta(&format!("papers/{id}"), &meta);
        papers::upsert_paper(vault, &record).expect("upsert placeholder")
    }

    fn probe(status: &str, arxiv: Option<&str>, title: Option<&str>) -> PdfIdentProbe {
        PdfIdentProbe {
            file_path: "x.pdf".into(),
            status: status.into(),
            error: None,
            doi: None,
            arxiv_id: arxiv.map(str::to_string),
            title: title.map(str::to_string),
            authors: vec!["A Author".into()],
            year: Some(2017),
            abstract_text: None,
            publication: None,
            volume: None,
            issue: None,
            pages: None,
            publisher: None,
            source: "crossref".into(),
        }
    }

    #[tokio::test]
    async fn renames_placeholder_to_canonical_id() {
        let vault = temp_vault();
        commit_placeholder(&vault, "attention-paper");
        let index = Arc::new(Mutex::new(WikiIndex::default()));

        let outcome = apply_probe_result(
            None,
            &vault,
            None,
            index,
            "papers/attention-paper",
            &probe("ok", Some("1706.03762"), Some("Attention Is All You Need")),
        )
        .await
        .expect("apply");

        match outcome {
            RecognizeApply::Renamed { from, to } => {
                assert_eq!(from, "papers/attention-paper");
                assert_eq!(to, "papers/1706.03762");
            }
            other => panic!("expected Renamed, got {other:?}"),
        }
        assert!(!vault.join("papers/attention-paper").exists());
        assert!(vault.join("papers/1706.03762/1706.03762.pdf").is_file());
        let row = papers::get_by_path(&vault, "papers/1706.03762")
            .expect("row")
            .expect("exists");
        assert_eq!(row.id, "1706.03762");
        assert_eq!(row.title, "Attention Is All You Need");
        assert_eq!(row.meta_source.as_deref(), Some("recognize"));
        assert!(papers::get_by_path(&vault, "papers/attention-paper")
            .expect("row")
            .is_none());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[tokio::test]
    async fn merges_into_existing_canonical_entry() {
        let vault = temp_vault();
        commit_placeholder(&vault, "attention-paper");
        // Existing canonical entry without a local PDF.
        let dir = vault.join("papers/1706.03762");
        std::fs::create_dir_all(&dir).expect("canonical dir");
        std::fs::write(dir.join("NOTES.md"), "# Canonical\n").expect("notes");
        let mut meta = local_pdf_meta("1706.03762".into(), "Attention Is All You Need".into());
        meta.arxiv_id = Some("1706.03762".into());
        let canonical = paper_record_from_meta("papers/1706.03762", &meta);
        papers::upsert_paper(&vault, &canonical).expect("upsert canonical");

        let index = Arc::new(Mutex::new(WikiIndex::default()));
        let outcome = apply_probe_result(
            None,
            &vault,
            None,
            index,
            "papers/attention-paper",
            &probe("ok", Some("1706.03762"), Some("Attention Is All You Need")),
        )
        .await
        .expect("apply");

        match outcome {
            RecognizeApply::Merged { into } => assert_eq!(into, "papers/1706.03762"),
            other => panic!("expected Merged, got {other:?}"),
        }
        assert!(!vault.join("papers/attention-paper").exists());
        assert!(vault.join("papers/1706.03762/1706.03762.pdf").is_file());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[tokio::test]
    async fn title_only_updates_metadata_in_place() {
        let vault = temp_vault();
        commit_placeholder(&vault, "attention-paper");
        let index = Arc::new(Mutex::new(WikiIndex::default()));

        let outcome = apply_probe_result(
            None,
            &vault,
            None,
            index,
            "papers/attention-paper",
            &probe("title", None, Some("Recognized Title")),
        )
        .await
        .expect("apply");

        assert!(matches!(outcome, RecognizeApply::MetaUpdated));
        assert!(vault
            .join("papers/attention-paper/attention-paper.pdf")
            .is_file());
        let row = papers::get_by_path(&vault, "papers/attention-paper")
            .expect("row")
            .expect("exists");
        assert_eq!(row.title, "Recognized Title");
        assert_eq!(row.meta_source.as_deref(), Some("recognize"));
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[tokio::test]
    async fn skips_when_user_edited_metadata_meanwhile() {
        let vault = temp_vault();
        commit_placeholder(&vault, "attention-paper");
        let mut row = papers::get_by_path(&vault, "papers/attention-paper")
            .expect("row")
            .expect("exists");
        row.meta_source = Some("manual".into());
        papers::upsert_paper(&vault, &row).expect("mark manual");

        let index = Arc::new(Mutex::new(WikiIndex::default()));
        let outcome = apply_probe_result(
            None,
            &vault,
            None,
            index,
            "papers/attention-paper",
            &probe("ok", Some("1706.03762"), Some("Attention Is All You Need")),
        )
        .await
        .expect("apply");

        assert!(matches!(outcome, RecognizeApply::Skipped("user-edited")));
        assert!(vault.join("papers/attention-paper").exists());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[tokio::test]
    async fn no_match_marks_unresolved() {
        let vault = temp_vault();
        commit_placeholder(&vault, "attention-paper");
        let index = Arc::new(Mutex::new(WikiIndex::default()));

        let outcome = apply_probe_result(
            None,
            &vault,
            None,
            index,
            "papers/attention-paper",
            &probe("no-match", None, None),
        )
        .await
        .expect("apply");

        assert!(matches!(outcome, RecognizeApply::MetaUpdated));
        let row = papers::get_by_path(&vault, "papers/attention-paper")
            .expect("row")
            .expect("exists");
        assert_eq!(row.meta_source.as_deref(), Some("local-unresolved"));
        let _ = std::fs::remove_dir_all(&vault);
    }
}
