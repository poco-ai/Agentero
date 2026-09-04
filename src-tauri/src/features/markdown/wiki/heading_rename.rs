//! Explicit heading rename transactions.
//!
//! A normal Markdown save never enters this module. The caller must provide the
//! exact saved document snapshot plus a heading path and line, making the
//! cross-file rewrite an explicit and reviewable user action.

use crate::features::wiki::extract::{extract_document, parse_heading_source};
use crate::features::wiki::index::WikiIndex;
use crate::features::wiki::models::{
    LinkFragment, LinkResolutionStatus, SourceRange, WikiRenameErrorCode, WikiRenameHeadingResult,
    WikiRenameRollback,
};
use crate::features::wiki::rename::{
    atomic_write, content_hash, normalize_vault_path, WikiRenameError,
};
use crate::features::wiki::resolve::{fragment_anchors, FragmentAnchor};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
struct PlannedEdit {
    range: SourceRange,
    expected: String,
    replacement: String,
}

#[derive(Debug, Clone)]
struct PlannedSource {
    path: String,
    original_content: String,
    original_hash: String,
    edits: Vec<PlannedEdit>,
}

#[derive(Debug, Clone)]
pub(crate) struct WikiHeadingRenameTransaction {
    vault_root: PathBuf,
    path: String,
    old_path: Vec<String>,
    new_path: Vec<String>,
    sources: Vec<PlannedSource>,
}

impl WikiHeadingRenameTransaction {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn plan(
        vault_root: &Path,
        index: &WikiIndex,
        path: &str,
        heading_path: &[String],
        heading_line: u32,
        expected_content: &str,
        new_text: &str,
        dirty_paths: &[String],
    ) -> Result<Self, WikiRenameError> {
        crate::core::fs::ensure_vault_dir(vault_root)
            .map_err(|e| WikiRenameError::new(WikiRenameErrorCode::InvalidPath, e.to_string()))?;
        if index.vault_path.as_deref() != vault_root.to_str() {
            return Err(WikiRenameError::new(
                WikiRenameErrorCode::IndexStale,
                "wiki index does not describe this vault",
            ));
        }

        let path = normalize_vault_path(path)?;
        let new_text = new_text.trim();
        if new_text.is_empty() || new_text.contains('\r') || new_text.contains('\n') {
            return Err(WikiRenameError::new(
                WikiRenameErrorCode::InvalidHeading,
                "heading text must be one non-empty line",
            ));
        }
        if heading_path.is_empty() {
            return Err(WikiRenameError::new(
                WikiRenameErrorCode::HeadingMissing,
                "heading path is required",
            ));
        }

        let target_abs = vault_root.join(&path);
        let current_content = fs::read_to_string(&target_abs).map_err(|error| {
            WikiRenameError::new(
                WikiRenameErrorCode::SourceChanged,
                format!("could not read heading target {path}: {error}"),
            )
        })?;
        if current_content != expected_content {
            return Err(WikiRenameError::new(
                WikiRenameErrorCode::SourceChanged,
                "heading target changed after the editor snapshot",
            ));
        }

        let document = index.document(&path).ok_or_else(|| {
            WikiRenameError::new(
                WikiRenameErrorCode::HeadingMissing,
                "heading target is not present in the wiki index",
            )
        })?;
        let matching = document
            .headings
            .iter()
            .filter(|heading| heading.line == heading_line && heading.path == heading_path)
            .collect::<Vec<_>>();
        let [heading] = matching.as_slice() else {
            return Err(WikiRenameError::new(
                WikiRenameErrorCode::HeadingMissing,
                "heading identity no longer matches path and line",
            ));
        };
        if heading.text == new_text {
            return Err(WikiRenameError::new(
                WikiRenameErrorCode::InvalidHeading,
                "new heading text is unchanged",
            ));
        }
        if fragment_anchors(
            document,
            &LinkFragment::Heading {
                path: heading.path.clone(),
            },
        )
        .len()
            != 1
        {
            return Err(WikiRenameError::new(
                WikiRenameErrorCode::AmbiguousHeading,
                "heading path is not a unique link target",
            ));
        }

        let heading_range = heading_range_at(expected_content, heading_line).ok_or_else(|| {
            WikiRenameError::new(
                WikiRenameErrorCode::HeadingMissing,
                "heading line is no longer an ATX heading",
            )
        })?;
        if expected_content.get(heading_range.start..heading_range.end)
            != Some(heading.text.as_str())
        {
            return Err(WikiRenameError::new(
                WikiRenameErrorCode::SourceChanged,
                "heading text no longer matches the indexed anchor",
            ));
        }

        let mut new_path = heading.path.clone();
        let Some(last) = new_path.last_mut() else {
            return Err(WikiRenameError::new(
                WikiRenameErrorCode::HeadingMissing,
                "heading path is empty",
            ));
        };
        *last = new_text.to_string();

        let heading_edit = PlannedEdit {
            expected: heading.text.clone(),
            replacement: new_text.to_string(),
            range: heading_range,
        };
        let heading_only_content =
            apply_edits(expected_content, std::slice::from_ref(&heading_edit));
        let (new_document, _) = extract_document(&path, &heading_only_content);
        let new_identity_matches = new_document
            .headings
            .iter()
            .filter(|candidate| candidate.line == heading_line && candidate.path == new_path)
            .count();
        if new_identity_matches != 1 {
            return Err(WikiRenameError::new(
                WikiRenameErrorCode::InvalidHeading,
                "new heading text does not produce the expected Markdown anchor",
            ));
        }
        if fragment_anchors(
            &new_document,
            &LinkFragment::Heading {
                path: new_path.clone(),
            },
        )
        .len()
            != 1
        {
            return Err(WikiRenameError::new(
                WikiRenameErrorCode::AmbiguousHeading,
                "new heading path would be ambiguous",
            ));
        }

        reject_affected_unresolved_links(index, &path, &heading.path)?;

        let mut edits_by_source: BTreeMap<String, Vec<PlannedEdit>> = BTreeMap::new();
        edits_by_source
            .entry(path.clone())
            .or_default()
            .push(heading_edit);

        for edge in &index.edges {
            if edge.status != LinkResolutionStatus::Resolved
                || edge.target_path.as_deref() != Some(path.as_str())
            {
                continue;
            }
            let Some(LinkFragment::Heading {
                path: fragment_path,
            }) = edge.occurrence.fragment.as_ref()
            else {
                continue;
            };
            let anchors = fragment_anchors(
                document,
                edge.occurrence.fragment.as_ref().expect("heading"),
            );
            let [FragmentAnchor::Heading(actual_heading)] = anchors.as_slice() else {
                continue;
            };
            if !path_is_at_or_under(&actual_heading.path, &heading.path) {
                continue;
            }

            let fragment_start = actual_heading.path.len() - fragment_path.len();
            let renamed_index = heading.path.len().saturating_sub(1);
            if renamed_index < fragment_start {
                // The suffix reference omitted the renamed ancestor, so its
                // persisted text remains valid after the parent rename.
                continue;
            }
            let mut replacement_path = fragment_path.clone();
            replacement_path[renamed_index - fragment_start] = new_text.to_string();
            let replacement = replacement_path.join("#");
            let candidate_fragment = LinkFragment::Heading {
                path: replacement_path,
            };
            if fragment_anchors(&new_document, &candidate_fragment).len() != 1 {
                return Err(WikiRenameError::new(
                    WikiRenameErrorCode::AmbiguousHeading,
                    "rewritten heading fragment would not resolve uniquely",
                ));
            }
            let range = edge.occurrence.fragment_range.clone().ok_or_else(|| {
                WikiRenameError::new(
                    WikiRenameErrorCode::OverlappingEdits,
                    "resolved heading reference has no fragment range",
                )
            })?;
            edits_by_source
                .entry(edge.occurrence.source.clone())
                .or_default()
                .push(PlannedEdit {
                    range,
                    expected: String::new(),
                    replacement,
                });
        }

        let dirty = dirty_paths
            .iter()
            .map(|candidate| normalize_vault_path(candidate))
            .collect::<Result<BTreeSet<_>, _>>()?;
        let affected_dirty = edits_by_source
            .keys()
            .filter(|source| dirty.contains(*source))
            .cloned()
            .collect::<Vec<_>>();
        if !affected_dirty.is_empty() {
            return Err(WikiRenameError::new(
                WikiRenameErrorCode::UnsavedEdits,
                "unsaved editor changes block heading rename",
            )
            .with_paths(affected_dirty));
        }

        let mut sources = Vec::new();
        for (source_path, mut edits) in edits_by_source {
            let original_content = if source_path == path {
                expected_content.to_string()
            } else {
                fs::read_to_string(vault_root.join(&source_path)).map_err(|error| {
                    WikiRenameError::new(
                        WikiRenameErrorCode::SourceChanged,
                        format!("could not read heading reference source {source_path}: {error}"),
                    )
                })?
            };
            for edit in &mut edits {
                if edit.expected.is_empty() {
                    edit.expected = original_content
                        .get(edit.range.start..edit.range.end)
                        .ok_or_else(|| {
                            WikiRenameError::new(
                                WikiRenameErrorCode::OverlappingEdits,
                                format!("fragment range exceeds source bounds in {source_path}"),
                            )
                        })?
                        .to_string();
                }
            }
            validate_edits(&source_path, &original_content, &mut edits)?;
            sources.push(PlannedSource {
                path: source_path,
                original_hash: content_hash(&original_content),
                original_content,
                edits,
            });
        }

        Ok(Self {
            vault_root: vault_root.to_path_buf(),
            path,
            old_path: heading.path.clone(),
            new_path,
            sources,
        })
    }

    pub(crate) fn execute(
        &self,
        index: &mut WikiIndex,
        fail_write_at: Option<usize>,
        fail_rebuild: bool,
    ) -> Result<WikiRenameHeadingResult, WikiRenameError> {
        self.verify_sources_unchanged()?;
        let mut written: Vec<&PlannedSource> = Vec::new();
        for (write_index, source) in self.sources.iter().enumerate() {
            if fail_write_at == Some(write_index) {
                let rollback = self.rollback(&written, index);
                return Err(WikiRenameError::after_mutation(
                    WikiRenameErrorCode::WriteFailed,
                    format!("simulated heading write failure for {}", source.path),
                    rollback,
                ));
            }
            let rewritten = apply_edits(&source.original_content, &source.edits);
            if let Err(error) =
                atomic_write(&self.vault_root.join(&source.path), rewritten.as_bytes())
            {
                let rollback = self.rollback(&written, index);
                return Err(WikiRenameError::after_mutation(
                    WikiRenameErrorCode::WriteFailed,
                    format!("could not rewrite heading source {}: {error}", source.path),
                    rollback,
                ));
            }
            written.push(source);
        }

        let vault_path = self.vault_root.to_str().ok_or_else(|| {
            WikiRenameError::new(
                WikiRenameErrorCode::InvalidPath,
                "vault path is not valid UTF-8",
            )
        })?;
        let rebuild = if fail_rebuild {
            Err("simulated wiki index rebuild failure".to_string())
        } else {
            index.rebuild(vault_path).map(|_| ())
        };
        if let Err(error) = rebuild {
            let rollback = self.rollback(&written, index);
            return Err(WikiRenameError::after_mutation(
                WikiRenameErrorCode::CommitFailed,
                format!("heading rename rolled back after index rebuild failed: {error}"),
                rollback,
            ));
        }

        Ok(WikiRenameHeadingResult {
            path: self.path.clone(),
            old_path: self.old_path.clone(),
            new_path: self.new_path.clone(),
            updated_sources: self
                .sources
                .iter()
                .filter(|source| source.path != self.path)
                .map(|source| source.path.clone())
                .collect(),
            rollback: WikiRenameRollback::NotNeeded,
        })
    }

    fn verify_sources_unchanged(&self) -> Result<(), WikiRenameError> {
        for source in &self.sources {
            let current =
                fs::read_to_string(self.vault_root.join(&source.path)).map_err(|error| {
                    WikiRenameError::new(
                        WikiRenameErrorCode::SourceChanged,
                        format!("could not re-read heading source {}: {error}", source.path),
                    )
                })?;
            if content_hash(&current) != source.original_hash {
                return Err(WikiRenameError::new(
                    WikiRenameErrorCode::SourceChanged,
                    format!("heading source changed: {}", source.path),
                ));
            }
        }
        Ok(())
    }

    fn rollback(&self, written: &[&PlannedSource], index: &mut WikiIndex) -> WikiRenameRollback {
        if written.is_empty() {
            return WikiRenameRollback::NotNeeded;
        }
        let mut complete = true;
        for source in written.iter().rev() {
            if atomic_write(
                &self.vault_root.join(&source.path),
                source.original_content.as_bytes(),
            )
            .is_err()
            {
                complete = false;
            }
        }
        if self
            .vault_root
            .to_str()
            .is_none_or(|vault_path| index.rebuild(vault_path).is_err())
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

#[allow(clippy::too_many_arguments)]
pub fn run_heading_rename_transaction(
    vault_root: &Path,
    index: &mut WikiIndex,
    path: &str,
    heading_path: &[String],
    heading_line: u32,
    expected_content: &str,
    new_text: &str,
    dirty_paths: &[String],
) -> Result<WikiRenameHeadingResult, WikiRenameError> {
    let vault_path = vault_root.to_str().ok_or_else(|| {
        WikiRenameError::new(
            WikiRenameErrorCode::InvalidPath,
            "vault path is not valid UTF-8",
        )
    })?;
    index.rebuild(vault_path).map_err(|error| {
        WikiRenameError::new(
            WikiRenameErrorCode::IndexStale,
            format!("could not build pre-rename wiki snapshot: {error}"),
        )
    })?;
    let transaction = WikiHeadingRenameTransaction::plan(
        vault_root,
        index,
        path,
        heading_path,
        heading_line,
        expected_content,
        new_text,
        dirty_paths,
    )?;
    transaction.execute(index, None, false)
}

fn reject_affected_unresolved_links(
    index: &WikiIndex,
    target_path: &str,
    old_path: &[String],
) -> Result<(), WikiRenameError> {
    let old_label = old_path.join("#");
    for edge in &index.edges {
        if edge.target_path.as_deref() != Some(target_path)
            || edge.status == LinkResolutionStatus::Resolved
        {
            continue;
        }
        let affected_candidate = edge.candidates.iter().any(|candidate| {
            candidate == &old_label || candidate.starts_with(&format!("{old_label}#"))
        });
        let affected_raw = matches!(
            &edge.occurrence.fragment,
            Some(LinkFragment::Heading { path })
                if path_may_reference_at_or_under(path, old_path)
        );
        if affected_candidate || affected_raw {
            return Err(WikiRenameError::new(
                WikiRenameErrorCode::AmbiguousHeading,
                "an affected heading reference is ambiguous or invalid",
            ));
        }
    }
    Ok(())
}

fn heading_range_at(markdown: &str, line: u32) -> Option<SourceRange> {
    let mut byte_start = 0;
    for (index, raw_line) in markdown.split_inclusive('\n').enumerate() {
        let content = raw_line
            .strip_suffix('\n')
            .unwrap_or(raw_line)
            .strip_suffix('\r')
            .unwrap_or(raw_line);
        if (index + 1) as u32 == line {
            return parse_heading_source(content, byte_start).map(|(_, _, range)| range);
        }
        byte_start += raw_line.len();
    }
    None
}

fn path_is_at_or_under(path: &[String], root: &[String]) -> bool {
    path.len() >= root.len() && path.iter().zip(root).all(|(left, right)| left == right)
}

fn path_may_reference_at_or_under(path: &[String], root: &[String]) -> bool {
    (0..root.len()).any(|start| {
        let suffix = &root[start..];
        path.len() >= suffix.len()
            && crate::features::wiki::resolve::heading_path_ends_with(&path[..suffix.len()], suffix)
    })
}

fn validate_edits(
    path: &str,
    content: &str,
    edits: &mut [PlannedEdit],
) -> Result<(), WikiRenameError> {
    edits.sort_by_key(|edit| std::cmp::Reverse(edit.range.start));
    if edits.iter().any(|edit| {
        edit.range.start > edit.range.end
            || edit.range.end > content.len()
            || !content.is_char_boundary(edit.range.start)
            || !content.is_char_boundary(edit.range.end)
            || content.get(edit.range.start..edit.range.end) != Some(edit.expected.as_str())
    }) || edits
        .windows(2)
        .any(|pair| pair[0].range.start < pair[1].range.end)
    {
        return Err(WikiRenameError::new(
            WikiRenameErrorCode::OverlappingEdits,
            format!("heading edits overlap or exceed source bounds in {path}"),
        ));
    }
    Ok(())
}

fn apply_edits(content: &str, edits: &[PlannedEdit]) -> String {
    let mut rewritten = content.to_string();
    for edit in edits {
        rewritten.replace_range(edit.range.start..edit.range.end, edit.replacement.as_str());
    }
    rewritten
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use uuid::Uuid;

    fn fixture_vault() -> PathBuf {
        let root = std::env::temp_dir().join(format!("agentero-heading-rename-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("notes")).expect("create fixture vault");
        root
    }

    fn build_index(root: &Path) -> WikiIndex {
        let mut index = WikiIndex::default();
        index
            .rebuild(root.to_str().expect("utf-8 fixture path"))
            .expect("rebuild fixture index");
        index
    }

    #[test]
    fn rewrites_resolved_heading_fragments_and_preserves_surrounding_markdown() {
        let root = fixture_vault();
        let target = "# Parent\n## Old\n[[#Old|self alias]]\n### Child\nBody\n";
        let source = "[[Target#Parent#Old|Alias]]\n![[Target#Old#Child]]\n[label](Target.md#Parent#Old)\n[[Target#Child]]\n";
        fs::write(root.join("notes/Target.md"), target).expect("write target");
        fs::write(root.join("notes/Source.md"), source).expect("write source");
        let mut index = build_index(&root);

        let result = run_heading_rename_transaction(
            &root,
            &mut index,
            "notes/Target.md",
            &["Parent".into(), "Old".into()],
            2,
            target,
            "New",
            &[],
        )
        .expect("rename heading");

        assert_eq!(result.old_path, vec!["Parent", "Old"]);
        assert_eq!(result.new_path, vec!["Parent", "New"]);
        assert_eq!(result.updated_sources, vec!["notes/Source.md"]);
        assert_eq!(
            fs::read_to_string(root.join("notes/Target.md")).expect("read target"),
            "# Parent\n## New\n[[#New|self alias]]\n### Child\nBody\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("notes/Source.md")).expect("read source"),
            "[[Target#Parent#New|Alias]]\n![[Target#New#Child]]\n[label](Target.md#Parent#New)\n[[Target#Child]]\n"
        );

        fs::remove_dir_all(root).expect("remove fixture vault");
    }

    #[test]
    fn rejects_dirty_stale_and_ambiguous_heading_renames_without_writing() {
        let root = fixture_vault();
        let target = "# Parent\n## Old\n## Taken\n";
        fs::write(root.join("notes/Target.md"), target).expect("write target");
        fs::write(root.join("notes/Source.md"), "[[Target#Parent#Old|keep]]\n")
            .expect("write source");
        let index = build_index(&root);

        let dirty = WikiHeadingRenameTransaction::plan(
            &root,
            &index,
            "notes/Target.md",
            &["Parent".into(), "Old".into()],
            2,
            target,
            "New",
            &[
                "notes/Target.md".into(),
                "notes/Unrelated.md".into(),
                "notes/Source.md".into(),
            ],
        )
        .expect_err("dirty source must block");
        assert_eq!(dirty.code, WikiRenameErrorCode::UnsavedEdits);
        assert_eq!(
            dirty.paths,
            vec!["notes/Source.md".to_string(), "notes/Target.md".to_string()]
        );

        let stale = WikiHeadingRenameTransaction::plan(
            &root,
            &index,
            "notes/Target.md",
            &["Parent".into(), "Old".into()],
            2,
            "# stale\n",
            "New",
            &[],
        )
        .expect_err("stale snapshot must block");
        assert_eq!(stale.code, WikiRenameErrorCode::SourceChanged);

        let ambiguous = WikiHeadingRenameTransaction::plan(
            &root,
            &index,
            "notes/Target.md",
            &["Parent".into(), "Old".into()],
            2,
            target,
            "Taken",
            &[],
        )
        .expect_err("ambiguous new heading must block");
        assert_eq!(ambiguous.code, WikiRenameErrorCode::AmbiguousHeading);
        assert_eq!(
            fs::read_to_string(root.join("notes/Target.md")).expect("read target"),
            target
        );

        fs::remove_dir_all(root).expect("remove fixture vault");
    }

    #[test]
    fn rejects_a_deep_suffix_rewrite_that_would_become_ambiguous() {
        let root = fixture_vault();
        let target =
            "# Root\n## Old\n### Section\n#### Leaf\n# Other\n## New\n### Section\n#### Leaf\n";
        let source = "[[Target#Old#Section#Leaf]]\n";
        fs::write(root.join("notes/Target.md"), target).expect("write target");
        fs::write(root.join("notes/Source.md"), source).expect("write source");
        let index = build_index(&root);

        let error = WikiHeadingRenameTransaction::plan(
            &root,
            &index,
            "notes/Target.md",
            &["Root".into(), "Old".into()],
            2,
            target,
            "New",
            &[],
        )
        .expect_err("ambiguous rewritten suffix must block");

        assert_eq!(error.code, WikiRenameErrorCode::AmbiguousHeading);
        assert_eq!(
            fs::read_to_string(root.join("notes/Target.md")).expect("read target"),
            target
        );
        assert_eq!(
            fs::read_to_string(root.join("notes/Source.md")).expect("read source"),
            source
        );

        fs::remove_dir_all(root).expect("remove fixture vault");
    }

    #[test]
    fn rolls_back_every_written_file_when_a_write_or_rebuild_fails() {
        let root = fixture_vault();
        let target = "# Old\n";
        let source_a = "[[Target#Old]]\n";
        let source_b = "![[Target#Old]]\n";
        fs::write(root.join("notes/Target.md"), target).expect("write target");
        fs::write(root.join("notes/A.md"), source_a).expect("write source A");
        fs::write(root.join("notes/B.md"), source_b).expect("write source B");
        let mut index = build_index(&root);
        let transaction = WikiHeadingRenameTransaction::plan(
            &root,
            &index,
            "notes/Target.md",
            &["Old".into()],
            1,
            target,
            "New",
            &[],
        )
        .expect("plan rename");

        let write_error = transaction
            .execute(&mut index, Some(1), false)
            .expect_err("simulated write must fail");
        assert_eq!(write_error.code, WikiRenameErrorCode::WriteFailed);
        assert_eq!(write_error.rollback, WikiRenameRollback::Completed);
        assert_eq!(
            fs::read_to_string(root.join("notes/A.md")).expect("read source A"),
            source_a
        );
        assert_eq!(
            fs::read_to_string(root.join("notes/B.md")).expect("read source B"),
            source_b
        );
        assert_eq!(
            fs::read_to_string(root.join("notes/Target.md")).expect("read target"),
            target
        );

        let rebuild_error = transaction
            .execute(&mut index, None, true)
            .expect_err("simulated rebuild must fail");
        assert_eq!(rebuild_error.code, WikiRenameErrorCode::CommitFailed);
        assert_eq!(rebuild_error.rollback, WikiRenameRollback::Completed);
        assert_eq!(
            fs::read_to_string(root.join("notes/Target.md")).expect("read target"),
            target
        );

        fs::remove_dir_all(root).expect("remove fixture vault");
    }
}
