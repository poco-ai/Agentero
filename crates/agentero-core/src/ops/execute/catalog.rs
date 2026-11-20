use super::*;
use crate::features::paper::catalog::papers as paper;
use crate::features::paper::{
    catalog::papers::{self, PaperMetaPatch, PaperRecord},
    discovery::{discover, embeddings::EmbeddingConfig},
    import::{self, LookupImportArgs, NoteShellMode},
};
use crate::features::pdf::layout_index;

use evidence::{paper_brief as brief, paper_detail as detail};
pub(super) fn execute(vault: &Path, name: &str, a: &Value) -> Result<Value> {
    let internal = flag(a, "include_internal");
    if name == "paper_list" {
        let mut rows = papers::list_all(vault)?;
        let q = a["query"].as_str().unwrap_or("").to_lowercase();
        let tags = strings(a, "tag");
        rows.retain(|r| {
            let matches_q = q.is_empty()
                || [&r.id, &r.path, &r.title]
                    .into_iter()
                    .chain(r.authors.iter())
                    .chain(
                        r.tags
                            .iter()
                            .filter(|t| internal || !papers::is_internal_tag_name(&t.name))
                            .map(|t| &t.name),
                    )
                    .any(|s| s.to_lowercase().contains(&q));
            matches_q
                && papers::paper_has_all_tags(r, &tags)
                && a["state"]
                    .as_str()
                    .is_none_or(|s| (s == "read") == r.is_read)
                && a["status"].as_str().is_none_or(|s| r.status == s)
        });
        rows.sort_by(|a1, b| {
            match a["sort"].as_str().unwrap_or("updated") {
                "title" => a1.title.cmp(&b.title),
                "date" => b.date.cmp(&a1.date),
                _ => b.updated_at.cmp(&a1.updated_at),
            }
            .then(a1.id.cmp(&b.id))
            .then(a1.path.cmp(&b.path))
        });
        return paginate(
            vault,
            a,
            rows.iter()
                .map(|r| brief(r, internal))
                .collect::<Result<Vec<_>>>()?,
        );
    }
    if name == "paper_tag_list" {
        let mut tags = papers::list_tags(vault, internal)?;
        tags.sort_by(|a, b| b.count.cmp(&a.count).then(a.name.cmp(&b.name)));
        return paginate(
            vault,
            a,
            tags.into_iter()
                .map(|t| json!({"name":t.name,"color":t.color,"count":t.count}))
                .collect(),
        );
    }
    let r = paper::resolve_paper(vault, text(a, "paper")?)?;
    let root = vault.canonicalize()?;
    if !root.join(&r.path).canonicalize()?.starts_with(&root) {
        return Err(AppError::domain(
            "permission_denied",
            "Paper path outside vault",
        ));
    }
    let check = |r: &PaperRecord| match_revision(&hash(&serde_json::to_vec(r)?), a);
    match name {
        "paper_get" => detail(vault, &r, internal),
        "paper_update" => {
            let mut fields = a.clone();
            for field in strings(a, "clear") {
                let key = match field.as_str() {
                    "authors" => "author",
                    other => other,
                };
                if a.get(key).is_some() {
                    return Err(usage(format!("Cannot set and clear {key} together")));
                }
                fields[key] = if key == "author" {
                    json!([])
                } else {
                    json!("")
                };
            }
            let patch = PaperMetaPatch {
                title: fields["title"].as_str().map(str::to_owned),
                authors: fields.get("author").map(|_| strings(&fields, "author")),
                publication: fields["venue"].as_str().map(str::to_owned),
                doi: fields["doi"].as_str().map(str::to_owned),
                arxiv_id: fields["arxiv"].as_str().map(str::to_owned),
                date: fields["date"].as_str().map(str::to_owned),
                ..Default::default()
            };
            let row = papers::update_meta_checked(
                vault,
                &r.path,
                &patch,
                fields["state"].as_str().map(|s| s == "read"),
                fields["status"].as_str(),
                check,
            )?;
            detail(vault, &row, internal)
        }
        "paper_tag_add" | "paper_tag_remove" | "paper_tag_set" => {
            let tags = strings(a, "tags");
            let parsed = tags
                .iter()
                .map(|s| papers::parse_tag_spec(s))
                .collect::<Result<Vec<_>>>()?;
            if parsed.iter().any(|t| papers::is_internal_tag_name(&t.name)) {
                return Err(usage("Internal tags cannot be edited"));
            }
            let row = match name {
                "paper_tag_add" => papers::add_tags(vault, &r.path, &parsed)?,
                "paper_tag_remove" => papers::remove_tags(vault, &r.path, &tags)?,
                _ => papers::set_user_tags_checked(vault, &r.path, &parsed, check)?,
            };
            detail(vault, &row, internal)
        }
        "paper_regions" => {
            for suffix in ["source/layout.json", "source/layout-index.json"] {
                let asset = vault.join(&r.path).join(suffix);
                if asset.exists() && !asset.canonicalize()?.starts_with(&root) {
                    return Err(AppError::domain(
                        "permission_denied",
                        "Layout outside vault",
                    ));
                }
            }
            let out = layout_index::list_regions(
                vault,
                &r.path,
                &strings(a, "kind"),
                Some(a["min_score"].as_f64().unwrap_or(0.3)),
            )?;
            let rev = evidence::page_revision(vault, &r.path)?;
            let mut items = Vec::new();
            for region in out.items {
                if a["page"].as_u64().is_some_and(|p| p != region.page as u64) {
                    continue;
                }
                let locator = json!({"page":region.page,"region":region.id});
                let cite = evidence::make_citation(vault, &r.path, &rev, "body", &locator)?;
                items.push(json!({"region":region.id,"kind":region.kind,"page":region.page,"box":[region.bbox.x,region.bbox.y,region.bbox.w,region.bbox.h],"score":region.score,"cite":cite}));
            }
            paginate(vault, a, items)
        }
        _ => Err(usage("Unknown paper operation")),
    }
}
pub(super) async fn network(
    host: &dyn OperationHost,
    vault: &Path,
    name: &str,
    a: &Value,
) -> Result<Value> {
    if name == "paper_import" {
        let parent =
            import::normalize_parent_dir(a["into"].as_str().unwrap_or(&host.parent_dir()))?;
        files::reject_segments(&parent)?;
        let root = vault.canonicalize()?;
        let probe = format!("{parent}/import-target");
        files::require_canonical(
            &root,
            &probe,
            &files::contained_write_target(&root, &probe)?,
        )?;
        let args = LookupImportArgs {
            vault_path: vault.to_string_lossy().into_owned(),
            parent_dir: parent,
            text: text(a, "identifier")?.into(),
            translator_base_url: host.translator_url(),
            task_id: None,
        };
        let ctx = host.import_context();
        let r = import::import_by_identifier_with_progress(
            args,
            ctx.app.as_ref(),
            ctx.caps.as_ref(),
            NoteShellMode::parse(&host.paper_note_mode()),
        )
        .await?;
        host.after_import(vault, &r.preparation);
        let outcome = match r.status {
            Some(
                import::paper_import::CommitStatus::Deduped
                | import::paper_import::CommitStatus::Skipped,
            ) => "existing",
            _ => "created",
        };
        return Ok(
            json!({"items":[{"id":r.id,"path":r.path,"outcome":outcome,"message":r.asset_messages.join("\n")}]}),
        );
    }
    let query = discover::DiscoverQuery {
        keywords: strings(a, "keyword"),
        keyword_match: serde_json::from_value(a.get("match").cloned().unwrap_or(json!("all")))?,
        categories: strings(a, "category"),
        since: a["since"].as_str().map(str::to_owned),
        until: a["until"].as_str().map(str::to_owned),
        top: Some(a["limit"].as_u64().unwrap_or(20) as usize),
        max_candidates: Some(a["candidates"].as_u64().unwrap_or(100) as usize),
        semantic_weight: a["semantic_weight"].as_f64().map(|w| w as f32),
    };
    if query.top > query.max_candidates
        || query
            .since
            .as_ref()
            .zip(query.until.as_ref())
            .is_some_and(|(s, u)| s > u)
    {
        return Err(usage("Check the date range and candidate limits"));
    }
    let embeddings = if a["rank"] == "hybrid" {
        let profiles: Value = serde_json::from_reader(
            fs::File::open(crate::paths::agentero_config_dir().join("embedding-profiles.json"))
                .map_err(|_| {
                    AppError::domain(
                        "profile_not_found",
                        "Configure embedding-profiles.json in the Agentero config directory",
                    )
                })?,
        )?;
        let profile = &profiles[text(a, "embedding_profile")?];
        Some(EmbeddingConfig {
            base_url: text(profile, "base_url")?.into(),
            model: text(profile, "model")?.into(),
            api_key: profile["api_key"].as_str().map(str::to_owned),
        })
    } else {
        None
    };
    let excluded = if flag(a, "include_known") || vault.as_os_str().is_empty() {
        Default::default()
    } else {
        discover::known_arxiv_ids(vault)?
    };
    let result = discover::discover_arxiv(&query, &excluded, embeddings.as_ref()).await?;
    Ok(
        json!({"items":result.items.into_iter().map(|i|json!({"identifier":i.arxiv_id,"title":i.title,"authors":i.authors,"abstract":i.abstract_text,"url":i.url,"score":i.score})).collect::<Vec<_>>()}),
    )
}
