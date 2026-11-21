//! `agentero doctor`

use crate::error::{CliError, ExitCode};
use crate::output::to_value;

use crate::resolve::{resolve_vault, GlobalOpts};
use agentero_core::features::doctor::{
    apply_alias_repairs, apply_catalog_duplicate_repairs, apply_visual_mark_repairs, diagnose,
    AliasRepairCandidate, AliasRepairChange, VisualMarkRepairChange,
};
use agentero_core::features::wiki::index::WikiIndex;
use agentero_core::features::wiki::models::LinkResolutionStatus;
use agentero_core::fs::sanitize_vault_rel;

use serde_json::{json, Value};
use std::path::Path;

fn default_change(candidate: &AliasRepairCandidate) -> AliasRepairChange {
    AliasRepairChange {
        path: candidate.path.clone(),
        title_alias: candidate.title_alias.clone(),
        short_alias: candidate.short_alias.clone(),
        expected_hash: candidate.expected_hash.clone(),
    }
}

fn check_wiki(source: Option<&str>, globals: &GlobalOpts) -> Result<Value, CliError> {
    let vault = resolve_vault(globals)?;
    let scope = source.map(validate_wiki_scope).transpose()?;
    if let Some(rel) = scope.as_deref() {
        let path = vault.join(rel);
        if !path.exists() {
            return Err(CliError::message(format!("path not found: {rel}")));
        }
        if path.is_file() && !is_markdown(&path) {
            return Err(CliError::usage(
                "doctor wiki source must be a Markdown file or directory",
            ));
        }
    }

    let vault_str = vault.to_string_lossy();
    let mut index = WikiIndex::default();
    index.rebuild(&vault_str).map_err(|error| {
        CliError::with_details(
            "wiki_index_failed",
            "could not build Wiki index",
            json!({ "cause": error }),
            ExitCode::Business,
        )
    })?;
    let report = index.check_links(&vault_str, scope.as_deref());
    let mut value = to_value(&report)?;

    if !report.issues.is_empty() {
        if let Some(object) = value.as_object_mut() {
            object.insert("lines".into(), json!(wiki_issue_lines(&report.issues)));
        }
        return Err(CliError::with_details(
            "wikilink_check_failed",
            "wikilink check found unresolved or invalid links",
            value,
            ExitCode::Business,
        ));
    }

    if let Some(object) = value.as_object_mut() {
        object.insert(
            "lines".into(),
            json!([format!(
                "ok: {} Markdown file(s), {} resolved link(s)",
                report.checked_files, report.counts.resolved
            )]),
        );
    }
    Ok(value)
}

fn validate_wiki_scope(raw: &str) -> Result<String, CliError> {
    if Path::new(raw).is_absolute() {
        return Err(CliError::usage("doctor wiki source must be Vault-relative"));
    }
    sanitize_vault_rel(raw).map_err(CliError::usage)
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "md" | "mdx" | "markdown"
            )
        })
}

fn wiki_issue_lines(
    issues: &[agentero_core::features::wiki::models::WikiCheckIssue],
) -> Vec<String> {
    issues
        .iter()
        .map(|issue| {
            format!(
                "{}: {}:{} -> {}",
                wiki_status_label(&issue.status),
                issue.source,
                issue.line,
                issue.target_raw
            )
        })
        .collect()
}

fn wiki_status_label(status: &LinkResolutionStatus) -> &'static str {
    match status {
        LinkResolutionStatus::Resolved => "resolved",
        LinkResolutionStatus::Missing => "missing",
        LinkResolutionStatus::Ambiguous => "ambiguous",
        LinkResolutionStatus::InvalidFragment => "invalidFragment",
    }
}

pub fn dispatch(path: &str, a: &Value, g: &GlobalOpts) -> Result<Value, CliError> {
    use crate::dispatch::{required, string, strings};
    let vault = resolve_vault(g)?;
    if path == "vault check" {
        let areas = strings(a, "area");
        let mut findings = Vec::new();
        if let Some(under) = string(a, "under") {
            if !areas.is_empty() && areas != ["links"] {
                return Err(CliError::usage("--under requires --area links"));
            }
            if let Err(error) = check_wiki(Some(under), g) {
                if error.code != "wikilink_check_failed" {
                    return Err(error);
                }
                findings.push(json!({"outcome":"issue","id":"links","message":error.message,"details":error.details}));
            }
        } else {
            let report = to_value(&diagnose(&vault)?)?;
            for (area, key) in [
                ("catalog", "catalog"),
                ("aliases", "aliases"),
                ("annotations", "visualMarks"),
                ("links", "wikilinks"),
            ] {
                if !areas.is_empty() && !areas.iter().any(|v| v == area) {
                    continue;
                }
                let section = &report[key];
                if section["ok"] == false
                    || section["issues"].as_array().is_some_and(|v| !v.is_empty())
                {
                    findings.push(json!({"outcome":"issue","id":area,"message":format!("{area} check found issues"),"details":section}));
                }
            }
        }
        if findings.is_empty() {
            return Ok(json!({"ok":true,"findings":[]}));
        }
        return Err(CliError::with_details(
            "doctor_issues",
            "vault checks found issues",
            json!({"ok":false,"findings":findings}),
            ExitCode::Business,
        ));
    }
    let area = required(a, "area")?;
    let report = diagnose(&vault)?;
    let snapshot = to_value(&report)?;
    let key = match area {
        "aliases" => "aliases",
        "annotations" => "visualMarks",
        "duplicate-records" => "catalog",
        _ => return Err(CliError::usage("unknown repair area")),
    };
    if a["apply"] != true {
        return Ok(
            json!({"applied":false,"items":[{"id":area,"outcome":"preview","details":snapshot[key]}]}),
        );
    }
    let result = match area {
        "aliases" => {
            let changes = report
                .aliases
                .candidates
                .iter()
                .filter(|c| c.fixable)
                .map(default_change)
                .collect::<Vec<_>>();
            let outcome = apply_alias_repairs(&vault, &changes, &[]).map_err(|e| {
                CliError::with_details(
                    "alias_repair_failed",
                    &e.message,
                    to_value(&e).unwrap_or_default(),
                    ExitCode::Business,
                )
            })?;
            to_value(&outcome)?
        }
        "annotations" => {
            let changes = report
                .visual_marks
                .candidates
                .iter()
                .filter(|c| c.fixable)
                .map(|c| VisualMarkRepairChange {
                    path: c.path.clone(),
                })
                .collect::<Vec<_>>();
            to_value(&apply_visual_mark_repairs(&vault, &changes, &[])?)?
        }
        _ => to_value(&apply_catalog_duplicate_repairs(&vault)?)?,
    };
    Ok(json!({"applied":true,"items":[{"id":area,"outcome":"applied","details":result}]}))
}
