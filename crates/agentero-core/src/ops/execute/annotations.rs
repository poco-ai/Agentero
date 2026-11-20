//! Read and edit the same annotations and per-mark records as the desktop PDF viewer.
use crate::error::AppError;
use crate::features::catalog::papers::PaperRecord;
use crate::features::import::pdf_parse::run_pdf_locate;
use crate::features::layout_index::LayoutIndexItem;
use crate::features::{
    evidence, layout_index,
    pdf_locate::{annotations, LocateMatch, LocateRequest, NormRect},
};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

fn usage(s: &str) -> AppError {
    AppError::domain("usage", s)
}
fn text<'a>(a: &'a Value, k: &str) -> Option<&'a str> {
    a[k].as_str()
}
fn required<'a>(a: &'a Value, k: &str) -> Result<&'a str, AppError> {
    text(a, k).ok_or_else(|| usage(&format!("{k} is required")))
}

fn check_child(path: &Path) -> Result<(), AppError> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_symlink() => Err(AppError::domain(
            "scope_denied",
            "managed annotation assets cannot be symbolic links",
        )),
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}
fn managed(vault: &Path, paper: &PaperRecord) -> Result<PathBuf, AppError> {
    let (dir, _) = crate::fs::resolve_paper_dir(vault, &paper.path)?;
    if !dir.canonicalize()?.starts_with(vault.canonicalize()?) {
        return Err(AppError::domain("scope_denied", "paper path escapes vault"));
    }
    let marks = dir.join("marks");
    check_child(&marks)?;
    check_child(&marks.join("annotations.json"))?;
    Ok(dir)
}

fn records(dir: &Path) -> Result<Vec<Value>, AppError> {
    let mut records = Vec::new();
    let marks = dir.join("marks");
    if !marks.is_dir() {
        return Ok(records);
    }
    for entry in marks.read_dir()? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        check_child(&path)?;
        if path.file_name().is_some_and(|s| s == "annotations.json") {
            let aggregate: Value = serde_json::from_slice(&fs::read(&path)?)?;
            if !aggregate.is_null() && !aggregate.is_object() && !aggregate.is_array() {
                return Err(usage("invalid annotation collection"));
            }
            records.extend(annotations::load(dir));
        } else {
            let record: Value = serde_json::from_slice(&fs::read(path)?)?;
            if record.get("id").and_then(Value::as_str).is_some() {
                records.push(record)
            }
        }
    }
    Ok(records)
}
fn id(raw: &Value) -> Option<&str> {
    raw["annotation"]["id"].as_str().or(raw["id"].as_str())
}
fn record_path(dir: &Path, id: &str) -> Result<PathBuf, AppError> {
    if id.is_empty()
        || id == "annotations"
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(usage("invalid annotation ID"));
    }
    let path = dir.join("marks").join(format!("{id}.json"));
    check_child(&path)?;
    Ok(path)
}
fn item(
    vault: &Path,
    p: &PaperRecord,
    raw: &Value,
    page_revision: Option<&str>,
) -> Result<Value, AppError> {
    let anno = &raw["annotation"];
    let page = anno["pageIndex"]
        .as_u64()
        .map(|i| i + 1)
        .or(raw["page"].as_u64())
        .or(raw["anchor"]["page"].as_u64());
    let kind = if anno.is_object() {
        "highlight"
    } else {
        raw["kind"].as_str().unwrap_or("agent-trace")
    };
    let mut loc = json!({});
    if let Some(page) = page {
        loc["page"] = json!(page);
    }
    let cite = match (page, page_revision) {
        (Some(_), Some(revision)) => {
            evidence::make_citation(vault, &p.path, revision, "body", &loc)?
        }
        _ => evidence::make_citation(
            vault,
            &p.path,
            &evidence::content_revision(&serde_json::to_vec(p)?),
            "metadata",
            &json!({}),
        )?,
    };
    Ok(
        json!({"id":id(raw),"paper":p.path,"kind":kind,"cite":cite,"locator":loc,"revision":evidence::content_revision(&serde_json::to_vec(raw)?),
        "comment":anno["contents"].as_str().or(raw["comment"].as_str()),"color":anno["custom"]["paletteKey"].as_str(),
        "question":raw.pointer("/messages/0/content").and_then(Value::as_str),"translation":raw["result"].as_str()}),
    )
}
pub(crate) async fn execute(
    vault: &Path,
    name: &str,
    args: Value,
    full_text: bool,
) -> Result<Value, AppError> {
    let paper =
        crate::features::paper::catalog::papers::resolve_paper(vault, required(&args, "paper")?)?;
    let dir = managed(vault, &paper)?;
    let all = records(&dir)?;
    if name == "annotation_add" {
        if args["quote"].is_string() && !full_text {
            return Err(AppError::domain("full_text_required", "Locating a free-form quote requires full-text access. Use a returned excerpt citation or a region."));
        }
        return add(vault, &dir, &paper, &args, &all, full_text).await;
    }
    let page_revision = evidence::page_revision(vault, &paper.path).ok();
    if name == "annotation_list" {
        let mut items = all
            .iter()
            .map(|raw| item(vault, &paper, raw, page_revision.as_deref()))
            .collect::<Result<Vec<_>, _>>()?;
        items.retain(|m| {
            args["kind"]
                .as_array()
                .is_none_or(|kinds| kinds.contains(&m["kind"]))
                && args["page"]
                    .as_u64()
                    .is_none_or(|page| m["locator"]["page"] == page)
        });
        items.sort_by(|a, b| {
            (a["locator"]["page"].as_u64(), a["id"].as_str())
                .cmp(&(b["locator"]["page"].as_u64(), b["id"].as_str()))
        });
        return super::paginate(vault, &args, items);
    }
    let key = required(&args, "id")?;
    let raw = all
        .into_iter()
        .find(|r| id(r) == Some(key))
        .ok_or_else(|| AppError::domain("mark_not_found", "annotation not found"))?;
    let current = item(vault, &paper, &raw, page_revision.as_deref())?;
    if name == "annotation_get" {
        return Ok(current);
    }
    if required(&args, "if_revision")? != current["revision"] {
        return Err(AppError::domain(
            "revision_conflict",
            "annotation changed; read it again before writing",
        )
        .with_details(json!({"actual":current["revision"],"expected":args["if_revision"]})));
    }
    let path = record_path(&dir, key)?;
    if name == "annotation_remove" {
        if raw["annotation"].is_object() {
            annotations::remove(&dir, key)?;
        } else {
            fs::remove_file(path)?;
        }
        return Ok(
            json!({"changed":true,"preview":false,"items":[{"id":key,"outcome":"removed"}]}),
        );
    }
    let c = text(&args, "comment");
    let color = text(&args, "color");
    if name != "annotation_update" || c.is_none() && color.is_none() {
        return Err(usage("provide comment or color"));
    }
    if raw["annotation"].is_object() {
        annotations::update(&dir, key, c, color)?;
    } else {
        if color.is_some() {
            return Err(usage("color applies only to highlights"));
        }
        let mut next = raw;
        next["comment"] = json!(c);
        next["updatedAt"] = json!(annotations::now_iso());
        crate::fs::atomic_write(&path, &serde_json::to_vec_pretty(&next)?)?;
        let saved = serde_json::from_slice(&fs::read(path)?)?;
        return item(vault, &paper, &saved, page_revision.as_deref());
    }
    let next = annotations::load(&dir)
        .into_iter()
        .find(|r| id(r) == Some(key))
        .ok_or_else(|| AppError::domain("mark_not_found", "annotation was removed"))?;
    item(vault, &paper, &next, page_revision.as_deref())
}

async fn add(
    vault: &Path,
    dir: &Path,
    paper: &PaperRecord,
    a: &Value,
    existing: &[Value],
    full_text: bool,
) -> Result<Value, AppError> {
    let kind = text(a, "kind").unwrap_or("highlight");
    let question = text(a, "question");
    let color = text(a, "color").unwrap_or("yellow");
    if !matches!(kind, "ask" | "highlight" | "translate") || kind == "ask" && question.is_none() {
        return Err(usage("ask annotations require a question"));
    }
    if ["quote", "region", "cite"]
        .iter()
        .filter(|k| text(a, k).is_some())
        .count()
        != 1
    {
        return Err(usage("select one of quote, region or cite"));
    }
    if (a["all_matches"] == true || a["occurrence"].is_number() || a["page"].is_number())
        && a["quote"].is_null()
    {
        return Err(usage("page, occurrence and all-matches require a quote"));
    }
    if a["all_matches"] == true && a["occurrence"].is_number() {
        return Err(usage("choose occurrence or all-matches"));
    }
    let mut quote = text(a, "quote").map(str::to_owned);
    let mut region = text(a, "region").map(str::to_owned);
    let mut page = a["page"].as_u64().map(|v| v as u32);
    if let Some(cite) = text(a, "cite") {
        let (source, loc) = evidence::resolve_citation(vault, cite)?;
        if source != paper.path && !Path::new(&source).starts_with(&paper.path) {
            return Err(usage("citation belongs to another paper"));
        }
        region = loc["region"].as_str().map(str::to_owned);
        page = loc["page"].as_u64().map(|n| n as u32);
        let excerpt = loc["char_from"].is_u64() && loc["char_to"].is_u64();
        if region.is_none() || (excerpt && full_text) {
            if !full_text {
                return Err(AppError::domain(
                    "full_text_required",
                    "Use an issued excerpt citation or a public region",
                ));
            }
            let input = serde_json::from_value(
                json!({"source":cite,"max_chars":if excerpt {260} else {120}}),
            )?;
            quote = evidence::read(vault, input, full_text)?["text"]
                .as_str()
                .map(str::to_owned);
            if excerpt {
                // Search spans can name a raw paragraph with no public region anchor.
                // Locate the issued words on their physical page.
                region = None;
            }
        }
    }
    let pdf = crate::features::paper::capabilities::find_local_pdf(dir)
        .ok_or_else(|| AppError::domain("source_not_found", "paper has no local PDF"))?;
    check_child(&pdf)?;
    let (hits, quote, layout) = if let Some(region) = region {
        for rel in ["source", "source/layout-index.json", "source/layout.json"] {
            check_child(&dir.join(rel))?;
        }
        let entry = layout_index::load_region(vault, &paper.path, &region)?;
        let layout = layout_ref_value(&entry);
        (
            vec![region_anchor(&pdf, &entry).await?],
            quote
                .or_else(|| full_text.then_some(entry.title).flatten())
                .unwrap_or(region),
            Some(layout),
        )
    } else {
        let quote = quote
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| usage("a citation must resolve to locatable text or a region"))?;
        let mut request = LocateRequest::new(&quote);
        request.page = page;
        let hits = run_pdf_locate(&pdf, &request).await?;
        let mut hits = hits.matches;
        if hits.is_empty() {
            return Err(AppError::domain(
                "source_not_found",
                "quote not found on requested pages",
            ));
        }
        if a["all_matches"] != true {
            if hits.len() > 1 && a["occurrence"].is_null() {
                return Err(AppError::domain(
                    "ambiguous",
                    format!("quote found {} times; specify occurrence", hits.len()),
                ).with_details(json!({"candidates":hits.iter().enumerate().map(|(i,h)|json!({"occurrence":i+1,"page":h.page})).collect::<Vec<_>>()})));
            }
            let index = a["occurrence"]
                .as_u64()
                .unwrap_or(1)
                .checked_sub(1)
                .ok_or_else(|| usage("occurrence starts at one"))? as usize;
            if index >= hits.len() {
                return Err(usage("occurrence exceeds match count"));
            }
            hits = vec![hits.remove(index)];
        }
        (hits, quote, None)
    };
    let translated = if kind == "translate" {
        let target = required(a, "language")?;
        if let Some(text) = text(a, "translation") {
            Some(text.to_string())
        } else {
            use crate::features::translate::{translate_text, TranslateTextArgs};
            Some(
                translate_text(TranslateTextArgs {
                    text: quote.clone(),
                    source_lang: "auto".into(),
                    target_lang: target.into(),
                    provider: "tencenttransmart".into(),
                    glossary: None,
                    dictionary: false,
                    dictionary_surrounding: None,
                    dictionary_reference: None,
                    custom_prompt: None,
                    custom_system: None,
                    custom_user: None,
                    api_key: None,
                    base_url: None,
                    region: None,
                    model: None,
                    extra_request_body: None,
                    timeout_ms: None,
                })
                .await?
                .text,
            )
        }
    } else {
        None
    };
    let now = annotations::now_iso();
    let mut written_ids = Vec::new();
    fs::create_dir_all(dir.join("marks"))?;
    let mut new_highlights = Vec::new();
    let request_id = required(a, "request_id")?;
    for (ordinal, hit) in hits.into_iter().enumerate() {
        let digest = super::hash(&serde_json::to_vec(&(
            paper.id.as_str(),
            request_id,
            ordinal,
        ))?);
        let mark_id = if kind == "highlight" {
            format!(
                "{}-{}-{}-{}-{}",
                &digest[..8],
                &digest[8..12],
                &digest[12..16],
                &digest[16..20],
                &digest[20..32]
            )
        } else {
            digest[..24].to_owned()
        };
        written_ids.push(mark_id.clone());
        if existing.iter().any(|r| id(r) == Some(&mark_id)) {
            continue;
        }
        let id = mark_id;
        let raw = match kind {
            "highlight" => {
                let mut val = annotations::highlight_item(
                    &id,
                    &hit,
                    &quote,
                    color,
                    text(a, "comment"),
                    &now,
                )?;
                if let Some(l) = &layout {
                    val["annotation"]["custom"]["layoutRef"] = l.clone()
                }
                val
            }
            "ask" => build_ask_mark(
                &id,
                &paper.path,
                &now,
                &hit,
                &quote,
                question,
                text(a, "comment"),
                layout.clone(),
            ),
            _ => build_translate_mark(
                &id,
                &paper.path,
                &now,
                &hit,
                &quote,
                translated.as_deref().unwrap_or_default(),
            ),
        };
        if kind != "highlight" {
            crate::fs::atomic_write(&record_path(dir, &id)?, &serde_json::to_vec_pretty(&raw)?)?;
        } else {
            new_highlights.push(raw);
        }
    }
    if !new_highlights.is_empty() {
        annotations::append(dir, new_highlights)?;
    }
    let page_revision = evidence::page_revision(vault, &paper.path).ok();
    // Hash persisted geometry so revisions match a subsequent annotation_get.
    let saved = records(dir)?;
    let saved: std::collections::HashMap<_, _> = saved
        .iter()
        .filter_map(|raw| id(raw).map(|id| (id, raw)))
        .collect();
    let items = written_ids
        .iter()
        .map(|id| {
            let raw = saved.get(id.as_str()).ok_or_else(|| {
                AppError::domain("mark_not_found", "Persisted annotation was removed")
            })?;
            item(vault, paper, raw, page_revision.as_deref())
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({"items":items,"next_cursor":null}))
}

async fn region_anchor(pdf: &Path, region: &LayoutIndexItem) -> Result<LocateMatch, AppError> {
    let result = run_pdf_locate(pdf, &LocateRequest::measure(vec![region.page]))
        .await
        .map_err(|e| AppError::message(e.to_string()))?;
    let size = result
        .pages
        .into_iter()
        .find(|p| p.page == region.page)
        .ok_or_else(|| {
            AppError::message(format!(
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
