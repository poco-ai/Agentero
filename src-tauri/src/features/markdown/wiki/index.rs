//! In-memory wikilink graph index (rebuildable from Vault Markdown).

use crate::features::wiki::cache::{
    discard_snapshot, fingerprint_files, load_snapshot, store_snapshot, wiki_cache_path,
    WikiCacheLoad, WikiCacheSnapshot, WikiFileFingerprint, WikiSnapshotWrite,
};
use crate::features::wiki::embed::project_markdown;
use crate::features::wiki::extract::extract_document;
use crate::features::wiki::models::{
    BacklinksResponse, InternalLinkOccurrence, InternalLinkSyntax, LinkFragment,
    OutgoingLinksResponse, RebuildResult, ResolvedLink, WikiCheckCounts, WikiCheckIssue,
    WikiCheckResult, WikiDocument, WikiEmbedContentKind, WikiEmbedResponse, WikiLinkEdge,
    WikiResolveResponse, WikiSearchCandidate, WikiSearchCandidateKind,
};
use crate::features::wiki::resolve::{
    normalize_rel, resolve_occurrence, resolve_occurrence_with, DocumentLookup,
};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const IGNORE_NAMES: &[&str] = &[
    ".git",
    ".DS_Store",
    "node_modules",
    "target",
    "dist",
    ".agentero",
];

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let e = e.to_ascii_lowercase();
            e == "md" || e == "mdx" || e == "markdown"
        })
        .unwrap_or(false)
}

/// `PAPER.md` is derived full text. Keep it in the document index so links can
/// target its headings, but do not treat links extracted from it as authored
/// Vault knowledge.
fn is_derived_paper_body(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("PAPER.md"))
}

fn is_wiki_source(path: &Path) -> bool {
    is_markdown(path) && !is_derived_paper_body(path)
}

fn is_pdf(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
}

fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "avif" | "ico"
            )
        })
}

fn is_wiki_target(path: &Path) -> bool {
    is_markdown(path) || is_pdf(path) || is_image(path)
}

fn without_markdown_extension(path: &str) -> String {
    let lower = path.to_ascii_lowercase();
    for extension in [".markdown", ".mdx", ".md"] {
        if lower.ends_with(extension) {
            return path[..path.len() - extension.len()].to_string();
        }
    }
    path.to_string()
}

fn document_stem(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(path)
        .to_string()
}

fn document_link_name(path: &str) -> String {
    if is_markdown(Path::new(path)) {
        return document_stem(path);
    }
    Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(path)
        .to_string()
}

#[derive(Debug)]
struct HeadingSearch {
    parent_suffix: Vec<String>,
    leaf_query: String,
    has_path_separator: bool,
    valid: bool,
}

fn parse_heading_search(value: &str) -> HeadingSearch {
    let parts = value
        .split(['#', '›'])
        .map(|part| part.trim().to_lowercase())
        .collect::<Vec<_>>();
    let has_path_separator = parts.len() > 1;
    let leaf_query = parts.last().cloned().unwrap_or_default();
    let parent_suffix = parts
        .get(..parts.len().saturating_sub(1))
        .unwrap_or_default()
        .to_vec();
    let valid = parent_suffix.iter().all(|part| !part.is_empty());
    HeadingSearch {
        parent_suffix,
        leaf_query,
        has_path_separator,
        valid,
    }
}

fn heading_matches_search(path: &[String], search: &HeadingSearch) -> bool {
    if !search.valid {
        return false;
    }
    if !search.has_path_separator {
        return search.leaf_query.is_empty()
            || path
                .iter()
                .map(|part| part.to_lowercase())
                .collect::<Vec<_>>()
                .join(" › ")
                .contains(&search.leaf_query);
    }
    let Some((leaf, parents)) = path.split_last() else {
        return false;
    };
    crate::features::wiki::resolve::heading_path_ends_with(parents, &search.parent_suffix)
        && leaf.to_lowercase().contains(&search.leaf_query)
}

fn should_skip_name(name: &str) -> bool {
    if IGNORE_NAMES.contains(&name) {
        return true;
    }
    // Hidden files/dirs except we still skip all dotfiles for index scan
    name.starts_with('.')
}

/// Collect vault-relative Markdown, image, and PDF targets (forward slashes).
pub fn collect_wiki_target_files(vault_root: &Path) -> std::io::Result<Vec<String>> {
    let mut out = Vec::new();
    walk_wiki_targets(vault_root, vault_root, 0, &mut out)?;
    out.sort();
    Ok(out)
}

fn walk_wiki_targets(
    vault_root: &Path,
    dir: &Path,
    depth: usize,
    out: &mut Vec<String>,
) -> std::io::Result<()> {
    if depth > 24 {
        return Ok(());
    }
    let entries = fs::read_dir(dir)?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if should_skip_name(&name) {
            continue;
        }
        let path = entry.path();
        let ft = entry.file_type()?;
        if ft.is_dir() {
            walk_wiki_targets(vault_root, &path, depth + 1, out)?;
        } else if ft.is_file() && is_wiki_target(&path) {
            if let Ok(rel) = path.strip_prefix(vault_root) {
                out.push(normalize_rel(&rel.to_string_lossy()));
            }
        }
    }
    Ok(())
}

fn to_vault_rel(vault_root: &Path, path: &str) -> String {
    let p = PathBuf::from(path);
    if let Ok(rel) = p.strip_prefix(vault_root) {
        return normalize_rel(&rel.to_string_lossy());
    }
    normalize_rel(path)
}

#[derive(Debug, Default)]
pub struct WikiIndex {
    /// Absolute vault root last indexed.
    pub vault_path: Option<String>,
    /// All outgoing edges.
    pub edges: Vec<WikiLinkEdge>,
    /// target_path → incoming occurrences
    reverse: HashMap<String, Vec<ResolvedLink>>,
    /// Indexed markdown relative paths.
    files: Vec<String>,
    /// File metadata and anchors, rebuilt entirely from Markdown source.
    documents: Vec<WikiDocument>,
    /// Stat fingerprints of the last successful build. A later rebuild reuses
    /// the in-memory snapshot for every unchanged file instead of re-reading
    /// the on-disk cache. Empty when the index was built without fingerprints
    /// (tests, read-only diagnostics), which disables in-memory reuse.
    fingerprints: Vec<WikiFileFingerprint>,
    /// Whether the on-disk cache rows match the in-memory snapshot, so the
    /// next persist may write only changed rows.
    cache_synced: bool,
    /// Result of the last install, returned verbatim by the fingerprint-equal
    /// fast path.
    last_result: Option<RebuildResult>,
}

/// Reusable parse products from the previous build (in-memory or on-disk).
/// Only files whose stat fingerprint is unchanged are actually reused.
struct PreviousIndexState {
    fingerprints: Vec<WikiFileFingerprint>,
    documents: Vec<WikiDocument>,
    occurrences_by_source: HashMap<String, Vec<InternalLinkOccurrence>>,
    /// True when the on-disk cache already holds this exact state, so the
    /// persist step may rewrite only the changed rows.
    incremental_store: bool,
}

impl PreviousIndexState {
    fn from_snapshot(snapshot: WikiCacheSnapshot) -> Self {
        let mut occurrences_by_source: HashMap<String, Vec<InternalLinkOccurrence>> =
            HashMap::new();
        for occurrence in snapshot.occurrences {
            occurrences_by_source
                .entry(occurrence.source.clone())
                .or_default()
                .push(occurrence);
        }
        Self {
            fingerprints: snapshot.fingerprints,
            documents: snapshot.documents,
            occurrences_by_source,
            incremental_store: true,
        }
    }
}

impl WikiIndex {
    #[cfg_attr(not(feature = "desktop"), allow(dead_code))]
    pub(crate) fn document(&self, path: &str) -> Option<&WikiDocument> {
        self.documents.iter().find(|document| document.path == path)
    }

    /// Indexed Markdown metadata used by read-only diagnostics.
    pub fn documents(&self) -> &[WikiDocument] {
        &self.documents
    }

    pub fn rebuild(&mut self, vault_path: &str) -> Result<RebuildResult, String> {
        let root = crate::core::fs::resolve_vault(vault_path).map_err(|e| e.to_string())?;

        let files = collect_wiki_target_files(&root).map_err(|e| e.to_string())?;
        if cfg!(test) {
            return self.rebuild_from(vault_path, &root, files, Vec::new(), None, None);
        }
        let cache_path = wiki_cache_path(&root);
        self.rebuild_with_cache_path(vault_path, &root, files, &cache_path, true)
    }

    pub fn rebuild_fresh(&mut self, vault_path: &str) -> Result<RebuildResult, String> {
        let root = PathBuf::from(vault_path);
        let cache_path = wiki_cache_path(&root);
        self.rebuild_fresh_with_cache_path(vault_path, &cache_path)
    }

    /// Build a complete in-memory snapshot without reading or writing the
    /// derived on-disk cache. Read-only diagnostics use this path.
    pub fn rebuild_read_only(&mut self, vault_path: &str) -> Result<RebuildResult, String> {
        let root = crate::core::fs::resolve_vault(vault_path).map_err(|e| e.to_string())?;
        let files = collect_wiki_target_files(&root).map_err(|error| error.to_string())?;
        self.rebuild_from(vault_path, &root, files, Vec::new(), None, None)
    }

    fn rebuild_fresh_with_cache_path(
        &mut self,
        vault_path: &str,
        cache_path: &Path,
    ) -> Result<RebuildResult, String> {
        let root = crate::core::fs::resolve_vault(vault_path).map_err(|e| e.to_string())?;
        let files = collect_wiki_target_files(&root).map_err(|error| error.to_string())?;
        if let Err(error) = discard_snapshot(cache_path) {
            log::warn!(target: "agentero::wiki", "{error}");
        }
        self.rebuild_with_cache_path(vault_path, &root, files, cache_path, false)
    }

    fn rebuild_with_cache_path(
        &mut self,
        vault_path: &str,
        root: &Path,
        files: Vec<String>,
        cache_path: &Path,
        restore: bool,
    ) -> Result<RebuildResult, String> {
        let fingerprints = match fingerprint_files(root, &files) {
            Ok(fingerprints) => fingerprints,
            Err(error) => {
                log::warn!(
                    target: "agentero::wiki",
                    "Wiki cache fingerprint validation unavailable: {error}"
                );
                return self.rebuild_from(vault_path, root, files, Vec::new(), None, None);
            }
        };
        // In-memory reuse: when this index already describes the same vault,
        // the previous build is the freshest possible snapshot — no need to
        // re-read and re-decode the on-disk cache on every watcher rebuild.
        if restore
            && self.vault_path.as_deref() == Some(vault_path)
            && !self.fingerprints.is_empty()
        {
            if self.fingerprints == fingerprints {
                if let Some(result) = self.last_result.clone() {
                    return Ok(result);
                }
            } else {
                let previous = self.take_previous();
                return self.rebuild_from(
                    vault_path,
                    root,
                    files,
                    fingerprints,
                    Some(previous),
                    Some(cache_path),
                );
            }
        }
        let previous = if restore {
            match load_snapshot(cache_path, root) {
                WikiCacheLoad::Hit(snapshot) => {
                    if snapshot.fingerprints == fingerprints {
                        let WikiCacheSnapshot {
                            fingerprints,
                            documents,
                            occurrences,
                        } = snapshot;
                        // The cache stores parse products only; resolution is
                        // always recomputed against the full document set so a
                        // restored index cannot carry stale link statuses.
                        let edges = {
                            let lookup = DocumentLookup::new(&documents);
                            occurrences
                                .into_iter()
                                .map(|occurrence| resolve_occurrence_with(occurrence, &lookup))
                                .collect()
                        };
                        let result = self.install_snapshot(
                            vault_path,
                            files,
                            documents,
                            edges,
                            fingerprints,
                        );
                        self.cache_synced = true;
                        return Ok(result);
                    }
                    Some(PreviousIndexState::from_snapshot(snapshot))
                }
                WikiCacheLoad::Miss => None,
                WikiCacheLoad::Stale => {
                    if let Err(discard_error) = discard_snapshot(cache_path) {
                        log::warn!(target: "agentero::wiki", "{discard_error}");
                    }
                    None
                }
                WikiCacheLoad::Invalid(error) => {
                    log::warn!(
                        target: "agentero::wiki",
                        "discarding invalid Wiki cache {}: {error}",
                        cache_path.display()
                    );
                    if let Err(discard_error) = discard_snapshot(cache_path) {
                        log::warn!(target: "agentero::wiki", "{discard_error}");
                    }
                    None
                }
            }
        } else {
            None
        };
        self.rebuild_from(
            vault_path,
            root,
            files,
            fingerprints,
            previous,
            Some(cache_path),
        )
    }

    /// Move the current build out of this index as a reusable previous state.
    fn take_previous(&mut self) -> PreviousIndexState {
        let mut occurrences_by_source: HashMap<String, Vec<InternalLinkOccurrence>> =
            HashMap::new();
        for edge in std::mem::take(&mut self.edges) {
            occurrences_by_source
                .entry(edge.occurrence.source.clone())
                .or_default()
                .push(edge.occurrence);
        }
        PreviousIndexState {
            fingerprints: std::mem::take(&mut self.fingerprints),
            documents: std::mem::take(&mut self.documents),
            occurrences_by_source,
            incremental_store: self.cache_synced,
        }
    }

    /// Rebuild the index, reusing parsed documents and occurrences from the
    /// previous state for every file whose stat fingerprint is unchanged. Only
    /// changed or new Markdown files are read from disk; link resolution always
    /// runs against the complete document set. The persist step rewrites only
    /// changed rows when the on-disk cache already matches the previous state.
    fn rebuild_from(
        &mut self,
        vault_path: &str,
        root: &Path,
        files: Vec<String>,
        fingerprints: Vec<WikiFileFingerprint>,
        previous: Option<PreviousIndexState>,
        cache_path: Option<&Path>,
    ) -> Result<RebuildResult, String> {
        let current: HashMap<&str, &WikiFileFingerprint> = fingerprints
            .iter()
            .map(|fingerprint| (fingerprint.relative_path.as_str(), fingerprint))
            .collect();
        let mut prev_documents = HashMap::new();
        let mut prev_occurrences: HashMap<String, Vec<InternalLinkOccurrence>> = HashMap::new();
        let mut previous_paths: Vec<String> = Vec::new();
        let mut incremental_store = false;
        if let Some(previous) = previous {
            incremental_store = previous.incremental_store;
            let unchanged: HashSet<String> = previous
                .fingerprints
                .iter()
                .filter(|stored| {
                    current.get(stored.relative_path.as_str()).copied() == Some(*stored)
                })
                .map(|stored| stored.relative_path.clone())
                .collect();
            previous_paths = previous
                .fingerprints
                .into_iter()
                .map(|stored| stored.relative_path)
                .collect();
            for document in previous.documents {
                if unchanged.contains(&document.path) {
                    prev_documents.insert(document.path.clone(), document);
                }
            }
            for (source, occurrences) in previous.occurrences_by_source {
                if unchanged.contains(&source) {
                    prev_occurrences.insert(source, occurrences);
                }
            }
        }

        let mut documents = Vec::new();
        let mut occurrences = Vec::new();
        let mut changed: BTreeSet<String> = BTreeSet::new();
        let mut failed_reads: HashSet<String> = HashSet::new();
        for rel in &files {
            if let Some(document) = prev_documents.remove(rel) {
                documents.push(document);
                if is_wiki_source(Path::new(rel)) {
                    occurrences.extend(prev_occurrences.remove(rel).unwrap_or_default());
                }
                continue;
            }
            changed.insert(rel.clone());
            if !is_markdown(Path::new(rel)) {
                documents.push(WikiDocument {
                    path: rel.clone(),
                    aliases: Vec::new(),
                    headings: Vec::new(),
                    blocks: Vec::new(),
                });
                continue;
            }
            let bytes = match fs::read(root.join(rel)) {
                Ok(bytes) => bytes,
                Err(_) => {
                    failed_reads.insert(rel.clone());
                    continue;
                }
            };
            let Ok(content) = String::from_utf8(bytes) else {
                continue;
            };
            let (document, parsed) = extract_document(rel, &content);
            documents.push(document);
            if is_wiki_source(Path::new(rel)) {
                occurrences.extend(parsed);
            }
        }

        let file_set: HashSet<&str> = files.iter().map(String::as_str).collect();
        let removed: BTreeSet<String> = previous_paths
            .into_iter()
            .filter(|path| !file_set.contains(path.as_str()))
            .collect();

        let edges: Vec<ResolvedLink> = {
            let lookup = DocumentLookup::new(&documents);
            occurrences
                .into_iter()
                .map(|occurrence| resolve_occurrence_with(occurrence, &lookup))
                .collect()
        };

        // A failed read leaves that file unindexed; drop its fingerprint so the
        // next rebuild retries it, and skip persisting the partial snapshot.
        let cacheable = cache_path.is_some() && failed_reads.is_empty();
        let kept_fingerprints = if failed_reads.is_empty() {
            fingerprints
        } else {
            fingerprints
                .into_iter()
                .filter(|fingerprint| !failed_reads.contains(&fingerprint.relative_path))
                .collect()
        };

        let result = self.install_snapshot(vault_path, files, documents, edges, kept_fingerprints);
        self.cache_synced = false;
        if cacheable {
            if let Some(cache_path) = cache_path {
                let write = if incremental_store {
                    WikiSnapshotWrite::Incremental { changed, removed }
                } else {
                    WikiSnapshotWrite::Full
                };
                match store_snapshot(
                    cache_path,
                    root,
                    &self.fingerprints,
                    &self.documents,
                    &self.edges,
                    &write,
                ) {
                    Ok(()) => self.cache_synced = true,
                    Err(error) => {
                        log::warn!(
                            target: "agentero::wiki",
                            "could not persist Wiki cache {}: {error}",
                            cache_path.display()
                        );
                    }
                }
            }
        }
        Ok(result)
    }

    fn install_snapshot(
        &mut self,
        vault_path: &str,
        files: Vec<String>,
        documents: Vec<WikiDocument>,
        edges: Vec<ResolvedLink>,
        fingerprints: Vec<WikiFileFingerprint>,
    ) -> RebuildResult {
        let mut reverse: HashMap<String, Vec<ResolvedLink>> = HashMap::new();
        let mut nodes = files.iter().cloned().collect::<HashSet<_>>();
        for edge in &edges {
            if let Some(target_path) = &edge.target_path {
                nodes.insert(target_path.clone());
                reverse
                    .entry(target_path.clone())
                    .or_default()
                    .push(edge.clone());
            } else {
                nodes.insert(format!("stub:{}", edge.occurrence.target_raw));
            }
        }
        for list in reverse.values_mut() {
            list.sort_by(|left, right| left.occurrence.source.cmp(&right.occurrence.source));
        }
        let result = RebuildResult {
            indexed_files: files.len() as u32,
            edges: edges.len() as u32,
            nodes: nodes.len() as u32,
        };

        self.vault_path = Some(vault_path.to_string());
        self.edges = edges;
        self.reverse = reverse;
        self.files = files;
        self.documents = documents;
        self.fingerprints = fingerprints;
        self.last_result = Some(result.clone());

        result
    }

    pub fn ensure_vault(&mut self, vault_path: &str) -> Result<(), String> {
        if self.vault_path.as_deref() != Some(vault_path) {
            self.rebuild(vault_path)?;
        }
        Ok(())
    }

    pub fn get_backlinks(&self, vault_root: &str, path: &str) -> BacklinksResponse {
        let root = Path::new(vault_root);
        let rel = to_vault_rel(root, path);
        // Also try with/without .md for lookup
        let mut keys = vec![rel.clone()];
        if !rel.ends_with(".md") && !rel.ends_with(".mdx") && !rel.ends_with(".markdown") {
            keys.push(format!("{rel}.md"));
        }
        // Match any reverse key equal ignore case
        let mut backlinks = Vec::new();
        for (k, list) in &self.reverse {
            if keys.iter().any(|q| q == k || q.eq_ignore_ascii_case(k)) {
                backlinks.extend(list.iter().cloned());
            }
        }
        // Preserve every occurrence: different fragments on one line are distinct.
        backlinks.sort_by(|a, b| {
            a.occurrence
                .source
                .cmp(&b.occurrence.source)
                .then(a.occurrence.line.cmp(&b.occurrence.line))
                .then(
                    a.occurrence
                        .source_range
                        .start
                        .cmp(&b.occurrence.source_range.start),
                )
        });

        BacklinksResponse {
            path: rel,
            backlinks,
        }
    }

    pub fn get_outgoing(&self, vault_root: &str, path: &str) -> OutgoingLinksResponse {
        let rel = to_vault_rel(Path::new(vault_root), path);
        let outgoing = self
            .edges
            .iter()
            .filter(|edge| edge.occurrence.source == rel)
            .cloned()
            .collect();
        OutgoingLinksResponse {
            path: rel,
            outgoing,
        }
    }

    /// Validate all explicit links authored by one Markdown file, a directory,
    /// or the complete Vault. Resolution always reuses the same canonical Wiki
    /// index consumed by navigation, embeds, backlinks, and rename repair.
    pub fn check_links(&self, vault_root: &str, scope: Option<&str>) -> WikiCheckResult {
        let root = Path::new(vault_root);
        let normalized_scope = scope.map(|value| to_vault_rel(root, value));
        let scope_is_dir = normalized_scope
            .as_deref()
            .is_some_and(|value| root.join(value).is_dir());
        let source_matches = |source: &str| match normalized_scope.as_deref() {
            None => true,
            Some(value) if scope_is_dir => {
                source == value || source.starts_with(&format!("{value}/"))
            }
            Some(value) => source == value,
        };

        let checked_files = self
            .documents
            .iter()
            .filter(|document| {
                is_wiki_source(Path::new(&document.path)) && source_matches(&document.path)
            })
            .count() as u32;
        let mut counts = WikiCheckCounts::default();
        let mut issues = Vec::new();

        for link in self
            .edges
            .iter()
            .filter(|link| source_matches(&link.occurrence.source))
        {
            use crate::features::wiki::models::LinkResolutionStatus;

            match link.status {
                LinkResolutionStatus::Resolved => counts.resolved += 1,
                LinkResolutionStatus::Missing => counts.missing += 1,
                LinkResolutionStatus::Ambiguous => counts.ambiguous += 1,
                LinkResolutionStatus::InvalidFragment => counts.invalid_fragment += 1,
            }
            if link.status == LinkResolutionStatus::Resolved {
                continue;
            }
            issues.push(WikiCheckIssue {
                status: link.status.clone(),
                source: link.occurrence.source.clone(),
                line: link.occurrence.line,
                target_raw: link.occurrence.target_raw.clone(),
                syntax: link.occurrence.syntax.clone(),
                embed: link.occurrence.embed,
                target_path: link.target_path.clone(),
                candidates: link.candidates.clone(),
                context: link.occurrence.context.clone(),
            });
        }
        issues.sort_by(|left, right| {
            left.source
                .cmp(&right.source)
                .then(left.line.cmp(&right.line))
                .then(left.target_raw.cmp(&right.target_raw))
        });

        WikiCheckResult {
            scope: normalized_scope,
            checked_files,
            counts,
            issues,
        }
    }

    pub fn resolve_text(
        &self,
        vault_root: &str,
        source_path: &str,
        text: &str,
        syntax: InternalLinkSyntax,
    ) -> WikiResolveResponse {
        let source = to_vault_rel(Path::new(vault_root), source_path);
        let input = match syntax {
            InternalLinkSyntax::Wikilink if text.trim_start().starts_with("[[") => text.to_string(),
            InternalLinkSyntax::Wikilink => format!("[[{}]]", text.trim()),
            InternalLinkSyntax::Markdown => format!("[link]({})", text.trim()),
        };
        let (_, mut occurrences) = extract_document(&source, &input);
        let occurrence = occurrences.pop().unwrap_or_else(|| {
            crate::features::wiki::models::InternalLinkOccurrence {
                source,
                target_raw: text.trim().to_string(),
                syntax,
                embed: false,
                display_text: None,
                fragment: None,
                source_range: crate::features::wiki::models::SourceRange {
                    start: 0,
                    end: text.len(),
                },
                fragment_range: None,
                line: 1,
                context: None,
            }
        });
        WikiResolveResponse {
            link: resolve_occurrence(occurrence, &self.documents),
        }
    }

    pub fn read_embed(
        &self,
        vault_root: &str,
        source_path: &str,
        text: &str,
    ) -> Result<WikiEmbedResponse, String> {
        let mut link = self
            .resolve_text(vault_root, source_path, text, InternalLinkSyntax::Wikilink)
            .link;
        link.occurrence.embed = true;

        if !matches!(
            link.status,
            crate::features::wiki::models::LinkResolutionStatus::Resolved
        ) {
            return Ok(WikiEmbedResponse {
                link,
                content_kind: None,
                content: None,
            });
        }

        let Some(target_path) = link.target_path.as_deref() else {
            return Ok(WikiEmbedResponse {
                link,
                content_kind: None,
                content: None,
            });
        };

        // Annotation embeds: Host only confirms the fragment kind; frontend loads
        // quote/preview from marks/annotations.json or marks/<id>.json.
        if matches!(
            link.occurrence.fragment,
            Some(LinkFragment::Annotation { .. })
        ) {
            return Ok(WikiEmbedResponse {
                link,
                content_kind: Some(WikiEmbedContentKind::Annotation),
                content: None,
            });
        }

        let target = Path::new(vault_root).join(target_path);
        if is_image(&target) {
            return Ok(WikiEmbedResponse {
                link,
                content_kind: Some(WikiEmbedContentKind::Image),
                content: None,
            });
        }
        if is_pdf(&target) {
            return Ok(WikiEmbedResponse {
                link,
                content_kind: Some(WikiEmbedContentKind::Pdf),
                content: None,
            });
        }
        if !is_markdown(&target) {
            return Ok(WikiEmbedResponse {
                link,
                content_kind: Some(WikiEmbedContentKind::Unsupported),
                content: None,
            });
        }
        let markdown = fs::read_to_string(&target)
            .map_err(|error| format!("read embedded Markdown {target_path}: {error}"))?;
        let (document, _) = extract_document(target_path, &markdown);
        let content = project_markdown(&markdown, &document, link.occurrence.fragment.as_ref());
        if content.is_none() {
            link.status = crate::features::wiki::models::LinkResolutionStatus::InvalidFragment;
        }

        Ok(WikiEmbedResponse {
            link,
            content_kind: content.as_ref().map(|_| WikiEmbedContentKind::Markdown),
            content,
        })
    }

    pub fn search(&self, query: &str) -> Vec<WikiSearchCandidate> {
        self.search_scoped(query, None, None)
    }

    pub fn search_scoped(
        &self,
        query: &str,
        path: Option<&str>,
        kind: Option<&WikiSearchCandidateKind>,
    ) -> Vec<WikiSearchCandidate> {
        let query_key = query.trim().to_lowercase();
        let heading_search = parse_heading_search(query);
        let stem_counts =
            self.documents
                .iter()
                .fold(HashMap::<String, usize>::new(), |mut counts, document| {
                    *counts
                        .entry(document_link_name(&document.path).to_lowercase())
                        .or_default() += 1;
                    counts
                });
        let mut candidates = Vec::new();
        for document in &self.documents {
            if path.is_some_and(|path| !document.path.eq_ignore_ascii_case(path)) {
                continue;
            }
            let file_name = document_link_name(&document.path);
            let target = if stem_counts
                .get(&file_name.to_lowercase())
                .copied()
                .unwrap_or_default()
                > 1
            {
                if is_markdown(Path::new(&document.path)) {
                    without_markdown_extension(&document.path)
                } else {
                    document.path.clone()
                }
            } else {
                file_name.clone()
            };
            // Path/basename hits and frontmatter-alias hits are separate rows.
            // Matching an alias must NOT also emit the basename row (that pair is
            // confusing when the user typed a title / short name).
            let path_match =
                query_key.is_empty() || document.path.to_lowercase().contains(&query_key);
            let include_file = kind.is_none_or(|kind| *kind == WikiSearchCandidateKind::File);
            let include_heading = kind.is_none_or(|kind| *kind == WikiSearchCandidateKind::Heading);
            let include_block = kind.is_none_or(|kind| *kind == WikiSearchCandidateKind::Block);
            if include_file && path_match {
                candidates.push(WikiSearchCandidate {
                    kind: WikiSearchCandidateKind::File,
                    path: document.path.clone(),
                    insert_text: target.clone(),
                    label: file_name.clone(),
                    detail: None,
                    alias: None,
                    fragment: None,
                });
            }
            // Alias rows only when the query actually matches an alias (not on
            // empty/recent file lists — those already list each file once).
            if include_file && !query_key.is_empty() {
                for alias in &document.aliases {
                    if alias.to_lowercase().contains(&query_key) {
                        candidates.push(WikiSearchCandidate {
                            kind: WikiSearchCandidateKind::File,
                            path: document.path.clone(),
                            insert_text: target.clone(),
                            label: alias.clone(),
                            detail: None,
                            alias: Some(alias.clone()),
                            fragment: None,
                        });
                    }
                }
            }
            if include_heading {
                for heading in &document.headings {
                    let label = heading.path.join(" › ");
                    if heading_matches_search(&heading.path, &heading_search) {
                        candidates.push(WikiSearchCandidate {
                            kind: WikiSearchCandidateKind::Heading,
                            path: document.path.clone(),
                            insert_text: format!("{}#{}", target, heading.path.join("#")),
                            label,
                            detail: Some(format!("H{}", heading.level)),
                            alias: None,
                            fragment: Some(LinkFragment::Heading {
                                path: heading.path.clone(),
                            }),
                        });
                    }
                }
            }
            if include_block {
                for block in &document.blocks {
                    if query_key.is_empty() || block.id.to_lowercase().contains(&query_key) {
                        candidates.push(WikiSearchCandidate {
                            kind: WikiSearchCandidateKind::Block,
                            path: document.path.clone(),
                            insert_text: format!("{}#^{}", target, block.id),
                            label: format!("^{}", block.id),
                            detail: (!block.preview.is_empty()).then(|| block.preview.clone()),
                            alias: None,
                            fragment: Some(LinkFragment::Block {
                                id: block.id.clone(),
                            }),
                        });
                    }
                }
            }
        }
        candidates.sort_by(|left, right| {
            left.path
                .cmp(&right.path)
                .then(left.label.cmp(&right.label))
        });
        candidates.truncate(100);
        candidates
    }
}

/// Thread-safe index managed by Tauri.
///
/// The index sits behind an `Arc` so async commands can clone the handle and
/// move it into `spawn_blocking` closures (lock + heavy work off the main
/// thread). The global-Mutex semantics are unchanged.
pub struct WikiIndexState {
    pub inner: Arc<Mutex<WikiIndex>>,
}

impl WikiIndexState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(WikiIndex::default())),
        }
    }

    /// Cloneable handle for moving into blocking closures.
    pub fn handle(&self) -> Arc<Mutex<WikiIndex>> {
        Arc::clone(&self.inner)
    }
}

impl Default for WikiIndexState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::wiki::models::{BlockAnchor, HeadingAnchor, LinkResolutionStatus};
    use uuid::Uuid;

    fn test_vault() -> PathBuf {
        let root = std::env::temp_dir().join(format!("agentero-wiki-embed-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("notes")).expect("create embed fixture vault");
        root
    }

    #[test]
    fn checks_links_with_shared_resolution_and_source_scope() {
        let root = test_vault();
        fs::create_dir_all(root.join("notes/a")).expect("create first topic dir");
        fs::create_dir_all(root.join("notes/b")).expect("create second topic dir");
        fs::write(root.join("notes/Target.md"), "# Existing\n").expect("write target");
        fs::write(root.join("notes/a/Topic.md"), "# A\n").expect("write first topic");
        fs::write(root.join("notes/b/Topic.md"), "# B\n").expect("write second topic");
        fs::write(
            root.join("notes/Source.md"),
            "[[Target]]\n[[Missing]]\n[[Topic]]\n[[Target#Gone]]\n",
        )
        .expect("write source");
        fs::write(root.join("notes/Clean.md"), "[[Target]]\n").expect("write clean source");

        let vault = root.to_string_lossy().to_string();
        let mut index = WikiIndex::default();
        index.rebuild(&vault).expect("rebuild");

        let source = index.check_links(&vault, Some("notes/Source.md"));
        assert_eq!(source.checked_files, 1);
        assert_eq!(source.counts.resolved, 1);
        assert_eq!(source.counts.missing, 1);
        assert_eq!(source.counts.ambiguous, 1);
        assert_eq!(source.counts.invalid_fragment, 1);
        assert_eq!(source.issues.len(), 3);
        assert_eq!(source.issues[0].source, "notes/Source.md");
        assert_eq!(source.issues[0].line, 2);

        let clean = index.check_links(&vault, Some("notes/Clean.md"));
        assert_eq!(clean.checked_files, 1);
        assert_eq!(clean.counts.resolved, 1);
        assert!(clean.issues.is_empty());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn keeps_paper_body_as_a_target_without_indexing_its_outgoing_links() {
        let root = test_vault();
        fs::create_dir_all(root.join("papers/demo")).expect("create paper dir");
        fs::write(
            root.join("papers/demo/PAPER.md"),
            "# Paper\n## Method\n[web](chat.openai.com) [[MissingFromPaper]]\n",
        )
        .expect("write derived paper body");
        fs::write(
            root.join("notes/Source.md"),
            "[[papers/demo/PAPER#Paper#Method]]\n[missing](Missing.md)\n",
        )
        .expect("write authored source");

        let vault = root.to_string_lossy().to_string();
        let mut index = WikiIndex::default();
        index.rebuild(&vault).expect("rebuild");

        let paper = index.get_outgoing(&vault, "papers/demo/PAPER.md");
        assert!(paper.outgoing.is_empty());
        let source = index.get_outgoing(&vault, "notes/Source.md");
        assert_eq!(source.outgoing.len(), 2);
        assert_eq!(source.outgoing[0].status, LinkResolutionStatus::Resolved);
        assert_eq!(
            source.outgoing[0].target_path.as_deref(),
            Some("papers/demo/PAPER.md")
        );

        let report = index.check_links(&vault, None);
        assert_eq!(report.checked_files, 1);
        assert_eq!(report.counts.resolved, 1);
        assert_eq!(report.counts.missing, 1);
        assert_eq!(report.issues.len(), 1);
        assert_eq!(report.issues[0].source, "notes/Source.md");

        let paper_report = index.check_links(&vault, Some("papers/demo/PAPER.md"));
        assert_eq!(paper_report.checked_files, 0);
        assert!(paper_report.issues.is_empty());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reads_resolved_heading_and_block_embed_projections() {
        let root = test_vault();
        fs::write(
            root.join("notes/Target.md"),
            "# Root\nintro\n## Child\nchild\nBlock text ^focus\n## Sibling\nend\n",
        )
        .expect("write target");
        fs::write(root.join("notes/Source.md"), "![[Target#Child]]").expect("write source");

        let mut index = WikiIndex::default();
        index
            .rebuild(root.to_str().expect("utf-8 fixture path"))
            .expect("rebuild index");
        let heading = index
            .read_embed(
                root.to_str().expect("utf-8 fixture path"),
                "notes/Source.md",
                "Target#Child",
            )
            .expect("read heading embed");
        assert_eq!(
            heading.content.as_deref(),
            Some("## Child\nchild\nBlock text ^focus\n")
        );
        assert!(heading.link.occurrence.embed);

        let block = index
            .read_embed(
                root.to_str().expect("utf-8 fixture path"),
                "notes/Source.md",
                "Target#^focus",
            )
            .expect("read block embed");
        assert_eq!(block.content.as_deref(), Some("Block text ^focus\n"));

        fs::remove_dir_all(root).expect("remove fixture vault");
    }

    #[test]
    fn resolves_current_file_heading_and_block_through_the_command_path() {
        let root = test_vault();
        fs::write(
            root.join("notes/Current.md"),
            "# Overview\nCurrent block ^summary\n",
        )
        .expect("write current note");

        let vault = root.to_str().expect("utf-8 fixture path");
        let mut index = WikiIndex::default();
        index.rebuild(vault).expect("rebuild index");

        let current_file = index
            .resolve_text(vault, "notes/Current.md", "", InternalLinkSyntax::Wikilink)
            .link;
        assert_eq!(current_file.status, LinkResolutionStatus::Resolved);
        assert_eq!(
            current_file.target_path.as_deref(),
            Some("notes/Current.md")
        );

        for link_text in ["#Overview", "#^summary"] {
            let link = index
                .resolve_text(
                    vault,
                    "notes/Current.md",
                    link_text,
                    InternalLinkSyntax::Wikilink,
                )
                .link;
            assert_eq!(link.status, LinkResolutionStatus::Resolved, "{link_text}");
            assert_eq!(
                link.target_path.as_deref(),
                Some("notes/Current.md"),
                "{link_text}"
            );
            assert!(link.occurrence.target_raw.is_empty(), "{link_text}");
        }

        fs::remove_dir_all(root).expect("remove fixture vault");
    }

    #[test]
    fn resolves_and_projects_image_and_pdf_targets() {
        let root = test_vault();
        fs::create_dir_all(root.join("assets")).expect("create attachment directory");
        fs::write(root.join("assets/figure.png"), b"png fixture").expect("write image fixture");
        fs::write(root.join("assets/paper.pdf"), b"pdf fixture").expect("write pdf fixture");
        fs::write(
            root.join("notes/Source.md"),
            "[[figure.png]]\n[[paper.pdf]]\n![[figure.png]]\n![[paper.pdf]]\n",
        )
        .expect("write attachment links");

        let vault = root.to_str().expect("utf-8 fixture path");
        let mut index = WikiIndex::default();
        index.rebuild(vault).expect("rebuild attachment index");

        let image = index
            .resolve_text(
                vault,
                "notes/Source.md",
                "figure.png",
                InternalLinkSyntax::Wikilink,
            )
            .link;
        assert_eq!(image.status, LinkResolutionStatus::Resolved);
        assert_eq!(image.target_path.as_deref(), Some("assets/figure.png"));

        let pdf = index
            .resolve_text(
                vault,
                "notes/Source.md",
                "paper.pdf",
                InternalLinkSyntax::Wikilink,
            )
            .link;
        assert_eq!(pdf.status, LinkResolutionStatus::Resolved);
        assert_eq!(pdf.target_path.as_deref(), Some("assets/paper.pdf"));

        let image_embed = index
            .read_embed(vault, "notes/Source.md", "figure.png")
            .expect("read image embed");
        assert_eq!(image_embed.content_kind, Some(WikiEmbedContentKind::Image));
        assert_eq!(image_embed.content, None);

        let pdf_embed = index
            .read_embed(vault, "notes/Source.md", "paper.pdf")
            .expect("read pdf embed");
        assert_eq!(pdf_embed.content_kind, Some(WikiEmbedContentKind::Pdf));
        assert_eq!(pdf_embed.content, None);

        let file_targets = index
            .search("")
            .into_iter()
            .filter(|candidate| candidate.kind == WikiSearchCandidateKind::File)
            .map(|candidate| candidate.insert_text)
            .collect::<Vec<_>>();
        assert!(file_targets.contains(&"figure.png".to_string()));
        assert!(file_targets.contains(&"paper.pdf".to_string()));

        fs::remove_dir_all(root).expect("remove fixture vault");
    }

    #[test]
    fn duplicate_attachment_names_require_vault_relative_targets() {
        let root = test_vault();
        fs::create_dir_all(root.join("assets/first")).expect("create first asset directory");
        fs::create_dir_all(root.join("assets/second")).expect("create second asset directory");
        fs::write(root.join("assets/first/figure.png"), b"first image").expect("write first image");
        fs::write(root.join("assets/second/figure.png"), b"second image")
            .expect("write second image");

        let vault = root.to_str().expect("utf-8 fixture path");
        let mut index = WikiIndex::default();
        index.rebuild(vault).expect("rebuild attachment index");

        let ambiguous = index
            .resolve_text(
                vault,
                "notes/Source.md",
                "figure.png",
                InternalLinkSyntax::Wikilink,
            )
            .link;
        assert_eq!(ambiguous.status, LinkResolutionStatus::Ambiguous);

        let targets = index
            .search("figure.png")
            .into_iter()
            .filter(|candidate| candidate.kind == WikiSearchCandidateKind::File)
            .map(|candidate| candidate.insert_text)
            .collect::<Vec<_>>();
        assert_eq!(
            targets,
            vec![
                "assets/first/figure.png".to_string(),
                "assets/second/figure.png".to_string()
            ]
        );

        fs::remove_dir_all(root).expect("remove fixture vault");
    }

    #[test]
    fn search_keeps_alias_display_separate_from_canonical_target() {
        let index = WikiIndex {
            documents: vec![WikiDocument {
                path: "notes/Canonical.md".into(),
                aliases: vec!["Short name".into()],
                headings: vec![
                    HeadingAnchor {
                        text: "Overview".into(),
                        path: vec!["Outer".into(), "Overview".into()],
                        level: 2,
                        line: 4,
                    },
                    HeadingAnchor {
                        text: "Overview".into(),
                        path: vec!["Other".into(), "Overview".into()],
                        level: 2,
                        line: 8,
                    },
                    HeadingAnchor {
                        text: "内层".into(),
                        path: vec!["中文外层".into(), "内层".into()],
                        level: 3,
                        line: 12,
                    },
                ],
                blocks: vec![BlockAnchor {
                    id: "验收块".into(),
                    preview: "Canonical block preview".into(),
                    line: 8,
                }],
            }],
            ..Default::default()
        };

        let alias_hits: Vec<_> = index
            .search("Short")
            .into_iter()
            .filter(|candidate| candidate.kind == WikiSearchCandidateKind::File)
            .collect();
        assert_eq!(
            alias_hits.len(),
            1,
            "alias query must not also list basename"
        );
        assert_eq!(alias_hits[0].alias.as_deref(), Some("Short name"));
        assert_eq!(alias_hits[0].label, "Short name");
        assert_eq!(alias_hits[0].insert_text, "Canonical");

        let heading = index
            .search("Outer#Overview")
            .into_iter()
            .find(|candidate| candidate.kind == WikiSearchCandidateKind::Heading)
            .expect("heading candidate");
        assert_eq!(heading.insert_text, "Canonical#Outer#Overview");
        assert_eq!(heading.label, "Outer › Overview");
        assert_eq!(heading.detail.as_deref(), Some("H2"));

        let heading_by_display_path = index
            .search("Other › Overview")
            .into_iter()
            .find(|candidate| candidate.kind == WikiSearchCandidateKind::Heading)
            .expect("heading candidate by display path");
        assert_eq!(
            heading_by_display_path.insert_text,
            "Canonical#Other#Overview"
        );

        let unicode_heading = index
            .search("中文外层#内层")
            .into_iter()
            .find(|candidate| candidate.kind == WikiSearchCandidateKind::Heading)
            .expect("Unicode heading candidate by persisted path");
        assert_eq!(unicode_heading.insert_text, "Canonical#中文外层#内层");
        assert_eq!(unicode_heading.label, "中文外层 › 内层");

        let block = index
            .search("验收")
            .into_iter()
            .find(|candidate| candidate.kind == WikiSearchCandidateKind::Block)
            .expect("block candidate");
        assert_eq!(block.insert_text, "Canonical#^验收块");
        assert_eq!(block.detail.as_deref(), Some("Canonical block preview"));
    }

    #[test]
    fn heading_search_scopes_each_hash_to_the_next_child_level() {
        let index = WikiIndex {
            documents: vec![WikiDocument {
                path: "notes/2026-W31.md".into(),
                aliases: Vec::new(),
                headings: vec![
                    HeadingAnchor {
                        text: "Week".into(),
                        path: vec!["Week".into()],
                        level: 1,
                        line: 1,
                    },
                    HeadingAnchor {
                        text: "07-28 周二".into(),
                        path: vec!["Week".into(), "07-28 周二".into()],
                        level: 2,
                        line: 2,
                    },
                    HeadingAnchor {
                        text: "复盘分析".into(),
                        path: vec!["Week".into(), "07-28 周二".into(), "复盘分析".into()],
                        level: 3,
                        line: 3,
                    },
                    HeadingAnchor {
                        text: "paper 阅读".into(),
                        path: vec![
                            "Week".into(),
                            "07-28 周二".into(),
                            "复盘分析".into(),
                            "paper 阅读".into(),
                        ],
                        level: 4,
                        line: 4,
                    },
                    HeadingAnchor {
                        text: "其他分支".into(),
                        path: vec!["Week".into(), "其他分支".into()],
                        level: 2,
                        line: 5,
                    },
                ],
                blocks: Vec::new(),
            }],
            ..Default::default()
        };

        let children = index.search_scoped(
            "07-28 周二#",
            Some("notes/2026-W31.md"),
            Some(&WikiSearchCandidateKind::Heading),
        );
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].label, "Week › 07-28 周二 › 复盘分析");

        let grandchildren = index.search_scoped(
            "07-28 周二#复盘分析#",
            Some("notes/2026-W31.md"),
            Some(&WikiSearchCandidateKind::Heading),
        );
        assert_eq!(grandchildren.len(), 1);
        assert_eq!(
            grandchildren[0].insert_text,
            "2026-W31#Week#07-28 周二#复盘分析#paper 阅读"
        );

        let suffix = index.search_scoped(
            "复盘分析#paper",
            Some("notes/2026-W31.md"),
            Some(&WikiSearchCandidateKind::Heading),
        );
        assert_eq!(suffix.len(), 1);
        assert_eq!(suffix[0].label, "Week › 07-28 周二 › 复盘分析 › paper 阅读");

        let invalid_gap = index.search_scoped(
            "07-28 周二##paper",
            Some("notes/2026-W31.md"),
            Some(&WikiSearchCandidateKind::Heading),
        );
        assert!(invalid_gap.is_empty());
    }

    #[test]
    fn search_uses_vault_relative_paths_for_duplicate_file_names() {
        let index = WikiIndex {
            documents: vec![
                WikiDocument {
                    path: "notes/Target.md".into(),
                    aliases: Vec::new(),
                    headings: Vec::new(),
                    blocks: Vec::new(),
                },
                WikiDocument {
                    path: "references/target.md".into(),
                    aliases: Vec::new(),
                    headings: Vec::new(),
                    blocks: Vec::new(),
                },
                WikiDocument {
                    path: "papers/Fara-1.5.md".into(),
                    aliases: Vec::new(),
                    headings: Vec::new(),
                    blocks: Vec::new(),
                },
            ],
            ..Default::default()
        };

        let duplicate_targets = index
            .search("Target")
            .into_iter()
            .filter(|candidate| candidate.kind == WikiSearchCandidateKind::File)
            .map(|candidate| candidate.insert_text)
            .collect::<Vec<_>>();
        assert_eq!(duplicate_targets, vec!["notes/Target", "references/target"]);

        let unique = index
            .search("Fara-1.5")
            .into_iter()
            .find(|candidate| candidate.kind == WikiSearchCandidateKind::File)
            .expect("unique file candidate");
        assert_eq!(unique.insert_text, "Fara-1.5");
    }

    #[test]
    fn scoped_search_filters_before_the_global_candidate_limit() {
        let mut documents = (0..101)
            .map(|index| WikiDocument {
                path: format!("early/{index:03}.md"),
                aliases: Vec::new(),
                headings: Vec::new(),
                blocks: Vec::new(),
            })
            .collect::<Vec<_>>();
        documents.push(WikiDocument {
            path: "notes/双链验收/目标笔记.md".into(),
            aliases: Vec::new(),
            headings: Vec::new(),
            blocks: vec![
                BlockAnchor {
                    id: "验收块".into(),
                    preview: "可精确定位到本段。".into(),
                    line: 17,
                },
                BlockAnchor {
                    id: "asb".into(),
                    preview: "请仅在 Agentero 内将本文件改名。".into(),
                    line: 21,
                },
            ],
        });
        let index = WikiIndex {
            documents,
            ..Default::default()
        };

        let blocks = index.search_scoped(
            "",
            Some("notes/双链验收/目标笔记.md"),
            Some(&WikiSearchCandidateKind::Block),
        );

        assert_eq!(blocks.len(), 2);
        assert!(blocks.iter().any(|candidate| {
            candidate.label == "^验收块"
                && candidate.detail.as_deref() == Some("可精确定位到本段。")
        }));
        assert!(blocks.iter().any(|candidate| {
            candidate.label == "^asb"
                && candidate.detail.as_deref() == Some("请仅在 Agentero 内将本文件改名。")
        }));
    }

    fn cache_fixture() -> (PathBuf, PathBuf) {
        let root = test_vault();
        fs::create_dir_all(root.join("assets")).expect("create cache asset directory");
        fs::write(
            root.join("notes/Target.md"),
            "# Root\n## Child\nTarget block ^focus\n",
        )
        .expect("write cache target");
        fs::write(
            root.join("notes/Source.md"),
            "[[Target#Child]]\n![[Target#^focus]]\n![[figure.png]]\n",
        )
        .expect("write cache source");
        fs::write(root.join("assets/figure.png"), b"cache image").expect("write cache image");
        let cache_path =
            std::env::temp_dir().join(format!("agentero-wiki-cache-{}.sqlite", Uuid::new_v4()));
        (root, cache_path)
    }

    fn rebuild_with_test_cache(
        index: &mut WikiIndex,
        root: &Path,
        cache_path: &Path,
    ) -> RebuildResult {
        let vault = root.to_str().expect("utf-8 cache fixture path");
        let files = collect_wiki_target_files(root).expect("collect cache fixture files");
        index
            .rebuild_with_cache_path(vault, root, files, cache_path, true)
            .expect("rebuild with cache")
    }

    fn cleanup_cache_fixture(root: &Path, cache_path: &Path) {
        let _ = discard_snapshot(cache_path);
        fs::remove_dir_all(root).expect("remove cache fixture vault");
    }

    #[test]
    fn restores_warm_snapshot_with_cold_query_semantics() {
        let (root, cache_path) = cache_fixture();
        let vault = root.to_str().expect("utf-8 cache fixture path");
        assert!(!cache_path.starts_with(&root));

        let mut cold = WikiIndex::default();
        let cold_result = rebuild_with_test_cache(&mut cold, &root, &cache_path);
        assert!(cache_path.is_file());

        let mut warm = WikiIndex::default();
        let warm_result = rebuild_with_test_cache(&mut warm, &root, &cache_path);
        assert_eq!(warm_result.indexed_files, cold_result.indexed_files);
        assert_eq!(warm_result.edges, cold_result.edges);
        assert_eq!(warm_result.nodes, cold_result.nodes);
        assert_eq!(warm.files, cold.files);
        assert_eq!(warm.documents, cold.documents);
        assert_eq!(warm.edges, cold.edges);
        assert_eq!(warm.reverse, cold.reverse);
        assert_eq!(warm.search("Child"), cold.search("Child"));
        assert_eq!(
            serde_json::to_value(warm.get_backlinks(vault, "notes/Target.md"))
                .expect("serialize warm backlinks"),
            serde_json::to_value(cold.get_backlinks(vault, "notes/Target.md"))
                .expect("serialize cold backlinks")
        );
        assert_eq!(
            serde_json::to_value(warm.get_outgoing(vault, "notes/Source.md"))
                .expect("serialize warm outgoing"),
            serde_json::to_value(cold.get_outgoing(vault, "notes/Source.md"))
                .expect("serialize cold outgoing")
        );

        cleanup_cache_fixture(&root, &cache_path);
    }

    #[test]
    fn invalidates_cache_when_a_vault_file_changes() {
        let (root, cache_path) = cache_fixture();
        let mut initial = WikiIndex::default();
        rebuild_with_test_cache(&mut initial, &root, &cache_path);

        fs::write(
            root.join("notes/Target.md"),
            "# Root\n## Renamed\nTarget block ^focus\n",
        )
        .expect("change cached target");
        let mut changed = WikiIndex::default();
        rebuild_with_test_cache(&mut changed, &root, &cache_path);

        let target = changed
            .document("notes/Target.md")
            .expect("changed target document");
        assert_eq!(target.headings[1].text, "Renamed");
        assert_eq!(
            changed.edges[0].status,
            LinkResolutionStatus::InvalidFragment
        );

        cleanup_cache_fixture(&root, &cache_path);
    }

    #[test]
    fn rebuilds_corrupt_version_mismatched_and_tampered_cache_files() {
        let (root, cache_path) = cache_fixture();
        let mut initial = WikiIndex::default();
        rebuild_with_test_cache(&mut initial, &root, &cache_path);

        fs::write(&cache_path, b"not a sqlite database").expect("corrupt wiki cache");
        let mut recovered = WikiIndex::default();
        rebuild_with_test_cache(&mut recovered, &root, &cache_path);
        assert_eq!(
            recovered
                .document("notes/Target.md")
                .expect("recovered target")
                .headings[1]
                .text,
            "Child"
        );

        {
            let connection = rusqlite::Connection::open(&cache_path).expect("open cache metadata");
            connection
                .execute(
                    "UPDATE cache_metadata SET schema_version = 999 WHERE id = 1",
                    [],
                )
                .expect("invalidate cache schema");
        }
        let mut version_recovered = WikiIndex::default();
        rebuild_with_test_cache(&mut version_recovered, &root, &cache_path);
        let connection =
            rusqlite::Connection::open(&cache_path).expect("open rebuilt cache metadata");
        let schema_version: i64 = connection
            .query_row(
                "SELECT schema_version FROM cache_metadata WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .expect("read rebuilt cache schema");
        assert_eq!(
            schema_version,
            crate::features::wiki::cache::WIKI_CACHE_SCHEMA_VERSION
        );
        connection
            .execute(
                "UPDATE documents SET headings_json = '[]' WHERE path = 'notes/Target.md'",
                [],
            )
            .expect("tamper valid cache JSON");
        drop(connection);

        let mut tamper_recovered = WikiIndex::default();
        rebuild_with_test_cache(&mut tamper_recovered, &root, &cache_path);
        assert_eq!(
            tamper_recovered
                .document("notes/Target.md")
                .expect("tamper recovered target")
                .headings
                .len(),
            2
        );

        cleanup_cache_fixture(&root, &cache_path);
    }

    #[test]
    fn cache_store_failure_does_not_block_in_memory_rebuild() {
        let (root, unused_cache_path) = cache_fixture();
        let blocker =
            std::env::temp_dir().join(format!("agentero-wiki-cache-blocker-{}", Uuid::new_v4()));
        fs::write(&blocker, b"not a directory").expect("write cache parent blocker");
        let cache_path = blocker.join("wiki.sqlite");
        let mut index = WikiIndex::default();

        let result = rebuild_with_test_cache(&mut index, &root, &cache_path);
        assert_eq!(result.edges, 3);
        assert_eq!(index.edges.len(), 3);
        assert!(blocker.is_file());

        fs::remove_file(blocker).expect("remove cache blocker");
        cleanup_cache_fixture(&root, &unused_cache_path);
    }

    #[test]
    fn hot_index_rebuild_is_incremental_and_keeps_the_disk_cache_equivalent() {
        let (root, cache_path) = cache_fixture();
        let vault = root.to_str().expect("utf-8 cache fixture path").to_string();
        let mut hot = WikiIndex::default();
        rebuild_with_test_cache(&mut hot, &root, &cache_path);

        // Change (different size), add, and remove files, then rebuild the
        // same in-memory index: the previous build is reused for unchanged
        // files and the on-disk cache receives only the changed rows.
        fs::write(
            root.join("notes/Target.md"),
            "# Root\n## Renamed heading\nTarget block ^focus\n",
        )
        .expect("change target");
        fs::write(root.join("notes/Extra.md"), "[[Target#Renamed heading]]\n")
            .expect("add extra source");
        fs::remove_file(root.join("assets/figure.png")).expect("remove image");
        let result = rebuild_with_test_cache(&mut hot, &root, &cache_path);
        assert_eq!(result.indexed_files, 3);
        assert_eq!(
            hot.document("notes/Target.md")
                .expect("changed target")
                .headings[1]
                .text,
            "Renamed heading"
        );
        let extra = hot.get_outgoing(&vault, "notes/Extra.md");
        assert_eq!(extra.outgoing.len(), 1);
        assert_eq!(extra.outgoing[0].status, LinkResolutionStatus::Resolved);
        assert!(hot.document("assets/figure.png").is_none());

        // A cold process restoring the incrementally-updated cache must be
        // indistinguishable from a full re-read of the vault.
        let mut restored = WikiIndex::default();
        rebuild_with_test_cache(&mut restored, &root, &cache_path);
        let mut fresh = WikiIndex::default();
        fresh.rebuild_read_only(&vault).expect("read-only rebuild");
        assert_eq!(restored.documents, fresh.documents);
        assert_eq!(restored.edges, fresh.edges);
        assert_eq!(restored.reverse, fresh.reverse);
        assert_eq!(restored.files, fresh.files);

        cleanup_cache_fixture(&root, &cache_path);
    }

    #[test]
    fn warm_restore_reflects_resolution_changes_caused_by_other_files() {
        let root = test_vault();
        fs::write(root.join("notes/Source.md"), "[[FutureTarget]]\n").expect("write source");
        let cache_path =
            std::env::temp_dir().join(format!("agentero-wiki-cache-{}.sqlite", Uuid::new_v4()));
        let mut hot = WikiIndex::default();
        rebuild_with_test_cache(&mut hot, &root, &cache_path);
        assert_eq!(hot.edges[0].status, LinkResolutionStatus::Missing);

        // Creating the target changes the resolution of the *unchanged*
        // Source.md. The incremental persist stores only parse products, so a
        // later warm restore must still re-resolve to the new state.
        fs::write(root.join("notes/FutureTarget.md"), "# Future\n").expect("write target");
        rebuild_with_test_cache(&mut hot, &root, &cache_path);
        assert_eq!(hot.edges[0].status, LinkResolutionStatus::Resolved);

        let mut restored = WikiIndex::default();
        rebuild_with_test_cache(&mut restored, &root, &cache_path);
        assert_eq!(restored.edges[0].status, LinkResolutionStatus::Resolved);
        assert_eq!(
            restored.edges[0].target_path.as_deref(),
            Some("notes/FutureTarget.md")
        );

        cleanup_cache_fixture(&root, &cache_path);
    }

    #[test]
    fn unchanged_fingerprints_return_the_last_result_without_breaking_queries() {
        let (root, cache_path) = cache_fixture();
        let vault = root.to_str().expect("utf-8 cache fixture path").to_string();
        let mut hot = WikiIndex::default();
        let first = rebuild_with_test_cache(&mut hot, &root, &cache_path);
        let second = rebuild_with_test_cache(&mut hot, &root, &cache_path);
        assert_eq!(second.indexed_files, first.indexed_files);
        assert_eq!(second.edges, first.edges);
        assert_eq!(second.nodes, first.nodes);
        let backlinks = hot.get_backlinks(&vault, "notes/Target.md");
        assert_eq!(backlinks.backlinks.len(), 2);
        assert!(!hot.search("Target").is_empty());

        cleanup_cache_fixture(&root, &cache_path);
    }

    /// Release-mode benchmark for the production rebuild paths:
    /// `cargo test -p agentero --release --lib -- --ignored bench_wiki_rebuild --nocapture`
    #[test]
    #[ignore = "perf benchmark; run manually in release mode"]
    fn bench_wiki_rebuild_scenarios() {
        use std::fmt::Write as _;
        use std::time::Instant;

        let root = std::env::temp_dir().join(format!("agentero-wiki-bench-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("notes")).expect("create bench vault");
        let file_count = 1000usize;
        for i in 0..file_count {
            let mut content =
                format!("# Note {i}\n\n## Section {i}\n\nBody text for note {i}.\n\n");
            for j in 0..5usize {
                let target = (i * 7 + j * 131 + 1) % file_count;
                let _ = writeln!(content, "Link to [[note-{target:04}]] in this line.");
            }
            fs::write(root.join(format!("notes/note-{i:04}.md")), content)
                .expect("write bench note");
        }
        let cache_path = std::env::temp_dir().join(format!(
            "agentero-wiki-bench-cache-{}.sqlite",
            Uuid::new_v4()
        ));
        let vault = root.to_str().expect("utf-8 bench vault").to_string();
        let rebuild = |index: &mut WikiIndex| {
            let files = collect_wiki_target_files(&root).expect("collect bench files");
            index
                .rebuild_with_cache_path(&vault, &root, files, &cache_path, true)
                .expect("bench rebuild")
        };

        // Scenario A: cold start, no cache on disk.
        let mut index = WikiIndex::default();
        let started = Instant::now();
        let cold = rebuild(&mut index);
        eprintln!(
            "A  cold rebuild + store          {:>10.3?}  ({} files, {} edges)",
            started.elapsed(),
            cold.indexed_files,
            cold.edges
        );

        // Scenario A2: process restart, cache on disk, nothing changed.
        let mut warm = WikiIndex::default();
        let started = Instant::now();
        rebuild(&mut warm);
        eprintln!(
            "A2 warm disk restore             {:>10.3?}",
            started.elapsed()
        );

        // Scenario B: one file changed, index already hot in memory.
        fs::write(
            root.join("notes/note-0100.md"),
            "# Note changed\n\nLink to [[note-0002]] plus fresh text that changes the size.\n",
        )
        .expect("change bench note");
        let started = Instant::now();
        rebuild(&mut warm);
        eprintln!(
            "B  one-file-changed hot rebuild  {:>10.3?}",
            started.elapsed()
        );

        // Scenario B2: watcher fired but nothing actually changed.
        let started = Instant::now();
        rebuild(&mut warm);
        eprintln!(
            "B2 no-change hot rebuild         {:>10.3?}",
            started.elapsed()
        );

        // Scenario C: production-like rename transaction (pre-check rebuild,
        // plan, execute, post rebuild) against a hot index.
        let started = Instant::now();
        rebuild(&mut warm);
        let transaction = crate::features::wiki::rename::WikiRenameTransaction::plan(
            &root,
            &warm,
            "notes/note-0001.md",
            "notes/renamed-0001.md",
        )
        .expect("plan bench rename");
        transaction
            .execute(|| Ok(()))
            .expect("execute bench rename");
        rebuild(&mut warm);
        eprintln!(
            "C  rename transaction total      {:>10.3?}",
            started.elapsed()
        );

        let _ = discard_snapshot(&cache_path);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn fresh_rebuild_discards_and_replaces_the_snapshot() {
        let (root, cache_path) = cache_fixture();
        let vault = root.to_str().expect("utf-8 cache fixture path");
        let mut initial = WikiIndex::default();
        rebuild_with_test_cache(&mut initial, &root, &cache_path);
        {
            let connection = rusqlite::Connection::open(&cache_path).expect("open cache");
            connection
                .execute(
                    "UPDATE cache_metadata SET parser_version = 'stale' WHERE id = 1",
                    [],
                )
                .expect("stale parser version");
        }

        let mut fresh = WikiIndex::default();
        let result = fresh
            .rebuild_fresh_with_cache_path(vault, &cache_path)
            .expect("fresh cache rebuild");
        assert_eq!(result.edges, 3);
        let connection = rusqlite::Connection::open(&cache_path).expect("open fresh cache");
        let parser_version: String = connection
            .query_row(
                "SELECT parser_version FROM cache_metadata WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .expect("read fresh parser version");
        assert_eq!(
            parser_version,
            crate::features::wiki::cache::WIKI_PARSER_VERSION
        );

        cleanup_cache_fixture(&root, &cache_path);
    }
}
