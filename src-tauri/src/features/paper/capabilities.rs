use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PaperCaps {
    pub pdf_path: Option<PathBuf>,
    pub has_tex: bool,
    pub has_paper_md: bool,
}

impl PaperCaps {
    pub fn has_pdf(&self) -> bool {
        self.pdf_path.is_some()
    }

    /// True when the paper needs a `PAPER.md` backfill: it has a local PDF to
    /// parse, no LaTeX source that would supersede liteparse, and no existing
    /// `PAPER.md`. This is the reconcile predicate for the `ParseBody` job.
    pub fn needs_paper_md(&self) -> bool {
        self.has_pdf() && !self.has_tex && !self.has_paper_md
    }

    /// True when this paper still needs an asset download: no local PDF, or
    /// the body is unknown (no catalog `body_source`) and there is neither TeX
    /// nor `PAPER.md`. Mirrors the frontend `paperAssetDownloadReasons`.
    pub fn needs_asset_download(&self, body_source: Option<&str>) -> bool {
        if !self.has_pdf() {
            return true;
        }
        let body_unknown = body_source.map(str::is_empty).unwrap_or(true);
        body_unknown && !self.has_tex && !self.has_paper_md
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CapsKey {
    vault: PathBuf,
    paper: String,
}

/// In-memory cache of per-paper derived capabilities.
///
/// `caps_for` returns the cached value when available; otherwise it walks the
/// paper directory once and stores the result. Callers that mutate the paper
/// folder must `invalidate` the entry so the next read sees fresh disk state.
#[derive(Clone, Debug)]
pub struct CapsCache {
    inner: Arc<Mutex<HashMap<CapsKey, PaperCaps>>>,
}

impl CapsCache {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Return capabilities for `paper_path` under `vault`, probing and caching
    /// on miss. If the paper path cannot be normalized, the value is computed
    /// but not cached.
    pub fn caps_for(&self, vault: &Path, paper_path: &str) -> PaperCaps {
        let vault = normalize_vault_path(vault);
        let Ok(paper) = crate::core::fs::sanitize_vault_rel(paper_path) else {
            return probe_paper_caps(&vault.join(paper_path));
        };
        let key = CapsKey {
            vault: vault.clone(),
            paper: paper.clone(),
        };
        {
            let inner = self.inner.lock().expect("caps cache lock poisoned");
            if let Some(caps) = inner.get(&key) {
                return caps.clone();
            }
        }
        let caps = probe_paper_caps(&vault.join(&paper));
        let mut inner = self.inner.lock().expect("caps cache lock poisoned");
        inner.insert(key, caps.clone());
        caps
    }

    /// Drop the cached entry for a single paper so the next `caps_for` re-probes.
    pub fn invalidate(&self, vault: &Path, paper_path: &str) {
        let vault = normalize_vault_path(vault);
        let Ok(paper) = crate::core::fs::sanitize_vault_rel(paper_path) else {
            return;
        };
        let key = CapsKey { vault, paper };
        let mut inner = self.inner.lock().expect("caps cache lock poisoned");
        inner.remove(&key);
    }

    /// Drop all cached entries, e.g. when the active vault changes.
    pub fn clear(&self) {
        let mut inner = self.inner.lock().expect("caps cache lock poisoned");
        inner.clear();
    }
}

impl Default for CapsCache {
    fn default() -> Self {
        Self::new()
    }
}

fn normalize_vault_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

pub fn probe_paper_caps(paper_dir: &Path) -> PaperCaps {
    let mut caps = PaperCaps {
        has_paper_md: has_paper_md(paper_dir),
        ..Default::default()
    };
    let mut stack = Vec::new();

    if let Ok(entries) = fs::read_dir(paper_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if is_ext(&path, &["pdf"]) && caps.pdf_path.is_none() {
                caps.pdf_path = Some(path);
            } else if is_ext(&path, &["tex", "ltx"]) {
                caps.has_tex = true;
            }
        }
    }

    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if stack.len() < 32 {
                    stack.push(path);
                }
                continue;
            }
            if caps.pdf_path.is_none() && is_ext(&path, &["pdf"]) {
                caps.pdf_path = Some(path);
            } else if is_ext(&path, &["tex", "ltx"]) {
                caps.has_tex = true;
            }
            if caps.pdf_path.is_some() && caps.has_tex {
                return caps;
            }
        }
    }

    caps
}

pub fn find_local_pdf(paper_dir: &Path) -> Option<PathBuf> {
    probe_paper_caps(paper_dir).pdf_path
}

pub fn has_local_pdf(paper_dir: &Path) -> bool {
    probe_paper_caps(paper_dir).has_pdf()
}

pub fn has_local_tex(paper_dir: &Path) -> bool {
    probe_paper_caps(paper_dir).has_tex
}

pub fn has_paper_md(paper_dir: &Path) -> bool {
    paper_dir.join("PAPER.md").is_file()
}

fn is_ext(path: &Path, exts: &[&str]) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|ext| {
            exts.iter()
                .any(|candidate| ext.eq_ignore_ascii_case(candidate))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_paper_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before unix epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "agentero-paper-caps-{}-{}-{stamp}",
            std::process::id(),
            name
        ));
        fs::create_dir_all(&dir).expect("create temp paper dir");
        dir
    }

    #[test]
    fn probe_detects_root_paper_md_only() {
        let root = temp_paper_dir("root-paper-md");
        fs::write(root.join("PAPER.md"), "body").expect("write root paper md");
        fs::create_dir_all(root.join("source")).expect("create source dir");
        fs::write(root.join("source/PAPER.md"), "nested").expect("write nested paper md");
        assert!(probe_paper_caps(&root).has_paper_md);
        fs::remove_dir_all(&root).ok();

        let nested_only = temp_paper_dir("nested-paper-md");
        fs::create_dir_all(nested_only.join("source")).expect("create nested source dir");
        fs::write(nested_only.join("source/PAPER.md"), "nested").expect("write nested paper md");
        assert!(!probe_paper_caps(&nested_only).has_paper_md);
        fs::remove_dir_all(&nested_only).ok();
    }

    #[test]
    fn probe_prefers_root_pdf_over_nested_pdf() {
        let root = temp_paper_dir("root-pdf");
        let root_pdf = root.join("root.PDF");
        fs::write(&root_pdf, b"%PDF root").expect("write root pdf");
        fs::create_dir_all(root.join("source")).expect("create source dir");
        fs::write(root.join("source/nested.pdf"), b"%PDF nested").expect("write nested pdf");
        assert_eq!(
            probe_paper_caps(&root).pdf_path.as_deref(),
            Some(root_pdf.as_path())
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn probe_finds_nested_pdf_when_no_root_pdf() {
        let root = temp_paper_dir("nested-pdf");
        fs::create_dir_all(root.join("source/deep")).expect("create deep source dir");
        let nested_pdf = root.join("source/deep/file.PdF");
        fs::write(&nested_pdf, b"%PDF nested").expect("write nested pdf");
        let caps = probe_paper_caps(&root);
        assert!(caps.has_pdf());
        assert_eq!(caps.pdf_path.as_deref(), Some(nested_pdf.as_path()));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn probe_finds_recursive_tex_and_ltx_case_insensitive() {
        let tex_root = temp_paper_dir("tex");
        fs::create_dir_all(tex_root.join("source/deep")).expect("create tex source dir");
        fs::write(tex_root.join("source/deep/main.TeX"), "tex").expect("write tex");
        assert!(probe_paper_caps(&tex_root).has_tex);
        fs::remove_dir_all(&tex_root).ok();

        let ltx_root = temp_paper_dir("ltx");
        fs::create_dir_all(ltx_root.join("source/deep")).expect("create ltx source dir");
        fs::write(ltx_root.join("source/deep/main.LTX"), "ltx").expect("write ltx");
        assert!(probe_paper_caps(&ltx_root).has_tex);
        fs::remove_dir_all(&ltx_root).ok();
    }

    #[test]
    fn needs_paper_md_only_with_pdf_no_tex_no_paper_md() {
        // PDF only → needs backfill.
        let pdf_only = temp_paper_dir("needs-paper-md");
        fs::write(pdf_only.join("paper.pdf"), b"%PDF").expect("write pdf");
        assert!(probe_paper_caps(&pdf_only).needs_paper_md());
        fs::remove_dir_all(&pdf_only).ok();

        // PDF + existing PAPER.md → already done.
        let with_md = temp_paper_dir("has-paper-md");
        fs::write(with_md.join("paper.pdf"), b"%PDF").expect("write pdf");
        fs::write(with_md.join("PAPER.md"), "body").expect("write paper md");
        assert!(!probe_paper_caps(&with_md).needs_paper_md());
        fs::remove_dir_all(&with_md).ok();

        // PDF + TeX → liteparse superseded by source.
        let with_tex = temp_paper_dir("has-tex");
        fs::write(with_tex.join("paper.pdf"), b"%PDF").expect("write pdf");
        fs::create_dir_all(with_tex.join("source")).expect("create source dir");
        fs::write(with_tex.join("source/main.tex"), "tex").expect("write tex");
        assert!(!probe_paper_caps(&with_tex).needs_paper_md());
        fs::remove_dir_all(&with_tex).ok();

        // No PDF → nothing to parse.
        let no_pdf = temp_paper_dir("no-pdf");
        fs::write(no_pdf.join("NOTES.md"), "notes").expect("write notes");
        assert!(!probe_paper_caps(&no_pdf).needs_paper_md());
        fs::remove_dir_all(&no_pdf).ok();
    }

    #[test]
    fn probe_empty_folder_reports_no_caps() {
        let root = temp_paper_dir("empty");
        let caps = probe_paper_caps(&root);
        assert!(!caps.has_pdf());
        assert!(!caps.has_tex);
        assert!(!caps.has_paper_md);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn caps_cache_returns_same_caps_on_second_call() {
        let root = temp_paper_dir("cache-hit");
        let paper = root.join("papers/test");
        fs::create_dir_all(&paper).expect("create paper dir");
        fs::write(paper.join("PAPER.md"), "body").expect("write paper md");
        let cache = CapsCache::new();
        let first = cache.caps_for(&root, "papers/test");
        let second = cache.caps_for(&root, "papers/test");
        assert_eq!(first, second);
        assert!(second.has_paper_md);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn caps_cache_reprobes_after_invalidate() {
        let root = temp_paper_dir("cache-invalidate");
        let paper = root.join("papers/test");
        fs::create_dir_all(&paper).expect("create paper dir");
        let cache = CapsCache::new();
        let before = cache.caps_for(&root, "papers/test");
        assert!(!before.has_paper_md);

        fs::write(paper.join("PAPER.md"), "body").expect("write paper md");
        cache.invalidate(&root, "papers/test");
        let after = cache.caps_for(&root, "papers/test");
        assert!(after.has_paper_md);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn caps_cache_uses_cached_pdf_path() {
        let root = temp_paper_dir("cache-pdf");
        let root = std::fs::canonicalize(&root).unwrap_or(root);
        let paper = root.join("papers/test");
        fs::create_dir_all(&paper).expect("create paper dir");
        let pdf = paper.join("paper.pdf");
        fs::write(&pdf, b"%PDF").expect("write pdf");
        let cache = CapsCache::new();
        let first = cache.caps_for(&root, "papers/test");
        assert_eq!(first.pdf_path.as_deref(), Some(pdf.as_path()));

        // Rename the PDF and remove the old file; cache should still report the old path.
        let new_pdf = paper.join("moved.pdf");
        fs::rename(&pdf, &new_pdf).expect("rename pdf");
        let cached = cache.caps_for(&root, "papers/test");
        assert_eq!(cached.pdf_path.as_deref(), Some(pdf.as_path()));

        // After invalidation the new path is discovered.
        cache.invalidate(&root, "papers/test");
        let fresh = cache.caps_for(&root, "papers/test");
        assert_eq!(fresh.pdf_path.as_deref(), Some(new_pdf.as_path()));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn needs_asset_download_matches_body_source_rules() {
        let pdf = Some(PathBuf::from("a.pdf"));
        let no_pdf = PaperCaps {
            pdf_path: None,
            has_tex: false,
            has_paper_md: false,
        };
        // No PDF always needs a download, regardless of body.
        assert!(no_pdf.needs_asset_download(Some("pdf")));
        assert!(no_pdf.needs_asset_download(None));

        let pdf_only = PaperCaps {
            pdf_path: pdf.clone(),
            has_tex: false,
            has_paper_md: false,
        };
        assert!(pdf_only.needs_asset_download(None)); // body unknown, no TeX/PAPER.md
        assert!(pdf_only.needs_asset_download(Some(""))); // empty body_source = unknown
        assert!(!pdf_only.needs_asset_download(Some("pdf"))); // body known

        let with_tex = PaperCaps {
            pdf_path: pdf.clone(),
            has_tex: true,
            has_paper_md: false,
        };
        assert!(!with_tex.needs_asset_download(None)); // TeX present

        let with_md = PaperCaps {
            pdf_path: pdf,
            has_tex: false,
            has_paper_md: true,
        };
        assert!(!with_md.needs_asset_download(None)); // PAPER.md present
    }
}
