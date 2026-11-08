//! Official ACP Registry metadata for the Antigravity ACP server.
//!
//! Google publishes the ACP server through the Agent Client Protocol registry
//! (`antigravity-acp/agent.json`), which is the source of truth for the current
//! release and its per-platform download URL. The registry is the only source:
//! a failed lookup, an unparsable manifest, a platform without a binary entry
//! or a non-HTTPS archive all surface as an error instead of guessing at a
//! version Agentero would otherwise have to keep in sync by hand.

use crate::features::agent::registry::templates::antigravity_install_dir;
use crate::features::agent::registry::version_check::normalize_version;
use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

/// Older `agy` launchers only open the IDE. Select native ACP only when the
/// installed CLI advertises it; cache until the executable is replaced.
pub(crate) fn native_cli_available() -> bool {
    type ProbeCache = Option<((PathBuf, Option<SystemTime>, u64), bool)>;
    static CACHE: OnceLock<Mutex<ProbeCache>> = OnceLock::new();
    let Some(path) = super::discovery::resolve_command("agy") else {
        return false;
    };
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    let key = (path.clone(), metadata.modified().ok(), metadata.len());
    let Ok(mut cache) = CACHE.get_or_init(|| Mutex::new(None)).lock() else {
        return false;
    };
    if let Some((cached_key, available)) = cache.as_ref() {
        if cached_key == &key {
            return *available;
        }
    }
    let available = cli_has_acp(&path);
    *cache = Some((key, available));
    available
}

fn cli_has_acp(path: &Path) -> bool {
    let mut command = Command::new(path);
    command
        .arg("--help")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::core::process::hide_console_window(&mut command);
    let Ok(mut child) = command.spawn() else {
        return false;
    };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                return child.wait_with_output().is_ok_and(|output| {
                    String::from_utf8_lossy(&output.stdout)
                        .lines()
                        .chain(String::from_utf8_lossy(&output.stderr).lines())
                        .any(|line| line.split_whitespace().next() == Some("acp"))
                });
            }
            Ok(None) if started.elapsed() < Duration::from_secs(2) => {
                std::thread::sleep(Duration::from_millis(10));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

/// Manifest published by the ACP registry for the official Antigravity server.
pub(crate) const REGISTRY_MANIFEST_URL: &str =
    "https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json";

/// The manifest is a few KB; fail fast so Settings stays responsive.
const REGISTRY_TIMEOUT: Duration = Duration::from_secs(10);
/// Successful lookups are cached briefly: one fetch serves an install plus the
/// Settings version check that follows it.
const REGISTRY_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
/// Failed lookups are cached even more briefly, so an offline machine does not
/// re-request the manifest on every catalog scan while a manual retry stays
/// possible within seconds.
const REGISTRY_FAILURE_CACHE_TTL: Duration = Duration::from_secs(30);

/// File inside the managed directory recording which release is installed.
/// Written into the staging directory, so it swaps (and rolls back) with the
/// payload and disappears with the directory on uninstall.
const VERSION_MARKER_FILE: &str = ".agentero-version";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AntigravityRelease {
    pub version: String,
    pub archive_url: String,
}

#[derive(Debug, Deserialize)]
struct RegistryManifest {
    #[serde(default)]
    version: String,
    distribution: RegistryDistribution,
}

#[derive(Debug, Deserialize)]
struct RegistryDistribution {
    #[serde(default)]
    binary: HashMap<String, RegistryBinary>,
}

#[derive(Debug, Deserialize)]
struct RegistryBinary {
    #[serde(default)]
    archive: String,
}

/// Registry platform key of the running build, or `None` on targets Google
/// publishes no ACP server for (`supports_lifecycle` mirrors this).
pub(crate) fn current_platform_key() -> Option<&'static str> {
    let key = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "darwin-aarch64"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "linux-x86_64"
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        "linux-aarch64"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "windows-x86_64"
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
        "windows-aarch64"
    } else {
        return None;
    };
    Some(key)
}

/// Release the registry currently publishes for this host: what both the
/// installer and the Settings version check work from.
pub(crate) fn resolve_release(
    proxy_enabled: bool,
    proxy_url: &str,
) -> Result<AntigravityRelease, String> {
    let platform = current_platform_key()
        .ok_or_else(|| "Antigravity ACP has no published build for this platform".to_string())?;
    release_for_platform(platform, || manifest_text(proxy_enabled, proxy_url))
}

/// Registry-only lookup for one platform: fetch and validation errors are
/// returned as they are, never replaced by a guessed release.
fn release_for_platform(
    platform: &str,
    fetch: impl FnOnce() -> Result<String, String>,
) -> Result<AntigravityRelease, String> {
    release_from_manifest(&fetch()?, platform)
}

/// Parse one platform's release out of a registry manifest. Pure, so the
/// platform selection and the payload checks are testable for every target.
pub(crate) fn release_from_manifest(
    manifest_json: &str,
    platform: &str,
) -> Result<AntigravityRelease, String> {
    let manifest: RegistryManifest = serde_json::from_str(manifest_json)
        .map_err(|e| format!("Antigravity registry manifest is not valid JSON: {e}"))?;
    let version = normalize_version(&manifest.version).to_string();
    if version.is_empty() {
        return Err("Antigravity registry manifest has an empty version".to_string());
    }
    let binary = manifest
        .distribution
        .binary
        .get(platform)
        .ok_or_else(|| format!("Antigravity registry manifest has no build for {platform}"))?;
    let archive_url = binary.archive.trim();
    if !is_trusted_archive_url(archive_url) {
        return Err(format!(
            "Antigravity registry archive for {platform} must be an HTTPS .zip URL, got: {archive_url}"
        ));
    }
    Ok(AntigravityRelease {
        version,
        archive_url: archive_url.to_string(),
    })
}

/// The archive is downloaded and unpacked without a signature check, so the
/// manifest may only point at plain HTTPS zip downloads.
fn is_trusted_archive_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("https://") && lower.ends_with(".zip") && url.len() > "https://.zip".len()
}

struct ManifestCache {
    /// Proxy configuration the entry was fetched with: a different proxy (or
    /// none) must not be served a result fetched through the previous one.
    proxy: String,
    at: Instant,
    result: Result<String, String>,
}

fn manifest_cache() -> &'static Mutex<Option<ManifestCache>> {
    static CACHE: OnceLock<Mutex<Option<ManifestCache>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn cache_proxy_key(proxy_enabled: bool, proxy_url: &str) -> String {
    format!("{proxy_enabled}:{}", proxy_url.trim())
}

fn manifest_text(proxy_enabled: bool, proxy_url: &str) -> Result<String, String> {
    manifest_text_with_cache(cache_proxy_key(proxy_enabled, proxy_url), || {
        request_manifest(proxy_enabled, proxy_url)
    })
}

/// Cache the raw manifest (not a parsed release) so one fetch serves both the
/// installer and the Settings version check.
fn manifest_text_with_cache(
    proxy: String,
    load: impl FnOnce() -> Result<String, String>,
) -> Result<String, String> {
    if let Some(cached) = cached_manifest(&proxy) {
        return cached;
    }
    let result = load();
    if let Ok(mut cache) = manifest_cache().lock() {
        *cache = Some(ManifestCache {
            proxy,
            at: Instant::now(),
            result: result.clone(),
        });
    }
    result
}

fn cached_manifest(proxy: &str) -> Option<Result<String, String>> {
    let cache = manifest_cache().lock().ok()?;
    let entry = cache.as_ref()?;
    if entry.proxy != proxy {
        return None;
    }
    let ttl = match entry.result {
        Ok(_) => REGISTRY_CACHE_TTL,
        Err(_) => REGISTRY_FAILURE_CACHE_TTL,
    };
    (entry.at.elapsed() < ttl).then(|| entry.result.clone())
}

fn request_manifest(proxy_enabled: bool, proxy_url: &str) -> Result<String, String> {
    let client = build_client(
        "Agentero/antigravity-registry",
        proxy_enabled,
        proxy_url,
        REGISTRY_TIMEOUT,
    )?;
    let response = client
        .get(REGISTRY_MANIFEST_URL)
        .send()
        .map_err(|e| format!("Antigravity registry request failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Antigravity registry request failed with HTTP {}",
            response.status()
        ));
    }
    let body = response
        .text()
        .map_err(|e| format!("Antigravity registry response could not be read: {e}"))?;
    if body.trim().is_empty() {
        return Err("Antigravity registry response was empty".to_string());
    }
    Ok(body)
}

/// HTTP client honoring the Agentero proxy settings, shared by the manifest
/// request and the archive download.
pub(crate) fn build_client(
    user_agent: &str,
    proxy_enabled: bool,
    proxy_url: &str,
    timeout: Duration,
) -> Result<reqwest::blocking::Client, String> {
    let mut builder = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .user_agent(user_agent.to_string());
    if proxy_enabled && !proxy_url.trim().is_empty() {
        builder = builder.proxy(
            reqwest::Proxy::all(proxy_url.trim()).map_err(|e| format!("invalid proxy: {e}"))?,
        );
    }
    builder
        .build()
        .map_err(|e| format!("failed to create download client: {e}"))
}

/// Version recorded by the installer into the Agentero-managed directory, or
/// `None` when nothing is installed / no marker was recorded.
pub(crate) fn installed_version() -> Option<String> {
    installed_version_in(&antigravity_install_dir())
}

pub(crate) fn installed_version_in(dir: &Path) -> Option<String> {
    let raw = fs::read_to_string(dir.join(VERSION_MARKER_FILE)).ok()?;
    let version = normalize_version(&raw);
    (!version.is_empty()).then(|| version.to_string())
}

/// Record the installed release inside `dir` (the staging directory, so the
/// marker ships and rolls back with the payload).
pub(crate) fn write_version_marker(dir: &Path, version: &str) -> Result<(), String> {
    fs::write(dir.join(VERSION_MARKER_FILE), format!("{version}\n"))
        .map_err(|e| format!("failed to record Antigravity version marker: {e}"))
}

#[cfg(test)]
mod tests {
    #[test]
    #[cfg(unix)]
    fn native_cli_requires_an_advertised_acp_subcommand() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("agy");
        for (help, stream, expected) in [
            (
                "Available subcommands:\\n  acp  Start the ACP stdio server",
                "1",
                true,
            ),
            (
                "Available subcommands:\\n  acp  Start the ACP stdio server",
                "2",
                true,
            ),
            ("Usage: agy [options] [paths...]", "1", false),
            ("  --acp  Unrelated option", "2", false),
        ] {
            std::fs::write(&cli, format!("#!/bin/sh\nprintf '{help}\\n' >&{stream}\n")).unwrap();
            std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(super::cli_has_acp(&cli), expected);
        }
    }

    use super::*;

    /// Trimmed copy of the published manifest shape: one entry per platform
    /// Google ships, with the version Agentero must take from the registry.
    const MANIFEST: &str = r#"{
        "id": "antigravity-acp",
        "name": "Google Antigravity",
        "version": "2.0.0",
        "distribution": {
            "binary": {
                "darwin-aarch64": {
                    "archive": "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-agy_acp_server_2.0.0-darwin-arm64.zip",
                    "cmd": "./agy_acp_server.par"
                },
                "linux-x86_64": {
                    "archive": "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_2.0.0-linux-x86_64.zip",
                    "cmd": "./agy_acp_server.par"
                },
                "linux-aarch64": {
                    "archive": "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_2.0.0-linux-arm64.zip",
                    "cmd": "./agy_acp_server.par"
                },
                "windows-x86_64": {
                    "archive": "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_2.0.0-windows-x86_64.zip",
                    "cmd": "./agy_acp_server.exe"
                },
                "windows-aarch64": {
                    "archive": "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_2.0.0-windows-arm64.zip",
                    "cmd": "./agy_acp_server.exe"
                }
            }
        }
    }"#;

    #[test]
    fn manifest_selects_the_archive_per_platform() {
        let platforms = [
            ("darwin-aarch64", "-darwin-arm64.zip"),
            ("linux-x86_64", "-linux-x86_64.zip"),
            ("linux-aarch64", "-linux-arm64.zip"),
            ("windows-x86_64", "-windows-x86_64.zip"),
            ("windows-aarch64", "-windows-arm64.zip"),
        ];
        for (platform, suffix) in platforms {
            let release = release_from_manifest(MANIFEST, platform).expect(platform);
            assert_eq!(release.version, "2.0.0");
            assert!(
                release.archive_url.starts_with("https://dl.google.com/"),
                "{platform}"
            );
            assert!(release.archive_url.ends_with(suffix), "{platform}");
        }
    }

    #[test]
    fn manifest_version_is_normalized() {
        let renamed = MANIFEST.replace("\"2.0.0\"", "\" v2.4.0 \"");
        let release = release_from_manifest(&renamed, "linux-x86_64").expect("release");
        // The manifest's version field is what gets recorded, not the version
        // embedded in the archive file name.
        assert_eq!(release.version, "2.4.0");
        assert!(
            release.archive_url.contains("2.0.0"),
            "{}",
            release.archive_url
        );
    }

    #[test]
    fn manifest_errors_name_the_failing_check() {
        let cases = [
            ("<html>", "not valid JSON"),
            (
                "{\"distribution\":{\"binary\":{}}}",
                "empty version",
            ),
            (
                "{\"version\":\"2.0.0\",\"distribution\":{\"binary\":{}}}",
                "no build for linux-x86_64",
            ),
            (
                "{\"version\":\"2.0.0\",\"distribution\":{\"binary\":{\"linux-x86_64\":{\"archive\":\"http://dl.google.com/x.zip\"}}}}",
                "must be an HTTPS .zip URL",
            ),
            (
                "{\"version\":\"2.0.0\",\"distribution\":{\"binary\":{\"linux-x86_64\":{\"archive\":\"https://dl.google.com/x.tar.gz\"}}}}",
                "must be an HTTPS .zip URL",
            ),
            (
                "{\"version\":\"2.0.0\",\"distribution\":{\"binary\":{\"linux-x86_64\":{\"archive\":\"\"}}}}",
                "must be an HTTPS .zip URL",
            ),
        ];
        for (json, expected) in cases {
            let error = release_from_manifest(json, "linux-x86_64").unwrap_err();
            assert!(error.contains(expected), "{json} → {error}");
        }
    }

    #[test]
    fn registry_failure_is_reported_instead_of_guessing_a_release() {
        // Network / HTTP failure propagates unchanged.
        let offline = release_for_platform("linux-x86_64", || Err("offline".to_string()));
        assert_eq!(offline.unwrap_err(), "offline");
        // A manifest that does not parse, or that lacks this platform, fails
        // instead of reusing another platform's build.
        let html = release_for_platform("linux-x86_64", || Ok("<html>".to_string()));
        assert!(html.unwrap_err().contains("not valid JSON"));
        let unpublished = release_for_platform("darwin-x86_64", || Ok(MANIFEST.to_string()));
        assert!(unpublished
            .unwrap_err()
            .contains("no build for darwin-x86_64"));
    }

    #[test]
    fn platform_key_matches_the_build_target() {
        let key = current_platform_key();
        if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
            assert_eq!(key, None, "Intel macOS has no published ACP server");
            assert!(
                resolve_release(false, "").is_err(),
                "the registry lookup must fail, not guess, off the published platforms"
            );
            return;
        }
        let key = key.expect("supported build target");
        assert!(
            [
                "darwin-aarch64",
                "linux-x86_64",
                "linux-aarch64",
                "windows-x86_64",
                "windows-aarch64"
            ]
            .contains(&key),
            "{key}"
        );
        assert!(crate::features::agent::registry::lifecycle::supports_lifecycle("antigravity-acp"));
    }

    fn clear_manifest_cache() {
        if let Ok(mut cache) = manifest_cache().lock() {
            *cache = None;
        }
    }

    #[test]
    fn manifest_lookup_is_cached_per_proxy() {
        clear_manifest_cache();
        let direct = cache_proxy_key(false, "");
        assert_eq!(
            manifest_text_with_cache(direct.clone(), || Ok(MANIFEST.to_string())),
            Ok(MANIFEST.to_string())
        );
        assert_eq!(
            manifest_text_with_cache(direct.clone(), || panic!(
                "cache must serve the second lookup"
            )),
            Ok(MANIFEST.to_string())
        );
        // A lookup through a different proxy configuration must not be served
        // the direct result: the entry is keyed by proxy and replaced.
        let proxied = cache_proxy_key(true, "http://127.0.0.1:7890");
        assert_eq!(
            manifest_text_with_cache(proxied.clone(), || Err("offline".to_string())),
            Err("offline".to_string())
        );
        assert_eq!(cached_manifest(&direct), None);
        // Failures are cached too, so an offline scan does not retry the
        // manifest for every row within the backoff window.
        assert_eq!(
            manifest_text_with_cache(proxied.clone(), || panic!("failure must be cached")),
            Err("offline".to_string())
        );
        clear_manifest_cache();
    }

    #[test]
    fn version_marker_records_the_installed_release() {
        let root = tempfile::tempdir().unwrap();
        // Nothing installed / install from before markers existed.
        assert_eq!(installed_version_in(root.path()), None);
        write_version_marker(root.path(), "v1.2.0").unwrap();
        assert_eq!(installed_version_in(root.path()).as_deref(), Some("1.2.0"));
        // An empty marker is not a version.
        fs::write(root.path().join(VERSION_MARKER_FILE), b"  \n").unwrap();
        assert_eq!(installed_version_in(root.path()), None);
    }
}
