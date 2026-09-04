//! Windows user-PATH management for the CLI shim directory.
//!
//! The installer writes `agentero-cli.cmd` into the shim dir and then adds that
//! dir to the *user* PATH (`HKCU\Environment\Path`) so a fresh terminal can run
//! `agentero-cli` without manual setup. PATH is read/written through the
//! registry (the process env is the merged system+user PATH, so editing it
//! would duplicate or expand entries), preserving the existing value type
//! (`REG_EXPAND_SZ` / `REG_SZ`). After writing we broadcast `WM_SETTINGCHANGE`
//! so the shell refreshes, and refresh the in-process PATH so agents spawned by
//! the already-running app find the CLI immediately.

use crate::core::error::AppError;
use std::path::Path;
use winreg::enums::RegType;
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_EXPAND_SZ};
use winreg::{RegKey, RegValue};

const ENV_KEY: &str = "Environment";
const PATH_VALUE: &str = "Path";

/// Add `dir` to the user PATH when missing (case-insensitive). Non-destructive:
/// existing entries are preserved in order.
pub(crate) fn add_to_user_path(dir: &Path) -> Result<(), AppError> {
    let dir = normalize_dir(dir);
    let (mut entries, vtype) = read_user_path()?;
    if entries.iter().any(|e| eq_entry(e, &dir)) {
        return Ok(());
    }
    entries.push(dir.clone());
    write_user_path(&entries, vtype)?;
    broadcast_environment_change();
    prepend_in_process_path(&dir);
    Ok(())
}

/// Remove `dir` from the user PATH if present. Returns whether an entry was
/// removed. An empty PATH value is deleted rather than written empty.
pub(crate) fn remove_from_user_path(dir: &Path) -> Result<bool, AppError> {
    let dir = normalize_dir(dir);
    let (mut entries, vtype) = read_user_path()?;
    let before = entries.len();
    entries.retain(|e| !eq_entry(e, &dir));
    if entries.len() == before {
        return Ok(false);
    }
    write_user_path(&entries, vtype)?;
    broadcast_environment_change();
    remove_in_process_path(&dir);
    Ok(true)
}

/// Normalize a directory into a canonical registry PATH entry (`\` separators).
fn normalize_dir(dir: &Path) -> String {
    dir.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_string()
}

fn eq_entry(a: &str, b: &str) -> bool {
    a.trim_matches('"')
        .eq_ignore_ascii_case(b.trim_matches('"'))
}

/// Split a registry PATH string, dropping blank segments but preserving each
/// entry verbatim (quotes, case) so round-tripping never rewrites user entries.
fn parse_entries(text: &str) -> Vec<String> {
    text.split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

fn join_entries(entries: &[String]) -> String {
    entries.join(";")
}

fn read_user_path() -> Result<(Vec<String>, RegType), AppError> {
    let env = open_env_key()?;
    match env.get_raw_value(PATH_VALUE) {
        Ok(raw) => {
            let vtype = raw.vtype;
            let text = decode_reg_string(&raw.bytes);
            Ok((parse_entries(&text), vtype))
        }
        Err(_) => Ok((Vec::new(), REG_EXPAND_SZ)),
    }
}

fn write_user_path(entries: &[String], vtype: RegType) -> Result<(), AppError> {
    let env = open_env_key()?;
    if entries.is_empty() {
        env.delete_value(PATH_VALUE)
            .map_err(|e| AppError::message(format!("delete HKCU\\{ENV_KEY}\\{PATH_VALUE}: {e}")))?;
        return Ok(());
    }
    let text = join_entries(entries);
    let bytes = encode_reg_string(&text);
    let raw = RegValue { bytes, vtype };
    env.set_raw_value(PATH_VALUE, &raw)
        .map_err(|e| AppError::message(format!("set HKCU\\{ENV_KEY}\\{PATH_VALUE}: {e}")))
}

fn open_env_key() -> Result<RegKey, AppError> {
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(ENV_KEY, KEY_READ | KEY_WRITE)
        .map_err(|e| AppError::message(format!("open HKCU\\{ENV_KEY}: {e}")))
}

/// Decode a registry string value, tolerating the trailing NUL unit(s) of
/// `REG_SZ` / `REG_EXPAND_SZ`. Only whole zero units are stripped — a single
/// stray `00` byte (the high byte of a trailing ASCII char) is left intact.
fn decode_reg_string(bytes: &[u8]) -> String {
    let mut bytes = bytes;
    while bytes.len() >= 2 && bytes[bytes.len() - 2] == 0 && bytes[bytes.len() - 1] == 0 {
        bytes = &bytes[..bytes.len() - 2];
    }
    let units = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| u16::from_le_bytes(*c))
        .collect::<Vec<u16>>();
    String::from_utf16(&units).unwrap_or_default()
}

fn encode_reg_string(text: &str) -> Vec<u8> {
    let mut bytes: Vec<u8> = text.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    bytes.push(0);
    bytes.push(0);
    bytes
}

/// Tell the shell to reload environment variables so new processes see the
/// updated PATH. Best-effort: a missing Explorer does not fail the install.
fn broadcast_environment_change() {
    const HWND_BROADCAST: isize = 0xFFFF;
    const WM_SETTINGCHANGE: u32 = 0x001A;
    const SMTO_ABORTIFHUNG: u32 = 0x0002;

    #[link(name = "user32")]
    unsafe extern "system" {
        fn SendMessageTimeoutW(
            hwnd: isize,
            msg: u32,
            wparam: usize,
            lparam: isize,
            flags: u32,
            timeout: u32,
            result: *mut usize,
        ) -> isize;
    }

    let param = "Environment\0".encode_utf16().collect::<Vec<u16>>();
    unsafe {
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            0,
            param.as_ptr() as isize,
            SMTO_ABORTIFHUNG,
            5000,
            std::ptr::null_mut(),
        );
    }
}

/// Refresh the current process PATH so agents spawned by this running app find
/// the CLI right away (registry edits only affect new processes after a restart).
fn prepend_in_process_path(dir: &str) {
    let Some(current) = std::env::var_os("PATH") else {
        // SAFETY: single-threaded install moment; the running app needs the new
        // entry for the agent spawns in this session.
        unsafe { std::env::set_var("PATH", dir) };
        return;
    };
    let current = current.to_string_lossy().into_owned();
    if current.split(';').any(|p| p.eq_ignore_ascii_case(dir)) {
        return;
    }
    unsafe { std::env::set_var("PATH", format!("{dir};{current}")) };
}

fn remove_in_process_path(dir: &str) {
    let Some(current) = std::env::var_os("PATH") else {
        return;
    };
    let next = current
        .to_string_lossy()
        .split(';')
        .filter(|p| !p.eq_ignore_ascii_case(dir))
        .collect::<Vec<_>>()
        .join(";");
    unsafe { std::env::set_var("PATH", next) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_windows_style_dirs() {
        assert_eq!(
            normalize_dir(Path::new("C:\\Users\\a b\\AppData\\Local\\Agentero\\bin")),
            "C:\\Users\\a b\\AppData\\Local\\Agentero\\bin"
        );
        assert_eq!(
            normalize_dir(Path::new("C:/Users/foo/AppData/Local/Agentero/bin/")),
            "C:\\Users\\foo\\AppData\\Local\\Agentero\\bin"
        );
    }

    #[test]
    fn parses_and_joins_registry_path() {
        let entries = parse_entries("A;B;;\"C\"; ");
        // Entries round-trip verbatim (quotes preserved).
        assert_eq!(entries, vec!["A", "B", "\"C\""]);
        assert_eq!(join_entries(&entries), "A;B;\"C\"");
        // Comparison ignores quotes + case.
        assert!(entries.iter().any(|e| eq_entry(e, "a")));
        assert!(entries.iter().any(|e| eq_entry(e, "\"C\"")));
        assert!(entries.iter().any(|e| eq_entry(e, "c")));
    }

    #[test]
    fn roundtrips_reg_string_encoding() {
        let text = "C:\\Users\\me\\bin;D:\\tools";
        let bytes = encode_reg_string(text);
        assert_eq!(decode_reg_string(&bytes), text);
        // REG_SZ terminator is a single NUL unit (`00 00`) — decodes cleanly.
        assert_eq!(decode_reg_string(&bytes[..bytes.len() - 2]), text);
    }
}
