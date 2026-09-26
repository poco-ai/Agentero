//! Detect whether a catalog Agent CLI has a newer silent-update target.
//!
//! Used by Settings to show the Upgrade button only when a newer version is
//! known — not merely because the binary is installed. Network checks stay out
//! of synchronous `scan_catalog` (Doctor / chat switcher also call that path).

use crate::features::agent::models::CatalogScanResponse;
use crate::features::agent::registry::antigravity;
use crate::features::agent::registry::discovery::resolve_command;
use crate::features::agent::registry::templates::template_info;
use std::collections::HashMap;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const NPM_VERSION_CACHE_TTL: Duration = Duration::from_secs(15 * 60);

struct NpmVersionCache {
    entries: HashMap<String, (Instant, String)>,
}

fn npm_version_cache() -> &'static Mutex<NpmVersionCache> {
    static CACHE: OnceLock<Mutex<NpmVersionCache>> = OnceLock::new();
    CACHE.get_or_init(|| {
        Mutex::new(NpmVersionCache {
            entries: HashMap::new(),
        })
    })
}

/// npm package that silent lifecycle updates toward for a catalog template.
/// Hermes has no stable npm source — callers leave `update_available` unset.
pub fn npm_package_for_template(template_id: &str) -> Option<&'static str> {
    match template_id {
        "opencode" => Some("@opencode/cli"),
        "openclaw" => Some("openclaw"),
        "claude-acp" => Some("@anthropic-ai/claude-code"),
        "codex-acp" => Some("@openai/codex"),
        "pi" => Some("@earendil-works/pi-coding-agent"),
        "grok-build" => Some("@xai-official/grok"),
        "dsh" => Some("@deepseek-ai/dsh"),
        "kimi-code" => Some("@moonshot-ai/kimi-code"),
        "zcode" => Some("zcode-acp-server"),
        "minimax-code" => Some("@minimax-ai/code"),
        _ => None,
    }
}

/// Enrich installed lifecycle rows with version / update-available fields.
/// Rows that cannot be compared keep `update_available` unset (UI hides Upgrade).
pub fn enrich_catalog_updates(
    scan: &mut CatalogScanResponse,
    proxy_enabled: bool,
    proxy_url: &str,
) {
    for entry in &mut scan.entries {
        entry.installed_version = None;
        entry.latest_version = None;
        entry.update_available = None;

        if !entry.can_install || !entry.binary_available {
            continue;
        }

        let Some(installed) = read_installed_version(&entry.template_id) else {
            continue;
        };

        let latest = latest_version_for_template(&entry.template_id, proxy_enabled, proxy_url);
        (
            entry.installed_version,
            entry.latest_version,
            entry.update_available,
        ) = version_check_fields(installed, latest);
    }
}

/// Version fields for one catalog row: the installed version always, plus the
/// newest silent-update target and its newer-than comparison once a target is
/// known (an unknown target leaves Upgrade hidden).
fn version_check_fields(
    installed: String,
    latest: Option<String>,
) -> (Option<String>, Option<String>, Option<bool>) {
    match latest {
        Some(latest) => {
            let update_available = is_newer(&latest, &installed);
            (Some(installed), Some(latest), Some(update_available))
        }
        None => (Some(installed), None, None),
    }
}

/// Newest version the silent updater can reach for a template. npm-based
/// agents use the package dist-tag; Antigravity ships no npm package and is
/// served by the ACP registry manifest instead.
fn latest_version_for_template(
    template_id: &str,
    proxy_enabled: bool,
    proxy_url: &str,
) -> Option<String> {
    if template_id == "antigravity-acp" {
        // Registry is the only source (the ACP server has no npm package); an
        // unreachable registry yields no target, so the row keeps the version
        // recorded by the installer and shows no Upgrade button.
        return match antigravity::resolve_release(proxy_enabled, proxy_url) {
            Ok(release) => Some(release.version),
            Err(error) => {
                log::warn!(
                    target: "agentero::agent",
                    "antigravity version check failed: {error}"
                );
                None
            }
        };
    }
    npm_package_for_template(template_id)
        .and_then(|pkg| npm_view_version(pkg, proxy_enabled, proxy_url))
}

fn read_installed_version(template_id: &str) -> Option<String> {
    // Antigravity is a managed archive download: the installer records its
    // release in a version marker, and the ACP server has no `--version`.
    if template_id == "antigravity-acp" {
        return antigravity::installed_version();
    }
    let info = template_info(template_id)?;
    let detect = info
        .detect_command
        .as_deref()
        .unwrap_or(info.command.as_str());
    let path = resolve_command(detect)?;

    let mut cmd = Command::new(&path);
    cmd.arg("--version");
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let line = text
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    extract_version_token(line).map(|v| normalize_version(&v).to_string())
}

fn npm_view_version(package: &str, proxy_enabled: bool, proxy_url: &str) -> Option<String> {
    if let Some(cached) = cached_npm_version(package) {
        return Some(cached);
    }
    let npm = resolve_command("npm")?;
    let mut cmd = Command::new(npm);
    cmd.args(["view", package, "version"]);
    apply_proxy_env(&mut cmd, proxy_enabled, proxy_url);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let version = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| normalize_version(line).to_string())?;
    if version.is_empty() {
        return None;
    }
    store_npm_version(package, version.clone());
    Some(version)
}

fn cached_npm_version(package: &str) -> Option<String> {
    let Ok(cache) = npm_version_cache().lock() else {
        return None;
    };
    let (at, version) = cache.entries.get(package)?;
    if at.elapsed() > NPM_VERSION_CACHE_TTL {
        return None;
    }
    Some(version.clone())
}

fn store_npm_version(package: &str, version: String) {
    if let Ok(mut cache) = npm_version_cache().lock() {
        cache
            .entries
            .insert(package.to_string(), (Instant::now(), version));
    }
}

fn apply_proxy_env(cmd: &mut Command, proxy_enabled: bool, proxy_url: &str) {
    for key in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] {
        cmd.env_remove(key);
        cmd.env_remove(key.to_ascii_lowercase());
    }
    if proxy_enabled {
        let proxy_url = proxy_url.trim();
        if !proxy_url.is_empty() {
            for key in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] {
                cmd.env(key, proxy_url);
            }
        }
    }
}

/// Strip a leading `v` for comparison / display.
pub fn normalize_version(raw: &str) -> &str {
    raw.trim().trim_start_matches(['v', 'V'])
}

/// Pull a semver-ish token from a `--version` banner line.
pub fn extract_version_token(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Prefer the last whitespace token that starts with a digit (optionally after v).
    let from_tokens = trimmed.split_whitespace().rev().find_map(|token| {
        let candidate = token
            .trim_matches(|c: char| matches!(c, ',' | ';' | ')' | '(' | '[' | ']' | '"' | '\''));
        let stripped = candidate.trim_start_matches(['v', 'V']);
        if stripped.chars().next().is_some_and(|c| c.is_ascii_digit()) {
            Some(stripped.to_string())
        } else {
            None
        }
    });
    if from_tokens.is_some() {
        return from_tokens;
    }
    // Fallback: first digit run in the line (e.g. `version:1.2.3`).
    let bytes = trimmed.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len()
                && (bytes[i].is_ascii_alphanumeric() || matches!(bytes[i], b'.' | b'-' | b'+'))
            {
                i += 1;
            }
            let token = &trimmed[start..i];
            if token.chars().next().is_some_and(|c| c.is_ascii_digit()) {
                return Some(token.to_string());
            }
        } else {
            i += 1;
        }
    }
    None
}

/// True when `candidate` is strictly newer than `installed`.
pub fn is_newer(candidate: &str, installed: &str) -> bool {
    let a = normalize_version(candidate);
    let b = normalize_version(installed);
    if a == b {
        return false;
    }
    match (parse_semver_parts(a), parse_semver_parts(b)) {
        (Some(ca), Some(in_)) => compare_semver(&ca, &in_) == std::cmp::Ordering::Greater,
        _ => a != b,
    }
}

#[derive(Debug, PartialEq, Eq)]
struct SemverParts {
    major: u64,
    minor: u64,
    patch: u64,
    /// Empty = release; non-empty prerelease sorts below the same numeric triple.
    prerelease: String,
}

fn parse_semver_parts(raw: &str) -> Option<SemverParts> {
    let core = raw.split_once('+').map(|(c, _)| c).unwrap_or(raw);
    let (numeric, prerelease) = match core.split_once('-') {
        Some((num, pre)) => (num, pre.to_string()),
        None => (core, String::new()),
    };
    let mut parts = numeric.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().unwrap_or(0);
    let patch = parts.next().unwrap_or("0").parse().unwrap_or(0);
    Some(SemverParts {
        major,
        minor,
        patch,
        prerelease,
    })
}

fn compare_semver(a: &SemverParts, b: &SemverParts) -> std::cmp::Ordering {
    (
        a.major,
        a.minor,
        a.patch,
        a.prerelease.is_empty(),
        &a.prerelease,
    )
        .cmp(&(
            b.major,
            b.minor,
            b.patch,
            b.prerelease.is_empty(),
            &b.prerelease,
        ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn npm_package_map_covers_lifecycle_npm_templates() {
        assert_eq!(npm_package_for_template("opencode"), Some("@opencode/cli"));
        assert_eq!(
            npm_package_for_template("claude-acp"),
            Some("@anthropic-ai/claude-code")
        );
        assert_eq!(npm_package_for_template("hermes"), None);
        assert_eq!(npm_package_for_template("dsh"), Some("@deepseek-ai/dsh"));
        assert_eq!(
            npm_package_for_template("minimax-code"),
            Some("@minimax-ai/code")
        );
    }

    #[test]
    fn version_check_fields_flag_only_a_newer_target() {
        // Registry moved ahead → Upgrade shows.
        let (installed, latest, update) =
            version_check_fields("1.0.0".to_string(), Some("1.1.0".to_string()));
        assert_eq!(installed.as_deref(), Some("1.0.0"));
        assert_eq!(latest.as_deref(), Some("1.1.0"));
        assert_eq!(update, Some(true));

        // Registry still on the installed release → nothing to upgrade.
        let (_, _, update) = version_check_fields("1.1.0".to_string(), Some("1.1.0".to_string()));
        assert_eq!(update, Some(false));

        // No target (offline / no npm package): installed version only.
        let (installed, latest, update) = version_check_fields("1.0.0".to_string(), None);
        assert_eq!(installed.as_deref(), Some("1.0.0"));
        assert_eq!(latest, None);
        assert_eq!(update, None);
    }

    #[test]
    fn antigravity_has_no_npm_target() {
        // Antigravity rows are served by the registry manifest branch, so the
        // npm lookup must stay out of their way (and never spawn npm for them).
        assert_eq!(npm_package_for_template("antigravity-acp"), None);
        assert_eq!(npm_package_for_template("hermes"), None);
        assert!(latest_version_for_template("hermes", false, "").is_none());
    }

    #[test]
    fn extract_version_from_common_banners() {
        assert_eq!(
            extract_version_token("opencode 1.2.3").as_deref(),
            Some("1.2.3")
        );
        assert_eq!(
            extract_version_token("claude-code/v2.0.1").as_deref(),
            Some("2.0.1")
        );
        assert_eq!(
            extract_version_token("pi v0.84.1 — coding agent").as_deref(),
            Some("0.84.1")
        );
        assert_eq!(extract_version_token("not a version"), None);
    }

    #[test]
    fn is_newer_semver_and_prerelease() {
        assert!(is_newer("1.2.4", "1.2.3"));
        assert!(!is_newer("1.2.3", "1.2.3"));
        assert!(!is_newer("1.2.3", "1.2.4"));
        assert!(is_newer("1.0.0", "1.0.0-rc.1"));
        assert!(!is_newer("1.0.0-rc.1", "1.0.0"));
        assert!(is_newer("0.1.1-rc.3", "0.1.1-rc.2"));
        assert!(is_newer("v2.0.0", "2.0.0-beta"));
    }

    #[test]
    fn is_newer_falls_back_to_inequality_for_opaque_strings() {
        assert!(is_newer("abc", "xyz"));
        assert!(!is_newer("same", "same"));
    }
}
