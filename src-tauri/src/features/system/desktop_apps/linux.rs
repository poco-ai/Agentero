//! Linux installation probes and launch helpers.
//!
//! Installations are recognised from what the desktop itself registered
//! (`.desktop` entries, the scheme handler database, Flatpak, Snap), never from
//! profile data such as `~/.config/<app>` or any cache. Every candidate must
//! resolve to an existing executable; an uninstalled app that left a cache
//! behind therefore stays "not installed".
//!
//! Distributors ship these GUIs as `.deb` / `.rpm`, Flatpak or Snap, where the
//! Electron payload sits in `<install root>/resources` (`/opt/<Product>`,
//! `/var/lib/flatpak/app/<id>/<arch>/<branch>/<commit>/files`).

use super::AppSpec;
use crate::core::error::AppError;
use crate::core::process::SpawnInAgentScratchDir;
use std::path::{Path, PathBuf};

pub(super) struct LinuxSpec {
    /// Desktop entry file names (`<name>.desktop`) distributors install.
    pub desktop_names: &'static [&'static str],
    /// `Name` written into the vendor's desktop entry.
    pub display_name: &'static str,
    /// Vendor application ids used by Flatpak and Snap registrations.
    pub app_ids: &'static [&'static str],
    /// Snap command names under `/snap/bin`.
    pub snap_names: &'static [&'static str],
    /// URI schemes registered as `x-scheme-handler/<scheme>`.
    pub protocols: &'static [&'static str],
    /// Directory inside the payload that ships a CLI engine, with the names it
    /// answers to (`qoderclicn`, `codebuddy`, …).
    pub bundled_cli: Option<(&'static str, &'static [&'static str])>,
}

/// Every installation layout keeps the Electron payload here.
const RESOURCES: &str = "resources";

/// One installed GUI: its desktop entry (preferred for launching, so argv and
/// single-instance handling match a menu click) plus the launchable executable
/// and the root that holds `resources/`.
#[derive(Debug)]
pub(super) struct Detected {
    /// `None` when only the installation tree or a binary is registered.
    pub desktop_entry: Option<DesktopEntry>,
    /// How the installation was registered, which decides how it is started.
    pub kind: InstallKind,
    /// Existing executable that starts the app.
    pub executable: PathBuf,
    /// Directory holding the app's `resources` payload.
    pub install_root: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum InstallKind {
    /// `.deb` / `.rpm` tree or a loose executable.
    Native,
    /// Flatpak application id.
    Flatpak(String),
    /// Snap command's regenerated entry.
    Snap,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct DesktopEntry {
    pub path: PathBuf,
    pub name: String,
    pub exec: ExecCandidate,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ExecCandidate {
    pub program: PathBuf,
    pub args: Vec<String>,
}

/// Filesystem roots a probe reads. System paths are the defaults; tests inject
/// a fixture so nothing outside it is touched.
pub(super) struct SearchRoots {
    /// Desktop entry directories, user before system.
    pub desktop_dirs: Vec<PathBuf>,
    /// Flatpak installations (`/var/lib/flatpak`, `~/.local/share/flatpak`).
    pub flatpak_roots: Vec<PathBuf>,
    /// Snap's regenerated entry directory.
    pub snap_desktop: PathBuf,
    /// Directories a bare `Exec` command is resolved against.
    pub exec_path: Vec<PathBuf>,
}

impl SearchRoots {
    fn system() -> Self {
        Self {
            desktop_dirs: desktop_dirs(),
            flatpak_roots: flatpak_roots(),
            snap_desktop: PathBuf::from("/var/lib/snapd/desktop/applications"),
            exec_path: std::env::var("PATH")
                .map(|value| std::env::split_paths(&value).collect())
                .unwrap_or_default(),
        }
    }

    #[cfg(test)]
    fn fixture(desktop_dirs: Vec<PathBuf>, flatpak_roots: Vec<PathBuf>) -> Self {
        Self {
            desktop_dirs,
            flatpak_roots,
            snap_desktop: PathBuf::from("/agentero-test/absent/snap-applications"),
            exec_path: Vec::new(),
        }
    }
}

pub(super) fn detect(spec: &AppSpec) -> Option<Detected> {
    detect_in(spec, &SearchRoots::system())
}

/// Apps without a Linux build (`linux: None`) never match a probe.
fn linux_spec(spec: &AppSpec) -> Option<&LinuxSpec> {
    spec.linux.as_ref()
}

/// Directories a desktop-bundled CLI was found in, for the child `PATH`.
pub(super) fn bundled_cli_dirs(spec: &AppSpec, commands: &[&str]) -> Vec<PathBuf> {
    let roots = SearchRoots::system();
    let Some(detected) = detect_in(spec, &roots) else {
        return Vec::new();
    };
    let binaries = commands
        .iter()
        .filter_map(|command| bundled_cli_for(spec, &detected, command))
        .collect::<Vec<_>>();
    let mut dirs: Vec<PathBuf> = Vec::new();
    for directory in binaries
        .iter()
        .filter_map(|binary| binary.parent().map(Path::to_path_buf))
    {
        if !dirs.contains(&directory) {
            dirs.push(directory);
        }
    }
    // A `#!` launcher (`codebuddy`) needs the Node this payload ships, because
    // the Host's own `node` may be missing or too old.
    let node = resources_dir(&detected).join("runtime/node/bin");
    if binaries.iter().any(|binary| is_interpreter_script(binary))
        && node.join("node").is_file()
        && !dirs.contains(&node)
    {
        dirs.push(node);
    }
    dirs
}

/// Resolve a CLI the app ships, using the install result so Flatpak / Snap
/// payloads work without assuming `/opt`.
pub(super) fn bundled_cli(spec: &AppSpec, requested: &str) -> Option<PathBuf> {
    let detected = detect(spec)?;
    bundled_cli_for(spec, &detected, requested)
}

fn bundled_cli_for(spec: &AppSpec, detected: &Detected, requested: &str) -> Option<PathBuf> {
    let (directory, names) = linux_spec(spec)?.bundled_cli?;
    if !names.contains(&requested) {
        return None;
    }
    let dir = resources_dir(detected).join(directory);
    candidate_files(requested, names)
        .into_iter()
        .find_map(|name| {
            crate::core::process::resolve_command_in_paths(name, std::slice::from_ref(&dir))
        })
}

/// A `#!` script launcher (`codebuddy`) rather than a native binary.
fn is_interpreter_script(binary: &Path) -> bool {
    use std::io::Read;
    let Ok(mut file) = std::fs::File::open(binary) else {
        return false;
    };
    let mut head = [0_u8; 2];
    file.read_exact(&mut head).is_ok() && &head == b"#!"
}

/// The requested entry first, then the other names the same engine answers
/// to (`qodercn` → `qoderclicn`).
fn candidate_files<'a>(requested: &'a str, names: &'a [&'a str]) -> Vec<&'a str> {
    std::iter::once(requested)
        .chain(names.iter().copied().filter(|name| *name != requested))
        .collect()
}

fn detect_in(spec: &AppSpec, roots: &SearchRoots) -> Option<Detected> {
    let spec = linux_spec(spec)?;
    for dir in &roots.desktop_dirs {
        for name in spec.desktop_names {
            let Some(entry) = read_desktop_entry(&dir.join(format!("{name}.desktop"))) else {
                continue;
            };
            if let Some(detected) = detected_from_entry(spec, entry, roots) {
                return Some(detected);
            }
        }
        for (id, path) in flatpak_entries_in(dir) {
            if !spec.app_ids.contains(&id.as_str()) {
                continue;
            }
            let Some(entry) = read_desktop_entry(&path) else {
                continue;
            };
            if let Some(detected) = detected_from_entry(spec, entry, roots) {
                return Some(detected);
            }
        }
    }
    for app_id in spec.app_ids {
        if let Some(detected) = detected_from_flatpak(spec, app_id, roots) {
            return Some(detected);
        }
    }
    for name in spec.snap_names {
        if let Some(detected) = detected_from_snap(spec, name, roots) {
            return Some(detected);
        }
    }
    for scheme in spec.protocols {
        if let Some(detected) = detected_from_scheme(spec, scheme, roots) {
            return Some(detected);
        }
    }
    None
}

/// The vendor's own display name, which is what the entry cannot fake by
/// merely reusing a file name.
fn entry_matches(spec: &LinuxSpec, entry: &DesktopEntry) -> bool {
    entry.name.trim().to_lowercase() == spec.display_name.to_lowercase()
        || display_matches(&entry.name, spec.display_name)
}

fn detected_from_entry(
    spec: &LinuxSpec,
    entry: DesktopEntry,
    roots: &SearchRoots,
) -> Option<Detected> {
    if !entry_matches(spec, &entry) {
        return None;
    }
    let executable = resolve_entry_program(&entry.exec, &roots.exec_path)?;
    // A registration name alone proves nothing: the program must exist, and a
    // Flatpak export must name an id that still has a deployed application.
    let flatpak_id = allowed_flatpak_id(&entry.path, &roots.flatpak_roots)
        .filter(|id| spec.app_ids.contains(&id.as_str()))
        .filter(|id| flatpak_app_root(id, &roots.flatpak_roots).is_some());
    let (kind, install_root) = match &flatpak_id {
        Some(id) => (
            InstallKind::Flatpak(id.clone()),
            flatpak_app_root(id, &roots.flatpak_roots)?.join("files"),
        ),
        None => (InstallKind::Native, install_root(&executable)),
    };
    Some(Detected {
        desktop_entry: Some(entry),
        kind,
        executable,
        install_root,
    })
}

/// Display names the vendor itself ships. A version or product tag may follow
/// (`ChatGPT (Beta)`, `WorkBuddy 5.6.2`) while helper entries
/// (`ChatGPT Helper`) never match, so an unrelated executable is rejected.
fn display_matches(display: &str, name: &str) -> bool {
    let display = display.trim().to_lowercase();
    let name = name.to_lowercase();
    let Some(suffix) = display.strip_prefix(&name) else {
        return false;
    };
    if suffix.is_empty() {
        return true;
    }
    if !suffix.starts_with([' ', '(', '-', '\u{3000}']) {
        return false;
    }
    let tag = suffix.trim_start_matches([' ', '(', '-', '\u{3000}']);
    tag.is_empty()
        || tag.starts_with(|c: char| c.is_ascii_digit() || c == 'v')
        || matches!(
            tag.trim_end_matches([')', '\u{3000}', ' '])
                .to_lowercase()
                .as_str(),
            "beta" | "alpha" | "preview" | "classic" | "canary" | "nightly" | "预览版"
        )
}

/// The directory whose `resources/` payload belongs to the app.
///
/// `resources/` beside the executable for a distro tree (`/usr/lib/chatgpt`),
/// `/opt/<Product>/<product>` for an unpacked tree; a launcher inside `bin/`
/// or an unpacked wrapper resolves to the product root one level up.
pub(super) fn install_root(executable: &Path) -> PathBuf {
    let executable = std::fs::canonicalize(executable).unwrap_or_else(|_| executable.into());
    if let Some(directory) = executable.parent() {
        if directory.join(RESOURCES).is_dir() {
            return directory.to_path_buf();
        }
    }
    for depth in 0..2 {
        let mut root = executable.as_path();
        for _ in 0..=depth {
            let Some(parent) = root.parent() else {
                break;
            };
            root = parent;
        }
        if root.join(RESOURCES).is_dir() {
            return root.to_path_buf();
        }
    }
    executable
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default()
}

pub(super) fn resources_dir(detected: &Detected) -> PathBuf {
    detected.install_root.join(RESOURCES)
}

/// `Exec` may name an absolute path or a bare command; `env`, `sh -c` and
/// other wrappers are never interpreted.
fn resolve_entry_program(exec: &ExecCandidate, path: &[PathBuf]) -> Option<PathBuf> {
    let program = &exec.program;
    if program.is_absolute() {
        return crate::core::process::resolve_command_in_paths(&program.to_string_lossy(), &[]);
    }
    if program.components().count() != 1 {
        return None;
    }
    crate::core::process::resolve_command_in_paths(&program.to_string_lossy(), path)
}

// --- directories -----------------------------------------------------------

fn data_home() -> Option<PathBuf> {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| dirs::home_dir().map(|home| home.join(".local/share")))
}

fn data_dirs() -> Vec<PathBuf> {
    let mut dirs = std::env::var("XDG_DATA_DIRS")
        .map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();
    for fallback in ["/usr/local/share", "/usr/share"] {
        let path = PathBuf::from(fallback);
        if !dirs.contains(&path) {
            dirs.push(path);
        }
    }
    dirs
}

/// Desktop entry directories, highest priority first (user before system).
fn desktop_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(data_home) = data_home() {
        dirs.push(data_home.join("applications"));
    }
    dirs.extend(data_dirs().iter().map(|dir| dir.join("applications")));
    dirs
}

fn flatpak_roots() -> Vec<PathBuf> {
    let mut roots = vec![PathBuf::from("/var/lib/flatpak")];
    if let Some(data_home) = data_home() {
        roots.push(data_home.join("flatpak"));
    }
    roots
}

// --- .desktop parsing ------------------------------------------------------

fn unescape_desktop_string(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            result.push(c);
            continue;
        }
        match chars.next() {
            Some('s') => result.push(' '),
            Some('n') => result.push('\n'),
            Some('t') => result.push('\t'),
            Some('r') => result.push('\r'),
            Some('\\') => result.push('\\'),
            Some(other) => result.push(other),
            None => result.push('\\'),
        }
    }
    result
}

/// Read `Name` and `Exec` from the `[Desktop Entry]` group only. Localized
/// keys (`Name[zh_CN]`) are ignored; the first untranslated occurrence wins.
fn parse_desktop_entry(text: &str) -> Option<(String, ExecCandidate)> {
    let mut in_entry = false;
    let mut name: Option<String> = None;
    let mut exec: Option<ExecCandidate> = None;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_entry || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim() {
            "Name" if name.is_none() => name = Some(unescape_desktop_string(value.trim())),
            "Exec" if exec.is_none() => exec = parse_exec(value.trim()),
            _ => {}
        }
    }
    Some((name?, exec?))
}

fn read_desktop_entry(path: &Path) -> Option<DesktopEntry> {
    let text = std::fs::read_to_string(path).ok()?;
    let (name, exec) = parse_desktop_entry(&text)?;
    Some(DesktopEntry {
        path: path.to_path_buf(),
        name,
        exec,
    })
}

/// Split an `Exec` value into a program and literal arguments.
///
/// Field codes (`%f`, `%F`, `%u`, `%U`, `%i`, `%c`, `%k`, …) are dropped —
/// Agentero opens the app without a document — and only the spec's quoting and
/// backslash escapes are honoured.
fn parse_exec(value: &str) -> Option<ExecCandidate> {
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut has_token = false;
    let mut chars = value.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                quoted = !quoted;
                has_token = true;
            }
            '\\' if quoted => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            '\\' => current.push('\\'),
            c if c.is_whitespace() && !quoted => {
                if has_token {
                    tokens.push(std::mem::take(&mut current));
                    has_token = false;
                }
            }
            c => {
                current.push(c);
                has_token = true;
            }
        }
    }
    if quoted || (has_token && current.is_empty()) {
        return None;
    }
    if has_token {
        tokens.push(current);
    }
    let mut tokens = tokens.into_iter();
    // A program made only of field codes (`%U`) is not launchable.
    let program = PathBuf::from(decode_field_codes(tokens.next()?)?);
    let args = tokens.filter_map(decode_field_codes).collect();
    Some(ExecCandidate { program, args })
}

/// Expand `%%` and drop field codes; returns `None` for a token that is only a
/// field code and keeps a literal `%` intact.
fn decode_field_codes(token: String) -> Option<String> {
    let mut result = String::new();
    let mut had_code = false;
    let mut chars = token.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            result.push(c);
            continue;
        }
        match chars.next() {
            Some('%') => result.push('%'),
            // `%f %F %u %U %i %c %k` and the deprecated codes carry no state.
            Some(_) => had_code = true,
            None => result.push('%'),
        }
    }
    if result.is_empty() && had_code {
        None
    } else {
        Some(result)
    }
}

// --- Flatpak ---------------------------------------------------------------

/// `(app id, desktop entry path)` pairs exported by one Flatpak installation.
fn flatpak_entries_in(dir: &Path) -> Vec<(String, PathBuf)> {
    let apps = dir.join("share/applications");
    let Ok(entries) = std::fs::read_dir(apps) else {
        return Vec::new();
    };
    let mut result = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let Some(id) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(id) = id.strip_suffix(".desktop") else {
            continue;
        };
        // Reverse-DNS ids are what Flatpak exports; plain files here belong to
        // the host.
        if id.split('.').count() < 2 {
            continue;
        }
        result.push((id.to_string(), path));
    }
    result
}

/// `<root>/app/<id>/<arch>/<branch>/<commit>` of the current deploy.
fn flatpak_app_root(id: &str, roots: &[PathBuf]) -> Option<PathBuf> {
    for root in roots {
        let Ok(archs) = std::fs::read_dir(root.join("app").join(id)) else {
            continue;
        };
        for arch in archs.filter_map(Result::ok) {
            let Ok(branches) = std::fs::read_dir(arch.path()) else {
                continue;
            };
            for branch in branches.filter_map(Result::ok) {
                let Ok(commits) = std::fs::read_dir(branch.path()) else {
                    continue;
                };
                for commit in commits.filter_map(Result::ok) {
                    let deploy = commit.path();
                    if deploy.join("active").is_file() || deploy.join("files").is_dir() {
                        return Some(deploy);
                    }
                }
            }
        }
    }
    None
}

/// A Flatpak export names the application `<id>.desktop` inside a Flatpak
/// installation root.
fn allowed_flatpak_id(entry: &Path, roots: &[PathBuf]) -> Option<String> {
    let id = entry.file_name()?.to_str()?.strip_suffix(".desktop")?;
    let exported = roots
        .iter()
        .any(|root| entry.starts_with(root.join("exports")));
    (exported && id.split('.').count() >= 2).then(|| id.to_string())
}

fn detected_from_flatpak(spec: &LinuxSpec, id: &str, search: &SearchRoots) -> Option<Detected> {
    let deploy = flatpak_app_root(id, &search.flatpak_roots)?;
    let root = deploy.join("files");
    if !root.join(RESOURCES).is_dir() {
        return None;
    }
    // The exported entry starts `flatpak run`; prefer it so argv matches a
    // menu click. Without it, launch the app directly through Flatpak.
    let entry = search
        .flatpak_roots
        .iter()
        .find_map(|root| {
            read_desktop_entry(&root.join(format!("exports/share/applications/{id}.desktop")))
        })
        .filter(|entry| entry_matches(spec, entry));
    let executable = entry
        .as_ref()
        .and_then(|entry| resolve_entry_program(&entry.exec, &search.exec_path))
        .unwrap_or_else(|| PathBuf::from("/usr/bin/flatpak"));
    Some(Detected {
        desktop_entry: entry,
        kind: InstallKind::Flatpak(id.to_string()),
        executable,
        install_root: root,
    })
}

// --- Snap ------------------------------------------------------------------

fn detected_from_snap(spec: &LinuxSpec, name: &str, roots: &SearchRoots) -> Option<Detected> {
    let entries = snap_entries(name, roots);
    if entries.is_empty() {
        return None;
    }
    let entry = entries
        .iter()
        .find(|entry| entry_matches(spec, entry))
        .or_else(|| entries.first())
        .cloned()?;
    // Snap regenerates the entry for every revision, but the launcher itself
    // only exists while the snap is installed.
    let executable = resolve_entry_program(&entry.exec, &roots.exec_path).or_else(|| {
        crate::core::process::resolve_command_in_paths(
            &PathBuf::from("/snap/bin").join(name).to_string_lossy(),
            &[],
        )
    })?;
    let install_root = install_root(&executable);
    // Snap mounts the revision on demand; only a visible payload can supply
    // the bundled CLI.
    (!install_root.join(RESOURCES).is_dir()).then_some(())?;
    Some(Detected {
        desktop_entry: Some(entry),
        kind: InstallKind::Snap,
        executable,
        install_root,
    })
}

/// Snap regenerates `<command>_<command>.desktop` (and `-<variant>`) on every
/// refresh, so the lexicographically last registration is the current one.
fn snap_entries(name: &str, roots: &SearchRoots) -> Vec<DesktopEntry> {
    let Ok(entries) = std::fs::read_dir(&roots.snap_desktop) else {
        return Vec::new();
    };
    let prefix = format!("{name}_");
    let mut paths: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|file| file.to_str())
                .is_some_and(|file| file.starts_with(&prefix) && file.ends_with(".desktop"))
        })
        .collect();
    paths.sort();
    paths
        .iter()
        .rev()
        .filter_map(|path| read_desktop_entry(path))
        .collect()
}

// --- scheme handlers -------------------------------------------------------

/// The default handler may live in any desktop data dir; its `Exec` must point
/// at an existing executable and carry this app's display name.
fn detected_from_scheme(spec: &LinuxSpec, scheme: &str, roots: &SearchRoots) -> Option<Detected> {
    let id = scheme_default_application(scheme).or_else(|| scheme_from_mimeapps(scheme))?;
    roots
        .desktop_dirs
        .iter()
        .filter_map(|dir| read_desktop_entry(&dir.join(&id)))
        .find_map(|entry| detected_from_entry(spec, entry, roots))
}

fn scheme_default_application(scheme: &str) -> Option<String> {
    let mut command = std::process::Command::new("gio");
    command
        .args(["mime", &format!("x-scheme-handler/{scheme}")])
        .spawn_in_agent_scratch_dir();
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    valid_handler(&String::from_utf8_lossy(&output.stdout))
}

/// `gio` ships with GLib but minimal installs may miss it; read the
/// freedesktop databases directly in that case.
fn scheme_from_mimeapps(scheme: &str) -> Option<String> {
    let key = format!("x-scheme-handler/{scheme}=");
    let mut files = Vec::new();
    if let Some(config) = dirs::config_dir() {
        files.push(config.join("mimeapps.list"));
    }
    for dir in data_dirs() {
        files.push(dir.join("applications/mimeapps.list"));
        files.push(dir.join("applications/defaults.list"));
    }
    for file in files {
        let Ok(text) = std::fs::read_to_string(file) else {
            continue;
        };
        for line in text.lines() {
            let Some(value) = line.trim().strip_prefix(&key) else {
                continue;
            };
            if let Some(id) = value.split(';').find_map(valid_handler) {
                return Some(id);
            }
        }
    }
    None
}

fn valid_handler(value: &str) -> Option<String> {
    // `gio` prints "No default applications…" on stdout for missing schemes.
    let id = value.trim().split(';').next().unwrap_or_default();
    let id = id.split('\u{201c}').next_back().unwrap_or(id);
    (id.ends_with(".desktop") && !id.contains(char::is_whitespace) && !id.contains('\u{201c}'))
        .then(|| id.to_string())
}

// --- launch ----------------------------------------------------------------

pub(super) fn open(spec: &AppSpec) -> Result<(), AppError> {
    let detected = detect(spec).ok_or_else(|| {
        AppError::message("desktop app is not installed or its executable is missing")
    })?;
    launch_command(&detected)
        .spawn()
        .map(|_| ())
        .map_err(|error| AppError::message(format!("failed to open desktop app: {error}")))
}

fn launch_command(detected: &Detected) -> std::process::Command {
    use std::process::{Command, Stdio};
    let mut command = match (&detected.kind, &detected.desktop_entry) {
        // GLib starts a plain `.desktop` entry exactly like a menu click
        // (startup notification, single instance, working directory).
        (InstallKind::Native, Some(entry)) => {
            let mut command = Command::new("gio");
            command.arg("launch").arg(&entry.path);
            command
        }
        // Flatpak exports and Snap entries keep their own argv (`flatpak run`).
        (_, Some(entry)) => {
            let mut command = Command::new(&entry.exec.program);
            command.args(&entry.exec.args);
            command
        }
        (InstallKind::Flatpak(id), None) => {
            let mut command = Command::new("flatpak");
            command.args(["run", id.as_str()]);
            command
        }
        (_, None) => Command::new(&detected.executable),
    };
    command
        .spawn_in_agent_scratch_dir()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::system::desktop_apps::DesktopAppId;

    const TEST_SPEC: LinuxSpec = LinuxSpec {
        desktop_names: &["ChatGPT"],
        display_name: "ChatGPT",
        app_ids: &["com.openai.chatgpt"],
        snap_names: &["chatgpt"],
        protocols: &[],
        bundled_cli: None,
    };

    fn test_app() -> AppSpec {
        AppSpec {
            id: DesktopAppId::Chatgpt,
            names: &["ChatGPT"],
            bundle_ids: &[],
            linux: Some(TEST_SPEC),
        }
    }

    fn qwen_app() -> AppSpec {
        AppSpec {
            id: DesktopAppId::Qwenwork,
            names: &["QwenWork"],
            bundle_ids: &[],
            linux: Some(LinuxSpec {
                desktop_names: &["qwenwork"],
                display_name: "QwenWork",
                app_ids: &["com.qwenwork.desktop"],
                snap_names: &[],
                protocols: &[],
                bundled_cli: Some(("app.asar.unpacked/bin", &["qoderclicn", "qodercn"])),
            }),
        }
    }

    #[cfg(unix)]
    fn executable_bin(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"fixture").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn exec_parsing_drops_field_codes_and_honors_quotes() {
        let exec = parse_exec("\"/opt/ChatGPT/codex\" --open-url %U --name \"My App\" %%").unwrap();
        assert_eq!(exec.program, PathBuf::from("/opt/ChatGPT/codex"));
        assert_eq!(exec.args, vec!["--open-url", "--name", "My App", "%"]);
    }

    #[test]
    fn exec_parsing_rejects_unbalanced_quotes_and_empty_values() {
        assert!(parse_exec("\"unterminated").is_none());
        assert!(parse_exec("").is_none());
        assert!(parse_exec("%U").is_none());
        assert_eq!(
            parse_exec("app --flag=\"100%\"").unwrap().args,
            vec!["--flag=100%"]
        );
    }

    #[test]
    fn desktop_entry_reads_only_the_main_group() {
        let text = "\
# comment
Name=Outside
[Desktop Entry]
Name=QwenWork\\sCN
Name[zh_CN]=千问办公
Exec=\"/opt/QwenWork/QwenWork\" %U
[Desktop Action New]
Name=Other
";
        let (name, exec) = parse_desktop_entry(text).unwrap();
        assert_eq!(name, "QwenWork CN");
        assert_eq!(exec.program, PathBuf::from("/opt/QwenWork/QwenWork"));
        assert!(parse_desktop_entry("[Desktop Action New]\nName=x\nExec=y").is_none());
    }

    #[test]
    fn display_names_match_product_and_localized_variants() {
        assert!(display_matches("ChatGPT", "ChatGPT"));
        assert!(display_matches("ChatGPT (Beta)", "ChatGPT"));
        assert!(display_matches("WorkBuddy 5.6.2", "WorkBuddy"));
        assert!(display_matches("千问办公", "千问办公"));
        assert!(!display_matches("ChatGPT Helper", "ChatGPT"));
        assert!(!display_matches("WorkBuddy AI Assistant", "WorkBuddy"));
        assert!(!display_matches("Flameshot", "Flame"));
    }

    #[test]
    fn scheme_handlers_reject_messages_and_accept_desktop_ids() {
        assert_eq!(
            valid_handler("No default applications for \u{201c}x-scheme-handler/dsh\u{201d}"),
            None
        );
        assert_eq!(
            valid_handler("workbuddy.desktop\n"),
            Some("workbuddy.desktop".to_string())
        );
        assert_eq!(
            valid_handler("first.desktop;second.desktop;"),
            Some("first.desktop".to_string())
        );
        assert_eq!(valid_handler(""), None);
    }

    #[test]
    fn install_root_walks_up_to_the_directory_with_resources() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("opt/ChatGPT");
        let executable = root.join("ChatGPT");
        std::fs::create_dir_all(&executable).unwrap();
        assert!(!install_root(&executable).join(RESOURCES).is_dir());
        std::fs::create_dir_all(root.join("resources")).unwrap();
        assert_eq!(install_root(&executable), root);
        // A wrapper one level below keeps pointing at its own install root.
        let wrapper = root.join("bin/ChatGPT");
        std::fs::create_dir_all(wrapper.parent().unwrap()).unwrap();
        std::fs::write(&wrapper, b"#!/bin/sh\n").unwrap();
        assert_eq!(install_root(&wrapper), root);
    }

    #[test]
    fn install_root_prefers_resources_beside_the_executable() {
        // The official `.deb` unpacks to `/usr/lib/chatgpt` (payload and
        // `resources/` side by side), not to an `/opt/<Product>/<product>` tree.
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("usr/lib/chatgpt");
        std::fs::create_dir_all(root.join(RESOURCES)).unwrap();
        let executable = root.join("ChatGPT");
        std::fs::write(&executable, b"fixture").unwrap();
        assert_eq!(install_root(&executable), root);
    }

    #[cfg(unix)]
    #[test]
    fn desktop_entries_require_an_installed_executable() {
        let fixture = tempfile::tempdir().unwrap();
        let apps = fixture.path().join("share/applications");
        let install = fixture.path().join("opt/ChatGPT");
        let binary = install.join("ChatGPT");
        std::fs::create_dir_all(&apps).unwrap();
        std::fs::write(
            apps.join("ChatGPT.desktop"),
            format!(
                "[Desktop Entry]\nName=ChatGPT\nExec=\"{}\" %U\n",
                binary.display()
            ),
        )
        .unwrap();
        let roots = SearchRoots::fixture(vec![apps.clone()], Vec::new());
        assert!(detect_in(&test_app(), &roots).is_none());

        executable_bin(&binary);
        let detected = detect_in(&test_app(), &roots).unwrap();
        assert_eq!(detected.executable, binary);
        assert_eq!(detected.install_root, install);
        assert_eq!(detected.kind, InstallKind::Native);
        assert_eq!(
            launch_command(&detected).get_program(),
            std::ffi::OsStr::new("gio")
        );

        // Uninstall removes the executable but may leave data behind.
        std::fs::remove_file(&binary).unwrap();
        std::fs::create_dir_all(fixture.path().join(".config/ChatGPT")).unwrap();
        assert!(detect_in(&test_app(), &roots).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn unrelated_desktop_entries_and_helpers_are_ignored() {
        let fixture = tempfile::tempdir().unwrap();
        let apps = fixture.path().join("share/applications");
        std::fs::create_dir_all(&apps).unwrap();
        let binary = fixture.path().join("bin/ChatGPT");
        executable_bin(&binary);
        std::fs::write(
            apps.join("ChatGPT.desktop"),
            format!(
                "[Desktop Entry]\nName=ChatGPT Helper\nExec=\"{}\"\n",
                binary.display()
            ),
        )
        .unwrap();
        // A vendor-named file (`chatgpt*.desktop`) with an unrelated program
        // still loses to the display-name check on its `Name`.
        std::fs::write(
            apps.join("chatgpt-helper.desktop"),
            format!(
                "[Desktop Entry]\nName=ChatGPT Helper\nExec=\"{}\"\n",
                binary.display()
            ),
        )
        .unwrap();
        std::fs::write(
            apps.join("helper.desktop"),
            format!(
                "[Desktop Entry]\nName=ChatGPT\nExec=\"{}\"\n",
                binary.display()
            ),
        )
        .unwrap();
        let roots = SearchRoots::fixture(vec![apps], Vec::new());
        assert!(detect_in(&test_app(), &roots).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn flatpak_exports_count_only_with_a_live_deployed_payload() {
        let fixture = tempfile::tempdir().unwrap();
        let flatpak = fixture.path().join("flatpak");
        let exports = flatpak.join("exports/share/applications");
        std::fs::create_dir_all(&exports).unwrap();
        std::fs::write(
            exports.join("com.openai.chatgpt.desktop"),
            "[Desktop Entry]\nName=ChatGPT\nExec=/usr/bin/flatpak run --branch=stable com.openai.chatgpt\n",
        )
        .unwrap();
        let roots = SearchRoots::fixture(Vec::new(), vec![flatpak.clone()]);
        // A leftover export without a payload is not an installation.
        assert!(detect_in(&test_app(), &roots).is_none());

        let deploy = flatpak.join("app/com.openai.chatgpt/x86_64/stable/abc123");
        std::fs::create_dir_all(deploy.join("files/resources")).unwrap();
        std::fs::write(deploy.join("active"), b"abc123").unwrap();
        let detected = detect_in(&test_app(), &roots).unwrap();
        assert_eq!(
            detected.kind,
            InstallKind::Flatpak("com.openai.chatgpt".into())
        );
        assert_eq!(detected.install_root, deploy.join("files"));
        // The export runs `flatpak`, which resolves through PATH.
        assert!(detect_in(&qwen_app(), &roots).is_none());
    }

    /// Real `qwenworkcn-linux-arm64.deb` 1.3.1 layout: `/opt/apps/QwenWorkCN`,
    /// `qwen-work-cn.desktop` with a Chinese `Name`, engine in `resources/bin`.
    #[cfg(unix)]
    #[test]
    fn qwenwork_cn_deb_layout_is_detected() {
        let fixture = tempfile::tempdir().unwrap();
        let apps = fixture.path().join("share/applications");
        let root = fixture.path().join("opt/apps/QwenWorkCN");
        std::fs::create_dir_all(&apps).unwrap();
        let gui = root.join("qwen-work-cn");
        executable_bin(&gui);
        let engine = root.join("resources/bin/qoderclicn");
        std::fs::create_dir_all(engine.parent().unwrap()).unwrap();
        std::fs::write(&engine, b"fixture").unwrap();
        std::fs::write(
            apps.join("qwen-work-cn.desktop"),
            format!(
                "[Desktop Entry]\nName=千问办公\nName[zh_CN]=千问办公\nExec=\"{}\" %U\nMimeType=x-scheme-handler/qwenwork-cn;\n",
                gui.display()
            ),
        )
        .unwrap();
        let spec = AppSpec {
            id: DesktopAppId::Qwenwork,
            names: &["QwenWorkCN"],
            bundle_ids: &[],
            linux: Some(LinuxSpec {
                desktop_names: &["qwen-work-cn"],
                display_name: "千问办公",
                app_ids: &["cn.qwenwork.desktop"],
                snap_names: &["qwenwork"],
                protocols: &["qwenwork-cn"],
                bundled_cli: Some(("bin", &["qoderclicn", "qodercli", "qodercn"])),
            }),
        };
        let roots = SearchRoots::fixture(vec![apps], Vec::new());
        let detected = detect_in(&spec, &roots).expect("deb layout installed");
        assert_eq!(detected.install_root, root);
        assert_eq!(detected.kind, InstallKind::Native);

        // The engine only supplies the CN template once it is executable.
        assert_eq!(
            linux_spec(&spec).unwrap().bundled_cli.unwrap().1,
            &["qoderclicn", "qodercli", "qodercn"]
        );
        assert!(bundled_cli_for(&spec, &detected, "qodercn").is_none());
        executable_bin(&engine);
        assert_eq!(
            bundled_cli_for(&spec, &detected, "qoderclicn"),
            Some(engine.clone())
        );
        // A newer dispatcher name finds the same engine.
        assert_eq!(bundled_cli_for(&spec, &detected, "qodercn"), Some(engine));
    }

    #[cfg(unix)]
    #[test]
    fn bundled_cli_resolves_inside_the_detected_install_tree() {
        let fixture = tempfile::tempdir().unwrap();
        let apps = fixture.path().join("share/applications");
        let root = fixture.path().join("opt/QwenWork");
        std::fs::create_dir_all(&apps).unwrap();
        let gui = root.join("QwenWork");
        executable_bin(&gui);
        std::fs::create_dir_all(root.join("resources/app.asar.unpacked/bin")).unwrap();
        let cli = root.join("resources/app.asar.unpacked/bin/qoderclicn");
        std::fs::write(&cli, b"data, not an executable").unwrap();
        std::fs::write(
            apps.join("qwenwork.desktop"),
            format!(
                "[Desktop Entry]\nName=QwenWork\nExec=\"{}\" %U\n",
                gui.display()
            ),
        )
        .unwrap();
        let roots = SearchRoots::fixture(vec![apps], Vec::new());
        let detected = detect_in(&qwen_app(), &roots).expect("gui installed");

        // Plain data with the engine name is not a usable CLI.
        assert!(bundled_cli_for(&qwen_app(), &detected, "qoderclicn").is_none());
        executable_bin(&cli);
        assert_eq!(
            bundled_cli_for(&qwen_app(), &detected, "qoderclicn"),
            Some(cli.clone())
        );
        // Commands the app does not ship never resolve to it.
        assert!(bundled_cli_for(&qwen_app(), &detected, "codebuddy").is_none());
        // The other names this engine answers to find the same file.
        assert_eq!(
            bundled_cli_for(&qwen_app(), &detected, "qodercn"),
            Some(cli.clone())
        );
    }
}
