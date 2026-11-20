use super::*;
use crate::features::paper::{catalog::papers as paper, notes};
use crate::features::{
    paper::catalog,
    vault::{rename::WikiIndex, trash},
};
fn move_receipt(path: &str, outcome: &str, preview: bool) -> Value {
    json!({"changed":!preview,"preview":preview,"items":[{"path":path,"outcome":outcome}]})
}
pub(super) fn execute(
    host: &dyn OperationHost,
    vault: &Path,
    name: &str,
    a: &Value,
    receipt: Option<&Receipt>,
    permissions: Permissions,
) -> Result<Value> {
    let root = vault.canonicalize()?;
    let preview = flag(a, "dry_run");
    match name {
        "file_list" => {
            let entries =
                files::list_dir(&root, a["path"].as_str().unwrap_or(""), flag(a, "hidden"))?;
            let items = entries
                .into_iter()
                .map(|e| {
                    let path = root.join(&e.path);
                    let meta = path.metadata()?;
                    let revision = if meta.is_file() {
                        revision(&path)?
                    } else {
                        hash(&serde_json::to_vec(&(
                            meta.len(),
                            meta.modified()
                                .ok()
                                .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                                .map(|s| s.as_nanos()),
                        ))?)
                    };
                    Ok(json!({"kind":e.kind,"path":e.path,"name":e.name,"revision":revision}))
                })
                .collect::<Result<Vec<_>>>()?;
            paginate(vault, a, items)
        }
        "file_write" | "paper_note_replace" | "paper_note_append" => {
            let content = text(a, "content")?;
            let rel = if name == "file_write" {
                files::relative_path(text(a, "path")?)?
            } else {
                notes::notes_rel(&paper::resolve_paper(&root, text(a, "paper")?)?.path)?
            };
            let target = files::contained_write_target(&root, &rel)?;
            files::reject_segments(&rel)?;
            files::require_canonical(&root, &rel, &target)?;
            if target.is_file()
                && target
                    .extension()
                    .is_some_and(|x| x.eq_ignore_ascii_case("md"))
                && files::markdown_experiment_locked(&target)?
            {
                return Err(AppError::domain(
                    "experiment_locked",
                    "Experiment is locked",
                ));
            }
            let before = revision(&target)?;
            match_revision(&before, a)?;
            let bytes = if name == "file_write" {
                let mode = a["mode"].as_str().unwrap_or("create");
                if mode == "create" && before != "missing" {
                    return Err(AppError::domain(
                        "already_exists",
                        "Choose a new path or replace with if_revision",
                    ));
                }
                let mode = if mode == "append" {
                    files::WriteMode::Append
                } else {
                    files::WriteMode::Replace
                };
                if a["encoding"] == "base64" {
                    files::prepare_base64(&root, &rel, content, mode)?
                } else {
                    files::prepare_text(&root, &rel, content, mode)?
                }
            } else {
                if content.len() > files::MAX_TEXT_BYTES {
                    return Err(usage("Note input exceeds 2 MiB"));
                }
                let r = paper::resolve_paper(&root, text(a, "paper")?)?;
                notes::prepare_notes(
                    &root,
                    &r.path,
                    &r.id,
                    content,
                    if name == "paper_note_append" {
                        notes::WriteMode::Append
                    } else {
                        notes::WriteMode::Replace
                    },
                )?
            };
            let result = json!({"path":rel,"revision":hash(&bytes),"bytes":bytes.len()});
            if let Some(receipt) = receipt {
                receipt.save(json!({"before":before,"result":result}))?;
            }
            fs::create_dir_all(
                target
                    .parent()
                    .ok_or_else(|| usage("Missing parent directory"))?,
            )?;
            atomic_write(&target, &bytes)?;
            Ok(result)
        }
        "file_remove" => {
            let paths = files::delete_candidates(&root, &strings(a, "paths"))?;
            if preview {
                return Ok(
                    json!({"preview":true,"items":paths.iter().map(|p|json!({"path":p,"id":null})).collect::<Vec<_>>()}),
                );
            }
            let out = files::delete_paths(&root, &paths, false)?;
            let items = trash::list_trash(&root)?
                .into_iter()
                .filter(|e| Some(&e.batch_id) == out.batch_id.as_ref())
                .map(|e| json!({"path":e.rel,"id":e.id}))
                .collect::<Vec<_>>();
            Ok(json!({"items":items,"preview":false}))
        }
        "file_move" => {
            let from = files::relative_path(text(a, "source")?)?;
            let to = files::relative_path(text(a, "destination")?)?;
            if from == "papers" || to == "papers" {
                return Err(usage("The papers root cannot be moved or replaced"));
            }
            let dst = a["to_vault"]
                .as_str()
                .map(PathBuf::from)
                .unwrap_or(root.clone())
                .canonicalize()?;
            files::reject_segments(&from)?;
            files::reject_segments(&to)?;
            files::reject_managed(&from)?;
            files::reject_managed(&to)?;
            files::require_canonical(&root, &from, &root.join(&from).canonicalize()?)?;
            let folder = root.join(&from).is_dir();
            let has_papers = folder && !catalog::papers::list_under_path(&root, &from)?.is_empty();
            // A directory itself may be named NOTES.md; classify its contained assets.
            let visibility_path = if folder {
                format!("{from}/asset")
            } else {
                from.clone()
            };
            if !permissions.full_text && evidence::source_kind(&root, &visibility_path)? == "body" {
                // A directory carries children whose visibility can change at the destination.
                // A complete cataloged paper keeps its ownership across a normal paper move.
                let safe_move = if folder {
                    let mut inside_paper = false;
                    for parent in Path::new(&from)
                        .ancestors()
                        .skip(1)
                        .filter(|p| !p.as_os_str().is_empty())
                    {
                        if catalog::papers::get_by_path(&root, &parent.to_string_lossy())?.is_some()
                        {
                            inside_paper = true;
                            break;
                        }
                    }
                    !inside_paper
                        && has_papers
                        && to.starts_with("papers/")
                        && Path::new(&from).file_name() == Path::new(&to).file_name()
                } else {
                    evidence::source_kind(&dst, &to)? == "body"
                };
                if !safe_move {
                    return Err(AppError::domain(
                        "full_text_required",
                        "Moving a paper asset into a readable location requires full-text access",
                    ));
                }
            }
            if dst.join(&to).exists() {
                return Err(AppError::domain("already_exists", "Destination exists"));
            }
            files::require_canonical(&dst, &to, &files::contained_write_target(&dst, &to)?)?;
            let paper_dir = folder && (from.starts_with("papers/") || has_papers);
            if root != dst && !paper_dir {
                return Err(usage("Cross-vault moves require a paper directory"));
            }
            if paper_dir
                && (Path::new(&from).file_name() != Path::new(&to).file_name()
                    || !to.starts_with("papers/"))
            {
                return Err(usage(
                    "Move paper folders under papers/ and preserve the folder name",
                ));
            }
            if root == dst && to.starts_with(&format!("{from}/")) {
                return Err(usage("Cannot move a directory into itself"));
            }
            if root != dst {
                let parent = to
                    .rsplit_once('/')
                    .ok_or_else(|| usage("Missing paper parent"))?
                    .0;
                catalog::migrate_paper_between_vaults(&root, &from, &dst, parent, preview)?;
            } else if !preview {
                let handle = host.wiki_index(&root);
                let mut guard = handle
                    .as_ref()
                    .map(|h| h.lock().unwrap_or_else(|e| e.into_inner()));
                let mut fallback = WikiIndex::default();
                files::move_entry(
                    &root,
                    &from,
                    &to,
                    guard.as_deref_mut().unwrap_or(&mut fallback),
                )?;
                crate::usage::rename_path_best_effort(&root.to_string_lossy(), &from, &to);
            }
            Ok(move_receipt(&to, "move", preview))
        }
        "trash_list" => paginate(
            vault,
            a,
            trash::list_trash(&root)?
                .into_iter()
                .map(|e| json!({"id":e.id,"path":e.rel,"removed_at":e.deleted_at}))
                .collect(),
        ),
        "trash_restore" => {
            let id = text(a, "id")?;
            let entry = trash::list_trash(&root)?
                .into_iter()
                .find(|e| e.id == id)
                .ok_or_else(|| AppError::domain("source_not_found", "Unknown trash ID"))?;
            let rel = files::relative_path(&entry.rel)?;
            files::reject_segments(&rel)?;
            files::reject_managed(&rel)?;
            let target = root.join(&rel);
            let resolved = if target.exists() {
                target.canonicalize()?
            } else {
                files::contained_write_target(&root, &rel)?
            };
            files::require_canonical(&root, &rel, &resolved)?;
            let path = trash::restore_item(&root, &entry.batch_id, &entry.stored)?;
            Ok(move_receipt(&path, "restored", false))
        }
        _ => Err(usage("Unknown document operation")),
    }
}
