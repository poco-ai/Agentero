//! Vault scanning → manifest (relative path → content hash + stat).

use super::scope::{self, Category};
use crate::error::AppError;
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
    /// In remote manifests, categories whose omissions may come from legacy
    /// filtering. In the local base, the scope used to sync this device.
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
///
/// Mirrored sync-store artifacts (`blobs/`, `manifests/`, `HEAD`,
/// `vault.json`) are matched at any depth, unlike the file tree's root-only
/// rule: the store can sit in a user-named subfolder of a mirrored target,
/// and scanning it would feed the engine's own output back into the blob
/// store — a loop that bloats the remote every pass. The cost: a nested user
/// path that happens to share one of these names (e.g. `notes/blobs/`)
/// silently stops syncing — edits stay local, nothing propagates or deletes.
pub fn is_ignored_name(name: &str) -> bool {
    matches!(name, ".agentero" | ".git" | "node_modules" | ".DS_Store")
        || name.ends_with(".tmp")
        || crate::features::vault::tree::is_sync_store_artifact(name)
}

/// Which bulky, re-derivable paper assets participate in sync. Notes,
/// sidecars, marks and embedded images always sync — they are small and not
/// recoverable from any upstream source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
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

/// Local disk usage per bulky-asset category (bytes), for the sync-scope UI.
#[derive(Debug, Default, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncScopeSizes {
    pub pdf: u64,
    pub source: u64,
    pub attachments: u64,
}

pub fn scope_sizes(vault: &Path) -> SyncScopeSizes {
    let files: Vec<_> = vault_files(&vault.join("papers"), "papers/")
        .flatten()
        .collect();
    let roots = scope::paper_roots(files.iter().map(|(rel, _)| rel.as_str()));
    let mut sizes = SyncScopeSizes::default();
    for (rel, file) in &files {
        if let Some((category, _)) = scope::classify(rel, &roots) {
            let size = file.metadata().map_or(0, |meta| meta.len());
            match category {
                Category::Pdf => sizes.pdf += size,
                Category::Source => sizes.source += size,
                Category::Attachments => sizes.attachments += size,
            }
        }
    }
    sizes
}

fn vault_files<'a>(
    root: &'a Path,
    prefix: &'a str,
) -> impl Iterator<Item = Result<(String, walkdir::DirEntry), walkdir::Error>> + 'a {
    walkdir::WalkDir::new(root)
        .follow_links(false)
        .follow_root_links(false)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !is_ignored_name(&e.file_name().to_string_lossy()))
        .filter_map(move |entry| match entry {
            Ok(entry) if entry.depth() > 0 && entry.file_type().is_file() => {
                let rel = entry.path().strip_prefix(root).ok()?.to_str()?;
                Some(Ok((format!("{prefix}{}", rel.replace('\\', "/")), entry)))
            }
            Ok(_) => None,
            Err(error) => Some(Err(error)),
        })
}

/// Scan the vault into manifest entries. Files whose `size + mtime` match the
/// base entry reuse its hash instead of re-reading (cheap steady-state scans).
pub fn scan_vault(
    vault: &Path,
    base: &Manifest,
    scope: &SyncScope,
) -> Result<BTreeMap<String, FileEntry>, AppError> {
    let mut out = BTreeMap::new();
    let files = vault_files(vault, "")
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::message(format!("scan vault: {e}")))?;
    let roots = if scope.pdf {
        Default::default()
    } else {
        scope::paper_roots(files.iter().map(|(rel, _)| rel.as_str()))
    };
    for (rel, entry) in files {
        if scope::excluded(scope, &rel, &roots) {
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
    fn scan_skips_mirrored_sync_store_artifacts() {
        let vault = std::env::temp_dir().join(format!("agentero-scan-{}", Uuid::new_v4()));
        fs::create_dir_all(vault.join("papers/x")).unwrap();
        fs::create_dir_all(vault.join("store/blobs/ab")).unwrap();
        fs::write(vault.join("papers/x/NOTES.md"), b"# x\n").unwrap();
        // A store mirrored at the vault root...
        fs::create_dir_all(vault.join("blobs/ab")).unwrap();
        fs::write(vault.join("blobs/ab/hash"), b"blob").unwrap();
        fs::write(vault.join("HEAD"), b"{}").unwrap();
        fs::write(vault.join("vault.json"), b"{}").unwrap();
        // ...and one in a user-named subfolder of a mirrored target.
        fs::write(vault.join("store/blobs/ab/hash"), b"blob").unwrap();
        fs::write(vault.join("store/HEAD"), b"{}").unwrap();

        let files = scan_vault(&vault, &Manifest::default(), &SyncScope::all()).unwrap();
        assert_eq!(files.keys().collect::<Vec<_>>(), vec!["papers/x/NOTES.md"]);

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
        let roots = scope::paper_roots(["papers/collection/topic/x/metadata.json"]);
        for (rel, expected) in [
            ("papers/x/legacy.pdf", Some(Category::Pdf)),
            ("papers/collection/topic/y/Y.PDF", Some(Category::Pdf)),
            (
                "papers/collection/topic/x/download.pdf",
                Some(Category::Pdf),
            ),
            ("papers/collection/topic/x/source", Some(Category::Source)),
            (
                "papers/collection/topic/x/source/attachments/fig.pdf",
                Some(Category::Source),
            ),
            (
                "papers/collection/topic/x/attachments/source/fig.pdf",
                Some(Category::Attachments),
            ),
            ("papers/collection/topic/x/NOTES.md", None),
            ("papers/collection/topic/x/metadata.json", None),
            ("papers/collection/topic/x/marks/a.json", None),
            ("papers/collection/topic/x/assets/source/fig.pdf", None),
            ("papers/collection/topic/handout.pdf", None),
            ("loose.pdf", None),
        ] {
            assert_eq!(
                scope::classify(rel, &roots).map(|(category, _)| category),
                expected,
                "{rel}"
            );
        }
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
