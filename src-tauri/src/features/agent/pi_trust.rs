//! Pi project trust for a local Vault.
//!
//! Pi gates project-local `.agents/skills` and `.pi/*` resources behind a
//! trust decision. In headless RPC mode (`pi --mode rpc`, driven by
//! `pi-acp`) there is no UI to answer "Trust project folder?", so Pi keeps the
//! default `ask` and reports the project as untrusted. Project skills are then
//! skipped silently.
//!
//! Agentero mirrors Pi's own resolution instead of guessing:
//! 1. nearest `true`/`false` entry for the Vault or an ancestor in
//!    `~/.pi/agent/trust.json` (null entries are ignored);
//! 2. otherwise the global `defaultProjectTrust` in
//!    `~/.pi/agent/settings.json` (`always` / `never`, missing or `ask` = ask);
//! 3. `ask` in headless mode = untrusted.
//!
//! Vaults without trust-requiring resources are treated as trusted, matching
//! Pi (`hasTrustRequiringProjectResources`). The user-level
//! `~/.agents/skills` directory is never gated.
//!
//! Granting trust writes only the Vault entry in `trust.json` (merged under
//! the same `.lock` directory convention as Pi's `proper-lockfile`). It never
//! changes `settings.json` and never trusts automatically.

use crate::core::error::AppError;
use crate::features::agent::acp::client::effective_local_agent_env;
use crate::features::agent::models::{AgentDescriptor, AgentTemplate};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

/// Project-local entries whose presence makes Pi ask for folder trust.
const TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES: [&str; 8] = [
    "settings.json",
    "mcp.json",
    "extensions",
    "skills",
    "prompts",
    "themes",
    "SYSTEM.md",
    "APPEND_SYSTEM.md",
];

const TRUST_LOCK_TIMEOUT: Duration = Duration::from_secs(5);
/// Same stale window as `proper-lockfile`'s default (10s, refreshed every 5s).
const TRUST_LOCK_STALE: Duration = Duration::from_secs(10);

/// Effective Pi project-trust state for one local Vault.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PiProjectTrustStatus {
    /// The Vault has `.pi` resources, or the Vault / an ancestor has
    /// `.agents/skills`, so Pi gates them behind project trust.
    pub required: bool,
    /// Pi's effective decision for the Vault. Always `true` when no trust
    /// decision applies and nothing needs gating.
    pub trusted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DefaultProjectTrust {
    Ask,
    Always,
    Never,
}

/// Resolve Pi's `(agent config dir, user home)` exactly like `getAgentDir()`:
/// `PI_CODING_AGENT_DIR` (when non-empty) overrides `~/.pi/agent`.
///
/// `cwd` is the ACP session cwd (the Vault): Pi's own `resolve()` resolves a
/// relative `PI_CODING_AGENT_DIR` against its process cwd, which is that Vault.
pub(crate) fn dirs_from_env(
    env: &HashMap<String, String>,
    cwd: &Path,
) -> Result<(PathBuf, PathBuf), AppError> {
    let home = home_dir_from_env(env)?;
    let raw = env
        .get("PI_CODING_AGENT_DIR")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    let dir = match raw {
        Some("~") => home.clone(),
        Some(value) if value.starts_with("~/") || value.starts_with("~\\") => {
            home.join(&value[2..])
        }
        Some(value) => PathBuf::from(value),
        None => home.join(".pi").join("agent"),
    };
    let dir = if dir.is_absolute() {
        dir
    } else {
        cwd.join(dir)
    };
    Ok((dir, home))
}

fn home_dir_from_env(env: &HashMap<String, String>) -> Result<PathBuf, AppError> {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    env.get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .ok_or_else(|| AppError::message("Pi project trust: cannot locate the user home"))
}

/// Effective trust status for `vault`, using `agent_dir` for `trust.json` /
/// `settings.json` and `home` only to exclude the user-level
/// `~/.agents/skills` from the resource scan.
pub(crate) fn status(
    vault: &Path,
    agent_dir: &Path,
    home: &Path,
) -> Result<PiProjectTrustStatus, AppError> {
    status_inner(vault, agent_dir, home, true)
}

/// `lock = false` is only for the per-turn warm-pool check: a concurrent
/// writer can make the read fail (callers then fall back to no variant), but
/// never yield a valid-looking stale decision.
fn status_inner(
    vault: &Path,
    agent_dir: &Path,
    home: &Path,
    lock: bool,
) -> Result<PiProjectTrustStatus, AppError> {
    let vault = normalize_vault(vault);
    let required = has_trust_requiring_project_resources(&vault, home);
    let trust_path = agent_dir.join("trust.json");
    let decision = nearest_trust_entry(&vault, &trust_path, lock)?;
    let trusted = match decision {
        Some(trusted) => trusted,
        // Pi returns `trustStore.get(cwd) ?? true` when nothing is gated.
        None if !required => true,
        None => match read_default_project_trust(agent_dir)? {
            DefaultProjectTrust::Always => true,
            DefaultProjectTrust::Never => false,
            // Headless RPC has no UI to answer the prompt.
            DefaultProjectTrust::Ask => false,
        },
    };
    Ok(PiProjectTrustStatus { required, trusted })
}

/// Warm-pool identity for a Pi agent: its effective project-trust decision.
///
/// Pi reads `trust.json` / `defaultProjectTrust` once while its process starts,
/// so a connection created before the folder was trusted keeps skipping
/// project resources for its whole lifetime. Keying the warm pool by the
/// decision makes every change — Agentero's grant, Pi's own interactive prompt,
/// or a settings edit — start a fresh process on the next warm/turn.
///
/// `None` for other templates and when the store cannot be resolved; the pool
/// then treats the connection exactly as before.
pub(crate) fn pool_variant(desc: &AgentDescriptor, vault: &Path) -> Option<String> {
    if desc.template != AgentTemplate::Pi {
        return None;
    }
    let env = effective_local_agent_env(desc);
    let (agent_dir, home) = dirs_from_env(&env, vault).ok()?;
    // Runs on every turn, so read without the store lock: a concurrent grant
    // at worst makes this return None and the turn starts cold.
    let status = status_inner(vault, &agent_dir, &home, false).ok()?;
    Some(if status.trusted {
        "pi-trust:trusted".to_string()
    } else {
        "pi-trust:untrusted".to_string()
    })
}

/// Write `trust.json` so this Vault is trusted, then return the new status.
///
/// Existing entries (including `null`) and unrelated keys are preserved;
/// keys naming the same directory with different spelling/case are replaced.
pub(crate) fn grant(
    vault: &Path,
    agent_dir: &Path,
    home: &Path,
) -> Result<PiProjectTrustStatus, AppError> {
    let vault = normalize_vault(vault);
    let trust_path = agent_dir.join("trust.json");
    fs::create_dir_all(agent_dir).map_err(|error| {
        AppError::message(format!(
            "Pi project trust: cannot create {}: {error}",
            agent_dir.display()
        ))
    })?;
    {
        let _lock = TrustLock::acquire(&trust_path)?;
        let mut data = read_trust_file(&trust_path)?;
        data.retain(|key, _| !paths_equal_str(key, &vault));
        data.insert(vault_key(&vault), Some(true));
        write_trust_file(&trust_path, &data)?;
    }
    status(&vault, agent_dir, home)
}

fn normalize_vault(vault: &Path) -> PathBuf {
    crate::core::process::windows_shell_path(&crate::core::fs::canonicalize_best_effort(vault))
}

fn vault_key(vault: &Path) -> String {
    vault.to_string_lossy().into_owned()
}

fn has_trust_requiring_project_resources(vault: &Path, home: &Path) -> bool {
    let config_dir = vault.join(".pi");
    if TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES
        .iter()
        .any(|entry| config_dir.join(entry).exists())
    {
        return true;
    }

    let home = normalize_vault(home);
    let user_agents_skills = home.join(".agents").join("skills");
    let mut current = vault.to_path_buf();
    loop {
        let agents_skills = current.join(".agents").join("skills");
        if !paths_equal(&agents_skills, &user_agents_skills) && agents_skills.exists() {
            return true;
        }
        let Some(parent) = current.parent() else {
            return false;
        };
        if parent == current {
            return false;
        }
        current = parent.to_path_buf();
    }
}

fn nearest_trust_entry(
    vault: &Path,
    trust_path: &Path,
    lock: bool,
) -> Result<Option<bool>, AppError> {
    // Do not create `~/.pi/agent` just to read a missing store; Pi is the only
    // process that should decide when the config directory appears.
    if !trust_path.exists() {
        return Ok(None);
    }
    let _lock = if lock {
        Some(TrustLock::acquire(trust_path)?)
    } else {
        None
    };
    let data = read_trust_file(trust_path)?;
    Ok(find_nearest_trust_entry(&data, vault))
}

fn find_nearest_trust_entry(data: &BTreeMap<String, Option<bool>>, vault: &Path) -> Option<bool> {
    let mut current = vault.to_path_buf();
    loop {
        for (key, value) in data {
            let Some(decision) = value else {
                continue;
            };
            if paths_equal_str(key, &current) {
                return Some(*decision);
            }
        }
        let parent = current.parent()?;
        if parent == current {
            return None;
        }
        current = parent.to_path_buf();
    }
}

fn read_default_project_trust(agent_dir: &Path) -> Result<DefaultProjectTrust, AppError> {
    let path = agent_dir.join("settings.json");
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(DefaultProjectTrust::Ask),
        Err(error) => {
            return Err(AppError::message(format!(
                "Pi project trust: cannot read {}: {error}",
                path.display()
            )))
        }
    };
    let text = strip_bom(&text);
    let value: serde_json::Value = serde_json::from_str(text).map_err(|error| {
        AppError::message(format!(
            "Pi project trust: invalid settings {}: {error}",
            path.display()
        ))
    })?;
    // Pi's settings manager only accepts "always" / "never" and otherwise
    // falls back to the default "ask".
    Ok(
        match value.get("defaultProjectTrust").and_then(|v| v.as_str()) {
            Some("always") => DefaultProjectTrust::Always,
            Some("never") => DefaultProjectTrust::Never,
            _ => DefaultProjectTrust::Ask,
        },
    )
}

fn read_trust_file(path: &Path) -> Result<BTreeMap<String, Option<bool>>, AppError> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => {
            return Err(AppError::message(format!(
                "Pi project trust: cannot read {}: {error}",
                path.display()
            )))
        }
    };
    let value: serde_json::Value = serde_json::from_str(strip_bom(&text)).map_err(|error| {
        AppError::message(format!(
            "Failed to read trust store {}: {error}",
            path.display()
        ))
    })?;
    let Some(object) = value.as_object() else {
        return Err(AppError::message(format!(
            "Invalid trust store {}: expected an object",
            path.display()
        )));
    };
    let mut data = BTreeMap::new();
    for (key, value) in object {
        match value {
            serde_json::Value::Bool(decision) => {
                data.insert(key.clone(), Some(*decision));
            }
            serde_json::Value::Null => {
                data.insert(key.clone(), None);
            }
            _ => {
                return Err(AppError::message(format!(
                    "Invalid trust store {}: value for {key:?} must be true, false, or null",
                    path.display()
                )))
            }
        }
    }
    Ok(data)
}

fn write_trust_file(path: &Path, data: &BTreeMap<String, Option<bool>>) -> Result<(), AppError> {
    let mut text = serde_json::to_string_pretty(data).map_err(|error| {
        AppError::message(format!(
            "Pi project trust: cannot encode {}: {error}",
            path.display()
        ))
    })?;
    text.push('\n');
    fs::write(path, text).map_err(|error| {
        AppError::message(format!(
            "Pi project trust: cannot write {}: {error}",
            path.display()
        ))
    })
}

fn strip_bom(text: &str) -> &str {
    text.strip_prefix('\u{feff}').unwrap_or(text)
}

/// Path comparison mirrors Pi's `pathsEqual`: resolve lexical relative keys
/// against the process cwd, compare resolved strings, case-fold on Windows.
fn paths_equal_str(left: &str, right: &Path) -> bool {
    path_key(Path::new(left)) == path_key(right)
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    path_key(left) == path_key(right)
}

fn path_key(path: &Path) -> String {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };
    let mut value = path.to_string_lossy().into_owned();
    if cfg!(windows) {
        value = value.replace('/', "\\");
        while value.len() > 3 && value.ends_with('\\') {
            value.pop();
        }
        value.to_lowercase()
    } else {
        while value.len() > 1 && value.ends_with('/') {
            value.pop();
        }
        value
    }
}

/// Directory lock compatible with Pi's `proper-lockfile` path (`.lock` beside
/// the trust file). Held only for the read-modify-write of `trust.json`.
struct TrustLock {
    path: PathBuf,
}

impl TrustLock {
    fn acquire(trust_path: &Path) -> Result<Self, AppError> {
        let lock_path = PathBuf::from(format!("{}.lock", trust_path.to_string_lossy()));
        if let Some(parent) = lock_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                AppError::message(format!(
                    "Pi project trust: cannot create {}: {error}",
                    parent.display()
                ))
            })?;
        }
        let deadline = Instant::now() + TRUST_LOCK_TIMEOUT;
        loop {
            match fs::create_dir(&lock_path) {
                Ok(()) => return Ok(Self { path: lock_path }),
                Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                    if lock_is_stale(&lock_path) {
                        let _ = fs::remove_dir(&lock_path);
                        continue;
                    }
                    if Instant::now() >= deadline {
                        return Err(AppError::message(format!(
                            "Pi project trust: timed out waiting for {}",
                            lock_path.display()
                        )));
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(error) => {
                    return Err(AppError::message(format!(
                        "Pi project trust: cannot lock {}: {error}",
                        lock_path.display()
                    )))
                }
            }
        }
    }
}

impl Drop for TrustLock {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.path);
    }
}

fn lock_is_stale(path: &Path) -> bool {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age > TRUST_LOCK_STALE)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        _tmp: tempfile::TempDir,
        home: PathBuf,
        agent_dir: PathBuf,
        vault: PathBuf,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let root = crate::core::fs::canonicalize_best_effort(tmp.path());
        let home = root.join("home");
        let agent_dir = home.join(".pi").join("agent");
        let vault = root.join("project").join("vault");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&vault).unwrap();
        Fixture {
            _tmp: tmp,
            home,
            agent_dir,
            vault,
        }
    }

    impl Fixture {
        fn with_project_skills(&self) {
            fs::create_dir_all(self.vault.join(".agents/skills/demo")).unwrap();
        }

        fn trust_path(&self) -> PathBuf {
            self.agent_dir.join("trust.json")
        }

        fn write_trust(&self, entries: serde_json::Value) {
            fs::create_dir_all(&self.agent_dir).unwrap();
            fs::write(
                self.trust_path(),
                format!("{}\n", serde_json::to_string_pretty(&entries).unwrap()),
            )
            .unwrap();
        }

        fn write_settings(&self, value: serde_json::Value) {
            fs::create_dir_all(&self.agent_dir).unwrap();
            fs::write(
                self.agent_dir.join("settings.json"),
                serde_json::to_string(&value).unwrap(),
            )
            .unwrap();
        }

        fn status(&self) -> PiProjectTrustStatus {
            status(&self.vault, &self.agent_dir, &self.home).unwrap()
        }
    }

    fn canonical(path: &Path) -> PathBuf {
        normalize_vault(path)
    }

    #[test]
    fn no_agents_skills_is_trusted_without_a_prompt() {
        let fixture = fixture();
        // A bare `.agents` directory is not a Pi resource; only `.agents/skills`
        // (or `.pi/*`) requires folder trust.
        fs::create_dir_all(fixture.vault.join(".agents/not-skills")).unwrap();
        assert_eq!(
            fixture.status(),
            PiProjectTrustStatus {
                required: false,
                trusted: true,
            }
        );
    }

    #[test]
    fn project_pi_resources_require_trust() {
        let fixture = fixture();
        fs::create_dir_all(fixture.vault.join(".pi")).unwrap();
        fs::write(fixture.vault.join(".pi/settings.json"), "{}").unwrap();
        assert_eq!(
            fixture.status(),
            PiProjectTrustStatus {
                required: true,
                trusted: false,
            }
        );
    }

    #[test]
    fn ancestor_trust_entry_is_inherited() {
        let fixture = fixture();
        fixture.with_project_skills();
        fixture.write_trust(serde_json::json!({
            canonical(fixture.vault.parent().unwrap()).to_string_lossy(): true,
        }));
        assert_eq!(
            fixture.status(),
            PiProjectTrustStatus {
                required: true,
                trusted: true,
            }
        );
    }

    #[test]
    fn explicit_false_overrides_trusted_ancestor() {
        let fixture = fixture();
        fixture.with_project_skills();
        fixture.write_trust(serde_json::json!({
            canonical(fixture.vault.parent().unwrap()).to_string_lossy(): true,
            canonical(&fixture.vault).to_string_lossy(): false,
        }));
        assert_eq!(
            fixture.status(),
            PiProjectTrustStatus {
                required: true,
                trusted: false,
            }
        );
    }

    #[test]
    fn default_project_trust_always_and_never_apply_without_entries() {
        let fixture = fixture();
        fixture.with_project_skills();
        fixture.write_settings(serde_json::json!({ "defaultProjectTrust": "always" }));
        assert!(fixture.status().trusted);

        fixture.write_settings(serde_json::json!({ "defaultProjectTrust": "never" }));
        assert!(!fixture.status().trusted);
    }

    #[test]
    fn missing_trust_file_with_ask_is_untrusted_when_resources_exist() {
        let fixture = fixture();
        fixture.with_project_skills();
        assert_eq!(
            fixture.status(),
            PiProjectTrustStatus {
                required: true,
                trusted: false,
            }
        );
    }

    #[test]
    fn ancestor_agents_skills_require_trust_but_home_user_skills_do_not() {
        let fixture = fixture();
        let skills_root = canonical(fixture.vault.parent().unwrap());
        fs::create_dir_all(skills_root.join(".agents/skills/demo")).unwrap();
        assert!(fixture.status().required);

        // A Vault under $HOME sees $HOME/.agents/skills while walking parents;
        // Pi deliberately treats that directory as user-level (never gated).
        let home_vault = fixture.home.join("vault");
        fs::create_dir_all(&home_vault).unwrap();
        fs::create_dir_all(fixture.home.join(".agents/skills/user-skill")).unwrap();
        let status = status(&home_vault, &fixture.agent_dir, &fixture.home).unwrap();
        assert!(!status.required);
        assert!(status.trusted);
    }

    #[test]
    fn grant_merges_entries_and_preserves_unrelated_keys() {
        let fixture = fixture();
        fixture.with_project_skills();
        let vault_key = canonical(&fixture.vault).to_string_lossy().into_owned();
        let other_key = canonical(fixture.vault.parent().unwrap())
            .join("other")
            .to_string_lossy()
            .into_owned();
        fixture.write_settings(serde_json::json!({ "defaultProjectTrust": "never" }));
        fixture.write_trust(serde_json::json!({
            other_key.clone(): true,
            vault_key.clone(): false,
            "/removed/entry": serde_json::Value::Null,
        }));

        let status = grant(&fixture.vault, &fixture.agent_dir, &fixture.home).unwrap();
        assert_eq!(
            status,
            PiProjectTrustStatus {
                required: true,
                trusted: true,
            }
        );

        let raw = fs::read_to_string(fixture.trust_path()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed[&other_key], serde_json::json!(true));
        assert_eq!(parsed[&vault_key], serde_json::json!(true));
        assert_eq!(parsed["/removed/entry"], serde_json::Value::Null);
        assert_eq!(parsed.as_object().unwrap().len(), 3);
        // Never rewrite the global default just because one project was trusted.
        let settings = fs::read_to_string(fixture.agent_dir.join("settings.json")).unwrap();
        assert!(settings.contains("\"never\""));
        assert!(!fixture.agent_dir.join("trust.json.lock").exists());
    }

    #[test]
    fn agent_dir_follows_pi_environment_override() {
        let fixture = fixture();
        let mut env = HashMap::new();
        env.insert(
            if cfg!(windows) { "USERPROFILE" } else { "HOME" }.to_string(),
            fixture.home.to_string_lossy().into_owned(),
        );
        env.insert("PI_CODING_AGENT_DIR".to_string(), "~/custom-pi".to_string());
        assert_eq!(
            dirs_from_env(&env, &fixture.vault).unwrap().0,
            fixture.home.join("custom-pi")
        );

        // Pi resolves a relative override against its process cwd (the Vault).
        env.insert(
            "PI_CODING_AGENT_DIR".to_string(),
            "relative/agent".to_string(),
        );
        assert_eq!(
            dirs_from_env(&env, &fixture.vault).unwrap().0,
            fixture.vault.join("relative/agent")
        );
    }

    #[test]
    fn pool_variant_follows_the_effective_decision() {
        let fixture = fixture();
        fixture.with_project_skills();
        let mut env = HashMap::new();
        env.insert(
            if cfg!(windows) { "USERPROFILE" } else { "HOME" }.to_string(),
            fixture.home.to_string_lossy().into_owned(),
        );
        env.insert(
            "PI_CODING_AGENT_DIR".to_string(),
            fixture.agent_dir.to_string_lossy().into_owned(),
        );
        let mut desc = AgentDescriptor {
            id: "catalog-pi".into(),
            name: "Pi".into(),
            template: AgentTemplate::Pi,
            command: "pi-acp".into(),
            args: Vec::new(),
            env,
            available: true,
            last_error: None,
            last_probe_ok: None,
            last_probe_agent_name: None,
            last_probe_error: None,
            last_probed_at: None,
        };
        assert_eq!(
            pool_variant(&desc, &fixture.vault).as_deref(),
            Some("pi-trust:untrusted")
        );

        grant(&fixture.vault, &fixture.agent_dir, &fixture.home).unwrap();
        assert_eq!(
            pool_variant(&desc, &fixture.vault).as_deref(),
            Some("pi-trust:trusted")
        );

        // Only Pi gates project resources behind a startup decision.
        desc.template = AgentTemplate::CodexAcp;
        assert_eq!(pool_variant(&desc, &fixture.vault), None);
    }
}
