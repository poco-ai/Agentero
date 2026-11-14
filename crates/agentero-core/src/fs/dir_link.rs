//! Directory links inside a vault.
//!
//! A same-vault paper alias is one directory link, not a second copy. Unix
//! uses a relative symlink so the alias survives moving the vault. Windows
//! prefers a directory symlink and falls back to a junction when the process
//! cannot create symlinks; a junction stores an absolute target.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use super::{canonicalize_best_effort, normalize_rel_separators};

/// `link_rel`'s parent, expressed as a relative path to `target_rel`.
///
/// Both arguments are vault-relative and use `/`. The result also uses `/`
/// (`create_directory_link` converts separators on Windows).
pub fn relative_link_target(link_rel: &str, target_rel: &str) -> String {
    let link_parent = link_rel
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or("");
    let link_parts: Vec<&str> = link_parent
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    let target_parts: Vec<&str> = target_rel
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    let mut shared = 0;
    while shared < link_parts.len()
        && shared < target_parts.len()
        && link_parts[shared] == target_parts[shared]
    {
        shared += 1;
    }
    let mut parts = vec![".."; link_parts.len() - shared];
    parts.extend(target_parts[shared..].iter().copied());
    if parts.is_empty() {
        ".".to_string()
    } else {
        parts.join("/")
    }
}

/// A directory symlink or Windows junction, including one whose target is missing.
///
/// File symlinks are not directory links. `DirEntry::file_type().is_dir()` is
/// false for a symlink, and true for a junction, so callers that only check
/// `is_dir()` either hide the alias or walk it as a second folder.
pub fn is_linked_dir(path: &Path) -> bool {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return false;
    };
    if !is_reparse(&meta) {
        return false;
    }
    match fs::metadata(path) {
        Ok(followed) => followed.is_dir(),
        // A dangling file symlink has no directory attribute. A junction and a
        // directory symlink keep it even when the target is gone.
        Err(_) => meta.is_dir(),
    }
}

/// Vault-relative target of a directory link, when that target stays inside
/// `vault_root`. `None` for real directories, file symlinks, and links that
/// point outside the vault or do not resolve.
pub fn linked_dir_vault_rel(vault_root: &Path, rel: &str) -> Option<String> {
    let rel = normalize_rel_separators(rel);
    let abs = vault_root.join(&rel);
    if !is_linked_dir(&abs) {
        return None;
    }
    let canon = fs::canonicalize(&abs).ok()?;
    let root = canonicalize_best_effort(vault_root);
    let stripped = canon.strip_prefix(&root).ok()?;
    let canon_rel = normalize_rel_separators(&stripped.to_string_lossy());
    if canon_rel.is_empty() || canon_rel == rel {
        return None;
    }
    Some(canon_rel)
}

/// Create a directory link at `link` pointing at `abs_target`.
///
/// `rel_target` is the stored symlink text (relative, `/`-separated). On
/// Windows a symlink is kept only when it can be read; otherwise the broken
/// link is removed and a junction to `abs_target` is created.
pub fn create_directory_link(rel_target: &Path, abs_target: &Path, link: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        let _ = abs_target;
        std::os::unix::fs::symlink(rel_target, link)
    }
    #[cfg(windows)]
    {
        let windows_target = rel_target.to_string_lossy().replace('/', "\\");
        if std::os::windows::fs::symlink_dir(&windows_target, link).is_ok()
            && fs::metadata(link).is_ok()
        {
            return Ok(());
        }
        if link.symlink_metadata().is_ok() {
            let _ = fs::remove_dir(link);
            let _ = fs::remove_file(link);
        }
        create_junction(abs_target, link)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (rel_target, abs_target, link);
        Err(io::Error::other(
            "directory links are not supported on this platform",
        ))
    }
}

/// Remove a directory symlink or junction without deleting the target's contents.
pub fn remove_directory_link(path: &Path) -> io::Result<()> {
    fs::remove_dir(path).or_else(|_| fs::remove_file(path))
}

fn is_reparse(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        meta.file_type().is_symlink() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

#[cfg(windows)]
fn create_junction(target: &Path, link: &Path) -> io::Result<()> {
    use std::process::Command;

    // `mklink` needs existing absolute paths and rejects the `\\?\` prefix that
    // `canonicalize` returns for drive paths. The link itself does not exist yet,
    // so resolve its parent and keep the file name.
    let link_name = link
        .file_name()
        .ok_or_else(|| io::Error::other("link path has no file name"))?;
    let link_abs = crate::process::windows_shell_path(
        &link
            .parent()
            .ok_or_else(|| io::Error::other("link path has no parent"))?
            .canonicalize()?,
    )
    .join(link_name);
    let target_abs = crate::process::windows_shell_path(&target.canonicalize()?);

    let mut command = Command::new("cmd");
    command
        .arg("/D")
        .arg("/C")
        .arg("mklink")
        .arg("/J")
        .arg(&link_abs)
        .arg(&target_abs);
    crate::process::hide_console_window(&mut command);
    let output = command.output()?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr);
    let detail = detail.trim();
    Err(io::Error::other(if detail.is_empty() {
        format!("mklink /J exited with {:?}", output.status.code())
    } else {
        format!("mklink /J failed: {detail}")
    }))
}

/// Absolute path of a directory link's target, for copying bytes rather than
/// the link itself. Real directories canonicalize to themselves.
pub fn resolved_dir(path: &Path) -> io::Result<PathBuf> {
    fs::canonicalize(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_link_target_walks_up_to_the_shared_prefix() {
        assert_eq!(
            relative_link_target("papers/archive/demo", "papers/inbox/demo"),
            "../inbox/demo"
        );
        assert_eq!(
            relative_link_target("papers/shelf/sub/demo", "papers/inbox/demo"),
            "../../inbox/demo"
        );
    }
}
