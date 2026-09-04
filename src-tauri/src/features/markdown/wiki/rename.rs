//! Link-aware local Vault rename transactions.
//!
//! The planner consumes the *pre-move* semantic index and only replaces the
//! target byte range of occurrences that were already resolved. Markdown stays
//! the authority: the index is rebuilt by the caller after a successful commit.
//!
//! This module is the wiki domain's *atomic* capability (plan + execute +
//! rollback of the move and link rewrites). The cross-domain orchestration
//! trunk (index rebuilds, dependent catalog commit, external-repair store)
//! lives one level up in `features/rename`.

use crate::features::wiki::index::WikiIndex;
use crate::features::wiki::models::{
    InternalLinkSyntax, LinkResolutionStatus, ResolvedLink, WikiRenameErrorCode, WikiRenameResult,
    WikiRenameRollback, WikiRenameSkipped,
};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt;
use std::fs;
use std::path::{Component, Path, PathBuf};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct WikiRenameError {
    pub code: WikiRenameErrorCode,
    pub message: String,
    pub rollback: WikiRenameRollback,
    pub paths: Vec<String>,
}

impl WikiRenameError {
    pub(crate) fn new(code: WikiRenameErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            rollback: WikiRenameRollback::NotNeeded,
            paths: Vec::new(),
        }
    }

    pub(crate) fn after_mutation(
        code: WikiRenameErrorCode,
        message: impl Into<String>,
        rollback: WikiRenameRollback,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            rollback,
            paths: Vec::new(),
        }
    }

    pub(crate) fn with_paths(mut self, paths: Vec<String>) -> Self {
        self.paths = paths;
        self
    }
}

impl fmt::Display for WikiRenameError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} ({:?})", self.message, self.code)
    }
}

impl Error for WikiRenameError {}

#[derive(Debug, Clone)]
struct PlannedEdit {
    start: usize,
    end: usize,
    expected: String,
    replacement: String,
}

#[derive(Debug, Clone)]
struct PlannedSource {
    current_path: String,
    final_path: String,
    original_content: String,
    original_hash: String,
    edits: Vec<PlannedEdit>,
}

/// A preflighted local rename/move. Construction never mutates the Vault.
#[derive(Debug, Clone)]
pub struct WikiRenameTransaction {
    vault_root: PathBuf,
    from: String,
    to: String,
    primary_move_pending: bool,
    sources: Vec<PlannedSource>,
    skipped: Vec<WikiRenameSkipped>,
}

/// Return the uniquely resolved document target independently of fragment health.
///
/// File moves replace only `target_raw`; heading/block fragments stay untouched.
/// A stale fragment therefore must not make an otherwise unambiguous Wikilink or
/// embed keep pointing at the old file path.
fn unique_document_target(edge: &ResolvedLink) -> Option<&str> {
    match edge.status {
        LinkResolutionStatus::Resolved | LinkResolutionStatus::InvalidFragment => {
            edge.target_path.as_deref()
        }
        LinkResolutionStatus::Missing | LinkResolutionStatus::Ambiguous => None,
    }
}

impl WikiRenameTransaction {
    /// Create a transaction from an index that still describes the old Vault
    /// state. The caller must rebuild immediately before calling this function.
    pub fn plan(
        vault_root: impl Into<PathBuf>,
        index: &WikiIndex,
        from: &str,
        to: &str,
    ) -> Result<Self, WikiRenameError> {
        Self::plan_with_move_state(vault_root, index, from, to, true)
    }

    /// Plan a repair after a local filesystem watcher has reliably observed
    /// that the primary rename already happened. The supplied index must still
    /// describe the old paths; sources are read from their final locations and
    /// their original link text is checked before any write is allowed.
    pub fn plan_external_repair(
        vault_root: impl Into<PathBuf>,
        index: &WikiIndex,
        from: &str,
        to: &str,
    ) -> Result<Self, WikiRenameError> {
        Self::plan_with_move_state(vault_root, index, from, to, false)
    }

    fn plan_with_move_state(
        vault_root: impl Into<PathBuf>,
        index: &WikiIndex,
        from: &str,
        to: &str,
        primary_move_pending: bool,
    ) -> Result<Self, WikiRenameError> {
        let vault_root = vault_root.into();
        crate::core::fs::ensure_vault_dir(&vault_root)
            .map_err(|e| WikiRenameError::new(WikiRenameErrorCode::InvalidPath, e.to_string()))?;
        if index.vault_path.as_deref() != vault_root.to_str() {
            return Err(WikiRenameError::new(
                WikiRenameErrorCode::IndexStale,
                "wiki index does not describe this vault",
            ));
        }

        let from = normalize_vault_path(from)?;
        let to = normalize_vault_path(to)?;
        if from == to {
            return Err(WikiRenameError::new(
                WikiRenameErrorCode::InvalidPath,
                "source and target paths are identical",
            ));
        }
        if is_at_or_under(&to, &from) {
            return Err(WikiRenameError::new(
                WikiRenameErrorCode::TargetInsideSource,
                "cannot move a path into itself",
            ));
        }

        let from_exists = vault_root.join(&from).exists();
        let to_exists = vault_root.join(&to).exists();
        if primary_move_pending {
            if !from_exists {
                return Err(WikiRenameError::new(
                    WikiRenameErrorCode::SourceMissing,
                    "source path does not exist",
                ));
            }
            if to_exists {
                return Err(WikiRenameError::new(
                    WikiRenameErrorCode::TargetExists,
                    "target path already exists",
                ));
            }
        } else if from_exists || !to_exists {
            return Err(WikiRenameError::new(
                WikiRenameErrorCode::SourceChanged,
                "external rename pair is no longer valid",
            ));
        }

        let mut candidates: BTreeMap<String, Vec<PlannedEdit>> = BTreeMap::new();
        let mut skipped: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();

        for edge in &index.edges {
            let source_moved = is_at_or_under(&edge.occurrence.source, &from);
            let unique_target = unique_document_target(edge);
            let target_moved = unique_target.is_some_and(|target| is_at_or_under(target, &from));
            let candidate_target_moved = edge
                .candidates
                .iter()
                .any(|candidate| is_at_or_under(candidate, &from));
            let source_moved_markdown =
                source_moved && matches!(edge.occurrence.syntax, InternalLinkSyntax::Markdown);

            if !target_moved && !candidate_target_moved && !source_moved_markdown {
                continue;
            }
            let Some(target) = unique_target else {
                skipped
                    .entry(edge.occurrence.source.clone())
                    .or_default()
                    .insert("unresolved or ambiguous link".to_string());
                continue;
            };
            let final_source = remap_path(&edge.occurrence.source, &from, &to);
            let final_target = remap_path(target, &from, &to);
            let replacement = replacement_target(
                &edge.occurrence.syntax,
                &edge.occurrence.target_raw,
                &final_source,
                &final_target,
            );
            if replacement == edge.occurrence.target_raw {
                continue;
            }
            candidates
                .entry(edge.occurrence.source.clone())
                .or_default()
                .push(PlannedEdit {
                    start: edge.occurrence.source_range.start,
                    end: edge.occurrence.source_range.end,
                    expected: edge.occurrence.target_raw.clone(),
                    replacement,
                });
        }

        let mut sources = Vec::new();
        for (path, mut edits) in candidates {
            let current_path = if primary_move_pending {
                path.clone()
            } else {
                remap_path(&path, &from, &to)
            };
            let original_content =
                fs::read_to_string(vault_root.join(&current_path)).map_err(|error| {
                    WikiRenameError::new(
                        WikiRenameErrorCode::SourceChanged,
                        format!("could not read planned source {current_path}: {error}"),
                    )
                })?;
            edits.sort_by_key(|edit| std::cmp::Reverse(edit.start));
            if edits.iter().any(|edit| {
                edit.start > edit.end
                    || edit.end > original_content.len()
                    || !original_content.is_char_boundary(edit.start)
                    || !original_content.is_char_boundary(edit.end)
                    || original_content.get(edit.start..edit.end) != Some(edit.expected.as_str())
            }) || edits.windows(2).any(|pair| pair[0].start < pair[1].end)
            {
                return Err(WikiRenameError::new(
                    WikiRenameErrorCode::OverlappingEdits,
                    format!("planned edits overlap or exceed source bounds in {path}"),
                ));
            }
            sources.push(PlannedSource {
                final_path: remap_path(&path, &from, &to),
                original_hash: content_hash(&original_content),
                original_content,
                current_path,
                edits,
            });
        }

        let skipped = skipped
            .into_iter()
            .map(|(path, reasons)| WikiRenameSkipped {
                path,
                reason: reasons.into_iter().collect::<Vec<_>>().join(", "),
            })
            .collect();
        Ok(Self {
            vault_root,
            from,
            to,
            primary_move_pending,
            sources,
            skipped,
        })
    }

    pub fn moved_path(&self) -> &str {
        &self.to
    }

    pub fn from(&self) -> &str {
        &self.from
    }

    /// Vault root this transaction was planned against.
    pub fn vault_root(&self) -> &Path {
        &self.vault_root
    }

    /// True when this plan performs the primary filesystem move itself
    /// (false for external-repair plans that only rewrite Markdown).
    pub fn primary_move_pending(&self) -> bool {
        self.primary_move_pending
    }

    pub fn skipped(&self) -> &[WikiRenameSkipped] {
        &self.skipped
    }

    pub fn updated_sources(&self) -> Vec<String> {
        self.sources
            .iter()
            .map(|source| source.final_path.clone())
            .collect()
    }

    pub fn reject_dirty_paths(&self, dirty_paths: &[String]) -> Result<(), WikiRenameError> {
        let mut affected = BTreeSet::new();
        for raw_path in dirty_paths {
            let path = normalize_vault_path(raw_path)?;
            let touches_primary_move = is_at_or_under(&path, &self.from);
            let touches_rewrite = self
                .sources
                .iter()
                .any(|source| source.current_path == path);
            if touches_primary_move || touches_rewrite {
                affected.insert(path);
            }
        }
        if !affected.is_empty() {
            let paths = affected.into_iter().collect::<Vec<_>>();
            return Err(WikiRenameError::new(
                WikiRenameErrorCode::UnsavedEdits,
                format!("unsaved editor changes block move: {}", paths.join(", ")),
            )
            .with_paths(paths));
        }
        Ok(())
    }

    /// Execute the filesystem move, all planned atomic writes, and then an
    /// optional dependent commit (for example a catalog path update). A failed
    /// dependent commit still rolls the Markdown and primary move back.
    pub fn execute<F>(&self, commit: F) -> Result<WikiRenameResult, WikiRenameError>
    where
        F: FnOnce() -> Result<(), String>,
    {
        if !self.primary_move_pending {
            return Err(WikiRenameError::new(
                WikiRenameErrorCode::InvalidPath,
                "external repair plan cannot perform a primary move",
            ));
        }
        self.execute_inner(commit, None)
    }

    /// Apply only Markdown rewrites after an already-observed external rename.
    pub fn execute_external_repair(&self) -> Result<WikiRenameResult, WikiRenameError> {
        if self.primary_move_pending {
            return Err(WikiRenameError::new(
                WikiRenameErrorCode::InvalidPath,
                "local move plan cannot be applied as an external repair",
            ));
        }
        self.execute_inner(|| Ok(()), None)
    }

    fn execute_inner<F>(
        &self,
        commit: F,
        fail_write_at: Option<usize>,
    ) -> Result<WikiRenameResult, WikiRenameError>
    where
        F: FnOnce() -> Result<(), String>,
    {
        self.verify_sources_unchanged()?;

        let mut primary_move_completed = false;
        if self.primary_move_pending {
            let from_abs = self.vault_root.join(&self.from);
            let to_abs = self.vault_root.join(&self.to);
            if to_abs.exists() {
                return Err(WikiRenameError::new(
                    WikiRenameErrorCode::TargetExists,
                    "target path already exists",
                ));
            }
            if let Some(parent) = to_abs.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    WikiRenameError::new(
                        WikiRenameErrorCode::MoveFailed,
                        format!("could not create target parent: {error}"),
                    )
                })?;
            }
            fs::rename(&from_abs, &to_abs).map_err(|error| {
                WikiRenameError::new(
                    WikiRenameErrorCode::MoveFailed,
                    format!("could not move {} to {}: {error}", self.from, self.to),
                )
            })?;
            primary_move_completed = true;
        } else if self.vault_root.join(&self.from).exists()
            || !self.vault_root.join(&self.to).exists()
        {
            return Err(WikiRenameError::new(
                WikiRenameErrorCode::SourceChanged,
                "external rename pair changed before repair",
            ));
        }

        let mut written = Vec::new();
        for (write_index, source) in self.sources.iter().enumerate() {
            if fail_write_at == Some(write_index) {
                let rollback = self.rollback(&written, primary_move_completed);
                return Err(WikiRenameError::after_mutation(
                    WikiRenameErrorCode::WriteFailed,
                    format!("simulated write failure for {}", source.final_path),
                    rollback,
                ));
            }
            let rewritten = apply_edits(&source.original_content, &source.edits);
            if let Err(error) = atomic_write(
                &self.vault_root.join(&source.final_path),
                rewritten.as_bytes(),
            ) {
                let rollback = self.rollback(&written, primary_move_completed);
                return Err(WikiRenameError::after_mutation(
                    WikiRenameErrorCode::WriteFailed,
                    format!("could not rewrite {}: {error}", source.final_path),
                    rollback,
                ));
            }
            written.push(source);
        }

        if let Err(message) = commit() {
            let rollback = self.rollback(&written, primary_move_completed);
            return Err(WikiRenameError::after_mutation(
                WikiRenameErrorCode::CommitFailed,
                message,
                rollback,
            ));
        }

        Ok(WikiRenameResult {
            moved_path: self.to.clone(),
            updated_sources: self.updated_sources(),
            skipped: self.skipped.clone(),
            rollback: WikiRenameRollback::NotNeeded,
        })
    }

    fn verify_sources_unchanged(&self) -> Result<(), WikiRenameError> {
        for source in &self.sources {
            let current = fs::read_to_string(self.vault_root.join(&source.current_path)).map_err(
                |error| {
                    WikiRenameError::new(
                        WikiRenameErrorCode::SourceChanged,
                        format!(
                            "could not re-read planned source {}: {error}",
                            source.current_path
                        ),
                    )
                },
            )?;
            if content_hash(&current) != source.original_hash {
                return Err(WikiRenameError::new(
                    WikiRenameErrorCode::SourceChanged,
                    format!("planned source changed: {}", source.current_path),
                ));
            }
        }
        Ok(())
    }

    fn rollback(
        &self,
        written: &[&PlannedSource],
        primary_move_completed: bool,
    ) -> WikiRenameRollback {
        let mut complete = true;
        for source in written.iter().rev() {
            if atomic_write(
                &self.vault_root.join(&source.final_path),
                source.original_content.as_bytes(),
            )
            .is_err()
            {
                complete = false;
            }
        }
        if primary_move_completed
            && fs::rename(
                self.vault_root.join(&self.to),
                self.vault_root.join(&self.from),
            )
            .is_err()
        {
            complete = false;
        }
        if complete {
            WikiRenameRollback::Completed
        } else {
            WikiRenameRollback::ManualRecoveryRequired
        }
    }
}

pub(crate) fn normalize_vault_path(path: &str) -> Result<String, WikiRenameError> {
    let path = path.trim().replace('\\', "/");
    let path = path.trim_matches('/');
    if path.is_empty() {
        return Err(WikiRenameError::new(
            WikiRenameErrorCode::InvalidPath,
            "path is required",
        ));
    }
    let parsed = Path::new(path);
    if parsed.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(WikiRenameError::new(
            WikiRenameErrorCode::InvalidPath,
            "path must stay inside the vault",
        ));
    }
    Ok(parsed.to_string_lossy().replace('\\', "/"))
}

fn is_at_or_under(path: &str, root: &str) -> bool {
    path == root || path.starts_with(&format!("{root}/"))
}

fn remap_path(path: &str, from: &str, to: &str) -> String {
    if path == from {
        return to.to_string();
    }
    path.strip_prefix(&format!("{from}/"))
        .map(|suffix| format!("{to}/{suffix}"))
        .unwrap_or_else(|| path.to_string())
}

fn replacement_target(
    syntax: &InternalLinkSyntax,
    target_raw: &str,
    final_source: &str,
    final_target: &str,
) -> String {
    if target_raw.is_empty() && final_source == final_target {
        return String::new();
    }
    match syntax {
        InternalLinkSyntax::Wikilink => strip_markdown_extension(final_target).to_string(),
        InternalLinkSyntax::Markdown => markdown_relative_target(final_source, final_target),
    }
}

fn strip_markdown_extension(path: &str) -> &str {
    [".markdown", ".mdx", ".md"]
        .iter()
        .find_map(|extension| path.strip_suffix(extension))
        .unwrap_or(path)
}

fn markdown_relative_target(source: &str, target: &str) -> String {
    let source_parent = Path::new(source).parent().unwrap_or_else(|| Path::new(""));
    let source_parts = source_parent
        .components()
        .filter_map(component_name)
        .collect::<Vec<_>>();
    let target_parts = Path::new(target)
        .components()
        .filter_map(component_name)
        .collect::<Vec<_>>();
    let common = source_parts
        .iter()
        .zip(&target_parts)
        .take_while(|(left, right)| left == right)
        .count();
    let mut parts = Vec::new();
    parts.extend(std::iter::repeat_n("..", source_parts.len() - common));
    parts.extend(target_parts[common..].iter().copied());
    if parts.is_empty() {
        Path::new(target)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(target)
            .to_string()
    } else {
        parts.join("/")
    }
}

fn component_name(component: Component<'_>) -> Option<&str> {
    match component {
        Component::Normal(value) => value.to_str(),
        _ => None,
    }
}

pub(crate) fn content_hash(content: &str) -> String {
    hex::encode(Sha256::digest(content.as_bytes()))
}

fn apply_edits(content: &str, edits: &[PlannedEdit]) -> String {
    let mut rewritten = content.to_string();
    for edit in edits {
        rewritten.replace_range(edit.start..edit.end, &edit.replacement);
    }
    rewritten
}

pub(crate) fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
    path.parent()
        .ok_or_else(|| format!("{} has no parent", path.display()))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("markdown");
    // `.agentero-rename-` marks the temp for the vault watcher (content
    // modify, not a user rename); the `.tmp` suffix keeps sync scans away.
    let opts = crate::core::fs::AtomicOpts {
        temp_name: Some(format!(".{name}.agentero-rename-{}.tmp", Uuid::new_v4())),
        ..Default::default()
    };
    crate::core::fs::atomic_write_with(path, contents, &opts).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::wiki::index::WikiIndex;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct SharedFixture {
        documents: Vec<FixtureDocument>,
        #[serde(rename = "moveCases")]
        move_cases: Vec<MoveCase>,
    }

    #[derive(Deserialize)]
    struct FixtureDocument {
        path: String,
        content: String,
    }

    #[derive(Deserialize)]
    struct MoveCase {
        source: String,
        from: String,
        to: String,
        expected: String,
    }

    fn temp_vault() -> PathBuf {
        let root = std::env::temp_dir().join(format!("agentero-wiki-rename-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create vault");
        root
    }

    fn write(root: &Path, path: &str, content: &str) {
        let file = root.join(path);
        fs::create_dir_all(file.parent().expect("parent")).expect("create parent");
        fs::write(file, content).expect("write fixture");
    }

    fn snapshot(root: &Path) -> WikiIndex {
        let mut index = WikiIndex::default();
        index
            .rebuild(root.to_str().expect("utf8 vault"))
            .expect("rebuild");
        index
    }

    #[test]
    fn plans_and_rewrites_only_resolved_target_ranges() {
        let root = temp_vault();
        write(
            &root,
            "notes/Source.md",
            "[[notes/Target#Overview|Alias]] ![[notes/Target#^block]] [label](./Target.md#Overview) `[[notes/Target]]`\n",
        );
        write(&root, "notes/Target.md", "# Overview\nText ^block\n");
        let index = snapshot(&root);
        let transaction =
            WikiRenameTransaction::plan(&root, &index, "notes/Target.md", "archive/Renamed.md")
                .expect("plan");

        assert_eq!(transaction.updated_sources(), vec!["notes/Source.md"]);
        transaction.execute(|| Ok(())).expect("execute");
        let source = fs::read_to_string(root.join("notes/Source.md")).expect("source");
        assert_eq!(
            source,
            "[[archive/Renamed#Overview|Alias]] ![[archive/Renamed#^block]] [label](../archive/Renamed.md#Overview) `[[notes/Target]]`\n"
        );
        assert!(root.join("archive/Renamed.md").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rewrites_unique_file_targets_even_when_an_embed_fragment_is_invalid() {
        let root = temp_vault();
        write(
            &root,
            "notes/Source.md",
            "[[notes/Target#Overview]]\n![[notes/Target#Renamed heading]]\n",
        );
        write(&root, "notes/Target.md", "# Overview\n");
        let index = snapshot(&root);
        let transaction =
            WikiRenameTransaction::plan(&root, &index, "notes/Target.md", "archive/Renamed.md")
                .expect("plan");

        assert_eq!(transaction.updated_sources(), vec!["notes/Source.md"]);
        assert!(transaction.skipped().is_empty());
        transaction.execute(|| Ok(())).expect("execute");
        assert_eq!(
            fs::read_to_string(root.join("notes/Source.md")).expect("source"),
            "[[archive/Renamed#Overview]]\n![[archive/Renamed#Renamed heading]]\n"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn shared_fixture_preserves_fragments_while_rewriting_targets() {
        let fixture: SharedFixture = serde_json::from_str(include_str!(
            "../../../../../test/fixtures/wikilinks/semantic-cases.json"
        ))
        .expect("shared fixture must parse");
        let root = temp_vault();
        for document in fixture
            .documents
            .iter()
            // The shared resolver fixture deliberately includes an ambiguous
            // duplicate. Rename only rewrites resolved occurrences, so the
            // move projection uses its unambiguous subset.
            .filter(|document| document.path != "duplicates/Target.md")
        {
            write(&root, &document.path, &document.content);
        }
        let first = fixture.move_cases.first().expect("move fixture");
        let index = snapshot(&root);
        WikiRenameTransaction::plan(&root, &index, &first.from, &first.to)
            .expect("plan")
            .execute(|| Ok(()))
            .expect("execute");

        for case in fixture.move_cases {
            let source = fs::read_to_string(root.join(&case.source)).expect("source");
            assert!(source.contains(&case.expected), "{}", case.expected);
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn moving_a_source_rewrites_relative_markdown_links_but_keeps_self_fragment() {
        let root = temp_vault();
        write(
            &root,
            "notes/Source.md",
            "[target](./Target.md#Overview) [[#Local]]\n# Local\n",
        );
        write(&root, "notes/Target.md", "# Overview\n");
        let index = snapshot(&root);
        let transaction =
            WikiRenameTransaction::plan(&root, &index, "notes/Source.md", "archive/Source.md")
                .expect("plan");

        transaction.execute(|| Ok(())).expect("execute");
        let source = fs::read_to_string(root.join("archive/Source.md")).expect("source");
        assert_eq!(
            source,
            "[target](../notes/Target.md#Overview) [[#Local]]\n# Local\n"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn source_hash_conflict_prevents_any_mutation() {
        let root = temp_vault();
        write(&root, "notes/Source.md", "[[notes/Target]]\n");
        write(&root, "notes/Target.md", "# Target\n");
        let index = snapshot(&root);
        let transaction =
            WikiRenameTransaction::plan(&root, &index, "notes/Target.md", "archive/Target.md")
                .expect("plan");
        write(&root, "notes/Source.md", "manual edit\n");

        let error = transaction.execute(|| Ok(())).expect_err("hash conflict");
        assert_eq!(error.code, WikiRenameErrorCode::SourceChanged);
        assert!(root.join("notes/Target.md").exists());
        assert!(!root.join("archive/Target.md").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn target_conflict_and_ambiguous_links_never_trigger_a_blind_rewrite() {
        let root = temp_vault();
        write(&root, "notes/Source.md", "[[Target]]\n");
        write(&root, "notes/Target.md", "# Target\n");
        write(&root, "other/Target.md", "# Duplicate\n");
        write(&root, "archive/Target.md", "# Existing\n");
        let index = snapshot(&root);
        let conflict =
            WikiRenameTransaction::plan(&root, &index, "notes/Target.md", "archive/Target.md")
                .expect_err("existing target must stop the transaction");
        assert_eq!(conflict.code, WikiRenameErrorCode::TargetExists);

        let transaction =
            WikiRenameTransaction::plan(&root, &index, "notes/Target.md", "archive/Renamed.md")
                .expect("ambiguous occurrence is skipped rather than rewritten");
        assert!(transaction.updated_sources().is_empty());
        assert_eq!(transaction.skipped.len(), 1);
        assert_eq!(transaction.skipped[0].path, "notes/Source.md");
        transaction.execute(|| Ok(())).expect("move");
        assert_eq!(
            fs::read_to_string(root.join("notes/Source.md")).unwrap(),
            "[[Target]]\n"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn failed_dependent_commit_restores_markdown_and_primary_move() {
        let root = temp_vault();
        write(&root, "notes/Source.md", "[[notes/Target]]\n");
        write(&root, "notes/Target.md", "# Target\n");
        let index = snapshot(&root);
        let transaction =
            WikiRenameTransaction::plan(&root, &index, "notes/Target.md", "archive/Target.md")
                .expect("plan");

        let error = transaction
            .execute(|| Err("catalog update failed".to_string()))
            .expect_err("catalog failure must roll back");
        assert_eq!(error.code, WikiRenameErrorCode::CommitFailed);
        assert_eq!(error.rollback, WikiRenameRollback::Completed);
        assert_eq!(
            fs::read_to_string(root.join("notes/Source.md")).unwrap(),
            "[[notes/Target]]\n"
        );
        assert!(root.join("notes/Target.md").exists());
        assert!(!root.join("archive/Target.md").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unsaved_source_or_moved_path_blocks_before_any_mutation() {
        let root = temp_vault();
        write(&root, "notes/Source.md", "[[notes/Target]]\n");
        write(&root, "notes/Target.md", "# Target\n");
        let index = snapshot(&root);
        let transaction =
            WikiRenameTransaction::plan(&root, &index, "notes/Target.md", "archive/Target.md")
                .expect("plan");

        let error = transaction
            .reject_dirty_paths(&[
                "notes/Target.md".to_string(),
                "notes/Unrelated.md".to_string(),
                "notes/Source.md".to_string(),
            ])
            .expect_err("dirty incoming source must block the move");
        assert_eq!(error.code, WikiRenameErrorCode::UnsavedEdits);
        assert_eq!(
            error.paths,
            vec!["notes/Source.md".to_string(), "notes/Target.md".to_string()]
        );
        assert!(root.join("notes/Target.md").exists());
        assert!(!root.join("archive/Target.md").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn external_rename_repair_rejects_dirty_or_stale_sources_without_writing() {
        let root = temp_vault();
        write(&root, "notes/Source.md", "[[notes/Target]]\n");
        write(&root, "notes/Target.md", "# Target\n");
        let index = snapshot(&root);
        fs::create_dir_all(root.join("archive")).expect("create archive");
        fs::rename(root.join("notes/Target.md"), root.join("archive/Target.md"))
            .expect("external rename");
        let transaction = WikiRenameTransaction::plan_external_repair(
            &root,
            &index,
            "notes/Target.md",
            "archive/Target.md",
        )
        .expect("external plan");

        let dirty = transaction
            .reject_dirty_paths(&["notes/Source.md".to_string()])
            .expect_err("dirty source blocks repair");
        assert_eq!(dirty.code, WikiRenameErrorCode::UnsavedEdits);
        assert_eq!(dirty.paths, vec!["notes/Source.md".to_string()]);
        write(&root, "notes/Source.md", "[[manually changed]]\n");
        let stale = transaction
            .execute_external_repair()
            .expect_err("hash mismatch blocks repair");
        assert_eq!(stale.code, WikiRenameErrorCode::SourceChanged);
        assert_eq!(
            fs::read_to_string(root.join("notes/Source.md")).unwrap(),
            "[[manually changed]]\n"
        );
        assert!(root.join("archive/Target.md").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn failed_write_restores_markdown_and_primary_move() {
        let root = temp_vault();
        write(&root, "notes/A.md", "[[notes/Target]]\n");
        write(&root, "notes/B.md", "[[notes/Target]]\n");
        write(&root, "notes/Target.md", "# Target\n");
        let index = snapshot(&root);
        let transaction =
            WikiRenameTransaction::plan(&root, &index, "notes/Target.md", "archive/Target.md")
                .expect("plan");

        let error = transaction
            .execute_inner(|| Ok(()), Some(1))
            .expect_err("write should fail");
        assert_eq!(
            error.code,
            WikiRenameErrorCode::WriteFailed,
            "{}",
            error.message
        );
        assert_eq!(error.rollback, WikiRenameRollback::Completed);
        assert_eq!(
            fs::read_to_string(root.join("notes/A.md")).unwrap(),
            "[[notes/Target]]\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("notes/B.md")).unwrap(),
            "[[notes/Target]]\n"
        );
        assert!(root.join("notes/Target.md").exists());
        assert!(!root.join("archive/Target.md").exists());
        let _ = fs::remove_dir_all(root);
    }
}
