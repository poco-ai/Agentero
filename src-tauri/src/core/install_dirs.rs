//! Shared knowledge of common tool install locations (POSIX).
//!
//! Consumed by both the local GUI PATH patch (`features/agent/discover.rs`,
//! Launchpad-style launches miss the login-shell PATH) and the remote SSH
//! bootstrap (`features/remote/agent_exec.rs`, BatchMode `bash -lc` skips
//! interactive-only profile snippets). Keep the two sides in sync by editing
//! this list instead of either consumer.

/// `$HOME`-relative bin directories, highest priority first.
pub const HOME_BIN_DIRS: &[&str] = &[
    ".local/bin",
    "bin",
    ".npm-global/bin",
    ".cargo/bin",
    ".volta/bin",
    // fnm default-alias bins (data dir varies by platform; session
    // multishell dirs are ephemeral, skip them).
    "Library/Application Support/fnm/aliases/default/bin",
    ".local/share/fnm/aliases/default/bin",
    ".fnm/aliases/default/bin",
];

/// Absolute bin directories, highest priority first.
pub const ABS_BIN_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];

/// Linuxbrew install roots (common on servers).
pub const LINUXBREW_ABS_BIN: &str = "/home/linuxbrew/.linuxbrew/bin";
pub const LINUXBREW_HOME_BIN: &str = ".linuxbrew/bin";

/// nvm layout: binaries live under `$HOME/{NVM_VERSIONS_DIR}/<ver>/bin`,
/// never on a GUI or non-interactive PATH (nvm only mutates shell PATH).
pub const NVM_VERSIONS_DIR: &str = ".nvm/versions/node";
/// Alias file whose content names the default nvm version (e.g. `v24.16.0`).
pub const NVM_DEFAULT_ALIAS_FILE: &str = ".nvm/alias/default";
