//! Cross-process pass lock.
//!
//! The desktop Host, the CLI (and cron jobs driving it) can all reach the
//! same vault on one machine. The remote CAS keeps the *store* consistent,
//! but two passes interleaving local writes would race `.agentero/sync/`
//! state files and vault content. An advisory OS lock (flock / LockFileEx)
//! serializes passes. The guard unlocks explicitly before closing its handle;
//! abnormal exits release the lock when the last related handle is closed.

use std::fs::{self, File};
use std::io;
use std::path::Path;

/// RAII guard: dropping it (or the process exiting) releases the lock.
#[must_use = "keep the guard alive for the entire sync pass"]
pub struct SyncLock {
    _file: File,
}

impl Drop for SyncLock {
    fn drop(&mut self) {
        // Duplicated handles (including Unix fork/dup) can keep the lock alive.
        // Unlock explicitly instead of waiting for the last handle to close.
        let _ = fs2::FileExt::unlock(&self._file);
    }
}

impl SyncLock {
    /// Try to claim this vault's sync pass. `Ok(None)` when another process
    /// is mid-pass; other IO failures propagate.
    pub fn try_acquire(vault: &Path) -> io::Result<Option<SyncLock>> {
        let dir = vault.join(".agentero").join("sync");
        fs::create_dir_all(&dir)?;
        let file = File::create(dir.join("lock"))?;
        // Use fs2's platform error: Windows ERROR_LOCK_VIOLATION need not map
        // to ErrorKind::WouldBlock in std's decode tables.
        match fs2::FileExt::try_lock_exclusive(&file) {
            Ok(()) => Ok(Some(SyncLock { _file: file })),
            Err(e) if e.raw_os_error() == fs2::lock_contended_error().raw_os_error() => Ok(None),
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drop_releases_even_when_a_duplicate_descriptor_is_alive() {
        let vault = tempfile::tempdir().unwrap();
        let first = SyncLock::try_acquire(vault.path()).unwrap().unwrap();
        // Keep a duplicate alive to deterministically model a shared lock
        // lifetime, including a concurrently forked child on Unix.
        let inherited = first._file.try_clone().unwrap();
        assert!(SyncLock::try_acquire(vault.path()).unwrap().is_none());

        drop(first);
        let next = SyncLock::try_acquire(vault.path()).unwrap();
        assert!(next.is_some());

        // Closing the old descriptor must not release the new owner's lock.
        drop(inherited);
        assert!(SyncLock::try_acquire(vault.path()).unwrap().is_none());
        drop(next);
        assert!(SyncLock::try_acquire(vault.path()).unwrap().is_some());
    }

    #[test]
    fn second_acquire_on_the_same_vault_is_rejected_and_drop_releases() {
        let vault =
            std::env::temp_dir().join(format!("agentero-sync-lock-{}", uuid::Uuid::new_v4()));
        let first = SyncLock::try_acquire(&vault).unwrap();
        assert!(first.is_some());
        // A second claim (as another process would) reports busy, not error.
        assert!(SyncLock::try_acquire(&vault).unwrap().is_none());
        drop(first);
        // Releasing the guard frees the lock for the next pass.
        assert!(SyncLock::try_acquire(&vault).unwrap().is_some());
        let _ = fs::remove_dir_all(vault);
    }
}
