//! Vault operations used by the CLI and the external MCP transports.
mod catalog;
mod documents;
mod tables;

use crate::{McpController, Permissions};
use agentero_core::fs::atomic_write;
use agentero_core::{error::AppError, features::evidence};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

pub(super) type Result<T> = std::result::Result<T, AppError>;
pub(super) fn usage(msg: impl Into<String>) -> AppError {
    AppError::domain("usage", msg)
}
pub(super) fn text<'a>(a: &'a Value, k: &str) -> Result<&'a str> {
    a[k].as_str().ok_or_else(|| usage(format!("Missing {k}")))
}
pub(super) fn strings(a: &Value, k: &str) -> Vec<String> {
    a[k].as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}
pub(super) fn flag(a: &Value, k: &str) -> bool {
    a[k].as_bool().unwrap_or(false)
}
pub(super) fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(super) fn revision(path: &Path) -> Result<String> {
    match fs::File::open(path) {
        Ok(mut file) => {
            let mut hasher = Sha256::new();
            std::io::copy(&mut file, &mut hasher)?;
            Ok(format!("{:x}", hasher.finalize()))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok("missing".into()),
        Err(err) => Err(err.into()),
    }
}
pub(super) fn match_revision(actual: &str, a: &Value) -> Result<()> {
    if a["if_revision"]
        .as_str()
        .is_some_and(|given| given != actual)
    {
        Err(AppError::domain(
            "revision_conflict",
            format!("The resource has changed; current revision: {actual}"),
        )
        .with_details(json!({"expected":a["if_revision"],"actual":actual})))
    } else {
        Ok(())
    }
}

fn cursor_signature(vault: &Path, a: &Value, revision: &str) -> Result<String> {
    let mut query = a.clone();
    query.as_object_mut().unwrap().remove("cursor");
    Ok(hash(&serde_json::to_vec(&(vault, query, revision))?))
}
pub(super) fn offset(vault: &Path, a: &Value, revision: &str) -> Result<usize> {
    let Some(cursor) = a["cursor"].as_str() else {
        return Ok(0);
    };
    let (sig, raw) = cursor
        .split_once('.')
        .ok_or_else(|| usage("Invalid cursor"))?;
    if sig != cursor_signature(vault, a, revision)? {
        return Err(AppError::domain(
            "stale_cursor",
            "The result set or query changed. Start a fresh query.",
        ));
    }
    raw.parse().map_err(|_| usage("Invalid cursor"))
}
pub(super) fn next(vault: &Path, a: &Value, revision: &str, offset: usize) -> Result<String> {
    Ok(format!(
        "{}.{offset}",
        cursor_signature(vault, a, revision)?
    ))
}
pub(super) fn paginate(vault: &Path, a: &Value, items: Vec<Value>) -> Result<Value> {
    let revision = hash(&serde_json::to_vec(&items)?);
    let start = offset(vault, a, &revision)?;
    if start > items.len() {
        return Err(usage("Invalid cursor offset"));
    }
    let end = start
        .saturating_add(a["limit"].as_u64().unwrap_or(50) as usize)
        .min(items.len());
    let cursor = if end < items.len() {
        Some(next(vault, a, &revision, end)?)
    } else {
        None
    };
    Ok(json!({"items":&items[start..end],"next_cursor":cursor}))
}

#[derive(Clone)]
struct Receipt {
    path: PathBuf,
    input: String,
}
impl Receipt {
    fn save(&self, state: Value) -> Result<()> {
        let mut record = state;
        record["input"] = json!(self.input);
        atomic_write(&self.path, &serde_json::to_vec(&record)?)?;
        Ok(())
    }
    fn replay(&self, vault: &Path) -> Result<Option<Value>> {
        if fs::symlink_metadata(&self.path).is_ok_and(|m| m.is_symlink()) {
            return Err(AppError::domain(
                "scope_denied",
                "Invalid operation receipt",
            ));
        }
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let record: Value = serde_json::from_slice(&bytes)?;
        if record["input"] != self.input {
            return Err(AppError::domain(
                "idempotency_conflict",
                "This request ID already identifies different input",
            ));
        }
        if let Some(previous) = record["before"].as_str() {
            let rel = agentero_core::fs::sanitize_vault_rel(text(&record["result"], "path")?)
                .map_err(usage)?;
            let root = vault.canonicalize()?;
            let target = crate::files::contained_write_target(&root, &rel)?;
            crate::files::require_canonical(&root, &rel, &target)?;
            let current = revision(&target)?;
            if current == record["result"]["revision"] {
                self.save(json!({"result":record["result"]}))?;
            } else if current == previous {
                return Ok(None);
            } else {
                return Err(AppError::domain(
                    "revision_conflict",
                    "Target changed while recovering an interrupted write",
                ));
            }
        }
        Ok(Some(record["result"].clone()))
    }
}

// An excerpt-only reader can repeat the exact evidence card they already received. Never
// reconstruct one from an arbitrary cite: a locator might refer to an entire PDF page.
impl McpController {
    fn remember_excerpts(&self, result: &Value) {
        let mut cards = self.excerpts.lock().unwrap_or_else(|e| e.into_inner());
        for item in result["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|v| v["kind"] == "body")
        {
            cards.retain(|card| card["cite"] != item["cite"]);
            cards.push_back(item.clone());
            if cards.len() > 256 {
                cards.pop_front();
            }
        }
    }

    fn read_excerpt(&self, vault: &Path, args: &Value) -> Result<Option<Value>> {
        let Some(cite) = args["source"]
            .as_str()
            .filter(|s| s.starts_with("agentero://cite/"))
        else {
            return Ok(None);
        };
        if !args
            .as_object()
            .unwrap()
            .keys()
            .all(|k| matches!(k.as_str(), "source" | "max_chars"))
        {
            return Ok(None);
        }
        let Some(mut card) = self
            .excerpts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|v| v["cite"] == cite)
            .cloned()
        else {
            return Ok(None);
        };
        evidence::resolve_citation(vault, cite)?;
        let budget = args["max_chars"].as_u64().unwrap_or(u64::MAX);
        let excerpt = card["excerpt"]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(usize::try_from(budget).unwrap_or(usize::MAX))
            .collect::<String>();
        card["excerpt"] = json!(excerpt);
        Ok(Some(
            json!({"source":card["source"],"revision":card["revision"],"text":excerpt,"evidence":[card],"truncated":false,"next_cursor":null}),
        ))
    }
}

pub(crate) async fn execute(
    ctrl: Arc<McpController>,
    vault: PathBuf,
    name: &str,
    args: Value,
    p: Permissions,
    is_write: bool,
) -> Result<Value> {
    let name = name.to_owned();
    // Dropping a protocol request must not release the vault lock while its blocking write is still running.
    tokio::spawn(async move { dispatch(ctrl, vault, &name, args, p, is_write).await })
        .await
        .map_err(|e| AppError::message(e.to_string()))?
}

fn check_private_store(root: &Path) -> Result<()> {
    let private = root.join(".agentero");
    if private.exists() && private.canonicalize()? != private {
        return Err(AppError::domain(
            "scope_denied",
            "Invalid Vault metadata directory",
        ));
    }
    for file in [
        "catalog.sqlite",
        "catalog.sqlite-wal",
        "catalog.sqlite-shm",
        ".trash",
    ] {
        if fs::symlink_metadata(private.join(file)).is_ok_and(|m| m.is_symlink()) {
            return Err(AppError::domain(
                "scope_denied",
                "Invalid Vault metadata path",
            ));
        }
    }
    Ok(())
}

async fn dispatch(
    ctrl: Arc<McpController>,
    vault: PathBuf,
    name: &str,
    args: Value,
    p: Permissions,
    is_write: bool,
) -> Result<Value> {
    if name == "paper_discover" && vault.as_os_str().is_empty() {
        return catalog::network(&ctrl, &vault, name, &args).await;
    }
    let root = vault.canonicalize()?;
    check_private_store(&root)?;
    let destination = if let Some(raw) = args["to_vault"].as_str() {
        let dst = std::fs::canonicalize(raw)?;
        check_private_store(&dst)?;
        Some(dst)
    } else {
        None
    };
    if name == "annotation_add"
        && args["kind"] == "translate"
        && args["translation"].is_null()
        && !p.online
    {
        return Err(AppError::domain(
            "permission_denied",
            "Automatic translation requires the online grant",
        ));
    }
    if name == "paper_import" || name == "paper_discover" {
        return catalog::network(&ctrl, &vault, name, &args).await;
    }
    // Cross-vault changes lock both roots in canonical order, including when two
    // processes move papers in opposite directions at the same time.
    let mut guards = Vec::new();
    if is_write && !flag(&args, "dry_run") {
        let mut roots = vec![&root];
        roots.extend(destination.as_ref().filter(|p| *p != &root));
        roots.sort();
        for path in roots {
            guards.push(WriteGuard::acquire(path).await?);
        }
    }
    let key = args["request_id"].as_str();
    let target = args["path"]
        .as_str()
        .or(args["paper"].as_str())
        .unwrap_or("");
    let stored = if let (Some(guard), Some(key)) = (guards.first(), key) {
        let path = guard
            .directory
            .join(hash(&serde_json::to_vec(&(name, target, key))?));
        let fingerprint = hash(&serde_json::to_vec(&args)?);
        let receipt = Receipt {
            path,
            input: fingerprint,
        };
        if let Some(result) = receipt.replay(&vault)? {
            return Ok(result);
        }
        Some(receipt)
    } else {
        None
    };
    let result = if name.starts_with("annotation_") {
        crate::annotations::execute(&vault, name, args.clone(), p.full_text).await?
    } else {
        let receipt = stored.clone();
        let name = name.to_string();
        let args = args.clone();
        let vault = vault.clone();
        let ctrl = ctrl.clone();
        tokio::task::spawn_blocking(move || {
            match name.as_str() {
                "evidence_search" => {
                    let found = evidence::search(&vault, serde_json::from_value(args)?)?;
                    if !p.full_text {
                        ctrl.remember_excerpts(&found);
                    }
                    Ok(found)
                }
                "evidence_read" => {
                    if !p.full_text {
                        if let Some(card) = ctrl.read_excerpt(&vault, &args)? {
                            return Ok(card);
                        }
                    }
                    evidence::read(&vault, serde_json::from_value(args)?, p.full_text)
                }
                "paper_relations" => evidence::relations_page(
                    &vault,
                    text(&args, "paper")?,
                    args["direction"].as_str().unwrap_or("references"),
                    flag(&args, "local_only"),
                    args["limit"].as_u64().unwrap_or(50) as usize,
                    args["cursor"].as_str(),
                ),
                "vault_list" => {
                    let name = vault.file_name().unwrap_or_default().to_string_lossy();
                    Ok(json!({"items": [{"id": crate::vault_id(&vault), "name": name, "current": true}]}))
                }
                op if op.starts_with("table_") => tables::execute(&vault, op, &args, p.full_text),
                op if op.starts_with("file_") || op.starts_with("trash_") || op.starts_with("paper_note_") => {
                    documents::execute(&ctrl, &vault, op, &args, receipt.as_ref(), p)
                }
                op => catalog::execute(&vault, op, &args),
            }
        })
        .await
        .map_err(|e| AppError::message(e.to_string()))??
    };
    if let Some(receipt) = stored {
        receipt.save(json!({"result":result}))?;
    }
    if name == "file_remove" && !flag(&args, "dry_run") {
        ctrl.host()
            .after_delete(&vault, &strings(&args, "paths"))
            .await;
    }
    Ok(result)
}

struct WriteGuard {
    directory: PathBuf,
    _lock: fs::File,
}
impl WriteGuard {
    async fn acquire(vault: &Path) -> Result<Self> {
        let root = vault.canonicalize()?;
        let directory = root.join(".agentero").join("operation-receipts");
        for dir in [root.join(".agentero"), directory.clone()] {
            match fs::create_dir(&dir) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e.into()),
            }
            if dir.canonicalize()? != dir {
                return Err(AppError::domain(
                    "permission_denied",
                    "Invalid operation store",
                ));
            }
        }
        let path = directory.join("write.lock");
        if fs::symlink_metadata(&path).is_ok_and(|m| m.is_symlink()) {
            return Err(AppError::domain(
                "permission_denied",
                "Invalid operation lock",
            ));
        }
        let lock = fs::OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(path)?;
        loop {
            match fs2::FileExt::try_lock_exclusive(&lock) {
                Ok(()) => break,
                Err(e) if e.raw_os_error() == fs2::lock_contended_error().raw_os_error() => {
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
                Err(e) => return Err(e.into()),
            }
        }
        Ok(Self {
            directory,
            _lock: lock,
        })
    }
}
