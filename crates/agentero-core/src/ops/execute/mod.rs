//! Vault operations used by the CLI and the external MCP transports.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
mod annotations;
mod catalog;
mod registry;
pub use registry::{operation, Permissions, ResearchOperation, ToolId};
mod documents;
mod tables;

use crate::app_handle::AppHandle;
use crate::features::vault::files;
use crate::features::{
    paper::{capabilities::CapsCache, import::PreparationPlan},
    vault::rename::WikiIndex,
};
use crate::fs::atomic_write;
use crate::{error::AppError, features::evidence};
use evidence::content_revision as hash;
use serde_json::{json, Value};
use std::sync::Mutex;
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
pub(super) fn revision(path: &Path) -> Result<String> {
    match evidence::file_revision(path) {
        Err(AppError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => Ok("missing".into()),
        other => other,
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
            let rel =
                crate::fs::sanitize_vault_rel(text(&record["result"], "path")?).map_err(usage)?;
            let root = vault.canonicalize()?;
            let target = files::contained_write_target(&root, &rel)?;
            files::require_canonical(&root, &rel, &target)?;
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

#[derive(Default)]
pub struct ImportContext {
    pub app: Option<AppHandle>,
    pub caps: Option<CapsCache>,
}

/// Optional integrations supplied by the desktop host or the local CLI.
#[async_trait::async_trait]
pub trait OperationHost: Send + Sync + 'static {
    fn translator_url(&self) -> Option<String> {
        None
    }
    fn parent_dir(&self) -> String {
        "papers".into()
    }
    fn paper_note_mode(&self) -> String {
        "standard".into()
    }
    fn import_context(&self) -> ImportContext {
        ImportContext::default()
    }
    fn wiki_index(&self, _vault: &Path) -> Option<Arc<Mutex<WikiIndex>>> {
        None
    }
    fn after_import(&self, _vault: &Path, plan: &PreparationPlan) {
        if let Some(line) = crate::features::paper::import::skipped_preparation_line(plan) {
            log::info!(target: "agentero::import", "{line}");
        }
    }
    async fn after_delete(&self, _vault: &Path, _rels: &[String]) {}
}

pub struct LocalHost {
    pub translator_url: Option<String>,
}
impl OperationHost for LocalHost {
    fn translator_url(&self) -> Option<String> {
        self.translator_url.clone()
    }
}

pub fn vault_id(path: &Path) -> String {
    format!(
        "v-{}",
        hash(
            crate::fs::canonicalize_best_effort(path)
                .to_string_lossy()
                .as_bytes()
        )
    )
}

pub async fn run_local(
    vault: &Path,
    name: &str,
    args: Value,
    translator_url: Option<String>,
) -> Result<Value> {
    let op = operation(name, Permissions::all())?;
    run(
        Arc::new(LocalHost { translator_url }),
        vault.to_owned(),
        op,
        args,
        Permissions::all(),
    )
    .await
}

pub async fn run(
    host: Arc<dyn OperationHost>,
    vault: PathBuf,
    op: &'static ResearchOperation,
    args: Value,
    p: Permissions,
) -> Result<Value> {
    op.authorize(p)?;
    op.validate_input(&args)?;
    // Cancellation must not release the vault lock while a blocking write still runs.
    let output = tokio::spawn(async move { dispatch(host, vault, op, args, p).await })
        .await
        .map_err(|e| AppError::message(e.to_string()))??;
    op.checked_output(output)
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
    host: Arc<dyn OperationHost>,
    vault: PathBuf,
    op: &ResearchOperation,
    args: Value,
    p: Permissions,
) -> Result<Value> {
    use ToolId::*;
    let name = op.id.as_str();
    if op.id == PaperDiscover && vault.as_os_str().is_empty() {
        return catalog::network(host.as_ref(), &vault, name, &args).await;
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
    // Cross-vault changes lock both roots in canonical order, including when two
    // processes move papers in opposite directions at the same time.
    let mut guards = Vec::new();
    if op.writes() && !flag(&args, "dry_run") {
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
    let result = match op.id {
        PaperDiscover | PaperImport => catalog::network(host.as_ref(), &vault, name, &args).await?,
        AnnotationList | AnnotationGet | AnnotationAdd | AnnotationUpdate | AnnotationRemove => {
            #[cfg(not(any(target_os = "ios", target_os = "android")))]
            {
                annotations::execute(&vault, name, args.clone(), p.full_text).await?
            }
            #[cfg(any(target_os = "ios", target_os = "android"))]
            {
                return Err(AppError::domain(
                    "host_unavailable",
                    "PDF annotation tools require a desktop host",
                ));
            }
        }
        id => {
            let receipt = stored.clone();
            let args = args.clone();
            let vault = vault.clone();
            let host = host.clone();
            tokio::task::spawn_blocking(move || match id {
                EvidenceSearch => evidence::search(&vault, serde_json::from_value(args)?),
                EvidenceRead => evidence::read(&vault, serde_json::from_value(args)?, p.full_text),
                PaperRelations => evidence::relations_page(
                    &vault,
                    text(&args, "paper")?,
                    args["direction"].as_str().unwrap_or("references"),
                    flag(&args, "local_only"),
                    args["limit"].as_u64().unwrap_or(50) as usize,
                    args["cursor"].as_str(),
                ),
                VaultList => {
                    let name = vault.file_name().unwrap_or_default().to_string_lossy();
                    Ok(json!({"items":[{"id":vault_id(&vault),"name":name,"current":true}]}))
                }
                TableQuery | TableUpsert | TablePatch => {
                    tables::execute(&vault, name, &args, p.full_text)
                }
                FileList | FileWrite | FileMove | FileRemove | TrashList | TrashRestore
                | PaperNoteAppend | PaperNoteReplace => {
                    documents::execute(host.as_ref(), &vault, name, &args, receipt.as_ref(), p)
                }
                PaperList | PaperGet | PaperUpdate | PaperRegions | PaperTagList | PaperTagAdd
                | PaperTagRemove | PaperTagSet => catalog::execute(&vault, name, &args),
                PaperDiscover | PaperImport | AnnotationList | AnnotationGet | AnnotationAdd
                | AnnotationUpdate | AnnotationRemove => {
                    unreachable!("asynchronous operation handled above")
                }
            })
            .await
            .map_err(|e| AppError::message(e.to_string()))??
        }
    };
    if let Some(receipt) = stored {
        receipt.save(json!({"result":result}))?;
    }
    if name == "file_remove" && !flag(&args, "dry_run") {
        host.after_delete(&vault, &strings(&args, "paths")).await;
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
