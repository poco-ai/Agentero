//! Host-owned Vault file operations used by background workflows.
//!
//! Paths cross IPC only as Vault-relative strings. Local files are resolved
//! against a canonical root; remote files stay behind the [`VaultFs`] boundary.

use crate::core::error::AppError;
use crate::core::fs::{sanitize_vault_rel, VaultFs, WriteOpts};
use crate::features::remote::{parse_remote_handle, RemoteRegistry};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;
use walkdir::WalkDir;

const HASH_BUFFER_SIZE: usize = 256 * 1024;
const SNAPSHOT_WORKSPACE_ROOT: &str = "agentero-defense-snapshots";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultFileFingerprint {
    /// Normalized Vault-relative path.
    pub path: String,
    pub size: u64,
    /// Modified time in Unix seconds, matching `FsFileMeta`.
    pub mtime: u64,
    /// Lowercase SHA-256 hex.
    pub hash: String,
}

/// Validate an IPC-provided Vault path before normalization can erase evidence
/// of an absolute path (for example `/tmp/x` or `C:\\tmp\\x`).
fn strict_vault_rel(raw: &str) -> Result<String, AppError> {
    let rel = raw.trim();
    if rel.is_empty() {
        return Err(AppError::message("empty vault path"));
    }
    if rel.starts_with('/') || rel.starts_with('\\') || Path::new(rel).is_absolute() {
        return Err(AppError::message("vault path must be relative"));
    }
    let bytes = rel.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Err(AppError::message("vault path must not use a drive prefix"));
    }
    if rel.split(['/', '\\']).any(|component| component == "..") {
        return Err(AppError::message("path escapes vault root"));
    }
    sanitize_vault_rel(rel).map_err(AppError::message)
}

fn modified_seconds(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn file_unchanged(before: &std::fs::Metadata, after: &std::fs::Metadata) -> bool {
    before.len() == after.len() && before.modified().ok() == after.modified().ok()
}

async fn canonical_local_root(vault_root: &str) -> Result<PathBuf, AppError> {
    let root = PathBuf::from(vault_root.trim());
    if !root.is_absolute() {
        return Err(AppError::message("local vault root must be absolute"));
    }
    let canonical = fs::canonicalize(&root)
        .await
        .map_err(|error| AppError::message(format!("resolve vault root: {error}")))?;
    let meta = fs::metadata(&canonical)
        .await
        .map_err(|error| AppError::message(format!("stat vault root: {error}")))?;
    if !meta.is_dir() {
        return Err(AppError::message("vault root is not a directory"));
    }
    Ok(canonical)
}

async fn fingerprint_local(root: &Path, rel: &str) -> Result<VaultFileFingerprint, AppError> {
    let candidate = root.join(rel);
    let target = fs::canonicalize(&candidate)
        .await
        .map_err(|error| AppError::message(format!("resolve {}: {error}", candidate.display())))?;
    if !target.starts_with(root) {
        return Err(AppError::message("path escapes vault root"));
    }

    let before = fs::metadata(&target)
        .await
        .map_err(|error| AppError::message(format!("stat {}: {error}", target.display())))?;
    if !before.is_file() {
        return Err(AppError::message("vault path is not a file"));
    }

    let mut file = fs::File::open(&target)
        .await
        .map_err(|error| AppError::message(format!("open {}: {error}", target.display())))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; HASH_BUFFER_SIZE];
    let mut bytes_read = 0_u64;
    loop {
        let count = file
            .read(&mut buffer)
            .await
            .map_err(|error| AppError::message(format!("read {}: {error}", target.display())))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        bytes_read += count as u64;
    }

    let after = fs::metadata(&target)
        .await
        .map_err(|error| AppError::message(format!("restat {}: {error}", target.display())))?;
    if bytes_read != before.len() || !file_unchanged(&before, &after) {
        return Err(AppError::message("vault file changed while hashing"));
    }

    Ok(VaultFileFingerprint {
        path: rel.to_string(),
        size: bytes_read,
        mtime: modified_seconds(&after),
        hash: hex::encode(hasher.finalize()),
    })
}

async fn fingerprint_vault_fs(
    vault_fs: &dyn VaultFs,
    rel: &str,
) -> Result<VaultFileFingerprint, AppError> {
    let before = vault_fs.stat(rel).await?;
    if !before.is_file {
        return Err(AppError::message("vault path is not a file"));
    }
    let bytes = vault_fs.read(rel).await?;
    let after = vault_fs.stat(rel).await?;
    if bytes.len() as u64 != before.size || before != after {
        return Err(AppError::message("vault file changed while hashing"));
    }
    Ok(VaultFileFingerprint {
        path: rel.to_string(),
        size: after.size,
        mtime: after.mtime,
        hash: hex::encode(Sha256::digest(&bytes)),
    })
}

fn split_parent_and_name(rel: &str) -> Result<(&str, &str), AppError> {
    match rel.rsplit_once('/') {
        Some((parent, name)) if !name.is_empty() => Ok((parent, name)),
        None if !rel.is_empty() => Ok(("", rel)),
        _ => Err(AppError::message("invalid vault file path")),
    }
}

async fn resolve_local_parent(root: &Path, parent_rel: &str) -> Result<PathBuf, AppError> {
    let mut resolved = root.to_path_buf();
    if parent_rel.is_empty() {
        return Ok(resolved);
    }

    for component in parent_rel.split('/') {
        let candidate = resolved.join(component);
        match fs::symlink_metadata(&candidate).await {
            Ok(_) => {
                let canonical = fs::canonicalize(&candidate).await.map_err(|error| {
                    AppError::message(format!("resolve {}: {error}", candidate.display()))
                })?;
                if !canonical.starts_with(root) {
                    return Err(AppError::message("path escapes vault root"));
                }
                let meta = fs::metadata(&canonical).await.map_err(|error| {
                    AppError::message(format!("stat {}: {error}", canonical.display()))
                })?;
                if !meta.is_dir() {
                    return Err(AppError::message("vault path parent is not a directory"));
                }
                resolved = canonical;
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {
                fs::create_dir(&candidate).await.map_err(|error| {
                    AppError::message(format!("create directory {}: {error}", candidate.display()))
                })?;
                let canonical = fs::canonicalize(&candidate).await.map_err(|error| {
                    AppError::message(format!("resolve {}: {error}", candidate.display()))
                })?;
                if !canonical.starts_with(root) {
                    return Err(AppError::message("path escapes vault root"));
                }
                resolved = canonical;
            }
            Err(error) => {
                return Err(AppError::message(format!(
                    "inspect directory {}: {error}",
                    candidate.display()
                )))
            }
        }
    }
    Ok(resolved)
}

fn atomic_temp_name(name: &str) -> String {
    format!(".{name}.agentero-rename-{}.tmp", Uuid::new_v4())
}

fn safe_workspace_id(raw: &str) -> Result<&str, AppError> {
    let value = raw.trim();
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(AppError::message("invalid snapshot workspace id"));
    }
    Ok(value)
}

fn set_workspace_readonly(workspace: &Path) -> Result<(), AppError> {
    let entries = WalkDir::new(workspace)
        .follow_links(false)
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| AppError::message(format!("walk snapshot workspace: {error}")))?;
    for entry in entries.into_iter().rev() {
        let mut permissions = entry
            .metadata()
            .map_err(|error| AppError::message(format!("stat snapshot workspace: {error}")))?
            .permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(entry.path(), permissions)
            .map_err(|error| AppError::message(format!("protect snapshot workspace: {error}")))?;
    }
    Ok(())
}

fn make_workspace_writable(workspace: &Path) -> Result<(), AppError> {
    let entries = WalkDir::new(workspace)
        .follow_links(false)
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| AppError::message(format!("walk snapshot workspace: {error}")))?;
    for entry in entries {
        let metadata = entry
            .metadata()
            .map_err(|error| AppError::message(format!("stat snapshot workspace: {error}")))?;
        let mut permissions = metadata.permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let writable = if metadata.is_dir() { 0o700 } else { 0o600 };
            permissions.set_mode(permissions.mode() | writable);
        }
        #[cfg(not(unix))]
        permissions.set_readonly(false);
        std::fs::set_permissions(entry.path(), permissions)
            .map_err(|error| AppError::message(format!("unprotect snapshot workspace: {error}")))?;
    }
    Ok(())
}

/// Copy the immutable source list into a Host-owned, read-only workspace.
/// This deliberately supports local Vaults only; remote ACP processes retain
/// their existing remote cwd and are still constrained by the read-only prompt.
pub async fn materialize_local_snapshot_workspace(
    vault_root: &str,
    workspace_id: &str,
    source_paths: &[String],
) -> Result<String, AppError> {
    let id = safe_workspace_id(workspace_id)?;
    let root = canonical_local_root(vault_root).await?;
    let workspace = std::env::temp_dir().join(SNAPSHOT_WORKSPACE_ROOT).join(id);
    if let Some(parent) = workspace.parent() {
        fs::create_dir_all(parent).await.map_err(|error| {
            AppError::message(format!("create snapshot workspace parent: {error}"))
        })?;
    }
    if workspace.exists() {
        let existing = fs::canonicalize(&workspace)
            .await
            .map_err(|error| AppError::message(format!("resolve snapshot workspace: {error}")))?;
        make_workspace_writable(&existing)?;
        fs::remove_dir_all(&existing)
            .await
            .map_err(|error| AppError::message(format!("replace snapshot workspace: {error}")))?;
    }
    fs::create_dir_all(&workspace)
        .await
        .map_err(|error| AppError::message(format!("create snapshot workspace: {error}")))?;
    let workspace_root = fs::canonicalize(&workspace)
        .await
        .map_err(|error| AppError::message(format!("resolve snapshot workspace: {error}")))?;

    let result = async {
        for raw_path in source_paths {
            let rel = strict_vault_rel(raw_path)?;
            let before = fingerprint_local(&root, &rel).await?;
            let source = root.join(&rel);
            let destination = workspace.join(&rel);
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).await.map_err(|error| {
                    AppError::message(format!("create snapshot source directory: {error}"))
                })?;
            }
            fs::copy(&source, &destination).await.map_err(|error| {
                AppError::message(format!("copy snapshot source {rel}: {error}"))
            })?;
            let after = fingerprint_local(&root, &rel).await?;
            if before.hash != after.hash || before.size != after.size || before.mtime != after.mtime
            {
                return Err(AppError::message(format!(
                    "source changed while creating snapshot: {rel}"
                )));
            }
            let copied = fingerprint_local(&workspace_root, &rel).await?;
            if copied.hash != before.hash || copied.size != before.size {
                return Err(AppError::message(format!(
                    "snapshot copy verification failed: {rel}"
                )));
            }
        }
        set_workspace_readonly(&workspace)?;
        Ok::<(), AppError>(())
    }
    .await;
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&workspace).await;
        return Err(error);
    }
    Ok(workspace.to_string_lossy().into_owned())
}

pub async fn release_local_snapshot_workspace(path: &str) -> Result<(), AppError> {
    let workspace = PathBuf::from(path.trim());
    let root = std::env::temp_dir().join(SNAPSHOT_WORKSPACE_ROOT);
    let workspace_id = workspace
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| AppError::message("invalid snapshot workspace path"))?;
    safe_workspace_id(workspace_id)?;
    if workspace != root.join(workspace_id) {
        return Err(AppError::message(
            "snapshot workspace is outside the Host temp root",
        ));
    }
    if !workspace.exists() {
        return Ok(());
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|error| AppError::message(format!("resolve snapshot root: {error}")))?;
    let canonical_workspace = workspace
        .canonicalize()
        .map_err(|error| AppError::message(format!("resolve snapshot workspace: {error}")))?;
    if canonical_workspace.parent() != Some(canonical_root.as_path()) {
        return Err(AppError::message(
            "snapshot workspace is outside the Host temp root",
        ));
    }
    make_workspace_writable(&canonical_workspace)?;
    fs::remove_dir_all(canonical_workspace)
        .await
        .map_err(|error| AppError::message(format!("remove snapshot workspace: {error}")))
}

#[cfg(not(target_os = "windows"))]
async fn replace_file(temp: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(temp, target).await
}

#[cfg(target_os = "windows")]
async fn replace_file(temp: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

async fn write_local_temp_and_replace(target: &Path, content: &[u8]) -> Result<(), AppError> {
    let parent = target
        .parent()
        .ok_or_else(|| AppError::message("vault file has no parent directory"))?;
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| AppError::message("invalid vault filename"))?;
    let temp = parent.join(atomic_temp_name(name));

    let result = async {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .await?;
        file.write_all(content).await?;
        file.flush().await?;
        file.sync_all().await?;
        drop(file);
        replace_file(&temp, target).await
    }
    .await;

    if let Err(error) = result {
        let _ = fs::remove_file(&temp).await;
        return Err(AppError::message(format!(
            "atomic write {}: {error}",
            target.display()
        )));
    }
    Ok(())
}

async fn write_local_atomic(root: &Path, rel: &str, content: &[u8]) -> Result<(), AppError> {
    let (parent_rel, name) = split_parent_and_name(rel)?;
    let parent = resolve_local_parent(root, parent_rel).await?;
    // Re-resolve the parent immediately before the write to catch a replaced
    // symlink or directory after the component-by-component walk.
    let parent = fs::canonicalize(&parent)
        .await
        .map_err(|error| AppError::message(format!("resolve target parent: {error}")))?;
    if !parent.starts_with(root) {
        return Err(AppError::message("path escapes vault root"));
    }
    let target = parent.join(name);
    match fs::symlink_metadata(&target).await {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(AppError::message("refusing to replace a symlink"))
        }
        Ok(meta) if meta.is_dir() => return Err(AppError::message("vault path is a directory")),
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => {
            return Err(AppError::message(format!(
                "inspect target {}: {error}",
                target.display()
            )))
        }
    }
    write_local_temp_and_replace(&target, content).await
}

async fn write_vault_fs_atomic(
    vault_fs: &dyn VaultFs,
    rel: &str,
    content: &[u8],
) -> Result<(), AppError> {
    let (parent, name) = split_parent_and_name(rel)?;
    match vault_fs.stat(rel).await {
        Ok(meta) if meta.is_dir => return Err(AppError::message("vault path is a directory")),
        Ok(_) => {}
        Err(error)
            if error.to_string().to_ascii_lowercase().contains("not found")
                || error
                    .to_string()
                    .to_ascii_lowercase()
                    .contains("no such file") => {}
        Err(error) => return Err(error),
    }
    let temp_name = atomic_temp_name(name);
    let temp_rel = if parent.is_empty() {
        temp_name
    } else {
        format!("{parent}/{temp_name}")
    };

    if let Err(error) = vault_fs
        .write(
            &temp_rel,
            content,
            WriteOpts {
                create_parents: true,
            },
        )
        .await
    {
        let _ = vault_fs.remove(&temp_rel, false).await;
        return Err(error);
    }
    if let Err(error) = vault_fs.rename(&temp_rel, rel).await {
        let _ = vault_fs.remove(&temp_rel, false).await;
        return Err(error);
    }
    Ok(())
}

pub async fn fingerprint_vault_file(
    registry: &RemoteRegistry,
    vault_root: &str,
    vault_relative_path: &str,
) -> Result<VaultFileFingerprint, AppError> {
    let rel = strict_vault_rel(vault_relative_path)?;
    if let Some(session_id) = parse_remote_handle(vault_root) {
        let session = registry.get(session_id).await?;
        return fingerprint_vault_fs(session.fs.as_ref(), &rel).await;
    }
    let root = canonical_local_root(vault_root).await?;
    fingerprint_local(&root, &rel).await
}

pub async fn write_vault_file_atomic(
    registry: &RemoteRegistry,
    vault_root: &str,
    vault_relative_path: &str,
    content: &str,
) -> Result<(), AppError> {
    let rel = strict_vault_rel(vault_relative_path)?;
    if let Some(session_id) = parse_remote_handle(vault_root) {
        let session = registry.get(session_id).await?;
        return write_vault_fs_atomic(session.fs.as_ref(), &rel, content.as_bytes()).await;
    }
    let root = canonical_local_root(vault_root).await?;
    write_local_atomic(&root, &rel, content.as_bytes()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::fs::LocalFs;

    fn temp_vault() -> PathBuf {
        let root = std::env::temp_dir().join(format!("agentero-host-fs-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp vault");
        std::fs::canonicalize(root).expect("canonicalize temp vault")
    }

    fn temp_files(root: &Path) -> Vec<String> {
        std::fs::read_dir(root)
            .expect("read temp vault")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".agentero-rename-"))
            .collect()
    }

    #[test]
    fn strict_relative_path_rejects_ambiguous_roots_and_escape() {
        for invalid in [
            "",
            "   ",
            "/tmp/file",
            "\\\\server\\share\\file",
            "\\rooted",
            "C:\\tmp\\file",
            "c:/tmp/file",
            "../file",
            "notes/../../file",
        ] {
            assert!(strict_vault_rel(invalid).is_err(), "accepted {invalid:?}");
        }
        assert_eq!(
            strict_vault_rel("papers\\demo/./NOTES.md").unwrap(),
            "papers/demo/NOTES.md"
        );
    }

    #[tokio::test]
    async fn fingerprints_known_hash_and_large_file_by_streaming() {
        let root = temp_vault();
        std::fs::write(root.join("small.txt"), b"abc").unwrap();
        let small = fingerprint_local(&root, "small.txt").await.unwrap();
        assert_eq!(small.size, 3);
        assert_eq!(
            small.hash,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );

        let large_bytes = vec![0x5a; HASH_BUFFER_SIZE * 5 + 17];
        std::fs::write(root.join("large.pdf"), &large_bytes).unwrap();
        let large = fingerprint_local(&root, "large.pdf").await.unwrap();
        assert_eq!(large.size, large_bytes.len() as u64);
        assert_eq!(large.hash, hex::encode(Sha256::digest(&large_bytes)));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn generic_vault_fs_fingerprint_and_atomic_write_roundtrip() {
        let root = temp_vault();
        let vault_fs = LocalFs::new(&root);
        write_vault_fs_atomic(&vault_fs, "plans/manifest.md", b"first")
            .await
            .unwrap();
        write_vault_fs_atomic(&vault_fs, "plans/manifest.md", b"second")
            .await
            .unwrap();
        let fingerprint = fingerprint_vault_fs(&vault_fs, "plans/manifest.md")
            .await
            .unwrap();
        assert_eq!(fingerprint.size, 6);
        assert_eq!(
            std::fs::read(root.join("plans/manifest.md")).unwrap(),
            b"second"
        );
        assert!(temp_files(&root.join("plans")).is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn local_atomic_overwrite_leaves_no_temp_file() {
        let root = temp_vault();
        std::fs::create_dir_all(root.join("plans")).unwrap();
        std::fs::write(root.join("plans/manifest.md"), "old").unwrap();
        write_local_atomic(&root, "plans/manifest.md", b"new")
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("plans/manifest.md")).unwrap(),
            "new"
        );
        assert!(temp_files(&root.join("plans")).is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn failed_replace_preserves_target_and_cleans_temp() {
        let root = temp_vault();
        let target = root.join("manifest.md");
        std::fs::create_dir(&target).unwrap();
        let error = write_local_temp_and_replace(&target, b"new")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("atomic write"));
        assert!(target.is_dir());
        assert!(temp_files(&root).is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn snapshot_workspace_is_verified_immutable_and_released_idempotently() {
        let root = temp_vault();
        std::fs::create_dir_all(root.join("papers/demo/figures")).unwrap();
        std::fs::write(root.join("papers/demo/PAPER.md"), "original paper").unwrap();
        let binary = [0_u8, 1, 2, 0xff, 0x80];
        std::fs::write(root.join("papers/demo/figures/result.png"), binary).unwrap();
        let workspace_id = format!("test-{}", Uuid::new_v4());
        let workspace = PathBuf::from(
            materialize_local_snapshot_workspace(
                root.to_str().unwrap(),
                &workspace_id,
                &[
                    "papers/demo/PAPER.md".to_string(),
                    "papers/demo/figures/result.png".to_string(),
                ],
            )
            .await
            .unwrap(),
        );

        assert_eq!(
            std::fs::read_to_string(workspace.join("papers/demo/PAPER.md")).unwrap(),
            "original paper"
        );
        assert_eq!(
            std::fs::read(workspace.join("papers/demo/figures/result.png")).unwrap(),
            binary
        );
        std::fs::write(root.join("papers/demo/PAPER.md"), "changed paper").unwrap();
        assert_eq!(
            std::fs::read_to_string(workspace.join("papers/demo/PAPER.md")).unwrap(),
            "original paper"
        );

        let recreated = materialize_local_snapshot_workspace(
            root.to_str().unwrap(),
            &workspace_id,
            &["papers/demo/PAPER.md".to_string()],
        )
        .await
        .unwrap();
        assert_eq!(PathBuf::from(&recreated), workspace);
        assert_eq!(
            std::fs::read_to_string(workspace.join("papers/demo/PAPER.md")).unwrap(),
            "changed paper"
        );
        assert!(!workspace.join("papers/demo/figures/result.png").exists());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for path in [
                workspace.clone(),
                workspace.join("papers/demo"),
                workspace.join("papers/demo/PAPER.md"),
            ] {
                assert_eq!(
                    std::fs::metadata(path).unwrap().permissions().mode() & 0o222,
                    0
                );
            }
        }

        release_local_snapshot_workspace(workspace.to_str().unwrap())
            .await
            .unwrap();
        assert!(!workspace.exists());
        release_local_snapshot_workspace(workspace.to_str().unwrap())
            .await
            .unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn snapshot_workspace_rejects_invalid_sources_and_release_paths() {
        let root = temp_vault();
        std::fs::write(root.join("paper.md"), "paper").unwrap();
        assert!(materialize_local_snapshot_workspace(
            root.to_str().unwrap(),
            "../outside",
            &["paper.md".to_string()],
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("invalid snapshot workspace id"));
        assert!(materialize_local_snapshot_workspace(
            root.to_str().unwrap(),
            &format!("test-{}", Uuid::new_v4()),
            &["../paper.md".to_string()],
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("escapes"));
        assert!(release_local_snapshot_workspace(root.to_str().unwrap())
            .await
            .unwrap_err()
            .to_string()
            .contains("outside"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_paths_cannot_escape_through_symlinks() {
        use std::os::unix::fs::symlink;

        let root = temp_vault();
        let outside = temp_vault();
        std::fs::write(outside.join("secret.txt"), "secret").unwrap();
        symlink(&outside, root.join("outside")).unwrap();

        assert!(fingerprint_local(&root, "outside/secret.txt")
            .await
            .unwrap_err()
            .to_string()
            .contains("escapes"));
        assert!(write_local_atomic(&root, "outside/manifest.md", b"blocked")
            .await
            .unwrap_err()
            .to_string()
            .contains("escapes"));
        assert!(!outside.join("manifest.md").exists());
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }
}
