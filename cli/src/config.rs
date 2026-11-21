//! CLI-only config in the shared application config directory. The file stays
//! separate from GUI settings, with a non-destructive old-location migration.

use crate::error::CliError;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CliConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_vault: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub translator_base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub known_vaults: Vec<String>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub vault_names: std::collections::BTreeMap<String, String>,
    /// Preserve fields written by newer CLI versions when migrating or saving.
    #[serde(flatten)]
    pub extra: std::collections::BTreeMap<String, toml::Value>,
}

pub fn config_path() -> Result<PathBuf, CliError> {
    Ok(agentero_core::paths::agentero_config_dir().join("config.toml"))
}

/// Before shared paths, the CLI ignored XDG overrides and used ~/.config even
/// on Windows. Keep this only as an input location for the one-time migration.
fn legacy_config_dir() -> Option<PathBuf> {
    dirs::home_dir()
        .map(|h| h.join(".config"))
        .or_else(dirs::config_dir)
        .map(|base| base.join("agentero"))
}

/// Read legacy `vaults.md` entries, if present.
fn read_legacy_known_vaults(path: &Path) -> Result<Vec<String>, CliError> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let trimmed = line
            .trim_start_matches('-')
            .trim_start_matches('*')
            .trim_start_matches(' ')
            .to_string();
        if trimmed.is_empty() {
            continue;
        }
        if seen.insert(trimmed.clone()) {
            out.push(trimmed);
        }
    }
    Ok(out)
}

/// Read all known vault absolute paths, deduplicated and in original order.
pub fn list_known_vaults() -> Result<Vec<String>, CliError> {
    let cfg = load()?;
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for v in &cfg.known_vaults {
        if seen.insert(v.clone()) {
            out.push(v.clone());
        }
    }
    Ok(out)
}

/// Append a vault path to `known_vaults` if it is not already present.
pub fn record_vault(path: &Path) -> Result<(), CliError> {
    let path = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string();
    let mut cfg = load()?;
    if cfg.known_vaults.iter().any(|p| p == &path) {
        return Ok(());
    }
    cfg.known_vaults.push(path);
    save(&cfg)?;
    Ok(())
}

pub fn load() -> Result<CliConfig, CliError> {
    let path = config_path()?;
    load_from(&path, legacy_config_dir().as_deref())
}

fn parse_config(path: &Path, text: &str) -> Result<CliConfig, CliError> {
    toml::from_str(text)
        .map_err(|e| CliError::message(format!("parse config {}: {e}", path.display())))
}

fn load_from(path: &Path, legacy_dir: Option<&Path>) -> Result<CliConfig, CliError> {
    let mut cfg = match fs::read_to_string(path) {
        Ok(text) => parse_config(path, &text)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            migrate_config_file(path, legacy_dir)?
        }
        Err(error) => return Err(error.into()),
    };

    let mut sources = vec![path.with_file_name("vaults.md")];
    if let Some(legacy_dir) = legacy_dir.filter(|dir| Some(*dir) != path.parent()) {
        sources.push(legacy_dir.join("vaults.md"));
    }
    let mut consumed = Vec::new();
    let mut seen: std::collections::HashSet<_> = cfg.known_vaults.iter().cloned().collect();
    for source in sources {
        let legacy = read_legacy_known_vaults(&source)?;
        if !legacy.is_empty() {
            for vault in legacy {
                if seen.insert(vault.clone()) {
                    cfg.known_vaults.push(vault);
                }
            }
            consumed.push(source);
        }
    }
    if !consumed.is_empty() {
        // Never remove the source before the migrated list is safely written.
        save_to(path, &cfg)?;
        for source in consumed {
            let _ = fs::remove_file(source);
        }
    }

    Ok(cfg)
}

fn migrate_config_file(path: &Path, legacy_dir: Option<&Path>) -> Result<CliConfig, CliError> {
    let Some(legacy_dir) = legacy_dir.filter(|dir| Some(*dir) != path.parent()) else {
        return Ok(CliConfig::default());
    };
    let legacy_path = legacy_dir.join("config.toml");
    let text = match fs::read_to_string(&legacy_path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(CliConfig::default()),
        Err(error) => return Err(error.into()),
    };
    let cfg = parse_config(&legacy_path, &text)?;
    let parent = path
        .parent()
        .ok_or_else(|| CliError::message("config path has no parent"))?;
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(text.as_bytes())?;
    temporary.as_file().sync_all()?;
    match temporary.persist_noclobber(path) {
        Ok(_) => Ok(cfg),
        // Another CLI may have created the new config while we read the old
        // file. The new location wins; never overwrite it during migration.
        Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => {
            parse_config(path, &fs::read_to_string(path)?)
        }
        Err(error) => Err(error.error.into()),
    }
}

pub fn save(cfg: &CliConfig) -> Result<PathBuf, CliError> {
    let path = config_path()?;
    save_to(&path, cfg)?;
    Ok(path)
}

fn save_to(path: &Path, cfg: &CliConfig) -> Result<(), CliError> {
    let parent = path
        .parent()
        .ok_or_else(|| CliError::message("config path has no parent"))?;
    fs::create_dir_all(parent)?;
    let text = toml::to_string_pretty(cfg)
        .map_err(|e| CliError::message(format!("serialize config: {e}")))?;
    agentero_core::fs::atomic_write_with(
        path,
        text.as_bytes(),
        &agentero_core::fs::AtomicOpts {
            sync_file: true,
            ..agentero_core::fs::AtomicOpts::OWNER_ONLY
        },
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_config_is_copied_verbatim_without_removing_the_source() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("old");
        fs::create_dir(&legacy).unwrap();
        let original = "# user comment\ndefault_vault = '/vault/旧目录'\nfuture_setting = 42\n";
        fs::write(legacy.join("config.toml"), original).unwrap();
        let target = temp.path().join("xdg/agentero/config.toml");
        let cfg = load_from(&target, Some(&legacy)).unwrap();
        assert_eq!(cfg.default_vault.as_deref(), Some("/vault/旧目录"));
        assert_eq!(fs::read_to_string(&target).unwrap(), original);
        assert_eq!(
            fs::read_to_string(legacy.join("config.toml")).unwrap(),
            original
        );
    }

    #[test]
    fn new_location_wins_even_when_the_legacy_file_is_invalid() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("old");
        fs::create_dir(&legacy).unwrap();
        fs::write(legacy.join("config.toml"), "invalid [").unwrap();
        let target = temp.path().join("config.toml");
        fs::write(&target, "default_vault = '/new'\n").unwrap();
        assert_eq!(
            load_from(&target, Some(&legacy))
                .unwrap()
                .default_vault
                .as_deref(),
            Some("/new")
        );
    }

    #[test]
    fn migration_cannot_overwrite_a_concurrently_created_destination() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("old");
        fs::create_dir(&legacy).unwrap();
        fs::write(legacy.join("config.toml"), "default_vault = '/old'\n").unwrap();
        let target = temp.path().join("config.toml");
        fs::write(&target, "default_vault = '/new'\n").unwrap();
        assert_eq!(
            migrate_config_file(&target, Some(&legacy))
                .unwrap()
                .default_vault
                .as_deref(),
            Some("/new")
        );
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "default_vault = '/new'\n"
        );
    }

    #[test]
    fn invalid_legacy_config_is_retained_and_not_published() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("old");
        fs::create_dir(&legacy).unwrap();
        fs::write(legacy.join("config.toml"), "invalid [").unwrap();
        let target = temp.path().join("new/config.toml");
        assert!(load_from(&target, Some(&legacy)).is_err());
        assert!(!target.exists());
        assert!(legacy.join("config.toml").exists());
    }

    #[test]
    fn legacy_vault_lists_merge_in_order_and_are_removed_after_save() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("old");
        fs::create_dir(&legacy).unwrap();
        let target = temp.path().join("config.toml");
        fs::write(&target, "known_vaults = ['/first']\nfuture_setting = 42\n").unwrap();
        fs::write(target.with_file_name("vaults.md"), "- /first\n- /second\n").unwrap();
        fs::write(legacy.join("vaults.md"), "# vaults\n- /second\n* /third\n").unwrap();
        let cfg = load_from(&target, Some(&legacy)).unwrap();
        assert_eq!(cfg.known_vaults, ["/first", "/second", "/third"]);
        assert_eq!(cfg.extra["future_setting"].as_integer(), Some(42));
        assert_eq!(
            load_from(&target, Some(&legacy)).unwrap().known_vaults,
            cfg.known_vaults
        );
        assert!(!target.with_file_name("vaults.md").exists());
        assert!(!legacy.join("vaults.md").exists());
    }

    #[test]
    fn failed_destination_write_preserves_legacy_vault_list() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("old");
        fs::create_dir(&legacy).unwrap();
        fs::write(legacy.join("vaults.md"), "- /vault\n").unwrap();
        // A file in the destination parent position fails independently of
        // platform permissions or whether the tests run as an administrator.
        let blocked = temp.path().join("blocked");
        fs::write(&blocked, "not a directory").unwrap();
        assert!(load_from(&blocked.join("config.toml"), Some(&legacy)).is_err());
        assert_eq!(
            fs::read_to_string(legacy.join("vaults.md")).unwrap(),
            "- /vault\n"
        );
    }
}
