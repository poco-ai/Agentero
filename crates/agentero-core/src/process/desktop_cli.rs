//! Known CLI entrypoints shipped inside desktop applications.
//!
//! Only supplement the normal process PATH. Explicit path-list resolution must
//! stay isolated, and a desktop GUI executable is never an agent entrypoint.
use std::path::{Path, PathBuf};

const MACOS_CLI_ENTRIES: &[&str] = &[
    "ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
    "DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh",
];

/// Keep environment/OS discovery separate from the deterministic layout probe.
#[cfg(target_os = "macos")]
pub(super) fn path_dirs() -> Vec<PathBuf> {
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Applications"));
    }
    path_dirs_in(&roots, MACOS_CLI_ENTRIES)
}

/// Preserve root/entry order, reject broken installs, and deduplicate directories.
fn path_dirs_in(roots: &[PathBuf], entries: &[&str]) -> Vec<PathBuf> {
    let mut result = Vec::new();
    for root in roots {
        for entry in entries {
            let binary = root.join(entry);
            if !super::discover::is_executable(&binary) {
                continue;
            }
            if let Some(parent) = binary.parent().map(Path::to_path_buf) {
                if !result.contains(&parent) {
                    result.push(parent);
                }
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::discover::resolve_command_in_paths;

    fn executable(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // On Windows production validation requires the PE magic; no execution
        // occurs in these discovery fixtures.
        std::fs::write(path, b"MZ fixture").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn probes_known_layouts_without_real_applications() {
        let fixture = tempfile::tempdir().unwrap();
        let roots = vec![fixture.path().join("Applications")];
        assert!(path_dirs_in(&roots, MACOS_CLI_ENTRIES).is_empty());
        for entry in MACOS_CLI_ENTRIES {
            executable(&roots[0].join(entry));
        }
        let directories = path_dirs_in(&roots, MACOS_CLI_ENTRIES);
        assert_eq!(directories.len(), 2);
        for entry in MACOS_CLI_ENTRIES {
            let binary = roots[0].join(entry);
            assert!(directories.contains(&binary.parent().unwrap().to_path_buf()));
        }
        assert_eq!(
            path_dirs_in(&[roots[0].clone(), roots[0].clone()], MACOS_CLI_ENTRIES),
            directories
        );
    }

    #[cfg(unix)]
    #[test]
    fn ignores_nonexecutable_files_and_directories() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = tempfile::tempdir().unwrap();
        let roots = vec![fixture.path().to_path_buf()];
        let binary = roots[0].join(MACOS_CLI_ENTRIES[0]);
        executable(&binary);
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(path_dirs_in(&roots, MACOS_CLI_ENTRIES).is_empty());
        std::fs::create_dir_all(roots[0].join(MACOS_CLI_ENTRIES[1])).unwrap();
        assert!(path_dirs_in(&roots, MACOS_CLI_ENTRIES).is_empty());
    }

    #[test]
    fn explicit_paths_and_path_priority_are_preserved() {
        let fixture = tempfile::tempdir().unwrap();
        let preferred = fixture.path().join("preferred");
        let bundled = fixture.path().join("bundled");
        let name = if cfg!(windows) { "codex.exe" } else { "codex" };
        executable(&preferred.join(name));
        executable(&bundled.join(name));
        assert_eq!(
            resolve_command_in_paths("codex", &[preferred.clone(), bundled]),
            Some(preferred.join(name))
        );
        assert!(resolve_command_in_paths("codex", &[]).is_none());
        assert!(resolve_command_in_paths(
            fixture.path().join("missing/codex").to_str().unwrap(),
            &[preferred]
        )
        .is_none());
    }
}
