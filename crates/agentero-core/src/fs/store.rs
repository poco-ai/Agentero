//! Atomic local-disk writes: exclusive sibling temp file + replacement.
//!
//! Before `docs/development/refactor-audit-2026-08.md` P2-17, eight features
//! each open-coded their own "write temp, rename into place" loop (temp
//! naming / 0o600 permissions in every possible combination). They now share
//! this module. Failed replacement never falls back to truncating the target.
//!
//! Contracts preserved from the originals:
//! - temp files end in `.tmp` by default — `features/sync/snapshot.rs`
//!   excludes `*.tmp` from vault scans, so temps are never synced;
//! - wiki rename passes a `.agentero-rename-` temp name so
//!   `features/watcher` classifies the swap as a content modify instead of a
//!   user rename;
//! - the deliberate FSEvents exceptions (doctor alias repair, refs cite
//!   sidecars) stay plain in-place writes and must NOT use this module.
//!
//! File-content syncing is opt-in; parent directories are not synced. This
//! guarantees atomic replacement, not crash-proof persistence of the rename.

use crate::error::AppError;
use serde::Serialize;
use std::fs;
use std::io::{self, Write};
use std::path::Path;

/// Options for [`atomic_write_with`] / [`json_store_with`].
#[derive(Debug, Clone, Default)]
pub struct AtomicOpts {
    /// Exact sibling temp file name, exclusively created. Callers supplying
    /// one must choose a unique name (Wiki uses a UUID); collisions fail
    /// without overwriting it. The default is a short unique sibling ending in
    /// `.tmp`, so long target names fit, concurrent writers cannot share staging
    /// files, and sync scans skip them.
    pub temp_name: Option<String>,
    /// Unix permission mode applied to the written file (best-effort), e.g.
    /// `0o600` for files that hold secrets. Ignored on other platforms.
    pub unix_mode: Option<u32>,
    /// Sync the file's contents before replacing the target. The containing
    /// directory is not synced, so this does not guarantee rename durability.
    pub sync_file: bool,
}

impl AtomicOpts {
    /// Owner-only file on Unix (0o600): settings / sync credentials.
    pub const OWNER_ONLY: Self = Self {
        temp_name: None,
        unix_mode: Some(0o600),
        sync_file: false,
    };
}

/// Atomic write with default options (unique sibling ending in `.tmp`).
pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    atomic_write_with(path, bytes, &AtomicOpts::default())
}

/// Write `bytes` through an exclusively created sibling, then atomically
/// replace `path` on Unix and Windows. A failed write/replacement leaves the
/// existing target untouched and removes only this invocation's temporary file.
pub fn atomic_write_with(path: &Path, bytes: &[u8], opts: &AtomicOpts) -> io::Result<()> {
    let mut temp = create_temp(path, opts)?;
    temp.write_all(bytes)?;
    apply_mode(temp.as_file(), opts);
    if opts.sync_file {
        temp.as_file().sync_all()?;
    }
    persist_replace(temp, path)
}

/// Replace `path` with the staged file. Concurrent Windows replacements of the
/// same path can make `MoveFileExW` return access-denied or a sharing
/// violation. Writers of one path take the same shard so they do not collide,
/// and a remaining transient error is retried. A persistently locked target is
/// left untouched.
fn persist_replace(temp: tempfile::NamedTempFile, path: &Path) -> io::Result<()> {
    let _guard = replace_guard(path);
    let mut temp = temp;
    let started = std::time::Instant::now();
    let mut attempt = 0u32;
    loop {
        match temp.persist(path) {
            Ok(_) => return Ok(()),
            Err(error) => {
                let timed_out = started.elapsed() >= std::time::Duration::from_secs(5);
                if !transient_replace(&error.error) || timed_out {
                    return Err(error.error);
                }
                temp = error.file;
                let step = 1u64 << attempt.min(5);
                let jitter = thread_mix() % (step + 1);
                std::thread::sleep(std::time::Duration::from_millis(step + jitter));
                attempt = attempt.saturating_add(1);
            }
        }
    }
}

#[cfg(windows)]
fn replace_guard(path: &Path) -> std::sync::MutexGuard<'static, ()> {
    use std::sync::Mutex;
    const SHARDS: usize = 32;
    static LOCKS: [Mutex<()>; SHARDS] = [const { Mutex::new(()) }; SHARDS];
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in path.as_os_str().as_encoded_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    LOCKS[(hash as usize) % SHARDS]
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
}

#[cfg(not(windows))]
fn replace_guard(_path: &Path) {}

fn thread_mix() -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    std::thread::current().id().hash(&mut hasher);
    hasher.finish()
}

#[cfg(windows)]
fn transient_replace(error: &io::Error) -> bool {
    // ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION.
    matches!(error.raw_os_error(), Some(5 | 32 | 33))
}

#[cfg(not(windows))]
fn transient_replace(_error: &io::Error) -> bool {
    false
}

/// Serialize `value` as pretty JSON and write it atomically (see
/// [`atomic_write`]). Field order and formatting come from the `Serialize`
/// impl, exactly as a direct `serde_json::to_vec_pretty` would produce.
pub fn json_store<T: Serialize>(path: &Path, value: &T) -> Result<(), AppError> {
    json_store_with(path, value, &AtomicOpts::default())
}

/// [`json_store`] with options (e.g. [`AtomicOpts::OWNER_ONLY`] for secrets).
pub fn json_store_with<T: Serialize>(
    path: &Path,
    value: &T,
    opts: &AtomicOpts,
) -> Result<(), AppError> {
    let raw = serde_json::to_vec_pretty(value)?;
    atomic_write_with(path, &raw, opts)?;
    Ok(())
}

fn create_temp(path: &Path, opts: &AtomicOpts) -> io::Result<tempfile::NamedTempFile> {
    let name = path.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "atomic write target has no file name",
        )
    })?;
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut builder = tempfile::Builder::new();
    // NamedTempFile defaults to 0600. Preserve fs::write's 0666 & umask default
    // for ordinary Vault files; secret writers explicitly request 0600.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(fs::Permissions::from_mode(opts.unix_mode.unwrap_or(0o666)));
    }
    if let Some(custom) = &opts.temp_name {
        let custom = std::ffi::OsStr::new(custom);
        if Path::new(custom).file_name() != Some(custom) || custom == name {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "atomic write temp must be a distinct sibling file name",
            ));
        }
        builder.prefix(custom).rand_bytes(0);
    } else {
        builder.prefix(".agentero-write-").suffix(".tmp");
    }
    builder.tempfile_in(parent)
}

/// Best-effort permission change, mirroring the original `let _ = …` calls.
/// Applied through the open file before replacement, so the target never
/// exists with looser permissions and no second path lookup is needed.
#[cfg(unix)]
fn apply_mode(file: &fs::File, opts: &AtomicOpts) {
    use std::os::unix::fs::PermissionsExt;
    if let Some(mode) = opts.unix_mode {
        let _ = file.set_permissions(fs::Permissions::from_mode(mode));
    }
}

#[cfg(not(unix))]
fn apply_mode(_file: &fs::File, _opts: &AtomicOpts) {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn atomic_write_replaces_content_and_leaves_no_temp() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("notes.md");
        fs::write(&path, "old").expect("seed");

        atomic_write(&path, b"new").expect("atomic write");

        assert_eq!(fs::read_to_string(&path).expect("read"), "new");
        let names: Vec<String> = fs::read_dir(dir.path())
            .expect("read_dir")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert_eq!(names, vec!["notes.md".to_string()]);
    }

    #[test]
    fn custom_temp_name_is_honored_and_cleaned_up() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("NOTES.md");
        // Watcher contract: wiki temps carry the `.agentero-rename-` marker.
        let opts = AtomicOpts {
            temp_name: Some(".NOTES.md.agentero-rename-deadbeef.tmp".into()),
            ..Default::default()
        };
        let temp = create_temp(&path, &opts).expect("custom temp");
        assert_eq!(
            temp.path().file_name().unwrap(),
            ".NOTES.md.agentero-rename-deadbeef.tmp"
        );
        drop(temp);

        atomic_write_with(&path, b"x", &opts).expect("atomic write");

        assert_eq!(fs::read(&path).expect("read"), b"x");
        assert!(!dir
            .path()
            .join(".NOTES.md.agentero-rename-deadbeef.tmp")
            .exists());
    }

    #[test]
    fn default_temps_are_unique_siblings_and_remain_excluded_from_sync() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        let first = create_temp(&path, &AtomicOpts::default()).unwrap();
        let second = create_temp(&path, &AtomicOpts::default()).unwrap();
        assert_ne!(first.path(), second.path());
        for temp in [&first, &second] {
            assert_eq!(temp.path().parent(), Some(dir.path()));
            let name = temp.path().file_name().unwrap().to_str().unwrap();
            assert!(crate::features::sync::snapshot::is_ignored_name(name));
        }
    }

    #[test]
    fn a_custom_temp_collision_preserves_both_existing_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        let staging = dir.path().join("notes.pending.tmp");
        fs::write(&path, "original target").unwrap();
        fs::write(&staging, "another writer's staging data").unwrap();
        let opts = AtomicOpts {
            temp_name: Some("notes.pending.tmp".into()),
            ..Default::default()
        };
        assert_eq!(
            atomic_write_with(&path, b"new", &opts).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "original target");
        assert_eq!(
            fs::read_to_string(&staging).unwrap(),
            "another writer's staging data"
        );
    }

    #[test]
    fn failed_replacement_keeps_the_target_and_cleans_its_staging_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        // A nonempty directory rejects replacement on Unix and Windows without
        // relying on the test user's privileges or platform permission flags.
        fs::create_dir(&target).unwrap();
        fs::write(target.join("original"), "keep").unwrap();
        assert!(atomic_write(&target, b"new").is_err());
        assert_eq!(fs::read_to_string(target.join("original")).unwrap(), "keep");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn custom_temp_cannot_alias_the_target_or_escape_its_directory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        fs::write(&path, "keep").unwrap();
        for name in ["notes.md", "../outside.tmp"] {
            let opts = AtomicOpts {
                temp_name: Some(name.into()),
                ..Default::default()
            };
            assert_eq!(
                atomic_write_with(&path, b"new", &opts).unwrap_err().kind(),
                io::ErrorKind::InvalidInput
            );
            assert_eq!(fs::read_to_string(&path).unwrap(), "keep");
        }
    }

    #[test]
    fn concurrent_writes_never_publish_partial_or_mixed_contents() {
        use std::sync::Barrier;
        const WRITERS: usize = 8;
        const BYTES: usize = 64 * 1024;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("shared.bin");
        fs::write(&path, vec![0; BYTES]).unwrap();
        let barrier = Barrier::new(WRITERS + 1);
        std::thread::scope(|scope| {
            let mut writers = Vec::new();
            for writer in 1..=WRITERS {
                let (path, barrier) = (&path, &barrier);
                writers.push(scope.spawn(move || {
                    let bytes = vec![writer as u8; BYTES];
                    barrier.wait();
                    for _ in 0..20 {
                        atomic_write(path, &bytes).unwrap();
                    }
                }));
            }
            barrier.wait();
            loop {
                let bytes = fs::read(&path).unwrap();
                assert_eq!(bytes.len(), BYTES);
                assert!(bytes[0] <= WRITERS as u8);
                assert!(bytes.iter().all(|byte| *byte == bytes[0]));
                if writers.iter().all(|writer| writer.is_finished()) {
                    break;
                }
                std::thread::yield_now();
            }
            for writer in writers {
                writer.join().unwrap();
            }
        });
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn windows_locked_destination_is_never_truncated_on_replace_failure() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("locked.txt");
        fs::write(&path, "original").unwrap();
        // Allow reads/writes but deny delete-sharing, forcing MoveFileExW to
        // fail while an in-place write would have been allowed.
        let guard = fs::OpenOptions::new()
            .read(true)
            .share_mode(0x1 | 0x2)
            .open(&path)
            .unwrap();
        assert!(atomic_write(&path, b"replacement").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
        drop(guard);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn json_store_writes_pretty_json() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("state.json");
        let value = json!({"k": "v", "n": 1});

        json_store(&path, &value).expect("json store");

        let expected = serde_json::to_string_pretty(&value).expect("serialize");
        assert_eq!(fs::read_to_string(&path).expect("read"), expected);
    }

    #[cfg(unix)]
    #[test]
    fn owner_only_mode_is_applied() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("secrets.json");

        json_store_with(&path, &json!({"a": 1}), &AtomicOpts::OWNER_ONLY).expect("json store");

        let mode = fs::metadata(&path).expect("metadata").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn default_mode_matches_ordinary_file_creation() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let ordinary = dir.path().join("ordinary");
        let atomic = dir.path().join("atomic");
        fs::write(&ordinary, "normal").unwrap();
        atomic_write(&atomic, b"atomic").unwrap();
        assert_eq!(
            fs::metadata(ordinary).unwrap().permissions().mode() & 0o777,
            fs::metadata(atomic).unwrap().permissions().mode() & 0o777
        );
    }
}
