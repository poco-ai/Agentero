//! Resolve parsed local-link occurrences against a rebuildable Vault document index.

use crate::features::wiki::models::{
    BlockAnchor, HeadingAnchor, InternalLinkOccurrence, InternalLinkSyntax, LinkFragment,
    LinkResolutionStatus, ResolvedLink, WikiDocument,
};
use std::collections::HashMap;
use std::path::Path;

/// Normalize a Vault-relative forward-slash path without allowing it to escape the root.
pub fn normalize_rel(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let mut parts = Vec::new();
    for component in normalized.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    parts.push("..");
                }
            }
            value => parts.push(value),
        }
    }
    parts.join("/")
}

fn normalize_key(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

pub(crate) fn heading_path_ends_with(path: &[String], suffix: &[String]) -> bool {
    !suffix.is_empty()
        && path.len() >= suffix.len()
        && path[path.len() - suffix.len()..]
            .iter()
            .zip(suffix)
            .all(|(current, wanted)| normalize_key(current) == normalize_key(wanted))
}

fn stem_of(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(path)
        .to_string()
}

fn add_extensions(value: &str) -> Vec<String> {
    let value = normalize_rel(value);
    if value.is_empty() {
        return Vec::new();
    }
    let has_markdown_extension = [".md", ".mdx", ".markdown"]
        .iter()
        .any(|extension| value.to_ascii_lowercase().ends_with(extension));
    let mut candidates = vec![value.clone()];
    if !has_markdown_extension {
        candidates.extend([
            format!("{value}.md"),
            format!("{value}.mdx"),
            format!("{value}.markdown"),
        ]);
    }
    candidates
}

fn source_relative(source: &str, target: &str) -> String {
    let parent = Path::new(source).parent().unwrap_or_else(|| Path::new(""));
    normalize_rel(&parent.join(target).to_string_lossy())
}

fn unique(mut candidates: Vec<String>) -> Result<String, Vec<String>> {
    candidates.sort();
    candidates.dedup();
    if candidates.len() == 1 {
        Ok(candidates.remove(0))
    } else {
        Err(candidates)
    }
}

/// Precomputed lookup tables over one document set.
///
/// Rebuilding the index resolves every occurrence against the same documents;
/// these maps replace the previous per-occurrence linear scans (O(E×D)) with
/// hash lookups (~O(E)) while preserving `resolve_document` semantics exactly:
/// the same priority order (exact path → case-insensitive path → path suffix →
/// stem → alias) and the same candidate lists for ambiguous results.
pub(crate) struct DocumentLookup<'a> {
    by_path: HashMap<&'a str, &'a WikiDocument>,
    by_path_lower: HashMap<String, Vec<&'a WikiDocument>>,
    /// Every segment-boundary suffix of every path, including the full path.
    /// `documents.path.ends_with("/{candidate}") || path == candidate` is
    /// exactly membership of `candidate` in this suffix set.
    by_suffix: HashMap<&'a str, Vec<&'a WikiDocument>>,
    by_stem: HashMap<String, Vec<&'a WikiDocument>>,
    by_alias: HashMap<String, Vec<&'a WikiDocument>>,
}

impl<'a> DocumentLookup<'a> {
    pub(crate) fn new(documents: &'a [WikiDocument]) -> Self {
        let mut by_path: HashMap<&str, &WikiDocument> = HashMap::with_capacity(documents.len());
        let mut by_path_lower: HashMap<String, Vec<&WikiDocument>> =
            HashMap::with_capacity(documents.len());
        let mut by_suffix: HashMap<&str, Vec<&WikiDocument>> = HashMap::new();
        let mut by_stem: HashMap<String, Vec<&WikiDocument>> =
            HashMap::with_capacity(documents.len());
        let mut by_alias: HashMap<String, Vec<&WikiDocument>> = HashMap::new();
        for document in documents {
            let path = document.path.as_str();
            by_path.entry(path).or_insert(document);
            by_path_lower
                .entry(path.to_ascii_lowercase())
                .or_default()
                .push(document);
            by_suffix.entry(path).or_default().push(document);
            let mut rest = path;
            while let Some(position) = rest.find('/') {
                rest = &rest[position + 1..];
                by_suffix.entry(rest).or_default().push(document);
            }
            by_stem
                .entry(normalize_key(&stem_of(path)))
                .or_default()
                .push(document);
            for alias in &document.aliases {
                by_alias
                    .entry(normalize_key(alias))
                    .or_default()
                    .push(document);
            }
        }
        Self {
            by_path,
            by_path_lower,
            by_suffix,
            by_stem,
            by_alias,
        }
    }

    pub(crate) fn document(&self, path: &str) -> Option<&'a WikiDocument> {
        self.by_path.get(path).copied()
    }
}

fn resolve_document(
    occurrence: &InternalLinkOccurrence,
    lookup: &DocumentLookup<'_>,
) -> Result<String, Vec<String>> {
    if occurrence.target_raw.trim().is_empty() {
        return lookup
            .document(&occurrence.source)
            .map(|document| document.path.clone())
            .ok_or_else(Vec::new);
    }

    let raw = occurrence.target_raw.trim();
    // Source-relative resolution:
    // - Markdown destinations are always source-relative (CommonMark).
    // - Wikilinks only when explicitly relative (`./` / `../`), so vault paths
    //   like `papers/foo/NOTES` are NOT joined under the source directory
    //   (which previously produced impossible candidates and flaky misses).
    let mut exact_candidates = Vec::new();
    let wiki_explicit_relative = raw == "." || raw.starts_with("./") || raw.starts_with("../");
    let try_relative = !raw.starts_with('/')
        && (matches!(occurrence.syntax, InternalLinkSyntax::Markdown) || wiki_explicit_relative);
    if try_relative {
        let relative = source_relative(&occurrence.source, raw);
        // If resolving would escape the Vault, do not fall through to a
        // root/suffix/stem match: `../../Target.md` must never silently become
        // `Target.md` at vault root.
        if relative == ".." || relative.starts_with("../") {
            return Err(Vec::new());
        }
        exact_candidates.extend(add_extensions(&relative));
    }
    exact_candidates.extend(add_extensions(raw));
    for candidate in &exact_candidates {
        if let Some(document) = lookup.document(candidate) {
            return Ok(document.path.clone());
        }
    }
    for candidate in &exact_candidates {
        if let Some(documents) = lookup.by_path_lower.get(&candidate.to_ascii_lowercase()) {
            return unique(
                documents
                    .iter()
                    .map(|document| document.path.clone())
                    .collect(),
            );
        }
    }

    let suffixes = add_extensions(raw);
    let mut suffix_hits = Vec::new();
    for candidate in &suffixes {
        if let Some(documents) = lookup.by_suffix.get(candidate.as_str()) {
            suffix_hits.extend(documents.iter().map(|document| document.path.clone()));
        }
    }
    match unique(suffix_hits) {
        Ok(path) => return Ok(path),
        Err(candidates) if candidates.len() > 1 => return Err(candidates),
        Err(_) => {}
    }

    if Path::new(raw).extension().is_none() {
        let stem_hits = lookup
            .by_stem
            .get(&normalize_key(&stem_of(raw)))
            .map(|documents| {
                documents
                    .iter()
                    .map(|document| document.path.clone())
                    .collect()
            })
            .unwrap_or_default();
        match unique(stem_hits) {
            Ok(path) => return Ok(path),
            Err(candidates) if candidates.len() > 1 => return Err(candidates),
            Err(_) => {}
        }
    }

    let alias_hits = lookup
        .by_alias
        .get(&normalize_key(raw))
        .map(|documents| {
            documents
                .iter()
                .map(|document| document.path.clone())
                .collect()
        })
        .unwrap_or_default();
    unique(alias_hits)
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum FragmentAnchor<'a> {
    Heading(&'a HeadingAnchor),
    Block(&'a BlockAnchor),
}

impl FragmentAnchor<'_> {
    fn label(self) -> String {
        match self {
            Self::Heading(heading) => heading.path.join("#"),
            Self::Block(block) => block.id.clone(),
        }
    }
}

/// Return the exact anchors that satisfy one fragment using the same matching
/// rules as navigation. Embed projection consumes this instead of maintaining a
/// second heading/block resolver.
pub(crate) fn fragment_anchors<'a>(
    document: &'a WikiDocument,
    fragment: &LinkFragment,
) -> Vec<FragmentAnchor<'a>> {
    match fragment {
        LinkFragment::Heading { path } => document
            .headings
            .iter()
            .filter(|heading| heading_path_ends_with(&heading.path, path))
            .map(FragmentAnchor::Heading)
            .collect(),
        LinkFragment::Block { id } if crate::features::wiki::extract::is_valid_block_id(id) => {
            document
                .blocks
                .iter()
                .filter(|block| block.id == *id)
                .map(FragmentAnchor::Block)
                .collect()
        }
        LinkFragment::Block { .. } => Vec::new(),
        // Annotations live in paper marks/, not Markdown anchors.
        LinkFragment::Annotation { .. } => Vec::new(),
    }
}

/// Resolve one occurrence. Missing/ambiguous paths and invalid/ambiguous anchors
/// are explicit states; callers must never turn them into a best-effort jump.
pub fn resolve_occurrence(
    occurrence: InternalLinkOccurrence,
    documents: &[WikiDocument],
) -> ResolvedLink {
    resolve_occurrence_with(occurrence, &DocumentLookup::new(documents))
}

/// Resolve one occurrence against a prebuilt document lookup. Bulk callers
/// (index rebuild) build the lookup once and reuse it for every occurrence.
pub(crate) fn resolve_occurrence_with(
    occurrence: InternalLinkOccurrence,
    lookup: &DocumentLookup<'_>,
) -> ResolvedLink {
    let path = match resolve_document(&occurrence, lookup) {
        Ok(path) => path,
        Err(candidates) if candidates.is_empty() => {
            return ResolvedLink {
                occurrence,
                status: LinkResolutionStatus::Missing,
                target_path: None,
                candidates,
            };
        }
        Err(candidates) => {
            return ResolvedLink {
                occurrence,
                status: LinkResolutionStatus::Ambiguous,
                target_path: None,
                candidates,
            };
        }
    };

    if let Some(fragment) = &occurrence.fragment {
        // PDF annotation ids are not Markdown anchors. A well-formed id + resolved
        // target is enough for link status; existence is refined when a vault root
        // is available (see WikiIndex) and always re-checked on the frontend for
        // embed/jump.
        if let LinkFragment::Annotation { id } = fragment {
            let status = if crate::features::wiki::extract::is_valid_annotation_id(id) {
                LinkResolutionStatus::Resolved
            } else {
                LinkResolutionStatus::InvalidFragment
            };
            return ResolvedLink {
                occurrence,
                status,
                target_path: Some(path),
                candidates: Vec::new(),
            };
        }
        let document = lookup.document(&path);
        let candidates: Vec<String> = document
            .map(|document| {
                fragment_anchors(document, fragment)
                    .into_iter()
                    .map(FragmentAnchor::label)
                    .collect()
            })
            .unwrap_or_default();
        return match candidates.len() {
            1 => ResolvedLink {
                occurrence,
                status: LinkResolutionStatus::Resolved,
                target_path: Some(path),
                candidates: Vec::new(),
            },
            0 => ResolvedLink {
                occurrence,
                status: LinkResolutionStatus::InvalidFragment,
                target_path: Some(path),
                candidates,
            },
            _ => ResolvedLink {
                occurrence,
                status: LinkResolutionStatus::Ambiguous,
                target_path: Some(path),
                candidates,
            },
        };
    }

    ResolvedLink {
        occurrence,
        status: LinkResolutionStatus::Resolved,
        target_path: Some(path),
        candidates: Vec::new(),
    }
}

/// Compatibility helper for callers that only have file paths and no source context.
pub fn resolve_target(target_raw: &str, vault_files: &[String]) -> Option<String> {
    let documents = vault_files
        .iter()
        .map(|path| WikiDocument {
            path: path.clone(),
            aliases: Vec::new(),
            headings: Vec::new(),
            blocks: Vec::new(),
        })
        .collect::<Vec<_>>();
    let occurrence = InternalLinkOccurrence {
        source: String::new(),
        target_raw: target_raw.to_string(),
        syntax: InternalLinkSyntax::Wikilink,
        embed: false,
        display_text: None,
        fragment: None,
        source_range: crate::features::wiki::models::SourceRange { start: 0, end: 0 },
        fragment_range: None,
        line: 0,
        context: None,
    };
    let resolved = resolve_occurrence(occurrence, &documents);
    matches!(resolved.status, LinkResolutionStatus::Resolved)
        .then_some(resolved.target_path)
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::wiki::extract::extract_document;
    use crate::features::wiki::models::{HeadingAnchor, SourceRange};
    use serde::Deserialize;

    fn occurrence(
        source: &str,
        target: &str,
        fragment: Option<LinkFragment>,
    ) -> InternalLinkOccurrence {
        InternalLinkOccurrence {
            source: source.to_string(),
            target_raw: target.to_string(),
            syntax: InternalLinkSyntax::Wikilink,
            embed: false,
            display_text: None,
            fragment,
            source_range: SourceRange {
                start: 0,
                end: target.len(),
            },
            fragment_range: None,
            line: 1,
            context: None,
        }
    }

    fn documents() -> Vec<WikiDocument> {
        vec![
            WikiDocument {
                path: "notes/a.md".into(),
                aliases: vec!["Alpha".into()],
                headings: vec![HeadingAnchor {
                    text: "Root".into(),
                    path: vec!["Root".into()],
                    level: 1,
                    line: 1,
                }],
                blocks: Vec::new(),
            },
            WikiDocument {
                path: "notes/b.md".into(),
                aliases: vec!["Beta".into()],
                headings: Vec::new(),
                blocks: Vec::new(),
            },
        ]
    }

    #[test]
    fn resolves_alias_and_same_file_heading() {
        let docs = documents();
        let alias = resolve_occurrence(occurrence("notes/b.md", "Alpha", None), &docs);
        assert_eq!(alias.target_path.as_deref(), Some("notes/a.md"));
        let same_file = resolve_occurrence(
            occurrence(
                "notes/a.md",
                "",
                Some(LinkFragment::Heading {
                    path: vec!["Root".into()],
                }),
            ),
            &docs,
        );
        assert!(matches!(same_file.status, LinkResolutionStatus::Resolved));
    }

    #[test]
    fn resolves_unique_heading_path_suffixes_at_any_depth() {
        let (source, mut links) = extract_document(
            "notes/source.md",
            "[[Nested#Week#Day#Review#Paper]] [[Nested#Review#Paper]]",
        );
        let (target, _) = extract_document(
            "notes/Nested.md",
            "# Week\n## Day\n### Review\n#### Paper\n",
        );
        let documents = vec![source, target];

        let suffix = resolve_occurrence(links.pop().expect("suffix link"), &documents);
        let full = resolve_occurrence(links.pop().expect("full path link"), &documents);

        assert_eq!(full.status, LinkResolutionStatus::Resolved);
        assert_eq!(suffix.status, LinkResolutionStatus::Resolved);
        assert_eq!(suffix.target_path.as_deref(), Some("notes/Nested.md"));
    }

    #[test]
    fn reports_ambiguous_heading_path_suffixes() {
        let (source, mut links) = extract_document("notes/source.md", "[[Nested#Review#Paper]]");
        let (target, _) = extract_document(
            "notes/Nested.md",
            "# Week A\n## Review\n### Paper\n# Week B\n## Review\n### Paper\n",
        );

        let resolved = resolve_occurrence(
            links.pop().expect("ambiguous suffix link"),
            &[source, target],
        );

        assert_eq!(resolved.status, LinkResolutionStatus::Ambiguous);
        assert_eq!(resolved.target_path.as_deref(), Some("notes/Nested.md"));
        assert_eq!(
            resolved.candidates,
            vec!["Week A#Review#Paper", "Week B#Review#Paper"]
        );
    }

    #[test]
    fn never_silently_resolves_duplicate_names() {
        let mut docs = documents();
        docs.push(WikiDocument {
            path: "other/a.md".into(),
            aliases: Vec::new(),
            headings: Vec::new(),
            blocks: Vec::new(),
        });
        let link = resolve_occurrence(occurrence("notes/b.md", "a", None), &docs);
        assert!(matches!(link.status, LinkResolutionStatus::Ambiguous));
    }

    #[test]
    fn resolves_markdown_relative_path() {
        let docs = documents();
        let mut link = occurrence("folder/source.md", "../notes/a.md", None);
        link.syntax = InternalLinkSyntax::Markdown;
        let link = resolve_occurrence(link, &docs);
        assert_eq!(link.target_path.as_deref(), Some("notes/a.md"));
    }

    #[test]
    fn resolves_bare_markdown_destination_relative_to_source_before_vault_root() {
        let mut docs = documents();
        docs.extend([
            WikiDocument {
                path: "Target.md".into(),
                aliases: Vec::new(),
                headings: Vec::new(),
                blocks: Vec::new(),
            },
            WikiDocument {
                path: "folder/Target.md".into(),
                aliases: Vec::new(),
                headings: Vec::new(),
                blocks: Vec::new(),
            },
        ]);
        let mut link = occurrence("folder/source.md", "Target.md", None);
        link.syntax = InternalLinkSyntax::Markdown;

        let link = resolve_occurrence(link, &docs);

        assert_eq!(link.target_path.as_deref(), Some("folder/Target.md"));
    }

    #[test]
    fn reports_invalid_block_fragments_for_same_and_cross_file_links() {
        let (source, mut links) =
            extract_document("notes/source.md", "[[#^bad id]] and [[Target#^also-bad!]]");
        let (target, _) = extract_document("notes/Target.md", "# Target\nBlock ^valid\n");
        let documents = vec![source, target];

        let cross_file = resolve_occurrence(links.pop().expect("cross-file link"), &documents);
        let same_file = resolve_occurrence(links.pop().expect("same-file link"), &documents);

        assert_eq!(same_file.status, LinkResolutionStatus::InvalidFragment);
        assert_eq!(same_file.target_path.as_deref(), Some("notes/source.md"));
        assert_eq!(cross_file.status, LinkResolutionStatus::InvalidFragment);
        assert_eq!(cross_file.target_path.as_deref(), Some("notes/Target.md"));
    }

    #[test]
    fn resolves_unicode_block_fragments() {
        let (source, links) = extract_document("notes/source.md", "[[Target#^验收块]]");
        let (target, _) =
            extract_document("notes/Target.md", "# Target\n可精确定位到本段。 ^验收块\n");
        let link = resolve_occurrence(
            links.into_iter().next().expect("unicode block link"),
            &[source, target],
        );

        assert_eq!(link.status, LinkResolutionStatus::Resolved);
        assert_eq!(link.target_path.as_deref(), Some("notes/Target.md"));
    }

    #[test]
    fn never_resolves_markdown_paths_outside_the_vault() {
        let mut docs = documents();
        docs.push(WikiDocument {
            path: "Target.md".into(),
            aliases: Vec::new(),
            headings: Vec::new(),
            blocks: Vec::new(),
        });
        let mut link = occurrence("notes/source.md", "../../Target.md", None);
        link.syntax = InternalLinkSyntax::Markdown;

        let link = resolve_occurrence(link, &docs);

        assert_eq!(link.status, LinkResolutionStatus::Missing);
        assert_eq!(link.target_path, None);
    }

    #[derive(Deserialize)]
    struct SemanticFixture {
        documents: Vec<FixtureDocument>,
        cases: Vec<FixtureCase>,
    }

    #[derive(Deserialize)]
    struct FixtureDocument {
        path: String,
        content: String,
    }

    #[derive(Deserialize)]
    struct FixtureCase {
        source: String,
        link: String,
        #[serde(default)]
        syntax: Option<InternalLinkSyntax>,
        status: String,
        path: Option<String>,
    }

    #[test]
    fn shared_semantic_fixture_has_deterministic_results() {
        let fixture: SemanticFixture = serde_json::from_str(include_str!(
            "../../../../../test/fixtures/wikilinks/semantic-cases.json"
        ))
        .expect("semantic fixture must be valid JSON");
        let documents = fixture
            .documents
            .iter()
            .map(|document| extract_document(&document.path, &document.content).0)
            .collect::<Vec<_>>();

        for case in fixture.cases {
            let syntax = case.syntax.unwrap_or(InternalLinkSyntax::Wikilink);
            let input = match syntax {
                InternalLinkSyntax::Wikilink => format!("[[{}]]", case.link),
                InternalLinkSyntax::Markdown => format!("[link]({})", case.link),
            };
            let (_, mut occurrences) = extract_document(&case.source, &input);
            let resolved = resolve_occurrence(
                occurrences.pop().expect("fixture link must parse"),
                &documents,
            );
            assert_eq!(
                serde_json::to_value(&resolved.status)
                    .expect("status serializes")
                    .as_str(),
                Some(case.status.as_str()),
                "{}",
                case.link
            );
            assert_eq!(resolved.target_path, case.path, "{}", case.link);
        }
    }

    /// Byte-for-byte port of the pre-`DocumentLookup` linear resolver. It exists
    /// only to prove that the hash-map lookup preserves resolution semantics.
    fn reference_resolve_document(
        occurrence: &InternalLinkOccurrence,
        documents: &[WikiDocument],
    ) -> Result<String, Vec<String>> {
        if occurrence.target_raw.trim().is_empty() {
            return documents
                .iter()
                .find(|document| document.path == occurrence.source)
                .map(|document| document.path.clone())
                .ok_or_else(Vec::new);
        }

        let raw = occurrence.target_raw.trim();
        let mut exact_candidates = Vec::new();
        let wiki_explicit_relative = raw == "." || raw.starts_with("./") || raw.starts_with("../");
        let try_relative = !raw.starts_with('/')
            && (matches!(occurrence.syntax, InternalLinkSyntax::Markdown)
                || wiki_explicit_relative);
        if try_relative {
            let relative = source_relative(&occurrence.source, raw);
            if relative == ".." || relative.starts_with("../") {
                return Err(Vec::new());
            }
            exact_candidates.extend(add_extensions(&relative));
        }
        exact_candidates.extend(add_extensions(raw));
        for candidate in &exact_candidates {
            let hits = documents
                .iter()
                .filter(|document| document.path == *candidate)
                .map(|document| document.path.clone())
                .collect::<Vec<_>>();
            if !hits.is_empty() {
                return unique(hits);
            }
        }
        for candidate in &exact_candidates {
            let hits = documents
                .iter()
                .filter(|document| document.path.eq_ignore_ascii_case(candidate))
                .map(|document| document.path.clone())
                .collect::<Vec<_>>();
            if !hits.is_empty() {
                return unique(hits);
            }
        }

        let suffixes = add_extensions(raw);
        let suffix_hits = documents
            .iter()
            .filter(|document| {
                suffixes.iter().any(|candidate| {
                    document.path == *candidate || document.path.ends_with(&format!("/{candidate}"))
                })
            })
            .map(|document| document.path.clone())
            .collect::<Vec<_>>();
        match unique(suffix_hits) {
            Ok(path) => return Ok(path),
            Err(candidates) if candidates.len() > 1 => return Err(candidates),
            Err(_) => {}
        }

        if Path::new(raw).extension().is_none() {
            let wanted_stem = normalize_key(&stem_of(raw));
            let stem_hits = documents
                .iter()
                .filter(|document| normalize_key(&stem_of(&document.path)) == wanted_stem)
                .map(|document| document.path.clone())
                .collect::<Vec<_>>();
            match unique(stem_hits) {
                Ok(path) => return Ok(path),
                Err(candidates) if candidates.len() > 1 => return Err(candidates),
                Err(_) => {}
            }
        }

        let wanted_alias = normalize_key(raw);
        let alias_hits = documents
            .iter()
            .filter(|document| {
                document
                    .aliases
                    .iter()
                    .any(|alias| normalize_key(alias) == wanted_alias)
            })
            .map(|document| document.path.clone())
            .collect::<Vec<_>>();
        unique(alias_hits)
    }

    #[test]
    fn lookup_resolution_matches_the_linear_reference_scan() {
        fn doc(path: &str, aliases: &[&str]) -> WikiDocument {
            WikiDocument {
                path: path.into(),
                aliases: aliases.iter().map(|alias| alias.to_string()).collect(),
                headings: Vec::new(),
                blocks: Vec::new(),
            }
        }

        let documents = vec![
            doc("notes/Target.md", &["Alpha", "Short  name"]),
            doc("references/target.md", &[]),
            doc("notes/sub/Target.md", &[]),
            doc("notes/Unique.md", &["共享别名"]),
            doc("papers/demo/PAPER.md", &[]),
            doc("papers/demo/NOTES.md", &["共享别名"]),
            doc("assets/figure.png", &[]),
            doc("assets/deep/figure.png", &[]),
            doc("assets/paper.pdf", &[]),
            doc("notes/中文笔记.md", &[]),
            doc("notes/Case.md", &[]),
            doc("other/case.md", &[]),
            doc("Fara-1.5.md", &[]),
            doc("notes/source.md", &[]),
            doc("folder/source.md", &[]),
            doc("folder/Target.md", &[]),
        ];

        let raws = [
            "",
            "Target",
            "target",
            "Target.md",
            "TARGET.MD",
            "notes/Target",
            "notes/Target.md",
            "sub/Target",
            "./Target",
            "./Target.md",
            "../notes/Target.md",
            "../../Target.md",
            "/Target",
            "Unique",
            "unique",
            "Alpha",
            "alpha",
            "Short name",
            "short  NAME",
            "共享别名",
            "figure.png",
            "deep/figure.png",
            "paper.pdf",
            "paper",
            "中文笔记",
            "Case",
            "case",
            "Fara-1.5",
            "Missing",
            "demo/PAPER",
            "papers/demo/NOTES",
            "NOTES",
            "does/not/exist.md",
            ".",
            "source",
        ];

        for source in ["notes/source.md", "folder/source.md", "missing/source.md"] {
            for syntax in [InternalLinkSyntax::Wikilink, InternalLinkSyntax::Markdown] {
                for raw in raws {
                    let mut probe = occurrence(source, raw, None);
                    probe.syntax = syntax.clone();
                    let reference = reference_resolve_document(&probe, &documents);
                    let lookup = DocumentLookup::new(&documents);
                    let optimized = resolve_document(&probe, &lookup);
                    assert_eq!(
                        optimized, reference,
                        "raw={raw:?} source={source:?} syntax={syntax:?}"
                    );
                }
            }
        }
    }
}
