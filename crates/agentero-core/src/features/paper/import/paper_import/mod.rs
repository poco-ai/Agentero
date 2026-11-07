//! Unified paper commit: the single authoritative dedupe → path → shell →
//! catalog → assets pipeline behind every local import entry (magic wand,
//! Zotero Connector, local PDF, Bib/RIS). Entries stay thin source adapters
//! that produce a mapped [`papers::PaperRecord`] and pick policies here.
//!
//! @see docs/backend/paper-import-pipeline.md

use crate::app_handle::AppHandle;
use crate::error::AppError;
use crate::features::catalog::{papers, probe_paper_caps, CapsCache};
use crate::features::import::preparation::{
    plan_after_assets, plan_after_merged_pdf, PreparationPlan,
};
use crate::features::import::{
    allocate_paper_path, ensure_paper_assets_with_progress, normalize_parent_dir,
    write_paper_shell_opts, AssetDownloadResult, AssetProgressContext, NoteShellMode,
};
use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum CommitStatus {
    /// New paper folder + catalog row were written.
    Created,
    /// Catalog already had this paper; existing path returned, nothing touched.
    Deduped,
    /// `{parent}/{id}` already holds a paper (dir + NOTES or catalog row).
    Skipped,
}

/// How to detect "this paper is already in the library" before writing.
pub enum DedupePolicy {
    /// Catalog has a row with the same `id` → `Deduped` (single-item entries).
    ByCatalogId,
    /// Catalog row shares a canonical id or identifier (arXiv ID, DOI, PMID, ISBN)
    /// → `Deduped`. With `CopyPdf`, the local PDF is merged into the existing
    /// folder instead of being discarded (Fix #406).
    ByIdentifiers,
    /// `{parent}/{id}` exists with NOTES.md, or catalog has that path →
    /// `Skipped` (batch Bib/RIS compatibility).
    ByPathOrNotes,
    /// No dedupe; the path allocator still avoids folder collisions.
    None,
}

/// How the paper body/PDF is produced after shell + catalog are written.
pub enum AssetsPolicy<'a> {
    /// Await `ensure_paper_assets` (+ liteparse). Asset flags in the result
    /// are final. Errors become `asset_messages`, never a failed commit.
    SyncDownload {
        cookies: Option<&'a str>,
        progress: AssetProgressContext<'a>,
    },
    /// Copy a local PDF into the folder root as `{id}.pdf` (+ liteparse).
    CopyPdf {
        src: &'a Path,
        progress: AssetProgressContext<'a>,
    },
    /// Shell + catalog only; the adapter downloads in the background
    /// (Connector must answer inside the browser extension's ~15s timeout).
    Deferred,
}

pub struct PaperCommitOptions<'a> {
    pub vault: &'a Path,
    /// Raw parent dir (normalized here), e.g. `papers` or `papers/nlp`.
    pub parent_dir: &'a str,
    pub dedupe: DedupePolicy,
    pub assets: AssetsPolicy<'a>,
    /// zh-CN abstract MT in the NOTES shell (Connector passes `false`).
    pub translate_abstract: bool,
    /// NOTES.md shell generation mode (settings `paperNoteMode`).
    pub note_mode: NoteShellMode,
    /// Stamp `added_at` / `updated_at` with now (Connector semantics).
    pub fresh_timestamps: bool,
    /// Optional in-memory caps cache; avoids repeated directory walks.
    pub cache: Option<&'a CapsCache>,
    /// Lifecycle event sink (`paper:imported` / `paper:assets-ready`).
    pub app: Option<&'a AppHandle>,
    /// Omit ParseBody/ParseRefs from the returned [`PreparationPlan`].
    /// Deferred-recognition imports add `RecognizeMetadata` and run parse
    /// after the final path is known (rename/merge).
    pub defer_parse_jobs: bool,
}

/// Uniform result shape for every entry (camelCase matches the frontend).
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PaperCommitResult {
    pub status: CommitStatus,
    /// Vault-relative paper folder.
    pub path: String,
    pub id: String,
    pub title: String,
    /// Absolute paper folder.
    pub paper_dir: String,
    pub pdf: bool,
    pub tex: bool,
    pub paper_md: bool,
    pub asset_messages: Vec<String>,
    /// True when assets are still downloading in the background (`Deferred`).
    pub assets_pending: bool,
    /// Follow-up steps for this commit. Not part of the IPC payload.
    #[serde(skip)]
    #[specta(skip)]
    pub preparation: PreparationPlan,
}

/// Commit one paper draft to the vault. Fixed step order:
/// normalize parent → id check → dedupe early-return → allocate path
/// (adopting the possibly suffixed folder id into `meta.id`) → shell →
/// catalog upsert → assets/liteparse → uniform result.
pub async fn paper_commit(
    mut meta: papers::PaperRecord,
    opts: PaperCommitOptions<'_>,
) -> Result<PaperCommitResult, AppError> {
    let vault = opts.vault;
    crate::fs::ensure_vault_dir(vault)?;
    let parent_rel = normalize_parent_dir(opts.parent_dir)?;
    if meta.id.is_empty() {
        return Err(AppError::message("resolved metadata has empty id"));
    }

    match opts.dedupe {
        DedupePolicy::ByCatalogId => {
            if let Ok(Some(existing)) = papers::get_by_id(vault, &meta.id) {
                let existing = repair_existing_import_shell(vault, existing, &meta, &opts).await?;
                let dir = vault.join(&existing.path);
                return Ok(existing_result(
                    CommitStatus::Deduped,
                    existing,
                    vault,
                    &dir,
                    opts.cache,
                ));
            }
        }
        DedupePolicy::ByIdentifiers => {
            if let Some(existing) = find_existing_by_identifiers(vault, &meta)? {
                if let AssetsPolicy::CopyPdf { src, .. } = &opts.assets {
                    return merge_pdf_into_existing(
                        vault, existing, src, &meta, opts.cache, opts.app,
                    )
                    .await;
                }
                let existing = repair_existing_import_shell(vault, existing, &meta, &opts).await?;
                let dir = vault.join(&existing.path);
                return Ok(existing_result(
                    CommitStatus::Deduped,
                    existing,
                    vault,
                    &dir,
                    opts.cache,
                ));
            }
        }
        DedupePolicy::ByPathOrNotes => {
            let candidate = format!("{parent_rel}/{}", meta.id).replace('\\', "/");
            let dir = vault.join(&candidate);
            if dir.is_dir()
                && (dir.join("NOTES.md").is_file()
                    || papers::get_by_path(vault, &candidate)?.is_some())
            {
                let caps = opts
                    .cache
                    .map(|c| c.caps_for(vault, &candidate))
                    .unwrap_or_else(|| probe_paper_caps(&dir));
                return Ok(PaperCommitResult {
                    status: CommitStatus::Skipped,
                    path: candidate.clone(),
                    id: meta.id,
                    title: meta.title,
                    paper_dir: dir.to_string_lossy().to_string(),
                    pdf: caps.has_pdf(),
                    tex: caps.has_tex,
                    paper_md: caps.has_paper_md,
                    asset_messages: Vec::new(),
                    assets_pending: false,
                    preparation: PreparationPlan::empty(candidate),
                });
            }
        }
        DedupePolicy::None => {}
    }

    let unique_local_id =
        meta.paper_type == papers::PaperKind::Pdf && meta.doi.is_none() && meta.arxiv_id.is_none();
    let (folder_id, path_rel, paper_dir) =
        allocate_paper_path(vault, &parent_rel, &meta.id, unique_local_id);
    meta.id = folder_id;
    if opts.fresh_timestamps {
        let now = crate::time::now_rfc3339_millis();
        meta.added_at = now.clone();
        meta.updated_at = now;
    }
    fs::create_dir_all(&paper_dir)?;

    // Copy → shell → catalog must succeed as a unit. The folder was just
    // created by us; if any step fails, roll it back so a half-written paper
    // never shows in the tree without a catalog row.
    let commit_steps = async {
        if let AssetsPolicy::CopyPdf { src, .. } = &opts.assets {
            // PDF lives in the folder root as `{id}.pdf` (same as downloaded PDFs).
            fs::copy(src, paper_dir.join(format!("{}.pdf", meta.id)))
                .map_err(|e| AppError::message(format!("copy PDF failed: {e}")))?;
        }

        write_paper_shell_opts(
            &paper_dir,
            vault,
            &meta,
            opts.note_mode,
            opts.translate_abstract,
        )
        .await?;

        // Catalog SQLite is authoritative; metadata.json is a projection.
        let record = meta.clone().at_path(&path_rel);
        papers::upsert_paper(vault, &record)?;
        Ok(())
    };
    if let Err(e) = commit_steps.await {
        if let Err(rm) = fs::remove_dir_all(&paper_dir) {
            log::warn!(
                target: "agentero::import",
                "rollback of {} failed: {rm}",
                paper_dir.display()
            );
        }
        return Err(e);
    }

    crate::features::lifecycle::emit_paper_imported(opts.app, vault, &meta.id, &path_rel);

    let arxiv_request = crate::features::paper::source::arxiv_request(&meta);
    let (assets, assets_pending) = match opts.assets {
        AssetsPolicy::SyncDownload { cookies, progress } => {
            let assets = match ensure_paper_assets_with_progress(
                &paper_dir,
                vault,
                &path_rel,
                &meta.id,
                arxiv_request.as_deref(),
                meta.pdf_url.as_deref(),
                meta.doi.as_deref(),
                cookies,
                opts.cache,
                progress,
            )
            .await
            {
                Ok(assets) => {
                    crate::features::lifecycle::emit_paper_assets_ready(
                        opts.app, vault, &meta.id, &path_rel,
                    );
                    assets
                }
                Err(e) => {
                    let caps = probe_paper_caps(&paper_dir);
                    AssetDownloadResult {
                        pdf: caps.has_pdf(),
                        tex: caps.has_tex,
                        paper_md: caps.has_paper_md,
                        messages: vec![format!("asset download error: {e}")],
                        ..Default::default()
                    }
                }
            };
            (assets, false)
        }
        AssetsPolicy::CopyPdf { .. } => {
            crate::features::lifecycle::emit_paper_assets_ready(
                opts.app, vault, &meta.id, &path_rel,
            );
            let assets = AssetDownloadResult {
                pdf: true,
                ..Default::default()
            };
            (assets, false)
        }
        AssetsPolicy::Deferred => (AssetDownloadResult::default(), true),
    };

    let preparation = plan_after_assets(
        &path_rel,
        assets.pdf,
        assets.tex,
        assets.paper_md,
        opts.defer_parse_jobs,
    );

    if let Some(c) = opts.cache {
        c.invalidate(vault, &path_rel);
    }

    if assets.pdf {
        super::code_repo::fill_code_repo_from_pdf(vault, &path_rel).await;
    }
    // Best-effort catalog fill by arXiv id; detached so the import never waits
    // on the network. No arXiv id makes it a no-op.
    crate::features::paper::discovery::pwc::spawn_enrich(vault, &path_rel);

    Ok(PaperCommitResult {
        status: CommitStatus::Created,
        path: path_rel,
        id: meta.id,
        title: meta.title,
        paper_dir: paper_dir.to_string_lossy().to_string(),
        pdf: assets.pdf,
        tex: assets.tex,
        paper_md: assets.paper_md,
        asset_messages: assets.messages,
        assets_pending,
        preparation,
    })
}

fn existing_result(
    status: CommitStatus,
    existing: papers::PaperRecord,
    vault: &Path,
    dir: &Path,
    cache: Option<&CapsCache>,
) -> PaperCommitResult {
    let caps = cache
        .map(|c| c.caps_for(vault, &existing.path))
        .unwrap_or_else(|| probe_paper_caps(dir));
    let path = existing.path.clone();
    let mut preparation = PreparationPlan::empty(&path);
    if existing.arxiv_id.is_some()
        && crate::features::paper::source::needs_preparation(vault, &existing)
    {
        preparation
            .steps
            .push(super::preparation::PreparationStep::ParseBody { force: false });
    }
    PaperCommitResult {
        status,
        pdf: caps.has_pdf(),
        tex: caps.has_tex,
        paper_md: caps.has_paper_md,
        paper_dir: dir.to_string_lossy().to_string(),
        path,
        id: existing.id,
        title: existing.title,
        asset_messages: Vec::new(),
        assets_pending: false,
        preparation,
    }
}

async fn repair_existing_import_shell(
    vault: &Path,
    mut existing: papers::PaperRecord,
    incoming: &papers::PaperRecord,
    opts: &PaperCommitOptions<'_>,
) -> Result<papers::PaperRecord, AppError> {
    let dir = vault.join(&existing.path);
    fs::create_dir_all(&dir)?;

    let mut changed = backfill_existing_metadata(&mut existing, incoming);
    let notes = dir.join("NOTES.md");
    if !notes.is_file() {
        write_paper_shell_opts(
            &dir,
            vault,
            &existing,
            opts.note_mode,
            opts.translate_abstract,
        )
        .await?;
        changed = true;
    }

    if changed {
        existing.updated_at = crate::time::now_rfc3339_millis();
        existing = papers::upsert_paper(vault, &existing)?;
        if let Some(c) = opts.cache {
            c.invalidate(vault, &existing.path);
        }
    }

    Ok(existing)
}

fn backfill_existing_metadata(
    existing: &mut papers::PaperRecord,
    incoming: &papers::PaperRecord,
) -> bool {
    let mut changed = false;

    if existing.title.trim().is_empty() && !incoming.title.trim().is_empty() {
        existing.title = incoming.title.clone();
        changed = true;
    }
    if existing.authors.is_empty() && !incoming.authors.is_empty() {
        existing.authors = incoming.authors.clone();
        changed = true;
    }
    if existing.tags.is_empty() && !incoming.tags.is_empty() {
        existing.tags = incoming.tags.clone();
        changed = true;
    }

    macro_rules! fill {
        ($field:ident) => {
            if existing.$field.is_none() {
                if let Some(value) = incoming
                    .$field
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    existing.$field = Some(value.to_string());
                    changed = true;
                }
            }
        };
    }

    if existing.year.is_none() && incoming.year.is_some() {
        existing.year = incoming.year;
        changed = true;
    }
    fill!(abstract_text);
    fill!(arxiv_id);
    fill!(doi);
    fill!(pdf_url);
    fill!(html_url);
    fill!(source_url);
    fill!(body_source);
    fill!(body_quality);
    fill!(bibtex_key);
    if existing.citation_count.is_none() && incoming.citation_count.is_some() {
        existing.citation_count = incoming.citation_count;
        changed = true;
    }
    if existing.status.trim().is_empty() && !incoming.status.trim().is_empty() {
        existing.status = incoming.status.clone();
        changed = true;
    }
    fill!(summary);
    fill!(date);
    fill!(isbn);
    fill!(issn);
    fill!(pmid);
    fill!(publication);
    fill!(volume);
    fill!(issue);
    fill!(pages);
    fill!(publisher);
    fill!(place);
    fill!(series);
    fill!(language);
    fill!(zotero_item_type);
    fill!(meta_source);
    fill!(extra);

    if existing.creators.is_none() && incoming.creators.is_some() {
        existing.creators = incoming.creators.clone();
        changed = true;
    }
    if existing.zotero_item_id.is_none() && incoming.zotero_item_id.is_some() {
        existing.zotero_item_id = incoming.zotero_item_id;
        changed = true;
    }
    fill!(zotero_last_synced);

    changed
}

/// First catalog row matching a canonical id or shared identifier of `meta`
/// (arXiv ID, DOI, PMID, ISBN) — the cross-identifier lookup behind
/// [`DedupePolicy::ByIdentifiers`].
fn find_existing_by_identifiers(
    vault: &Path,
    meta: &papers::PaperRecord,
) -> Result<Option<papers::PaperRecord>, AppError> {
    // Local PDF names are placeholders, never proof of scholarly identity.
    // Keep id-based recovery for identifier imports with incomplete old rows.
    let canonical_id = meta.paper_type != papers::PaperKind::Pdf
        || meta
            .arxiv_id
            .as_deref()
            .is_some_and(|id| super::slug_from_stem(id) == meta.id)
        || meta
            .doi
            .as_deref()
            .is_some_and(|doi| super::doi_slug(doi) == meta.id);
    if canonical_id {
        if let Some(existing) = papers::get_by_id(vault, &meta.id)? {
            return Ok(Some(existing));
        }
    }
    let lookups: [(&str, Option<&str>); 4] = [
        ("arxiv_id", meta.arxiv_id.as_deref()),
        ("doi", meta.doi.as_deref()),
        ("pmid", meta.pmid.as_deref()),
        ("isbn", meta.isbn.as_deref()),
    ];
    for (column, value) in lookups {
        let Some(value) = value.map(str::trim).filter(|v| !v.is_empty()) else {
            continue;
        };
        if let Some(existing) = papers::find_by_identifier(vault, column, value)? {
            return Ok(Some(existing));
        }
    }
    Ok(None)
}

/// Merge a freshly imported PDF into an existing catalog entry instead of
/// creating a duplicate folder: it becomes the main `{id}.pdf` when the entry
/// has none yet (e.g. PMID imports whose full text is not downloadable),
/// otherwise it lands in `attachments/`. Identifier columns the existing row
/// lacks are backfilled from `meta`.
async fn merge_pdf_into_existing(
    vault: &Path,
    mut existing: papers::PaperRecord,
    src: &Path,
    meta: &papers::PaperRecord,
    cache: Option<&CapsCache>,
    app: Option<&AppHandle>,
) -> Result<PaperCommitResult, AppError> {
    let dir = vault.join(&existing.path);
    let main_pdf = dir.join(format!("{}.pdf", existing.id));
    let became_main = !main_pdf.is_file();
    let dest = if became_main {
        main_pdf
    } else {
        let attachments = dir.join("attachments");
        fs::create_dir_all(&attachments)?;
        unique_attachment_path(&attachments, src)
    };
    fs::copy(src, &dest)
        .map_err(|e| AppError::message(format!("copy PDF into existing entry failed: {e}")))?;

    let mut backfilled = false;
    for (slot, incoming) in [
        (&mut existing.arxiv_id, &meta.arxiv_id),
        (&mut existing.doi, &meta.doi),
        (&mut existing.pmid, &meta.pmid),
        (&mut existing.isbn, &meta.isbn),
        (&mut existing.issn, &meta.issn),
    ] {
        if slot.is_none() {
            if let Some(v) = incoming.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
                *slot = Some(v.to_string());
                backfilled = true;
            }
        }
    }
    if backfilled || became_main {
        existing.updated_at = crate::time::now_rfc3339_millis();
        papers::upsert_paper(vault, &existing)?;
    }

    if let Some(c) = cache {
        c.invalidate(vault, &existing.path);
    }
    if became_main {
        super::code_repo::fill_code_repo_from_pdf(vault, &existing.path).await;
    }
    crate::features::lifecycle::emit_paper_imported(app, vault, &existing.id, &existing.path);
    crate::features::lifecycle::emit_paper_assets_ready(app, vault, &existing.id, &existing.path);

    let caps = cache
        .map(|c| c.caps_for(vault, &existing.path))
        .unwrap_or_else(|| probe_paper_caps(&dir));

    let message = if became_main {
        "merged PDF into existing entry as main PDF".to_string()
    } else {
        format!(
            "added PDF to attachments of existing entry ({})",
            dest.file_name().and_then(|s| s.to_str()).unwrap_or("")
        )
    };
    log::info!(target: "agentero::import", "{}: {}", message, existing.path);

    let mut preparation = plan_after_merged_pdf(
        &existing.path,
        became_main,
        caps.has_pdf(),
        caps.has_tex,
        caps.has_paper_md,
    );
    if !preparation.has_parse_body()
        && existing.arxiv_id.is_some()
        && crate::features::paper::source::needs_preparation(vault, &existing)
    {
        preparation
            .steps
            .push(super::preparation::PreparationStep::ParseBody { force: false });
    }

    Ok(PaperCommitResult {
        status: CommitStatus::Deduped,
        pdf: caps.has_pdf(),
        tex: caps.has_tex,
        paper_md: caps.has_paper_md,
        paper_dir: dir.to_string_lossy().to_string(),
        path: existing.path,
        id: existing.id,
        title: existing.title,
        asset_messages: vec![message],
        assets_pending: false,
        preparation,
    })
}

/// Free `attachments/{name}` path, suffixing `-2`, `-3`, … on collision.
pub fn unique_attachment_path(dir: &Path, src: &Path) -> std::path::PathBuf {
    let name = src
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("attachment.pdf");
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let src_path = Path::new(name);
    let stem = src_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("attachment");
    let ext = src_path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for n in 2u32.. {
        let candidate = dir.join(format!("{stem}-{n}{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!("attachment name space exhausted")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_vault(tag: &str) -> std::path::PathBuf {
        let vault = std::env::temp_dir().join(format!(
            "agentero-commit-{tag}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(vault.join("papers")).unwrap();
        vault
    }

    /// Catalog row + folder for a paper imported by PMID without fulltext.
    fn seed_existing_without_pdf(vault: &Path) {
        let mut meta = papers::PaperRecord::local_pdf(
            "pmid-12345".into(),
            "A Biomedical Paper Without Fulltext".into(),
        );
        meta.pmid = Some("12345".into());
        let record = meta.at_path("papers/pmid-12345");
        papers::upsert_paper(vault, &record).unwrap();
        fs::create_dir_all(vault.join("papers/pmid-12345")).unwrap();
        fs::write(vault.join("papers/pmid-12345/NOTES.md"), "# Notes\n").unwrap();
    }

    async fn commit_pdf(vault: &Path, src: &Path, doi: &str) -> PaperCommitResult {
        let mut meta =
            papers::PaperRecord::local_pdf("fulltext-slug".into(), "Fulltext PDF".into());
        meta.doi = Some(doi.into());
        meta.pmid = Some("12345".into());
        paper_commit(
            meta,
            PaperCommitOptions {
                vault,
                parent_dir: "papers",
                dedupe: DedupePolicy::ByIdentifiers,
                assets: AssetsPolicy::CopyPdf {
                    src,
                    progress: AssetProgressContext {
                        app: None,
                        task_id: None,
                    },
                },
                translate_abstract: false,
                note_mode: NoteShellMode::Standard,
                fresh_timestamps: false,
                cache: None,
                app: None,
                defer_parse_jobs: false,
            },
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn by_identifiers_merges_pdf_into_existing_entry() {
        let vault = tmp_vault("merge");
        seed_existing_without_pdf(&vault);
        let src = vault.join("incoming.pdf");
        fs::write(&src, b"%PDF-1.4 merged").unwrap();

        // Matched by shared PMID despite different id/DOI → becomes main PDF.
        let res = commit_pdf(&vault, &src, "10.1000/journal.123").await;
        assert_eq!(res.status, CommitStatus::Deduped);
        assert_eq!(res.path, "papers/pmid-12345");
        assert!(vault.join("papers/pmid-12345/pmid-12345.pdf").is_file());
        assert!(res.preparation.steps.iter().any(|step| matches!(
            step,
            crate::features::import::PreparationStep::ParseBody { force: false }
        )));
        assert!(!vault.join("papers/fulltext-slug").exists());
        let row = papers::get_by_path(&vault, "papers/pmid-12345")
            .unwrap()
            .unwrap();
        assert_eq!(row.doi.as_deref(), Some("10.1000/journal.123"));
        assert_eq!(row.pmid.as_deref(), Some("12345"));

        // A second PDF for the same paper lands in attachments/.
        let src2 = vault.join("supplement.pdf");
        fs::write(&src2, b"%PDF-1.4 supplement").unwrap();
        let res2 = commit_pdf(&vault, &src2, "10.1000/journal.123").await;
        assert_eq!(res2.status, CommitStatus::Deduped);
        assert!(vault
            .join("papers/pmid-12345/attachments/supplement.pdf")
            .is_file());
        assert!(!res2.preparation.has_parse_body());
        // Same filename again → suffixed, never overwritten.
        let res3 = commit_pdf(&vault, &src2, "10.1000/journal.123").await;
        assert_eq!(res3.status, CommitStatus::Deduped);
        assert!(vault
            .join("papers/pmid-12345/attachments/supplement-2.pdf")
            .is_file());

        let _ = fs::remove_dir_all(&vault);
    }

    #[tokio::test]
    async fn by_identifiers_never_merges_local_filename_collisions() {
        for id in ["paper", "中文论文"] {
            let vault = tmp_vault("local-name-collision");
            let existing_dir = vault.join("papers/舞蹈概论");
            fs::create_dir_all(&existing_dir).unwrap();
            fs::write(existing_dir.join("NOTES.md"), "# 舞蹈概论\n").unwrap();
            fs::write(existing_dir.join("paper.pdf"), b"%PDF-1.4 dance").unwrap();
            papers::upsert_paper(
                &vault,
                &papers::PaperRecord::local_pdf(id.into(), "舞蹈概论".into())
                    .at_path("papers/舞蹈概论"),
            )
            .unwrap();
            let src = vault.join("家长情绪支持与儿童英语学习兴趣转化研究.pdf");
            fs::write(&src, b"%PDF-1.4 unrelated education paper").unwrap();
            let result = paper_commit(
                papers::PaperRecord::local_pdf(
                    id.into(),
                    "家长情绪支持与儿童英语学习兴趣转化研究".into(),
                ),
                PaperCommitOptions {
                    vault: &vault,
                    parent_dir: "papers/英语启蒙",
                    dedupe: DedupePolicy::ByIdentifiers,
                    assets: AssetsPolicy::CopyPdf {
                        src: &src,
                        progress: AssetProgressContext {
                            app: None,
                            task_id: None,
                        },
                    },
                    translate_abstract: false,
                    note_mode: NoteShellMode::TitleOnly,
                    fresh_timestamps: false,
                    cache: None,
                    app: None,
                    defer_parse_jobs: true,
                },
            )
            .await
            .unwrap();
            assert_eq!(result.status, CommitStatus::Created);
            assert_ne!(result.id, id);
            assert!(result.path.starts_with("papers/英语启蒙/"));
            assert_eq!(
                fs::read(vault.join(&result.path).join(format!("{}.pdf", result.id))).unwrap(),
                fs::read(&src).unwrap()
            );
            assert!(!existing_dir.join("attachments").exists());
            assert_eq!(
                fs::read(existing_dir.join("paper.pdf")).unwrap(),
                b"%PDF-1.4 dance"
            );
            assert_eq!(papers::list_all_unique_by_id(&vault).unwrap().len(), 2);
            let _ = fs::remove_dir_all(vault);
        }
    }

    #[tokio::test]
    async fn by_identifiers_creates_when_no_identifier_matches() {
        let vault = tmp_vault("no-match");
        seed_existing_without_pdf(&vault);
        let src = vault.join("other.pdf");
        fs::write(&src, b"%PDF-1.4 other").unwrap();

        let mut meta = papers::PaperRecord::local_pdf("unrelated".into(), "Unrelated Paper".into());
        meta.doi = Some("10.9999/unrelated".into());
        let res = paper_commit(
            meta,
            PaperCommitOptions {
                vault: &vault,
                parent_dir: "papers",
                dedupe: DedupePolicy::ByIdentifiers,
                assets: AssetsPolicy::CopyPdf {
                    src: &src,
                    progress: AssetProgressContext {
                        app: None,
                        task_id: None,
                    },
                },
                translate_abstract: false,
                note_mode: NoteShellMode::Standard,
                fresh_timestamps: false,
                cache: None,
                app: None,
                defer_parse_jobs: false,
            },
        )
        .await
        .unwrap();
        assert_eq!(res.status, CommitStatus::Created);
        assert_eq!(res.path, "papers/unrelated");
        assert!(vault.join("papers/unrelated/unrelated.pdf").is_file());
        // No host hooks: the plan is still produced from the copied PDF.
        assert_eq!(
            res.preparation.steps,
            vec![
                crate::features::import::PreparationStep::ParseBody { force: false },
                crate::features::import::PreparationStep::ParseRefs,
            ]
        );

        let _ = fs::remove_dir_all(&vault);
    }

    #[tokio::test]
    async fn by_identifiers_repairs_incomplete_existing_entry() {
        let vault = tmp_vault("repair-existing");

        let mut existing = papers::PaperRecord::local_pdf("1706.03762".into(), "".into())
            .at_path("papers/1706.03762");
        existing.openreview_url = Some("https://openreview.net/forum?id=keep".into());
        papers::upsert_paper(&vault, &existing).unwrap();

        let mut incoming =
            papers::PaperRecord::local_pdf("1706.03762".into(), "Attention Is All You Need".into());
        incoming.authors = vec!["Ashish Vaswani".into()];
        incoming.year = Some(2017);
        incoming.abstract_text = Some("The dominant sequence transduction models.".into());
        incoming.arxiv_id = Some("1706.03762".into());
        incoming.html_url = Some("https://arxiv.org/abs/1706.03762".into());

        let res = paper_commit(
            incoming,
            PaperCommitOptions {
                vault: &vault,
                parent_dir: "papers",
                dedupe: DedupePolicy::ByIdentifiers,
                assets: AssetsPolicy::Deferred,
                translate_abstract: false,
                note_mode: NoteShellMode::Standard,
                fresh_timestamps: false,
                cache: None,
                app: None,
                defer_parse_jobs: false,
            },
        )
        .await
        .unwrap();

        assert_eq!(res.status, CommitStatus::Deduped);
        assert_eq!(res.path, "papers/1706.03762");
        let notes = fs::read_to_string(vault.join("papers/1706.03762/NOTES.md")).unwrap();
        assert!(notes.contains("# Attention Is All You Need"));
        assert!(notes.contains("> The dominant sequence transduction models."));

        let row = papers::get_by_path(&vault, "papers/1706.03762")
            .unwrap()
            .unwrap();
        assert_eq!(row.title, "Attention Is All You Need");
        assert_eq!(row.authors, vec!["Ashish Vaswani"]);
        assert_eq!(row.year, Some(2017));
        assert_eq!(
            row.abstract_text.as_deref(),
            Some("The dominant sequence transduction models.")
        );
        assert_eq!(row.arxiv_id.as_deref(), Some("1706.03762"));
        assert_eq!(
            row.openreview_url.as_deref(),
            Some("https://openreview.net/forum?id=keep")
        );

        let _ = fs::remove_dir_all(&vault);
    }
}
