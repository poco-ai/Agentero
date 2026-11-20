//! Vault resolution and paper ref resolution.

use crate::config;
use crate::error::{CliError, ExitCode};
use crate::output::OutputFormat;
use crate::style::Style;
use agentero_core::features::catalog::papers::{self, PaperRecord, PaperRefLookup};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct GlobalOpts {
    pub vault_flag: Option<PathBuf>,
    pub yes: bool,
    pub no_input: bool,
    pub quiet: bool,
    pub translator_url: Option<String>,
    pub format: OutputFormat,

    /// Text-mode paint switch (always false for JSON).
    pub style: Style,
}

impl GlobalOpts {
    pub fn translator_base_url(&self) -> Option<String> {
        if let Some(u) = &self.translator_url {
            let t = u.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
        if let Ok(env) = std::env::var("AGENTERO_TRANSLATOR_URL") {
            let t = env.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
        config::load()
            .ok()
            .and_then(|c| c.translator_base_url)
            .filter(|s| !s.trim().is_empty())
    }
}

/// Resolve the vault from `--vault`, then `AGENTERO_VAULT`, then parent directories.
pub fn resolve_vault(globals: &GlobalOpts) -> Result<PathBuf, CliError> {
    // 1. --vault
    if let Some(p) = &globals.vault_flag {
        return named_vault(p);
    }

    // 2. AGENTERO_VAULT
    if let Ok(env) = std::env::var("AGENTERO_VAULT") {
        let t = env.trim();
        if !t.is_empty() {
            let p = PathBuf::from(t);
            return named_vault(&p).map_err(|_| {
                CliError::vault_not_found(format!("AGENTERO_VAULT is not a directory: {t}"))
            });
        }
    }

    // 3. Walk up from cwd
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(found) = walk_up_vault(&cwd) {
            return Ok(found);
        }
    }

    Err(CliError::new(
        "vault_required",
        "Select a vault with --vault, AGENTERO_VAULT, or cd into the vault directory.",
        ExitCode::Vault,
    ))
}

fn absolutize(p: &Path) -> Result<PathBuf, CliError> {
    if p.is_absolute() {
        Ok(p.to_path_buf())
    } else {
        Ok(std::env::current_dir()?.join(p))
    }
}

fn canonicalize_existing(p: &Path) -> Result<PathBuf, CliError> {
    let abs = absolutize(p)?;
    if !abs.is_dir() {
        return Err(CliError::vault_not_found(format!(
            "not a directory: {}",
            abs.display()
        )));
    }
    Ok(agentero_core::fs::canonicalize_best_effort(&abs))
}

/// True if path looks like an Agentero vault root.
pub fn looks_like_vault(root: &Path) -> bool {
    let catalog = root.join(".agentero").join("catalog.sqlite");
    if catalog.is_file() {
        return true;
    }
    root.join("papers").is_dir() && root.join("notes").is_dir() && root.join(".agentero").is_dir()
}

fn walk_up_vault(start: &Path) -> Option<PathBuf> {
    let mut cur = start.to_path_buf();
    loop {
        if looks_like_vault(&cur) {
            return Some(agentero_core::fs::canonicalize_best_effort(&cur));
        }
        if !cur.pop() {
            return None;
        }
    }
}

/// Resolve paper by path or id (with ambiguity detection).
///
/// When multiple rows share an id and stdin is a TTY (not `--json`), prompts with `inquire::Select`.
pub fn resolve_paper(
    vault: &Path,
    ref_: &str,
    globals: &GlobalOpts,
) -> Result<PaperRecord, CliError> {
    let ref_ = ref_.trim();
    // Keep this precheck: `lookup_paper_ref` reports the same message but as a
    // generic AppError, which would lose the usage exit code.
    if ref_.is_empty() {
        return Err(CliError::usage("paper ref is required"));
    }

    match papers::lookup_paper_ref(vault, ref_)? {
        PaperRefLookup::Found(record) => Ok(*record),
        PaperRefLookup::NotFound => Err(CliError::paper_not_found(ref_)),
        PaperRefLookup::Ambiguous(candidates) => {
            if let Some(path) = crate::prompt::select_one(
                globals,
                &format!("Multiple papers match id '{ref_}'. Choose a vault-relative path"),
                candidates.clone(),
            )? {
                return papers::get_by_path(vault, &path)?
                    .ok_or_else(|| CliError::paper_not_found(&path));
            }
            Err(CliError::paper_ambiguous(ref_, &candidates))
        }
    }
}

pub fn paper_dir(vault: &Path, path_rel: &str) -> PathBuf {
    let mut p = vault.to_path_buf();
    for part in path_rel.split('/').filter(|s| !s.is_empty()) {
        p.push(part);
    }
    p
}

pub fn named_vault(value: &Path) -> Result<PathBuf, CliError> {
    if value.is_dir() {
        let p = canonicalize_existing(value)?;
        if looks_like_vault(&p) {
            return Ok(p);
        }
    }
    let cfg = config::load()?;
    let name = value.to_string_lossy();
    let mut candidates = cfg.known_vaults.iter().filter(|p| {
        cfg.vault_names.get(*p).map(String::as_str) == Some(&name)
            || Path::new(p).file_name() == Some(value.as_os_str())
    });
    let first = candidates.next().ok_or_else(|| {
        CliError::vault_not_found(format!(
            "unknown vault {}; run agentero vault list",
            value.display()
        ))
    })?;
    if candidates.next().is_some() {
        return Err(CliError::new(
            "ambiguous",
            "multiple vaults have this name; select the absolute path",
            crate::error::ExitCode::Conflict,
        ));
    }
    canonicalize_existing(Path::new(first))
}
