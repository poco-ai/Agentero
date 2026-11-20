use super::*;
use crate::features::{pdf::layout_index, research_table};
use walkdir::WalkDir;

pub(super) fn kind_for(path: &str, parent: Option<&PaperRecord>) -> &'static str {
    if let Some(paper) = parent {
        if path.strip_prefix(&paper.path) == Some("/NOTES.md") {
            return "note";
        }
        return "body";
    }
    if path.ends_with(".table.json") {
        "table"
    } else if path.ends_with("/NOTES.md") || path.starts_with("notes/") {
        "note"
    } else if path.starts_with("papers/") {
        "body"
    } else {
        "file"
    }
}

/// Classify direct paths against catalog ownership, including custom import directories.
pub fn source_kind(vault: &Path, rel: &str) -> Result<&'static str> {
    for ancestor in Path::new(rel)
        .ancestors()
        .filter(|s| !s.as_os_str().is_empty())
    {
        if let Some(parent) = papers::get_by_path(vault, &ancestor.to_string_lossy())? {
            return Ok(kind_for(rel, Some(&parent)));
        }
    }
    Ok(kind_for(rel, None))
}
pub(super) fn permitted_file(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or("");
    !(name == "catalog.sqlite"
        || name == "metadata.json"
        || path.split('/').any(|s| s == "marks")
        || path.ends_with("/source/layout.json")
        || path.ends_with("/source/layout-index.json")
        || path.ends_with("/source/agentero-cite.json"))
}

pub(super) fn resolve_source(vault: &Path, source: &str) -> Result<String> {
    if source.starts_with("agentero://cite/") {
        return Ok(resolve_citation(vault, source)?.0);
    }
    validate_rel(source)?;
    if vault.join(source.replace('\\', "/")).exists() {
        return relative(vault, &existing(vault, source)?);
    }
    paper(vault, source)?
        .map(|p| p.path)
        .ok_or_else(|| missing(source))
}
fn in_scope(path: &str, scope: &[String]) -> bool {
    scope.is_empty() || scope.iter().any(|s| Path::new(path).starts_with(s))
}
fn accepts(kind: &str, filter: &[String]) -> bool {
    filter.is_empty() || filter.iter().any(|v| v == kind)
}

struct Matcher {
    terms: Vec<String>,
    any: bool,
}
impl Matcher {
    fn score(&self, text: &str) -> usize {
        let lower = text.to_lowercase();
        let mut score = 0;
        for term in &self.terms {
            let count = lower.matches(term).count();
            if !self.any && count == 0 {
                return 0;
            }
            score += count.min(10);
        }
        score
    }
    fn excerpt_span(&self, text: &str) -> (usize, String) {
        // Bound excerpts in characters. Unicode case folding can change byte lengths.
        let lower = text.to_lowercase();
        let folded_byte = self
            .terms
            .iter()
            .filter_map(|q| lower.find(q))
            .min()
            .unwrap_or(0);
        let mut folded_offset = 0;
        let byte = text
            .char_indices()
            .find_map(|(i, c)| {
                folded_offset += c.to_lowercase().map(char::len_utf8).sum::<usize>();
                (folded_offset > folded_byte).then_some(i)
            })
            .unwrap_or(0);
        let start = text[..byte]
            .char_indices()
            .rev()
            .nth(65)
            .map_or(0, |(i, _)| i);
        (
            text[..start].chars().count(),
            text[start..].chars().take(260).collect(),
        )
    }
    fn excerpt(&self, text: &str) -> String {
        self.excerpt_span(text).1
    }
    fn body_card(
        &self,
        vault: &Path,
        source: &str,
        revision: &str,
        mut locator: Value,
        content: &str,
        offset: usize,
    ) -> Result<Value> {
        let (local_start, excerpt) = self.excerpt_span(content);
        let start = offset + local_start;
        locator["char_from"] = json!(start);
        locator["char_to"] = json!(start + excerpt.chars().count());
        card(vault, source, "body", locator, revision, &excerpt)
    }
}
pub fn search(vault: &Path, mut input: SearchInput) -> Result<Value> {
    let vault = std::fs::canonicalize(vault)?;
    let cursor = input.cursor.take();
    let key = query_key(&vault, &input)?;
    let limit = input.limit.unwrap_or(20);
    if !(1..=50).contains(&limit) {
        return Err(usage("limit must be 1..50"));
    }
    let matcher = Matcher {
        terms: input
            .query
            .split_whitespace()
            .map(str::to_lowercase)
            .collect(),
        any: match input.matching.as_deref().unwrap_or("all") {
            "all" => false,
            "any" => true,
            _ => return Err(usage("match must be all or any")),
        },
    };
    if matcher.terms.is_empty() {
        return Err(usage("query must contain at least one word"));
    }
    if input
        .kind
        .iter()
        .any(|s| !["metadata", "body", "note", "file", "table"].contains(&s.as_str()))
    {
        return Err(usage("unknown evidence kind"));
    }
    let scope = input
        .scope
        .iter()
        .map(|r| resolve_source(&vault, r))
        .collect::<Result<Vec<_>>>()?;
    let mut hits = Vec::new();
    let mut tex_papers = std::collections::HashSet::new();
    let records = papers::list_all(&vault)?;
    for p in &records {
        if !in_scope(&p.path, &scope)
            || !papers::paper_has_all_tags(p, &input.tag)
            || existing(&vault, &p.path).is_err()
        {
            continue;
        }
        if accepts("metadata", &input.kind) {
            let content = format!(
                "{}\n{}\n{}",
                p.title,
                p.authors.join(", "),
                p.abstract_text.as_deref().unwrap_or("")
            );
            let score = matcher.score(&content);
            if score > 0 {
                let rev = content_revision(&serde_json::to_vec(p)?);
                hits.push((
                    score + 2,
                    card(
                        &vault,
                        &p.path,
                        "metadata",
                        json!({}),
                        &rev,
                        &matcher.excerpt(&content),
                    )?,
                ));
            }
        }
        if !accepts("body", &input.kind) {
            continue;
        }
        if crate::features::paper::source::read_tex(&existing(&vault, &p.path)?).is_some() {
            // The walk below cites the individual TeX files with real line numbers.
            tex_papers.insert(p.path.as_str());
            continue;
        }
        if existing(&vault, &format!("{}/source/layout.json", p.path)).is_ok() {
            if let Ok(layout) = layout_index::load_raw_layout(&vault, &p.path) {
                let path = existing(&vault, &format!("{}/source/layout.json", p.path))?;
                let revision = file_revision(&path)?;
                for r in layout.regions {
                    let body = r.text.as_deref().or(r.title.as_deref()).unwrap_or_default();
                    let score = matcher.score(body);
                    if score > 0 {
                        hits.push((
                            score,
                            matcher.body_card(
                                &vault,
                                &p.path,
                                &revision,
                                json!({"page":r.page_index+1,"region":r.id}),
                                body,
                                0,
                            )?,
                        ));
                    }
                }
            }
        } else if !vault.join(&p.path).join("PAPER.md").is_file() {
            #[cfg(not(any(target_os = "ios", target_os = "android")))]
            if let Ok(pdf) =
                super::read::pdf_file(&vault, &p.path).and_then(|path| Ok(std::fs::read(path)?))
            {
                if let Ok(pages) = crate::features::pdf::text::extract_text(&pdf, None, usize::MAX)
                {
                    let mut revision = None;
                    for page in pages.pages {
                        let score = matcher.score(&page.text);
                        if score > 0 {
                            let rev = revision.get_or_insert_with(|| content_revision(&pdf));
                            hits.push((
                                score,
                                matcher.body_card(
                                    &vault,
                                    &p.path,
                                    rev,
                                    json!({"page":page.page}),
                                    &page.text,
                                    0,
                                )?,
                            ));
                        }
                    }
                }
            }
        }
    }
    let by_path: std::collections::HashMap<_, _> =
        records.iter().map(|p| (Path::new(&p.path), p)).collect();
    let walk = WalkDir::new(&vault)
        .follow_links(false)
        .max_depth(32)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            if e.file_type().is_symlink() {
                return false;
            }
            let Ok(rel) = e.path().strip_prefix(&vault) else {
                return false;
            };
            let name = rel.to_string_lossy().replace('\\', "/");
            validate_rel(&name).is_ok()
                && (in_scope(&name, &scope) || scope.iter().any(|s| Path::new(s).starts_with(rel)))
        });
    for entry in walk
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        let rel = relative(&vault, entry.path())?;
        if !permitted_file(&rel)
            || entry
                .path()
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
        {
            // PDF hits use the physical page returned by the text engine.
            continue;
        }
        let parent = Path::new(&rel)
            .ancestors()
            .find_map(|x| by_path.get(x).copied());
        if parent.is_some_and(|p| {
            tex_papers.contains(p.path.as_str()) && rel == format!("{}/PAPER.md", p.path)
        }) {
            continue;
        }
        let kind = kind_for(&rel, parent);
        if !accepts(kind, &input.kind)
            || (!input.tag.is_empty()
                && !parent.is_some_and(|p| papers::paper_has_all_tags(p, &input.tag)))
        {
            continue;
        }
        if kind == "table" {
            let Ok(source) = std::fs::read_to_string(entry.path()) else {
                continue;
            };
            let Ok(rows) = research_table::evidence_rows(&source) else {
                continue;
            };
            let revision = content_revision(source.as_bytes());
            for row in rows {
                for (field, value) in row.values {
                    let text = value
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| value.to_string());
                    let score = matcher.score(&text);
                    if score > 0 {
                        let locator = json!({"row":row.public_id,"field":field});
                        hits.push((
                            score,
                            card(
                                &vault,
                                &rel,
                                kind,
                                locator,
                                &revision,
                                &matcher.excerpt(&text),
                            )?,
                        ));
                    }
                }
            }
            continue;
        }
        if entry.metadata().is_err() || entry.path().metadata()?.len() > 2 * 1024 * 1024 {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        if content.contains('\0') {
            continue;
        }
        let mut revision = None;
        let mut char_offset = 0;
        for (i, raw_line) in content.split_inclusive('\n').enumerate() {
            let line = raw_line.strip_suffix('\n').unwrap_or(raw_line);
            let line = line.strip_suffix('\r').unwrap_or(line);
            let line_start = char_offset;
            char_offset += raw_line.chars().count();
            let score = matcher.score(line);
            if score == 0 {
                continue;
            }
            let revision = revision.get_or_insert_with(|| content_revision(content.as_bytes()));
            let locator = json!({"line_from":i+1,"line_to":i+1});
            let hit = if kind == "body" {
                matcher.body_card(&vault, &rel, revision, locator, line, line_start)?
            } else {
                card(
                    &vault,
                    &rel,
                    kind,
                    locator,
                    revision,
                    &matcher.excerpt(line),
                )?
            };
            hits.push((score, hit));
        }
    }
    hits.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1["source"].as_str().cmp(&b.1["source"].as_str()))
            .then_with(|| a.1["cite"].as_str().cmp(&b.1["cite"].as_str()))
    });
    list_page(
        hits.into_iter().map(|(_, item)| item).collect(),
        cursor.as_deref(),
        &key,
        limit,
    )
}
