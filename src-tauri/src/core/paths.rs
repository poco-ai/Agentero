//! Application data directories following the [XDG Base Directory
//! Specification](https://specifications.freedesktop.org/basedir-spec/latest/).
//!
//! | Kind | Env | Default (Unix) | Contents |
//! |------|-----|----------------|----------|
//! | config | `$XDG_CONFIG_HOME` | `~/.config` | `agentero/settings.json`, `agents.json` |
//! | cache | `$XDG_CACHE_HOME` | `~/.cache` | remote work mirrors, PDF blobs |
//! | data | `$XDG_DATA_HOME` | `~/.local/share` | `usage.sqlite` (device-local activity), `feeds.sqlite` |
//! | state | `$XDG_STATE_HOME` | `~/.local/state` | reserved |
//!
//! On Windows and iOS, when XDG env vars are unset, falls back to the platform
//! dirs crate (Windows: `config` → `%APPDATA%`, `cache` → `%LOCALAPPDATA%`;
//! iOS: `Library/Application Support` / `Library/Caches` — the container root
//! itself is not writable, so `~/.config` would fail with EPERM).

use std::path::PathBuf;

/// Resolve XDG config home (`$XDG_CONFIG_HOME` or platform default).
pub fn xdg_config_home() -> PathBuf {
    if let Some(p) = env_dir("XDG_CONFIG_HOME") {
        return p;
    }
    #[cfg(any(windows, target_os = "ios"))]
    {
        dirs::config_dir().unwrap_or_else(|| PathBuf::from("."))
    }
    #[cfg(not(any(windows, target_os = "ios")))]
    {
        home_dir().join(".config")
    }
}

/// Resolve XDG cache home (`$XDG_CACHE_HOME` or platform default).
pub fn xdg_cache_home() -> PathBuf {
    if let Some(p) = env_dir("XDG_CACHE_HOME") {
        return p;
    }
    #[cfg(any(windows, target_os = "ios"))]
    {
        dirs::cache_dir().unwrap_or_else(|| PathBuf::from("."))
    }
    #[cfg(not(any(windows, target_os = "ios")))]
    {
        home_dir().join(".cache")
    }
}

/// `$XDG_CONFIG_HOME/agentero` (created on demand by callers).
pub fn agentero_config_dir() -> PathBuf {
    xdg_config_home().join("agentero")
}

/// Resolve XDG data home (`$XDG_DATA_HOME` or platform default).
pub fn xdg_data_home() -> PathBuf {
    if let Some(p) = env_dir("XDG_DATA_HOME") {
        return p;
    }
    #[cfg(any(windows, target_os = "ios"))]
    {
        dirs::data_dir().unwrap_or_else(|| PathBuf::from("."))
    }
    #[cfg(not(any(windows, target_os = "ios")))]
    {
        home_dir().join(".local").join("share")
    }
}

/// `$XDG_CACHE_HOME/agentero` (created on demand by callers).
pub fn agentero_cache_dir() -> PathBuf {
    xdg_cache_home().join("agentero")
}

/// `$XDG_DATA_HOME/agentero` (created on demand by callers).
pub fn agentero_data_dir() -> PathBuf {
    xdg_data_home().join("agentero")
}

/// Device-local activity log: `…/agentero/usage.sqlite`.
pub fn usage_db_path() -> PathBuf {
    agentero_data_dir().join("usage.sqlite")
}

/// Plaza feed subscriptions + item cache: `…/agentero/feeds.sqlite`.
pub fn feeds_db_path() -> PathBuf {
    agentero_data_dir().join("feeds.sqlite")
}

/// ONNX / other large assets: `$XDG_CACHE_HOME/agentero/models`.
pub fn agentero_models_dir() -> PathBuf {
    agentero_cache_dir().join("models")
}

/// Owned by the built-in ChatGPT tunnel supervisor:
/// `$XDG_CACHE_HOME/agentero/mcp-tunnel` (private `--profile-dir`, health url, log).
pub fn mcp_tunnel_dir() -> PathBuf {
    agentero_cache_dir().join("mcp-tunnel")
}

/// App settings file: `…/agentero/settings.json`.
pub fn settings_path() -> PathBuf {
    agentero_config_dir().join("settings.json")
}

/// Agent registry file: `…/agentero/agents.json`.
pub fn agents_path() -> PathBuf {
    agentero_config_dir().join("agents.json")
}

/// Long-lived desktop Bridge identity and paired-device registry.
pub fn bridge_config_dir() -> PathBuf {
    agentero_config_dir().join("bridge")
}

/// Pre-XDG path used by older builds (`dirs::config_dir()/agentero`).
/// On Linux this often equals the XDG path; on macOS it was
/// `~/Library/Application Support/agentero`.
pub fn legacy_config_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|p| p.join("agentero"))
}

/// If `target` is missing but a legacy file exists, copy it once (best-effort).
pub fn migrate_legacy_file(file_name: &str, target: &std::path::Path) {
    if target.exists() {
        return;
    }
    let Some(legacy_dir) = legacy_config_dir() else {
        return;
    };
    // Same directory as the new path — nothing to migrate.
    if legacy_dir == agentero_config_dir() {
        return;
    }
    let src = legacy_dir.join(file_name);
    if !src.is_file() {
        return;
    }
    if let Some(parent) = target.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::copy(&src, target) {
        Ok(_) => {
            log::info!(
                target: "agentero::paths",
                "migrated {file_name} from {} → {}",
                src.display(),
                target.display()
            );
        }
        Err(e) => {
            log::warn!(
                target: "agentero::paths",
                "failed to migrate {file_name} from {}: {e}",
                src.display()
            );
        }
    }
}

fn env_dir(key: &str) -> Option<PathBuf> {
    std::env::var_os(key)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// Fallback home directory for XDG defaults. Only used where the `~/.config`
/// convention applies (not Windows/iOS), hence the cfg gate to avoid a
/// dead-code warning on those builds.
#[cfg(not(any(windows, target_os = "ios")))]
fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_dir_ends_with_agentero() {
        let p = agentero_config_dir();
        assert_eq!(p.file_name().and_then(|s| s.to_str()), Some("agentero"));
    }

    #[test]
    fn settings_and_agents_share_config_dir() {
        assert_eq!(settings_path().parent(), agents_path().parent());
    }

    #[test]
    fn cache_dir_ends_with_agentero() {
        let p = agentero_cache_dir();
        assert_eq!(p.file_name().and_then(|s| s.to_str()), Some("agentero"));
    }

    #[test]
    fn models_dir_under_cache() {
        let p = agentero_models_dir();
        assert_eq!(p.file_name().and_then(|s| s.to_str()), Some("models"));
        assert_eq!(p.parent(), Some(agentero_cache_dir().as_path()));
    }

    #[test]
    fn mcp_tunnel_dir_under_cache() {
        let p = mcp_tunnel_dir();
        assert_eq!(p.file_name().and_then(|s| s.to_str()), Some("mcp-tunnel"));
        assert_eq!(p.parent(), Some(agentero_cache_dir().as_path()));
    }

    #[test]
    fn data_dir_ends_with_agentero() {
        let p = agentero_data_dir();
        assert_eq!(p.file_name().and_then(|s| s.to_str()), Some("agentero"));
    }

    #[test]
    fn usage_db_under_data_dir() {
        let p = usage_db_path();
        assert_eq!(p.file_name().and_then(|s| s.to_str()), Some("usage.sqlite"));
        assert_eq!(p.parent(), Some(agentero_data_dir().as_path()));
    }

    #[test]
    fn feeds_db_under_data_dir() {
        let p = feeds_db_path();
        assert_eq!(p.file_name().and_then(|s| s.to_str()), Some("feeds.sqlite"));
        assert_eq!(p.parent(), Some(agentero_data_dir().as_path()));
    }
}
