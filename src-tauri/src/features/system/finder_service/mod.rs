//! Finder "Open with Agentero" Quick Action management (macOS).
//!
//! Finder offers no "Open With" for folders, so the app can install a
//! user-level Quick Action (a `.workflow` bundle in `~/Library/Services/`).
//! Its Run Shell Script action launches this app's binary with the selected
//! folder paths as bare arguments; `features::open_request::collect_open_args`
//! handles them (running app → single-instance forward, otherwise cold start).

use crate::core::error::AppError;
use crate::core::paths::agentero_config_dir;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[cfg(feature = "desktop")]
pub mod commands;

pub const WORKFLOW_NAME: &str = "Open with Agentero";
/// Ownership marker — never overwrite a `.workflow` we did not create.
pub const MARKER_BUNDLE_ID: &str = "com.poco-ai.agentero.open-vault-service";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinderServiceStatus {
    /// Quick Action integration only exists on macOS.
    pub supported: bool,
    pub installed: bool,
    pub install_path: Option<String>,
    /// Bundle the Quick Action is / would be pointed at.
    pub app_bundle_path: Option<String>,
    /// installed && baked-in bundle matches the current app bundle.
    pub current: bool,
    pub message: Option<String>,
}

fn is_macos() -> bool {
    cfg!(target_os = "macos")
}

pub fn workflow_root() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Library")
        .join("Services")
        .join(format!("{WORKFLOW_NAME}.workflow"))
}

/// Written when the user explicitly removes the Quick Action, so the startup
/// auto-install does not silently resurrect it. Cleared on explicit install.
fn opt_out_marker() -> PathBuf {
    agentero_config_dir().join("finder-service.removed")
}

fn opted_out() -> bool {
    opt_out_marker().exists()
}

/// The target a Quick Action should launch.
///
/// Installed bundle: the `.app` root (launched via `open` so it goes through
/// LaunchServices — Dock icon, focus, window session). Dev: the raw binary
/// from target/ (no `.app` ancestor), executed directly.
pub fn app_bundle_path() -> Result<PathBuf, AppError> {
    let exe = std::env::current_exe()
        .map_err(|e| AppError::message(format!("failed to resolve current executable: {e}")))?;
    let mut cursor = exe.as_path();
    while let Some(parent) = cursor.parent() {
        if cursor.extension().and_then(|e| e.to_str()) == Some("app") {
            return Ok(cursor.to_path_buf());
        }
        cursor = parent;
    }
    Ok(exe)
}

/// Whether the `.workflow` at `root` was created by us (marker bundle id).
pub fn is_ours(root: &Path) -> bool {
    let plist = root.join("Contents").join("Info.plist");
    std::fs::read_to_string(plist)
        .map(|s| s.contains(MARKER_BUNDLE_ID))
        .unwrap_or(false)
}

/// The app path baked into an installed workflow's shell script, if any.
pub fn baked_bundle_path(root: &Path) -> Option<PathBuf> {
    let wflow = root.join("Contents").join("document.wflow");
    let content = std::fs::read_to_string(wflow).ok()?;
    let start = content.find("APP='")? + "APP='".len();
    let end = content[start..].find('\'')? + start;
    Some(PathBuf::from(&content[start..end]))
}

pub fn collect_status() -> FinderServiceStatus {
    let supported = is_macos();
    let root = workflow_root();
    let bundle = app_bundle_path().ok();
    let installed = supported && is_ours(&root);
    let current = installed
        && match (&bundle, baked_bundle_path(&root)) {
            (Some(current), Some(baked)) => current == &baked,
            _ => false,
        };
    FinderServiceStatus {
        supported,
        installed,
        install_path: installed.then(|| root.to_string_lossy().into_owned()),
        app_bundle_path: bundle.map(|p| p.to_string_lossy().into_owned()),
        current,
        message: None,
    }
}

pub fn install() -> Result<FinderServiceStatus, AppError> {
    if !is_macos() {
        return Err(AppError::message(
            "Finder Quick Action is only supported on macOS",
        ));
    }
    let bundle = app_bundle_path()?;
    let root = workflow_root();
    if root.exists() && !is_ours(&root) {
        return Err(AppError::message(format!(
            "refusing to overwrite non-Agentero workflow at {}",
            root.display()
        )));
    }
    let contents = root.join("Contents");
    std::fs::create_dir_all(&contents)?;
    std::fs::write(contents.join("Info.plist"), INFO_PLIST)?;
    std::fs::write(contents.join("document.wflow"), build_wflow(&bundle))?;
    let _ = std::fs::remove_file(opt_out_marker());
    refresh_services_db();
    log::info!(
        target: "agentero::op",
        "op end finder_service_install ok=true path={} bundle={}",
        root.display(),
        bundle.display()
    );
    Ok(collect_status())
}

pub fn uninstall() -> Result<FinderServiceStatus, AppError> {
    if !is_macos() {
        return Err(AppError::message(
            "Finder Quick Action is only supported on macOS",
        ));
    }
    let root = workflow_root();
    if root.exists() {
        if !is_ours(&root) {
            return Err(AppError::message(format!(
                "refusing to remove non-Agentero workflow at {}",
                root.display()
            )));
        }
        std::fs::remove_dir_all(&root)?;
        if let Some(parent) = opt_out_marker().parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(opt_out_marker(), "");
        refresh_services_db();
        log::info!(
            target: "agentero::op",
            "op end finder_service_uninstall ok=true path={}",
            root.display()
        );
    }
    Ok(collect_status())
}

/// Install or refresh the Quick Action if absent or stale (app moved /
/// updated). Silent by design — the entry is user-level and removable from
/// Settings → About; a foreign workflow at the same path is left alone.
pub fn ensure_installed() {
    if !is_macos() || opted_out() {
        return;
    }
    let status = collect_status();
    if status.installed && status.current {
        return;
    }
    let root = workflow_root();
    if root.exists() && !is_ours(&root) {
        log::info!(
            target: "agentero::op",
            "finder_service ensure skipped: foreign workflow at {}",
            root.display()
        );
        return;
    }
    if let Err(e) = install() {
        log::warn!(target: "agentero::op", "finder_service ensure failed: {e}");
    }
}

/// Best-effort Services database refresh so the menu updates without logout.
fn refresh_services_db() {
    let _ = std::process::Command::new("/System/Library/CoreServices/pbs")
        .arg("-flush")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn build_wflow(bundle: &Path) -> String {
    // Bundles go through LaunchServices (`open`): proper Dock icon, focus, and
    // window session. `-n` ensures args reach the process even when the app is
    // already running — the second instance forwards argv via single-instance.
    // The dev raw-binary fallback keeps the flow testable from target/.
    let script = format!(
        "APP='{app}'\nfor f in \"$@\"; do\n  [ -d \"$f\" ] || continue\n  if [[ \"$APP\" == *.app ]]; then\n    open -n \"$APP\" --args \"$f\"\n  else\n    nohup \"$APP\" \"$f\" >/dev/null 2>&1 &\n  fi\ndone",
        app = bundle.to_string_lossy()
    );
    WFLOW_TEMPLATE.replace("__COMMAND_STRING__", &xml_escape(&script))
}

const INFO_PLIST: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>com.poco-ai.agentero.open-vault-service</string>
	<key>CFBundleName</key>
	<string>Open with Agentero</string>
	<key>CFBundlePackageType</key>
	<string>Wflow</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>NSServices</key>
	<array>
		<dict>
			<key>NSMenuItem</key>
			<dict>
				<key>default</key>
				<string>Open with Agentero</string>
			</dict>
			<key>NSMessage</key>
			<string>runWorkflowAsService</string>
			<key>NSRequiredContext</key>
			<dict/>
			<key>NSSendFileTypes</key>
			<array>
				<string>public.folder</string>
			</array>
		</dict>
	</array>
</dict>
</plist>
"#;

const WFLOW_TEMPLATE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AMApplicationBuild</key>
	<string>528</string>
	<key>AMApplicationVersion</key>
	<string>2.10</string>
	<key>AMDocumentVersion</key>
	<string>2</string>
	<key>actions</key>
	<array>
		<dict>
			<key>action</key>
			<dict>
				<key>AMAccepts</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Optional</key>
					<true/>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>AMActionVersion</key>
				<string>2.0.3</string>
				<key>AMApplication</key>
				<array>
					<string>Automator</string>
				</array>
				<key>AMParameterProperties</key>
				<dict>
					<key>COMMAND_STRING</key>
					<dict/>
					<key>CheckedForUserDefaultShell</key>
					<dict/>
					<key>inputMethod</key>
					<dict/>
					<key>shell</key>
					<dict/>
					<key>source</key>
					<dict/>
				</dict>
				<key>AMProvides</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>ActionBundlePath</key>
				<string>/System/Library/Automator/Run Shell Script.action</string>
				<key>ActionName</key>
				<string>Run Shell Script</string>
				<key>ActionParameters</key>
				<dict>
					<key>COMMAND_STRING</key>
					<string>__COMMAND_STRING__</string>
					<key>CheckedForUserDefaultShell</key>
					<true/>
					<key>inputMethod</key>
					<integer>1</integer>
					<key>shell</key>
					<string>/bin/zsh</string>
					<key>source</key>
					<string></string>
				</dict>
				<key>BundleIdentifier</key>
				<string>com.apple.RunShellScript</string>
				<key>CFBundleVersion</key>
				<string>2.0.3</string>
				<key>CanShowSelectedItemsWhenRun</key>
				<false/>
				<key>CanShowWhenRun</key>
				<true/>
				<key>Category</key>
				<array>
					<string>AMCategoryUtilities</string>
				</array>
				<key>Class Name</key>
				<string>RunShellScriptAction</string>
				<key>InputUUID</key>
				<string>3C2F6B4E-9A1D-4E7B-8F52-6D0A1B2C3D4E</string>
				<key>Keywords</key>
				<array>
					<string>Shell</string>
					<string>Script</string>
					<string>Command</string>
					<string>Run</string>
					<string>Unix</string>
				</array>
				<key>OutputUUID</key>
				<string>7E8F9A0B-1C2D-4E5F-9A6B-7C8D9E0F1A2B</string>
				<key>UUID</key>
				<string>B1A2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D</string>
				<key>UnlocalizedApplications</key>
				<array>
					<string>Automator</string>
				</array>
				<key>isViewVisible</key>
				<integer>1</integer>
				<key>location</key>
				<string>309.000000:683.000000</string>
				<key>nibPath</key>
				<string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/Base.lproj/main.nib</string>
			</dict>
			<key>isViewVisible</key>
			<integer>1</integer>
		</dict>
	</array>
	<key>connectors</key>
	<dict/>
	<key>workflowMetaData</key>
	<dict>
		<key>applicationBundleIDsByPath</key>
		<dict/>
		<key>applicationPaths</key>
		<array/>
		<key>inputTypeIdentifier</key>
		<string>com.apple.Automator.fileSystemObject</string>
		<key>outputTypeIdentifier</key>
		<string>com.apple.Automator.nothing</string>
		<key>presentationMode</key>
		<integer>15</integer>
		<key>processesInput</key>
		<integer>0</integer>
		<key>serviceInputTypeIdentifier</key>
		<string>com.apple.Automator.fileSystemObject</string>
		<key>serviceOutputTypeIdentifier</key>
		<string>com.apple.Automator.nothing</string>
		<key>serviceProcessesInput</key>
		<integer>0</integer>
		<key>systemImageName</key>
		<string>NSActionTemplate</string>
		<key>useAutomaticInputType</key>
		<integer>0</integer>
		<key>workflowTypeIdentifier</key>
		<string>com.apple.Automator.servicesMenu</string>
	</dict>
</dict>
</plist>
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workflow_root_is_in_user_services() {
        let root = workflow_root();
        assert!(root.ends_with(format!("{WORKFLOW_NAME}.workflow")));
        assert!(root.to_string_lossy().contains("Library/Services"));
    }

    #[test]
    fn wflow_bakes_and_recovers_bundle_path() {
        let dir = std::env::temp_dir().join(format!("agentero-finder-svc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("Contents")).unwrap();
        let bundle = dir.join("Agentero.app");
        std::fs::write(
            dir.join("Contents").join("document.wflow"),
            build_wflow(&bundle),
        )
        .unwrap();
        std::fs::write(dir.join("Contents").join("Info.plist"), INFO_PLIST).unwrap();
        assert!(is_ours(&dir));
        assert_eq!(baked_bundle_path(&dir), Some(bundle));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_foreign_workflow() {
        let dir = std::env::temp_dir().join(format!(
            "agentero-finder-svc-foreign-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("Contents")).unwrap();
        std::fs::write(dir.join("Contents").join("Info.plist"), "<plist/>").unwrap();
        assert!(!is_ours(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn xml_escape_covers_script_specials() {
        assert_eq!(xml_escape("a & b < c > d"), "a &amp; b &lt; c &gt; d");
    }
}
