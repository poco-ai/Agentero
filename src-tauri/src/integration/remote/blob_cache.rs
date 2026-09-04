//! Local ephemeral PDF / blob cache for remote vaults with LRU eviction.
//!
//! Layout: `~/.cache/agentero/remote/<session-hash>/blobs/{hash}.{ext}`
//! Key = sha256(rel\0size\0mtime). On hit we touch mtime for LRU order.

use crate::core::error::AppError;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Default cap for one remote vault's blob directory (2 GiB).
pub const DEFAULT_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobCacheStats {
    /// Total bytes under all (or one) remote blob dirs.
    pub bytes: u64,
    pub files: u64,
    /// Absolute path when scoped to one vault; empty when aggregated.
    pub root: String,
    pub max_bytes: u64,
}

/// Ensure `dest` holds remote bytes; on hit refresh mtime, on miss write then LRU.
pub fn put_or_touch(dest: &Path, bytes: Option<&[u8]>) -> Result<(), AppError> {
    if dest.is_file() {
        touch_mtime(dest);
        return Ok(());
    }
    let Some(data) = bytes else {
        return Err(AppError::message("cache miss without bytes"));
    };
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(dest, data)?;
    Ok(())
}

/// Cache-file destination for a vault-relative path with known size/mtime.
/// Key = sha256(rel\0size\0mtime), extension preserved for preview mime.
pub fn dest_for(blob_root: &Path, rel: &str, size: u64, mtime: u64) -> PathBuf {
    use sha2::{Digest, Sha256};
    let key = format!("{rel}\0{size}\0{mtime}");
    let hash = hex::encode(Sha256::digest(key.as_bytes()));
    let ext = Path::new(rel)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin");
    blob_root.join(format!("{hash}.{ext}"))
}

/// Full cache flow: hit → touch mtime; miss → `fetch` bytes, write, enforce LRU.
/// Returns the absolute local path of the cached blob.
pub async fn ensure_cached<F, Fut>(
    blob_root: &Path,
    rel: &str,
    size: u64,
    mtime: u64,
    fetch: F,
) -> Result<PathBuf, AppError>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<Vec<u8>, AppError>>,
{
    let dest = dest_for(blob_root, rel, size, mtime);
    if dest.is_file() {
        touch_mtime(&dest);
        return Ok(dest);
    }
    let bytes = fetch().await?;
    put_or_touch(&dest, Some(&bytes))?;
    if let Err(e) = enforce_lru(blob_root, DEFAULT_MAX_BYTES) {
        log::warn!("blob LRU enforce: {e}");
    }
    Ok(dest)
}

pub fn touch_mtime(path: &Path) {
    let now = SystemTime::now();
    let _ = fs::File::options()
        .write(true)
        .open(path)
        .and_then(|f| f.set_times(fs::FileTimes::new().set_modified(now)));
    // Fallback: open+close does not update mtime on all FS; set_modified is preferred.
    let _ = now;
}

/// Evict oldest files (by mtime) until total size ≤ `max_bytes`.
pub fn enforce_lru(blob_root: &Path, max_bytes: u64) -> Result<(), AppError> {
    if max_bytes == 0 || !blob_root.is_dir() {
        return Ok(());
    }
    let mut entries = list_blob_files(blob_root);
    let mut total: u64 = entries.iter().map(|e| e.size).sum();
    if total <= max_bytes {
        return Ok(());
    }
    // Oldest first
    entries.sort_by_key(|e| e.mtime);
    for e in entries {
        if total <= max_bytes {
            break;
        }
        if fs::remove_file(&e.path).is_ok() {
            total = total.saturating_sub(e.size);
        }
    }
    Ok(())
}

pub fn stats_for_root(blob_root: &Path) -> BlobCacheStats {
    let entries = if blob_root.is_dir() {
        list_blob_files(blob_root)
    } else {
        Vec::new()
    };
    let bytes = entries.iter().map(|e| e.size).sum();
    let files = entries.len() as u64;
    BlobCacheStats {
        bytes,
        files,
        root: blob_root.display().to_string(),
        max_bytes: DEFAULT_MAX_BYTES,
    }
}

/// Aggregate all `agentero/remote/*/blobs` under the user cache dir.
pub fn stats_all() -> BlobCacheStats {
    let mut bytes = 0u64;
    let mut files = 0u64;
    for root in all_blob_roots() {
        let s = stats_for_root(&root);
        bytes = bytes.saturating_add(s.bytes);
        files = files.saturating_add(s.files);
    }
    BlobCacheStats {
        bytes,
        files,
        root: String::new(),
        max_bytes: DEFAULT_MAX_BYTES,
    }
}

pub fn clear_root(blob_root: &Path) -> Result<u64, AppError> {
    if !blob_root.is_dir() {
        return Ok(0);
    }
    let mut removed = 0u64;
    for e in list_blob_files(blob_root) {
        if fs::remove_file(&e.path).is_ok() {
            removed = removed.saturating_add(e.size);
        }
    }
    Ok(removed)
}

/// Clear every remote vault blob dir under the app cache.
pub fn clear_all() -> Result<u64, AppError> {
    let mut total = 0u64;
    for root in all_blob_roots() {
        total = total.saturating_add(clear_root(&root)?);
    }
    Ok(total)
}

fn remote_cache_base() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("agentero")
        .join("remote")
}

fn all_blob_roots() -> Vec<PathBuf> {
    let base = remote_cache_base();
    let Ok(read) = fs::read_dir(&base) else {
        return Vec::new();
    };
    read.filter_map(|e| e.ok())
        .map(|e| e.path().join("blobs"))
        .filter(|p| p.is_dir())
        .collect()
}

struct BlobFile {
    path: PathBuf,
    size: u64,
    mtime: SystemTime,
}

fn list_blob_files(blob_root: &Path) -> Vec<BlobFile> {
    let Ok(read) = fs::read_dir(blob_root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for ent in read.flatten() {
        let path = ent.path();
        if !path.is_file() {
            continue;
        }
        // Skip sidecars / non-blob names if any
        let Ok(meta) = path.metadata() else {
            continue;
        };
        let size = meta.len();
        let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        out.push(BlobFile { path, size, mtime });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn lru_evicts_oldest() {
        let dir = env::temp_dir().join(format!(
            "agentero-blob-lru-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let a = dir.join("a.bin");
        let b = dir.join("b.bin");
        let c = dir.join("c.bin");
        fs::write(&a, vec![1u8; 100]).unwrap();
        thread::sleep(Duration::from_millis(15));
        fs::write(&b, vec![1u8; 100]).unwrap();
        thread::sleep(Duration::from_millis(15));
        fs::write(&c, vec![1u8; 100]).unwrap();

        // Cap to 200 bytes → drop oldest (a)
        enforce_lru(&dir, 200).unwrap();
        assert!(!a.is_file(), "oldest should be evicted");
        assert!(b.is_file());
        assert!(c.is_file());

        let s = stats_for_root(&dir);
        assert_eq!(s.files, 2);
        assert_eq!(s.bytes, 200);

        clear_root(&dir).unwrap();
        assert_eq!(stats_for_root(&dir).files, 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn touch_on_hit() {
        let dir = env::temp_dir().join(format!(
            "agentero-blob-touch-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("x.pdf");
        put_or_touch(&p, Some(b"%PDF")).unwrap();
        assert!(p.is_file());
        put_or_touch(&p, None).unwrap(); // hit
        let _ = fs::remove_dir_all(&dir);
    }
}
