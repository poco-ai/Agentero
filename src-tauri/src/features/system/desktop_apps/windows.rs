//! Windows installation probes. Read current-user MSIX registration and both
//! registry views for desktop installers; never infer installation from caches.
use super::AppSpec;
use crate::core::error::AppError;
use std::path::{Component, Path, PathBuf};
use winreg::enums::{
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY,
};
use winreg::RegKey;

pub(super) struct WinSpec {
    pub uninstall_names: &'static [&'static str],
    pub package_names: &'static [&'static str],
    pub exe_names: &'static [&'static str],
    pub install_names: &'static [&'static str],
    pub protocols: &'static [&'static str],
}

pub(super) struct InstalledApp {
    pub path: PathBuf,
    aumid: Option<String>,
}

struct Sources {
    uninstall: Vec<RegKey>,
    app_paths: Vec<RegKey>,
    classes: Vec<RegKey>,
    packages: Option<RegKey>,
}

impl Sources {
    fn system() -> Self {
        let mut result = Self {
            uninstall: Vec::new(),
            app_paths: Vec::new(),
            classes: Vec::new(),
            packages: None,
        };
        for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            let root = RegKey::predef(hive);
            for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
                for (path, keys) in [
                    (
                        r"Software\Microsoft\Windows\CurrentVersion\Uninstall",
                        &mut result.uninstall,
                    ),
                    (
                        r"Software\Microsoft\Windows\CurrentVersion\App Paths",
                        &mut result.app_paths,
                    ),
                    (r"Software\Classes", &mut result.classes),
                ] {
                    if let Ok(key) = root.open_subkey_with_flags(path, KEY_READ | view) {
                        keys.push(key);
                    }
                }
            }
        }
        result.packages = RegKey::predef(HKEY_CURRENT_USER).open_subkey(
            r"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages"
        ).ok();
        result
    }
}

pub(super) fn detect(spec: &AppSpec) -> Option<InstalledApp> {
    let dirs = ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"]
        .into_iter()
        .filter_map(|key| {
            std::env::var_os(key).map(|value| {
                let path = PathBuf::from(value);
                if key == "LOCALAPPDATA" {
                    path.join("Programs")
                } else {
                    path
                }
            })
        })
        .collect::<Vec<_>>();
    detect_in(&spec.windows, &Sources::system(), &dirs)
}

fn detect_in(spec: &WinSpec, sources: &Sources, dirs: &[PathBuf]) -> Option<InstalledApp> {
    if let Some(app) = sources.packages.as_ref().and_then(|keys| msix(spec, keys)) {
        return Some(app);
    }
    for root in &sources.uninstall {
        for name in root.enum_keys().filter_map(Result::ok) {
            let Ok(key) = root.open_subkey(name) else {
                continue;
            };
            let display = key
                .get_value::<String, _>("DisplayName")
                .unwrap_or_default();
            if !spec
                .uninstall_names
                .iter()
                .any(|name| display_matches(&display, name))
            {
                continue;
            }
            if let Ok(icon) = key.get_value::<String, _>("DisplayIcon") {
                if let Some(path) = native_value(spec, &icon) {
                    return Some(native_app(path));
                }
            }
            if let Ok(location) = key.get_value::<String, _>("InstallLocation") {
                let dir = PathBuf::from(expand_environment(location.trim().trim_matches('"')));
                if let Some(path) = executable_in(spec, &dir) {
                    return Some(native_app(path));
                }
            }
            // Inno installers may omit InstallLocation; the uninstaller is
            // beside the app. Never execute the uninstall command itself.
            if let Ok(command) = key.get_value::<String, _>("UninstallString") {
                if let Some(dir) =
                    command_path(&command).and_then(|path| path.parent().map(Path::to_path_buf))
                {
                    if let Some(path) = executable_in(spec, &dir) {
                        return Some(native_app(path));
                    }
                }
            }
        }
    }
    for root in &sources.app_paths {
        for name in spec.exe_names {
            if let Some(path) = root
                .open_subkey(name)
                .ok()
                .and_then(|key| key.get_value::<String, _>("").ok())
                .and_then(|value| native_value(spec, &value))
            {
                return Some(native_app(path));
            }
        }
    }
    for root in &sources.classes {
        for scheme in spec.protocols {
            // A protocol key alone can remain after uninstall. Require its
            // registered command to point at the app's existing executable.
            if let Some(path) = root
                .open_subkey(format!(r"{scheme}\shell\open\command"))
                .ok()
                .and_then(|key| key.get_value::<String, _>("").ok())
                .and_then(|value| native_value(spec, &value))
            {
                return Some(native_app(path));
            }
        }
    }
    for dir in dirs {
        for name in spec.install_names {
            if let Some(path) = executable_in(spec, &dir.join(name)) {
                return Some(native_app(path));
            }
        }
    }
    None
}

fn native_app(path: PathBuf) -> InstalledApp {
    InstalledApp { path, aumid: None }
}

fn display_matches(display: &str, name: &str) -> bool {
    let display = display.trim().to_ascii_lowercase();
    let name = name.to_ascii_lowercase();
    display.strip_prefix(&name).is_some_and(|suffix| {
        suffix.is_empty()
            || suffix.starts_with([' ', '(', '-'])
            || suffix.starts_with(|c: char| c.is_ascii_digit())
    })
}

fn expand_environment(value: &str) -> String {
    let mut result = String::new();
    let mut rest = value;
    while let Some(start) = rest.find('%') {
        result.push_str(&rest[..start]);
        let Some(end) = rest[start + 1..].find('%') else {
            result.push_str(&rest[start..]);
            return result;
        };
        let end = start + 1 + end;
        let token = &rest[start + 1..end];
        result.push_str(&std::env::var(token).unwrap_or_else(|_| rest[start..=end].to_string()));
        rest = &rest[end + 1..];
    }
    result.push_str(rest);
    result
}

fn command_path(value: &str) -> Option<PathBuf> {
    let value = expand_environment(value.trim().trim_start_matches('@'));
    let value = value.trim();
    let path = if let Some(quoted) = value.strip_prefix('"') {
        quoted.split('"').next()?
    } else {
        let end = value
            .to_ascii_lowercase()
            .match_indices(".exe")
            .map(|(i, _)| i + 4)
            .find(|end| value[*end..].is_empty() || value[*end..].starts_with([',', ' ', '\t']))?;
        &value[..end]
    };
    Some(PathBuf::from(path))
}

fn native_value(spec: &WinSpec, value: &str) -> Option<PathBuf> {
    let path = command_path(value)?;
    if !path.is_absolute()
        || !spec.exe_names.iter().any(|name| {
            path.file_name()
                .is_some_and(|file| file.eq_ignore_ascii_case(name))
        })
    {
        return None;
    }
    crate::core::process::resolve_command_in_paths(&path.to_string_lossy(), &[])
}

fn executable_in(spec: &WinSpec, dir: &Path) -> Option<PathBuf> {
    spec.exe_names
        .iter()
        .find_map(|name| native_value(spec, &format!("\"{}\"", dir.join(name).display())))
}

fn msix(spec: &WinSpec, packages: &RegKey) -> Option<InstalledApp> {
    if spec.package_names.is_empty() {
        return None;
    }
    for full_name in packages.enum_keys().filter_map(Result::ok) {
        let parts = full_name.split('_').collect::<Vec<_>>();
        if parts.len() != 5
            || parts[4].is_empty()
            || !spec
                .package_names
                .iter()
                .any(|name| parts[0].eq_ignore_ascii_case(name))
        {
            continue;
        }
        let Some(app) = packages
            .open_subkey(&full_name)
            .ok()
            .and_then(|key| msix_package(spec, &key, parts[0], parts[4]))
        else {
            continue;
        };
        return Some(app);
    }
    None
}

fn msix_package(spec: &WinSpec, key: &RegKey, name: &str, publisher: &str) -> Option<InstalledApp> {
    let root = PathBuf::from(key.get_value::<String, _>("PackageRootFolder").ok()?);
    let xml = std::fs::read_to_string(root.join("AppxManifest.xml")).ok()?;
    let manifest = roxmltree::Document::parse(&xml).ok()?;
    // Ignore stale registrations, resources-only packages and non-UI helpers.
    manifest
        .descendants()
        .find(|n| n.tag_name().name() == "Identity" && n.attribute("Name") == Some(name))?;
    for app in manifest
        .descendants()
        .filter(|n| n.tag_name().name() == "Application")
    {
        let Some(id) = app.attribute("Id") else {
            continue;
        };
        if key.open_subkey(id).is_err()
            || !app
                .children()
                .any(|n| n.tag_name().name() == "VisualElements")
        {
            continue;
        }
        let Some(executable) = app.attribute("Executable") else {
            continue;
        };
        let relative = Path::new(executable);
        if relative
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        {
            continue;
        }
        // Rebuilding components normalizes / and \\ even for extended paths.
        let relative = relative.components().collect::<PathBuf>();
        if let Some(path) = native_value(spec, &format!("\"{}\"", root.join(relative).display())) {
            return Some(InstalledApp {
                path,
                aumid: Some(format!("{name}_{publisher}!{id}")),
            });
        }
    }
    None
}

pub(super) fn open(spec: &AppSpec) -> Result<(), AppError> {
    let app = detect(spec).ok_or_else(|| {
        AppError::message("desktop app is not installed or its executable is missing")
    })?;
    launch(&app)
}

fn launch_command(app: &InstalledApp) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let mut command = match &app.aumid {
        Some(aumid) => {
            let mut command = Command::new("explorer.exe");
            command.arg(format!(r"shell:AppsFolder\{aumid}"));
            command
        }
        None => Command::new(&app.path),
    };
    command
        .creation_flags(0x0800_0000)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

fn launch(app: &InstalledApp) -> Result<(), AppError> {
    launch_command(app)
        .spawn()
        .map(|_| ())
        .map_err(|error| AppError::message(format!("failed to open desktop app: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::system::desktop_apps::APPS;

    struct Fixture {
        dir: tempfile::TempDir,
        registry_path: String,
        root: RegKey,
        sources: Sources,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::Builder::new()
                .prefix("desktop apps ")
                .tempdir()
                .unwrap();
            let registry_path = format!(
                r"Software\Agentero\DesktopAppProbeTests\{}-{}",
                std::process::id(),
                dir.path().file_name().unwrap().to_string_lossy()
            );
            let (root, _) = RegKey::predef(HKEY_CURRENT_USER)
                .create_subkey(&registry_path)
                .unwrap();
            let sources = Sources {
                uninstall: vec![
                    root.create_subkey("UserUninstall").unwrap().0,
                    root.create_subkey("Machine32Uninstall").unwrap().0,
                ],
                app_paths: vec![root.create_subkey("AppPaths").unwrap().0],
                classes: vec![root.create_subkey("Classes").unwrap().0],
                packages: Some(root.create_subkey("Packages").unwrap().0),
            };
            Self {
                dir,
                registry_path,
                root,
                sources,
            }
        }
        fn exe(&self, name: &str) -> PathBuf {
            let path = self.dir.path().join(name);
            std::fs::write(&path, b"MZ fixture").unwrap();
            path
        }
        fn detect(&self, index: usize) -> Option<InstalledApp> {
            detect_in(&APPS[index].windows, &self.sources, &[])
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            // This path is generated under our private, unique test namespace.
            RegKey::predef(HKEY_CURRENT_USER)
                .delete_subkey_all(&self.registry_path)
                .unwrap();
        }
    }

    #[test]
    fn uninstall_icon_supports_chinese_names_spaces_and_icon_indices() {
        let fixture = Fixture::new();
        let exe = fixture.exe("QwenWorkCN.exe");
        let (record, _) = fixture.sources.uninstall[0].create_subkey("Qwen").unwrap();
        record.set_value("DisplayName", &"千问办公 1.0").unwrap();
        record
            .set_value("DisplayIcon", &format!("\"{}\",0", exe.display()))
            .unwrap();
        assert_eq!(fixture.detect(1).unwrap().path, exe);
        record
            .set_value("DisplayName", &"Unrelated QwenWork helper")
            .unwrap();
        assert!(fixture.detect(1).is_none());
    }

    #[test]
    fn machine_view_install_location_is_checked_and_stale_records_are_rejected() {
        let fixture = Fixture::new();
        let exe = fixture.exe("WorkBuddy.exe");
        let (record, _) = fixture.sources.uninstall[1]
            .create_subkey("WorkBuddy_is1")
            .unwrap();
        record.set_value("DisplayName", &"WorkBuddy").unwrap();
        record
            .set_value("InstallLocation", &fixture.dir.path().display().to_string())
            .unwrap();
        assert_eq!(fixture.detect(2).unwrap().path, exe);
        std::fs::remove_file(exe).unwrap();
        std::fs::create_dir(fixture.dir.path().join(".workbuddy-ai")).unwrap();
        assert!(fixture.detect(2).is_none());
    }

    #[test]
    fn inno_uninstaller_directory_can_locate_the_app_but_is_never_the_target() {
        let fixture = Fixture::new();
        let exe = fixture.exe("WorkBuddy.exe");
        let uninstall = fixture.exe("unins000.exe");
        let (record, _) = fixture.sources.uninstall[0]
            .create_subkey("WorkBuddy")
            .unwrap();
        record.set_value("DisplayName", &"WorkBuddy AI").unwrap();
        record
            .set_value(
                "UninstallString",
                &format!("\"{}\" /SILENT", uninstall.display()),
            )
            .unwrap();
        assert_eq!(fixture.detect(2).unwrap().path, exe);
    }

    #[test]
    fn app_paths_and_protocols_require_an_existing_matching_executable() {
        let fixture = Fixture::new();
        let qwen = fixture.exe("QwenWork.exe");
        let (key, _) = fixture.sources.app_paths[0]
            .create_subkey("QwenWork.exe")
            .unwrap();
        key.set_value("", &qwen.display().to_string()).unwrap();
        assert_eq!(fixture.detect(1).unwrap().path, qwen);
        let buddy = fixture.exe("WorkBuddy.exe");
        let (key, _) = fixture.sources.classes[0]
            .create_subkey(r"workbuddy\shell\open\command")
            .unwrap();
        key.set_value("", &format!("\"{}\" --open-url \"%1\"", buddy.display()))
            .unwrap();
        assert_eq!(fixture.detect(2).unwrap().path, buddy);
        std::fs::remove_file(buddy).unwrap();
        assert!(fixture.detect(2).is_none());
    }

    #[test]
    fn only_install_folders_with_real_executables_count_not_data_or_empty_folders() {
        let fixture = Fixture::new();
        let install = fixture.dir.path().join("WorkBuddy");
        std::fs::create_dir_all(&install).unwrap();
        let dirs = [fixture.dir.path().to_path_buf()];
        assert!(detect_in(&APPS[2].windows, &fixture.sources, &dirs).is_none());
        std::fs::write(install.join("WorkBuddy.exe"), b"MZ fixture").unwrap();
        assert!(detect_in(&APPS[2].windows, &fixture.sources, &dirs).is_some());
        std::fs::write(install.join("WorkBuddy.exe"), b"not an executable").unwrap();
        assert!(detect_in(&APPS[2].windows, &fixture.sources, &dirs).is_none());
    }

    #[test]
    fn msix_uses_registered_ui_id_and_ignores_helpers_and_stale_packages() {
        let fixture = Fixture::new();
        fixture.exe("ChatGPT.exe");
        let (key, _) = fixture
            .sources
            .packages
            .as_ref()
            .unwrap()
            .create_subkey("OpenAI.Codex_1.0.0.0_x64__publisher")
            .unwrap();
        key.set_value(
            "PackageRootFolder",
            &fixture.dir.path().display().to_string(),
        )
        .unwrap();
        let xml = r#"<Package xmlns="urn:package" xmlns:uap="urn:uap"><Identity Name="OpenAI.Codex"/><Applications><Application Id="Helper" Executable="ChatGPT.exe"/><Application Id="Main" Executable="ChatGPT.exe"><uap:VisualElements/></Application></Applications></Package>"#;
        let manifest = fixture.dir.path().join("AppxManifest.xml");
        std::fs::write(&manifest, xml).unwrap();
        assert!(fixture.detect(0).is_none());
        key.create_subkey("Main").unwrap();
        let app = fixture.detect(0).unwrap();
        assert_eq!(app.aumid.as_deref(), Some("OpenAI.Codex_publisher!Main"));
        let command = launch_command(&app);
        assert_eq!(command.get_program(), "explorer.exe");
        assert_eq!(
            command.get_args().next().unwrap(),
            r"shell:AppsFolder\OpenAI.Codex_publisher!Main"
        );
        std::fs::remove_file(manifest).unwrap();
        assert!(fixture.detect(0).is_none());
    }

    #[test]
    fn dsh_desktop_requires_the_gui_executable_not_a_cli_or_home_directory() {
        let fixture = Fixture::new();
        let cli = fixture.dir.path().join("dsh.cmd");
        std::fs::write(&cli, "@echo off").unwrap();
        std::fs::create_dir(fixture.dir.path().join(".dsh")).unwrap();
        let (record, _) = fixture.sources.uninstall[0].create_subkey("Dsh").unwrap();
        record
            .set_value("DisplayName", &"DeepSeek Harness 0.2.0-rc.2")
            .unwrap();
        record
            .set_value("DisplayIcon", &format!("\"{}\",0", cli.display()))
            .unwrap();
        assert!(fixture.detect(3).is_none());

        let exe = fixture.exe("DeepSeek Harness.exe");
        record
            .set_value("DisplayIcon", &format!("\"{}\",0", exe.display()))
            .unwrap();
        assert_eq!(fixture.detect(3).unwrap().path, exe);
        std::fs::remove_file(exe).unwrap();
        assert!(fixture.detect(3).is_none());
    }

    #[test]
    fn command_parsing_and_native_launch_do_not_invoke_a_shell() {
        let fixture = Fixture::new();
        let exe = fixture.exe("WorkBuddy.exe");
        let app = native_app(exe.clone());
        let command = launch_command(&app);
        assert_eq!(command.get_program(), exe);
        assert_eq!(command.get_args().count(), 0);
        assert_eq!(
            command_path(&format!("{},0", app.path.display())),
            Some(app.path.clone())
        );
        assert!(native_value(&APPS[2].windows, r"C:\missing\Uninstall.exe").is_none());
        assert_eq!(
            expand_environment("%AGENTERO_DESKTOP_TEST_UNKNOWN%"),
            "%AGENTERO_DESKTOP_TEST_UNKNOWN%"
        );
        assert_eq!(expand_environment("unterminated%"), "unterminated%");
        assert!(fixture.root.enum_keys().count() > 0);
    }
}
