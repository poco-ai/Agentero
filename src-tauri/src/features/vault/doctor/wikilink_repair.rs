//! Deterministic wikilink repair planning and conservative multi-file apply.
//!
//! Agent-layer suggestions are validated on the same apply path: the frontend
//! (or CLI) supplies a replacement for a residual range; Host only checks that
//! the expected bytes still match and that the rewrite is in-bounds.

use crate::features::wiki::index::WikiIndex;
use crate::features::wiki::models::{
    InternalLinkSyntax, LinkFragment, LinkResolutionStatus, ResolvedLink, SourceRange,
};
use crate::features::wiki::rename::content_hash;
use crate::features::wiki::resolve::{heading_path_ends_with, normalize_rel};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use uuid::Uuid;

use super::DoctorRepairError;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WikilinkRepairLayer {
    Deterministic,
    /// Probe located the edit span but has no safe auto fix — user can type one.
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WikilinkEditKind {
    Target,
    Fragment,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikilinkRepairSuggestion {
    pub id: String,
    pub source: String,
    pub line: u32,
    pub status: LinkResolutionStatus,
    pub syntax: InternalLinkSyntax,
    pub embed: bool,
    pub target_raw: String,
    pub suggested_replacement: String,
    pub edit_kind: WikilinkEditKind,
    pub range_start: usize,
    pub range_end: usize,
    pub expected: String,
    pub expected_hash: String,
    /// Text on the same source line before the edit span (for git-style display).
    #[serde(default)]
    pub line_prefix: String,
    /// Text on the same source line after the edit span.
    #[serde(default)]
    pub line_suffix: String,
    pub layer: WikilinkRepairLayer,
    pub reason: String,
    pub selected_by_default: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub candidates: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikilinkRepairResidual {
    pub id: String,
    pub source: String,
    pub line: u32,
    pub status: LinkResolutionStatus,
    pub syntax: InternalLinkSyntax,
    pub embed: bool,
    pub target_raw: String,
    pub edit_kind: WikilinkEditKind,
    pub range_start: usize,
    pub range_end: usize,
    pub expected: String,
    pub expected_hash: String,
    #[serde(default)]
    pub line_prefix: String,
    #[serde(default)]
    pub line_suffix: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub candidates: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_path: Option<String>,
    /// Compact document index for agent prompts (path + aliases + headings).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub vault_hints: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikilinkRepairPlan {
    pub suggestions: Vec<WikilinkRepairSuggestion>,
    pub residuals: Vec<WikilinkRepairResidual>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikilinkRepairChange {
    pub source: String,
    pub range_start: usize,
    pub range_end: usize,
    pub expected: String,
    pub replacement: String,
    pub expected_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikilinkRepairResult {
    pub updated_paths: Vec<String>,
}

fn normalize_key(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn stem_of(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(path)
        .to_string()
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
        .filter_map(|component| match component {
            Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>();
    let target_parts = Path::new(target)
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => value.to_str(),
            _ => None,
        })
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

fn replacement_target(
    syntax: &InternalLinkSyntax,
    target_raw: &str,
    source: &str,
    final_target: &str,
) -> String {
    if target_raw.is_empty() && source == final_target {
        return String::new();
    }
    match syntax {
        InternalLinkSyntax::Wikilink => strip_markdown_extension(final_target).to_string(),
        InternalLinkSyntax::Markdown => markdown_relative_target(source, final_target),
    }
}

fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut curr = vec![0; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        curr[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = if ca == cb { 0 } else { 1 };
            curr[j + 1] = (prev[j + 1] + 1).min(curr[j] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[b.len()]
}

fn unique_best(scored: Vec<(String, i32)>) -> Option<String> {
    if scored.is_empty() {
        return None;
    }
    let mut scored = scored;
    scored.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    let best_score = scored[0].1;
    if best_score < 40 {
        return None;
    }
    let winners = scored
        .iter()
        .filter(|(_, score)| *score == best_score)
        .map(|(path, _)| path.clone())
        .collect::<Vec<_>>();
    if winners.len() == 1 {
        Some(winners.into_iter().next().unwrap())
    } else {
        None
    }
}

fn score_document_match(raw: &str, path: &str, aliases: &[String]) -> i32 {
    let raw_key = normalize_key(raw);
    let path_key = normalize_key(path);
    let stem = normalize_key(&stem_of(path));
    let raw_stem = normalize_key(&stem_of(raw));
    let mut best = 0;
    if path_key == raw_key || stem == raw_key {
        return 100;
    }
    if aliases.iter().any(|alias| normalize_key(alias) == raw_key) {
        return 95;
    }
    for alias in aliases {
        let alias_key = normalize_key(alias);
        let distance = levenshtein(&alias_key, &raw_key);
        // Allow a few typos in long titles (Attention / Attentoin).
        let max_distance = (alias_key.chars().count() / 8).clamp(1, 4);
        if distance > 0 && distance <= max_distance {
            best = best.max(90 - distance as i32 * 5);
        }
    }
    if path_key.ends_with(&format!("/{raw_key}"))
        || path_key.ends_with(&format!("/{raw_key}.md"))
        || strip_markdown_extension(&path_key) == raw_key
    {
        best = best.max(90);
    }
    if !raw_stem.is_empty() && stem == raw_stem {
        best = best.max(85);
    }
    if !raw_stem.is_empty() && stem.contains(&raw_stem) {
        best = best.max(70);
    }
    if !raw_key.is_empty() && path_key.contains(&raw_key) {
        best = best.max(60);
    }
    let distance = levenshtein(&raw_stem, &stem);
    if !raw_stem.is_empty() && distance <= 2 {
        best = best.max(55 - distance as i32 * 5);
    }
    best
}

fn pick_document_path(link: &ResolvedLink, index: &WikiIndex) -> Option<String> {
    if let Some(path) = &link.target_path {
        return Some(path.clone());
    }
    if link.candidates.len() == 1 {
        return Some(link.candidates[0].clone());
    }
    if !link.candidates.is_empty() {
        let scored = link
            .candidates
            .iter()
            .map(|path| {
                let aliases = index
                    .documents()
                    .iter()
                    .find(|document| document.path == *path)
                    .map(|document| document.aliases.as_slice())
                    .unwrap_or(&[]);
                (
                    path.clone(),
                    score_document_match(&link.occurrence.target_raw, path, aliases),
                )
            })
            .collect::<Vec<_>>();
        return unique_best(scored);
    }
    let scored = index
        .documents()
        .iter()
        .map(|document| {
            (
                document.path.clone(),
                score_document_match(
                    &link.occurrence.target_raw,
                    &document.path,
                    &document.aliases,
                ),
            )
        })
        .filter(|(_, score)| *score > 0)
        .collect::<Vec<_>>();
    unique_best(scored)
}

fn pick_heading_fragment(
    raw_path: &[String],
    document_path: &str,
    index: &WikiIndex,
) -> Option<String> {
    let document = index
        .documents()
        .iter()
        .find(|document| document.path == document_path)?;
    if raw_path.is_empty() {
        return None;
    }
    let wanted_last = normalize_key(raw_path.last()?);
    let suffix_len = raw_path.len();
    let mut scored = Vec::new();
    for heading in &document.headings {
        if heading.path.len() < suffix_len {
            continue;
        }
        // Keep the same number of path segments the author wrote after `#`.
        let suffix = &heading.path[heading.path.len() - suffix_len..];
        let label = suffix.join("#");
        let last = normalize_key(suffix.last().map(String::as_str).unwrap_or(""));
        let mut score = 0;
        if last == wanted_last {
            score = 100;
        } else if last.contains(&wanted_last) || wanted_last.contains(&last) {
            score = 70;
        } else {
            let distance = levenshtein(&last, &wanted_last);
            if distance <= 2 {
                score = 55 - distance as i32 * 5;
            }
        }
        if raw_path.len() > 1 && heading_path_ends_with(&heading.path, raw_path) {
            score = score.max(95);
        }
        if score > 0 {
            scored.push((label, score));
        }
    }
    unique_best(scored)
}

fn file_slice(content: &str, range: &SourceRange) -> Option<String> {
    if range.start > range.end
        || range.end > content.len()
        || !content.is_char_boundary(range.start)
        || !content.is_char_boundary(range.end)
    {
        return None;
    }
    Some(content[range.start..range.end].to_string())
}

/// Split the source line that contains `range` into prefix / suffix around the span.
fn line_affixes(content: &str, range: &SourceRange) -> (String, String) {
    if range.start > content.len()
        || range.end > content.len()
        || range.start > range.end
        || !content.is_char_boundary(range.start)
        || !content.is_char_boundary(range.end)
    {
        return (String::new(), String::new());
    }
    let line_start = content[..range.start]
        .rfind('\n')
        .map(|index| index + 1)
        .unwrap_or(0);
    let line_end = content[range.end..]
        .find('\n')
        .map(|index| range.end + index)
        .unwrap_or(content.len());
    let prefix = content[line_start..range.start]
        .trim_end_matches('\r')
        .to_string();
    let suffix = content[range.end..line_end]
        .trim_end_matches('\r')
        .to_string();
    (prefix, suffix)
}

struct ManualCandidateArgs<'a> {
    link: &'a crate::features::wiki::models::ResolvedLink,
    content: &'a str,
    hash: &'a str,
    range: &'a SourceRange,
    edit_kind: WikilinkEditKind,
    target_path: Option<String>,
    vault_hints: &'a [String],
}

/// Always produce a manual (editable) suggestion + residual when auto-fix fails.
fn push_manual_candidate(
    suggestions: &mut Vec<WikilinkRepairSuggestion>,
    residuals: &mut Vec<WikilinkRepairResidual>,
    args: ManualCandidateArgs<'_>,
) {
    let ManualCandidateArgs {
        link,
        content,
        hash,
        range,
        edit_kind,
        target_path,
        vault_hints,
    } = args;
    let expected = match file_slice(content, range) {
        Some(value) => value,
        None => link.occurrence.target_raw.clone(),
    };
    let (line_prefix, line_suffix) = line_affixes(content, range);
    let id = Uuid::new_v4().to_string();
    suggestions.push(WikilinkRepairSuggestion {
        id: id.clone(),
        source: link.occurrence.source.clone(),
        line: link.occurrence.line,
        status: link.status.clone(),
        syntax: link.occurrence.syntax.clone(),
        embed: link.occurrence.embed,
        target_raw: link.occurrence.target_raw.clone(),
        // Prefill with current text so the full line renders; user edits the green span.
        suggested_replacement: expected.clone(),
        edit_kind: edit_kind.clone(),
        range_start: range.start,
        range_end: range.end,
        expected: expected.clone(),
        expected_hash: hash.to_string(),
        line_prefix: line_prefix.clone(),
        line_suffix: line_suffix.clone(),
        layer: WikilinkRepairLayer::Manual,
        reason: "manual edit required".into(),
        selected_by_default: false,
        candidates: link.candidates.clone(),
        context: link.occurrence.context.clone(),
    });
    residuals.push(WikilinkRepairResidual {
        id,
        source: link.occurrence.source.clone(),
        line: link.occurrence.line,
        status: link.status.clone(),
        syntax: link.occurrence.syntax.clone(),
        embed: link.occurrence.embed,
        target_raw: link.occurrence.target_raw.clone(),
        edit_kind,
        range_start: range.start,
        range_end: range.end,
        expected,
        expected_hash: hash.to_string(),
        line_prefix,
        line_suffix,
        candidates: link.candidates.clone(),
        context: link.occurrence.context.clone(),
        target_path,
        vault_hints: vault_hints.to_vec(),
    });
}

fn vault_hints(index: &WikiIndex, limit: usize) -> Vec<String> {
    let mut hints = index
        .documents()
        .iter()
        .map(|document| {
            let aliases = if document.aliases.is_empty() {
                String::new()
            } else {
                format!(" | aliases: {}", document.aliases.join(", "))
            };
            let headings = document
                .headings
                .iter()
                .take(8)
                .map(|heading| heading.path.join("#"))
                .collect::<Vec<_>>()
                .join(", ");
            let heading_part = if headings.is_empty() {
                String::new()
            } else {
                format!(" | headings: {headings}")
            };
            format!("{}{aliases}{heading_part}", document.path)
        })
        .collect::<Vec<_>>();
    hints.sort();
    hints.truncate(limit);
    hints
}

fn read_source_cache(
    vault: &Path,
    path: &str,
    cache: &mut HashMap<String, (String, String)>,
) -> Result<(String, String), DoctorRepairError> {
    if let Some(entry) = cache.get(path) {
        return Ok(entry.clone());
    }
    let absolute = vault.join(path);
    let content = fs::read_to_string(&absolute).map_err(|error| {
        DoctorRepairError::new(
            "readFailed",
            format!("could not read {path}: {error}"),
            vec![path.to_string()],
        )
    })?;
    let hash = content_hash(&content);
    cache.insert(path.to_string(), (content.clone(), hash.clone()));
    Ok((content, hash))
}

/// Build deterministic suggestions and residuals for Agent / manual review.
pub fn plan_wikilink_repairs(vault: &Path) -> Result<WikilinkRepairPlan, DoctorRepairError> {
    if let Err(e) = crate::core::fs::ensure_vault_dir(vault) {
        return Err(DoctorRepairError::new(
            "invalidVault",
            e.to_string(),
            Vec::new(),
        ));
    }
    let mut index = WikiIndex::default();
    index
        .rebuild_read_only(&vault.to_string_lossy())
        .map_err(|error| DoctorRepairError::new("wikiIndexFailed", error, Vec::new()))?;

    let hints = vault_hints(&index, 80);
    let mut source_cache = HashMap::new();
    let mut suggestions = Vec::new();
    let mut residuals = Vec::new();

    let mut edges = index.edges.clone();
    edges.sort_by(|left, right| {
        left.occurrence
            .source
            .cmp(&right.occurrence.source)
            .then(left.occurrence.line.cmp(&right.occurrence.line))
            .then(left.occurrence.target_raw.cmp(&right.occurrence.target_raw))
    });

    for link in edges {
        if link.status == LinkResolutionStatus::Resolved {
            continue;
        }
        // Annotation fragments are not Markdown rewrites Doctor can safely invent.
        if matches!(
            link.occurrence.fragment,
            Some(LinkFragment::Annotation { .. })
        ) {
            continue;
        }

        let (content, hash) =
            match read_source_cache(vault, &link.occurrence.source, &mut source_cache) {
                Ok(value) => value,
                Err(_) => continue,
            };

        // Path-level repair when the document itself is missing/ambiguous.
        if matches!(
            link.status,
            LinkResolutionStatus::Missing | LinkResolutionStatus::Ambiguous
        ) && link.target_path.is_none()
        {
            let range = &link.occurrence.source_range;
            if let Some(path) = pick_document_path(&link, &index) {
                let expected = file_slice(&content, range)
                    .unwrap_or_else(|| link.occurrence.target_raw.clone());
                let replacement = replacement_target(
                    &link.occurrence.syntax,
                    &link.occurrence.target_raw,
                    &link.occurrence.source,
                    &path,
                );
                if !replacement.is_empty() && replacement != expected {
                    let (line_prefix, line_suffix) = line_affixes(&content, range);
                    suggestions.push(WikilinkRepairSuggestion {
                        id: Uuid::new_v4().to_string(),
                        source: link.occurrence.source.clone(),
                        line: link.occurrence.line,
                        status: link.status.clone(),
                        syntax: link.occurrence.syntax.clone(),
                        embed: link.occurrence.embed,
                        target_raw: link.occurrence.target_raw.clone(),
                        suggested_replacement: replacement,
                        edit_kind: WikilinkEditKind::Target,
                        range_start: range.start,
                        range_end: range.end,
                        expected,
                        expected_hash: hash.clone(),
                        line_prefix,
                        line_suffix,
                        layer: WikilinkRepairLayer::Deterministic,
                        reason: format!("unique document match → {path}"),
                        selected_by_default: true,
                        candidates: link.candidates.clone(),
                        context: link.occurrence.context.clone(),
                    });
                    continue;
                }
            }
            // No unique auto fix: still surface an editable candidate.
            push_manual_candidate(
                &mut suggestions,
                &mut residuals,
                ManualCandidateArgs {
                    link: &link,
                    content: &content,
                    hash: &hash,
                    range,
                    edit_kind: WikilinkEditKind::Target,
                    target_path: None,
                    vault_hints: &hints,
                },
            );
            continue;
        }

        // Fragment-level repair when the document resolved but the anchor did not.
        if matches!(
            link.status,
            LinkResolutionStatus::InvalidFragment | LinkResolutionStatus::Ambiguous
        ) {
            let Some(target_path) = link.target_path.clone() else {
                continue;
            };
            let Some(fragment) = link.occurrence.fragment.clone() else {
                continue;
            };
            let Some(fragment_range) = link.occurrence.fragment_range.clone() else {
                // Fall back to target range so the user still gets an editable row.
                push_manual_candidate(
                    &mut suggestions,
                    &mut residuals,
                    ManualCandidateArgs {
                        link: &link,
                        content: &content,
                        hash: &hash,
                        range: &link.occurrence.source_range,
                        edit_kind: WikilinkEditKind::Target,
                        target_path: Some(target_path),
                        vault_hints: &hints,
                    },
                );
                continue;
            };
            if let Some(label) = match &fragment {
                LinkFragment::Heading { path } => pick_heading_fragment(path, &target_path, &index),
                LinkFragment::Block { id } => {
                    let document = index
                        .documents()
                        .iter()
                        .find(|document| document.path == target_path);
                    document.and_then(|document| {
                        let scored = document
                            .blocks
                            .iter()
                            .map(|block| {
                                let distance =
                                    levenshtein(&normalize_key(id), &normalize_key(&block.id));
                                let score = if normalize_key(&block.id) == normalize_key(id) {
                                    100
                                } else if distance <= 2 {
                                    55 - distance as i32 * 5
                                } else {
                                    0
                                };
                                (block.id.clone(), score)
                            })
                            .filter(|(_, score)| *score > 0)
                            .collect::<Vec<_>>();
                        unique_best(scored)
                    })
                }
                LinkFragment::Annotation { .. } => None,
            } {
                let expected = file_slice(&content, &fragment_range)
                    .unwrap_or_else(|| link.occurrence.target_raw.clone());
                if !label.is_empty() && label != expected {
                    let (line_prefix, line_suffix) = line_affixes(&content, &fragment_range);
                    suggestions.push(WikilinkRepairSuggestion {
                        id: Uuid::new_v4().to_string(),
                        source: link.occurrence.source.clone(),
                        line: link.occurrence.line,
                        status: link.status.clone(),
                        syntax: link.occurrence.syntax.clone(),
                        embed: link.occurrence.embed,
                        target_raw: link.occurrence.target_raw.clone(),
                        suggested_replacement: label,
                        edit_kind: WikilinkEditKind::Fragment,
                        range_start: fragment_range.start,
                        range_end: fragment_range.end,
                        expected,
                        expected_hash: hash.clone(),
                        line_prefix,
                        line_suffix,
                        layer: WikilinkRepairLayer::Deterministic,
                        reason: format!("unique anchor on {target_path}"),
                        selected_by_default: true,
                        candidates: link.candidates.clone(),
                        context: link.occurrence.context.clone(),
                    });
                    continue;
                }
            }
            push_manual_candidate(
                &mut suggestions,
                &mut residuals,
                ManualCandidateArgs {
                    link: &link,
                    content: &content,
                    hash: &hash,
                    range: &fragment_range,
                    edit_kind: WikilinkEditKind::Fragment,
                    target_path: Some(target_path),
                    vault_hints: &hints,
                },
            );
        }
    }

    Ok(WikilinkRepairPlan {
        suggestions,
        residuals,
    })
}

fn write_note_bytes(path: &Path, contents: &[u8]) -> Result<(), String> {
    fs::write(path, contents).map_err(|error| error.to_string())
}

fn safe_relative_path(raw: &str) -> bool {
    let path = Path::new(raw);
    !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

struct PlannedWikilinkWrite {
    path: String,
    absolute: PathBuf,
    original: String,
    rewritten: String,
}

/// Apply selected wikilink byte-range edits with dirty/hash checks and rollback.
pub fn apply_wikilink_repairs(
    vault: &Path,
    changes: &[WikilinkRepairChange],
    dirty_paths: &[String],
) -> Result<WikilinkRepairResult, DoctorRepairError> {
    if let Err(e) = crate::core::fs::ensure_vault_dir(vault) {
        return Err(DoctorRepairError::new(
            "invalidVault",
            e.to_string(),
            Vec::new(),
        ));
    }
    if changes.is_empty() {
        return Ok(WikilinkRepairResult {
            updated_paths: Vec::new(),
        });
    }

    let dirty = dirty_paths
        .iter()
        .map(|path| path.replace('\\', "/").trim_matches('/').to_string())
        .collect::<HashSet<_>>();

    // Group edits by source path.
    let mut by_source: HashMap<String, Vec<&WikilinkRepairChange>> = HashMap::new();
    for change in changes {
        let path = normalize_rel(&change.source.replace('\\', "/"));
        if !safe_relative_path(&path) {
            return Err(DoctorRepairError::new(
                "invalidPath",
                format!("invalid source path: {path}"),
                vec![path],
            ));
        }
        if dirty.contains(&path) {
            return Err(DoctorRepairError::new(
                "dirtyPath",
                format!("source has unsaved edits: {path}"),
                vec![path],
            ));
        }
        by_source.entry(path).or_default().push(change);
    }

    let mut planned = Vec::new();
    for (path, edits) in by_source {
        let absolute = vault.join(&path);
        let original = fs::read_to_string(&absolute).map_err(|error| {
            DoctorRepairError::new(
                "readFailed",
                format!("could not read {path}: {error}"),
                vec![path.clone()],
            )
        })?;
        let hash = content_hash(&original);
        if edits.iter().any(|edit| edit.expected_hash != hash) {
            return Err(DoctorRepairError::new(
                "sourceChanged",
                format!("source changed after diagnosis: {path}"),
                vec![path],
            ));
        }
        let mut ordered = edits
            .iter()
            .map(|edit| {
                (
                    edit.range_start,
                    edit.range_end,
                    edit.expected.as_str(),
                    edit.replacement.as_str(),
                )
            })
            .collect::<Vec<_>>();
        ordered.sort_by_key(|(start, _, _, _)| std::cmp::Reverse(*start));
        if ordered.iter().any(|(start, end, expected, _)| {
            *start > *end
                || *end > original.len()
                || !original.is_char_boundary(*start)
                || !original.is_char_boundary(*end)
                || original.get(*start..*end) != Some(*expected)
        }) || ordered.windows(2).any(|pair| pair[0].0 < pair[1].1)
        {
            return Err(DoctorRepairError::new(
                "overlappingEdits",
                format!("planned edits overlap or exceed bounds in {path}"),
                vec![path],
            ));
        }
        let mut rewritten = original.clone();
        for (start, end, _, replacement) in ordered {
            rewritten.replace_range(start..end, replacement);
        }
        planned.push(PlannedWikilinkWrite {
            path,
            absolute,
            original,
            rewritten,
        });
    }

    for write in &planned {
        let current = fs::read_to_string(&write.absolute).map_err(|error| {
            DoctorRepairError::new(
                "readFailed",
                format!("could not re-read {}: {error}", write.path),
                vec![write.path.clone()],
            )
        })?;
        if current != write.original {
            return Err(DoctorRepairError::new(
                "sourceChanged",
                format!("source changed after preflight: {}", write.path),
                vec![write.path.clone()],
            ));
        }
    }

    let mut written: Vec<&PlannedWikilinkWrite> = Vec::new();
    for write in &planned {
        if let Err(error) = write_note_bytes(&write.absolute, write.rewritten.as_bytes()) {
            let mut rollback_complete = true;
            for previous in written.iter().rev() {
                if write_note_bytes(&previous.absolute, previous.original.as_bytes()).is_err() {
                    rollback_complete = false;
                }
            }
            let mut failure = DoctorRepairError::new(
                "writeFailed",
                format!("could not write {}: {error}", write.path),
                planned.iter().map(|item| item.path.clone()).collect(),
            );
            failure.rollback = if rollback_complete {
                "completed"
            } else {
                "manualRecoveryRequired"
            }
            .into();
            return Err(failure);
        }
        written.push(write);
    }

    Ok(WikilinkRepairResult {
        updated_paths: planned.into_iter().map(|write| write.path).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::wiki::index::WikiIndex;
    use uuid::Uuid;

    fn write(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    #[test]
    fn deterministic_plan_fixes_missing_path_and_heading() {
        let vault = std::env::temp_dir().join(format!("agentero-wiki-doctor-{}", Uuid::new_v4()));
        write(
            &vault.join("notes/Source.md"),
            "See [[Attentoin Is All You Need]] and [[papers/demo/NOTES#Methd]].\n",
        );
        write(
            &vault.join("papers/demo/NOTES.md"),
            "---\naliases:\n  - \"Attention Is All You Need\"\n  - \"AIAYN\"\n---\n# Paper\n\n## Method\n\nBody.\n",
        );
        write(&vault.join("notes/Keep.md"), "# Keep\n");

        let plan = plan_wikilink_repairs(&vault).expect("plan");
        assert!(
            plan.suggestions
                .iter()
                .any(|item| item.target_raw.contains("Attentoin")
                    && item.suggested_replacement.contains("papers/demo/NOTES")
                    || item.suggested_replacement.contains("Attention")),
            "missing alias/path should produce a suggestion: {:?}",
            plan.suggestions
        );
        assert!(
            plan.suggestions.iter().any(|item| {
                matches!(item.edit_kind, WikilinkEditKind::Fragment)
                    && item.suggested_replacement.contains("Method")
            }),
            "heading typo should produce fragment suggestion: {:?}",
            plan.suggestions
        );

        let changes = plan
            .suggestions
            .iter()
            .map(|item| WikilinkRepairChange {
                source: item.source.clone(),
                range_start: item.range_start,
                range_end: item.range_end,
                expected: item.expected.clone(),
                replacement: item.suggested_replacement.clone(),
                expected_hash: item.expected_hash.clone(),
            })
            .collect::<Vec<_>>();
        let result = apply_wikilink_repairs(&vault, &changes, &[]).expect("apply");
        assert_eq!(result.updated_paths, vec!["notes/Source.md".to_string()]);

        let mut index = WikiIndex::default();
        index
            .rebuild_read_only(&vault.to_string_lossy())
            .expect("rebuild");
        let report = index.check_links(&vault.to_string_lossy(), Some("notes/Source.md"));
        assert!(
            report.issues.is_empty(),
            "source should be clean after repair: {:?}",
            report.issues
        );
        let _ = fs::remove_dir_all(vault);
    }
}
