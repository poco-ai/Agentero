//! One-shot vault file-tree listing.
//!
//! The renderer used to build the tree with one `readDir` IPC per directory
//! (serial); this walks the vault in-process and returns the whole tree in a
//! single command. Semantics mirror `src/lib/vault/tree.ts`:
//! - Eager roots (`papers/`, `notes/`, `.agents/`) recurse fully.
//! - Other vault-root trees are listed one level; subdirs stay pending.
//! - Inside a paper folder, `source/` (arXiv e-print, often hundreds of
//!   files) is a pending shell listed lazily on expand.

use crate::error::AppError;
use crate::features::catalog::CapsCache;
use crate::features::import::has_local_tex;
use serde::Serialize;
use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_DEPTH: usize = 12;

const IGNORE_NAMES: &[&str] = &[
    ".git",
    ".DS_Store",
    "node_modules",
    "target",
    "dist",
    ".agentero",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".tox",
    ".eggs",
    ".codex",
    ".idea",
    ".vscode",
    "site-packages",
];

const ALLOWED_DOT_NAMES: &[&str] = &[".env.example", ".agents"];

/// Names of the cloud-sync store's artifacts (`blobs/`, `manifests/`, `HEAD`,
/// `vault.json` — see `integration/sync/engine.rs`). When the sync target is a
/// cloud folder a desktop client (Nutstore, Nextcloud, …) mirrors back into
/// the vault, these appear as vault entries. They are engine internals, never
/// user content, so every vault consumer blinds itself to them: this tree and
/// its renderer-side mirror (`src/lib/vault/tree.ts`, both root level only —
/// a nested `notes/blobs/` folder is user content and stays visible), the
/// sync scan (`snapshot::is_ignored_name`), and the watcher
/// (`watcher::is_ignored`), the latter two at any depth because the store can
/// sit in a user-named subfolder of a mirrored target. Keep in sync with the
/// engine's `HEAD_KEY` / `VAULT_KEY` / blob and manifest prefixes.
pub const SYNC_STORE_ARTIFACT_NAMES: &[&str] = &["blobs", "manifests", "HEAD", "vault.json"];

/// A vault-root child name that belongs to a mirrored sync store.
pub fn is_sync_store_artifact(name: &str) -> bool {
    SYNC_STORE_ARTIFACT_NAMES.contains(&name)
}

/// File extensions produced by LaTeX engines (pdflatex / xelatex / lualatex /
/// latexmk / tectonic / bibtex / biber / makeindex / glossary). They pile up
/// next to the .tex source after each compile; hide them from the file tree
/// to keep the source folder readable.
const LATEX_INTERMEDIATE_EXTS: &[&str] = &[
    "aux", // aux: cross-references, labels
    "log", // log: engine log
    "out", // out: PDF outline bookmarks
    "toc",
    "lof",
    "lot", // table of contents / figures / tables
    "fls",
    "fdb_latexmk", // latexmk file list + database
    "synctex",
    "synctex.gz", // SyncTeX (gz has no real extension so check stem)
    "nav",
    "snm",
    "vrb", // beamer navigation / metadata / verbatim
    "bbl",
    "blg", // BibTeX output + log
    "idx",
    "ind",
    "ilg", // makeindex
    "glg",
    "glo",
    "gls", // glossary
    "xdv", // xelatex intermediate DVI
];

const EAGER_ROOT_NAMES: &[&str] = &["papers", "notes", ".agents"];

/// Any of these marks a directory as a paper unit whose `source/` is lazy.
const PAPER_MARKER_FILES: &[&str] = &["NOTES.md", "PAPER.md"];

/// Paper-internal directories (mirrors `src/lib/paper/paths.ts`). A folder
/// holding one of them is a paper unit, so they are never scanned for nested
/// papers.
const PAPER_MARKER_DIRS: &[&str] = &["source", "assets", "marks"];

const LAZY_PAPER_DIR: &str = "source";

/// App-owned rebuildable sidecars written inside a paper's `source/` bucket
/// (reference sidecar + PDF layout sidecars, see `docs/backend/api.md`). They
/// are never user content, so the tree blinds itself to them: a paper's
/// internals stay clean even for folders the tree does not classify as paper
/// units — papers kept outside `papers/`, copied in, or left behind by a
/// re-organization (#747).
const PAPER_SOURCE_ARTIFACT_NAMES: &[&str] = &[
    "agentero-cite.json",
    "agentero-figures.json",
    "agentero-source.json",
    "layout.json",
    "layout-index.json",
    "layout-translate.json",
];

fn is_paper_source_artifact(name: &str) -> bool {
    PAPER_SOURCE_ARTIFACT_NAMES.contains(&name)
}

/// Last segment of a vault-relative path (`""` for the vault root).
fn last_rel_segment(rel: &str) -> &str {
    rel.trim_matches('/').rsplit('/').next().unwrap_or("")
}

/// True when a vault-relative path sits at or below `papers/`.
fn is_under_papers_rel(rel: &str) -> bool {
    let r = rel.trim_matches('/');
    r == "papers" || r.starts_with("papers/")
}

/// One-level probe: `dir` holds nothing but the app's own sidecars (ignored
/// noise such as `.DS_Store` does not count as content). Early-exits on the
/// first real entry, so arXiv e-print trees stay cheap.
fn is_app_sidecar_only_dir(dir: &Path) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    let mut saw_sidecar = false;
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            return false;
        };
        if is_paper_source_artifact(name) {
            saw_sidecar = true;
            continue;
        }
        if should_ignore(name) {
            continue;
        }
        return false;
    }
    saw_sidecar
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultTreeNode {
    pub name: String,
    /// Absolute path (doubles as the renderer node id).
    pub path: String,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<VaultTreeNode>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children_pending: Option<bool>,
    /// Paper rows and lazy source shells: whether a readable TeX manuscript
    /// exists; the renderer cannot validate its dependencies from node names.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_tex: Option<bool>,
    /// Paper rows: missing fetchable arXiv source, independently of Markdown.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needs_source: Option<bool>,
}

/// Whether a vault-root child name is excluded from the tree. Public for the
/// LaTeX root scan (`features/compile/root.rs`), which walks the same vault
/// and must apply the identical exclusion set.
pub fn should_ignore(name: &str) -> bool {
    if name.is_empty() {
        return true;
    }
    if IGNORE_NAMES.contains(&name) {
        return true;
    }
    if ALLOWED_DOT_NAMES.contains(&name) {
        return false;
    }
    if name.starts_with('.') {
        return true;
    }
    if name.ends_with(".egg-info") {
        return true;
    }
    // LaTeX engine byproducts (see LATEX_INTERMEDIATE_EXTS). Compare the
    // extension case-insensitively and also handle the special `*.synctex.gz`
    // compound extension.
    let ext = Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .map(str::to_ascii_lowercase);
    if let Some(ext) = ext {
        if LATEX_INTERMEDIATE_EXTS.iter().any(|e| *e == ext) {
            return true;
        }
        // *.foo.gz — match the inner extension (e.g. `synctex` from `x.synctex.gz`).
        if ext == "gz" {
            if let Some(inner) = Path::new(name)
                .file_stem()
                .and_then(|s| Path::new(s).extension())
                .and_then(|s| s.to_str())
                .map(str::to_ascii_lowercase)
            {
                if LATEX_INTERMEDIATE_EXTS
                    .iter()
                    .any(|e| *e == inner || format!("{e}.gz") == inner)
                {
                    return true;
                }
            }
        }
    }
    false
}

fn natural_name_cmp(a: &str, b: &str) -> Ordering {
    let a = a.as_bytes();
    let b = b.as_bytes();
    let mut ai = 0;
    let mut bi = 0;

    while ai < a.len() && bi < b.len() {
        let ac = a[ai];
        let bc = b[bi];

        if ac.is_ascii_digit() && bc.is_ascii_digit() {
            let mut a_end = ai;
            while a_end < a.len() && a[a_end].is_ascii_digit() {
                a_end += 1;
            }

            let mut b_end = bi;
            while b_end < b.len() && b[b_end].is_ascii_digit() {
                b_end += 1;
            }

            let a_num = &a[ai..a_end];
            let b_num = &b[bi..b_end];
            match a_num.len().cmp(&b_num.len()).then_with(|| a_num.cmp(b_num)) {
                Ordering::Equal => {
                    ai = a_end;
                    bi = b_end;
                    continue;
                }
                cmp => return cmp,
            }
        }

        match ac.to_ascii_lowercase().cmp(&bc.to_ascii_lowercase()) {
            Ordering::Equal => {
                ai += 1;
                bi += 1;
            }
            cmp => return cmp,
        }
    }

    a.len().cmp(&b.len())
}

fn sort_nodes(nodes: &mut [VaultTreeNode]) {
    nodes.sort_by(|a, b| match (a.kind, b.kind) {
        ("directory", "file") => Ordering::Less,
        ("file", "directory") => Ordering::Greater,
        _ => natural_name_cmp(&a.name, &b.name),
    });
}

/// Whether a vault-relative dir (`""` = root) belongs to a fully-walked tree.
fn is_eager_rel(rel: &str) -> bool {
    let r = rel.trim_matches('/');
    if r.is_empty() {
        return true;
    }
    let top = r.split('/').next().unwrap_or("").to_ascii_lowercase();
    EAGER_ROOT_NAMES.contains(&top.as_str())
}

fn has_paper_marker(dir: &Path) -> bool {
    PAPER_MARKER_FILES.iter().any(|m| dir.join(m).is_file())
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    /// Recurse per-child semantics (eager roots deep, others one level).
    Eager,
    /// Files + pending directory shells only.
    OneLevel,
}

fn pending_shell(name: String, path: String) -> VaultTreeNode {
    VaultTreeNode {
        name,
        path,
        kind: "directory",
        children: Some(Vec::new()),
        children_pending: Some(true),
        has_tex: None,
        needs_source: None,
    }
}

/// TeX presence for a paper's lazy `source/` shell.
///
/// Goes through `CapsCache` keyed by the paper's vault-relative path so a full
/// tree rebuild does not re-walk every paper's `source/` (arXiv e-prints often
/// contain hundreds of files; on NTFS that walk dominates build time). The
/// watcher invalidates the paper's caps entry when capability-relevant files
/// change, so cached values stay fresh.
fn source_shell_has_tex(root: &Path, paper_rel: &str, source_dir: &Path, caps: &CapsCache) -> bool {
    if paper_rel.is_empty() {
        // Paper markers at the vault root cannot be keyed in the cache.
        return has_local_tex(source_dir);
    }
    caps.caps_for(root, paper_rel).has_tex
}

fn list_dir(
    root: &Path,
    dir: &Path,
    rel: &str,
    depth: usize,
    mode: Mode,
    caps: &CapsCache,
) -> Vec<VaultTreeNode> {
    if depth > MAX_DEPTH {
        return Vec::new();
    }
    // Best-effort: unreadable subdirs yield an empty listing, not a hard error.
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };

    let mut dirs: Vec<(String, PathBuf, String)> = Vec::new();
    let mut files: Vec<VaultTreeNode> = Vec::new();
    let mut paper_marker = false;

    for entry in entries.flatten() {
        let name = match entry.file_name().into_string() {
            Ok(name) => name,
            Err(_) => continue,
        };
        if should_ignore(&name) {
            continue;
        }
        // Sync-store artifacts only ever land at the vault root (a mirrored
        // WebDAV target); nested same-named folders are user content.
        if rel.is_empty() && is_sync_store_artifact(&name) {
            continue;
        }
        // The app's own sidecars inside a paper's `source/` bucket are never
        // user content (references + PDF layout sidecars).
        if last_rel_segment(rel) == LAZY_PAPER_DIR && is_paper_source_artifact(&name) {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        let child_path = entry.path();
        let child_rel = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        // `file_type()` does not follow symlinks, so a directory symlink is not
        // `is_dir()`. A same-vault paper alias is that symlink (or a Windows
        // junction, which already reports `is_dir`) and must show up as a folder.
        // File symlinks stay files; their targets are not walked.
        if file_type.is_dir() || crate::fs::is_linked_dir(&child_path) {
            dirs.push((name, child_path, child_rel));
        } else if file_type.is_file()
            || (file_type.is_symlink()
                && fs::metadata(&child_path)
                    .map(|metadata| metadata.is_file())
                    .unwrap_or(false))
        {
            if PAPER_MARKER_FILES.contains(&name.as_str()) {
                paper_marker = true;
            }
            files.push(VaultTreeNode {
                name,
                path: child_path.to_string_lossy().into_owned(),
                kind: "file",
                children: None,
                children_pending: None,
                has_tex: None,
                needs_source: None,
            });
        }
    }

    let mut nodes: Vec<VaultTreeNode> = Vec::with_capacity(dirs.len() + files.len());
    // A folder under `papers/` carrying a paper marker (NOTES.md / PAPER.md, or
    // a `source` / `assets` / `marks` child) is a paper unit: its `source/`
    // bucket keeps its current handling (lazy shell for papers, hidden by the
    // renderer for paper rows).
    let is_paper_unit = is_under_papers_rel(rel)
        && (paper_marker
            || dirs
                .iter()
                .any(|(name, _, _)| PAPER_MARKER_DIRS.contains(&name.as_str())));
    for (name, child_path, child_rel) in dirs {
        let path_str = child_path.to_string_lossy().into_owned();
        // Outside a paper unit the `source/` bucket exists only to hold the
        // app's rebuildable sidecars — skip it instead of surfacing an empty
        // folder (#747).
        if name == LAZY_PAPER_DIR && !is_paper_unit && is_app_sidecar_only_dir(&child_path) {
            continue;
        }
        let mut node = match mode {
            Mode::OneLevel => pending_shell(name, path_str),
            Mode::Eager => {
                if paper_marker && name == LAZY_PAPER_DIR {
                    let mut shell = pending_shell(name, path_str);
                    shell.has_tex = Some(source_shell_has_tex(root, rel, &child_path, caps));
                    shell
                } else if is_eager_rel(&child_rel) {
                    VaultTreeNode {
                        name,
                        path: path_str,
                        kind: "directory",
                        children: Some(list_dir(
                            root,
                            &child_path,
                            &child_rel,
                            depth + 1,
                            Mode::Eager,
                            caps,
                        )),
                        children_pending: None,
                        has_tex: None,
                        needs_source: None,
                    }
                } else {
                    VaultTreeNode {
                        name,
                        path: path_str,
                        kind: "directory",
                        children: Some(list_dir(
                            root,
                            &child_path,
                            &child_rel,
                            depth + 1,
                            Mode::OneLevel,
                            caps,
                        )),
                        children_pending: Some(false),
                        has_tex: None,
                        needs_source: None,
                    }
                }
            }
        };
        if node.children.as_ref().is_some_and(|children| {
            children.iter().any(|child| {
                child.kind == "file"
                    && crate::features::paper::identity::is_paper_marker_file(&child.name)
            })
        }) {
            let has_tex = caps.caps_for(root, &child_rel).has_tex;
            node.has_tex = Some(has_tex);
            if has_tex {
                node.needs_source = Some(false);
            } else if let Ok(Some(paper)) =
                crate::features::paper::catalog::papers::get_by_path(root, &child_rel)
            {
                node.needs_source = Some(
                    crate::features::paper::source::automatic_download_allowed(root)
                        && crate::features::paper::source::needs_source(
                            &child_path,
                            crate::features::paper::source::arxiv_request(&paper).as_deref(),
                        ),
                );
            }
        }
        nodes.push(node);
    }
    nodes.extend(files);
    sort_nodes(&mut nodes);
    nodes
}

/// Full tree for the vault root, in one pass.
pub fn build_tree(root: &Path, caps: &CapsCache) -> Vec<VaultTreeNode> {
    list_dir(root, root, "", 0, Mode::Eager, caps)
}

/// True when `rel` sits at or below a paper folder's lazy `source/` subtree.
fn in_paper_source(root: &Path, rel: &str) -> bool {
    let segments: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
    let mut prefix = root.to_path_buf();
    for segment in &segments {
        if *segment == LAZY_PAPER_DIR && has_paper_marker(&prefix) {
            return true;
        }
        prefix.push(segment);
    }
    false
}

/// Vault-relative path of `dir` under `root`, or an error when outside.
fn rel_under_root(root: &Path, dir: &Path) -> Result<String, AppError> {
    let strip = |base: &Path, target: &Path| -> Option<String> {
        target
            .strip_prefix(base)
            .ok()
            .map(|r| r.to_string_lossy().replace('\\', "/"))
    };
    if let Some(rel) = strip(root, dir) {
        return Ok(rel);
    }
    // Handle symlinked prefixes (e.g. /var vs /private/var on macOS).
    let root_canon = crate::fs::canonicalize_best_effort(root);
    let dir_canon = crate::fs::canonicalize_best_effort(dir);
    strip(&root_canon, &dir_canon)
        .ok_or_else(|| AppError::message("directory is outside the vault"))
}

/// Children of one directory, applying the same semantics as the full build:
/// eager subtrees recurse; non-eager dirs and paper `source/` list one level.
pub fn list_children(
    root: &Path,
    dir: &Path,
    caps: &CapsCache,
) -> Result<Vec<VaultTreeNode>, AppError> {
    let rel = rel_under_root(root, dir)?;
    if !dir.is_dir() {
        return Err(AppError::message("directory does not exist"));
    }
    let mode = if !is_eager_rel(&rel) || in_paper_source(root, &rel) {
        Mode::OneLevel
    } else {
        Mode::Eager
    };
    Ok(list_dir(root, dir, &rel, 0, mode, caps))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("agentero-tree-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn find<'a>(nodes: &'a [VaultTreeNode], name: &str) -> Option<&'a VaultTreeNode> {
        nodes.iter().find(|n| n.name == name)
    }

    #[test]
    fn eager_roots_recurse_and_paper_source_stays_pending() {
        let root = &temp_root("build");
        write(&root.join("papers/p1/NOTES.md"), "# n");
        write(
            &root.join("papers/p1/source/main.tex"),
            "\\documentclass{article}\\begin{document}Body\\end{document}",
        );
        write(&root.join("papers/p1/source/figs/a.png"), "x");
        write(&root.join("papers/p1/assets/img.png"), "x");
        write(&root.join("notes/idea.md"), "x");
        write(&root.join("src/lib/deep/file.ts"), "x");
        write(&root.join(".git/config"), "x");

        let tree = build_tree(root, &CapsCache::new());
        assert!(find(&tree, ".git").is_none());

        let papers = find(&tree, "papers").unwrap();
        let p1 = find(papers.children.as_ref().unwrap(), "p1").unwrap();
        let source = find(p1.children.as_ref().unwrap(), "source").unwrap();
        assert_eq!(source.children_pending, Some(true));
        assert!(source.children.as_ref().unwrap().is_empty());
        assert_eq!(source.has_tex, Some(true));
        let assets = find(p1.children.as_ref().unwrap(), "assets").unwrap();
        assert_ne!(assets.children_pending, Some(true));
        assert_eq!(assets.children.as_ref().unwrap().len(), 1);

        // Non-eager root: one level, nested dirs pending.
        let src = find(&tree, "src").unwrap();
        let lib = find(src.children.as_ref().unwrap(), "lib").unwrap();
        assert_eq!(lib.children_pending, Some(true));
    }

    #[test]
    fn list_children_modes() {
        let root = &temp_root("children");
        write(&root.join("papers/p1/NOTES.md"), "# n");
        write(&root.join("papers/p1/source/sub/deep.tex"), "x");
        write(
            &root.join("papers/p1/source/main.tex"),
            "\\documentclass{article}\\begin{document}Body\\end{document}",
        );
        let caps = CapsCache::new();

        // Expanding the paper's source/: one level, subdirs pending.
        let source_dir = root.join("papers/p1/source");
        let children = list_children(root, &source_dir, &caps).unwrap();
        assert!(find(&children, "main.tex").is_some());
        let sub = find(&children, "sub").unwrap();
        assert_eq!(sub.children_pending, Some(true));

        // Refreshing the paper folder recurses but keeps source/ pending.
        let paper = root.join("papers/p1");
        let children = list_children(root, &paper, &caps).unwrap();
        let source = find(&children, "source").unwrap();
        assert_eq!(source.children_pending, Some(true));
        assert_eq!(source.has_tex, Some(true));

        // Outside the vault is rejected.
        assert!(list_children(root, Path::new("/"), &caps).is_err());
    }

    #[test]
    fn directory_link_is_listed_as_a_folder() {
        let root = &temp_root("dir-link");
        write(&root.join("papers/inbox/demo/NOTES.md"), "# n");
        fs::create_dir_all(root.join("papers/archive")).unwrap();
        crate::fs::create_directory_link(
            Path::new("../inbox/demo"),
            &root.join("papers/inbox/demo"),
            &root.join("papers/archive/demo"),
        )
        .unwrap();

        let tree = build_tree(root, &CapsCache::new());
        let papers = find(&tree, "papers").unwrap();
        let archive = find(papers.children.as_ref().unwrap(), "archive").unwrap();
        let demo = find(archive.children.as_ref().unwrap(), "demo").unwrap();
        assert_eq!(demo.kind, "directory");
        assert!(find(demo.children.as_ref().unwrap(), "NOTES.md").is_some());
    }

    #[test]
    fn sync_store_artifacts_hidden_at_root_only() {
        let root = &temp_root("sync-store");
        // A sync store mirrored into the vault root by a desktop WebDAV client.
        write(&root.join("blobs/ab/hash"), "x");
        write(&root.join("manifests/0000000001-abcd.json.gz"), "x");
        write(&root.join("HEAD"), "{}");
        write(&root.join("vault.json"), "{}");
        write(&root.join("notes/idea.md"), "x");
        // Nested same-named folders are user content and must stay visible.
        write(&root.join("notes/blobs/keep.md"), "x");
        write(&root.join("notes/HEAD"), "x");

        let tree = build_tree(root, &CapsCache::new());
        let names: Vec<&str> = tree.iter().map(|n| n.name.as_str()).collect();
        for hidden in SYNC_STORE_ARTIFACT_NAMES {
            assert!(
                !names.contains(hidden),
                "{hidden} should be hidden but found in tree: {names:?}"
            );
        }
        let notes = find(&tree, "notes").unwrap();
        assert!(find(notes.children.as_ref().unwrap(), "blobs").is_some());
        assert!(find(notes.children.as_ref().unwrap(), "HEAD").is_some());

        // Root refreshes via list_children apply the same filter.
        let children = list_children(root, root, &CapsCache::new()).unwrap();
        let names: Vec<&str> = children.iter().map(|n| n.name.as_str()).collect();
        for hidden in SYNC_STORE_ARTIFACT_NAMES {
            assert!(!names.contains(hidden), "{hidden} leaked via refresh");
        }
    }

    #[test]
    fn latex_compile_byproducts_are_hidden() {
        let root = &temp_root("latex-hidden");
        // A .tex source + a PDF + the typical byproducts left behind by
        // pdflatex / latexmk / beamer / bibtex / synctex. The source folder
        // must show only the .tex and the .pdf.
        write(&root.join("notes/main.tex"), "\\documentclass{article}");
        write(&root.join("notes/main.pdf"), "%PDF-1.4");
        write(&root.join("notes/main.aux"), "x");
        write(&root.join("notes/main.log"), "x");
        write(&root.join("notes/main.out"), "x");
        write(&root.join("notes/main.toc"), "x");
        write(&root.join("notes/main.lof"), "x");
        write(&root.join("notes/main.lot"), "x");
        write(&root.join("notes/main.fls"), "x");
        write(&root.join("notes/main.fdb_latexmk"), "x");
        write(&root.join("notes/main.synctex.gz"), "x");
        write(&root.join("notes/main.nav"), "x");
        write(&root.join("notes/main.snm"), "x");
        write(&root.join("notes/main.bbl"), "x");
        write(&root.join("notes/main.blg"), "x");
        write(&root.join("notes/main.idx"), "x");
        write(&root.join("notes/main.gls"), "x");
        write(&root.join("notes/main.xdv"), "x");
        // Case insensitivity (BibTeX on Windows is happy to emit MAIN.AUX).
        write(&root.join("notes/UPPER.AUX"), "x");

        let tree = build_tree(root, &CapsCache::new());
        let notes = find(&tree, "notes").unwrap();
        let names: Vec<&str> = notes
            .children
            .as_ref()
            .unwrap()
            .iter()
            .map(|n| n.name.as_str())
            .collect();
        assert!(names.contains(&"main.tex"), "main.tex visible: {names:?}");
        assert!(names.contains(&"main.pdf"), "main.pdf visible: {names:?}");
        for hidden in [
            "main.aux",
            "main.log",
            "main.out",
            "main.toc",
            "main.lof",
            "main.lot",
            "main.fls",
            "main.fdb_latexmk",
            "main.synctex.gz",
            "main.nav",
            "main.snm",
            "main.bbl",
            "main.blg",
            "main.idx",
            "main.gls",
            "main.xdv",
            "UPPER.AUX",
        ] {
            assert!(
                !names.contains(&hidden),
                "{hidden} should be hidden but found in tree: {names:?}"
            );
        }
    }

    /// The app's own sidecars never surface, and a `source/` bucket that holds
    /// nothing but them is skipped entirely outside paper units (#747).
    #[test]
    fn app_sidecars_are_hidden_and_sidecar_only_source_dirs_are_skipped() {
        let root = &temp_root("app-sidecars");
        // A paper folder kept outside `papers/` (moved in / copied by the
        // user): the refs + layout sidecars are the only content.
        write(&root.join("loose-paper/source/agentero-cite.json"), "{}");
        write(&root.join("loose-paper/source/layout.json"), "{}");
        write(&root.join("loose-paper/source/layout-index.json"), "{}");
        // Same, but with real TeX next to the sidecars: the bucket stays and
        // only the sidecars are filtered out of its listing.
        write(
            &root.join("with-tex/source/main.tex"),
            "\\documentclass{article}\\begin{document}Body\\end{document}",
        );
        write(&root.join("with-tex/source/agentero-cite.json"), "{}");
        write(&root.join("with-tex/source/layout.json"), "{}");
        // A paper unit under papers/ without NOTES.md: `source/` is its only
        // marker, so it must survive for the renderer's paper detection.
        write(&root.join("papers/p1/p1.pdf"), "%PDF-1.4");
        write(&root.join("papers/p1/source/agentero-cite.json"), "{}");

        let tree = build_tree(root, &CapsCache::new());

        let loose = find(&tree, "loose-paper").unwrap();
        let loose_children: Vec<&str> = loose
            .children
            .as_ref()
            .unwrap()
            .iter()
            .map(|n| n.name.as_str())
            .collect();
        assert!(
            !loose_children.contains(&"source"),
            "sidecar-only source/ should be skipped: {loose_children:?}"
        );

        let with_tex = find(&tree, "with-tex").unwrap();
        let source = find(with_tex.children.as_ref().unwrap(), "source").unwrap();
        let source_children = list_children(root, &root.join("with-tex/source"), &CapsCache::new())
            .expect("list source");
        let source_names: Vec<&str> = source_children.iter().map(|n| n.name.as_str()).collect();
        assert!(
            source_names.contains(&"main.tex"),
            "real content stays visible: {source_names:?}"
        );
        for hidden in ["agentero-cite.json", "layout.json", "layout-index.json"] {
            assert!(
                !source_names.contains(&hidden),
                "{hidden} should be hidden but found: {source_names:?}"
            );
        }
        assert!(source.children.as_ref().is_none_or(|c| c.is_empty()));

        let papers = find(&tree, "papers").unwrap();
        let p1 = find(papers.children.as_ref().unwrap(), "p1").unwrap();
        assert!(
            find(p1.children.as_ref().unwrap(), "source").is_some(),
            "a paper unit keeps its source/ marker"
        );
    }

    #[test]
    fn source_shell_without_tex_reports_has_tex_false() {
        let root = &temp_root("notex");
        write(&root.join("papers/p1/NOTES.md"), "# n");
        write(&root.join("papers/p1/source/figs/a.png"), "x");

        let tree = build_tree(root, &CapsCache::new());
        let papers = find(&tree, "papers").unwrap();
        let p1 = find(papers.children.as_ref().unwrap(), "p1").unwrap();
        let source = find(p1.children.as_ref().unwrap(), "source").unwrap();
        assert_eq!(source.has_tex, Some(false));
    }

    #[test]
    fn source_probe_uses_caps_cache_until_invalidated() {
        let root = &temp_root("caps-fresh");
        write(&root.join("papers/p1/NOTES.md"), "# n");
        write(&root.join("papers/p1/source/notes.txt"), "x");
        let caps = CapsCache::new();

        let source_has_tex = |tree: &[VaultTreeNode]| {
            let papers = find(tree, "papers").unwrap();
            let p1 = find(papers.children.as_ref().unwrap(), "p1").unwrap();
            find(p1.children.as_ref().unwrap(), "source")
                .unwrap()
                .has_tex
        };

        assert_eq!(source_has_tex(&build_tree(root, &caps)), Some(false));

        // TeX appears; the cached probe is stale until the watcher invalidates.
        write(
            &root.join("papers/p1/source/main.tex"),
            "\\documentclass{article}\\begin{document}Body\\end{document}",
        );
        assert_eq!(source_has_tex(&build_tree(root, &caps)), Some(false));

        // Watcher-style invalidation of the paper folder refreshes the probe.
        caps.invalidate(root, "papers/p1");
        assert_eq!(source_has_tex(&build_tree(root, &caps)), Some(true));
    }

    #[cfg(unix)]
    #[test]
    fn valid_symlinked_pdf_is_listed_as_a_file() {
        use std::os::unix::fs::symlink;

        let root = &temp_root("symlink-pdf");
        let paper = root.join("papers/p1");
        write(&paper.join("NOTES.md"), "# n");
        write(
            &paper.join("source/main.tex"),
            "\\documentclass{article}\\begin{document}Body\\end{document}",
        );
        let target = root.join("outside.pdf");
        write(&target, "pdf");
        symlink(&target, paper.join("p1.pdf")).unwrap();

        let tree = build_tree(root, &CapsCache::new());
        let papers = find(&tree, "papers").unwrap();
        let p1 = find(papers.children.as_ref().unwrap(), "p1").unwrap();
        assert!(find(p1.children.as_ref().unwrap(), "p1.pdf").is_some());
    }

    /// Quantifies the caps-cache win: 20 papers with 200 files each under
    /// `source/`. The first build walks every source/ tree (cold); the second
    /// hits the cache and must not re-walk. Prints both durations
    /// (`cargo test ... -- --nocapture` to see the numbers).
    #[test]
    fn build_tree_second_pass_hits_caps_cache() {
        let root = &temp_root("caps-perf");
        for p in 0..20 {
            let paper = root.join(format!("papers/p{p:02}"));
            write(&paper.join("NOTES.md"), "# n");
            let src = paper.join("source");
            fs::create_dir_all(src.join("figs")).unwrap();
            for f in 0..199 {
                fs::write(src.join(format!("figs/f{f:03}.png")), "x").unwrap();
            }
            fs::write(
                src.join("main.tex"),
                "\\documentclass{article}\\begin{document}Body\\end{document}",
            )
            .unwrap();
        }
        let caps = CapsCache::new();

        let cold_start = std::time::Instant::now();
        let cold_tree = build_tree(root, &caps);
        let cold = cold_start.elapsed();

        let warm_start = std::time::Instant::now();
        let warm_tree = build_tree(root, &caps);
        let warm = warm_start.elapsed();

        eprintln!(
            "build_tree 20 papers x 200 source files: cold={cold:?} warm={warm:?} ({:.1}x)",
            cold.as_secs_f64() / warm.as_secs_f64().max(f64::EPSILON)
        );

        let check = |tree: &[VaultTreeNode]| {
            let papers = find(tree, "papers").unwrap();
            for p in 0..20 {
                let paper = find(papers.children.as_ref().unwrap(), &format!("p{p:02}")).unwrap();
                let source = find(paper.children.as_ref().unwrap(), "source").unwrap();
                assert_eq!(source.has_tex, Some(true));
                assert_eq!(source.children_pending, Some(true));
            }
        };
        check(&cold_tree);
        check(&warm_tree);
        // The warm build only does directory listings + cache lookups; it must
        // beat the cold build that walked 20 x 200 source files.
        assert!(
            warm < cold,
            "warm build ({warm:?}) should be faster than cold build ({cold:?})"
        );
    }

    #[test]
    fn sorts_names_naturally_with_directories_first() {
        let root = &temp_root("sort");
        write(&root.join("papers/10-topic/NOTES.md"), "# n");
        write(&root.join("papers/9-topic/NOTES.md"), "# n");
        write(&root.join("10-note.md"), "x");
        write(&root.join("9-note.md"), "x");

        let tree = build_tree(root, &CapsCache::new());
        let names: Vec<&str> = tree.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, vec!["papers", "9-note.md", "10-note.md"]);

        let papers = find(&tree, "papers").unwrap();
        let paper_names: Vec<&str> = papers
            .children
            .as_ref()
            .unwrap()
            .iter()
            .map(|n| n.name.as_str())
            .collect();
        assert_eq!(paper_names, vec!["9-topic", "10-topic"]);
    }
}
