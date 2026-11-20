//! `context_search`, `context_read`, and `paper_relations` against one grant.
//!
//! Results are evidence cards. The paper body is not the default, and a path
//! outside the grant is an error rather than a read.

use super::grant::{load_grant, record_usage};
use super::types::*;
use crate::error::AppError;
use crate::features::paper::analyze::refs::citing;
use crate::features::paper::analyze::refs::{self, Citation};
use crate::features::paper::capabilities::find_local_pdf;
use crate::features::paper::catalog::papers::{self, PaperRecord};
use crate::features::pdf::layout_index::{self, RawLayout, RawLayoutRegion};
use crate::fs::{normalize_rel, sanitize_vault_rel};
use std::io::Read;
use std::path::{Path, PathBuf};

pub struct ContextSession {
    vault: PathBuf,
    grant: ContextGrant,
    usage: PathBuf,
}

impl ContextSession {
    pub fn open(grant_file: &Path) -> Result<Self, AppError> {
        let grant = load_grant(grant_file)?;
        let usage = grant_file
            .parent()
            .map(|dir| dir.join("usage.jsonl"))
            .unwrap_or_else(|| PathBuf::from("usage.jsonl"));
        Ok(Self {
            vault: PathBuf::from(&grant.vault_path),
            grant,
            usage,
        })
    }

    pub fn from_parts(vault: PathBuf, grant: ContextGrant, usage: PathBuf) -> Self {
        Self {
            vault,
            grant,
            usage,
        }
    }

    pub fn search(
        &self,
        query: &str,
        scope: &[String],
        limit: Option<u32>,
    ) -> Result<ContextToolResult, AppError> {
        let limit = self.grant.budget.clamp_search_limit(limit);
        let sources = self.scoped_sources(scope)?;
        let tokens = query_tokens(query);
        let mut hits: Vec<(i32, EvidenceRef)> = Vec::new();
        for source in sources {
            match source.kind {
                AllowedSourceKind::Paper => {
                    if let Some(paper) = papers::get_by_path(&self.vault, &source.path)? {
                        hits.extend(search_paper(self, &paper, &tokens));
                    }
                }
                AllowedSourceKind::File => {
                    if let Some(hit) = search_file(self, &source.path, &tokens) {
                        hits.push(hit);
                    }
                }
                AllowedSourceKind::Directory => {
                    hits.extend(search_directory(self, &source.path, &tokens));
                }
            }
        }
        hits.sort_by(|left, right| {
            right
                .0
                .cmp(&left.0)
                .then(left.1.citation_uri.cmp(&right.1.citation_uri))
        });
        hits.truncate(limit);
        let evidence: Vec<_> = hits.into_iter().map(|(_, evidence)| evidence).collect();
        self.finish("context_search", evidence, None)
    }

    pub fn read(
        &self,
        query: &EvidenceQuery,
        level_raw: Option<&str>,
    ) -> Result<ContextToolResult, AppError> {
        let level = ReadLevel::parse(level_raw)
            .map_err(|message| AppError::domain("context_read", message))?;
        let located = self.locate(query)?;
        let evidence = match located {
            Located::Paper(paper) => self.read_paper(&paper, query, level)?,
            Located::File(path) => self.read_file(&path, query, level)?,
            Located::Directory(path) => self.read_directory(&path, level)?,
        };
        let note = (level == ReadLevel::Full).then(|| {
            "Full text is capped by this turn's read budget and is not the default level."
                .to_string()
        });
        self.finish("context_read", evidence, note)
    }

    pub fn relations(
        &self,
        paper_ref: &str,
        direction: Option<&str>,
        limit: Option<u32>,
    ) -> Result<ContextToolResult, AppError> {
        let paper = self.paper_in_grant(paper_ref)?;
        let limit = self.grant.budget.clamp_search_limit(limit);
        let direction = direction.map(str::trim).filter(|text| !text.is_empty());
        let mut evidence = Vec::new();
        let want = |name: &str| direction.is_none_or(|value| value == name);
        if want("citations") {
            evidence.extend(self.citation_cards(&paper, limit));
        }
        if want("cited_by") {
            evidence.extend(self.cited_by_cards(&paper, limit));
        }
        if want("related") {
            evidence.extend(self.related_cards(&paper, limit));
        }
        if !matches!(
            direction,
            None | Some("citations") | Some("cited_by") | Some("related")
        ) {
            return Err(AppError::domain(
                "paper_relations",
                "direction must be citations, cited_by, or related",
            ));
        }
        self.finish(
            "paper_relations",
            evidence,
            Some(
                "Cards name related work. context_read still refuses papers outside this turn's grant."
                    .to_string(),
            ),
        )
    }

    fn finish(
        &self,
        tool: &str,
        evidence: Vec<EvidenceRef>,
        note: Option<String>,
    ) -> Result<ContextToolResult, AppError> {
        let uris: Vec<_> = evidence
            .iter()
            .map(|item| item.citation_uri.clone())
            .filter(|uri| !uri.is_empty())
            .collect();
        record_usage(&self.usage, tool, &uris)?;
        Ok(ContextToolResult { evidence, note })
    }

    fn scoped_sources(&self, scope: &[String]) -> Result<Vec<AllowedSource>, AppError> {
        if scope.is_empty() {
            return Ok(self.grant.allowed.clone());
        }
        let mut out = Vec::new();
        for raw in scope {
            let rel = normalize_user_path(raw)?;
            let Some(source) = self.grant.allowed.iter().find(|source| source.path == rel) else {
                return Err(AppError::domain(
                    "context_scope",
                    format!("{rel} is outside this session's context grant"),
                ));
            };
            out.push(source.clone());
        }
        Ok(out)
    }

    fn locate(&self, query: &EvidenceQuery) -> Result<Located, AppError> {
        let (mut path, page, section, region) = parse_locator(query);
        if path.is_none() && self.grant.allowed.len() == 1 {
            path = Some(self.grant.allowed[0].path.clone());
        }
        if let Some(path) = path {
            if let Some(source) = self.source_for(&path) {
                return match source.kind {
                    AllowedSourceKind::Paper => {
                        let paper =
                            papers::get_by_path(&self.vault, &source.path)?.ok_or_else(|| {
                                AppError::domain(
                                    "context_read",
                                    format!("{} is not in the catalog", source.path),
                                )
                            })?;
                        Ok(Located::Paper(Box::new(paper)))
                    }
                    AllowedSourceKind::File => Ok(Located::File(source.path.clone())),
                    AllowedSourceKind::Directory => {
                        let child = path != source.path;
                        if child && self.vault.join(&path).is_file() {
                            Ok(Located::File(path))
                        } else {
                            Ok(Located::Directory(source.path.clone()))
                        }
                    }
                };
            }
            return Err(AppError::domain(
                "context_scope",
                format!("{path} is outside this session's context grant"),
            ));
        }
        let _ = (page, section, region);
        Err(AppError::domain(
            "context_read",
            "evidence_ref needs a paper path, file path, or citation URI inside this grant",
        ))
    }

    fn source_for(&self, path: &str) -> Option<&AllowedSource> {
        let mut cursor = path.to_string();
        loop {
            if let Some(source) = self
                .grant
                .allowed
                .iter()
                .find(|source| source.path == cursor)
            {
                return Some(source);
            }
            let slash = cursor.rfind('/')?;
            cursor = cursor[..slash].to_string();
            if cursor.is_empty() {
                return None;
            }
        }
    }

    fn paper_in_grant(&self, paper_ref: &str) -> Result<PaperRecord, AppError> {
        let needle = paper_ref.trim();
        let source = self
            .grant
            .allowed
            .iter()
            .find(|source| {
                source.kind == AllowedSourceKind::Paper
                    && (source.path == needle
                        || source.paper_id.as_deref() == Some(needle)
                        || normalize_user_path(needle).ok().as_deref()
                            == Some(source.path.as_str()))
            })
            .ok_or_else(|| {
                AppError::domain(
                    "context_scope",
                    format!("{needle} is outside this session's context grant"),
                )
            })?;
        papers::get_by_path(&self.vault, &source.path)?.ok_or_else(|| {
            AppError::domain(
                "paper_relations",
                format!("{} is not in the catalog", source.path),
            )
        })
    }

    fn read_paper(
        &self,
        paper: &PaperRecord,
        query: &EvidenceQuery,
        level: ReadLevel,
    ) -> Result<Vec<EvidenceRef>, AppError> {
        let budget = self.grant.budget.chars_for(level);
        let card = self.grant.budget.card_chars as usize;
        let (_, page, section, region) = parse_locator(query);
        let page = page.or(query.page);
        let section = section.or(query.section.clone());
        let region = region.or(query.region_id.clone());
        let layout = layout_index::load_raw_layout(&self.vault, &paper.path).ok();
        let body = match level {
            ReadLevel::Metadata => metadata_text(paper),
            ReadLevel::Excerpt => excerpt_text(
                &self.vault,
                paper,
                query.quote.as_deref(),
                page,
                layout.as_ref(),
                budget,
            ),
            ReadLevel::Section => section_text(
                &self.vault,
                paper,
                section.as_deref(),
                layout.as_ref(),
                budget,
            ),
            ReadLevel::Page => page_text(page, layout.as_ref(), budget)?,
            ReadLevel::Region => region_text(region.as_deref(), layout.as_ref(), budget)?,
            ReadLevel::Full => full_text(&self.vault, paper, layout.as_ref(), budget),
        };
        let (excerpt, _) = cap_text(
            &body,
            if level == ReadLevel::Metadata {
                card.max(budget)
            } else {
                budget
            },
        );
        let citation_uri = paper_citation(
            &self.vault,
            paper,
            page,
            section.as_deref(),
            region.as_deref(),
        );
        Ok(vec![self.evidence(
            paper.id.clone(),
            Some(paper.path.clone()),
            None,
            locator_for(level, page, section, region),
            excerpt,
            paper.updated_at.clone(),
            citation_uri,
        )])
    }

    fn read_file(
        &self,
        rel: &str,
        query: &EvidenceQuery,
        level: ReadLevel,
    ) -> Result<Vec<EvidenceRef>, AppError> {
        match level {
            ReadLevel::Page | ReadLevel::Region => {
                return Err(AppError::domain(
                    "context_read",
                    "page and region levels apply to a paper, not a vault file",
                ));
            }
            _ => {}
        }
        let abs = self.vault.join(rel);
        let budget = self.grant.budget.chars_for(level);
        let body = if level == ReadLevel::Excerpt {
            read_excerpt(&abs, query.quote.as_deref().unwrap_or(""), budget)?
        } else {
            let text = fs_read_capped(&abs, self.grant.budget.full_chars as usize + 1)?;
            match level {
                ReadLevel::Metadata => {
                    format!("File: {rel}\nCharacters: {}", text.chars().count())
                }
                ReadLevel::Section => markdown_section(&text, query.section.as_deref(), budget),
                ReadLevel::Full => cap_text(&text, budget).0,
                ReadLevel::Excerpt | ReadLevel::Page | ReadLevel::Region => unreachable!(),
            }
        };
        Ok(vec![self.evidence(
            rel.to_string(),
            None,
            Some(rel.to_string()),
            EvidenceLocator {
                kind: level_name(level).to_string(),
                page: None,
                section: query.section.clone(),
                region_id: None,
                line_from: None,
                line_to: None,
            },
            body,
            "file".into(),
            rel.to_string(),
        )])
    }

    fn read_directory(&self, rel: &str, level: ReadLevel) -> Result<Vec<EvidenceRef>, AppError> {
        if level != ReadLevel::Metadata {
            return Err(AppError::domain(
                "context_read",
                "pass a file path inside this directory to read its text",
            ));
        }
        let mut names = Vec::new();
        if let Ok(entries) = std::fs::read_dir(self.vault.join(rel)) {
            for entry in entries.filter_map(|entry| entry.ok()) {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with('.') {
                    continue;
                }
                names.push(name.into_owned());
            }
        }
        names.sort();
        names.truncate(40);
        let body = format!("Directory: {rel}\n{}", names.join("\n"));
        Ok(vec![self.evidence(
            rel.to_string(),
            None,
            None,
            EvidenceLocator {
                kind: "directory".into(),
                page: None,
                section: None,
                region_id: None,
                line_from: None,
                line_to: None,
            },
            cap_text(&body, self.grant.budget.chars_for(level)).0,
            "directory".into(),
            rel.to_string(),
        )])
    }

    fn citation_cards(&self, paper: &PaperRecord, limit: usize) -> Vec<EvidenceRef> {
        let path = self
            .vault
            .join(&paper.path)
            .join("source")
            .join(refs::SIDECAR_FILE);
        let Some(sidecar) = refs::read_sidecar(&path) else {
            return Vec::new();
        };
        sidecar
            .citations
            .into_iter()
            .take(limit)
            .map(|citation| citation_evidence(&self.grant, citation))
            .collect()
    }

    fn cited_by_cards(&self, paper: &PaperRecord, limit: usize) -> Vec<EvidenceRef> {
        citing::cached_citing_of(&self.vault, &paper.path)
            .into_iter()
            .take(limit)
            .map(|card| {
                let title = card
                    .title
                    .clone()
                    .unwrap_or_else(|| "Untitled citing paper".into());
                let year = card
                    .date
                    .as_deref()
                    .and_then(|date| date.get(..4))
                    .and_then(|year| year.parse::<i32>().ok());
                let excerpt = format!(
                    "{title}{}{}",
                    year.map(|year| format!(" ({year})")).unwrap_or_default(),
                    card.doi
                        .as_deref()
                        .map(|doi| format!(" doi:{doi}"))
                        .unwrap_or_default()
                );
                let local = citing_local_paper(&self.vault, &card);
                let paper_path = local.as_ref().map(|found| found.path.clone());
                let work_id = local
                    .as_ref()
                    .map(|found| found.id.clone())
                    .or_else(|| card.doi.clone())
                    .or_else(|| card.arxiv_id.clone())
                    .unwrap_or_else(|| title.clone());
                let revision = local
                    .as_ref()
                    .map(|found| found.updated_at.clone())
                    .unwrap_or_else(|| "citing".into());
                let citation_uri = relation_uri(
                    paper_path.as_deref(),
                    card.doi.as_deref(),
                    card.arxiv_id.as_deref(),
                );
                self.evidence(
                    work_id,
                    paper_path,
                    None,
                    EvidenceLocator {
                        kind: "cited_by".into(),
                        page: None,
                        section: None,
                        region_id: None,
                        line_from: None,
                        line_to: None,
                    },
                    cap_text(&excerpt, self.grant.budget.card_chars as usize).0,
                    revision,
                    citation_uri,
                )
            })
            .collect()
    }

    fn related_cards(&self, paper: &PaperRecord, limit: usize) -> Vec<EvidenceRef> {
        let path = self
            .vault
            .join(&paper.path)
            .join("source")
            .join(refs::SIDECAR_FILE);
        let Some(sidecar) = refs::read_sidecar(&path) else {
            return Vec::new();
        };
        sidecar
            .citations
            .into_iter()
            .filter_map(|citation| {
                citation
                    .local_match
                    .map(|local| (citation.metadata.title, local))
            })
            .take(limit)
            .map(|(title, local)| {
                let readable = self
                    .grant
                    .allowed
                    .iter()
                    .any(|source| source.path == local.paper_path);
                let label = title.unwrap_or_else(|| local.paper_path.clone());
                let mut excerpt = format!("Related local paper: {label} ({})", local.paper_path);
                if !readable {
                    excerpt.push_str(". Not readable in this session.");
                }
                self.evidence(
                    paper.id.clone(),
                    Some(local.paper_path.clone()),
                    None,
                    EvidenceLocator {
                        kind: "related".into(),
                        page: None,
                        section: None,
                        region_id: None,
                        line_from: None,
                        line_to: None,
                    },
                    cap_text(&excerpt, self.grant.budget.card_chars as usize).0,
                    paper.updated_at.clone(),
                    local.paper_path,
                )
            })
            .collect()
    }

    #[allow(clippy::too_many_arguments)]
    fn evidence(
        &self,
        work_id: String,
        paper_path: Option<String>,
        file_path: Option<String>,
        locator: EvidenceLocator,
        excerpt: String,
        revision: String,
        citation_uri: String,
    ) -> EvidenceRef {
        EvidenceRef {
            provider: "vault".into(),
            work_id,
            paper_path,
            file_path,
            locator,
            excerpt,
            revision,
            citation_uri,
        }
    }
}

enum Located {
    Paper(Box<PaperRecord>),
    File(String),
    Directory(String),
}

fn search_paper(
    session: &ContextSession,
    paper: &PaperRecord,
    tokens: &[String],
) -> Vec<(i32, EvidenceRef)> {
    let mut hits = Vec::new();
    let card = session.grant.budget.card_chars as usize;
    let title_score = score(&paper.title, tokens) * 3;
    let abstract_score = score(paper.abstract_text.as_deref().unwrap_or(""), tokens) * 2;
    if title_score + abstract_score > 0 || tokens.is_empty() {
        let excerpt = if tokens.is_empty() {
            paper.title.clone()
        } else {
            snippet(
                &format!(
                    "{} {}",
                    paper.title,
                    paper.abstract_text.as_deref().unwrap_or("")
                ),
                tokens,
                card,
            )
        };
        hits.push((
            title_score + abstract_score,
            session.evidence(
                paper.id.clone(),
                Some(paper.path.clone()),
                None,
                EvidenceLocator {
                    kind: "metadata".into(),
                    page: None,
                    section: None,
                    region_id: None,
                    line_from: None,
                    line_to: None,
                },
                excerpt,
                paper.updated_at.clone(),
                paper_citation(&session.vault, paper, None, None, None),
            ),
        ));
    }
    let tex_source = crate::features::paper::source::read_tex(&session.vault.join(&paper.path));
    if let Some(source) = &tex_source {
        let points = score(&source.text, tokens);
        if !tokens.is_empty() && points > 0 {
            let rel = source
                .root
                .strip_prefix(&session.vault)
                .unwrap_or(&source.root)
                .to_string_lossy()
                .replace('\\', "/");
            hits.push((
                points,
                session.evidence(
                    paper.id.clone(),
                    Some(paper.path.clone()),
                    Some(rel.clone()),
                    EvidenceLocator {
                        kind: "source".into(),
                        page: None,
                        section: None,
                        region_id: None,
                        line_from: None,
                        line_to: None,
                    },
                    snippet(&source.text, tokens, card),
                    paper.updated_at.clone(),
                    rel,
                ),
            ));
        }
    }
    for rel in ["NOTES.md", "PAPER.md"] {
        if rel == "PAPER.md" && tex_source.is_some() {
            continue;
        }
        let path = session.vault.join(&paper.path).join(rel);
        let Ok(text) = fs_read_capped(&path, 64 * 1024) else {
            continue;
        };
        let points = score(&text, tokens);
        if points == 0 && !tokens.is_empty() {
            continue;
        }
        if tokens.is_empty() {
            continue;
        }
        hits.push((
            points,
            session.evidence(
                paper.id.clone(),
                Some(paper.path.clone()),
                Some(format!("{}/{}", paper.path, rel)),
                EvidenceLocator {
                    kind: "note".into(),
                    page: None,
                    section: None,
                    region_id: None,
                    line_from: None,
                    line_to: None,
                },
                snippet(&text, tokens, card),
                paper.updated_at.clone(),
                format!("{}/{}", paper.path, rel),
            ),
        ));
    }
    if let Ok(layout) = layout_index::load_raw_layout(&session.vault, &paper.path) {
        if !tokens.is_empty() {
            if let Some((region, points)) = best_region(&layout, tokens) {
                let page = region.page_index + 1;
                hits.push((
                    points,
                    session.evidence(
                        paper.id.clone(),
                        Some(paper.path.clone()),
                        None,
                        EvidenceLocator {
                            kind: "page".into(),
                            page: Some(page),
                            section: region.title.clone(),
                            region_id: Some(region.id.clone()),
                            line_from: None,
                            line_to: None,
                        },
                        snippet(region.text.as_deref().unwrap_or(""), tokens, card),
                        paper.updated_at.clone(),
                        paper_citation(
                            &session.vault,
                            paper,
                            Some(page),
                            None,
                            Some(region.id.as_str()),
                        ),
                    ),
                ));
            }
        }
    }
    hits
}

const DIRECTORY_SCAN_FILES: usize = 64;

fn search_directory(
    session: &ContextSession,
    rel: &str,
    tokens: &[String],
) -> Vec<(i32, EvidenceRef)> {
    let mut hits = Vec::new();
    let mut scanned = 0usize;
    let mut seen = std::collections::HashSet::new();
    let root = session.vault.join(rel);
    seen.insert(root.clone());
    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        if scanned >= DIRECTORY_SCAN_FILES {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut entries: Vec<_> = entries.filter_map(|entry| entry.ok()).collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if scanned >= DIRECTORY_SCAN_FILES {
                break;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                if seen.insert(path.clone()) {
                    stack.push(path);
                }
                continue;
            }
            if !is_note_file(&name) {
                continue;
            }
            let Ok(file_rel) = path.strip_prefix(&session.vault) else {
                continue;
            };
            let file_rel = file_rel.to_string_lossy().replace('\\', "/");
            scanned += 1;
            if let Some(hit) = search_file(session, &file_rel, tokens) {
                hits.push(hit);
            }
        }
    }
    hits
}

fn is_note_file(name: &str) -> bool {
    match name.rsplit_once('.') {
        Some((_, ext)) => matches!(
            ext.to_ascii_lowercase().as_str(),
            "md" | "markdown" | "txt" | "tex" | "rst" | "org" | "csv"
        ),
        None => true,
    }
}

fn search_file(
    session: &ContextSession,
    rel: &str,
    tokens: &[String],
) -> Option<(i32, EvidenceRef)> {
    let text = fs_read_capped(&session.vault.join(rel), 64 * 1024).ok()?;
    let points = score(&text, tokens);
    if points == 0 && !tokens.is_empty() {
        return None;
    }
    let excerpt = if tokens.is_empty() {
        cap_text(&text, session.grant.budget.card_chars as usize).0
    } else {
        snippet(&text, tokens, session.grant.budget.card_chars as usize)
    };
    Some((
        points,
        session.evidence(
            rel.to_string(),
            None,
            Some(rel.to_string()),
            EvidenceLocator {
                kind: "file".into(),
                page: None,
                section: None,
                region_id: None,
                line_from: None,
                line_to: None,
            },
            excerpt,
            "file".into(),
            rel.to_string(),
        ),
    ))
}

fn citing_local_paper(vault: &Path, card: &citing::CachedCitingCard) -> Option<PaperRecord> {
    let lookup = |column: &str, value: &str| {
        let value = value.trim();
        if value.is_empty() {
            return None;
        }
        papers::find_by_identifier(vault, column, value)
            .ok()
            .flatten()
    };
    card.doi
        .as_deref()
        .and_then(|doi| lookup("doi", doi))
        .or_else(|| {
            card.arxiv_id
                .as_deref()
                .and_then(|id| lookup("arxiv_id", id))
        })
}

fn citation_evidence(grant: &ContextGrant, citation: Citation) -> EvidenceRef {
    let title = citation.metadata.title.clone().unwrap_or_else(|| {
        citation
            .display
            .clone()
            .unwrap_or_else(|| "Untitled reference".into())
    });
    let local = citation
        .local_match
        .as_ref()
        .map(|item| item.paper_path.clone());
    let readable = local
        .as_deref()
        .is_some_and(|path| grant.allowed.iter().any(|source| source.path == path));
    let mut excerpt = title.clone();
    if let Some(year) = citation.metadata.year {
        excerpt.push_str(&format!(" ({year})"));
    }
    if let Some(path) = &local {
        excerpt.push_str(&format!(" local:{path}"));
        if !readable {
            excerpt.push_str(" (not in this grant)");
        }
    }
    let citation_uri = relation_uri(
        local.as_deref(),
        citation.metadata.doi.as_deref(),
        citation.metadata.arxiv_id.as_deref(),
    );
    EvidenceRef {
        provider: "vault".into(),
        work_id: local.clone().unwrap_or_else(|| citation.id.clone()),
        paper_path: local,
        file_path: None,
        locator: EvidenceLocator {
            kind: "citation".into(),
            page: None,
            section: None,
            region_id: None,
            line_from: None,
            line_to: None,
        },
        excerpt: cap_text(&excerpt, grant.budget.card_chars as usize).0,
        revision: citation.source,
        citation_uri,
    }
}

fn metadata_text(paper: &PaperRecord) -> String {
    let authors = if paper.authors.is_empty() {
        String::new()
    } else {
        format!("\nAuthors: {}", paper.authors.join(", "))
    };
    let year = paper
        .year
        .map(|year| format!("\nYear: {year}"))
        .unwrap_or_default();
    let abstract_text = paper
        .abstract_text
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(|text| format!("\nAbstract:\n{text}"))
        .unwrap_or_else(|| "\nAbstract: (none stored)".to_string());
    format!(
        "Paper ref: {}\nTitle: {}{authors}{year}{abstract_text}",
        paper.id, paper.title
    )
}

fn excerpt_text(
    vault: &Path,
    paper: &PaperRecord,
    quote: Option<&str>,
    page: Option<u32>,
    layout: Option<&RawLayout>,
    budget: usize,
) -> String {
    if let (Some(layout), Some(page)) = (layout, page.filter(|page| *page > 0)) {
        let page_body = join_page(layout, page - 1);
        if let Some(quote) = quote.map(str::trim).filter(|text| !text.is_empty()) {
            if let Some(window) = window_around(&page_body, quote, budget) {
                return window;
            }
        }
        if !page_body.is_empty() {
            return cap_text(&page_body, budget).0;
        }
    }
    if let Some(source) = crate::features::paper::source::read_tex(&vault.join(&paper.path)) {
        if let Some(quote) = quote.map(str::trim).filter(|text| !text.is_empty()) {
            if let Some(window) = window_around(&source.text, quote, budget) {
                return window;
            }
        } else {
            return cap_text(&source.text, budget).0;
        }
    }
    let notes = read_paper_file(vault, paper, "NOTES.md").unwrap_or_default();
    if let Some(quote) = quote.map(str::trim).filter(|text| !text.is_empty()) {
        if let Some(window) = window_around(&notes, quote, budget) {
            return window;
        }
        return cap_text(quote, budget).0;
    }
    cap_text(&notes, budget.min(280)).0
}

fn section_text(
    vault: &Path,
    paper: &PaperRecord,
    section: Option<&str>,
    layout: Option<&RawLayout>,
    budget: usize,
) -> String {
    if let Some(source) = crate::features::paper::source::read_tex(&vault.join(&paper.path)) {
        let text = tex_section_markdown(&source.text);
        let body = markdown_section(&text, section, budget);
        if !body.is_empty() {
            return body;
        }
    }
    if let (Some(layout), Some(section)) = (layout, section.filter(|text| !text.trim().is_empty()))
    {
        let body = layout_section(layout, section);
        if !body.is_empty() {
            return cap_text(&body, budget).0;
        }
    }
    for name in ["PAPER.md", "NOTES.md"] {
        if let Some(text) = read_paper_file(vault, paper, name) {
            let body = markdown_section(&text, section, budget);
            if !body.is_empty() {
                return body;
            }
        }
    }
    "Section text is not available. Try context_read level metadata or page.".into()
}

fn page_text(
    page: Option<u32>,
    layout: Option<&RawLayout>,
    budget: usize,
) -> Result<String, AppError> {
    let page =
        page.ok_or_else(|| AppError::domain("context_read", "page level needs a 1-based page"))?;
    if page == 0 {
        return Err(AppError::domain("context_read", "page is 1-based"));
    }
    let Some(layout) = layout else {
        return Err(AppError::domain(
            "context_read",
            "this paper has no layout.json yet; open it so layout analysis can run",
        ));
    };
    let body = join_page(layout, page - 1);
    if body.is_empty() {
        return Err(AppError::domain(
            "context_read",
            format!("page {page} has no layout text"),
        ));
    }
    Ok(cap_text(&body, budget).0)
}

fn region_text(
    region_id: Option<&str>,
    layout: Option<&RawLayout>,
    budget: usize,
) -> Result<String, AppError> {
    let region_id = region_id
        .ok_or_else(|| AppError::domain("context_read", "region level needs a region id"))?;
    let Some(layout) = layout else {
        return Err(AppError::domain(
            "context_read",
            "this paper has no layout.json yet",
        ));
    };
    let Some(region) = layout.regions.iter().find(|region| region.id == region_id) else {
        return Err(AppError::domain(
            "context_read",
            format!("region {region_id} was not found"),
        ));
    };
    let text = region.text.clone().unwrap_or_default();
    if text.is_empty() {
        return Err(AppError::domain(
            "context_read",
            format!("region {region_id} has no text"),
        ));
    }
    Ok(cap_text(&text, budget).0)
}

fn full_text(
    vault: &Path,
    paper: &PaperRecord,
    layout: Option<&RawLayout>,
    budget: usize,
) -> String {
    if let Some(source) = crate::features::paper::source::read_tex(&vault.join(&paper.path)) {
        return cap_text(&source.text, budget).0;
    }
    if let Some(text) = read_paper_file(vault, paper, "PAPER.md") {
        return cap_text(&text, budget).0;
    }
    if let Some(layout) = layout {
        let joined = layout
            .regions
            .iter()
            .filter_map(|region| region.text.clone())
            .collect::<Vec<_>>()
            .join("\n");
        if !joined.is_empty() {
            return cap_text(&joined, budget).0;
        }
    }
    "Full text is not available. Use metadata, section, or page.".into()
}

/// Expose literal TeX section titles to the existing section slicer. Math and
/// body macros stay verbatim; this is not a lossy TeX-to-Markdown conversion.
fn tex_section_markdown(text: &str) -> String {
    let mut result = text.to_string();
    for (command, prefix) in [
        ("chapter", "#"),
        ("section", "##"),
        ("subsection", "###"),
        ("subsubsection", "####"),
    ] {
        let needle = format!("\\{command}");
        let mut offset = 0;
        while let Some(index) = result[offset..].find(&needle) {
            let start = offset + index;
            let rest = &result[start + needle.len()..];
            if rest.starts_with(|c: char| c.is_ascii_alphabetic()) {
                offset = start + needle.len();
                continue;
            }
            let rest = rest.trim_start_matches('*').trim_start();
            let rest = if rest.starts_with('[') {
                rest.split_once(']')
                    .map(|(_, rest)| rest.trim_start())
                    .unwrap_or(rest)
            } else {
                rest
            };
            let Some(after) = rest.strip_prefix('{') else {
                offset = start + needle.len();
                continue;
            };
            let Some(end) = after.find('}') else {
                break;
            };
            let title = after[..end].to_string();
            let consumed = result.len() - after[end + 1..].len();
            let replacement = format!("\n{prefix} {title}\n");
            result.replace_range(start..consumed, &replacement);
            offset = start + replacement.len();
        }
    }
    result
}

fn read_paper_file(vault: &Path, paper: &PaperRecord, name: &str) -> Option<String> {
    fs_read_capped(&vault.join(&paper.path).join(name), 256 * 1024).ok()
}

fn join_page(layout: &RawLayout, page_index: u32) -> String {
    layout_index::page_regions(layout, page_index)
        .into_iter()
        .filter_map(|region| region.text.clone())
        .collect::<Vec<_>>()
        .join("\n")
}

fn layout_section(layout: &RawLayout, section: &str) -> String {
    let needle = section.trim().to_lowercase();
    let mut started = false;
    let mut out = Vec::new();
    for region in &layout.regions {
        if is_heading(region) {
            let title = region
                .title
                .as_deref()
                .or(region.text.as_deref())
                .unwrap_or("")
                .to_lowercase();
            if started {
                break;
            }
            if title.contains(&needle) {
                started = true;
                if let Some(text) = region.text.as_deref() {
                    out.push(text.to_string());
                }
            }
            continue;
        }
        if started {
            if let Some(text) = region.text.as_deref() {
                out.push(text.to_string());
            }
        }
    }
    out.join("\n")
}

fn is_heading(region: &RawLayoutRegion) -> bool {
    let kind = region.kind.to_lowercase();
    kind.contains("title")
        || kind.contains("header")
        || kind.contains("section")
        || kind == "heading"
}

fn markdown_section(text: &str, section: Option<&str>, budget: usize) -> String {
    let Some(section) = section.map(str::trim).filter(|text| !text.is_empty()) else {
        return cap_text(text, budget.min(280)).0;
    };
    let needle = section.to_lowercase();
    let mut started = false;
    let mut level = 0usize;
    let mut out = Vec::new();
    for line in text.lines() {
        let hashes = line.chars().take_while(|ch| *ch == '#').count();
        if hashes > 0 && line.chars().nth(hashes) == Some(' ') {
            let title = line[hashes..].trim().to_lowercase();
            if started && hashes <= level {
                break;
            }
            if !started && title.contains(&needle) {
                started = true;
                level = hashes;
                out.push(line.to_string());
            }
            continue;
        }
        if started {
            out.push(line.to_string());
        }
    }
    cap_text(&out.join("\n"), budget).0
}

fn best_region<'a>(layout: &'a RawLayout, tokens: &[String]) -> Option<(&'a RawLayoutRegion, i32)> {
    layout
        .regions
        .iter()
        .filter_map(|region| {
            let text = region.text.as_deref().unwrap_or("");
            let points = score(text, tokens);
            (points > 0).then_some((region, points))
        })
        .max_by_key(|(_, points)| *points)
}

fn parse_locator(
    query: &EvidenceQuery,
) -> (Option<String>, Option<u32>, Option<String>, Option<String>) {
    let mut path = query
        .paper_path
        .clone()
        .or(query.file_path.clone())
        .and_then(|raw| normalize_user_path(&raw).ok());
    let mut page = query.page;
    let mut section = query.section.clone();
    let mut region = query.region_id.clone();
    if let Some(uri) = query.citation_uri.as_deref() {
        let (uri_path, fragment) = uri
            .split_once('#')
            .map(|(path, fragment)| (path, Some(fragment)))
            .unwrap_or((uri, None));
        if path.is_none() && !uri_path.starts_with("http://") && !uri_path.starts_with("https://") {
            path = normalize_user_path(uri_path).ok();
        }
        if let Some(fragment) = fragment {
            for part in fragment.split('&') {
                let (key, value) = part.split_once('=').unwrap_or((part, ""));
                let value = urlencoding::decode(value).unwrap_or(std::borrow::Cow::Borrowed(value));
                match key {
                    "page" => page = page.or(value.parse().ok()),
                    "section" if section.is_none() => {
                        section = Some(value.into_owned());
                    }
                    "region" if region.is_none() => {
                        region = Some(value.into_owned());
                    }
                    _ => {}
                }
            }
        }
    }
    (path, page, section, region)
}

fn paper_citation(
    vault: &Path,
    paper: &PaperRecord,
    page: Option<u32>,
    section: Option<&str>,
    region: Option<&str>,
) -> String {
    let pdf = find_local_pdf(&vault.join(&paper.path));
    let base = pdf
        .and_then(|path| {
            path.strip_prefix(vault)
                .ok()
                .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        })
        .unwrap_or_else(|| paper.path.clone());
    if let Some(region) = region.filter(|text| !text.is_empty()) {
        return format!("{base}#region={}", urlencoding::encode(region));
    }
    if let Some(page) = page {
        return format!("{base}#page={page}");
    }
    if let Some(section) = section.filter(|text| !text.is_empty()) {
        return format!("{base}#section={}", urlencoding::encode(section));
    }
    base
}

fn locator_for(
    level: ReadLevel,
    page: Option<u32>,
    section: Option<String>,
    region: Option<String>,
) -> EvidenceLocator {
    EvidenceLocator {
        kind: level_name(level).to_string(),
        page,
        section,
        region_id: region,
        line_from: None,
        line_to: None,
    }
}

fn level_name(level: ReadLevel) -> &'static str {
    match level {
        ReadLevel::Metadata => "metadata",
        ReadLevel::Excerpt => "excerpt",
        ReadLevel::Section => "section",
        ReadLevel::Page => "page",
        ReadLevel::Region => "region",
        ReadLevel::Full => "full",
    }
}

/// A path, DOI, or arXiv URL the app can open. Anything else stays empty so
/// the chat does not offer a link that `openCitation` cannot resolve.
fn relation_uri(local: Option<&str>, doi: Option<&str>, arxiv: Option<&str>) -> String {
    if let Some(path) = local.map(str::trim).filter(|path| !path.is_empty()) {
        return path.to_string();
    }
    if let Some(doi) = doi.map(str::trim).filter(|doi| !doi.is_empty()) {
        return format!("https://doi.org/{doi}");
    }
    if let Some(id) = arxiv.map(str::trim).filter(|id| !id.is_empty()) {
        return format!("https://arxiv.org/abs/{id}");
    }
    String::new()
}

fn normalize_user_path(raw: &str) -> Result<String, AppError> {
    sanitize_vault_rel(&normalize_rel(raw)).map_err(AppError::message)
}

fn query_tokens(query: &str) -> Vec<String> {
    query
        .split(|ch: char| !ch.is_alphanumeric())
        .filter(|token| token.chars().count() >= 2)
        .map(|token| token.to_lowercase())
        .collect()
}

fn score(text: &str, tokens: &[String]) -> i32 {
    if tokens.is_empty() {
        return 1;
    }
    let lower = text.to_lowercase();
    tokens
        .iter()
        .filter(|token| lower.contains(token.as_str()))
        .count() as i32
}

fn snippet(text: &str, tokens: &[String], limit: usize) -> String {
    let lower = text.to_lowercase();
    let byte = tokens
        .iter()
        .filter_map(|token| lower.find(token.as_str()))
        .min()
        .unwrap_or(0);
    window_at(text, byte, limit)
}

fn window_around(text: &str, quote: &str, limit: usize) -> Option<String> {
    if quote.is_empty() {
        return None;
    }
    let lower_text = text.to_lowercase();
    let lower_quote = quote.to_lowercase();
    let byte = lower_text.find(lower_quote.trim())?;
    Some(window_at(text, byte, limit))
}

fn window_at(text: &str, byte: usize, limit: usize) -> String {
    let start = floor_char(text, byte.saturating_sub(80));
    let end = ceil_char(text, (byte + limit).min(text.len()));
    cap_text(text[start..end].trim(), limit).0
}

fn floor_char(text: &str, byte: usize) -> usize {
    if text.is_char_boundary(byte) {
        return byte;
    }
    (0..byte)
        .rev()
        .find(|index| text.is_char_boundary(*index))
        .unwrap_or(0)
}

fn ceil_char(text: &str, byte: usize) -> usize {
    if byte >= text.len() {
        return text.len();
    }
    (byte..=text.len())
        .find(|index| text.is_char_boundary(*index))
        .unwrap_or(text.len())
}

fn cap_text(text: &str, max_chars: usize) -> (String, bool) {
    let mut chars = text.chars();
    let clipped: String = chars.by_ref().take(max_chars).collect();
    (clipped, chars.next().is_some())
}

/// Bytes scanned while locating a quote. The returned window still uses the
/// read budget. This is only so a selection past `full_chars` is not missed.
const EXCERPT_SEARCH_BYTES: usize = 32 * 1024 * 1024;

fn read_excerpt(path: &Path, quote: &str, limit: usize) -> Result<String, AppError> {
    let quote = quote.trim();
    if quote.is_empty() {
        let text = fs_read_capped(path, limit.saturating_mul(4).max(limit) + 4)?;
        return Ok(cap_text(&text, limit).0);
    }
    let text = fs_read_capped(path, EXCERPT_SEARCH_BYTES)?;
    Ok(window_around(&text, quote, limit).unwrap_or_else(|| cap_text(&text, limit).0))
}

fn fs_read_capped(path: &Path, max_bytes: usize) -> Result<String, AppError> {
    let file = std::fs::File::open(path)
        .map_err(|error| AppError::message(format!("read {}: {error}", path.display())))?;
    let mut bytes = Vec::new();
    file.take(max_bytes as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| AppError::message(format!("read {}: {error}", path.display())))?;
    let end = (0..=bytes.len())
        .rev()
        .find(|index| std::str::from_utf8(&bytes[..*index]).is_ok())
        .unwrap_or(0);
    Ok(String::from_utf8_lossy(&bytes[..end]).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::paper::catalog::papers::PaperRecord;
    use std::fs;

    fn vault_with_paper() -> (tempfile::TempDir, ContextSession, PaperRecord) {
        let dir = tempfile::tempdir().unwrap();
        let paper_dir = dir.path().join("papers/attention");
        fs::create_dir_all(paper_dir.join("source")).unwrap();
        fs::write(paper_dir.join("paper.pdf"), b"%PDF").unwrap();
        let notes = format!(
            "# Notes\n\n{}\n\nThe unique token is scaled-dot-product attention in the middle of the note.\n\n{}FAR-END-MARKER",
            "HEAD-SENTINEL ".repeat(40),
            "x".repeat(4_000)
        );
        fs::write(paper_dir.join("NOTES.md"), notes).unwrap();
        fs::write(
            paper_dir.join("PAPER.md"),
            "# 2.1 Model Architecture\n\nThe encoder stack is described here.\n\nFULL-BODY-SENTINEL and a great deal of extra prose that should not appear in a metadata read.\n",
        )
        .unwrap();
        fs::write(
            paper_dir.join("source/layout.json"),
            r#"{
              "regions": [
                {"id":"h1","pageIndex":1,"kind":"section_header","title":"2.1 Model Architecture","text":"2.1 Model Architecture","bbox":{"x":0,"y":0,"w":1,"h":0.1}},
                {"id":"p1","pageIndex":1,"kind":"text","text":"The encoder stack is six identical layers.","bbox":{"x":0,"y":0.2,"w":1,"h":0.2}},
                {"id":"h2","pageIndex":1,"kind":"section_header","title":"3 Experiments","text":"3 Experiments","bbox":{"x":0,"y":0.5,"w":1,"h":0.1}},
                {"id":"p2","pageIndex":2,"kind":"text","text":"Page three talks about training.","bbox":{"x":0,"y":0,"w":1,"h":0.2}}
              ]
            }"#,
        )
        .unwrap();
        fs::write(
            paper_dir.join("source/agentero-cite.json"),
            r#"{
              "schemaVersion": 1,
              "source": {"mode":"bib","generatedAt":"t","fingerprint":"fp"},
              "citations": [
                {
                  "id": "vaswani",
                  "metadata": {"title": "Attention Is All You Need", "year": 2017, "doi": "10.1/attn"},
                  "source": "bib",
                  "status": "resolved",
                  "localMatch": {"paperPath": "papers/other", "matchBy": "title"}
                },
                {
                  "id": "bare",
                  "metadata": {"title": "No Locator"},
                  "source": "bib",
                  "status": "resolved"
                }
              ]
            }"#,
        )
        .unwrap();
        fs::create_dir_all(dir.path().join(".agentero")).unwrap();
        fs::write(
            dir.path().join(".agentero/citing-scan.json"),
            r#"{
              "schemaVersion": 1,
              "generatedAt": "t",
              "seeds": {
                "papers/attention": {
                  "s2Id": "s2",
                  "citationCount": 2,
                  "fetchedAt": "t",
                  "citing": [
                    {"s2Id":"c1","title":"A Follow-up","date":"2024-01-01","doi":"10.9/follow","citationCount":3},
                    {"s2Id":"c2","title":"Unlocated citer","citationCount":1}
                  ]
                }
              }
            }"#,
        )
        .unwrap();
        let mut record =
            PaperRecord::local_pdf("attention".into(), "Attention Is All You Need".into())
                .at_path("papers/attention");
        record.abstract_text = Some("We propose the Transformer.".into());
        record.authors = vec!["Vaswani".into()];
        record.year = Some(2017);
        let stored = papers::upsert_paper(dir.path(), &record).unwrap();
        let grant = ContextGrant {
            schema_version: GRANT_SCHEMA_VERSION,
            session_id: "s".into(),
            vault_path: dir.path().display().to_string(),
            fingerprint: "fp".into(),
            allowed: vec![AllowedSource {
                kind: AllowedSourceKind::Paper,
                path: "papers/attention".into(),
                paper_id: Some("attention".into()),
                title: Some(stored.title.clone()),
            }],
            budget: ContextBudget::default(),
            mode: ContextMode::ReadOnly,
        };
        let session = ContextSession::from_parts(
            dir.path().to_path_buf(),
            grant,
            dir.path().join("usage.jsonl"),
        );
        (dir, session, stored)
    }

    #[test]
    fn search_returns_a_card_not_the_note_body() {
        let (_dir, session, _) = vault_with_paper();
        let result = session.search("scaled-dot-product", &[], Some(3)).unwrap();
        assert!(!result.evidence.is_empty());
        let blob = serde_json::to_string(&result).unwrap();
        assert!(blob.contains("scaled-dot-product"));
        assert!(!blob.contains("FAR-END-MARKER"));
        assert!(!blob.contains(&"HEAD-SENTINEL ".repeat(8)));
        assert!(result
            .evidence
            .iter()
            .all(|item| item.excerpt.chars().count() <= 280));
        assert!(result
            .evidence
            .iter()
            .any(|item| item.citation_uri.contains("papers/attention")));
    }

    #[test]
    fn tex_full_section_and_search_supersede_old_ocr() {
        let (vault, session, paper) = vault_with_paper();
        let source = vault.path().join(&paper.path).join("source");
        fs::write(source.join("main.tex"), "\\documentclass{article}\\begin{document}\\section{Introduction}\\input{intro}\\section{Method}\\input{method}\\end{document}").unwrap();
        fs::write(source.join("intro.tex"), "TEX-INTRO-SENTINEL").unwrap();
        fs::write(source.join("method.tex"), "TEX-METHOD-SENTINEL $x^2$.").unwrap();
        let query = EvidenceQuery {
            paper_path: Some(paper.path.clone()),
            ..Default::default()
        };
        let full = session.read(&query, Some("full")).unwrap();
        assert!(full.evidence[0].excerpt.contains("TEX-METHOD-SENTINEL"));
        assert!(!full.evidence[0].excerpt.contains("FULL-BODY-SENTINEL"));
        let section = session
            .read(
                &EvidenceQuery {
                    section: Some("Introduction".into()),
                    ..query
                },
                Some("section"),
            )
            .unwrap();
        assert!(section.evidence[0].excerpt.contains("TEX-INTRO-SENTINEL"));
        assert!(!section.evidence[0].excerpt.contains("TEX-METHOD-SENTINEL"));
        let hits = search_paper(&session, &paper, &["tex-method-sentinel".into()]);
        assert!(hits
            .iter()
            .any(|(_, evidence)| evidence.excerpt.contains("TEX-METHOD-SENTINEL")));
    }

    #[test]
    fn directory_grant_searches_notes_and_lists_names() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("notes")).unwrap();
        fs::write(
            dir.path().join("notes/idea.md"),
            "the token is directory-needle",
        )
        .unwrap();
        let grant = ContextGrant {
            schema_version: GRANT_SCHEMA_VERSION,
            session_id: "s".into(),
            vault_path: dir.path().display().to_string(),
            fingerprint: "fp".into(),
            allowed: vec![AllowedSource {
                kind: AllowedSourceKind::Directory,
                path: "notes".into(),
                paper_id: None,
                title: None,
            }],
            budget: ContextBudget::default(),
            mode: ContextMode::ReadOnly,
        };
        let session = ContextSession::from_parts(
            dir.path().to_path_buf(),
            grant,
            dir.path().join("usage.jsonl"),
        );
        let found = session.search("directory-needle", &[], Some(3)).unwrap();
        let blob = serde_json::to_string(&found).unwrap();
        assert!(blob.contains("directory-needle"));
        assert!(blob.contains("notes/idea.md"));
        let listed = session
            .read(
                &EvidenceQuery {
                    file_path: Some("notes".into()),
                    ..EvidenceQuery::default()
                },
                Some("metadata"),
            )
            .unwrap();
        let names = serde_json::to_string(&listed).unwrap();
        assert!(names.contains("idea.md"));
        assert!(!names.contains("directory-needle"));
        let note = session
            .read(
                &EvidenceQuery {
                    file_path: Some("notes/idea.md".into()),
                    quote: Some("directory-needle".into()),
                    ..EvidenceQuery::default()
                },
                Some("excerpt"),
            )
            .unwrap();
        assert!(serde_json::to_string(&note)
            .unwrap()
            .contains("directory-needle"));
    }

    #[test]
    fn excerpt_finds_a_quote_past_the_full_text_cap() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("long.md"),
            format!("{} LATE-QUOTE-MARKER", "x".repeat(20_000)),
        )
        .unwrap();
        let grant = ContextGrant {
            schema_version: GRANT_SCHEMA_VERSION,
            session_id: "s".into(),
            vault_path: dir.path().display().to_string(),
            fingerprint: "fp".into(),
            allowed: vec![AllowedSource {
                kind: AllowedSourceKind::File,
                path: "long.md".into(),
                paper_id: None,
                title: None,
            }],
            budget: ContextBudget::default(),
            mode: ContextMode::ReadOnly,
        };
        let session = ContextSession::from_parts(
            dir.path().to_path_buf(),
            grant,
            dir.path().join("usage.jsonl"),
        );
        let result = session
            .read(
                &EvidenceQuery {
                    file_path: Some("long.md".into()),
                    quote: Some("LATE-QUOTE-MARKER".into()),
                    ..EvidenceQuery::default()
                },
                Some("excerpt"),
            )
            .unwrap();
        let card = result.evidence.first().unwrap();
        assert!(card.excerpt.contains("LATE-QUOTE-MARKER"));
        assert!(card.excerpt.chars().count() <= 4_000);
    }

    #[test]
    fn capped_read_stops_at_max_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.txt");
        let mut file = fs::File::create(&path).unwrap();
        let chunk = vec![b'a'; 64 * 1024];
        for _ in 0..8 {
            std::io::Write::write_all(&mut file, &chunk).unwrap();
        }
        std::io::Write::write_all(&mut file, b"TAIL-MARKER").unwrap();
        let text = fs_read_capped(&path, 1000).unwrap();
        assert!(text.len() <= 1000);
        assert!(!text.contains("TAIL-MARKER"));
        assert!(text.chars().all(|ch| ch == 'a'));
    }

    #[test]
    fn read_defaults_to_metadata_and_refuses_other_papers() {
        let (_dir, session, _) = vault_with_paper();
        let meta = session
            .read(
                &EvidenceQuery {
                    paper_path: Some("papers/attention".into()),
                    ..EvidenceQuery::default()
                },
                None,
            )
            .unwrap();
        let blob = serde_json::to_string(&meta).unwrap();
        assert!(blob.contains("We propose the Transformer."));
        assert!(blob.contains("Vaswani"));
        assert!(!blob.contains("FULL-BODY-SENTINEL"));
        let implicit = session.read(&EvidenceQuery::default(), None).unwrap();
        assert!(serde_json::to_string(&implicit)
            .unwrap()
            .contains("We propose the Transformer."));
        let denied = session.read(
            &EvidenceQuery {
                paper_path: Some("papers/other".into()),
                ..EvidenceQuery::default()
            },
            Some("full"),
        );
        assert!(denied.is_err());
    }

    #[test]
    fn read_opens_section_and_page_without_dumping_the_paper() {
        let (_dir, session, _) = vault_with_paper();
        let section = session
            .read(
                &EvidenceQuery {
                    paper_path: Some("papers/attention".into()),
                    section: Some("2.1 Model Architecture".into()),
                    ..EvidenceQuery::default()
                },
                Some("section"),
            )
            .unwrap();
        let section_blob = serde_json::to_string(&section).unwrap();
        assert!(section_blob.contains("six identical layers"));
        assert!(!section_blob.contains("3 Experiments"));
        let page = session
            .read(
                &EvidenceQuery {
                    citation_uri: Some("papers/attention/paper.pdf#page=3".into()),
                    ..EvidenceQuery::default()
                },
                Some("page"),
            )
            .unwrap();
        assert!(serde_json::to_string(&page)
            .unwrap()
            .contains("Page three talks about training"));
        let uris = super::super::grant::read_usage_uris(&session.usage);
        assert!(uris
            .iter()
            .any(|uri| uri.contains("#page=3") || uri.contains("page=3")));
    }

    #[test]
    fn relations_use_the_sidecar_and_citing_cache() {
        let (_dir, session, _) = vault_with_paper();
        let cards = session.relations("attention", None, Some(5)).unwrap();
        let blob = serde_json::to_string(&cards).unwrap();
        assert!(blob.contains("Attention Is All You Need"));
        assert!(blob.contains("papers/other"));
        assert!(
            blob.contains("not in this grant")
                || blob.contains("Not readable")
                || blob.contains("not readable")
        );
        assert!(blob.contains("A Follow-up"));
        assert!(blob.contains("https://doi.org/10.9/follow"));
        assert!(blob.contains("No Locator"));
        assert!(blob.contains("Unlocated citer"));
        assert!(!blob.contains("cited-by:"));
        assert!(!blob.contains("citation:"));
        let bare = cards
            .evidence
            .iter()
            .find(|item| item.excerpt.contains("No Locator"))
            .unwrap();
        assert!(bare.citation_uri.is_empty());
        let follow = cards
            .evidence
            .iter()
            .find(|item| item.excerpt.contains("A Follow-up"))
            .unwrap();
        assert!(follow.paper_path.is_none());
        assert_ne!(follow.work_id, "attention");
        let unlocated = cards
            .evidence
            .iter()
            .find(|item| item.excerpt.contains("Unlocated citer"))
            .unwrap();
        assert!(unlocated.paper_path.is_none());
        assert_ne!(unlocated.work_id, "attention");
    }

    #[test]
    fn cited_by_uses_a_catalog_match_instead_of_the_seed() {
        let (dir, session, _) = vault_with_paper();
        let mut follow =
            PaperRecord::local_pdf("follow".into(), "A Follow-up".into()).at_path("papers/follow");
        follow.doi = Some("10.9/follow".into());
        papers::upsert_paper(dir.path(), &follow).unwrap();
        let cards = session
            .relations("attention", Some("cited_by"), Some(5))
            .unwrap();
        let matched = cards
            .evidence
            .iter()
            .find(|item| item.excerpt.contains("A Follow-up"))
            .unwrap();
        assert_eq!(matched.paper_path.as_deref(), Some("papers/follow"));
        assert_eq!(matched.work_id, "follow");
        assert_ne!(matched.paper_path.as_deref(), Some("papers/attention"));
    }
}
