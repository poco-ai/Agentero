use super::*;
use crate::features::refs::{self, citing};

pub fn relations(
    vault: &Path,
    paper: &str,
    direction: &str,
    local_only: bool,
    limit: usize,
) -> Result<Value> {
    relations_page(vault, paper, direction, local_only, limit, None)
}
pub fn relations_page(
    vault: &Path,
    reference: &str,
    direction: &str,
    local_only: bool,
    limit: usize,
    cursor: Option<&str>,
) -> Result<Value> {
    if !(1..=200).contains(&limit) {
        return Err(usage("limit must be 1..200"));
    }
    let target = paper(vault, reference)?.ok_or_else(|| missing(reference))?;
    let mut items = Vec::new();
    let state = match direction {
        "references" | "related" => {
            let rel = format!("{}/source/{}", target.path, refs::SIDECAR_FILE);
            if vault.join(&rel).exists() {
                let sidecar = refs::read_sidecar(&existing(vault, &rel)?)
                    .ok_or_else(|| AppError::domain("invalid_cache", "invalid citation sidecar"))?;
                for c in sidecar.citations {
                    let matched = c
                        .local_match
                        .filter(|m| existing(vault, &m.paper_path).is_ok());
                    if (local_only || direction == "related") && matched.is_none() {
                        continue;
                    }
                    items.push(json!({"direction":direction,"title":c.metadata.title.or(c.raw).unwrap_or_else(||c.id.clone()),"identifier":c.metadata.doi.or(c.metadata.arxiv_id),"paper":matched.as_ref().map(|m|&m.paper_path),"match_by":matched.map(|m|m.match_by)}));
                }
                "available"
            } else {
                "missing"
            }
        }
        "cited-by" => {
            let records = papers::list_all(vault)?;
            let citing = citing::cached_citing_of(vault, &target.path);
            let cached = citing.is_some();
            for c in citing.into_iter().flatten() {
                let matched = records.iter().find_map(|r| {
                    if let Some((a, b)) = c.doi.as_deref().zip(r.doi.as_deref()) {
                        if a.eq_ignore_ascii_case(b) {
                            return Some((r, "doi"));
                        }
                    }
                    c.arxiv_id
                        .as_deref()
                        .zip(r.arxiv_id.as_deref())
                        .filter(|(a, b)| {
                            refs::latex::strip_arxiv_version(a)
                                == refs::latex::strip_arxiv_version(b)
                        })
                        .map(|_| (r, "arxiv"))
                });
                if local_only && matched.is_none() {
                    continue;
                }
                items.push(json!({"direction":direction,"title":c.title.unwrap_or_default(),"identifier":c.doi.or(c.arxiv_id),"paper":matched.map(|(p,_)|&p.path),"match_by":matched.map(|(_,by)|by)}));
            }
            if cached {
                "available"
            } else {
                "missing"
            }
        }
        _ => return Err(usage("direction must be references, cited-by, or related")),
    };
    let key = query_key(vault, &(&target.path, direction, local_only, limit))?;
    let mut page = list_page(items, cursor, &key, limit)?;
    page["coverage"] = json!("local-cache");
    page["cache_state"] = json!(state);
    Ok(page)
}
