//! Auto-ingest (watch folder): adopt bare user-created folders under `papers/`
//! into the library, in place.
//!
//! A folder that appeared as a direct child of `papers/`, holds at least one
//! settled PDF, and is not already a paper unit / org folder / managed entry is
//! upgraded into a placeholder paper: main PDF renamed to `{id}.pdf`, extra
//! PDFs parked under `attachments/`, NOTES.md shell + catalog row + sidecar
//! written. The existing RecognizeMetadata job then resolves real metadata and
//! renames the folder to the canonical id (`recognize::apply`) — identical to
//! a manual local-PDF import, so downstream behavior (rename/merge/PAPER.md)
//! is reused unchanged.
//!
//! Unlike [`super::paper_commit`], adoption never deletes the user's folder:
//! PDF renames happen first and a failed shell/catalog write only leaves the
//! folder adoptable again (the classifier still sees no NOTES.md), so a retry
//! self-heals. The user's folder name is kept as the placeholder path; only
//! the catalog `id` is a folder-safe slug derived from it.

use crate::app_handle::AppHandle;
use crate::error::AppError;
use crate::features::catalog::{papers, CapsCache};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::paper_import::unique_attachment_path;
use super::{slug_from_stem, title_from_stem, write_paper_shell_opts, NoteShellMode};

/// Marker names mirroring the frontend paper-unit detection
/// (`src/lib/paper/detect.ts`): files `NOTES.md`/`PAPER.md`, dirs
/// `source`/`assets`/`marks`. `attachments/` is a paper-internal dir but not
/// a marker — a folder holding only attachments + PDFs is still adoptable.
const PAPER_MARKER_FILES: &[&str] = &["NOTES.md", "PAPER.md"];
const PAPER_MARKER_DIRS: &[&str] = &["source", "assets", "marks"];
/// Paper-internal dir names: never scanned for nested paper units.
const PAPER_INTERNAL_DIRS: &[&str] = &["attachments", "source", "assets", "marks"];
/// Suffixes (extension position) of browser/office in-flight downloads.
const TEMP_DOWNLOAD_EXTS: &[&str] = &["crdownload", "part", "download", "partial", "opdownload"];

/// How the classifier decided on a `papers/` direct child.
#[derive(Debug, PartialEq, Eq)]
pub enum FolderClass {
    /// Bare folder holding real PDF(s) → adoption candidate (natural order).
    Adopt { pdfs: Vec<PathBuf> },
    /// Paper markers present → already a paper unit (or a foreign paper
    /// folder copied in); never rewritten by adoption.
    PaperUnit,
    /// `metadata.json` sidecar or a catalog row for this path exists →
    /// managed entry (orphan self-heal territory, not adoption).
    Managed,
    /// Nested paper-unit subfolders → organization folder.
    OrgFolder,
    /// No real PDF inside yet → wait for one.
    NoPdf,
    /// Not a direct child of `papers/`.
    NotPapersChild,
}

/// Vault-relative path of `p` (forward slashes), or `None` outside the vault.
fn vault_rel(vault: &Path, p: &Path) -> Option<String> {
    let canonical = crate::fs::canonicalize_best_effort(vault);
    let rel = p
        .strip_prefix(&canonical)
        .or_else(|_| p.strip_prefix(vault))
        .ok()?;
    let s = rel.to_string_lossy().replace('\\', "/");
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// True when `name` (lowercased) is a temp/in-flight download file.
fn is_temp_download(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower.starts_with('~') {
        return true; // Office lock files (`~$doc.pdf`)
    }
    match lower.rsplit_once('.') {
        Some((_, ext)) => TEMP_DOWNLOAD_EXTS.contains(&ext),
        None => false,
    }
}

/// Real PDF files directly inside `dir` (not recursive), name-sorted.
fn direct_pdfs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| !n.starts_with('.') && !is_temp_download(n))
        })
        .collect();
    out.sort();
    out
}

/// Whether `dir` itself looks like a paper unit (marker file or marker dir
/// among its direct children).
fn has_paper_markers(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if PAPER_MARKER_FILES.iter().any(|m| name == *m.to_lowercase()) {
            return true;
        }
        if entry.path().is_dir() && PAPER_MARKER_DIRS.contains(&name.as_str()) {
            return true;
        }
    }
    false
}

/// Bounded scan for a nested paper-unit folder under `dir` (org-folder
/// detection): skip paper-internal dirs, look `depth` levels deep.
fn has_nested_paper_unit(dir: &Path, depth: usize) -> bool {
    if depth == 0 {
        return false;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if PAPER_INTERNAL_DIRS.contains(&name.as_str()) {
            continue;
        }
        if has_paper_markers(&path) || has_nested_paper_unit(&path, depth - 1) {
            return true;
        }
    }
    false
}

/// Classify a folder under `papers/` for auto-ingest. Pure disk/catalog read;
/// the caller re-runs it after every relevant FS batch (it is the loop guard:
/// once NOTES.md lands, the folder stops being adoptable).
pub fn classify_papers_subfolder(vault: &Path, dir: &Path) -> FolderClass {
    let Some(rel) = vault_rel(vault, dir) else {
        return FolderClass::NotPapersChild;
    };
    let segments: Vec<&str> = rel.split('/').collect();
    if segments.len() != 2 || segments[0] != "papers" {
        return FolderClass::NotPapersChild;
    }
    // Managed (sidecar or catalog row) is checked first: the strongest
    // "someone owns this" signal, independent of markers.
    if dir.join("metadata.json").is_file() {
        return FolderClass::Managed;
    }
    if matches!(papers::get_by_path(vault, &rel), Ok(Some(_))) {
        return FolderClass::Managed;
    }
    if has_paper_markers(dir) {
        return FolderClass::PaperUnit;
    }
    if has_nested_paper_unit(dir, 3) {
        return FolderClass::OrgFolder;
    }
    let pdfs = direct_pdfs(dir);
    if pdfs.is_empty() {
        FolderClass::NoPdf
    } else {
        FolderClass::Adopt { pdfs }
    }
}

/// Options for [`adopt_paper_folder`].
pub struct AdoptOptions<'a> {
    /// NOTES.md shell generation mode (settings `paperNoteMode`).
    pub note_mode: NoteShellMode,
    /// Optional in-memory caps cache; invalidated after adoption.
    pub cache: Option<&'a CapsCache>,
    /// Lifecycle/job hooks (`paper:imported`, RecognizeMetadata job).
    pub app: Option<&'a AppHandle>,
}

/// Outcome of adopting one folder (camelCase matches the frontend).
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AdoptResult {
    /// Vault-relative paper folder (the user's folder name, kept).
    pub path: String,
    /// Placeholder catalog id (folder-safe slug).
    pub id: String,
    /// Placeholder title (from the folder name; recognition replaces it).
    pub title: String,
    /// Vault-relative paths of extra PDFs moved into `attachments/`.
    pub attachments: Vec<String>,
}

/// Adopt a bare `papers/` child folder in place. Re-classifies first, so a
/// concurrent adoption (NOTES.md already written) is a plain `Err`, never a
/// double write. See the module docs for the ordering guarantees.
pub async fn adopt_paper_folder(
    vault: &Path,
    dir: &Path,
    opts: AdoptOptions<'_>,
) -> Result<AdoptResult, AppError> {
    let FolderClass::Adopt { pdfs } = classify_papers_subfolder(vault, dir) else {
        return Err(AppError::message(format!(
            "folder is not adoptable: {}",
            dir.display()
        )));
    };
    let rel = vault_rel(vault, dir).unwrap_or_default();
    let folder_name = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "paper".into());

    // Placeholder id: slug of the user's folder name; when that strips to
    // nothing (e.g. CJK-only name → "paper" fallback), prefer the first PDF's
    // stem so `{id}.pdf` still carries something recognizable.
    let mut id = slug_from_stem(&folder_name);
    if id == "paper" {
        if let Some(stem) = pdfs
            .first()
            .and_then(|p| p.file_stem())
            .and_then(|s| s.to_str())
        {
            id = slug_from_stem(stem);
        }
    }

    // Main-PDF heuristic among several: a PDF named after the folder (or
    // already `{id}.pdf`) is the obvious paper; otherwise the largest file —
    // the full text is almost always bigger than its supplements.
    let main_idx = pdfs
        .iter()
        .position(|p| {
            p.file_stem()
                .and_then(|s| s.to_str())
                .is_some_and(|s| slug_from_stem(s) == id)
        })
        .unwrap_or_else(|| {
            pdfs.iter()
                .enumerate()
                .max_by_key(|(_, p)| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0))
                .map(|(i, _)| i)
                .unwrap_or(0)
        });
    let mut rest: Vec<&PathBuf> = pdfs.iter().collect();
    let main_src = rest.remove(main_idx);

    // 1) Main PDF → `{id}.pdf` (before shell/catalog so the RecognizeMetadata
    //    runner always finds it once the catalog row lands).
    let main_target = dir.join(format!("{id}.pdf"));
    if main_src != &main_target && !main_target.is_file() {
        std::fs::rename(main_src, &main_target)
            .map_err(|e| AppError::message(format!("rename main PDF: {e}")))?;
    }

    // 2) Extra PDFs → `attachments/` (Fix #406 convention).
    let mut attachments = Vec::new();
    for pdf in rest {
        let attachments_dir = dir.join("attachments");
        std::fs::create_dir_all(&attachments_dir)?;
        let dest = unique_attachment_path(&attachments_dir, pdf);
        std::fs::rename(pdf, &dest)
            .map_err(|e| AppError::message(format!("move attachment PDF: {e}")))?;
        if let Some(r) = vault_rel(vault, &dest) {
            attachments.push(r);
        }
    }

    // 3) Shell + catalog (+ sidecar projection). A failure here leaves the
    //    renamed PDFs on disk and the folder still adoptable — no rollback
    //    deletes, unlike `paper_commit`.
    let meta = papers::PaperRecord::local_pdf(id.clone(), title_from_stem(&folder_name));
    write_paper_shell_opts(dir, vault, &meta, opts.note_mode, false).await?;
    let record = meta.at_path(&rel);
    papers::upsert_paper(vault, &record)?;

    if let Some(cache) = opts.cache {
        cache.invalidate(vault, &rel);
    }
    crate::features::lifecycle::emit_paper_imported(opts.app, vault, &record.id);
    crate::features::lifecycle::emit_paper_assets_ready(opts.app, vault, &record.id);
    // Deferred recognition owns the follow-ups (rename/merge + parse), exactly
    // like picker/drop imports without dialog metadata.
    if let Some(app) = opts.app {
        app.spawn_recognize_metadata(vault, &rel);
    }

    log::info!(
        target: "agentero::ingest",
        "auto-ingest adopted papers/{} as placeholder id={id}",
        folder_name
    );
    Ok(AdoptResult {
        path: rel,
        id,
        title: record.title,
        attachments,
    })
}

/// Size snapshot of the real PDFs directly inside `dir` (settle probing).
pub fn pdf_snapshot(dir: &Path) -> Vec<(PathBuf, u64)> {
    direct_pdfs(dir)
        .into_iter()
        .filter_map(|p| std::fs::metadata(&p).ok().map(|m| (p, m.len())))
        .collect()
}

/// True when two snapshots agree (same files, same sizes): the copy finished.
pub fn snapshots_settled(a: &[(PathBuf, u64)], b: &[(PathBuf, u64)]) -> bool {
    a == b
}

/// Block until the PDFs in `dir` stop changing, or `max_wait` elapses.
/// Two equal snapshots `gap` apart count as settled; never returns true for
/// an empty folder (nothing to adopt).
pub fn wait_until_pdf_settled(dir: &Path, gap: Duration, max_wait: Duration) -> bool {
    let start = std::time::Instant::now();
    let mut snapshot = pdf_snapshot(dir);
    loop {
        std::thread::sleep(gap);
        let next = pdf_snapshot(dir);
        if !next.is_empty() && snapshots_settled(&snapshot, &next) {
            return true;
        }
        snapshot = next;
        if start.elapsed() >= max_wait {
            return false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp_vault(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agentero-auto-ingest-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("papers")).unwrap();
        dir
    }

    fn write(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn classify_requires_direct_papers_child() {
        let vault = tmp_vault("path");
        write(&vault.join("papers/deep/nested/a.pdf"), b"%PDF-1.4");
        assert_eq!(
            classify_papers_subfolder(&vault, &vault.join("papers/deep/nested")),
            FolderClass::NotPapersChild
        );
        assert_eq!(
            classify_papers_subfolder(&vault, &vault.join("notes")),
            FolderClass::NotPapersChild
        );
        let _ = fs::remove_dir_all(&vault);
    }

    #[test]
    fn classify_bare_pdf_folder_is_adoptable() {
        let vault = tmp_vault("adopt");
        write(&vault.join("papers/my-paper/1.pdf"), b"%PDF-1.4");
        let class = classify_papers_subfolder(&vault, &vault.join("papers/my-paper"));
        assert!(matches!(class, FolderClass::Adopt { .. }));
        let _ = fs::remove_dir_all(&vault);
    }

    #[test]
    fn classify_skips_known_states() {
        let vault = tmp_vault("known");
        // NOTES.md marker → paper unit
        write(&vault.join("papers/with-notes/a.pdf"), b"%PDF-1.4");
        write(&vault.join("papers/with-notes/NOTES.md"), b"# n");
        assert_eq!(
            classify_papers_subfolder(&vault, &vault.join("papers/with-notes")),
            FolderClass::PaperUnit
        );
        // source/ marker dir → paper unit
        write(&vault.join("papers/with-source/source/main.tex"), b"x");
        assert_eq!(
            classify_papers_subfolder(&vault, &vault.join("papers/with-source")),
            FolderClass::PaperUnit
        );
        // sidecar → managed
        write(&vault.join("papers/with-sidecar/a.pdf"), b"%PDF-1.4");
        write(&vault.join("papers/with-sidecar/metadata.json"), b"{}");
        assert_eq!(
            classify_papers_subfolder(&vault, &vault.join("papers/with-sidecar")),
            FolderClass::Managed
        );
        // nested paper unit → org folder
        write(&vault.join("papers/org/inner/NOTES.md"), b"# n");
        assert_eq!(
            classify_papers_subfolder(&vault, &vault.join("papers/org")),
            FolderClass::OrgFolder
        );
        // empty folder → wait
        fs::create_dir(vault.join("papers/empty")).unwrap();
        assert_eq!(
            classify_papers_subfolder(&vault, &vault.join("papers/empty")),
            FolderClass::NoPdf
        );
        // only a temp download → wait
        write(&vault.join("papers/copying/paper.pdf.crdownload"), b"%PDF");
        assert_eq!(
            classify_papers_subfolder(&vault, &vault.join("papers/copying")),
            FolderClass::NoPdf
        );
        let _ = fs::remove_dir_all(&vault);
    }

    #[tokio::test]
    async fn adopt_builds_shell_catalog_and_moves_attachments() {
        let vault = tmp_vault("adopt-run");
        // Alphabetically "supplement" < "whatever"; the larger full text must
        // still win the main-PDF slot (size heuristic, not name order).
        write(
            &vault.join("papers/attention-paper/whatever.pdf"),
            b"%PDF-1.4 main text padded to be clearly the largest file",
        );
        write(
            &vault.join("papers/attention-paper/supplement.pdf"),
            b"%PDF-1.4",
        );

        let result = adopt_paper_folder(
            &vault,
            &vault.join("papers/attention-paper"),
            AdoptOptions {
                note_mode: NoteShellMode::TitleOnly,
                cache: None,
                app: None,
            },
        )
        .await
        .expect("adopt");

        // Folder name kept; id is its slug.
        assert_eq!(result.path, "papers/attention-paper");
        assert_eq!(result.id, "attention-paper");
        // Main PDF renamed to `{id}.pdf`; extra moved to attachments.
        assert!(vault
            .join("papers/attention-paper/attention-paper.pdf")
            .is_file());
        assert!(vault
            .join("papers/attention-paper/attachments/supplement.pdf")
            .is_file());
        assert_eq!(result.attachments.len(), 1);
        // Shell + sidecar + catalog row.
        assert!(vault.join("papers/attention-paper/NOTES.md").is_file());
        assert!(vault.join("papers/attention-paper/metadata.json").is_file());
        let row = papers::get_by_path(&vault, "papers/attention-paper")
            .unwrap()
            .expect("catalog row");
        assert_eq!(row.title, "attention-paper");
        // Idempotent guard: the folder is no longer adoptable (sidecar +
        // catalog row land before any reclassification can run).
        assert_eq!(
            classify_papers_subfolder(&vault, &vault.join("papers/attention-paper")),
            FolderClass::Managed
        );
        let _ = fs::remove_dir_all(&vault);
    }

    #[tokio::test]
    async fn adopt_keeps_identifier_named_pdf_and_uses_pdf_stem_for_cjk_folder() {
        let vault = tmp_vault("adopt-cjk");
        // CJK folder name strips to the slug fallback; the PDF stem takes over.
        write(&vault.join("papers/我的论文/2401.12345.pdf"), b"%PDF-1.4");
        let result = adopt_paper_folder(
            &vault,
            &vault.join("papers/我的论文"),
            AdoptOptions {
                note_mode: NoteShellMode::TitleOnly,
                cache: None,
                app: None,
            },
        )
        .await
        .expect("adopt");
        assert_eq!(result.id, "2401.12345");
        assert_eq!(result.path, "papers/我的论文");
        assert!(vault.join("papers/我的论文/2401.12345.pdf").is_file());
        // Identifier-named main PDF is not renamed when the id already matches.
        let vault2 = tmp_vault("adopt-id");
        write(
            &vault2.join("papers/1706.03762/1706.03762.pdf"),
            b"%PDF-1.4",
        );
        let r2 = adopt_paper_folder(
            &vault2,
            &vault2.join("papers/1706.03762"),
            AdoptOptions {
                note_mode: NoteShellMode::TitleOnly,
                cache: None,
                app: None,
            },
        )
        .await
        .expect("adopt");
        assert_eq!(r2.id, "1706.03762");
        assert!(vault2.join("papers/1706.03762/1706.03762.pdf").is_file());
        let _ = fs::remove_dir_all(&vault);
        let _ = fs::remove_dir_all(&vault2);
    }

    #[test]
    fn settle_probe_detects_growth_then_stability() {
        let vault = tmp_vault("settle");
        let dir = vault.join("papers/growing");
        write(&dir.join("a.pdf"), b"%PDF-1.4");

        assert!(wait_until_pdf_settled(
            &dir,
            Duration::from_millis(20),
            Duration::from_secs(2)
        ));

        // A folder with no real PDFs never settles (nothing to adopt).
        let empty = vault.join("papers/none");
        fs::create_dir_all(&empty).unwrap();
        assert!(!wait_until_pdf_settled(
            &empty,
            Duration::from_millis(10),
            Duration::from_millis(80)
        ));
        let _ = fs::remove_dir_all(&vault);
    }
}
