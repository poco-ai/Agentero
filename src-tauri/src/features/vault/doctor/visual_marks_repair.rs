//! Migrate legacy visual marks (`kind: agent-trace`, flat agent fields)
//! to v2 nested shape (`kind: visual`, optional `agent` object).

use super::{issue, DoctorIssue, DoctorSeverity};
use crate::core::error::AppError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualMarkCandidate {
    /// Vault-relative path e.g. `papers/foo/marks/abc.json`
    pub path: String,
    pub mark_id: String,
    pub reason: String,
    pub fixable: bool,
    pub selected_by_default: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualMarksDoctorSection {
    pub ok: bool,
    pub checked_files: u32,
    pub candidates: Vec<VisualMarkCandidate>,
    pub issues: Vec<DoctorIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualMarkRepairChange {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualMarkRepairResult {
    pub updated_paths: Vec<String>,
}

fn normalize_rel(raw: &str) -> String {
    raw.replace('\\', "/").trim_matches('/').to_string()
}

fn walk_mark_json_files(vault: &Path) -> Vec<PathBuf> {
    let papers = vault.join("papers");
    if !papers.is_dir() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let Ok(paper_entries) = fs::read_dir(&papers) else {
        return out;
    };
    for entry in paper_entries.flatten() {
        let marks = entry.path().join("marks");
        if !marks.is_dir() {
            continue;
        }
        let Ok(files) = fs::read_dir(&marks) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name.ends_with(".json") && name != "annotations.json" {
                out.push(path);
            }
        }
    }
    out.sort();
    out
}

fn vault_relative(vault: &Path, absolute: &Path) -> Option<String> {
    absolute
        .strip_prefix(vault)
        .ok()
        .map(|p| normalize_rel(&p.to_string_lossy()))
}

/// Detect whether a mark JSON needs v1 → v2 visual migration.
pub fn is_legacy_visual_mark(value: &Value) -> bool {
    let Some(obj) = value.as_object() else {
        return false;
    };
    let kind = obj.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    if kind == "agent-trace" {
        return true;
    }
    if kind != "visual" {
        return false;
    }
    // Already nested v2
    if obj.get("agent").map(|a| a.is_object()).unwrap_or(false)
        && obj.get("version").and_then(|v| v.as_u64()) == Some(2)
        && !obj.contains_key("agentId")
    {
        return false;
    }
    // kind visual but still flat agent fields or version 1
    if obj.get("agentId").and_then(|v| v.as_str()).is_some() {
        return true;
    }
    obj.get("version").and_then(|v| v.as_u64()) == Some(1)
}

/// Convert a legacy visual mark object into nested v2 visual JSON.
/// Returns None when the payload is not a migratable visual mark.
pub fn migrate_visual_mark_value(raw: &Value) -> Option<Value> {
    let obj = raw.as_object()?;
    let kind = obj.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    if kind != "agent-trace" && kind != "visual" {
        return None;
    }
    if !is_legacy_visual_mark(raw) {
        return None;
    }

    let id = obj.get("id").and_then(|v| v.as_str())?.to_string();
    let paper_path = obj
        .get("paperPath")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let page = obj.get("page").cloned().unwrap_or(json!(1));
    let rects = obj.get("rects").cloned().unwrap_or(json!([]));
    let comment = obj
        .get("comment")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let created_at = obj
        .get("createdAt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let updated_at = obj
        .get("updatedAt")
        .and_then(|v| v.as_str())
        .unwrap_or(&created_at)
        .to_string();

    let mut out = Map::new();
    out.insert("version".into(), json!(2));
    out.insert("kind".into(), json!("visual"));
    out.insert("id".into(), json!(id));
    out.insert("paperPath".into(), json!(paper_path));
    out.insert("page".into(), page);
    out.insert("rects".into(), rects);
    out.insert("comment".into(), json!(comment));
    out.insert("createdAt".into(), json!(created_at));
    out.insert("updatedAt".into(), json!(updated_at));

    if let Some(image) = obj.get("image").and_then(|v| v.as_object()) {
        if let Some(path) = image.get("path").and_then(|v| v.as_str()) {
            let mut img = Map::new();
            img.insert("path".into(), json!(path));
            img.insert(
                "mimeType".into(),
                json!(image
                    .get("mimeType")
                    .and_then(|v| v.as_str())
                    .unwrap_or("image/png")),
            );
            out.insert("image".into(), Value::Object(img));
        }
    }

    // Prefer nested agent if partially present; else lift flat fields.
    let agent_src = obj
        .get("agent")
        .and_then(|v| v.as_object())
        .cloned()
        .or_else(|| {
            let agent_id = obj.get("agentId").and_then(|v| v.as_str())?;
            if agent_id.is_empty() {
                return None;
            }
            let mut flat = Map::new();
            for key in [
                "agentId",
                "runtimeSessionId",
                "messageId",
                "providerSessionId",
                "status",
                "messages",
                "answerSnapshot",
                "sources",
                "error",
            ] {
                if let Some(v) = obj.get(key) {
                    flat.insert(key.to_string(), v.clone());
                }
            }
            if let Some(index) = obj.get("index") {
                flat.insert("index".into(), index.clone());
            }
            Some(flat)
        });

    if let Some(mut agent) = agent_src {
        // Ensure required agent keys exist when migrating v1.
        if !agent.contains_key("agentId") {
            if let Some(v) = obj.get("agentId") {
                agent.insert("agentId".into(), v.clone());
            }
        }
        if agent
            .get("agentId")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .is_some()
            && agent
                .get("runtimeSessionId")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .is_some()
            && agent
                .get("messageId")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .is_some()
            && agent
                .get("status")
                .and_then(|v| v.as_str())
                .is_some_and(|s| matches!(s, "running" | "completed" | "failed"))
        {
            out.insert("agent".into(), Value::Object(agent));
        }
    }

    // At least comment or agent required
    let has_comment = out
        .get("comment")
        .and_then(|v| v.as_str())
        .is_some_and(|s| !s.trim().is_empty());
    let has_agent = out.get("agent").map(|a| a.is_object()).unwrap_or(false);
    if !has_comment && !has_agent {
        return None;
    }

    Some(Value::Object(out))
}

pub fn scan_visual_marks(vault: &Path) -> VisualMarksDoctorSection {
    let mut section = VisualMarksDoctorSection {
        ok: true,
        ..Default::default()
    };
    for path in walk_mark_json_files(vault) {
        section.checked_files += 1;
        let rel = match vault_relative(vault, &path) {
            Some(r) => r,
            None => continue,
        };
        let raw = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(error) => {
                section.ok = false;
                section.issues.push(issue(
                    "visual_mark_unreadable",
                    format!("could not read mark: {error}"),
                    DoctorSeverity::Warning,
                    Some(rel),
                ));
                continue;
            }
        };
        let value: Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(error) => {
                section.ok = false;
                section.issues.push(issue(
                    "visual_mark_invalid_json",
                    format!("invalid mark JSON: {error}"),
                    DoctorSeverity::Warning,
                    Some(rel),
                ));
                continue;
            }
        };
        let kind = value.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        if kind != "agent-trace" && kind != "visual" {
            continue;
        }
        if !is_legacy_visual_mark(&value) {
            continue;
        }
        let mark_id = value
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let can_migrate = migrate_visual_mark_value(&value).is_some();
        let reason = if kind == "agent-trace" {
            "legacy kind agent-trace (v1 flat agent fields)".to_string()
        } else {
            "visual mark missing nested agent v2 shape".to_string()
        };
        section.candidates.push(VisualMarkCandidate {
            path: rel.clone(),
            mark_id,
            reason: reason.clone(),
            fixable: can_migrate,
            selected_by_default: can_migrate,
        });
        section.issues.push(issue(
            "visual_mark_v1",
            reason,
            DoctorSeverity::Warning,
            Some(rel),
        ));
        section.ok = false;
    }
    section
}

pub fn apply_visual_mark_repairs(
    vault: &Path,
    changes: &[VisualMarkRepairChange],
    dirty_paths: &[String],
) -> Result<VisualMarkRepairResult, AppError> {
    crate::core::fs::ensure_vault_dir(vault)?;
    let dirty: std::collections::HashSet<String> =
        dirty_paths.iter().map(|p| normalize_rel(p)).collect();
    let mut updated = Vec::new();
    for change in changes {
        let rel = normalize_rel(&change.path);
        if rel.is_empty() || rel.contains("..") {
            return Err(AppError::message(format!("invalid mark path: {rel}")));
        }
        if dirty.contains(&rel) {
            return Err(AppError::message(format!(
                "mark is open/dirty and cannot be repaired: {rel}"
            )));
        }
        let absolute = vault.join(&rel);
        let raw = fs::read_to_string(&absolute)
            .map_err(|error| AppError::message(format!("read mark {rel}: {error}")))?;
        let value: Value = serde_json::from_str(&raw)
            .map_err(|error| AppError::message(format!("parse mark {rel}: {error}")))?;
        let Some(migrated) = migrate_visual_mark_value(&value) else {
            // Already migrated or not applicable — skip.
            continue;
        };
        let body = serde_json::to_string_pretty(&migrated)
            .map_err(|error| AppError::message(format!("serialize mark {rel}: {error}")))?;
        fs::write(&absolute, format!("{body}\n"))
            .map_err(|error| AppError::message(format!("write mark {rel}: {error}")))?;
        updated.push(rel);
    }
    Ok(VisualMarkRepairResult {
        updated_paths: updated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn migrates_v1_agent_trace() {
        let raw = json!({
            "version": 1,
            "kind": "agent-trace",
            "id": "tr1",
            "paperPath": "papers/a",
            "index": 2,
            "page": 3,
            "rects": [{"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.1}],
            "comment": "note",
            "image": {"path": "assets/tr1.png", "mimeType": "image/png"},
            "agentId": "agent-1",
            "runtimeSessionId": "rt",
            "messageId": "m",
            "status": "completed",
            "answerSnapshot": "ok",
            "createdAt": "t1",
            "updatedAt": "t2"
        });
        assert!(is_legacy_visual_mark(&raw));
        let next = migrate_visual_mark_value(&raw).expect("migrate");
        assert_eq!(next["version"], 2);
        assert_eq!(next["kind"], "visual");
        assert!(next.get("agentId").is_none());
        assert_eq!(next["agent"]["agentId"], "agent-1");
        assert_eq!(next["agent"]["index"], 2);
        assert_eq!(next["agent"]["answerSnapshot"], "ok");
        assert_eq!(next["image"]["path"], "assets/tr1.png");
        // Idempotent
        assert!(!is_legacy_visual_mark(&next));
        assert!(migrate_visual_mark_value(&next).is_none());
    }

    #[test]
    fn note_only_v2_not_legacy() {
        let raw = json!({
            "version": 2,
            "kind": "visual",
            "id": "n1",
            "paperPath": "papers/a",
            "page": 1,
            "rects": [{"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}],
            "comment": "only note",
            "createdAt": "t",
            "updatedAt": "t"
        });
        assert!(!is_legacy_visual_mark(&raw));
    }
}
