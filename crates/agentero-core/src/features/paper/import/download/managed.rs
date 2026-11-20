//! Publish a staged download without replacing manually added or edited assets.
use super::*;
use std::collections::BTreeMap;

const MANIFEST: &str = ".agentero-downloads.json";
#[derive(serde::Serialize, serde::Deserialize)]
struct Revision {
    current: Option<String>,
    next: Option<String>,
}
impl Revision {
    fn matches(&self, digest: &str) -> bool {
        self.current.as_deref() == Some(digest) || self.next.as_deref() == Some(digest)
    }
}
type Revisions = BTreeMap<String, Revision>;

fn file_hash(path: &Path) -> Result<Option<String>, AppError> {
    match fs::File::open(path) {
        Ok(mut file) => {
            use sha2::{Digest, Sha256};
            let mut h = Sha256::new();
            let mut chunk = [0u8; 65536];
            loop {
                let n = file.read(&mut chunk)?;
                if n == 0 {
                    break;
                }
                h.update(&chunk[..n])
            }
            Ok(Some(hex::encode(h.finalize())))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
fn safe_target(dir: &Path, rel: &Path) -> Result<PathBuf, AppError> {
    let mut dest = dir.to_owned();
    for part in rel.components() {
        let std::path::Component::Normal(part) = part else {
            return Err(AppError::domain("scope_denied", "invalid asset path"));
        };
        dest.push(part);
        if dest.is_symlink() {
            return Err(AppError::domain(
                "scope_denied",
                "a managed download target is a symlink",
            ));
        }
    }
    Ok(dest)
}

fn manifest(dir: &Path) -> Result<(PathBuf, Revisions), AppError> {
    let path = safe_target(dir, Path::new(MANIFEST))?;
    let revisions: Revisions = match fs::read(&path) {
        Ok(data) => serde_json::from_slice(&data)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
        Err(e) => return Err(e.into()),
    };
    Ok((path, revisions))
}
pub(super) fn guarded(dir: &Path, asset: &Path) -> Result<(), AppError> {
    let dir = dir.canonicalize()?;
    let asset = asset.canonicalize()?;
    let rel = asset
        .strip_prefix(&dir)
        .map_err(|_| AppError::domain("scope_denied", "asset is outside the paper directory"))?;
    let (_, revisions) = manifest(&dir)?;
    let key = rel.to_string_lossy().replace('\\', "/");
    let saved = revisions.get(&key);
    let digest = file_hash(&safe_target(&dir, rel)?)?;
    if !saved
        .zip(digest.as_deref())
        .is_some_and(|(entry, hash)| entry.matches(hash))
    {
        return Err(AppError::domain(
            "revision_conflict",
            format!("{key} was supplied or edited locally and cannot be refreshed"),
        ));
    }
    Ok(())
}
pub(super) fn publish(stage: &Path, dir: &Path, pdf: bool, tex: bool) -> Result<(), AppError> {
    let (path, mut revisions) = manifest(dir)?;
    let mut changes = Vec::new();
    for entry in walkdir::WalkDir::new(stage).min_depth(1) {
        let entry = entry.map_err(|e| AppError::message(e.to_string()))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(stage)
            .expect("entry inside staging");
        let is_pdf = rel.components().count() == 1
            && rel
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"));
        let is_tex = rel.starts_with("source")
            && rel.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
                !matches!(
                    n,
                    source::STATE_FILE | ".paper-md-revision" | "layout.json" | "layout-index.json"
                )
            });
        if !(pdf && is_pdf || tex && is_tex) {
            continue;
        }
        let dst = safe_target(dir, rel)?;
        let key = rel.to_string_lossy().replace('\\', "/");
        let old = file_hash(&dst)?;
        let new =
            file_hash(entry.path())?.ok_or_else(|| AppError::message("staged asset vanished"))?;
        if old.as_ref() == Some(&new) {
            continue;
        }
        if old
            .as_deref()
            .is_some_and(|hash| !revisions.get(&key).is_some_and(|r| r.matches(hash)))
        {
            return Err(AppError::domain(
                "revision_conflict",
                format!("local edits to {key} prevent refreshing this asset"),
            ));
        }
        changes.push((key, entry.into_path(), dst, old, new));
    }
    // Validate the entire collection before writing. Each atomic replacement is
    // independently recoverable on retry: identical staged bytes need no rewrite.
    for (key, src, dst, old, new) in changes {
        if file_hash(&dst)? != old {
            return Err(AppError::domain(
                "revision_conflict",
                format!("{key} changed during refresh"),
            ));
        }
        fs::create_dir_all(dst.parent().expect("asset has a parent"))?;
        // Either digest remains recognizable after a crash between the file
        // replacement and the final receipt.
        revisions.insert(
            key.clone(),
            Revision {
                current: old,
                next: Some(new.clone()),
            },
        );
        crate::fs::atomic_write(&path, &serde_json::to_vec(&revisions)?)?;
        crate::fs::atomic_write(&dst, &fs::read(src)?)?;
        revisions.insert(
            key,
            Revision {
                current: Some(new),
                next: None,
            },
        );
        crate::fs::atomic_write(&path, &serde_json::to_vec(&revisions)?)?;
    }
    Ok(())
}
