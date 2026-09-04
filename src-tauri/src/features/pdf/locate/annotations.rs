//! `papers/<id>/marks/annotations.json` — the EmbedPDF annotation transfer blob
//! that the viewer treats as the single source of truth for highlights/批注.
//!
//! The desktop writer is `src/lib/pdf/highlight/annotation-store.ts`; this side
//! must stay byte-compatible with it (2-space pretty JSON + trailing newline,
//! deduped by `annotation.id`).

use crate::core::error::AppError;
use crate::features::pdf_locate::{LocateMatch, NormRect};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

/// `PdfAnnotationSubtype.HIGHLIGHT` from `@embedpdf/models`.
const HIGHLIGHT_SUBTYPE: u8 = 9;
/// `HIGHLIGHT_OPACITY` from `src/lib/pdf/highlight/palette.ts`.
const HIGHLIGHT_OPACITY: f32 = 0.4;

/// `HIGHLIGHT_HEX` from `src/lib/pdf/highlight/palette.ts`. Drifting from that
/// table makes CLI highlights render in a color the picker cannot round-trip.
pub fn highlight_hex(color: &str) -> Option<&'static str> {
    match color {
        "yellow" => Some("#fcd34d"),
        "green" => Some("#86efac"),
        "blue" => Some("#7dd3fc"),
        "pink" => Some("#f9a8d4"),
        "purple" => Some("#d8b4fe"),
        _ => None,
    }
}

pub fn annotations_path(paper_dir: &Path) -> PathBuf {
    paper_dir.join("marks").join("annotations.json")
}

/// Read the transfer items, tolerating a missing or malformed file (the viewer
/// does the same — see `loadAnnotationItems`).
pub fn load(paper_dir: &Path) -> Vec<Value> {
    let path = annotations_path(paper_dir);
    let Ok(text) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Array(items)) => items,
        _ => Vec::new(),
    }
}

/// Append `items`, dropping ids that already exist, then write atomically so a
/// concurrently reading viewer never sees a half-written array.
pub fn append(paper_dir: &Path, items: Vec<Value>) -> Result<usize, AppError> {
    if items.is_empty() {
        return Ok(0);
    }
    let mut existing = load(paper_dir);
    let mut seen: Vec<String> = existing.iter().filter_map(annotation_id).collect();
    let mut added = 0;
    for item in items {
        match annotation_id(&item) {
            Some(id) if seen.contains(&id) => continue,
            Some(id) => seen.push(id),
            None => continue,
        }
        existing.push(item);
        added += 1;
    }
    if added == 0 {
        return Ok(0);
    }
    write_all(paper_dir, &existing)?;
    Ok(added)
}

/// Patch one annotation in place. Returns false when the id is unknown.
pub fn update(
    paper_dir: &Path,
    id: &str,
    contents: Option<&str>,
    color: Option<&str>,
) -> Result<bool, AppError> {
    let mut items = load(paper_dir);
    let Some(item) = items
        .iter_mut()
        .find(|i| annotation_id(i).as_deref() == Some(id))
    else {
        return Ok(false);
    };
    let Some(anno) = item.get_mut("annotation").and_then(Value::as_object_mut) else {
        return Ok(false);
    };
    if let Some(text) = contents {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            anno.remove("contents");
        } else {
            anno.insert("contents".into(), json!(trimmed));
        }
    }
    if let Some(color) = color {
        let hex = highlight_hex(color)
            .ok_or_else(|| AppError::message(format!("unknown highlight color '{color}'")))?;
        anno.insert("strokeColor".into(), json!(hex));
        let custom = anno
            .entry("custom")
            .or_insert_with(|| json!({}))
            .as_object_mut();
        if let Some(custom) = custom {
            custom.insert("paletteKey".into(), json!(color));
        }
    }
    anno.insert("modified".into(), json!(now_iso()));
    write_all(paper_dir, &items)?;
    Ok(true)
}

pub fn remove(paper_dir: &Path, id: &str) -> Result<bool, AppError> {
    let items = load(paper_dir);
    let before = items.len();
    let kept: Vec<Value> = items
        .into_iter()
        .filter(|i| annotation_id(i).as_deref() != Some(id))
        .collect();
    if kept.len() == before {
        return Ok(false);
    }
    write_all(paper_dir, &kept)?;
    Ok(true)
}

fn annotation_id(item: &Value) -> Option<String> {
    item.get("annotation")?
        .get("id")?
        .as_str()
        .map(str::to_string)
}

fn write_all(paper_dir: &Path, items: &[Value]) -> Result<(), AppError> {
    let path = annotations_path(paper_dir);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| AppError::message(format!("create marks/: {e}")))?;
    }
    let body = format!(
        "{}\n",
        serde_json::to_string_pretty(items)
            .map_err(|e| AppError::message(format!("serialize annotations: {e}")))?
    );
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body).map_err(|e| AppError::message(format!("write annotations: {e}")))?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        AppError::message(format!("replace annotations.json: {e}"))
    })?;
    Ok(())
}

/// Build a HIGHLIGHT transfer item from a locate hit. Geometry goes back to
/// page points, which is what the viewer's `segmentRects` carry.
pub fn highlight_item(
    id: &str,
    hit: &LocateMatch,
    quote: &str,
    color: &str,
    comment: Option<&str>,
    created_iso: &str,
) -> Result<Value, AppError> {
    let hex = highlight_hex(color)
        .ok_or_else(|| AppError::message(format!("unknown highlight color '{color}'")))?;
    let segments: Vec<Value> = hit
        .rects
        .iter()
        .map(|r| point_rect(r, hit.page_width, hit.page_height))
        .collect();
    let bounds = union_rect(&hit.rects).unwrap_or(NormRect {
        x: 0.0,
        y: 0.0,
        w: 1.0,
        h: 1.0,
    });
    let mut anno = json!({
        "type": HIGHLIGHT_SUBTYPE,
        "id": id,
        "pageIndex": hit.page.saturating_sub(1),
        "rect": point_rect(&bounds, hit.page_width, hit.page_height),
        "segmentRects": segments,
        "strokeColor": hex,
        "opacity": HIGHLIGHT_OPACITY,
        "created": created_iso,
        "custom": { "app": "agentero", "paletteKey": color, "quote": quote },
    });
    if let Some(text) = comment.map(str::trim).filter(|s| !s.is_empty()) {
        anno["contents"] = json!(text);
    }
    Ok(json!({ "annotation": anno }))
}

fn point_rect(r: &NormRect, page_width: f32, page_height: f32) -> Value {
    json!({
        "origin": { "x": r.x * page_width, "y": r.y * page_height },
        "size": { "width": r.w * page_width, "height": r.h * page_height },
    })
}

fn union_rect(rects: &[NormRect]) -> Option<NormRect> {
    let first = rects.first()?;
    let mut min_x = first.x;
    let mut min_y = first.y;
    let mut max_x = first.x + first.w;
    let mut max_y = first.y + first.h;
    for r in rects.iter().skip(1) {
        min_x = min_x.min(r.x);
        min_y = min_y.min(r.y);
        max_x = max_x.max(r.x + r.w);
        max_y = max_y.max(r.y + r.h);
    }
    Some(NormRect {
        x: min_x,
        y: min_y,
        w: max_x - min_x,
        h: max_y - min_y,
    })
}

/// RFC3339 UTC with milliseconds — the shape `JSON.stringify(new Date())` emits,
/// which is what the viewer reads back out of `created`.
pub fn now_iso() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// Annotation id, matching the desktop's `crypto.randomUUID()` highlights.
pub fn new_annotation_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Short url-safe id for a per-id mark file (`marks/<id>.json`).
///
/// Must come from real randomness: a clock-seeded generator repeats its k-th
/// output across runs, and two marks sharing an id inside one paper break
/// `mark get` / `mark delete` and make `[[@id]]` links ambiguous.
pub fn new_mark_id() -> String {
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-";
    uuid::Uuid::new_v4()
        .as_bytes()
        .iter()
        .take(10)
        .map(|b| ALPHABET[(*b % 64) as usize] as char)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit() -> LocateMatch {
        LocateMatch {
            page: 3,
            char_index: 10,
            char_count: 5,
            rects: vec![
                NormRect {
                    x: 0.1,
                    y: 0.2,
                    w: 0.3,
                    h: 0.02,
                },
                NormRect {
                    x: 0.1,
                    y: 0.24,
                    w: 0.2,
                    h: 0.02,
                },
            ],
            page_width: 600.0,
            page_height: 800.0,
        }
    }

    #[test]
    fn builds_highlight_in_page_points() {
        let item = highlight_item(
            "abc",
            &hit(),
            "quote",
            "yellow",
            Some("note"),
            "2026-01-01T00:00:00.000Z",
        )
        .expect("item");
        let anno = &item["annotation"];
        assert_eq!(anno["type"], 9);
        assert_eq!(anno["pageIndex"], 2);
        assert_eq!(anno["strokeColor"], "#fcd34d");
        assert_eq!(anno["contents"], "note");
        assert_eq!(anno["segmentRects"][0]["origin"]["x"], 60.0);
        assert_eq!(anno["segmentRects"][0]["size"]["width"], 180.0);
        // Union spans both lines: y 0.2..0.26 → 160..208 points.
        assert_eq!(anno["rect"]["origin"]["y"], 160.0);
        assert!((anno["rect"]["size"]["height"].as_f64().unwrap() - 48.0).abs() < 0.01);
    }

    #[test]
    fn omits_contents_without_comment() {
        let item = highlight_item(
            "abc",
            &hit(),
            "q",
            "green",
            None,
            "2026-01-01T00:00:00.000Z",
        )
        .expect("item");
        assert!(item["annotation"].get("contents").is_none());
    }

    #[test]
    fn rejects_unknown_color() {
        assert!(highlight_item("a", &hit(), "q", "chartreuse", None, "x").is_err());
    }

    #[test]
    fn append_dedupes_by_id() {
        let dir = tempfile::tempdir().expect("tmp");
        let paper = dir.path();
        let item = highlight_item("dup", &hit(), "q", "yellow", None, "x").expect("item");
        assert_eq!(append(paper, vec![item.clone()]).expect("first"), 1);
        assert_eq!(append(paper, vec![item]).expect("second"), 0);
        assert_eq!(load(paper).len(), 1);
        let raw = fs::read_to_string(annotations_path(paper)).expect("read");
        assert!(
            raw.ends_with("]\n"),
            "trailing newline like the desktop writer"
        );
    }

    #[test]
    fn update_and_remove_round_trip() {
        let dir = tempfile::tempdir().expect("tmp");
        let paper = dir.path();
        let item = highlight_item("id1", &hit(), "q", "yellow", None, "x").expect("item");
        append(paper, vec![item]).expect("append");
        assert!(update(paper, "id1", Some("hello"), Some("blue")).expect("update"));
        let items = load(paper);
        assert_eq!(items[0]["annotation"]["contents"], "hello");
        assert_eq!(items[0]["annotation"]["strokeColor"], "#7dd3fc");
        assert_eq!(items[0]["annotation"]["custom"]["paletteKey"], "blue");
        assert!(!update(paper, "missing", Some("x"), None).expect("miss"));
        assert!(remove(paper, "id1").expect("remove"));
        assert!(load(paper).is_empty());
    }
}
