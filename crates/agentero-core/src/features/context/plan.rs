//! Turn a request plus catalog facts into a [`ContextPlan`] and a prompt block.

use super::types::*;
use super::TOOL_PROFILE;
use crate::error::AppError;
use crate::features::evidence;
use crate::features::paper::catalog::papers::{self, PaperRecord};
use crate::fs::{normalize_rel, sanitize_vault_rel};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::Path;

/// Catalog facts the resolver needs. The prompt does not receive the abstract.
#[derive(Debug, Clone)]
pub struct AnchorFacts {
    pub anchor: ContextAnchor,
    pub paper: Option<PaperBrief>,
    pub file_path: Option<String>,
    pub directory_path: Option<String>,
    pub citation_uri: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PaperBrief {
    pub id: String,
    pub path: String,
    pub title: String,
}

impl PaperBrief {
    fn from_record(record: &PaperRecord) -> Self {
        Self {
            id: record.id.clone(),
            path: record.path.clone(),
            title: record.title.clone(),
        }
    }
}

/// Resolve anchors against the open vault. Unknown paths are dropped.
/// An empty allow-list forces prompt-only expansion: there is nothing to grant.
pub fn resolve_in_vault(
    vault: &Path,
    request: &ContextRequest,
    expansion: ContextExpansion,
) -> Result<ContextPlan, AppError> {
    let mut facts = Vec::new();
    for anchor in &request.anchors {
        if let Some(fact) = facts_for_anchor(vault, anchor)? {
            facts.push(fact);
        }
    }
    Ok(plan_from_facts(request, &facts, expansion))
}

/// Anchors kept when the catalog cannot be opened. The quote and path still
/// go into the prompt; nothing is granted to a tool.
pub fn facts_from_anchors(anchors: &[ContextAnchor]) -> Vec<AnchorFacts> {
    anchors
        .iter()
        .filter(|anchor| {
            nonempty(anchor.quote.as_deref()).is_some()
                || nonempty(anchor.paper_path.as_deref()).is_some()
                || nonempty(anchor.file_path.as_deref()).is_some()
        })
        .map(|anchor| AnchorFacts {
            paper: nonempty(anchor.paper_path.as_deref()).map(|path| PaperBrief {
                id: path.clone(),
                path,
                title: String::new(),
            }),
            file_path: if nonempty(anchor.paper_path.as_deref()).is_some() {
                None
            } else {
                nonempty(anchor.file_path.as_deref())
            },
            directory_path: None,
            citation_uri: None,
            anchor: anchor.clone(),
        })
        .collect()
}

/// Pure planner. Tests build [`AnchorFacts`] without a catalog.
pub fn plan_from_facts(
    request: &ContextRequest,
    facts: &[AnchorFacts],
    mut expansion: ContextExpansion,
) -> ContextPlan {
    let mut allowed: Vec<AllowedSource> = Vec::new();
    let mut immediate = Vec::new();
    for fact in facts {
        if let Some(paper) = &fact.paper {
            push_source(
                &mut allowed,
                AllowedSource {
                    kind: AllowedSourceKind::Paper,
                    path: paper.path.clone(),
                    paper_id: Some(paper.id.clone()),
                    title: Some(paper.title.clone()),
                },
            );
        } else if let Some(dir) = &fact.directory_path {
            push_source(
                &mut allowed,
                AllowedSource {
                    kind: AllowedSourceKind::Directory,
                    path: dir.clone(),
                    paper_id: None,
                    title: None,
                },
            );
        } else if let Some(file) = &fact.file_path {
            push_source(
                &mut allowed,
                AllowedSource {
                    kind: AllowedSourceKind::File,
                    path: file.clone(),
                    paper_id: None,
                    title: None,
                },
            );
        }
        immediate.push(immediate_from(fact));
    }
    if allowed.is_empty() {
        expansion = ContextExpansion::PromptOnly;
    }
    let budget = ContextBudget::default();
    let fingerprint = fingerprint_of(&allowed, &budget, expansion);
    ContextPlan {
        mode: request.mode,
        expansion,
        immediate,
        allowed,
        budget,
        fingerprint,
    }
}

fn push_source(allowed: &mut Vec<AllowedSource>, source: AllowedSource) {
    if allowed
        .iter()
        .any(|existing| existing.kind == source.kind && existing.path == source.path)
    {
        return;
    }
    allowed.push(source);
}

fn immediate_from(fact: &AnchorFacts) -> ImmediateEvidence {
    let (quote, quote_truncated) = clip_quote(fact.anchor.quote.as_deref());
    ImmediateEvidence {
        annotation: fact.anchor.annotation,
        paper_id: fact.paper.as_ref().map(|paper| paper.id.clone()),
        paper_path: fact.paper.as_ref().map(|paper| paper.path.clone()),
        file_path: fact.file_path.clone(),
        directory_path: fact.directory_path.clone(),
        title: fact.paper.as_ref().map(|paper| paper.title.clone()),
        page: fact.anchor.page,
        section: nonempty(fact.anchor.section.as_deref()),
        line_from: fact.anchor.line_from,
        line_to: fact.anchor.line_to,
        quote,
        quote_truncated,
        comment: nonempty(fact.anchor.comment.as_deref()),
        before: nonempty(fact.anchor.before.as_deref()),
        after: nonempty(fact.anchor.after.as_deref()),
        translation: nonempty(fact.anchor.translation.as_deref()),
        citation_uri: fact.citation_uri.clone(),
    }
}

fn clip_quote(quote: Option<&str>) -> (Option<String>, bool) {
    let Some(quote) = quote.map(str::trim).filter(|text| !text.is_empty()) else {
        return (None, false);
    };
    let mut chars = quote.chars();
    let clipped: String = chars.by_ref().take(PROMPT_QUOTE_CHARS).collect();
    let truncated = chars.next().is_some();
    (Some(clipped), truncated)
}

fn nonempty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn fingerprint_of(
    allowed: &[AllowedSource],
    budget: &ContextBudget,
    expansion: ContextExpansion,
) -> String {
    let mut allowed = allowed.to_vec();
    allowed.sort_by(|left, right| {
        (left.kind_key(), left.path.as_str()).cmp(&(right.kind_key(), right.path.as_str()))
    });
    let payload = serde_json::json!({
        "profile": TOOL_PROFILE,
        "commands": ["search", "read", "paper relations"],
        "expansion": expansion,
        "allowed": allowed.iter().map(|source| serde_json::json!({
            "kind": source.kind,
            "path": source.path,
        })).collect::<Vec<_>>(),
        "budget": budget,
    });
    let bytes = serde_json::to_vec(&payload).unwrap_or_default();
    hex::encode(Sha256::digest(bytes))
}

impl AllowedSource {
    fn kind_key(&self) -> u8 {
        match self.kind {
            AllowedSourceKind::File => 0,
            AllowedSourceKind::Paper => 1,
            AllowedSourceKind::Directory => 2,
        }
    }
}

/// Prompt block inserted ahead of the user request. It names the paper and the
/// quote. It does not include the abstract or the body.
pub fn render_prompt_block(plan: &ContextPlan) -> String {
    if plan.immediate.is_empty() && plan.allowed.is_empty() {
        return String::new();
    }
    let mut lines = Vec::new();
    match plan.expansion {
        ContextExpansion::Cli => {
            lines.push(
                "Research context for this turn. This is the minimum evidence: a stable paper ref, title, page or section, and the quoted passage. Do not open the paper file or read the full text first."
                    .to_string(),
            );
            lines.push(
                "When this is not enough, use the turn-bound Agentero CLI executable: read PAPER for metadata, search QUERY to find evidence, then read the returned cite. Read a section, page or region when you need a particular passage. Use paper relations PAPER for references. The host tracks returned evidence for this turn."
                    .to_string(),
            );
        }
        ContextExpansion::PromptOnly => {
            lines.push(
                "Research context for this turn. Context expansion is unavailable: this agent has no turn-bound CLI and must not assume it can read the vault. Answer only from the evidence below. If it is not enough, say so."
                    .to_string(),
            );
        }
    }
    if !plan.allowed.is_empty() {
        lines.push("Sources authorized for this turn:".to_string());
        for source in &plan.allowed {
            let kind = match source.kind {
                AllowedSourceKind::Paper => "paper",
                AllowedSourceKind::File => "file",
                AllowedSourceKind::Directory => "directory",
            };
            let title = source
                .title
                .as_deref()
                .filter(|text| !text.is_empty())
                .map(|text| format!(" — {text}"))
                .unwrap_or_default();
            let id = source
                .paper_id
                .as_deref()
                .filter(|text| !text.is_empty())
                .map(|text| format!(" (id {text})"))
                .unwrap_or_default();
            lines.push(format!("- {kind} `{path}`{id}{title}", path = source.path));
        }
    }
    for item in &plan.immediate {
        lines.push(String::new());
        if let Some(n) = item.annotation {
            lines.push(format!("Annotation {n}"));
        }
        if let Some(id) = item.paper_id.as_deref().filter(|text| !text.is_empty()) {
            lines.push(format!("Paper ref: {id}"));
        }
        if let Some(path) = item.paper_path.as_deref() {
            lines.push(format!("Paper path: {path}"));
        }
        if let Some(path) = item.file_path.as_deref() {
            lines.push(format!("File: {path}"));
        }
        if let Some(path) = item.directory_path.as_deref() {
            lines.push(format!("Directory: {path}"));
        }
        if let Some(title) = item.title.as_deref().filter(|text| !text.is_empty()) {
            lines.push(format!("Title: {title}"));
        }
        if let Some(page) = item.page {
            lines.push(format!("Page: {page}"));
        }
        if let Some(section) = item.section.as_deref() {
            lines.push(format!("Section: {section}"));
        }
        if let Some(from) = item.line_from {
            let to = item.line_to.filter(|to| *to > from);
            match to {
                Some(to) => lines.push(format!("Lines: {from}-{to}")),
                None => lines.push(format!("Line: {from}")),
            }
        }
        if let Some(uri) = item.citation_uri.as_deref() {
            lines.push(format!("Citation: {uri}"));
        }
        if let Some(quote) = item.quote.as_deref() {
            lines.push("Quoted text:".to_string());
            for line in quote.lines() {
                lines.push(format!("> {line}"));
            }
            if item.quote_truncated {
                lines.push(
                    "The quote above is truncated. read SOURCE --quote TEXT returns a larger window. Do not guess the rest."
                        .to_string(),
                );
            }
        }
        if let Some(comment) = item.comment.as_deref() {
            lines.push(format!("User comment on this quote only: {comment}"));
        }
        if let Some(before) = item.before.as_deref() {
            lines.push(format!("Before quote (excerpt): {before}"));
        }
        if let Some(after) = item.after.as_deref() {
            lines.push(format!("After quote (excerpt): {after}"));
        }
        if let Some(translation) = item.translation.as_deref() {
            lines.push(format!(
                "Translation of the quoted sentences: {translation}"
            ));
        }
    }
    lines.join("\n")
}

fn facts_for_anchor(vault: &Path, anchor: &ContextAnchor) -> Result<Option<AnchorFacts>, AppError> {
    let raw = anchor
        .paper_path
        .as_deref()
        .filter(|text| !text.trim().is_empty())
        .or(anchor.file_path.as_deref())
        .map(str::trim)
        .unwrap_or("");
    if raw.is_empty()
        && anchor
            .quote
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
    {
        return Ok(None);
    }
    let rel = if raw.is_empty() {
        None
    } else {
        vault_rel(vault, raw)
    };
    let paper = match rel.as_deref() {
        Some(path) => paper_for_rel(vault, path)?,
        None => None,
    };
    let (file_path, directory_path) = match (&paper, rel.as_deref()) {
        (Some(_), _) | (_, None) => (None, None),
        (None, Some(path)) if vault.join(path).is_dir() => (None, Some(path.to_string())),
        (None, Some(path)) => (Some(path.to_string()), None),
    };
    if paper.is_none()
        && file_path.is_none()
        && directory_path.is_none()
        && nonempty(anchor.quote.as_deref()).is_none()
    {
        return Ok(None);
    }
    let citation_file = anchor
        .file_path
        .as_deref()
        .and_then(|p| vault_rel(vault, p))
        .filter(|p| {
            paper
                .as_ref()
                .is_none_or(|r| Path::new(p).starts_with(&r.path))
        });
    let citation_uri = citation_for(
        vault,
        paper.as_ref(),
        citation_file.as_deref().or(rel.as_deref()),
        anchor,
    );
    Ok(Some(AnchorFacts {
        anchor: anchor.clone(),
        paper: paper.as_ref().map(PaperBrief::from_record),
        file_path,
        directory_path,
        citation_uri,
    }))
}

fn vault_rel(vault: &Path, raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let candidate = Path::new(trimmed);
    let relative = if candidate.is_absolute() {
        candidate
            .strip_prefix(vault)
            .ok()?
            .to_string_lossy()
            .into_owned()
    } else {
        trimmed.to_string()
    };
    sanitize_vault_rel(&normalize_rel(&relative)).ok()
}

fn paper_for_rel(vault: &Path, rel: &str) -> Result<Option<PaperRecord>, AppError> {
    let mut cursor = rel.to_string();
    loop {
        if let Some(paper) = papers::get_by_path(vault, &cursor)? {
            return Ok(Some(paper));
        }
        let Some(parent) = parent_rel(&cursor) else {
            return Ok(None);
        };
        cursor = parent;
    }
}

fn parent_rel(rel: &str) -> Option<String> {
    let slash = rel.rfind('/')?;
    let parent = &rel[..slash];
    if parent.is_empty() {
        None
    } else {
        Some(parent.to_string())
    }
}

fn citation_for(
    vault: &Path,
    paper: Option<&PaperRecord>,
    file_path: Option<&str>,
    anchor: &ContextAnchor,
) -> Option<String> {
    let (path, kind, locator) = if let Some(paper) = paper {
        if let Some(page) = anchor.page {
            (paper.path.as_str(), "body", json!({"page": page}))
        } else if let Some(file) = file_path
            .filter(|f| vault.join(f).is_file() && !f.to_ascii_lowercase().ends_with(".pdf"))
        {
            (
                file,
                evidence::source_kind(vault, file).ok()?,
                text_locator(anchor),
            )
        } else if anchor.section.is_some() || anchor.line_from.is_some() {
            // Logical text may be served by TeX, PAPER.md, or a PDF layout.
            // Use the locator and underlying source selected by normal reads.
            let value = evidence::read(
                vault,
                evidence::ReadInput {
                    source: paper.path.clone(),
                    section: anchor
                        .section
                        .clone()
                        .filter(|_| anchor.line_from.is_none()),
                    lines: anchor
                        .line_from
                        .map(|first| format!("{first}-{}", anchor.line_to.unwrap_or(first))),
                    max_chars: Some(32),
                    ..Default::default()
                },
                true,
            )
            .ok()?;
            return value["evidence"].as_array()?.first()?["cite"]
                .as_str()
                .map(str::to_owned);
        } else {
            (paper.path.as_str(), "metadata", json!({}))
        }
    } else {
        let path = file_path.filter(|p| vault.join(p).is_file())?;
        (
            path,
            evidence::source_kind(vault, path).ok()?,
            text_locator(anchor),
        )
    };
    evidence::current_citation(vault, path, kind, &locator).ok()
}

fn text_locator(anchor: &ContextAnchor) -> serde_json::Value {
    if let Some(line) = anchor.line_from {
        json!({"line_from":line, "line_to":anchor.line_to.unwrap_or(line)})
    } else if let Some(section) = nonempty(anchor.section.as_deref()) {
        json!({"section":section})
    } else {
        json!({})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paper_fact(quote: &str) -> AnchorFacts {
        AnchorFacts {
            anchor: ContextAnchor {
                kind: ContextAnchorKind::Selection,
                paper_path: Some("papers/attention".into()),
                page: Some(3),
                section: Some("2.1 Model".into()),
                quote: Some(quote.into()),
                ..ContextAnchor::default()
            },
            paper: Some(PaperBrief {
                id: "attention".into(),
                path: "papers/attention".into(),
                title: "Attention Is All You Need".into(),
            }),
            file_path: None,
            directory_path: None,
            citation_uri: Some("papers/attention/paper.pdf#page=3".into()),
        }
    }

    fn request() -> ContextRequest {
        ContextRequest {
            surface: ContextSurface::QuickChat,
            question: "what does this mean?".into(),
            anchors: vec![],
            mode: ContextMode::ReadOnly,
        }
    }

    #[test]
    fn prompt_has_ref_title_page_and_quote_but_not_the_body() {
        let plan = plan_from_facts(
            &request(),
            &[paper_fact("scaled dot-product")],
            ContextExpansion::Cli,
        );
        let block = render_prompt_block(&plan);
        assert!(block.contains("Paper ref: attention"));
        assert!(block.contains("Title: Attention Is All You Need"));
        assert!(block.contains("Page: 3"));
        assert!(block.contains("Section: 2.1 Model"));
        assert!(block.contains("> scaled dot-product"));
        assert!(block.contains("papers/attention/paper.pdf#page=3"));
        assert!(!block.contains("Abstract:"));
        assert!(!block.contains("We propose a new"));
        assert_eq!(plan.allowed.len(), 1);
        assert_eq!(plan.expansion, ContextExpansion::Cli);
    }

    #[test]
    fn fingerprint_ignores_the_quote_and_changes_with_the_grant() {
        let first = plan_from_facts(&request(), &[paper_fact("one")], ContextExpansion::Cli);
        let same = plan_from_facts(&request(), &[paper_fact("two")], ContextExpansion::Cli);
        assert_eq!(first.fingerprint, same.fingerprint);
        let mut extra = paper_fact("one");
        extra.paper = Some(PaperBrief {
            id: "other".into(),
            path: "papers/other".into(),
            title: "Other".into(),
        });
        let wider = plan_from_facts(
            &request(),
            &[paper_fact("one"), extra],
            ContextExpansion::Cli,
        );
        assert_ne!(first.fingerprint, wider.fingerprint);
        let remote = plan_from_facts(
            &request(),
            &[paper_fact("one")],
            ContextExpansion::PromptOnly,
        );
        assert_ne!(first.fingerprint, remote.fingerprint);
        let fallback = render_prompt_block(&remote);
        assert!(fallback.contains("Context expansion is unavailable"));
        assert!(!fallback.contains("context_search"));
    }

    #[test]
    fn empty_grant_cannot_advertise_tools() {
        let quote_only = AnchorFacts {
            anchor: ContextAnchor {
                kind: ContextAnchorKind::Selection,
                quote: Some("orphan quote".into()),
                ..ContextAnchor::default()
            },
            paper: None,
            file_path: None,
            directory_path: None,
            citation_uri: None,
        };
        let plan = plan_from_facts(&request(), &[quote_only], ContextExpansion::Cli);
        assert!(plan.allowed.is_empty());
        assert_eq!(plan.expansion, ContextExpansion::PromptOnly);
        assert!(render_prompt_block(&plan).contains("orphan quote"));
    }

    #[test]
    fn directory_mention_is_an_allowed_source() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("notes")).unwrap();
        std::fs::write(dir.path().join("notes/idea.md"), "a note").unwrap();
        std::fs::write(dir.path().join("Makefile"), "all:\n").unwrap();
        let request = ContextRequest {
            surface: ContextSurface::Sidebar,
            question: String::new(),
            mode: ContextMode::ReadOnly,
            anchors: vec![
                ContextAnchor {
                    kind: ContextAnchorKind::Mention,
                    file_path: Some("notes".into()),
                    ..ContextAnchor::default()
                },
                ContextAnchor {
                    kind: ContextAnchorKind::Mention,
                    file_path: Some("Makefile".into()),
                    ..ContextAnchor::default()
                },
            ],
        };
        let plan = resolve_in_vault(dir.path(), &request, ContextExpansion::Cli).unwrap();
        assert!(plan.allowed.iter().any(|source| {
            source.kind == AllowedSourceKind::Directory && source.path == "notes"
        }));
        assert!(plan
            .allowed
            .iter()
            .any(|source| { source.kind == AllowedSourceKind::File && source.path == "Makefile" }));
        let block = render_prompt_block(&plan);
        assert!(block.contains("directory `notes`"));
        assert!(block.contains("Directory: notes"));
        assert!(block.contains("File: Makefile"));
    }
}
