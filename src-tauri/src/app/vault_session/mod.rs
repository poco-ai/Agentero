//! Active Vault session coordination owned by the application shell.

pub mod fs_scope;
pub mod lifecycle;

use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;

/// Which windows currently hold each vault open (canonical vault key →
/// window labels).
///
/// The Host's release sequence (cancel in-flight jobs / clear the caps cache /
/// evict the catalog connection) is vault-global, while the frontend activates
/// a vault per window. A window therefore registers a hold when its
/// `vault:opened` scope starts and drops it when the scope tears down; the
/// global release only runs when the last holder lets go. Window destruction
/// drains the dying window so a missed teardown cannot pin a vault.
///
/// Keys are pre-normalized by the `vault_hold` / `vault_release` commands via
/// [`holder_key`], so one vault spelled `D:\v` by one window and `\\?\D:\v`
/// by another collapses into the same entry. `drain_window` yields the stored
/// (already canonical) keys.
#[derive(Default)]
pub struct VaultHolders {
    inner: Mutex<HashMap<String, BTreeSet<String>>>,
}

impl VaultHolders {
    pub fn new() -> Self {
        Self::default()
    }

    /// Canonical vault paths that still have at least one holder.
    pub fn vault_keys(&self) -> Vec<String> {
        self.lock().keys().cloned().collect()
    }

    /// Registers `label` as a holder of `key` (a canonicalized vault path, see
    /// [`holder_key`]). Idempotent, so repeated activations of the same vault
    /// by one window (StrictMode remounts) are free.
    pub fn hold(&self, key: &str, label: &str) {
        if key.is_empty() || label.is_empty() {
            return;
        }
        self.lock()
            .entry(key.to_string())
            .or_default()
            .insert(label.to_string());
    }

    /// Drops `label`'s hold on `key`. Returns `true` when the caller should
    /// run the vault-global release sequence.
    ///
    /// "No entry at all" deliberately also returns `true`: a window that never
    /// registered a hold (e.g. a missed `vault_hold`, or a release whose
    /// canonicalization fallback missed the registered key) keeps today's
    /// always-release behavior — the release command must never regress into a
    /// silent no-op.
    pub fn release(&self, key: &str, label: &str) -> bool {
        let mut guard = self.lock();
        match guard.get_mut(key) {
            Some(labels) => {
                labels.remove(label);
                if labels.is_empty() {
                    guard.remove(key);
                    true
                } else {
                    false
                }
            }
            None => true,
        }
    }

    /// Drops every hold of `label` (its window is gone). Returns the vaults
    /// that lost their last holder and therefore need the global release.
    pub fn drain_window(&self, label: &str) -> Vec<String> {
        let mut guard = self.lock();
        let mut drained = Vec::new();
        guard.retain(|vault, labels| {
            labels.remove(label);
            if labels.is_empty() {
                drained.push(vault.clone());
                false
            } else {
                true
            }
        });
        drained
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, BTreeSet<String>>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Normalize a caller-provided vault path into the holder-map key by
/// canonicalizing it — the same best-effort identity used by the job dedupe
/// key and the catalog connection cache — so different spellings of one vault
/// (`D:\v` vs `\\?\D:\v`, symlinked roots, trailing separators) share one
/// entry.
///
/// `canonicalize_best_effort` performs a synchronous `fs::canonicalize`, so
/// the async commands run it on the blocking pool (same precedent as
/// `JobCenter::enqueue_core`); a blocking-join failure falls back to the
/// trimmed raw string. When the directory is already deleted the helper itself
/// falls back to the raw string too: the lookup then misses the canonical
/// entry, no removal happens, and `VaultHolders::release` still returns `true`
/// — the release sequence runs as before (single-window fallback), while the
/// stale entry is later cleaned by the window-destroyed drain.
pub(super) async fn holder_key(path: &str) -> String {
    let trimmed = path.trim().to_string();
    let for_blocking = trimmed.clone();
    tokio::task::spawn_blocking(move || {
        crate::core::fs::canonicalize_best_effort(std::path::Path::new(&for_blocking))
            .to_string_lossy()
            .to_string()
    })
    .await
    .unwrap_or(trimmed)
}

#[cfg(test)]
mod tests {
    use super::{holder_key, VaultHolders};

    #[test]
    fn release_without_hold_still_falls_back_to_global_release() {
        // Single-window compatibility: the release command must keep releasing
        // when no hold was ever registered (missed `vault_hold`).
        let holders = VaultHolders::new();
        assert!(holders.release("/vault-a", "main"));
        // The fallback leaves no entry behind.
        assert!(holders.release("/vault-a", "main"));
    }

    #[test]
    fn release_fires_only_when_the_last_holder_leaves() {
        let holders = VaultHolders::new();
        holders.hold("/vault-a", "main");
        holders.hold("/vault-a", "agentero-2");
        // Re-hold by the same window (StrictMode remount) is idempotent.
        holders.hold("/vault-a", "main");
        assert!(!holders.release("/vault-a", "main"));
        assert!(holders.release("/vault-a", "agentero-2"));
        // The emptied entry is gone; a later stray release falls back to the
        // global release path (an idempotent re-run, not a no-op).
        assert!(holders.release("/vault-a", "main"));
    }

    #[tokio::test]
    async fn holder_key_collapses_trailing_separator_spellings() {
        let dir = std::env::temp_dir().join("agentero-vault-holder-key-test");
        std::fs::create_dir_all(&dir).expect("create temp vault dir");
        let with_sep = format!("{}{}", dir.display(), std::path::MAIN_SEPARATOR);
        assert_eq!(
            holder_key(&with_sep).await,
            holder_key(&dir.to_string_lossy()).await
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn holder_key_falls_back_to_the_raw_string_for_a_missing_dir() {
        let missing = "/definitely/not/a/real/agentero-vault";
        assert_eq!(holder_key(missing).await, missing.to_string());
    }

    #[test]
    fn drain_window_returns_only_vaults_losing_their_last_holder() {
        let holders = VaultHolders::new();
        holders.hold("/vault-a", "main");
        holders.hold("/vault-a", "agentero-2");
        holders.hold("/vault-b", "agentero-2");
        assert_eq!(
            holders.drain_window("agentero-2"),
            vec!["/vault-b".to_string()]
        );
        assert!(holders.drain_window("agentero-3").is_empty());
        // `main` still holds /vault-a, so only its own release is global.
        assert!(holders.release("/vault-a", "main"));
    }

    #[test]
    fn hold_ignores_blank_inputs() {
        let holders = VaultHolders::new();
        holders.hold("", "main");
        holders.hold("/vault-a", "");
        // Neither registered anything: a release still goes through fallback.
        assert!(holders.release("/vault-a", "main"));
        assert!(holders.drain_window("main").is_empty());
    }
}
