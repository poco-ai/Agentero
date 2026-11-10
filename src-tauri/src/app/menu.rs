//! Native application menu (macOS) and locale labels.

#[cfg(target_os = "macos")]
use crate::features::system::settings::AppSettingsStore;
#[cfg(any(target_os = "macos", test))]
use crate::features::system::settings::ShortcutBinding;
#[cfg(target_os = "macos")]
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder, WINDOW_SUBMENU_ID};
#[cfg(target_os = "macos")]
use tauri::Manager;

#[cfg(target_os = "macos")]
#[derive(Default)]
struct NativeMenuState {
    inner: std::sync::Mutex<NativeMenuConfig>,
}

#[cfg(target_os = "macos")]
#[derive(Default)]
struct NativeMenuConfig {
    locale: String,
    recording_windows: std::collections::HashSet<String>,
}

#[cfg(any(target_os = "macos", test))]
fn menu_shortcut(id: &str) -> Option<(&'static str, &'static str)> {
    Some(match id {
        "settings" => ("settings", "CmdOrCtrl+,"),
        "new_window" => ("newWindow", "CmdOrCtrl+N"),
        "open_vault" => ("openVault", "CmdOrCtrl+O"),
        "create_vault" => ("createVault", "CmdOrCtrl+Shift+N"),
        "refresh_tree" => ("refreshTree", "CmdOrCtrl+R"),
        "close_tab_or_window" => ("closeTab", "CmdOrCtrl+W"),
        "toggle_sidebar" => ("toggleSidebar", "CmdOrCtrl+Alt+S"),
        "split_pane" => ("splitPane", "CmdOrCtrl+\\"),
        "toggle_chat" => ("toggleChat", "CmdOrCtrl+L"),
        _ => return None,
    })
}

#[cfg(any(target_os = "macos", test))]
fn is_function_key(key: &str) -> bool {
    key.strip_prefix('F')
        .and_then(|n| n.parse::<u8>().ok())
        .is_some_and(|n| (1..=24).contains(&n) && key == format!("F{n}"))
}

/// Mirrors the macOS rules in validateShortcutBinding for menu-owned commands.
#[cfg(any(target_os = "macos", test))]
fn valid_menu_binding(binding: &ShortcutBinding) -> bool {
    let meta = binding.meta.unwrap_or(false);
    let ctrl = binding.ctrl.unwrap_or(false);
    let alt = binding.alt.unwrap_or(false);
    let shift = binding.shift.unwrap_or(false);
    let key = binding.key.as_str();
    if key.chars().any(|ch| ch.is_whitespace() || ch.is_control()) {
        return false;
    }
    if !meta && !ctrl && !alt && key != "Escape" && !is_function_key(key) {
        return false;
    }
    if meta && !ctrl && !alt {
        let reserved: &[&str] = if shift {
            &["z", "s", "q"]
        } else {
            &[
                "a", "c", "x", "v", "z", "f", "g", "s", "b", "i", "u", "q", "h", "m",
            ]
        };
        if reserved.contains(&key.to_ascii_lowercase().as_str()) {
            return false;
        }
    }
    if meta && (key == "Tab" || (alt && key == "Escape")) {
        return false;
    }
    if meta && ctrl && !alt && !shift && key.eq_ignore_ascii_case("f") {
        return false;
    }
    true
}

/// Convert valid DOM chords to the physical key names accepted by Tauri's accelerator parser.
#[cfg(any(target_os = "macos", test))]
fn binding_accelerator(binding: &ShortcutBinding) -> Option<String> {
    if !valid_menu_binding(binding) {
        return None;
    }
    let mut shift = binding.shift.unwrap_or(false);
    let key = match binding.key.as_str() {
        // Shifted punctuation must use its base key, not the literal DOM key.
        key if key.len() == 1 => {
            let ch = key.chars().next()?;
            if let Some(index) = "~!@#$%^&*()_+{}|:\"<>?".find(ch) {
                shift = true;
                "`1234567890-=[]\\;',./".chars().nth(index)?.to_string()
            } else if ch.is_ascii_alphanumeric() || "`-=[]\\;',./".contains(ch) {
                ch.to_ascii_uppercase().to_string()
            } else {
                return None;
            }
        }
        key @ ("Escape" | "Enter" | "Tab" | "Backspace" | "Delete" | "Insert" | "Home" | "End"
        | "PageUp" | "PageDown" | "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown") => {
            key.to_string()
        }
        key if is_function_key(key) => key.to_string(),
        _ => return None,
    };
    let mut parts = Vec::new();
    if binding.ctrl.unwrap_or(false) {
        parts.push("Ctrl");
    }
    if binding.alt.unwrap_or(false) {
        parts.push("Alt");
    }
    if shift {
        parts.push("Shift");
    }
    if binding.meta.unwrap_or(false) {
        parts.push("Super");
    }
    parts.push(&key);
    Some(parts.join("+"))
}

#[cfg(any(target_os = "macos", test))]
fn menu_accelerator(
    id: &str,
    overrides: &std::collections::HashMap<String, Option<ShortcutBinding>>,
) -> Option<String> {
    let (shortcut, default) = menu_shortcut(id)?;
    match overrides.get(shortcut) {
        Some(Some(binding))
            if binding.alt.unwrap_or(false)
                && !binding.meta.unwrap_or(false)
                && !binding.ctrl.unwrap_or(false) =>
        {
            None
        }
        Some(Some(binding)) => binding_accelerator(binding),
        Some(None) => None,
        None => Some(default.to_string()),
    }
}

/// Broadcast when a native menu item is clicked; payload `{ action: <menu id> }`.
/// Wire naming follows docs/architecture.md (`domain:event`);
/// this is a request/command signal, not a lifecycle fact event.
pub const MENU_INVOKED_EVENT: &str = "menu:invoked";

/// Labels for the native application menu.
#[cfg(target_os = "macos")]
pub struct MenuLabels {
    pub settings: &'static str,
    pub new_window: &'static str,
    pub open_vault: &'static str,
    pub create_vault: &'static str,
    pub refresh_tree: &'static str,
    pub close: &'static str,
    pub toggle_sidebar: &'static str,
    pub split_pane: &'static str,
    pub toggle_chat: &'static str,
    pub toggle_fullscreen: &'static str,
    pub app: &'static str,
    pub file: &'static str,
    pub edit: &'static str,
    pub view: &'static str,
    pub window: &'static str,
}

#[cfg(target_os = "macos")]
const EN: MenuLabels = MenuLabels {
    settings: "Settings…",
    new_window: "New Window",
    open_vault: "Open Vault…",
    create_vault: "Create Vault…",
    refresh_tree: "Refresh File Tree",
    // Closes the active document tab first; with no tabs, closes the window.
    close: "Close",
    toggle_sidebar: "Toggle Sidebar",
    split_pane: "Split Pane Right",
    toggle_chat: "Toggle Chat",
    toggle_fullscreen: "Toggle Full Screen",
    app: "Agentero",
    file: "File",
    edit: "Edit",
    view: "View",
    window: "Window",
};

#[cfg(target_os = "macos")]
const ZH_CN: MenuLabels = MenuLabels {
    settings: "设置…",
    new_window: "新建窗口",
    open_vault: "打开知识库…",
    create_vault: "创建知识库…",
    refresh_tree: "刷新文件树",
    close: "关闭",
    toggle_sidebar: "切换侧边栏",
    split_pane: "向右分栏",
    toggle_chat: "切换对话",
    toggle_fullscreen: "切换全屏",
    app: "Agentero",
    file: "文件",
    edit: "编辑",
    view: "视图",
    window: "窗口",
};

/// Return the menu label set for a locale, falling back to English.
#[cfg(target_os = "macos")]
pub fn menu_labels(lang: &str) -> &'static MenuLabels {
    match lang {
        "zh-CN" | "zh" => &ZH_CN,
        _ => &EN,
    }
}

#[cfg(target_os = "macos")]
pub fn build_menu(
    app: &tauri::AppHandle,
    lang: &str,
) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let settings = app
        .state::<AppSettingsStore>()
        .get()
        .map_err(|error| tauri::Error::Anyhow(error.into()))?
        .settings;
    let state = app.state::<NativeMenuState>();
    let recording = !state
        .inner
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .recording_windows
        .is_empty();
    // Predefined editing/quit/fullscreen items also consume keys before WebKit.
    if recording {
        return MenuBuilder::new(app).build();
    }
    let labels = menu_labels(lang);
    let item = |id: &str, label: &str| {
        let mut builder = MenuItemBuilder::with_id(id, label);
        if let Some(accelerator) = menu_accelerator(id, &settings.shortcut_overrides) {
            builder = builder.accelerator(accelerator);
        }
        builder.build(app)
    };
    let settings = item("settings", labels.settings)?;
    let new_window = item("new_window", labels.new_window)?;
    let open_vault = item("open_vault", labels.open_vault)?;
    let create_vault = item("create_vault", labels.create_vault)?;
    let refresh_tree = item("refresh_tree", labels.refresh_tree)?;
    // Smart Close goes through the renderer rather than CloseWindow.
    let close = item("close_tab_or_window", labels.close)?;
    let toggle_sidebar = item("toggle_sidebar", labels.toggle_sidebar)?;
    let split_pane = item("split_pane", labels.split_pane)?;
    let toggle_chat = item("toggle_chat", labels.toggle_chat)?;

    let app_submenu = SubmenuBuilder::new(app, labels.app)
        .about(None)
        .separator()
        .item(&settings)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file_submenu = SubmenuBuilder::new(app, labels.file)
        .item(&new_window)
        .separator()
        .item(&open_vault)
        .item(&create_vault)
        .item(&refresh_tree)
        .separator()
        .item(&close)
        .build()?;

    // Required so text fields keep standard edit shortcuts after custom menu is set.
    let edit_submenu = SubmenuBuilder::new(app, labels.edit)
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let view_submenu = SubmenuBuilder::new(app, labels.view)
        .item(&toggle_sidebar)
        .item(&split_pane)
        .item(&toggle_chat)
        .separator()
        .fullscreen_with_text(labels.toggle_fullscreen)
        .build()?;

    let window_submenu = SubmenuBuilder::with_id(app, WINDOW_SUBMENU_ID, labels.window)
        .minimize()
        .maximize()
        .build()?;

    MenuBuilder::new(app)
        .item(&app_submenu)
        .item(&file_submenu)
        .item(&edit_submenu)
        .item(&view_submenu)
        .item(&window_submenu)
        .build()
}

#[cfg(target_os = "macos")]
fn refresh_menu(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<NativeMenuState>();
    let locale = state
        .inner
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .locale
        .clone();
    let menu = build_menu(app, &locale).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

/// Install the menu and react to persisted settings without coupling the settings store to menus.
#[cfg(target_os = "macos")]
pub fn setup(app: &tauri::AppHandle) -> Result<(), String> {
    let settings = app
        .state::<AppSettingsStore>()
        .get()
        .map_err(|e| e.to_string())?
        .settings;
    app.manage(NativeMenuState {
        inner: std::sync::Mutex::new(NativeMenuConfig {
            locale: settings.locale,
            ..Default::default()
        }),
    });
    refresh_menu(app)?;
    let handle = app.clone();
    app.state::<AppSettingsStore>().subscribe(move |_| {
        let app = handle.clone();
        if let Err(error) = handle.run_on_main_thread(move || {
            // Read the latest snapshot here so concurrent saves cannot install stale shortcuts.
            if let Ok(result) = app.state::<AppSettingsStore>().get() {
                if result.settings.locale != "system" {
                    app.state::<NativeMenuState>()
                        .inner
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .locale = result.settings.locale;
                }
            }
            if let Err(error) = refresh_menu(&app) {
                log::error!("Failed to refresh native menu: {error}");
            }
        }) {
            log::error!("Failed to schedule native menu refresh: {error}");
        }
    });
    Ok(())
}

/// A destroyed recorder window must not leave application accelerators suspended.
#[cfg(target_os = "macos")]
pub fn release_window(app: &tauri::AppHandle, label: &str) {
    let removed = app
        .state::<NativeMenuState>()
        .inner
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .recording_windows
        .remove(label);
    if removed {
        if let Err(error) = refresh_menu(app) {
            log::error!("Failed to restore native menu: {error}");
        }
    }
}

/// Suspend all native accelerators until the calling window finishes recording.
/// Other platforms have no native menu and need only the renderer recording guard.
#[tauri::command]
#[specta::specta]
pub fn set_menu_shortcut_recording(
    window: tauri::WebviewWindow,
    recording: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let app = window.app_handle();
        {
            let state = app.state::<NativeMenuState>();
            let mut config = state.inner.lock().unwrap_or_else(|e| e.into_inner());
            if recording {
                config.recording_windows.insert(window.label().to_string());
            } else {
                config.recording_windows.remove(window.label());
            }
        }
        refresh_menu(app)?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (&window, recording);
    Ok(())
}

/// Rebuild the menu with the renderer-resolved locale, including system language.
#[tauri::command]
#[specta::specta]
pub fn set_locale(app: tauri::AppHandle, locale: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        app.state::<NativeMenuState>()
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .locale = locale;
        refresh_menu(&app)?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (&app, &locale);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn binding(key: &str) -> ShortcutBinding {
        ShortcutBinding {
            key: key.into(),
            meta: Some(true),
            ..Default::default()
        }
    }

    #[test]
    fn overrides_replace_and_disable_native_defaults() {
        let mut overrides = HashMap::new();
        assert_eq!(
            menu_accelerator("new_window", &overrides).as_deref(),
            Some("CmdOrCtrl+N")
        );
        overrides.insert("newWindow".into(), Some(binding("j")));
        assert_eq!(
            menu_accelerator("new_window", &overrides).as_deref(),
            Some("Super+J")
        );
        overrides.insert("newWindow".into(), None);
        assert_eq!(menu_accelerator("new_window", &overrides), None);
        overrides.insert("closeTab".into(), Some(binding("Escape")));
        assert_eq!(
            menu_accelerator("close_tab_or_window", &overrides).as_deref(),
            Some("Super+Escape")
        );
        assert_eq!(menu_accelerator("unknown", &overrides), None);
    }

    #[test]
    fn converts_modifiers_and_dom_special_keys() {
        let mut chord = binding("ArrowLeft");
        chord.ctrl = Some(true);
        chord.alt = Some(true);
        chord.shift = Some(true);
        assert_eq!(
            binding_accelerator(&chord).as_deref(),
            Some("Ctrl+Alt+Shift+Super+ArrowLeft")
        );
        for (key, expected) in [
            ("\\", "Super+\\"),
            ("F12", "Super+F12"),
            ("+", "Shift+Super+="),
            ("?", "Shift+Super+/"),
            ("|", "Shift+Super+\\"),
            ("{", "Shift+Super+["),
        ] {
            assert_eq!(
                binding_accelerator(&binding(key)).as_deref(),
                Some(expected)
            );
        }
        for key in ["Escape", "F1", "F24"] {
            assert_eq!(
                binding_accelerator(&ShortcutBinding {
                    key: key.into(),
                    ..Default::default()
                })
                .as_deref(),
                Some(key)
            );
        }
    }

    #[test]
    fn rejects_unmodified_typing_and_navigation_chords() {
        for key in ["j", "1", ",", "Enter", "Tab", "ArrowLeft", "Backspace"] {
            for shift in [false, true] {
                let chord = ShortcutBinding {
                    key: key.into(),
                    shift: Some(shift),
                    ..Default::default()
                };
                assert_eq!(binding_accelerator(&chord), None, "{chord:?}");
            }
        }
        for key in [" ", "\t", "\n", "\u{7f}"] {
            assert_eq!(binding_accelerator(&binding(key)), None);
        }
    }

    #[test]
    fn reserved_native_chords_disable_persisted_menu_overrides() {
        let mut chords = Vec::new();
        for key in [
            "a", "c", "x", "v", "z", "f", "g", "s", "b", "i", "u", "q", "h", "m",
        ] {
            chords.push(binding(key));
            chords.push(binding(&key.to_ascii_uppercase()));
        }
        for key in ["z", "s", "q"] {
            chords.push(ShortcutBinding {
                shift: Some(true),
                ..binding(key)
            });
        }
        for key in ["Tab", " "] {
            for ctrl in [false, true] {
                for alt in [false, true] {
                    for shift in [false, true] {
                        chords.push(ShortcutBinding {
                            ctrl: Some(ctrl),
                            alt: Some(alt),
                            shift: Some(shift),
                            ..binding(key)
                        });
                    }
                }
            }
        }
        for ctrl in [false, true] {
            for shift in [false, true] {
                chords.push(ShortcutBinding {
                    ctrl: Some(ctrl),
                    alt: Some(true),
                    shift: Some(shift),
                    ..binding("Escape")
                });
            }
        }
        chords.push(ShortcutBinding {
            ctrl: Some(true),
            ..binding("f")
        });
        for chord in chords {
            assert_eq!(binding_accelerator(&chord), None, "{chord:?}");
            let overrides = HashMap::from([("settings".into(), Some(chord))]);
            assert_eq!(menu_accelerator("settings", &overrides), None);
        }
    }

    #[test]
    fn allows_non_reserved_modifier_variants() {
        for (chord, expected) in [
            (binding("j"), "Super+J"),
            (
                ShortcutBinding {
                    meta: None,
                    ctrl: Some(true),
                    ..binding("j")
                },
                "Ctrl+J",
            ),
            (
                ShortcutBinding {
                    meta: None,
                    alt: Some(true),
                    ..binding("j")
                },
                "Alt+J",
            ),
            (
                ShortcutBinding {
                    shift: Some(true),
                    ..binding("c")
                },
                "Shift+Super+C",
            ),
            (
                ShortcutBinding {
                    alt: Some(true),
                    ..binding("s")
                },
                "Alt+Super+S",
            ),
            (
                ShortcutBinding {
                    ctrl: Some(true),
                    ..binding("q")
                },
                "Ctrl+Super+Q",
            ),
            (
                ShortcutBinding {
                    meta: None,
                    alt: Some(true),
                    ..binding("Tab")
                },
                "Alt+Tab",
            ),
            (
                ShortcutBinding {
                    meta: None,
                    alt: Some(true),
                    ..binding("F4")
                },
                "Alt+F4",
            ),
        ] {
            assert_eq!(
                binding_accelerator(&chord).as_deref(),
                Some(expected),
                "{chord:?}"
            );
        }
    }

    #[test]
    fn unsupported_keys_never_reactivate_the_old_accelerator() {
        for key in ["", "Meta", "Unidentified", "é", "F25", "F01", "Super+Q"] {
            assert_eq!(binding_accelerator(&binding(key)), None);
            let overrides = HashMap::from([("settings".into(), Some(binding(key)))]);
            assert_eq!(menu_accelerator("settings", &overrides), None);
        }
    }
}
