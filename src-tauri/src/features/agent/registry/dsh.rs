//! Launch the Windows npm Dsh CLI without a shim's stale adjacent Node.
use std::path::{Component, Path, PathBuf};

/// Only recognize the official npm layout. Desktop/custom launchers keep their
/// own runtime policy; never parse or execute arbitrary shim text here.
fn npm_package(command: &Path) -> Result<Option<(PathBuf, serde_json::Value)>, String> {
    if !command
        .file_stem()
        .is_some_and(|name| name.eq_ignore_ascii_case("dsh"))
        || !command.extension().is_some_and(|ext| {
            ext.eq_ignore_ascii_case("cmd")
                || ext.eq_ignore_ascii_case("bat")
                || ext.eq_ignore_ascii_case("ps1")
        })
    {
        return Ok(None);
    }
    let Some(parent) = command.parent() else {
        return Ok(None);
    };
    let package = parent.join("node_modules").join("@deepseek-ai").join("dsh");
    let manifest = package.join("package.json");
    if !manifest.is_file() {
        return Ok(None);
    }
    let invalid = || {
        "failed to start Dsh: invalid npm CLI entry; repair @deepseek-ai/dsh installation"
            .to_string()
    };
    let json: serde_json::Value =
        serde_json::from_slice(&std::fs::read(manifest).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
    if json["name"] != "@deepseek-ai/dsh" {
        return Ok(None);
    }
    Ok(Some((package, json)))
}

fn npm_entry(command: &Path) -> Result<Option<PathBuf>, String> {
    let Some((package, json)) = npm_package(command)? else {
        return Ok(None);
    };
    let invalid = || {
        "failed to start Dsh: invalid npm CLI entry; repair @deepseek-ai/dsh installation"
            .to_string()
    };
    let entry = json["bin"]["dsh"]
        .as_str()
        .or_else(|| json["bin"].as_str())
        .ok_or_else(invalid)?;
    let relative = Path::new(entry);
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
        || !relative.extension().is_some_and(|ext| ext == "js")
    {
        return Err(invalid());
    }
    let entry = package.join(relative.components().collect::<PathBuf>());
    if !entry.is_file() {
        return Err(invalid());
    }
    Ok(Some(crate::core::process::windows_shell_path(&entry)))
}

fn compatible_node(node: &Path) -> bool {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    let Ok(mut child) = Command::new(node)
        .args([
            "--input-type=module",
            "-e",
            "const [major,minor]=process.versions.node.split('.').map(Number); process.exit(((major===22&&minor>=19)||(major===24&&minor>=2)||major>24)&&typeof import.meta.main==='boolean'?0:1)",
        ])
        .creation_flags(0x0800_0000)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if started.elapsed() < Duration::from_secs(5) => {
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

/// Windows global npm bins live at the prefix root. Restrict ownership to the
/// same recognized package layout used for launch, not a user's DSH_HOME.
pub(crate) fn npm_prefix(command: &Path) -> Result<Option<PathBuf>, String> {
    // Uninstall must also work when the JS entry is missing or broken.
    Ok(npm_package(command)?.and_then(|_| command.parent().map(Path::to_path_buf)))
}

pub(crate) fn npm_launch(
    command: &Path,
    path_node: Option<PathBuf>,
) -> Result<Option<(PathBuf, PathBuf)>, String> {
    npm_launch_with(command, path_node, compatible_node)
}

fn npm_launch_with(
    command: &Path,
    path_node: Option<PathBuf>,
    compatible: impl Fn(&Path) -> bool,
) -> Result<Option<(PathBuf, PathBuf)>, String> {
    let Some(entry) = npm_entry(command)? else {
        return Ok(None);
    };
    // npm shims prefer an adjacent node.exe even after PATH was upgraded.
    // Prefer the merged agent environment, then a compatible adjacent runtime.
    let adjacent = command.parent().map(|dir| dir.join("node.exe"));
    let candidates = path_node.into_iter().chain(adjacent);
    for node in candidates {
        if crate::core::process::resolve_command_in_paths(&node.to_string_lossy(), &[]).is_some()
            && compatible(&node)
        {
            return Ok(Some((node, entry)));
        }
    }
    Err(format!(
        "failed to start Dsh: Node.js 22.19+ or 24.2+ is required (including import.meta.main); no compatible Node was found on the agent PATH or alongside {}. Upgrade Node.js and restart Agentero",
        command.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn npm_fixture(dir: &Path) -> PathBuf {
        let package = dir.join("node_modules/@deepseek-ai/dsh");
        std::fs::create_dir_all(package.join("lib")).unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"name":"@deepseek-ai/dsh","bin":{"dsh":"lib/bin.js"}}"#,
        )
        .unwrap();
        std::fs::write(package.join("lib/bin.js"), "if(import.meta.main) {}").unwrap();
        let shim = dir.join("dsh.cmd");
        std::fs::write(&shim, "@echo off").unwrap();
        shim
    }

    #[test]
    fn newer_path_node_bypasses_old_adjacent_node() {
        let dir = tempfile::TempDir::new().unwrap();
        let shim = npm_fixture(dir.path());
        std::fs::write(dir.path().join("node.exe"), b"MZ old").unwrap();
        let node = dir.path().join("node24.exe");
        std::fs::write(&node, b"MZ new").unwrap();
        let (selected, entry) = npm_launch_with(&shim, Some(node.clone()), |path| path == node)
            .unwrap()
            .unwrap();
        assert_eq!(selected, node);
        assert_eq!(npm_prefix(&shim).unwrap(), Some(dir.path().to_path_buf()));
        assert!(entry.ends_with(r"node_modules\@deepseek-ai\dsh\lib\bin.js"));
        assert!(npm_launch_with(&shim, None, |_| false)
            .unwrap_err()
            .contains("Node.js 22.19+ or 24.2+"));
        let (selected, _) = npm_launch_with(&shim, None, |_| true).unwrap().unwrap();
        assert_eq!(selected, dir.path().join("node.exe"));
    }

    #[test]
    fn custom_launchers_are_preserved_and_invalid_package_entries_are_rejected() {
        let dir = tempfile::TempDir::new().unwrap();
        let shim = dir.path().join("custom.cmd");
        assert!(npm_launch_with(&shim, None, |_| panic!("not npm"))
            .unwrap()
            .is_none());
        assert!(npm_prefix(&shim).unwrap().is_none());
        let shim = npm_fixture(dir.path());
        let package = dir.path().join("node_modules/@deepseek-ai/dsh");
        assert!(npm_launch_with(&dir.path().join("dsh-acp.cmd"), None, |_| {
            panic!("custom wrapper must be preserved")
        })
        .unwrap()
        .is_none());
        std::fs::write(
            package.join("package.json"),
            r#"{"name":"@deepseek-ai/dsh","bin":{"dsh":"../outside.js"}}"#,
        )
        .unwrap();
        assert!(npm_launch_with(&shim, None, |_| true).is_err());
        std::fs::write(
            package.join("package.json"),
            r#"{"name":"@deepseek-ai/dsh","bin":{"dsh":"lib/missing.js"}}"#,
        )
        .unwrap();
        assert!(npm_launch_with(&shim, None, |_| true).is_err());
        assert_eq!(npm_prefix(&shim).unwrap(), Some(dir.path().to_path_buf()));
    }
}
