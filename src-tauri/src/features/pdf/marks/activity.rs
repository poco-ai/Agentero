//! Batch reading-activity reader for the Library heatmap.
//!
//! Reads the same per-mark sidecar files the renderer's mark stores use
//! (`papers/<id>/marks/*.json`, excluding the aggregate `annotations.json`)
//! and returns only the minimal fields the heatmap aggregation needs.
//! One IPC round-trip replaces the previous per-paper
//! `listPdfHighlights` + `listPdfAskThreads` + `listPdfTranslates` fan-out.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

/// Aggregate EmbedPDF annotations file under `marks/` (not a per-id mark).
const ANNOTATIONS_JSON: &str = "annotations.json";

/// Minimal activity point mirrored by `ReadingActivityPoint` in
/// `src/lib/paper/reading-heatmap/types.ts`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReadingActivityPoint {
    /// `highlight` | `ask` | `translate`.
    pub kind: String,
    /// 1-based page.
    pub page: u32,
    /// 0–1 vertical position on the page (mid of rects).
    pub y: f64,
    /// Contribution weight (≥ 1).
    pub weight: f64,
}

fn is_rect(v: &Value) -> bool {
    let Some(obj) = v.as_object() else {
        return false;
    };
    ["x", "y", "w", "h"]
        .iter()
        .all(|k| obj.get(*k).is_some_and(Value::is_number))
}

/// Mid-y of normalized rects; defaults to 0.5 when empty (matches
/// `meanRectY` in `src/lib/paper/reading-heatmap/aggregate.ts`).
fn mean_rect_y(rects: &[Value]) -> f64 {
    if rects.is_empty() {
        return 0.5;
    }
    let mut sum = 0.0;
    for r in rects {
        let y = r.get("y").and_then(Value::as_f64).unwrap_or(0.0);
        let h = r.get("h").and_then(Value::as_f64).unwrap_or(0.0);
        sum += y + h / 2.0;
    }
    let y = sum / rects.len() as f64;
    if !y.is_finite() {
        return 0.5;
    }
    y.clamp(0.0, 1.0)
}

fn non_empty_str(v: Option<&Value>) -> bool {
    v.and_then(Value::as_str).is_some_and(|s| !s.is_empty())
}

fn is_str(v: Option<&Value>) -> bool {
    v.is_some_and(Value::is_string)
}

fn finite_page(v: Option<&Value>) -> Option<u32> {
    let n = v?.as_f64()?;
    if !n.is_finite() {
        return None;
    }
    Some(n.floor().max(1.0) as u32)
}

fn rects_of(v: Option<&Value>) -> Option<&Vec<Value>> {
    let rects = v?.as_array()?;
    if rects.iter().all(is_rect) {
        Some(rects)
    } else {
        None
    }
}

/// Common `version: 1` + string id/paperPath/createdAt envelope shared by
/// the highlight/ask/translate schemas in `src/lib/pdf/*/schema.ts`.
fn valid_envelope(obj: &serde_json::Map<String, Value>) -> bool {
    obj.get("version").and_then(Value::as_i64) == Some(1)
        && non_empty_str(obj.get("id"))
        && is_str(obj.get("paperPath"))
        && is_str(obj.get("createdAt"))
}

/// Parse one mark JSON into a heatmap point, mirroring the renderer schemas
/// (`parsePdfHighlight` / `parsePdfAskThread` / `parsePdfTranslateRecord`).
/// Unknown kinds and invalid payloads yield `None`.
fn point_from_mark(raw: &Value) -> Option<ReadingActivityPoint> {
    let obj = raw.as_object()?;
    if !valid_envelope(obj) {
        return None;
    }
    match obj.get("kind").and_then(Value::as_str)? {
        "highlight" => {
            if !is_str(obj.get("updatedAt")) || !is_str(obj.get("quote")) {
                return None;
            }
            let page = finite_page(obj.get("page"))?;
            let rects = rects_of(obj.get("rects"))?;
            Some(ReadingActivityPoint {
                kind: "highlight".into(),
                page,
                y: mean_rect_y(rects),
                weight: 1.0,
            })
        }
        "ask" => {
            if !is_str(obj.get("updatedAt")) {
                return None;
            }
            let status = obj.get("status").and_then(Value::as_str)?;
            if status != "open" && status != "ended" {
                return None;
            }
            let anchor = obj.get("anchor")?.as_object()?;
            let page = finite_page(anchor.get("page"))?;
            let rects = rects_of(anchor.get("rects"))?;
            let trigger = anchor.get("trigger").and_then(Value::as_str)?;
            if !matches!(trigger, "selection" | "dblclick" | "dwell" | "region") {
                return None;
            }
            let messages = obj.get("messages")?.as_array()?;
            let mut turns: u64 = 0;
            for m in messages {
                let m = m.as_object()?;
                if !is_str(m.get("id")) || !is_str(m.get("content")) || !is_str(m.get("createdAt"))
                {
                    return None;
                }
                let role = m.get("role").and_then(Value::as_str)?;
                if !matches!(role, "user" | "assistant" | "system") {
                    return None;
                }
                if role != "system" {
                    turns += 1;
                }
            }
            Some(ReadingActivityPoint {
                kind: "ask".into(),
                page,
                y: mean_rect_y(rects),
                // Dialogue intensity: at least 1; more turns → hotter.
                weight: turns.max(1) as f64,
            })
        }
        "translate" => {
            let page = finite_page(obj.get("page"))?;
            let rects = rects_of(obj.get("rects"))?;
            Some(ReadingActivityPoint {
                kind: "translate".into(),
                page,
                y: mean_rect_y(rects),
                weight: 1.0,
            })
        }
        _ => None,
    }
}

/// Read one paper folder's `marks/*.json` into activity points.
/// Missing folder, unreadable files, and corrupt JSON are skipped silently
/// (same behavior as the renderer's `listMarkRaw`).
fn read_paper_activity(paper_dir: &Path) -> Vec<ReadingActivityPoint> {
    let marks = paper_dir.join("marks");
    let Ok(entries) = std::fs::read_dir(&marks) else {
        return Vec::new();
    };
    let mut points = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.ends_with(".json") || name == ANNOTATIONS_JSON {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        let Ok(raw) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if let Some(point) = point_from_mark(&raw) {
            points.push(point);
        }
    }
    points
}

/// Collect activity points for many papers keyed by vault-relative path.
/// Invalid paths map to empty lists so the renderer never falls back to
/// per-paper IPC reads.
pub fn collect_reading_activity(
    vault: &Path,
    paths: &[String],
) -> HashMap<String, Vec<ReadingActivityPoint>> {
    let mut out = HashMap::with_capacity(paths.len());
    for raw in paths {
        let key = raw.trim().trim_matches('/').replace('\\', "/");
        if key.is_empty() || out.contains_key(&key) {
            continue;
        }
        let points = match crate::core::fs::sanitize_vault_rel(&key) {
            Ok(rel) => read_paper_activity(&vault.join(rel)),
            Err(_) => Vec::new(),
        };
        out.insert(key, points);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;
    use uuid::Uuid;

    fn temp_vault(name: &str) -> PathBuf {
        let vault = std::env::temp_dir().join(format!(
            "agentero-reading-activity-{name}-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&vault).expect("create temp vault");
        vault
    }

    fn write_mark(paper_dir: &Path, id: &str, payload: &Value) {
        let marks = paper_dir.join("marks");
        fs::create_dir_all(&marks).expect("create marks dir");
        fs::write(
            marks.join(format!("{id}.json")),
            serde_json::to_string_pretty(payload).expect("serialize mark"),
        )
        .expect("write mark");
    }

    fn highlight(id: &str, page: u32) -> Value {
        json!({
            "version": 1,
            "kind": "highlight",
            "id": id,
            "paperPath": "papers/x",
            "createdAt": "2024-01-01T00:00:00Z",
            "updatedAt": "2024-01-01T00:00:00Z",
            "page": page,
            "rects": [{ "x": 0.1, "y": 0.2, "w": 0.5, "h": 0.2 }],
            "quote": "q"
        })
    }

    fn ask(id: &str, page: u32, user_turns: usize) -> Value {
        let messages: Vec<Value> = (0..user_turns)
            .map(|i| {
                json!({
                    "id": format!("m{i}"),
                    "role": if i % 2 == 0 { "user" } else { "assistant" },
                    "content": "hi",
                    "createdAt": "2024-01-01T00:00:00Z"
                })
            })
            .collect();
        json!({
            "version": 1,
            "kind": "ask",
            "id": id,
            "paperPath": "papers/x",
            "createdAt": "2024-01-01T00:00:00Z",
            "updatedAt": "2024-01-01T00:00:00Z",
            "status": "open",
            "anchor": {
                "page": page,
                "rects": [{ "x": 0.0, "y": 0.4, "w": 0.4, "h": 0.2 }],
                "trigger": "selection"
            },
            "messages": messages
        })
    }

    fn translate(id: &str, page: u32) -> Value {
        json!({
            "version": 1,
            "kind": "translate",
            "id": id,
            "paperPath": "papers/x",
            "createdAt": "2024-01-01T00:00:00Z",
            "page": page,
            "rects": [{ "x": 0.0, "y": 0.8, "w": 0.9, "h": 0.1 }]
        })
    }

    #[test]
    fn parses_the_three_mark_kinds_with_renderer_semantics() {
        let vault = temp_vault("kinds");
        let paper = vault.join("papers/x");
        write_mark(&paper, "h1", &highlight("h1", 3));
        write_mark(&paper, "a1", &ask("a1", 5, 4));
        write_mark(&paper, "t1", &translate("t1", 2));

        let mut points = read_paper_activity(&paper);
        points.sort_by(|a, b| a.kind.cmp(&b.kind));

        assert_eq!(points.len(), 3);
        assert_eq!(points[0].kind, "ask");
        assert_eq!(points[0].page, 5);
        assert_eq!(points[0].weight, 4.0, "ask weight = non-system turns");
        assert!((points[0].y - 0.5).abs() < 1e-9, "y = mean(rect.y + h/2)");
        assert_eq!(points[1].kind, "highlight");
        assert_eq!(points[1].page, 3);
        assert!((points[1].y - 0.3).abs() < 1e-9);
        assert_eq!(points[2].kind, "translate");
        assert_eq!(points[2].weight, 1.0);
        fs::remove_dir_all(vault).ok();
    }

    #[test]
    fn skips_corrupt_invalid_and_aggregate_files() {
        let vault = temp_vault("invalid");
        let paper = vault.join("papers/x");
        write_mark(&paper, "ok", &highlight("ok", 1));
        // Aggregate EmbedPDF store is not a per-id mark.
        fs::write(paper.join("marks/annotations.json"), "{}").expect("write annotations");
        // Corrupt JSON, wrong version, unknown kind.
        fs::write(paper.join("marks/broken.json"), "{ nope").expect("write corrupt");
        write_mark(&paper, "v2", &json!({ "version": 2, "kind": "highlight" }));
        write_mark(
            &paper,
            "visual",
            &json!({ "version": 1, "kind": "visual", "id": "v", "paperPath": "p", "createdAt": "t" }),
        );
        // Ask with zero messages still counts with weight 1.
        write_mark(&paper, "a0", &ask("a0", 2, 0));

        let points = read_paper_activity(&paper);
        assert_eq!(points.len(), 2);
        assert!(points.iter().any(|p| p.kind == "ask" && p.weight == 1.0));
        fs::remove_dir_all(vault).ok();
    }

    #[test]
    fn collect_handles_missing_and_escaping_paths() {
        let vault = temp_vault("collect");
        let paper = vault.join("papers/x");
        write_mark(&paper, "h1", &highlight("h1", 1));

        let out = collect_reading_activity(
            &vault,
            &[
                "papers/x".into(),
                "papers\\x".into(), // dedupes with the normalized key
                "papers/missing".into(),
                "../escape".into(),
                "".into(),
            ],
        );
        assert_eq!(out.len(), 3);
        assert_eq!(out["papers/x"].len(), 1);
        assert!(out["papers/missing"].is_empty());
        assert!(out["../escape"].is_empty(), "escaping path yields empty");
        fs::remove_dir_all(vault).ok();
    }

    /// Perf smoke: 50 papers × 4 marks each read in one batch. Prints the
    /// wall time so perf reports can quote a number.
    #[test]
    fn batch_reads_50_papers_with_marks_quickly() {
        let vault = temp_vault("perf");
        let mut paths = Vec::new();
        for i in 0..50 {
            let rel = format!("papers/p{i}");
            let paper = vault.join(&rel);
            write_mark(&paper, "h1", &highlight("h1", 1 + i % 9));
            write_mark(&paper, "h2", &highlight("h2", 2 + i % 7));
            write_mark(&paper, "a1", &ask("a1", 3 + i % 5, 3));
            write_mark(&paper, "t1", &translate("t1", 4 + i % 3));
            paths.push(rel);
        }

        let start = std::time::Instant::now();
        let out = collect_reading_activity(&vault, &paths);
        let elapsed = start.elapsed();
        eprintln!(
            "collect_reading_activity: 50 papers × 4 marks in {:.2?} ({} µs)",
            elapsed,
            elapsed.as_micros()
        );

        assert_eq!(out.len(), 50);
        assert!(out.values().all(|points| points.len() == 4));
        assert!(
            elapsed.as_millis() < 2_000,
            "batch read should stay well under IPC-storm territory"
        );
        fs::remove_dir_all(vault).ok();
    }
}
