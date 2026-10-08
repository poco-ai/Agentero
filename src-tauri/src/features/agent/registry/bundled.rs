//! Bundled ACP adapter tier — an offline fallback for the Claude/Codex
//! adapters, staged by `scripts/prepare-adapters.mjs` into `src-tauri/adapters/`
//! (JS-only trees, platform binaries stripped) and shipped as app resources.
//!
//! Resolution order everywhere: a PATH/lifecycle-installed adapter always
//! wins; the bundled tier is consulted only when `resolve_command` misses the
//! adapter command. Host CLIs (`claude`/`codex`) are never bundled — the
//! stripped adapters find them via injected env (`CLAUDE_CODE_EXECUTABLE` /
//! `CODEX_PATH`), with user-configured env still taking precedence.
//!
//! Layout under the adapters root (packaged: `Contents/Resources/adapters`,
//! dev: `src-tauri/adapters`):
//! `manifest.json` + one shared `node_modules/` tree whose entry paths the
//! manifest records relative to the root.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Deserialize;
use tauri::Manager;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundledAdapterInfo {
    #[allow(dead_code)] // kept for manifest completeness / future diagnostics
    package: String,
    version: String,
    entry: String,
    #[serde(default)]
    node_major: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundledManifest {
    adapters: HashMap<String, BundledAdapterInfo>,
}

/// A usable bundled adapter: absolute entry script + pinned metadata.
#[derive(Debug, Clone)]
pub struct BundledAdapter {
    /// Absolute path to the adapter's `dist/index.js` (spawn as
    /// `node <entry_js> [descriptor args…]`).
    pub entry_js: PathBuf,
    pub version: String,
    pub node_major: Option<u32>,
}

static ADAPTERS_ROOT: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Record the packaged adapters root at app setup. Dev runs (no staged
/// resources next to the binary) fall back to the source tree walk in
/// [`adapters_root`], so a missing call or directory simply disables the tier.
pub fn init<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Ok(res) = app.path().resource_dir() {
        let root = res.join("adapters");
        if root.join("manifest.json").is_file() {
            let _ = ADAPTERS_ROOT.set(Some(root));
            return;
        }
    }
    let _ = ADAPTERS_ROOT.set(discover_dev_root());
}

/// Walk exe/cwd ancestors for `src-tauri/adapters` (dev checkout; mirrors the
/// dev tier of `install::resolve_local_cli`). Cheap: only runs when the
/// packaged root was absent.
fn discover_dev_root() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.extend(
                dir.ancestors()
                    .take(8)
                    .map(|a| a.join("src-tauri/adapters")),
            );
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.extend(
            cwd.ancestors()
                .take(8)
                .map(|a| a.join("src-tauri/adapters")),
        );
    }
    candidates
        .into_iter()
        .find(|root| root.join("manifest.json").is_file())
}

/// Cached adapters root (packaged → dev → `None` = tier disabled).
///
/// Unit tests never activate the global tier: a developer-local
/// `src-tauri/adapters` staging would otherwise make catalog assertions
/// machine-dependent (CI never stages). Integration coverage runs through the
/// dev app instead; pure logic is tested against explicit fixtures via
/// [`adapter_at`].
pub fn adapters_root() -> Option<&'static Path> {
    ADAPTERS_ROOT
        .get_or_init(|| {
            #[cfg(test)]
            {
                None
            }
            #[cfg(not(test))]
            {
                discover_dev_root()
            }
        })
        .as_deref()
}

/// Resolve a bundled adapter from an explicit root. Pure so tests can point it
/// at a fixture; unknown template ids and missing entry files yield `None`.
pub fn adapter_at(root: &Path, template_id: &str) -> Option<BundledAdapter> {
    let manifest: BundledManifest =
        serde_json::from_str(&std::fs::read_to_string(root.join("manifest.json")).ok()?).ok()?;
    let info = manifest.adapters.get(template_id)?;
    let entry_js = root.join(&info.entry);
    if !entry_js.is_file() {
        return None;
    }
    Some(BundledAdapter {
        entry_js,
        version: info.version.clone(),
        node_major: info.node_major,
    })
}

/// Bundled adapter for a template id, or `None` when the tier is absent.
pub fn bundled_adapter(template_id: &str) -> Option<BundledAdapter> {
    adapter_at(adapters_root()?, template_id)
}

fn node_major_of(node: &Path) -> Option<u32> {
    let mut command = std::process::Command::new(node);
    command.arg("--version");
    // GUI-subsystem binary: a stray console window on every probe would look
    // broken (telemetry/device.rs precedent).
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    // "v22.23.2" → 22
    text.strip_prefix('v')?.split('.').next()?.parse().ok()
}

/// True when the bundled tier can actually spawn this template: adapter
/// staged, Node resolvable on PATH, and Node new enough for the adapter.
pub fn bundled_spawnable(template_id: &str) -> bool {
    let Some(adapter) = bundled_adapter(template_id) else {
        return false;
    };
    let Some(node) = super::resolve_command("node") else {
        return false;
    };
    node_meets(adapter.node_major, &node)
}

fn node_meets(required: Option<u32>, node: &Path) -> bool {
    match required {
        None => true,
        Some(min) => node_major_of(node).is_some_and(|major| major >= min),
    }
}

/// Spawn plan for the bundled tier: prefer a Node visible to the merged agent
/// environment (login-shell PATH), fall back to the process PATH probe.
/// Returns `None` unless the plan is executable (adapter + Node both resolve
/// and the Node version satisfies the adapter's requirement).
pub fn bundled_spawn(
    template_id: &str,
    child_env: &HashMap<String, String>,
) -> Option<(PathBuf, BundledAdapter)> {
    let adapter = bundled_adapter(template_id)?;
    let node = crate::features::agent::acp::client::resolve_command_in_agent_env("node", child_env)
        .or_else(|| super::resolve_command("node"))?;
    if !node_meets(adapter.node_major, &node) {
        return None;
    }
    Some((node, adapter))
}

pub(crate) fn host_requirement(template_id: &str) -> Option<(&'static str, &'static str)> {
    match template_id {
        "claude-acp" => Some(("claude", "CLAUDE_CODE_EXECUTABLE")),
        "codex-acp" => Some(("codex", "CODEX_PATH")),
        _ => None,
    }
}

pub fn host_path(template_id: &str, child_env: &HashMap<String, String>) -> Option<PathBuf> {
    let (command, key) = host_requirement(template_id)?;
    let command = child_env.get(key).map(String::as_str).unwrap_or(command);
    let path =
        crate::features::agent::acp::client::resolve_command_in_agent_env(command, child_env)?;
    #[cfg(windows)]
    if template_id == "claude-acp" {
        return claude_sdk_path(&path);
    }
    Some(path)
}

/// The Claude SDK spawns native binaries directly and JS entrypoints through
/// Node. Windows npm shims cannot be spawned directly (Node returns EINVAL).
/// Resolve only the known npm package layout, never execute/parse a shell shim.
#[cfg(windows)]
fn claude_sdk_path(path: &Path) -> Option<PathBuf> {
    let extension = path.extension()?.to_str()?;
    if extension.eq_ignore_ascii_case("exe") || extension == "js" {
        return Some(path.to_path_buf());
    }
    if ["cmd", "bat", "ps1"]
        .iter()
        .any(|ext| extension.eq_ignore_ascii_case(ext))
    {
        let package = path
            .parent()?
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-code");
        // Recent npm releases ship a native package bin instead of cli.js.
        // Reuse PE validation so a missing/corrupt binary is never injected.
        let native = package.join("bin").join("claude.exe");
        if let Some(native) =
            crate::core::process::resolve_command_in_paths(&native.to_string_lossy(), &[])
        {
            return Some(native);
        }
        let entry = package.join("cli.js");
        return entry.is_file().then_some(entry);
    }
    None
}

pub fn host_env_injection(
    template_id: &str,
    child_env: &HashMap<String, String>,
) -> Result<Vec<(String, String)>, String> {
    let Some((command, key)) = host_requirement(template_id) else {
        return Ok(Vec::new());
    };
    let path = host_path(template_id, child_env).ok_or_else(|| {
        if cfg!(windows) && template_id == "claude-acp" {
            "Claude Code has no SDK-compatible entrypoint: Windows .cmd/.bat/.ps1 shims cannot be spawned directly. Repair the npm installation, use the native Claude Code installer, or set CLAUDE_CODE_EXECUTABLE to an existing claude.exe or cli.js path".to_string()
        } else {
            format!("host command `{command}` not found (check its installation or `{key}`)")
        }
    })?;
    // Node's script lookup does not accept Tauri's Windows resource prefix.
    let path = crate::core::process::windows_shell_path(&path);
    Ok(vec![(key.to_string(), path.display().to_string())])
}

/// Scan-status hint when the tier exists but cannot run (Node missing/old).
pub fn node_blocker_message(template_id: &str) -> Option<String> {
    let adapter = bundled_adapter(template_id)?;
    if super::resolve_command("node").is_none() {
        return Some(format!(
            "bundled ACP adapter {} present but Node.js is required to run it",
            adapter.version
        ));
    }
    match adapter.node_major {
        Some(min)
            if super::resolve_command("node").is_some_and(|node| !node_meets(Some(min), &node)) =>
        {
            Some(format!(
                "bundled ACP adapter {} requires Node.js {min} or newer",
                adapter.version
            ))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_manifest(dir: &Path, adapters: serde_json::Value) {
        let manifest = serde_json::json!({ "adapters": adapters });
        std::fs::write(
            dir.join("manifest.json"),
            serde_json::to_string(&manifest).unwrap(),
        )
        .unwrap();
    }

    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let entry = root.join("node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js");
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::write(&entry, "#!/usr/bin/env node\n").unwrap();
        write_manifest(
            &root,
            serde_json::json!({
                "claude-acp": {
                    "package": "@agentclientprotocol/claude-agent-acp",
                    "version": "0.79.0",
                    "entry": "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
                    "nodeMajor": 22
                },
                "codex-acp": {
                    "package": "@agentclientprotocol/codex-acp",
                    "version": "1.12.0",
                    "entry": "node_modules/@agentclientprotocol/codex-acp/dist/index.js",
                    "nodeMajor": null
                }
            }),
        );
        (tmp, root)
    }

    #[test]
    fn adapter_at_resolves_entry_and_metadata() {
        let (_tmp, root) = fixture();
        let adapter = adapter_at(&root, "claude-acp").expect("claude-acp staged");
        assert!(adapter
            .entry_js
            .ends_with("node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js"));
        assert_eq!(adapter.version, "0.79.0");
        assert_eq!(adapter.node_major, Some(22));
    }

    #[test]
    fn adapter_at_rejects_missing_entry_and_unknown_id() {
        let (_tmp, root) = fixture();
        // codex-acp is in the manifest but its entry file was never created.
        assert!(adapter_at(&root, "codex-acp").is_none());
        assert!(adapter_at(&root, "dsh").is_none());
        assert!(adapter_at(&root, "custom").is_none());
    }

    #[test]
    fn adapter_at_requires_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(adapter_at(tmp.path(), "claude-acp").is_none());
    }

    #[test]
    fn host_env_injection_maps_templates_to_host_env() {
        // A fake host bin dir keeps this hermetic: no reliance on the test
        // machine having claude/codex installed.
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        for name in ["claude", "codex"] {
            fake_host(&bin, name);
        }
        let mut env = HashMap::new();
        env.insert(
            "PATH".to_string(),
            std::env::join_paths(std::iter::once(bin.clone()))
                .unwrap()
                .to_string_lossy()
                .to_string(),
        );

        let injected = host_env_injection("claude-acp", &env).unwrap();
        assert_eq!(injected.len(), 1);
        assert_eq!(injected[0].0, "CLAUDE_CODE_EXECUTABLE");
        assert!(injected[0].1.contains("claude"));

        let injected = host_env_injection("codex-acp", &env).unwrap();
        assert_eq!(injected.len(), 1);
        assert_eq!(injected[0].0, "CODEX_PATH");
        assert!(injected[0].1.contains("codex"));

        // No host on PATH → no injection; unknown templates never inject.
        let mut empty = HashMap::new();
        empty.insert(
            "PATH".to_string(),
            std::env::join_paths(std::iter::once(std::path::PathBuf::from(
                "/nonexistent-agentero-test",
            )))
            .unwrap()
            .to_string_lossy()
            .to_string(),
        );
        assert!(host_env_injection("claude-acp", &empty).is_err());
        assert!(host_env_injection("codex-acp", &empty).is_err());
        assert!(host_env_injection("dsh", &empty).unwrap().is_empty());
    }

    fn fake_host(dir: &Path, name: &str) -> PathBuf {
        let file = dir.join(if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_string()
        });
        std::fs::write(&file, if cfg!(windows) { "MZ" } else { "#!/bin/sh\n" }).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        file
    }

    #[test]
    fn host_path_resolves_merged_path_and_explicit_override() {
        let tmp = tempfile::tempdir().unwrap();
        let mut env = HashMap::from([("PATH".to_string(), tmp.path().display().to_string())]);
        for id in ["claude-acp", "codex-acp"] {
            let (host, key) = host_requirement(id).unwrap();
            let default = fake_host(tmp.path(), host);
            assert_eq!(host_path(id, &env), Some(default));

            let explicit = fake_host(tmp.path(), &format!("custom-{host}"));
            env.insert(key.to_string(), explicit.display().to_string());
            assert_eq!(host_path(id, &env), Some(explicit.clone()));
            assert_eq!(
                host_env_injection(id, &env).unwrap(),
                vec![(key.to_string(), explicit.display().to_string())]
            );
        }
    }

    #[test]
    fn host_path_rejects_missing_and_invalid_overrides_without_path_fallback() {
        let tmp = tempfile::tempdir().unwrap();
        let mut env = HashMap::from([("PATH".to_string(), tmp.path().display().to_string())]);
        for id in ["claude-acp", "codex-acp"] {
            let (host, key) = host_requirement(id).unwrap();
            assert!(host_path(id, &env).is_none());
            fake_host(tmp.path(), host);
            for value in [
                String::new(),
                tmp.path().join("missing").display().to_string(),
            ] {
                env.insert(key.to_string(), value);
                assert!(host_path(id, &env).is_none());
                assert!(host_env_injection(id, &env).is_err());
            }
            #[cfg(unix)]
            {
                let non_executable = tmp.path().join(format!("non-executable-{host}"));
                std::fs::write(&non_executable, "data").unwrap();
                env.insert(key.to_string(), non_executable.display().to_string());
                assert!(host_path(id, &env).is_none());
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn claude_npm_shims_resolve_to_cli_js_in_paths_with_spaces() {
        let tmp = tempfile::Builder::new()
            .prefix("Claude npm ")
            .tempdir()
            .unwrap();
        let entry = tmp
            .path()
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-code")
            .join("cli.js");
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::write(&entry, "").unwrap();
        let mut env = HashMap::from([("PATH".to_string(), tmp.path().display().to_string())]);
        for ext in ["cmd", "bat", "ps1", "CMD"] {
            let shim = tmp.path().join(format!("claude.{ext}"));
            std::fs::write(&shim, "npm shim").unwrap();
            env.insert(
                "CLAUDE_CODE_EXECUTABLE".to_string(),
                shim.display().to_string(),
            );
            assert_eq!(host_path("claude-acp", &env), Some(entry.clone()));
            assert_eq!(
                host_env_injection("claude-acp", &env).unwrap(),
                vec![(
                    "CLAUDE_CODE_EXECUTABLE".to_string(),
                    entry.display().to_string()
                )]
            );
        }
        env.remove("CLAUDE_CODE_EXECUTABLE");
        assert_eq!(host_path("claude-acp", &env), Some(entry.clone()));
        // Extended-length paths must retain native separators during lookup,
        // then lose the local drive prefix before entering the Node SDK.
        env.insert(
            "CLAUDE_CODE_EXECUTABLE".to_string(),
            format!(r"\\?\{}", tmp.path().join("claude.cmd").display()),
        );
        assert_eq!(
            host_env_injection("claude-acp", &env).unwrap()[0].1,
            entry.display().to_string()
        );
    }

    #[cfg(windows)]
    #[test]
    fn claude_unresolved_shim_fails_before_sdk_spawn() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("claude.cmd"), "npm shim").unwrap();
        let env = HashMap::from([("PATH".to_string(), tmp.path().display().to_string())]);
        assert!(host_path("claude-acp", &env).is_none());
        let error = host_env_injection("claude-acp", &env).unwrap_err();
        assert!(error.contains("CLAUDE_CODE_EXECUTABLE"));
        assert!(error.contains("cli.js"));
        assert!(error.contains("native Claude Code installer"));
    }

    #[cfg(windows)]
    #[test]
    fn claude_native_host_and_explicit_js_override_remain_usable() {
        let tmp = tempfile::tempdir().unwrap();
        let native = fake_host(tmp.path(), "claude");
        std::fs::write(tmp.path().join("claude.cmd"), "npm shim").unwrap();
        let mut env = HashMap::from([("PATH".to_string(), tmp.path().display().to_string())]);
        assert_eq!(host_path("claude-acp", &env), Some(native));
        let script = tmp.path().join("chosen-cli.js");
        std::fs::write(&script, "").unwrap();
        env.insert(
            "CLAUDE_CODE_EXECUTABLE".to_string(),
            script.display().to_string(),
        );
        assert_eq!(host_path("claude-acp", &env), Some(script));
    }

    #[cfg(windows)]
    #[test]
    fn claude_npm_native_package_bin_resolves_without_cli_js() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("claude.cmd"), "npm shim").unwrap();
        let bin = tmp
            .path()
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-code")
            .join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let native = fake_host(&bin, "claude");
        let env = HashMap::from([("PATH".to_string(), tmp.path().display().to_string())]);
        assert_eq!(host_path("claude-acp", &env), Some(native.clone()));
        std::fs::write(native, "invalid PE file").unwrap();
        assert!(host_path("claude-acp", &env).is_none());
    }

    #[test]
    fn node_major_gate_is_pure_comparison() {
        // node_meets with None requirement is trivially true; the version
        // parse itself is exercised through node_major_of on the real PATH
        // only where a node exists, so keep this test hermetic.
        assert!(node_meets(None, Path::new("/nonexistent/node")));
    }
}
