use super::search::{permitted_file, resolve_source};
use super::*;
use crate::features::{
    paper::{capabilities::find_local_pdf, source::read_tex},
    pdf::layout_index,
    research_table,
};

fn layout_file(vault: &Path, paper: &str) -> Result<PathBuf> {
    existing(vault, &format!("{paper}/source/layout.json"))
}
pub(super) fn pdf_file(vault: &Path, paper: &str) -> Result<PathBuf> {
    let folder = existing(vault, paper)?;
    let path = find_local_pdf(&folder).ok_or_else(|| missing("paper has no local PDF"))?;
    existing(vault, &relative(vault, &path)?)
}
pub fn page_revision(vault: &Path, paper: &str) -> Result<String> {
    let path = if vault.join(paper).join("source/layout.json").exists() {
        layout_file(vault, paper)?
    } else {
        pdf_file(vault, paper)?
    };
    file_revision(&path)
}
fn directory_entries(vault: &Path, rel: &str) -> Result<Vec<Value>> {
    let mut entries = Vec::new();
    for e in std::fs::read_dir(existing(vault, rel)?)? {
        let e = e?;
        let path = format!("{rel}/{}", e.file_name().to_string_lossy());
        if validate_rel(&path).is_err() || !permitted_file(&path) || e.file_type()?.is_symlink() {
            continue;
        }
        let meta = e.metadata()?;
        if !meta.is_file() && !meta.is_dir() {
            continue;
        }
        entries.push(json!({"name":e.file_name().to_string_lossy(),"path":path,"kind":if meta.is_dir(){"directory"}else{"file"},"revision":format!("{}:{:?}",meta.len(),meta.modified().ok())}));
    }
    entries.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    Ok(entries)
}
pub(super) fn directory_revision(vault: &Path, rel: &str) -> Result<String> {
    Ok(content_revision(&serde_json::to_vec(&directory_entries(
        vault, rel,
    )?)?))
}
fn read_text(path: &Path) -> Result<String> {
    if path.metadata()?.len() > 32 * 1024 * 1024 {
        return Err(usage("source exceeds the 32 MiB text limit"));
    }
    let text =
        std::fs::read_to_string(path).map_err(|_| usage("source must be a UTF-8 text file"))?;
    if text.contains('\0') {
        return Err(usage("binary input is not a text source"));
    }
    Ok(text)
}
struct Fragment {
    text: String,
    locator: Value,
}
impl Fragment {
    fn new(text: String, locator: Value) -> Self {
        Self { text, locator }
    }
}

fn selected_text(text: &str, input: &ReadInput, mut loc: Value) -> Result<Fragment> {
    if let (Some(start), Some(end)) = (loc["char_from"].as_u64(), loc["char_to"].as_u64()) {
        if end < start || end > text.chars().count() as u64 {
            return Err(usage("invalid character span"));
        }
        let passage = text
            .chars()
            .skip(start as usize)
            .take((end - start) as usize)
            .collect();
        return Ok(Fragment::new(passage, loc));
    }
    if let Some(quote) = input.quote.as_deref() {
        if quote.trim().is_empty() {
            return Err(usage("quote must contain text"));
        }
        let mut positions = text.match_indices(quote);
        let (byte, _) = positions.next().ok_or_else(|| missing("quote not found"))?;
        if let Some((second, _)) = positions.next() {
            let length = quote.chars().count();
            let locators: Vec<_> = [byte, second].into_iter().chain(positions.map(|(i, _)| i))
                .take(20).map(|i| {
                    let before = &text[..i];
                    let start = before.chars().count();
                    let line = before.bytes().filter(|b| *b == b'\n').count() + 1;
                    json!({"line_from":line, "line_to":line + quote.bytes().filter(|b| *b == b'\n').count(),
                           "char_from":start, "char_to":start+length})
                }).collect();
            return Err(AppError::domain(
                "ambiguous_quote",
                "quote occurs more than once; choose a candidate citation",
            )
            .with_details(json!({"candidates":locators})));
        }
        let before = &text[..byte];
        let context = input
            .max_chars
            .unwrap_or(4000)
            .saturating_sub(quote.chars().count())
            .min(144)
            / 2;
        let start = before
            .char_indices()
            .rev()
            .take(context)
            .last()
            .map_or(byte, |(i, _)| i);
        let after = byte + quote.len();
        let end = text[after..]
            .char_indices()
            .nth(200)
            .map_or(text.len(), |(i, _)| after + i);
        let passage = &text[start..end];
        let char_from = text[..start].chars().count();
        loc["char_from"] = json!(char_from);
        loc["char_to"] = json!(char_from + passage.chars().count());
        loc["line_from"] = json!(1 + before.bytes().filter(|b| *b == b'\n').count());
        loc["line_to"] = json!(1 + text[..after].bytes().filter(|b| *b == b'\n').count());
        return Ok(Fragment::new(passage.to_owned(), loc));
    }
    let mut lines = text.lines().enumerate().peekable();
    let range = if let Some(raw) = input.lines.as_deref() {
        Some(positive_range(raw)?)
    } else if let Some(section) = &input.section {
        let is_heading = |l: &str| {
            l.starts_with('#')
                || l.trim_start().starts_with("\\section{")
                || l.trim_start().starts_with("\\subsection{")
        };
        let candidates: Vec<_> = text
            .lines()
            .enumerate()
            .filter(|(_, l)| {
                is_heading(l)
                    && l.trim_matches('#')
                        .trim()
                        .trim_end_matches('}')
                        .split('{')
                        .next_back()
                        .is_some_and(|s| s.eq_ignore_ascii_case(section))
            })
            .collect();
        let (start, heading) = match candidates.as_slice() {
            [] => return Err(missing("section not found")),
            [one] => *one,
            _ => {
                return Err(AppError::domain(
                    "ambiguous_section",
                    "heading occurs more than once; choose a candidate",
                ).with_details(json!({"candidates":candidates.iter().take(20).map(|(i,_)| json!({"line_from":i+1,"line_to":i+1})).collect::<Vec<_>>()})))
            }
        };
        let depth = heading.chars().take_while(|c| *c == '#').count();
        let end = text
            .lines()
            .enumerate()
            .skip(start + 1)
            .find(|(_, l)| {
                is_heading(l)
                    && (depth == 0 || l.chars().take_while(|c| *c == '#').count() <= depth)
            })
            .map_or(text.lines().count(), |(i, _)| i);
        loc["section"] = json!(section);
        Some((start as u32 + 1, end as u32))
    } else {
        None
    };
    if let Some((start, end)) = range {
        if end as usize > text.lines().count() {
            return Err(missing("line outside source"));
        }
        loc["line_from"] = json!(start);
        loc["line_to"] = json!(end);
        return Ok(Fragment::new(
            lines
                .by_ref()
                .skip(start as usize - 1)
                .take((end - start + 1) as usize)
                .map(|(_, l)| l)
                .collect::<Vec<_>>()
                .join("\n"),
            loc,
        ));
    }
    Ok(Fragment::new(text.to_owned(), loc))
}

struct ReadWindow<'a> {
    vault: &'a Path,
    key: &'a str,
    cursor: Option<&'a str>,
    budget: usize,
}
impl ReadWindow<'_> {
    fn cite_candidates(
        &self,
        source: &str,
        kind: &str,
        revision: &str,
        error: AppError,
    ) -> AppError {
        let Some(locators) = error.details().and_then(|d| d["candidates"].as_array()) else {
            return error;
        };
        let candidates: Vec<_> = locators
            .iter()
            .filter_map(|locator| {
                let cite = make_citation(self.vault, source, revision, kind, locator).ok()?;
                Some(json!({"locator":locator,"cite":cite}))
            })
            .collect();
        error.with_details(json!({"candidates":candidates}))
    }

    fn render(
        &self,
        source: &str,
        kind: &str,
        revision: &str,
        fragments: Vec<Fragment>,
    ) -> Result<Value> {
        let start = offset(self.cursor, self.key, revision)?;
        let mut position = 0usize;
        let mut body = String::new();
        let mut evidence = Vec::new();
        let stop = start.saturating_add(self.budget);
        for (index, f) in fragments.into_iter().enumerate() {
            if index != 0 {
                if position >= start && position < stop {
                    body.push('\n')
                }
                position += 1;
            }
            let len = f.text.chars().count();
            let end = position + len;
            if end > start && position < stop {
                let skip = start.saturating_sub(position);
                let take = stop.saturating_sub(position + skip);
                let slice: String = f.text.chars().skip(skip).take(take).collect();
                let excerpt: String = slice.chars().take(260).collect();
                evidence.push(card(
                    self.vault, source, kind, f.locator, revision, &excerpt,
                )?);
                body.push_str(&slice);
            }
            position = end;
        }
        if start > position {
            return Err(usage("cursor offset outside source"));
        }
        let next = next(self.key, revision, stop, position)?;
        Ok(
            json!({"source":source,"revision":revision,"text":body,"evidence":evidence,"truncated":next.is_some(),"next_cursor":next}),
        )
    }
}
fn raw_region(r: &layout_index::RawLayoutRegion) -> Value {
    let kind = match r.kind.as_str() {
        "image" | "chart" | "table" | "formula" | "algorithm" | "figure" => r.kind.as_str(),
        "paragraph_title" | "section" => "section",
        _ => "paragraph",
    };
    json!({"region":r.id,"page":r.page_index+1,"kind":kind,"box":[r.bbox.x,r.bbox.y,r.bbox.w,r.bbox.h],"score":r.score})
}
fn physical(
    vault: &Path,
    paper: &str,
    input: &ReadInput,
    layout_only: bool,
) -> Result<(Vec<Fragment>, Vec<Value>)> {
    let mut fragments = Vec::new();
    let mut regions = Vec::new();
    if vault.join(paper).join("source/layout.json").exists() {
        layout_file(vault, paper)?;
        let layout = layout_index::load_raw_layout(vault, paper)?;
        if let Some(id) = &input.region {
            let region = layout.regions.iter().find(|r| r.id == *id);
            let owned;
            let (page, text) = if let Some(r) = region {
                regions.push(raw_region(r));
                (
                    r.page_index + 1,
                    r.text.clone().or(r.title.clone()).unwrap_or_default(),
                )
            } else {
                if vault.join(paper).join("source/layout-index.json").exists() {
                    existing(vault, &format!("{paper}/source/layout-index.json"))?;
                }
                owned = layout_index::get_region(vault, paper, id)?;
                let r = &owned.item;
                regions.push(json!({"region":id,"page":r.page,"kind":r.kind,"box":[r.bbox.x,r.bbox.y,r.bbox.w,r.bbox.h],"score":r.score}));
                (
                    r.page,
                    r.text.clone().or(r.title.clone()).unwrap_or_default(),
                )
            };
            fragments.push(Fragment::new(text, json!({"page":page,"region":id})));
        } else {
            let count = layout_index::page_count(&layout);
            let pages = input.pages.clone().unwrap_or_else(|| (1..=count).collect());
            for page in pages {
                if page > count {
                    return Err(missing("page outside source"));
                }
                let rows = layout_index::page_regions(&layout, page - 1);
                let body = rows
                    .iter()
                    .filter_map(|r| r.text.as_deref().or(r.title.as_deref()))
                    .collect::<Vec<_>>()
                    .join("\n");
                fragments.push(Fragment::new(body, json!({"page":page})));
                if layout_only {
                    regions.extend(rows.into_iter().map(raw_region));
                }
            }
        }
    } else if layout_only || input.region.is_some() {
        return Err(AppError::domain(
            "missing_layout",
            "run agentero paper analyze for this paper",
        ));
    } else {
        #[cfg(not(any(target_os = "ios", target_os = "android")))]
        {
            let pdf = std::fs::read(pdf_file(vault, paper)?)?;
            let result =
                crate::features::pdf::text::extract_text(&pdf, input.pages.as_deref(), usize::MAX)?;
            if input
                .pages
                .as_ref()
                .is_some_and(|p| p.iter().any(|n| *n > result.page_count))
            {
                return Err(missing("page outside PDF"));
            }
            fragments.extend(
                result
                    .pages
                    .into_iter()
                    .map(|p| Fragment::new(p.text, json!({"page":p.page}))),
            );
        }
        #[cfg(any(target_os = "ios", target_os = "android"))]
        return Err(missing("native PDF text is unavailable on this platform"));
    }
    Ok((fragments, regions))
}

// Preserve source text when a TeX command occurs in the middle of a source line.
fn tex_section(text: &str, section: &str) -> Result<Fragment> {
    static HEADINGS: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(
            r"\\(chapter|section|subsection|subsubsection)\*?\s*(?:\[[^\]]*\]\s*)?\{([^{}]*)\}",
        )
        .unwrap()
    });
    let headings: Vec<_> = HEADINGS.captures_iter(text).collect();
    let mut matches = headings
        .iter()
        .enumerate()
        .filter(|(_, h)| h[2].trim().eq_ignore_ascii_case(section));
    let (index, first) = matches.next().ok_or_else(|| missing("section not found"))?;
    if matches.next().is_some() {
        return Err(AppError::domain(
            "ambiguous_section",
            "section occurs more than once",
        ));
    }
    let level = |s: &str| match s {
        "chapter" => 0,
        "section" => 1,
        "subsection" => 2,
        _ => 3,
    };
    let end = headings[index + 1..]
        .iter()
        .find(|h| level(&h[1]) <= level(&first[1]))
        .map_or(text.len(), |h| h.get(0).unwrap().start());
    Ok(Fragment::new(
        text[first.get(0).unwrap().start()..end].to_owned(),
        json!({"section":section}),
    ))
}

fn layout_section(vault: &Path, paper: &str, section: &str) -> Result<Option<Fragment>> {
    layout_file(vault, paper)?;
    let layout = layout_index::load_raw_layout(vault, paper)?;
    let heading = |r: &layout_index::RawLayoutRegion| {
        r.kind.contains("title")
            || r.kind.contains("header")
            || r.kind.contains("section")
            || r.kind == "heading"
    };
    let mut matches = layout.regions.iter().enumerate().filter(|(_, r)| {
        heading(r)
            && r.title
                .as_deref()
                .or(r.text.as_deref())
                .is_some_and(|s| s.trim().eq_ignore_ascii_case(section))
    });
    let Some((i, first)) = matches.next() else {
        return Ok(None);
    };
    if matches.next().is_some() {
        return Err(AppError::domain(
            "ambiguous_section",
            "layout section occurs more than once",
        ));
    }
    let text = std::iter::once(first)
        .chain(layout.regions[i + 1..].iter().take_while(|r| !heading(r)))
        .filter_map(|r| r.text.as_deref().or(r.title.as_deref()))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(Some(Fragment::new(
        text,
        json!({"page":first.page_index+1,"section":section}),
    )))
}

pub fn read(vault: &Path, mut input: ReadInput, full_text: bool) -> Result<Value> {
    let cursor = input.cursor.take();
    let key = query_key(vault, &input)?;
    let budget = input.max_chars.unwrap_or(4000);
    if !(1..=20_000).contains(&budget) {
        return Err(usage("max_chars must be 1..20000"));
    }
    let window = ReadWindow {
        vault,
        key: &key,
        cursor: cursor.as_deref(),
        budget,
    };
    let selectors = [
        input.pages.is_some(),
        input.region.is_some(),
        input.section.is_some(),
        input.quote.is_some(),
        input.lines.is_some(),
    ]
    .into_iter()
    .filter(|x| *x)
    .count();
    if selectors > 1 {
        return Err(usage("provide one locator"));
    }
    let mut locator = json!({});
    let mut source = if input.source.starts_with("agentero://cite/") {
        if selectors != 0 {
            return Err(usage("citation already specifies its location"));
        }
        let (path, loc) = resolve_citation(vault, &input.source)?;
        locator = loc;
        if input.part.is_none()
            && decode_citation(vault, &input.source)?.kind == "body"
            && existing(vault, &path)?.is_dir()
        {
            input.part = Some("body".into())
        }
        if let Some(region) = locator["region"].as_str() {
            input.region = Some(region.into())
        } else if let Some(s) = locator["section"].as_str() {
            input.section = Some(s.into())
        } else if let Some(pg) = locator["page"].as_u64() {
            input.pages = Some(vec![u32::try_from(pg).map_err(|_| usage("invalid page"))?])
        } else if let Some(n) = locator["line_from"].as_u64() {
            input.lines = Some(format!("{n}-{}", locator["line_to"].as_u64().unwrap_or(n)))
        }
        path
    } else {
        resolve_source(vault, &input.source)?
    };
    if let Some(pages) = input.pages.as_mut() {
        let n = pages.len();
        pages.sort_unstable();
        pages.dedup();
        if n == 0 || n > 200 || n != pages.len() || pages[0] == 0 {
            return Err(usage("pages must contain 1..200 distinct positive numbers"));
        }
    }
    let part = input.part.as_deref().unwrap_or("auto");
    if !matches!(part, "auto" | "body" | "notes" | "metadata" | "layout") {
        return Err(usage("unknown part"));
    }
    if part == "layout" && input.region.is_none() && input.pages.as_ref().map(Vec::len) != Some(1) {
        return Err(usage("layout needs one page or region"));
    }
    let absolute = existing(vault, &source)?;
    let record = if absolute.is_dir() {
        paper(vault, &source)?
    } else {
        None
    };
    if let Some(record) = record {
        if part == "metadata"
            || (part == "auto"
                && input.region.is_none()
                && input.pages.is_none()
                && input.section.is_none()
                && input.quote.is_none()
                && input.lines.is_none())
        {
            if selectors > 0 {
                return Err(usage("metadata does not accept a locator"));
            }
            let revision = content_revision(&serde_json::to_vec(&record)?);
            let text = format!(
                "{}\n{}\n{}",
                record.title,
                record.authors.join(", "),
                record.abstract_text.as_deref().unwrap_or("")
            );
            let mut out = window.render(
                &source,
                "metadata",
                &revision,
                vec![Fragment::new(text, json!({}))],
            )?;
            out["metadata"] = paper_detail(vault, &record, false)?;
            return Ok(out);
        }
        if part == "notes" {
            if input.region.is_some() || input.pages.is_some() {
                return Err(usage("notes use text locators"));
            }
            source = format!("{source}/NOTES.md");
            if !vault.join(&source).exists() {
                return window.render(&source, "note", "missing", vec![]);
            }
        } else {
            if !full_text {
                return Err(AppError::domain(
                    "full_text_required",
                    "paper body requires the full-text grant",
                ));
            }
            if input.region.is_some() || input.pages.is_some() {
                if (part == "layout" || input.region.is_some())
                    && !absolute.join("source/layout.json").is_file()
                {
                    return Err(AppError::domain(
                        "missing_layout",
                        "run agentero paper analyze for this paper",
                    ));
                }
                let rev = page_revision(vault, &source)?;
                let (mut fragments, mut regions) =
                    physical(vault, &source, &input, part == "layout")?;
                if locator.get("char_from").is_some() {
                    let [fragment] = fragments.as_mut_slice() else {
                        return Err(usage("a character span selects one page or region"));
                    };
                    *fragment = selected_text(&fragment.text, &input, locator)?;
                }
                let mut out = window.render(&source, "body", &rev, fragments)?;
                if part == "layout" {
                    for r in &mut regions {
                        r["cite"] = json!(make_citation(
                            vault,
                            &source,
                            &rev,
                            "body",
                            &json!({"region":r["region"],"page":r["page"]})
                        )?)
                    }
                    out["regions"] = json!(regions);
                }
                return Ok(out);
            }
            if let Some(tex) = read_tex(&absolute) {
                // The combined TeX text has its own revision; a citation identifies
                // the paper body (not the bytes of just its main .tex file).
                let revision = content_revision(tex.text.as_bytes());
                let fragment = if let Some(section) = &input.section {
                    tex_section(&tex.text, section)?
                } else {
                    selected_text(&tex.text, &input, locator)
                        .map_err(|e| window.cite_candidates(&source, "body", &revision, e))?
                };
                return window.render(&source, "body", &revision, vec![fragment]);
            }
            if let Some(section) = &input.section {
                if absolute.join("source/layout.json").exists() {
                    if let Some(fragment) = layout_section(vault, &source, section)? {
                        return window.render(
                            &source,
                            "body",
                            &page_revision(vault, &source)?,
                            vec![fragment],
                        );
                    }
                }
            }
            if vault.join(&source).join("PAPER.md").exists() {
                source = format!("{source}/PAPER.md");
            } else {
                let rev = page_revision(vault, &source)?;
                let (fragments, _) = physical(vault, &source, &input, false)?;
                if input.quote.is_some() || input.lines.is_some() || input.section.is_some() {
                    let combined = fragments
                        .iter()
                        .map(|f| f.text.as_str())
                        .collect::<Vec<_>>()
                        .join("\n");
                    let fragment = selected_text(&combined, &input, locator)
                        .map_err(|e| window.cite_candidates(&source, "body", &rev, e))?;
                    return window.render(&source, "body", &rev, vec![fragment]);
                }
                return window.render(&source, "body", &rev, fragments);
            }
        }
    } else if absolute.is_dir() {
        if part != "auto" || selectors > 0 {
            return Err(usage("directory has no text locator"));
        }
        let entries = directory_entries(vault, &source)?;
        let revision = content_revision(&serde_json::to_vec(&entries)?);
        let start = offset(cursor.as_deref(), &key, &revision)?;
        if start > entries.len() {
            return Err(usage("invalid directory offset"));
        }
        let end = start.saturating_add(50).min(entries.len());
        let next = next(&key, &revision, end, entries.len())?;
        return Ok(
            json!({"source":source,"revision":revision,"entries":&entries[start..end],"evidence":[],"truncated":next.is_some(),"next_cursor":next}),
        );
    } else if part != "auto" {
        return Err(usage("part applies to paper directories"));
    }
    if input.region.is_some() || input.pages.is_some() {
        return Err(usage("physical page and region selectors require a paper"));
    }
    if !permitted_file(&source) {
        return Err(denied());
    }
    let path = existing(vault, &source)?;
    source = relative(vault, &path)?;
    if !permitted_file(&source) {
        return Err(denied());
    }
    let kind = source_kind(vault, &source)?;
    if kind == "body" && !full_text {
        return Err(AppError::domain(
            "full_text_required",
            "paper asset requires full-text access",
        ));
    }
    let text = read_text(&path)?;
    let revision = content_revision(text.as_bytes());
    let fragment =
        if let (Some(row), Some(field)) = (locator["row"].as_str(), locator["field"].as_str()) {
            let rows = research_table::evidence_rows(&text)
                .map_err(|e| AppError::domain("invalid_table", e.to_string()))?;
            let value = rows
                .iter()
                .find(|r| r.public_id == row)
                .and_then(|r| r.values.get(field))
                .ok_or_else(|| missing("table cell not found"))?;
            Fragment::new(
                value
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| value.to_string()),
                locator,
            )
        } else {
            selected_text(&text, &input, locator)
                .map_err(|e| window.cite_candidates(&source, kind, &revision, e))?
        };
    window.render(&source, kind, &revision, vec![fragment])
}
