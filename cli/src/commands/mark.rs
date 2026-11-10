//! `agentero mark *` — reading marks: highlight/批注 (annotations.json),
//! ask shells and translate records (per-id `marks/<id>.json`).
//!
//! Text anchors are resolved with the PDFium text engine (`pdf_locate`), the
//! same engine the viewer selects with, so a CLI highlight lands exactly where
//! a hand-drawn one would. Coordinates are never hand-computed here.
//!
//! @see docs/backend/cli.md
//! @see docs/backend/cli.md

use crate::commands::layout as layout_cmd;
use crate::error::{CliError, ExitCode};
use crate::prompt;
use crate::resolve::{paper_dir, resolve_paper, resolve_vault, GlobalOpts};
use agentero_core::features::catalog::probe_paper_caps;
use agentero_core::features::import::pdf_parse::run_pdf_locate;
use agentero_core::features::layout_index::LayoutIndexItem;
use agentero_core::features::pdf_locate::{annotations, LocateMatch, LocateRequest, NormRect};
use clap::{Subcommand, ValueHint};
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

#[derive(Debug, Subcommand)]
pub enum MarkCmd {
    /// List marks: per-id files under `{paper}/marks/` plus highlights.
    List {
        /// Vault-relative paper path or id.
        #[arg(value_hint = ValueHint::DirPath)]
        r#ref: String,
        /// Filter by kind (highlight|ask|translate|agent-trace).
        #[arg(
            long = "kind",
            value_name = "KIND",
            value_parser = ["highlight", "ask", "translate", "agent-trace"]
        )]
        kind: Option<String>,
    },
    /// Get one mark by id.
    Get {
        #[arg(value_hint = ValueHint::DirPath)]
        r#ref: String,
        /// Mark id. Accepts a leading `-`: ids are nanoids and that alphabet
        /// includes `-`, so ~1 in 64 would otherwise parse as an unknown flag.
        #[arg(allow_hyphen_values = true)]
        id: String,
    },
    /// Add a mark. `--quote` locates the text in the PDF; `--region` anchors to
    /// a `layout list` figure/table/formula box.
    Add {
        #[arg(value_hint = ValueHint::DirPath)]
        r#ref: String,
        /// Layout index region id from `layout list` (resolved geometry).
        #[arg(long = "region", value_name = "ID")]
        region: Option<String>,
        /// Mark kind (default: highlight; ask when --question set).
        #[arg(
            long = "kind",
            value_name = "KIND",
            value_parser = ["highlight", "ask", "translate"]
        )]
        kind: Option<String>,
        /// Annotation note / comment. On a highlight this is the 批注 body.
        #[arg(long = "comment", value_name = "TEXT")]
        comment: Option<String>,
        /// Optional user question for kind=ask.
        #[arg(long = "question", value_name = "TEXT")]
        question: Option<String>,
        /// Highlight color (yellow|green|blue|pink|purple). Default yellow (desktop palette).
        /// Named `--mark-color` to avoid clashing with global `--color` (ANSI TTY paint).
        #[arg(
            long = "mark-color",
            value_name = "NAME",
            default_value = "yellow",
            value_parser = ["yellow", "green", "blue", "pink", "purple"]
        )]
        mark_color: String,
        /// Sentence to mark. Located with the PDF text engine; whitespace and
        /// case differences are tolerated. With --region it overrides the title.
        #[arg(long = "quote", value_name = "TEXT")]
        quote: Option<String>,
        /// 1-based page hint. Disambiguates a quote that occurs several times.
        #[arg(long = "page", value_name = "N")]
        page: Option<u32>,
        /// Which occurrence to use when the quote matches more than once.
        #[arg(long = "match-index", value_name = "N", default_value = "0")]
        match_index: usize,
        /// Mark every occurrence instead of just one.
        #[arg(long = "all")]
        all: bool,
        /// Translation target language for kind=translate (default zh-CN).
        #[arg(long = "to", value_name = "LANG", default_value = "zh-CN")]
        to: String,
        /// Pre-translated text for kind=translate; skips machine translation.
        #[arg(long = "result", value_name = "TEXT")]
        result: Option<String>,
    },
    /// Update a mark's comment or color.
    Update {
        #[arg(value_hint = ValueHint::DirPath)]
        r#ref: String,
        /// Mark id. Accepts a leading `-` (see `Get`).
        #[arg(allow_hyphen_values = true)]
        id: String,
        /// New comment; empty string clears it.
        #[arg(long = "comment", value_name = "TEXT")]
        comment: Option<String>,
        /// New highlight color.
        #[arg(
            long = "mark-color",
            value_name = "NAME",
            value_parser = ["yellow", "green", "blue", "pink", "purple"]
        )]
        mark_color: Option<String>,
    },
    /// Delete a mark (per-id file or highlight annotation).
    Delete {
        #[arg(value_hint = ValueHint::DirPath)]
        r#ref: String,
        /// Mark id. Accepts a leading `-` (see `Get`).
        #[arg(allow_hyphen_values = true)]
        id: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MarkListItem {
    id: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    page: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    geometry: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    quote: Option<String>,
    path: String,
}

/// Everything `add` needs after clap parsing.
struct AddOpts<'a> {
    ref_: &'a str,
    region: Option<&'a str>,
    kind: Option<&'a str>,
    comment: Option<&'a str>,
    question: Option<&'a str>,
    mark_color: &'a str,
    quote: Option<&'a str>,
    page: Option<u32>,
    match_index: usize,
    all: bool,
    to: &'a str,
    result: Option<&'a str>,
}

pub async fn run(cmd: MarkCmd, globals: &GlobalOpts) -> Result<Value, CliError> {
    match cmd {
        MarkCmd::List { r#ref, kind } => list(globals, &r#ref, kind.as_deref()),
        MarkCmd::Get { r#ref, id } => get(globals, &r#ref, &id),
        MarkCmd::Add {
            r#ref,
            region,
            kind,
            comment,
            question,
            mark_color,
            quote,
            page,
            match_index,
            all,
            to,
            result,
        } => {
            add(
                globals,
                AddOpts {
                    ref_: &r#ref,
                    region: region.as_deref(),
                    kind: kind.as_deref(),
                    comment: comment.as_deref(),
                    question: question.as_deref(),
                    mark_color: &mark_color,
                    quote: quote.as_deref(),
                    page,
                    match_index,
                    all,
                    to: &to,
                    result: result.as_deref(),
                },
            )
            .await
        }
        MarkCmd::Update {
            r#ref,
            id,
            comment,
            mark_color,
        } => update(
            globals,
            &r#ref,
            &id,
            comment.as_deref(),
            mark_color.as_deref(),
        ),
        MarkCmd::Delete { r#ref, id } => delete(globals, &r#ref, &id),
    }
}

fn list(globals: &GlobalOpts, ref_: &str, kind: Option<&str>) -> Result<Value, CliError> {
    let vault = resolve_vault(globals)?;
    let paper = resolve_paper(&vault, ref_, globals)?;
    let dir = paper_dir(&vault, &paper.path);
    let marks_dir = dir.join("marks");
    let mut items: Vec<MarkListItem> = Vec::new();

    if marks_dir.is_dir() {
        let rd = fs::read_dir(&marks_dir)
            .map_err(|e| CliError::message(format!("failed to read marks/: {e}")))?;
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".json") || name == "annotations.json" {
                continue;
            }
            let id = name.trim_end_matches(".json").to_string();
            let path = entry.path();
            let Ok(text) = fs::read_to_string(&path) else {
                continue;
            };
            let Ok(raw) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            let k = raw
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if let Some(filter) = kind {
                if !k.eq_ignore_ascii_case(filter) {
                    continue;
                }
            }
            let page = raw.get("page").and_then(|v| v.as_u64()).or_else(|| {
                raw.get("anchor")
                    .and_then(|a| a.get("page"))
                    .and_then(|v| v.as_u64())
            });
            let geometry = raw
                .get("geometry")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let quote = raw
                .get("quote")
                .and_then(|v| v.as_str())
                .or_else(|| {
                    raw.get("anchor")
                        .and_then(|a| a.get("quote"))
                        .and_then(|v| v.as_str())
                })
                .map(|s| s.to_string());
            items.push(MarkListItem {
                id,
                kind: k,
                page,
                geometry,
                quote,
                path: format!("{}/marks/{name}", paper.path),
            });
        }
    }

    // Highlights/批注 live in the aggregate annotations blob, not per-id files.
    if kind.is_none_or(|k| k.eq_ignore_ascii_case("highlight")) {
        for item in annotations::load(&dir) {
            let anno = item.get("annotation").unwrap_or(&Value::Null);
            let Some(id) = anno.get("id").and_then(|v| v.as_str()) else {
                continue;
            };
            items.push(MarkListItem {
                id: id.to_string(),
                kind: "highlight".into(),
                page: anno
                    .get("pageIndex")
                    .and_then(|v| v.as_u64())
                    .map(|p| p + 1),
                geometry: Some("resolved".into()),
                quote: anno
                    .get("custom")
                    .and_then(|c| c.get("quote"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                path: format!("{}/marks/annotations.json", paper.path),
            });
        }
    }

    items.sort_by(|a, b| a.id.cmp(&b.id));
    let lines: Vec<String> = if items.is_empty() {
        vec!["(no marks)".into()]
    } else {
        items
            .iter()
            .map(|i| {
                format!(
                    "{}  {}  page={}  {}",
                    i.id,
                    i.kind,
                    i.page.map(|p| p.to_string()).unwrap_or_else(|| "-".into()),
                    i.quote.as_deref().unwrap_or("")
                )
            })
            .collect()
    };
    Ok(json!({
        "paperPath": paper.path,
        "count": items.len(),
        "items": items,
        "lines": lines,
    }))
}

fn get(globals: &GlobalOpts, ref_: &str, id: &str) -> Result<Value, CliError> {
    let vault = resolve_vault(globals)?;
    let paper = resolve_paper(&vault, ref_, globals)?;
    let dir = paper_dir(&vault, &paper.path);
    let path = mark_file(&vault, &paper.path, id);
    if path.is_file() {
        let text = fs::read_to_string(&path)
            .map_err(|e| CliError::message(format!("failed to read mark: {e}")))?;
        let raw: Value = serde_json::from_str(&text)
            .map_err(|e| CliError::message(format!("invalid mark JSON: {e}")))?;
        return Ok(json!({
            "paperPath": paper.path,
            "path": format!("{}/marks/{id}.json", paper.path),
            "mark": raw,
            "lines": [text.trim_end()],
        }));
    }
    if let Some(item) = annotations::load(&dir).into_iter().find(|i| {
        i.get("annotation")
            .and_then(|a| a.get("id"))
            .and_then(Value::as_str)
            == Some(id)
    }) {
        let pretty = serde_json::to_string_pretty(&item).unwrap_or_default();
        return Ok(json!({
            "paperPath": paper.path,
            "path": format!("{}/marks/annotations.json", paper.path),
            "mark": item,
            "lines": [pretty],
        }));
    }
    Err(CliError::with_details(
        "mark_not_found",
        format!("mark not found: {id}"),
        json!({ "paperPath": paper.path, "id": id }),
        ExitCode::Business,
    ))
}

async fn add(globals: &GlobalOpts, opts: AddOpts<'_>) -> Result<Value, CliError> {
    let vault = resolve_vault(globals)?;
    let paper = resolve_paper(&vault, opts.ref_, globals)?;
    let dir = paper_dir(&vault, &paper.path);
    let kind = resolve_kind(opts.kind, opts.question)?;
    let color = normalize_mark_color(opts.mark_color)?;
    let quote_arg = opts.quote.map(str::trim).filter(|s| !s.is_empty());

    let (anchors, layout_ref) = match opts.region {
        Some(region_id) => {
            let region = layout_cmd::load_region(&vault, &paper.path, region_id.trim())?;
            let quote = quote_arg
                .map(str::to_string)
                .or_else(|| region.title.clone())
                .unwrap_or_else(|| format!("{} {}", region.section, region.id));
            (
                vec![(region_anchor(&dir, &region).await?, quote)],
                Some(layout_ref_value(&region)),
            )
        }
        None => {
            let Some(quote) = quote_arg else {
                return Err(CliError::usage(
                    "mark add needs --quote \"<sentence>\" or --region <id> from `layout list`",
                ));
            };
            let hits = locate(&dir, quote, opts.page).await?;
            let picked = pick_matches(hits, quote, opts.page, opts.match_index, opts.all)?;
            (
                picked.into_iter().map(|m| (m, quote.to_string())).collect(),
                None,
            )
        }
    };

    let now = annotations::now_iso();
    let mut written: Vec<Value> = Vec::new();
    let mut ids: Vec<String> = Vec::new();
    let mut transfer_items: Vec<Value> = Vec::new();

    // One quote, one translation — `--all` must not fire N identical requests.
    let translation = if kind == "translate" {
        let quote = anchors.first().map(|(_, q)| q.as_str()).unwrap_or_default();
        Some(resolve_translation(opts.result, quote, opts.to).await?)
    } else {
        None
    };

    for (hit, quote) in &anchors {
        let id = if kind == "highlight" {
            annotations::new_annotation_id()
        } else {
            annotations::new_mark_id()
        };
        match kind.as_str() {
            "highlight" => {
                let mut item =
                    annotations::highlight_item(&id, hit, quote, &color, opts.comment, &now)
                        .map_err(|e| CliError::message(e.to_string()))?;
                // `custom` round-trips through EmbedPDF, so the region a
                // highlight came from stays recoverable.
                if let Some(layout) = layout_ref.clone() {
                    item["annotation"]["custom"]["layoutRef"] = layout;
                }
                written.push(item.clone());
                transfer_items.push(item);
            }
            "ask" => {
                let mark = build_ask_mark(
                    &id,
                    &paper.path,
                    &now,
                    hit,
                    quote,
                    opts.question,
                    opts.comment,
                    layout_ref.clone(),
                );
                write_mark_file(&dir, &id, &mark)?;
                written.push(mark);
            }
            "translate" => {
                let result = translation.as_deref().unwrap_or_default();
                let mark = build_translate_mark(&id, &paper.path, &now, hit, quote, result);
                write_mark_file(&dir, &id, &mark)?;
                written.push(mark);
            }
            other => {
                return Err(CliError::usage(format!("unsupported --kind '{other}'")));
            }
        }
        ids.push(id);
    }

    if !transfer_items.is_empty() {
        annotations::append(&dir, transfer_items).map_err(|e| CliError::message(e.to_string()))?;
    }

    let target = if kind == "highlight" {
        format!("{}/marks/annotations.json", paper.path)
    } else {
        format!("{}/marks/<id>.json", paper.path)
    };
    let lines: Vec<String> = ids
        .iter()
        .zip(anchors.iter())
        .map(|(id, (hit, _))| format!("wrote {kind} {id}  page={}  → {target}", hit.page))
        .collect();

    Ok(json!({
        "paperPath": paper.path,
        "kind": kind,
        "ids": ids,
        "count": ids.len(),
        "path": target,
        "marks": written,
        "lines": lines,
    }))
}

fn update(
    globals: &GlobalOpts,
    ref_: &str,
    id: &str,
    comment: Option<&str>,
    color: Option<&str>,
) -> Result<Value, CliError> {
    if comment.is_none() && color.is_none() {
        return Err(CliError::usage(
            "nothing to update: pass --comment or --mark-color",
        ));
    }
    let vault = resolve_vault(globals)?;
    let paper = resolve_paper(&vault, ref_, globals)?;
    let dir = paper_dir(&vault, &paper.path);

    if annotations::update(&dir, id, comment, color)
        .map_err(|e| CliError::message(e.to_string()))?
    {
        return Ok(json!({
            "paperPath": paper.path,
            "id": id,
            "path": format!("{}/marks/annotations.json", paper.path),
            "lines": [format!("updated highlight {id}")],
        }));
    }

    let path = mark_file(&vault, &paper.path, id);
    if !path.is_file() {
        return Err(CliError::with_details(
            "mark_not_found",
            format!("mark not found: {id}"),
            json!({ "paperPath": paper.path, "id": id }),
            ExitCode::Business,
        ));
    }
    let text = fs::read_to_string(&path)
        .map_err(|e| CliError::message(format!("failed to read mark: {e}")))?;
    let mut raw: Value = serde_json::from_str(&text)
        .map_err(|e| CliError::message(format!("invalid mark JSON: {e}")))?;
    if color.is_some() && raw.get("kind").and_then(Value::as_str) != Some("highlight") {
        return Err(CliError::usage("--mark-color only applies to highlights"));
    }
    if let Some(c) = comment {
        let trimmed = c.trim();
        if trimmed.is_empty() {
            if let Some(obj) = raw.as_object_mut() {
                obj.remove("comment");
            }
        } else {
            raw["comment"] = json!(trimmed);
        }
    }
    raw["updatedAt"] = json!(annotations::now_iso());
    let id_owned = id.trim().to_string();
    write_mark_file(&dir, &id_owned, &raw)?;
    Ok(json!({
        "paperPath": paper.path,
        "id": id,
        "path": format!("{}/marks/{id}.json", paper.path),
        "mark": raw,
        "lines": [format!("updated {id}")],
    }))
}

fn delete(globals: &GlobalOpts, ref_: &str, id: &str) -> Result<Value, CliError> {
    let vault = resolve_vault(globals)?;
    let paper = resolve_paper(&vault, ref_, globals)?;
    let dir = paper_dir(&vault, &paper.path);
    let path = mark_file(&vault, &paper.path, id);
    let in_annotations = annotations::load(&dir).iter().any(|i| {
        i.get("annotation")
            .and_then(|a| a.get("id"))
            .and_then(Value::as_str)
            == Some(id)
    });
    if !path.is_file() && !in_annotations {
        return Err(CliError::with_details(
            "mark_not_found",
            format!("mark not found: {id}"),
            json!({ "paperPath": paper.path, "id": id }),
            ExitCode::Business,
        ));
    }
    if !globals.yes {
        let ok = prompt::confirm(
            globals,
            &format!("Delete mark {id} under {}?", paper.path),
            false,
        )?;
        if !ok {
            return Err(CliError::needs_confirmation("delete cancelled"));
        }
    }
    if in_annotations {
        annotations::remove(&dir, id).map_err(|e| CliError::message(e.to_string()))?;
        return Ok(json!({
            "paperPath": paper.path,
            "id": id,
            "deleted": true,
            "lines": [format!("deleted highlight {id} from {}/marks/annotations.json", paper.path)],
        }));
    }
    fs::remove_file(&path).map_err(|e| CliError::message(format!("failed to delete mark: {e}")))?;
    Ok(json!({
        "paperPath": paper.path,
        "id": id,
        "deleted": true,
        "lines": [format!("deleted {}/marks/{id}.json", paper.path)],
    }))
}

fn paper_pdf(dir: &Path) -> Result<std::path::PathBuf, CliError> {
    probe_paper_caps(dir).pdf_path.ok_or_else(|| {
        CliError::with_details(
            "paper_pdf_missing",
            "this paper has no local PDF to locate text in",
            json!({ "paperDir": dir.to_string_lossy() }),
            ExitCode::Business,
        )
    })
}

async fn locate(dir: &Path, quote: &str, page: Option<u32>) -> Result<Vec<LocateMatch>, CliError> {
    let pdf = paper_pdf(dir)?;
    let mut request = LocateRequest::new(quote);
    request.page = page;
    let result = run_pdf_locate(&pdf, &request)
        .await
        .map_err(|e| CliError::message(e.to_string()))?;
    Ok(result.matches)
}

/// Region boxes are stored normalized, so the page size comes from the engine.
async fn region_anchor(dir: &Path, region: &LayoutIndexItem) -> Result<LocateMatch, CliError> {
    let pdf = paper_pdf(dir)?;
    let result = run_pdf_locate(&pdf, &LocateRequest::measure(vec![region.page]))
        .await
        .map_err(|e| CliError::message(e.to_string()))?;
    let size = result
        .pages
        .into_iter()
        .find(|p| p.page == region.page)
        .ok_or_else(|| {
            CliError::message(format!(
                "region {} points at page {}, which the PDF does not have",
                region.id, region.page
            ))
        })?;
    Ok(LocateMatch {
        page: region.page,
        char_index: -1,
        char_count: 0,
        rects: vec![NormRect {
            x: region.bbox.x as f32,
            y: region.bbox.y as f32,
            w: region.bbox.w as f32,
            h: region.bbox.h as f32,
        }],
        page_width: size.width,
        page_height: size.height,
    })
}

fn pick_matches(
    hits: Vec<LocateMatch>,
    quote: &str,
    page: Option<u32>,
    match_index: usize,
    all: bool,
) -> Result<Vec<LocateMatch>, CliError> {
    if hits.is_empty() {
        return Err(CliError::with_details(
            "mark_locate_failed",
            "could not find that quote in the PDF; try a longer, more distinctive sentence copied verbatim",
            json!({ "quote": quote, "page": page }),
            ExitCode::Business,
        ));
    }
    if all {
        return Ok(hits);
    }
    let total = hits.len();
    hits.into_iter()
        .nth(match_index)
        .map(|m| vec![m])
        .ok_or_else(|| {
            CliError::with_details(
                "mark_match_index_out_of_range",
                format!("--match-index {match_index} but the quote matched {total} time(s)"),
                json!({ "quote": quote, "matches": total }),
                ExitCode::Business,
            )
        })
}

async fn resolve_translation(
    provided: Option<&str>,
    quote: &str,
    target: &str,
) -> Result<String, CliError> {
    if let Some(text) = provided.map(str::trim).filter(|s| !s.is_empty()) {
        return Ok(text.to_string());
    }
    let out = crate::commands::translate::run_raw(quote, target, "auto", None).await?;
    Ok(out)
}

fn resolve_kind(kind: Option<&str>, question: Option<&str>) -> Result<String, CliError> {
    if let Some(k) = kind {
        let t = k.trim().to_ascii_lowercase();
        if t == "highlight" || t == "ask" || t == "translate" {
            return Ok(t);
        }
        return Err(CliError::usage(
            "--kind must be highlight, ask or translate",
        ));
    }
    if question.map(str::trim).filter(|s| !s.is_empty()).is_some() {
        return Ok("ask".into());
    }
    Ok("highlight".into())
}

/// Same palette as desktop `DEFAULT_HIGHLIGHT_COLOR` / `HIGHLIGHT_COLORS`.
fn normalize_mark_color(raw: &str) -> Result<String, CliError> {
    let t = raw.trim().to_ascii_lowercase();
    match t.as_str() {
        "yellow" | "green" | "blue" | "pink" | "purple" => Ok(t),
        other => Err(CliError::usage(format!(
            "unknown --mark-color '{other}' (use yellow|green|blue|pink|purple; default yellow)"
        ))),
    }
}

fn rects_value(hit: &LocateMatch) -> Value {
    Value::Array(
        hit.rects
            .iter()
            .map(|r| json!({ "x": r.x, "y": r.y, "w": r.w, "h": r.h }))
            .collect(),
    )
}

fn layout_ref_value(region: &LayoutIndexItem) -> Value {
    json!({
        "regionId": region.id,
        "stableKey": region.stable_key,
        "kind": region.kind,
        "section": region.section,
        "layoutRegionId": region.layout_region_id,
        "title": region.title,
    })
}

#[allow(clippy::too_many_arguments)]
fn build_ask_mark(
    id: &str,
    paper_path: &str,
    now: &str,
    hit: &LocateMatch,
    quote: &str,
    question: Option<&str>,
    comment: Option<&str>,
    layout_ref: Option<Value>,
) -> Value {
    let mut messages = Vec::new();
    let q = question
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| comment.map(str::trim).filter(|s| !s.is_empty()));
    if let Some(content) = q {
        messages.push(json!({
            "id": format!("{id}-q"),
            "role": "user",
            "content": content,
            "createdAt": now,
        }));
    }
    let mut mark = json!({
        "version": 1,
        "kind": "ask",
        "id": id,
        "paperPath": paper_path,
        "createdAt": now,
        "updatedAt": now,
        "status": "open",
        "geometry": "resolved",
        "anchor": {
            "page": hit.page,
            "rects": rects_value(hit),
            "quote": quote,
            "trigger": if layout_ref.is_some() { "region" } else { "selection" },
        },
        "messages": messages,
    });
    if let Some(layout) = layout_ref {
        mark["layoutRef"] = layout;
    }
    mark
}

fn build_translate_mark(
    id: &str,
    paper_path: &str,
    now: &str,
    hit: &LocateMatch,
    quote: &str,
    result: &str,
) -> Value {
    json!({
        "version": 1,
        "kind": "translate",
        "id": id,
        "paperPath": paper_path,
        "createdAt": now,
        "updatedAt": now,
        "page": hit.page,
        "rects": rects_value(hit),
        "quote": quote,
        "result": result,
        "geometry": "resolved",
    })
}

fn write_mark_file(dir: &Path, id: &str, mark: &Value) -> Result<(), CliError> {
    let marks_dir = dir.join("marks");
    fs::create_dir_all(&marks_dir)
        .map_err(|e| CliError::message(format!("failed to create marks/: {e}")))?;
    let body = format!(
        "{}\n",
        serde_json::to_string_pretty(mark)
            .map_err(|e| CliError::message(format!("serialize mark: {e}")))?
    );
    fs::write(marks_dir.join(format!("{id}.json")), body)
        .map_err(|e| CliError::message(format!("failed to write mark: {e}")))?;
    Ok(())
}

fn mark_file(vault: &Path, paper_path: &str, id: &str) -> std::path::PathBuf {
    let id = id.trim();
    paper_dir(vault, paper_path)
        .join("marks")
        .join(format!("{id}.json"))
}
