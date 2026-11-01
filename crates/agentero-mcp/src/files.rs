//! Vault-relative UTF-8 text read / write for MCP, plus base64 binary writes
//! (images and other generated files).
//!
//! Paper `NOTES.md` stays on `paper_notes_*` (frontmatter). This surface is for
//! other vault text, such as a LaTeX draft that does not live under `papers/`.

use agentero_core::error::AppError;
use agentero_core::features::paper::catalog::papers;
use agentero_core::features::vault::rename::{
    run_local_rename_transaction, WikiIndex, WikiRenameResult,
};
use agentero_core::features::vault::trash::{self, DeleteResult};
use agentero_core::features::vault::tree::should_ignore;
use agentero_core::fs::{atomic_write, sanitize_vault_rel};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// MCP text reads and writes refuse anything larger than this.
pub const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;

/// MCP binary writes refuse more decoded bytes than this.
pub const MAX_BINARY_BYTES: usize = 10 * 1024 * 1024;

const BINARY_EXTS: &[&str] = &[
    "pdf", "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "ico", "icns", "zip", "gz",
    "tgz", "bz2", "xz", "7z", "rar", "sqlite", "sqlite3", "db", "wasm", "mp3", "mp4", "mov", "avi",
    "webm", "docx", "xlsx", "pptx", "odt", "woff", "woff2", "ttf", "otf", "so", "dylib", "dll",
    "exe", "bin",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteMode {
    Replace,
    Append,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    /// Vault-relative path using `/`.
    pub path: String,
    /// `file` or `directory`.
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileListOut {
    /// Vault-relative directory that was listed. Empty string is the vault root.
    pub path: String,
    pub entries: Vec<FileEntry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileReadOut {
    pub path: String,
    pub content: String,
    pub bytes: usize,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileWriteOut {
    pub path: String,
    pub mode: String,
    pub bytes: usize,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileWriteBinaryOut {
    pub path: String,
    /// Decoded bytes written.
    pub bytes: usize,
}

pub fn list_dir(vault: &Path, rel: &str, limit: usize) -> Result<FileListOut, AppError> {
    let rel = normalize_dir(rel)?;
    reject_segments(&rel)?;
    let root = canonical_root(vault)?;
    let dir = if rel.is_empty() {
        root.clone()
    } else {
        contained_existing(&root, &rel, true)?
    };
    if !dir.is_dir() {
        return Err(AppError::message("path is not a directory"));
    }

    let mut entries = Vec::new();
    let mut truncated = false;
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if should_ignore(name) {
            continue;
        }
        let child_rel = if rel.is_empty() {
            name.to_string()
        } else {
            format!("{rel}/{name}")
        };
        let kind = match entry_kind(&root, &entry.path()) {
            Some(kind) => kind,
            None => continue,
        };
        entries.push(FileEntry {
            name: name.to_string(),
            path: child_rel,
            kind: kind.to_string(),
        });
        if entries.len() > limit {
            truncated = true;
            entries.pop();
            break;
        }
    }
    entries.sort_by(|a, b| {
        let kind = a.kind.cmp(&b.kind);
        if kind == std::cmp::Ordering::Equal {
            a.name
                .to_ascii_lowercase()
                .cmp(&b.name.to_ascii_lowercase())
        } else {
            // `directory` < `file`
            kind
        }
    });
    Ok(FileListOut {
        path: rel,
        entries,
        truncated,
    })
}

/// Use exactly the text-read path policy, before search reads/traverses entries.
/// Optional catalog metadata filter (`year` / `publication` / `doi` /
/// `is_read`) narrows hits to papers whose catalog record matches; hits that
/// do not map to a catalog paper are dropped when any filter is set.
pub fn search(
    vault: &Path,
    query: String,
    limit: Option<usize>,
    year: Option<i32>,
    publication: Option<String>,
    doi: Option<String>,
    is_read: Option<bool>,
) -> Result<agentero_core::features::markdown::search::VaultSearchResult, AppError> {
    use agentero_core::features::markdown::search::{vault_search_filtered, VaultSearchArgs};
    let root = canonical_root(vault)?;
    vault_search_filtered(
        VaultSearchArgs {
            vault_path: root.to_string_lossy().into_owned(),
            query,
            limit,
            year,
            publication,
            doi,
            is_read,
        },
        &|path| {
            let Some(rel) = path.strip_prefix(&root).ok().and_then(Path::to_str) else {
                return false;
            };
            let rel = match sanitize_vault_rel(rel) {
                Ok(rel) => rel,
                Err(_) => return false,
            };
            let is_dir = path.is_dir();
            reject_segments(&rel).is_ok()
                && (is_dir || (reject_managed(&rel).is_ok() && reject_binary_name(&rel).is_ok()))
                && contained_existing(&root, &rel, is_dir).is_ok()
        },
    )
}

pub fn read_text(vault: &Path, rel: &str) -> Result<FileReadOut, AppError> {
    let rel = normalize_file(rel)?;
    reject_segments(&rel)?;
    reject_managed(&rel)?;
    reject_binary_name(&rel)?;
    let root = canonical_root(vault)?;
    let path = contained_existing(&root, &rel, false)?;
    let meta = fs::metadata(&path)?;
    if meta.len() > MAX_TEXT_BYTES as u64 {
        return Err(AppError::message(format!(
            "file is {} bytes; MCP reads at most {MAX_TEXT_BYTES} bytes of UTF-8 text",
            meta.len()
        )));
    }
    let bytes = fs::read(&path)?;
    let content = decode_text(&bytes)?;
    let nbytes = content.len();
    Ok(FileReadOut {
        path: rel,
        content,
        bytes: nbytes,
    })
}

pub fn write_text(
    vault: &Path,
    rel: &str,
    content: &str,
    mode: WriteMode,
) -> Result<FileWriteOut, AppError> {
    let rel = normalize_file(rel)?;
    reject_segments(&rel)?;
    reject_managed(&rel)?;
    reject_notes(&rel)?;
    reject_binary_name(&rel)?;
    if content.len() > MAX_TEXT_BYTES {
        return Err(AppError::message(format!(
            "content is {} bytes; MCP writes at most {MAX_TEXT_BYTES} bytes",
            content.len()
        )));
    }
    if content.as_bytes().contains(&0) {
        return Err(AppError::message("content is binary"));
    }
    let root = canonical_root(vault)?;
    let path = contained_write_target(&root, &rel)?;
    if path.is_dir() {
        return Err(AppError::message("path is a directory"));
    }
    let next = match mode {
        WriteMode::Replace => content.to_string(),
        WriteMode::Append => {
            let existing = if path.is_file() {
                let meta = fs::metadata(&path)?;
                if meta.len() > MAX_TEXT_BYTES as u64 {
                    return Err(AppError::message(format!(
                        "file is {} bytes; MCP writes at most {MAX_TEXT_BYTES} bytes",
                        meta.len()
                    )));
                }
                decode_text(&fs::read(&path)?)?
            } else {
                String::new()
            };
            if existing.len() + content.len() > MAX_TEXT_BYTES {
                return Err(AppError::message(format!(
                    "append would exceed {MAX_TEXT_BYTES} bytes"
                )));
            }
            let mut next = existing;
            next.push_str(content);
            next
        }
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    atomic_write(&path, next.as_bytes())?;
    let mode_name = match mode {
        WriteMode::Replace => "replace",
        WriteMode::Append => "append",
    };
    Ok(FileWriteOut {
        path: rel,
        mode: mode_name.into(),
        bytes: next.len(),
    })
}

/// Write one binary file (an image, a PDF, an archive) from base64, replacing
/// any file already at `rel`. A `data:<type>;base64,` URL is accepted too.
pub fn write_binary(
    vault: &Path,
    rel: &str,
    content_base64: &str,
) -> Result<FileWriteBinaryOut, AppError> {
    let rel = normalize_file(rel)?;
    reject_segments(&rel)?;
    reject_managed(&rel)?;
    reject_notes(&rel)?;
    let bytes = decode_base64(content_base64)?;
    let root = canonical_root(vault)?;
    let path = contained_write_target(&root, &rel)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    atomic_write(&path, &bytes)?;
    Ok(FileWriteBinaryOut {
        path: rel,
        bytes: bytes.len(),
    })
}

/// Move or rename a vault path, updating resolved wiki links and catalog paper
/// path prefixes. The destination must not exist.
pub fn move_entry(
    vault: &Path,
    from: &str,
    to: &str,
    index: &mut WikiIndex,
) -> Result<WikiRenameResult, AppError> {
    let from = normalize_file(from)?;
    let to = normalize_file(to)?;
    if from.is_empty() || to.is_empty() {
        return Err(AppError::message("path is required"));
    }
    reject_segments(&from)?;
    reject_segments(&to)?;
    reject_managed(&from)?;
    reject_managed(&to)?;
    if from == to {
        return Err(AppError::message("source and target paths are identical"));
    }
    if to.starts_with(&format!("{from}/")) {
        return Err(AppError::message("cannot move a path into itself"));
    }

    let root = canonical_root(vault)?;
    let source = root.join(&from);
    if !source.exists() {
        return Err(AppError::message("source path not found"));
    }
    contained_existing(&root, &from, source.is_dir())?;
    if root.join(&to).exists() {
        return Err(AppError::message("destination path already exists"));
    }
    contained_write_target(&root, &to)?;

    run_local_rename_transaction(&root, index, &from, &to, &[], || {
        papers::move_under_path(&root, &from, &to)
            .map(|_| ())
            .map_err(|error| error.to_string())
    })
    .map_err(|error| AppError::message(error.to_string()))
}

/// Move vault paths into the recycle bin (default) or delete them permanently.
/// Paper catalog rows under `papers/` are handled by the shared trash/delete
/// use case.
pub fn delete_paths(
    vault: &Path,
    rels: &[String],
    permanent: bool,
) -> Result<DeleteResult, AppError> {
    let root = canonical_root(vault)?;
    let mut clean = Vec::new();
    for raw in rels {
        let rel = normalize_file(raw)?;
        if rel.is_empty() {
            continue;
        }
        reject_segments(&rel)?;
        reject_managed(&rel)?;
        if rel == "papers" {
            return Err(AppError::message("refusing to delete the papers root"));
        }
        let path = root.join(&rel);
        if !path.exists() {
            return Err(AppError::message(format!("path not found: {rel}")));
        }
        contained_existing(&root, &rel, path.is_dir())?;
        clean.push(rel);
    }
    if clean.is_empty() {
        return Err(AppError::message("paths is required"));
    }
    trash::delete_paths(&root, &clean, permanent)
}

fn normalize_dir(raw: &str) -> Result<String, AppError> {
    let raw = raw.trim();
    if raw.is_empty() || raw == "." {
        return Ok(String::new());
    }
    sanitize_vault_rel(raw).map_err(AppError::message)
}

fn normalize_file(raw: &str) -> Result<String, AppError> {
    let rel = sanitize_vault_rel(raw.trim()).map_err(AppError::message)?;
    if rel.ends_with('/') {
        return Err(AppError::message("path is a directory"));
    }
    Ok(rel)
}

fn reject_segments(rel: &str) -> Result<(), AppError> {
    if rel.is_empty() {
        return Ok(());
    }
    for segment in rel.split('/') {
        if should_ignore(segment) {
            return Err(AppError::message(format!(
                "path is not available via MCP: {rel}"
            )));
        }
    }
    Ok(())
}

fn reject_notes(rel: &str) -> Result<(), AppError> {
    if rel == "NOTES.md" || rel.ends_with("/NOTES.md") {
        return Err(AppError::message(
            "use paper_notes_write for NOTES.md (keeps YAML frontmatter)",
        ));
    }
    Ok(())
}

fn reject_managed(rel: &str) -> Result<(), AppError> {
    let managed = rel == "catalog.sqlite"
        || rel.ends_with("/catalog.sqlite")
        || rel == "marks/annotations.json"
        || rel.ends_with("/marks/annotations.json")
        || rel.ends_with("/source/layout-index.json")
        || rel.ends_with("/source/layout.json");
    if managed {
        return Err(AppError::message(
            "path is managed by Agentero and is not editable as a text file",
        ));
    }
    Ok(())
}

fn reject_binary_name(rel: &str) -> Result<(), AppError> {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    let ext = Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase());
    if ext.as_deref().is_some_and(|ext| BINARY_EXTS.contains(&ext)) {
        return Err(AppError::message(
            "path is not a UTF-8 text file (binary extension)",
        ));
    }
    Ok(())
}

fn decode_text(bytes: &[u8]) -> Result<String, AppError> {
    if bytes.contains(&0) {
        return Err(AppError::message("file is binary"));
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| AppError::message("file is not UTF-8 text"))
}

fn decode_base64(raw: &str) -> Result<Vec<u8>, AppError> {
    use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
    use base64::{alphabet, Engine};
    const ENGINE: GeneralPurpose = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );

    let raw = raw.trim();
    let payload = match raw.strip_prefix("data:") {
        Some(rest) => match rest.split_once(',') {
            Some((meta, data)) if meta.ends_with(";base64") => data,
            _ => {
                return Err(AppError::message(
                    "data URL must be base64 (data:<type>;base64,...)",
                ))
            }
        },
        None => raw,
    };
    let payload: String = payload
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect();
    if payload.is_empty() {
        return Err(AppError::message("contentBase64 is empty"));
    }
    // Refuse oversized input before decoding it.
    if payload.len() / 4 * 3 > MAX_BINARY_BYTES {
        return Err(AppError::message(format!(
            "content exceeds {MAX_BINARY_BYTES} bytes; MCP binary writes are limited to that"
        )));
    }
    let bytes = ENGINE
        .decode(payload.as_bytes())
        .map_err(|e| AppError::message(format!("contentBase64 is not valid base64: {e}")))?;
    if bytes.len() > MAX_BINARY_BYTES {
        return Err(AppError::message(format!(
            "content is {} bytes; MCP binary writes are limited to {MAX_BINARY_BYTES} bytes",
            bytes.len()
        )));
    }
    Ok(bytes)
}

fn canonical_root(vault: &Path) -> Result<PathBuf, AppError> {
    if !vault.is_dir() {
        return Err(AppError::message("vault path is not a directory"));
    }
    vault.canonicalize().map_err(AppError::from)
}

fn contained_existing(root: &Path, rel: &str, dir: bool) -> Result<PathBuf, AppError> {
    let candidate = root.join(rel);
    if !candidate.exists() {
        return Err(AppError::message(if dir {
            "directory not found"
        } else {
            "file not found"
        }));
    }
    let resolved = candidate.canonicalize()?;
    if !resolved.starts_with(root) {
        return Err(AppError::message("path escapes vault root"));
    }
    if dir && !resolved.is_dir() {
        return Err(AppError::message("path is not a directory"));
    }
    if !dir && !resolved.is_file() {
        return Err(AppError::message("path is not a file"));
    }
    Ok(resolved)
}

fn contained_write_target(root: &Path, rel: &str) -> Result<PathBuf, AppError> {
    let candidate = root.join(rel);
    let parent = candidate
        .parent()
        .ok_or_else(|| AppError::message("path has no parent"))?;
    let (existing, missing) = existing_ancestor(root, parent)?;
    let existing = existing.canonicalize()?;
    if !existing.starts_with(root) {
        return Err(AppError::message("path escapes vault root"));
    }
    if !existing.is_dir() {
        return Err(AppError::message("parent path is not a directory"));
    }
    let mut resolved = existing;
    for segment in missing.iter().rev() {
        resolved.push(segment);
    }
    let name = candidate
        .file_name()
        .ok_or_else(|| AppError::message("path has no file name"))?;
    resolved.push(name);
    if resolved.exists() {
        let canon = resolved.canonicalize()?;
        if !canon.starts_with(root) {
            return Err(AppError::message("path escapes vault root"));
        }
        if canon.is_dir() {
            return Err(AppError::message("path is a directory"));
        }
        return Ok(canon);
    }
    Ok(resolved)
}

/// Walk up to the nearest existing ancestor. Missing names are leaf-first.
fn existing_ancestor(
    root: &Path,
    dir: &Path,
) -> Result<(PathBuf, Vec<std::ffi::OsString>), AppError> {
    let mut missing = Vec::new();
    let mut current = dir.to_path_buf();
    loop {
        if current.exists() || current == root {
            return Ok((current, missing));
        }
        let Some(parent) = current.parent() else {
            return Err(AppError::message("path escapes vault root"));
        };
        if !parent.starts_with(root) && parent != root {
            return Err(AppError::message("path escapes vault root"));
        }
        let Some(name) = current.file_name() else {
            return Err(AppError::message("path escapes vault root"));
        };
        missing.push(name.to_os_string());
        current = parent.to_path_buf();
    }
}

fn entry_kind(root: &Path, path: &Path) -> Option<&'static str> {
    let file_type = fs::symlink_metadata(path).ok()?.file_type();
    if file_type.is_symlink() {
        let resolved = fs::canonicalize(path).ok()?;
        if !resolved.starts_with(root) {
            return None;
        }
        let meta = fs::metadata(path).ok()?;
        if meta.is_dir() {
            return Some("directory");
        }
        if meta.is_file() {
            return Some("file");
        }
        return None;
    }
    if file_type.is_dir() {
        Some("directory")
    } else if file_type.is_file() {
        Some("file")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn writes_and_reads_tex_outside_papers() {
        let dir = tempdir().unwrap();
        let out = write_text(
            dir.path(),
            "drafts/main.tex",
            "\\section{A}\n",
            WriteMode::Replace,
        )
        .unwrap();
        assert_eq!(out.path, "drafts/main.tex");
        assert_eq!(out.mode, "replace");
        let got = read_text(dir.path(), "drafts/main.tex").unwrap();
        assert_eq!(got.content, "\\section{A}\n");
        write_text(dir.path(), "drafts/main.tex", "more\n", WriteMode::Append).unwrap();
        let got = read_text(dir.path(), "drafts/main.tex").unwrap();
        assert_eq!(got.content, "\\section{A}\nmore\n");
    }

    #[test]
    fn list_shows_draft_and_hides_agentero() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".agentero")).unwrap();
        fs::write(dir.path().join(".agentero").join("catalog.sqlite"), b"no").unwrap();
        write_text(dir.path(), "drafts/main.tex", "hi", WriteMode::Replace).unwrap();
        let listed = list_dir(dir.path(), "", 50).unwrap();
        let paths: Vec<_> = listed.entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, vec!["drafts"]);
        let nested = list_dir(dir.path(), "drafts", 50).unwrap();
        assert_eq!(nested.entries[0].path, "drafts/main.tex");
        assert_eq!(nested.entries[0].kind, "file");
    }

    #[test]
    fn rejects_escape_hidden_notes_and_binary() {
        let dir = tempdir().unwrap();
        assert!(write_text(dir.path(), "../secret.tex", "x", WriteMode::Replace).is_err());
        fs::create_dir_all(dir.path().join(".agentero")).unwrap();
        assert!(read_text(dir.path(), ".agentero/catalog.sqlite").is_err());
        fs::create_dir_all(dir.path().join("papers/p1")).unwrap();
        let err = write_text(
            dir.path(),
            "papers/p1/NOTES.md",
            "# notes",
            WriteMode::Replace,
        )
        .unwrap_err();
        assert!(err.to_string().contains("paper_notes_write"), "{err}");
        let err = write_text(dir.path(), "drafts/fig.pdf", "%PDF", WriteMode::Replace).unwrap_err();
        assert!(err.to_string().contains("binary"), "{err}");
        write_text(dir.path(), "drafts/main.tex", "a\0b", WriteMode::Replace).unwrap_err();
    }

    #[test]
    fn writes_binary_files_byte_for_byte() {
        use base64::Engine;
        let dir = tempdir().unwrap();
        // PNG signature + bytes that are not UTF-8, including NUL.
        let png: Vec<u8> = [
            0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF, 0xFE,
        ]
        .into_iter()
        .chain(0..=255u8)
        .collect();
        let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
        let out = write_binary(dir.path(), "figures/plot.png", &b64).unwrap();
        assert_eq!(out.path, "figures/plot.png");
        assert_eq!(out.bytes, png.len());
        assert_eq!(fs::read(dir.path().join("figures/plot.png")).unwrap(), png);

        // A data URL, line-wrapped base64 and missing padding are accepted;
        // an existing file is replaced.
        let wrapped = format!("data:image/png;base64,{}\n{}", &b64[..40], &b64[40..]);
        write_binary(dir.path(), "figures/plot.png", &wrapped).unwrap();
        assert_eq!(fs::read(dir.path().join("figures/plot.png")).unwrap(), png);
        write_binary(dir.path(), "data/two.bin", "AAE").unwrap();
        assert_eq!(fs::read(dir.path().join("data/two.bin")).unwrap(), [0, 1]);

        // The text tools still refuse binaries.
        assert!(read_text(dir.path(), "figures/plot.png").is_err());
    }

    #[test]
    fn binary_write_rejects_bad_input_and_protected_paths() {
        let dir = tempdir().unwrap();
        let err = write_binary(dir.path(), "figures/a.png", "not base64!").unwrap_err();
        assert!(err.to_string().contains("not valid base64"), "{err}");
        let err = write_binary(dir.path(), "figures/a.png", "  ").unwrap_err();
        assert!(err.to_string().contains("empty"), "{err}");
        let err = write_binary(dir.path(), "figures/a.png", "data:image/png,abc").unwrap_err();
        assert!(err.to_string().contains("data URL"), "{err}");
        let huge = "A".repeat(MAX_BINARY_BYTES / 3 * 4 + 8);
        let err = write_binary(dir.path(), "figures/a.png", &huge).unwrap_err();
        assert!(err.to_string().contains("limited"), "{err}");
        assert!(!dir.path().join("figures").exists());

        for rel in [
            "../escape.png",
            ".agentero/catalog.sqlite",
            "papers/p1/NOTES.md",
            "papers/p1/marks/annotations.json",
        ] {
            assert!(write_binary(dir.path(), rel, "AAE=").is_err(), "{rel}");
        }
        fs::create_dir_all(dir.path().join("figures/dir.png")).unwrap();
        assert!(write_binary(dir.path(), "figures/dir.png", "AAE=").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_that_leaves_the_vault() {
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).unwrap();
        let err = write_text(dir.path(), "link/main.tex", "x", WriteMode::Replace).unwrap_err();
        assert!(err.to_string().contains("escapes"), "{err}");
        assert!(!outside.path().join("main.tex").exists());
    }

    #[test]
    fn moves_files_and_updates_wiki_links() {
        let dir = tempdir().unwrap();
        write_text(dir.path(), "drafts/old.md", "# Old\n", WriteMode::Replace).unwrap();
        write_text(
            dir.path(),
            "notes/Source.md",
            "See [[old]] for details.\n",
            WriteMode::Replace,
        )
        .unwrap();
        let mut index = WikiIndex::default();
        let out = move_entry(dir.path(), "drafts/old.md", "drafts/new.md", &mut index).unwrap();
        assert_eq!(out.moved_path, "drafts/new.md");
        assert!(!dir.path().join("drafts/old.md").exists());
        assert!(dir.path().join("drafts/new.md").exists());
        let source = read_text(dir.path(), "notes/Source.md").unwrap();
        assert!(
            source.content.contains("[[drafts/new]]"),
            "{}",
            source.content
        );
        assert!(move_entry(dir.path(), "drafts/new.md", "drafts/new.md", &mut index).is_err());
    }

    #[test]
    fn delete_moves_to_trash_and_can_restore() {
        let dir = tempdir().unwrap();
        write_text(dir.path(), "drafts/old.tex", "old\n", WriteMode::Replace).unwrap();
        let out = delete_paths(dir.path(), &["drafts/old.tex".into()], false).unwrap();
        assert_eq!(out.count, 1);
        assert_eq!(out.paths, vec!["drafts/old.tex"]);
        assert!(!dir.path().join("drafts/old.tex").exists());
        agentero_core::features::vault::trash::restore_batch(
            dir.path(),
            out.batch_id.as_deref().unwrap(),
        )
        .unwrap();
        assert_eq!(
            read_text(dir.path(), "drafts/old.tex").unwrap().content,
            "old\n"
        );
        let gone = delete_paths(dir.path(), &["drafts/old.tex".into()], true).unwrap();
        assert!(gone.permanent);
        assert!(gone.batch_id.is_none());
        assert!(!dir.path().join("drafts/old.tex").exists());
        assert!(delete_paths(dir.path(), &[".agentero".into()], false).is_err());
        assert!(delete_paths(dir.path(), &["papers".into()], false).is_err());
    }
}
