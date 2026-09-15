use crate::install_dirs;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Extra directories GUI apps often miss when launched outside a login shell.
/// Shares the candidate list with the remote SSH bootstrap (`core::install_dirs`).
fn extra_path_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = dirs::home_dir() {
        for d in install_dirs::HOME_BIN_DIRS {
            dirs.push(home.join(d));
        }
        dirs.push(home.join(install_dirs::LINUXBREW_HOME_BIN));
        dirs.extend(nvm_bin_dirs(&home));
    }
    // Windows: a GUI app often starts without the user's full PATH, and npm/pnpm
    // global bins plus package-manager shims (.cmd) live outside the default PATH.
    #[cfg(windows)]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            dirs.push(PathBuf::from(appdata).join("npm")); // npm i -g shims
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let local = PathBuf::from(local);
            dirs.push(local.join("pnpm")); // pnpm global bin
            dirs.push(local.join("Microsoft").join("WinGet").join("Links")); // winget
        }
        if let Some(home) = dirs::home_dir() {
            dirs.push(home.join("scoop").join("shims")); // scoop
        }
        for d in install_dirs::WIN_ABS_BIN_DIRS {
            dirs.push(PathBuf::from(*d)); // chocolatey
        }
    }
    #[cfg(not(windows))]
    {
        for d in install_dirs::ABS_BIN_DIRS {
            dirs.push(PathBuf::from(*d));
        }
        dirs.push(PathBuf::from(install_dirs::LINUXBREW_ABS_BIN));
        dirs.push(PathBuf::from("/usr/bin"));
        dirs.push(PathBuf::from("/bin"));
    }
    dirs
}

/// Prefer the nvm version pinned by the default alias, then the rest newest-first.
fn nvm_bin_dirs(home: &Path) -> Vec<PathBuf> {
    let versions_dir = home.join(install_dirs::NVM_VERSIONS_DIR);
    let Ok(entries) = std::fs::read_dir(&versions_dir) else {
        return Vec::new();
    };
    let mut versions: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    versions.sort_by_key(|v| std::cmp::Reverse(version_key(v)));
    if let Ok(alias) = std::fs::read_to_string(home.join(install_dirs::NVM_DEFAULT_ALIAS_FILE)) {
        let alias = alias.trim();
        if let Some(pos) = versions
            .iter()
            .position(|v| v == alias || v.strip_prefix('v') == Some(alias))
        {
            let default = versions.remove(pos);
            versions.insert(0, default);
        }
    }
    versions
        .into_iter()
        .map(|v| versions_dir.join(v).join("bin"))
        .collect()
}

fn version_key(name: &str) -> Vec<u64> {
    name.trim_start_matches('v')
        .split('.')
        .map(|p| p.parse::<u64>().unwrap_or(0))
        .collect()
}

pub fn path_entries() -> Vec<PathBuf> {
    let mut entries = Vec::new();
    if let Ok(path) = std::env::var("PATH") {
        for part in std::env::split_paths(&path) {
            if !part.as_os_str().is_empty() {
                entries.push(part);
            }
        }
    }
    for extra in extra_path_dirs() {
        if !entries.iter().any(|e| e == &extra) {
            entries.push(extra);
        }
    }
    entries
}

fn is_executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        #[cfg(windows)]
        if path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
        {
            return has_pe_magic(path);
        }
        true
    }
}

#[cfg(windows)]
fn has_pe_magic(path: &Path) -> bool {
    use std::io::Read;
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut magic = [0_u8; 2];
    file.read_exact(&mut magic).is_ok() && magic == *b"MZ"
}

/// Resolve `command` against an explicit ordered list of directories.
pub fn resolve_command_in_paths(command: &str, paths: &[PathBuf]) -> Option<PathBuf> {
    let path = Path::new(command);
    if path.is_absolute() || command.contains('/') || command.contains('\\') {
        return if is_executable(path) {
            Some(path.to_path_buf())
        } else {
            None
        };
    }

    for dir in paths {
        // On Windows, `npm i -g` drops BOTH a bare shell script (for Git Bash)
        // and a `.cmd`/`.exe` shim of the same name. The bare file is not a valid
        // Win32 executable, yet `is_executable` treats any file as runnable, so we
        // must probe the real Windows entrypoints (PATHEXT-style) FIRST — otherwise
        // we'd hand the sh script to CreateProcess and the ACP spawn/probe fails
        // (e.g. `codex-acp`, `claude-agent-acp`).
        #[cfg(windows)]
        for ext in ["exe", "cmd", "bat", "ps1"] {
            let with_ext = dir.join(format!("{command}.{ext}"));
            if is_executable(&with_ext) {
                return Some(with_ext);
            }
        }
        let candidate = dir.join(command);
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// Resolve `command` on PATH (and common extra dirs). Absolute paths are checked as-is.
pub fn resolve_command(command: &str) -> Option<PathBuf> {
    let path = Path::new(command);
    if path.is_absolute() || command.contains('/') || command.contains('\\') {
        return resolve_command_in_paths(command, &[]);
    }

    // Prefer `which` with current PATH first.
    if let Ok(found) = which::which(command) {
        // `which` only checks that a directory entry exists. Re-apply our
        // platform executable validation so a text file renamed to `.exe`
        // cannot trigger Windows' misleading 16-bit application dialog.
        if is_executable(&found) {
            return Some(found);
        }
    }

    resolve_command_in_paths(command, &path_entries())
}

pub fn probe_command(command: &str) -> Result<PathBuf, String> {
    resolve_command(command).ok_or_else(|| {
        format!("command `{command}` not found on PATH (or common install locations)")
    })
}

/// Cached login-shell environment variables.
///
/// GUI apps on macOS/Linux are often launched by `launchd`/`systemd` and do not
/// inherit the user's interactive shell configuration (`.zshrc`, `.bashrc`, etc.).
/// BYOA agents like `codex-acp` expect variables such as `OPENAI_API_KEY` and
/// `OPENAI_BASE_URL` to be present, so we bootstrap them from the login shell.
static LOGIN_SHELL_ENV: OnceLock<Option<HashMap<String, String>>> = OnceLock::new();

/// Parse `env -0` output (null-separated `key=value` entries).
// Only the unix `login_shell_env` calls this; Windows keeps it compiled for
// the cross-platform unit tests.
#[cfg_attr(windows, allow(dead_code))]
fn parse_env_zero(output: &[u8]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for chunk in output.split(|&b| b == 0) {
        if chunk.is_empty() {
            continue;
        }
        let line = String::from_utf8_lossy(chunk);
        if let Some((key, value)) = line.split_once('=') {
            map.insert(key.to_string(), value.to_string());
        }
    }
    map
}

/// Read the user's login-shell environment once and cache it.
///
/// Returns `None` if the shell cannot be queried. The result is intentionally
/// not logged to avoid leaking secrets.
#[cfg(not(windows))]
pub fn login_shell_env() -> Option<&'static HashMap<String, String>> {
    LOGIN_SHELL_ENV
        .get_or_init(|| {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
            let output = std::process::Command::new(&shell)
                .args(["-lic", "env -0"])
                .output()
                .ok()?;
            if !output.status.success() {
                return None;
            }
            let map = parse_env_zero(&output.stdout);
            if map.is_empty() {
                None
            } else {
                Some(map)
            }
        })
        .as_ref()
}

/// Windows GUI apps inherit a reasonably complete environment block from the
/// Explorer shell; there is no single "login shell" equivalent to query.
#[cfg(windows)]
pub fn login_shell_env() -> Option<&'static HashMap<String, String>> {
    LOGIN_SHELL_ENV.get_or_init(|| None).as_ref()
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::*;

    #[cfg(unix)]
    #[test]
    fn finds_sh_on_unix() {
        let p = resolve_command("sh");
        assert!(p.is_some());
    }

    #[test]
    fn version_key_sorts_numerically() {
        let mut v = vec!["v9.11.2", "v24.3.0", "v10.0.0"];
        v.sort_by_key(|b| std::cmp::Reverse(super::version_key(b)));
        assert_eq!(v, vec!["v24.3.0", "v10.0.0", "v9.11.2"]);
    }

    #[test]
    fn parse_env_zero_handles_null_separated_pairs() {
        let bytes = b"OPENAI_API_KEY=sk-abc\0OPENAI_BASE_URL=https://example/v1\0PATH=/usr/bin\0";
        let map = super::parse_env_zero(bytes);
        assert_eq!(map.get("OPENAI_API_KEY"), Some(&"sk-abc".to_string()));
        assert_eq!(
            map.get("OPENAI_BASE_URL"),
            Some(&"https://example/v1".to_string())
        );
        assert_eq!(map.get("PATH"), Some(&"/usr/bin".to_string()));
    }

    #[test]
    fn parse_env_zero_skips_empty_and_malformed_entries() {
        let bytes = b"FOO=bar\0BAD_NO_EQUAL\0\0BAZ=qux\0";
        let map = super::parse_env_zero(bytes);
        assert_eq!(map.get("FOO"), Some(&"bar".to_string()));
        assert_eq!(map.get("BAZ"), Some(&"qux".to_string()));
        assert!(!map.contains_key("BAD_NO_EQUAL"));
    }
}
