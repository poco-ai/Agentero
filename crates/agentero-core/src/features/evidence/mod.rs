//! Versioned research sources shared by the CLI and MCP adapters.
mod access;
mod metadata;
pub use metadata::{paper_brief, paper_detail};
mod read;
mod relations;
mod search;

pub use access::execute_scoped;
pub use read::{page_revision, read};
pub use relations::{relations, relations_page};
pub use search::{search, source_kind};

use crate::error::AppError;
use crate::features::paper::catalog::papers::{self, PaperRecord, PaperRefLookup};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

type Result<T> = std::result::Result<T, AppError>;

#[derive(Debug, Default, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SearchInput {
    pub query: String,
    #[serde(default, rename = "in")]
    pub scope: Vec<String>,
    #[serde(default)]
    pub kind: Vec<String>,
    #[serde(default)]
    pub tag: Vec<String>,
    #[serde(rename = "match")]
    pub matching: Option<String>,
    pub limit: Option<usize>,
    pub cursor: Option<String>,
}

#[derive(Debug, Default, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReadInput {
    pub source: String,
    pub part: Option<String>,
    pub pages: Option<Vec<u32>>,
    pub section: Option<String>,
    pub region: Option<String>,
    pub quote: Option<String>,
    pub lines: Option<String>,
    pub max_chars: Option<usize>,
    pub cursor: Option<String>,
}

pub fn parse_pages(raw: &str) -> Result<Vec<u32>> {
    let mut pages = BTreeSet::new();
    for token in raw.split(',') {
        let (from, to) = positive_range(token)?;
        if to - from >= 200 {
            return Err(usage("select at most 200 pages"));
        }
        pages.extend(from..=to);
        if pages.len() > 200 {
            return Err(usage("select at most 200 pages"));
        }
    }
    Ok(pages.into_iter().collect())
}

fn positive_range(raw: &str) -> Result<(u32, u32)> {
    let (a, b) = raw.split_once('-').unwrap_or((raw, raw));
    let number = |s: &str| {
        s.trim()
            .parse::<u32>()
            .ok()
            .filter(|n| *n > 0)
            .ok_or_else(|| usage("expected a positive page or line number"))
    };
    let (a, b) = (number(a)?, number(b)?);
    if a > b {
        return Err(usage("range end precedes its start"));
    }
    Ok((a, b))
}

fn usage(msg: &str) -> AppError {
    AppError::domain("usage", msg)
}
fn missing(msg: &str) -> AppError {
    AppError::domain("source_not_found", msg)
}
fn denied() -> AppError {
    AppError::domain(
        "scope_denied",
        "source is outside the allowed research scope",
    )
}
pub fn content_revision(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn vault_key(vault: &Path) -> Result<String> {
    let path = std::fs::canonicalize(vault)?;
    Ok(content_revision(path.to_string_lossy().as_bytes())[..16].to_owned())
}
fn validate_rel(rel: &str) -> Result<()> {
    if rel.is_empty()
        || rel.starts_with(['/', '\\'])
        || rel.as_bytes().get(1) == Some(&b':')
        || rel
            .split(['/', '\\'])
            .any(|s| s.is_empty() || s.starts_with('.') || s.eq_ignore_ascii_case("node_modules"))
    {
        return Err(denied());
    }
    Ok(())
}
fn existing(vault: &Path, rel: &str) -> Result<PathBuf> {
    validate_rel(rel)?;
    let root = std::fs::canonicalize(vault)?;
    let path = std::fs::canonicalize(root.join(rel.replace('\\', "/"))).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            missing(rel)
        } else {
            e.into()
        }
    })?;
    access::check_resolved(&root, rel, &path)?;
    let target = path.strip_prefix(root).map_err(|_| denied())?;
    validate_rel(&target.to_string_lossy())?;
    Ok(path)
}
fn relative(vault: &Path, path: &Path) -> Result<String> {
    Ok(path
        .strip_prefix(std::fs::canonicalize(vault)?)
        .map_err(|_| denied())?
        .to_string_lossy()
        .replace('\\', "/"))
}
fn paper(vault: &Path, id: &str) -> Result<Option<Box<PaperRecord>>> {
    match papers::lookup_paper_ref(vault, id)? {
        PaperRefLookup::Found(p) => {
            existing(vault, &p.path)?;
            Ok(Some(p))
        }
        PaperRefLookup::NotFound => Ok(None),
        PaperRefLookup::Ambiguous(paths) => Err(AppError::domain(
            "paper_ambiguous",
            format!("select one of {}", paths.join(", ")),
        )),
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Citation {
    path: String,
    revision: String,
    kind: String,
    locator: Value,
}
pub fn make_citation(
    vault: &Path,
    path: &str,
    revision: &str,
    kind: &str,
    locator: &Value,
) -> Result<String> {
    let cite = Citation {
        path: path.into(),
        revision: revision.into(),
        kind: kind.into(),
        locator: locator.clone(),
    };
    Ok(format!(
        "agentero://cite/{}/{}",
        vault_key(vault)?,
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&cite)?)
    ))
}
fn decode_citation(vault: &Path, uri: &str) -> Result<Citation> {
    // The protocol layer verifies excerpt proofs. The underlying locator is portable.
    let uri = uri
        .split_once("#excerpt=")
        .map_or(uri, |(source, _)| source);
    let (key, payload) = uri
        .strip_prefix("agentero://cite/")
        .and_then(|s| s.split_once('/'))
        .ok_or_else(|| usage("invalid citation URI"))?;
    if key != vault_key(vault)? {
        return Err(denied());
    }
    if payload.len() > 65536 {
        return Err(usage("citation too long"));
    }
    let cite: Citation = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(payload)
            .map_err(|_| usage("invalid citation"))?,
    )
    .map_err(|_| usage("invalid citation"))?;
    validate_rel(&cite.path)?;
    Ok(cite)
}
fn current_revision(vault: &Path, rel: &str, kind: &str, locator: &Value) -> Result<String> {
    let path = existing(vault, rel)?;
    Ok(if path.is_file() {
        file_revision(&path)?
    } else if kind == "body" && (locator.get("page").is_some() || locator.get("region").is_some()) {
        read::page_revision(vault, rel)?
    } else if kind == "body" {
        if let Some(tex) = crate::features::paper::source::read_tex(&path) {
            content_revision(tex.text.as_bytes())
        } else {
            page_revision(vault, rel)?
        }
    } else if let Some(p) = paper(vault, rel)? {
        content_revision(&serde_json::to_vec(&p)?)
    } else {
        read::directory_revision(vault, rel)?
    })
}

pub(crate) fn current_citation(
    vault: &Path,
    path: &str,
    kind: &str,
    locator: &Value,
) -> Result<String> {
    make_citation(
        vault,
        path,
        &current_revision(vault, path, kind, locator)?,
        kind,
        locator,
    )
}

pub fn resolve_citation(vault: &Path, uri: &str) -> Result<(String, Value)> {
    let c = decode_citation(vault, uri)?;
    let rev = current_revision(vault, &c.path, &c.kind, &c.locator)?;
    if c.revision != rev {
        return Err(AppError::domain(
            "stale_citation",
            "source changed; search again to find the current passage",
        ));
    }
    Ok((c.path, c.locator))
}
pub(crate) fn file_revision(path: &Path) -> Result<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buf = [0u8; 32768];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    Ok(hex::encode(hash.finalize()))
}
fn card(
    vault: &Path,
    source: &str,
    kind: &str,
    locator: Value,
    revision: &str,
    excerpt: &str,
) -> Result<Value> {
    Ok(
        json!({"source":source,"kind":kind,"revision":revision,"excerpt":excerpt,"locator":locator,
        "cite":make_citation(vault,source,revision,kind,&locator)?}),
    )
}

#[derive(Serialize, Deserialize)]
struct Cursor {
    query: String,
    revision: String,
    offset: usize,
}
fn query_key(vault: &Path, args: &impl Serialize) -> Result<String> {
    Ok(content_revision(&serde_json::to_vec(&(
        vault_key(vault)?,
        args,
    ))?))
}
fn offset(cursor: Option<&str>, key: &str, rev: &str) -> Result<usize> {
    let Some(raw) = cursor else { return Ok(0) };
    let parsed: Cursor = URL_SAFE_NO_PAD
        .decode(raw)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .ok_or_else(|| AppError::domain("invalid_cursor", "invalid cursor"))?;
    if parsed.query != key {
        return Err(AppError::domain(
            "invalid_cursor",
            "repeat the original query and selectors",
        ));
    }
    if parsed.revision != rev {
        return Err(AppError::domain(
            "stale_cursor",
            "source changed; restart the query",
        ));
    }
    Ok(parsed.offset)
}
fn next(key: &str, rev: &str, end: usize, len: usize) -> Result<Option<String>> {
    if end >= len {
        return Ok(None);
    }
    Ok(Some(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&Cursor {
        query: key.into(),
        revision: rev.into(),
        offset: end,
    })?)))
}
fn list_page(items: Vec<Value>, cursor: Option<&str>, key: &str, limit: usize) -> Result<Value> {
    let revision = content_revision(&serde_json::to_vec(&items)?);
    let start = offset(cursor, key, &revision)?;
    if start > items.len() {
        return Err(usage("cursor offset is out of bounds"));
    }
    let end = start.saturating_add(limit).min(items.len());
    Ok(json!({"items":&items[start..end],"next_cursor":next(key,&revision,end,items.len())?}))
}
