//! `agentero vault *`

use crate::config;
use crate::error::CliError;

use crate::resolve::GlobalOpts;
use agentero_core::features::vault as vault_svc;

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn detect_cli_locale() -> String {
    let env = std::env::var("LC_ALL")
        .or_else(|_| std::env::var("LANG"))
        .unwrap_or_default()
        .to_lowercase();
    if env.starts_with("zh") {
        "zh-CN".into()
    } else {
        "en".into()
    }
}

pub fn inventory(g: &GlobalOpts) -> Result<Value, CliError> {
    let current = crate::resolve::resolve_vault(g).ok();
    let cfg = config::load()?;
    let items=config::list_known_vaults()?.iter().map(|path|{
        let p=Path::new(path);
        let id=p.file_name().unwrap_or_default().to_string_lossy();
        json!({"id":path,"name":cfg.vault_names.get(path).map(String::as_str).unwrap_or(&id),"current":current.as_deref()==Some(p),"path":path})
    }).collect::<Vec<_>>();
    Ok(json!({"items":items}))
}

pub fn info(g: &GlobalOpts) -> Result<Value, CliError> {
    let p = crate::resolve::resolve_vault(g)?;
    let count = agentero_core::features::catalog::papers::list_all(&p)?.len();
    let name = p.file_name().unwrap_or_default().to_string_lossy();
    Ok(
        json!({"id":p,"path":p,"name":config::load()?.vault_names.get(p.to_string_lossy().as_ref()).map(String::as_str).unwrap_or(&name),"current":true,"catalog_state":"ready","paper_count":count}),
    )
}

pub fn create_new(path: &Path, name: Option<&str>, g: &GlobalOpts) -> Result<Value, CliError> {
    let existing = crate::resolve::looks_like_vault(path);
    if path.is_dir() && !existing && path.read_dir()?.next().is_some() {
        return Err(CliError::new(
            "already_exists",
            "choose an empty directory or an existing vault",
            crate::error::ExitCode::Conflict,
        ));
    }
    let result = vault_svc::create_vault(&std::path::absolute(path)?, &detect_cli_locale())?;
    let root = PathBuf::from(result.path);
    config::record_vault(&root)?;
    let mut selected = g.clone();
    selected.vault_flag = Some(root.clone());
    if let Some(name) = name {
        let mut cfg = config::load()?;
        cfg.vault_names
            .insert(root.to_string_lossy().into_owned(), name.into());
        config::save(&cfg)?;
    }
    let mut result = info(&selected)?;
    result["outcome"] = json!(if existing { "existing" } else { "created" });
    Ok(result)
}
