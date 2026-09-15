//! Shared knowledge of common tool install locations.
//!
//! Consumed by both the local GUI PATH patch (`features/agent/discover.rs`,
//! Launchpad-style launches miss the login-shell PATH) and the remote SSH
//! bootstrap (`features/remote/agent_exec.rs`, BatchMode `bash -lc` skips
//! interactive-only profile snippets). Keep the two sides in sync by editing
//! this list instead of either consumer.
//!
//! The entries below are POSIX paths: the GUI patch applies them on every
//! platform (a `$HOME`-relative dir that does not exist is just skipped), only
//! the remote SSH bootstrap is POSIX-only. Windows-only absolute dirs live in
//! `WIN_ABS_BIN_DIRS`.

/// `$HOME`-relative bin directories, highest priority first.
pub const HOME_BIN_DIRS: &[&str] = &[
    ".local/bin",
    "bin",
    ".npm-global/bin",
    ".cargo/bin",
    ".volta/bin",
    // OpenCode official installer (`curl -fsSL https://opencode.ai/install | bash`)
    // drops a single binary here; GUI launches miss it because the dir is only
    // added to the shell PATH by the installer.
    ".opencode/bin",
    // xAI Grok CLI official installer (https://x.ai/cli/install.sh).
    ".grok/bin",
    // Kimi Code official installer (single binary, writes PATH into the shell rc).
    ".kimi-code/bin",
    // fnm default-alias bins (data dir varies by platform; session
    // multishell dirs are ephemeral, skip them).
    "Library/Application Support/fnm/aliases/default/bin",
    ".local/share/fnm/aliases/default/bin",
    ".fnm/aliases/default/bin",
];

/// Absolute bin directories (POSIX), highest priority first.
pub const ABS_BIN_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];

/// Absolute bin directories on Windows, highest priority first.
///
/// Chocolatey writes its shim dir into the *machine* PATH, so it is normally
/// inherited already; it is listed defensively for launches that do not get the
/// user's full environment (service / scheduler task), like the npm and scoop
/// dirs the GUI patch adds itself.
pub const WIN_ABS_BIN_DIRS: &[&str] = &[r"C:\ProgramData\chocolatey\bin"];

/// Linuxbrew install roots (common on servers).
pub const LINUXBREW_ABS_BIN: &str = "/home/linuxbrew/.linuxbrew/bin";
pub const LINUXBREW_HOME_BIN: &str = ".linuxbrew/bin";

/// nvm layout: binaries live under `$HOME/{NVM_VERSIONS_DIR}/<ver>/bin`,
/// never on a GUI or non-interactive PATH (nvm only mutates shell PATH).
pub const NVM_VERSIONS_DIR: &str = ".nvm/versions/node";
/// Alias file whose content names the default nvm version (e.g. `v24.16.0`).
pub const NVM_DEFAULT_ALIAS_FILE: &str = ".nvm/alias/default";
