//! File-name components derived from external text (DOIs, titles, collection
//! names).
//!
//! A vault can be opened on any desktop OS, so a folder or file name produced
//! here must also be legal on Windows: it rejects `\ / : * ? " < > |` and
//! control characters, drops trailing dots and spaces, and refuses the reserved
//! device names (`CON`, `NUL`, `COM1`, 鈥? with `ERROR_INVALID_NAME`
//! (os error 267).

/// Characters a Windows file name cannot contain.
pub fn is_windows_illegal(ch: char) -> bool {
    matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || ch.is_control()
}

/// True for a Windows reserved device name, with or without an extension.
pub fn is_reserved_device_name(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or(name)
        .trim()
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}

/// Map arbitrary text to one portable file-name component.
///
/// Illegal characters become `_` and trailing dots / spaces are dropped. The
/// mapping is lossy (two inputs can share one output), so callers that need a
/// stable identity must keep their own uniqueness on top of it.
pub fn safe_file_stem(raw: &str) -> String {
    let mapped: String = raw
        .chars()
        .map(|ch| if is_windows_illegal(ch) { '_' } else { ch })
        .collect();
    let trimmed = mapped.trim_end_matches([' ', '.']).trim();
    if trimmed.is_empty() {
        return "untitled".to_string();
    }
    if is_reserved_device_name(trimmed) {
        format!("_{trimmed}")
    } else {
        trimmed.to_string()
    }
}
