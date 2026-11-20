use super::*;
use crate::features::context::{AllowedSourceKind, ContextGrant};
use std::cell::Cell;

thread_local! {static REJECT_ALIASES: Cell<bool> = const { Cell::new(false) };}

pub(super) fn check_resolved(root: &Path, rel: &str, canonical: &Path) -> Result<()> {
    if REJECT_ALIASES.get() && root.join(rel.replace('\\', "/")) != canonical {
        return Err(denied());
    }
    Ok(())
}

/// Run one operation with host-owned authority. The host serializes requests
/// for this turn, commits the returned cost and releases only a live result.
pub fn execute_scoped(
    grant: &ContextGrant,
    name: &str,
    args: Value,
    spent: usize,
) -> Result<(Value, usize, Vec<String>)> {
    if !matches!(
        name,
        "evidence_search" | "evidence_read" | "paper_relations"
    ) {
        return Err(denied());
    }
    struct Reset(bool);
    impl Drop for Reset {
        fn drop(&mut self) {
            REJECT_ALIASES.set(self.0);
        }
    }
    let _reset = Reset(REJECT_ALIASES.replace(true));
    run(grant, name, args, spent)
}

fn run(
    grant: &ContextGrant,
    name: &str,
    mut args: Value,
    spent: usize,
) -> Result<(Value, usize, Vec<String>)> {
    let vault = Path::new(&grant.vault_path);
    if let Some(target) = args.as_object_mut().and_then(|m| m.remove("vault")) {
        if target.as_str() != Some(&grant.vault_path) {
            return Err(denied());
        }
    }
    let allowed = grant
        .allowed
        .iter()
        .map(|s| {
            let rel = relative(vault, &existing(vault, &s.path)?)?;
            Ok((rel, s.kind != AllowedSourceKind::File))
        })
        .collect::<Result<Vec<_>>>()?;
    if allowed.is_empty() {
        return Err(denied());
    }
    let permitted = |rel: &str| {
        allowed
            .iter()
            .any(|(path, dir)| path == rel || (*dir && Path::new(rel).starts_with(path)))
    };
    let scope = |raw: &str| -> Result<String> {
        let rel = search::resolve_source(vault, raw).map_err(|_| denied())?;
        if !permitted(&rel) {
            return Err(denied());
        }
        Ok(rel)
    };
    let left = (grant.budget.full_chars as usize).saturating_sub(spent);
    if left == 0 {
        return Err(AppError::domain(
            "budget_exhausted",
            "turn evidence budget exhausted",
        ));
    }
    let mut out = match name {
        "evidence_search" => {
            let mut input: SearchInput = serde_json::from_value(args)?;
            input.scope = if input.scope.is_empty() {
                allowed.iter().map(|s| s.0.clone()).collect()
            } else {
                input
                    .scope
                    .iter()
                    .map(|s| scope(s))
                    .collect::<Result<_>>()?
            };
            input.limit = Some(
                input
                    .limit
                    .unwrap_or(20)
                    .min(grant.budget.search_limit as usize),
            );
            search(vault, input)?
        }
        "evidence_read" => {
            let mut input: ReadInput = serde_json::from_value(args)?;
            scope(&input.source)?;
            input.max_chars = Some(
                input
                    .max_chars
                    .unwrap_or(4000)
                    .min(left)
                    .min(grant.budget.read_chars as usize),
            );
            read(vault, input, true)?
        }
        _ => {
            let raw = args["paper"]
                .as_str()
                .ok_or_else(|| usage("paper is required"))?;
            scope(raw)?;
            let mut res = relations_page(
                vault,
                raw,
                args["direction"].as_str().unwrap_or("references"),
                args["local_only"].as_bool().unwrap_or(false),
                args["limit"]
                    .as_u64()
                    .unwrap_or(50)
                    .min(grant.budget.search_limit as u64) as usize,
                args["cursor"].as_str(),
            )?;
            if let Some(items) = res["items"].as_array_mut() {
                for item in items.iter_mut() {
                    if item["paper"].as_str().is_some_and(|p| !permitted(p)) {
                        item["paper"] = Value::Null;
                        item["match_by"] = Value::Null
                    }
                }
                if args["local_only"] == true || args["direction"] == "related" {
                    items.retain(|i| !i["paper"].is_null());
                }
            }
            res
        }
    };
    // Record only evidence actually returned. Preserve desktop-readable links.
    let mut uris = Vec::new();
    let mut consumed = out["text"].as_str().map_or(0, |t| t.chars().count());
    let list = if name == "evidence_search" {
        "items"
    } else {
        "evidence"
    };
    if let Some(cards) = out.get_mut(list).and_then(Value::as_array_mut) {
        for c in cards.iter_mut() {
            if name == "evidence_search" {
                let excerpt: String = c["excerpt"]
                    .as_str()
                    .unwrap_or("")
                    .chars()
                    .take((grant.budget.card_chars as usize).min(left.saturating_sub(consumed)))
                    .collect();
                consumed += excerpt.chars().count();
                c["excerpt"] = json!(excerpt);
            }
            if c["excerpt"] == "" {
                continue;
            }
            if let Some(cite) = c["cite"].as_str() {
                uris.push(cite.to_owned());
            }
        }
        if name == "evidence_search" {
            cards.retain(|c| c["excerpt"] != "");
        }
    }
    // Detailed metadata duplicates the bounded metadata passage (notably abstracts).
    // Give row, region and relationship listings the same cumulative budget.
    if let Some(object) = out.as_object_mut() {
        object.remove("metadata");
    }
    for field in ["entries", "regions", "items"] {
        if field == "items" && name == "evidence_search" {
            continue;
        }
        if let Some(rows) = out[field].as_array_mut() {
            let original = rows.len();
            let mut keep = 0;
            for row in rows.iter() {
                let cost = row.to_string().chars().count();
                if cost > left.saturating_sub(consumed) {
                    break;
                }
                consumed += cost;
                keep += 1;
            }
            rows.truncate(keep);
            if keep < original {
                if keep == 0 && consumed == 0 {
                    return Err(AppError::domain(
                        "budget_exhausted",
                        "turn budget too small for the next item",
                    ));
                }
                out["next_cursor"] = Value::Null;
                out["truncated"] = json!(true);
            }
        }
    }
    if name == "paper_relations" {
        // Only the relationships that survived the scope + budget filters are sources.
        for item in out["items"].as_array().into_iter().flatten() {
            let uri = if let Some(path) = item["paper"].as_str() {
                let Some(record) = paper(vault, path)? else {
                    continue;
                };
                let revision = content_revision(&serde_json::to_vec(&record)?);
                Some(make_citation(
                    vault,
                    path,
                    &revision,
                    "metadata",
                    &json!({}),
                )?)
            } else {
                item["identifier"].as_str().and_then(|id| {
                    use crate::features::refs::latex::{extract_arxiv_id, extract_doi};
                    extract_doi(id)
                        .map(|doi| format!("https://doi.org/{doi}"))
                        .or_else(|| {
                            extract_arxiv_id(&format!("arXiv:{id}"))
                                .map(|arxiv| format!("https://arxiv.org/abs/{arxiv}"))
                        })
                })
            };
            if let Some(uri) = uri {
                uris.push(uri);
            }
        }
    }
    if consumed >= left {
        out["next_cursor"] = Value::Null
    }
    Ok((out, consumed, uris))
}
