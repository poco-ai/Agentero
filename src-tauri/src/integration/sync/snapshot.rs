//! Vault scanning → manifest (relative path → content hash + stat).

use crate::core::error::AppError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;
use std::time::UNIX_EPOCH;

/// Immutable remote snapshot: `files` keys are `/`-separated vault-relative paths.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub version: u64,
    #[serde(default)]
    pub files: BTreeMap<String, FileEntry>,
    /// Categories the publishing device had filtered out of `files`. A path
    /// absent here while matching this scope is "not synced", not "deleted".
    /// Old manifests deserialize to the all-synced default.
    #[serde(default, skip_serializing_if = "SyncScope::is_all")]
    pub scope: SyncScope,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    /// Lowercase hex sha256 of the raw file content (blob key).
    pub hash: String,
    pub size: u64,
    pub mtime_ms: i64,
}

/// Directories never entered and files never synced.
/// Must stay a superset of the watcher's ignore rules so sync state and
/// catalog SQLite never travel through the blob store.
pub(crate) fn is_ignored_name(name: &str) -> bool {
    matches!(name, ".agentero" | ".git" | "node_modules" | ".DS_Store") || name.ends_with(".tmp")
}

/// Which bulky, re-derivable paper assets participate in sync. Notes,
/// sidecars, marks and embedded images always sync — they are small and not
/// recoverable from any upstream source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncScope {
    /// Paper-root PDFs: `papers/<id>/<id>.pdf`.
    pub pdf: bool,
    /// LaTeX / e-print trees: `papers/<id>/source/`.
    pub source: bool,
    /// Supplementary material: `papers/<id>/attachments/`.
    pub attachments: bool,
}

impl Default for SyncScope {
    /// Missing scope fields (legacy configs / old remote manifests) mean
    /// "sync everything".
    fn default() -> Self {
        Self::all()
    }
}

impl SyncScope {
    pub fn all() -> Self {
        Self {
            pdf: true,
            source: true,
            attachments: true,
        }
    }

    pub fn is_all(&self) -> bool {
        self.pdf && self.source && self.attachments
    }
}

/// Bulky-asset category of a vault-relative path, or `None` for always-synced
/// content. Only the conventional paper layout is classified; PDFs nested in
/// `source/` or `attachments/` follow their enclosing category.
pub fn scope_category(rel: &str) -> Option<&'static str> {
    let rest = rel.strip_prefix("papers/")?;
    let (_, tail) = rest.split_once('/')?;
    if tail == "source" || tail.starts_with("source/") {
        return Some("source");
    }
    if tail == "attachments" || tail.starts_with("attachments/") {
        return Some("attachments");
    }
    if !tail.contains('/') && tail.to_ascii_lowercase().ends_with(".pdf") {
        return Some("pdf");
    }
    None
}

pub fn is_scope_excluded(scope: &SyncScope, rel: &str) -> bool {
    match scope_category(rel) {
        Some("pdf") => !scope.pdf,
        Some("source") => !scope.source,
        Some("attachments") => !scope.attachments,
        _ => false,
    }
}

/// Drop excluded paths from a manifest map. The same predicate blinds the
/// local scan, the base, and the remote manifest, so a filtered file is
/// neither uploaded nor downloaded — and never mistaken for a deletion.
pub fn filter_files(
    files: BTreeMap<String, FileEntry>,
    scope: &SyncScope,
) -> BTreeMap<String, FileEntry> {
    if scope.is_all() {
        return files;
    }
    files
        .into_iter()
        .filter(|(rel, _)| !is_scope_excluded(scope, rel))
        .collect()
}

/// Scan the vault into manifest entries. Files whose `size + mtime` match the
/// base entry reuse its hash instead of re-reading (cheap steady-state scans).
pub fn scan_vault(
    vault: &Path,
    base: &Manifest,
    scope: &SyncScope,
) -> Result<BTreeMap<String, FileEntry>, AppError> {
    let mut out = BTreeMap::new();
    let walker = walkdir::WalkDir::new(vault)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !is_ignored_name(&e.file_name().to_string_lossy()));
    for entry in walker {
        let entry = entry.map_err(|e| AppError::message(format!("scan vault: {e}")))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let Some(rel) = entry
            .path()
            .strip_prefix(vault)
            .ok()
            .and_then(|p| p.to_str())
            .map(|s| s.replace('\\', "/"))
        else {
            continue; // non-UTF-8 names cannot ride a JSON manifest
        };
        if is_scope_excluded(scope, &rel) {
            continue;
        }
        let meta = entry
            .metadata()
            .map_err(|e| AppError::message(e.to_string()))?;
        let size = meta.len();
        let mtime_ms = mtime_millis(&meta);
        if let Some(prev) = base.files.get(&rel) {
            if prev.size == size && prev.mtime_ms == mtime_ms {
                out.insert(rel, prev.clone());
                continue;
            }
        }
        let hash = hash_file(entry.path())?;
        out.insert(
            rel,
            FileEntry {
                hash,
                size,
                mtime_ms,
            },
        );
    }
    Ok(out)
}

pub fn mtime_millis(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn hash_file(path: &Path) -> Result<String, AppError> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

pub fn hash_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use uuid::Uuid;

    #[test]
    fn scan_skips_internal_dirs_and_reuses_base_hashes() {
        let vault = std::env::temp_dir().join(format!("agentero-scan-{}", Uuid::new_v4()));
        fs::create_dir_all(vault.join(".agentero/sync")).unwrap();
        fs::create_dir_all(vault.join("papers/x")).unwrap();
        fs::write(vault.join(".agentero/catalog.sqlite"), b"db").unwrap();
        fs::write(vault.join(".agentero/sync/base.json"), b"{}").unwrap();
        fs::write(vault.join("papers/x/NOTES.md"), b"# x\n").unwrap();
        fs::write(vault.join("papers/x/.DS_Store"), b"junk").unwrap();

        let files = scan_vault(&vault, &Manifest::default(), &SyncScope::all()).unwrap();
        assert_eq!(files.keys().collect::<Vec<_>>(), vec!["papers/x/NOTES.md"]);

        // Unchanged size+mtime → hash reused from base without re-reading.
        let mut base = Manifest::default();
        let mut entry = files["papers/x/NOTES.md"].clone();
        entry.hash = "sentinel".into();
        base.files.insert("papers/x/NOTES.md".into(), entry);
        let again = scan_vault(&vault, &base, &SyncScope::all()).unwrap();
        assert_eq!(again["papers/x/NOTES.md"].hash, "sentinel");

        let _ = fs::remove_dir_all(&vault);
    }

    #[test]
    fn scan_skips_scope_excluded_files() {
        let vault = std::env::temp_dir().join(format!("agentero-scan-{}", Uuid::new_v4()));
        fs::create_dir_all(vault.join("papers/x/source")).unwrap();
        fs::create_dir_all(vault.join("papers/x/attachments")).unwrap();
        fs::write(vault.join("papers/x/NOTES.md"), b"# x\n").unwrap();
        fs::write(vault.join("papers/x/x.pdf"), b"%PDF").unwrap();
        fs::write(vault.join("papers/x/source/main.tex"), b"tex").unwrap();
        fs::write(vault.join("papers/x/attachments/supp.pdf"), b"%PDF").unwrap();
        fs::write(vault.join("loose.pdf"), b"%PDF").unwrap(); // outside papers/

        let scope = SyncScope {
            pdf: false,
            source: false,
            attachments: true,
        };
        let files = scan_vault(&vault, &Manifest::default(), &scope).unwrap();
        let keys: Vec<&String> = files.keys().collect();
        assert_eq!(
            keys,
            vec![
                "loose.pdf",
                "papers/x/NOTES.md",
                "papers/x/attachments/supp.pdf"
            ]
        );

        let _ = fs::remove_dir_all(&vault);
    }

    #[test]
    fn scope_category_classifies_paper_layout() {
        assert_eq!(scope_category("papers/x/x.pdf"), Some("pdf"));
        assert_eq!(scope_category("papers/x/X.PDF"), Some("pdf"));
        assert_eq!(scope_category("papers/x/source/main.tex"), Some("source"));
        assert_eq!(scope_category("papers/x/source"), Some("source"));
        assert_eq!(
            scope_category("papers/x/attachments/supp.pdf"),
            Some("attachments")
        );
        // PDFs nested in a category dir follow the enclosing category.
        assert_eq!(scope_category("papers/x/source/fig.pdf"), Some("source"));
        // Always-synced content and non-paper paths.
        assert_eq!(scope_category("papers/x/NOTES.md"), None);
        assert_eq!(scope_category("papers/x/metadata.json"), None);
        assert_eq!(scope_category("papers/x/marks/a.json"), None);
        assert_eq!(scope_category("papers/x/assets/img.png"), None);
        assert_eq!(scope_category("papers/x/attachments"), Some("attachments"));
        assert_eq!(scope_category("loose.pdf"), None);
        assert_eq!(scope_category("notes/todo.md"), None);
    }

    #[test]
    fn manifest_scope_roundtrip_and_legacy_default() {
        // All-synced scope is omitted on the wire.
        let full = Manifest::default();
        let json = serde_json::to_string(&full).unwrap();
        assert!(!json.contains("scope"));

        // Filtered scope travels with the manifest.
        let partial = Manifest {
            version: 1,
            files: BTreeMap::new(),
            scope: SyncScope {
                pdf: false,
                source: true,
                attachments: true,
            },
        };
        let back: Manifest =
            serde_json::from_str(&serde_json::to_string(&partial).unwrap()).unwrap();
        assert!(!back.scope.pdf);
        assert!(back.scope.source && back.scope.attachments);

        // Legacy manifests (no scope field) mean "everything synced".
        let legacy: Manifest = serde_json::from_str(r#"{"version":1,"files":{}}"#).unwrap();
        assert!(legacy.scope.is_all());
    }
}
