mod commands;
/// Shared error types (used by Host commands and the headless CLI).
pub mod error;
#[cfg(target_os = "macos")]
mod i18n;
/// Operation start/end helpers (`docs/development/logging.md`).
mod log_util;
mod models;
/// Domain services (Vault / Catalog / Lookup / Wiki / …).
/// The CLI path-depends on this crate and may `use agentero_lib::services::{vault,catalog,…}`;
/// it must **not** use `services::agent` (BYOA is desktop-only).
pub mod services;

#[cfg(target_os = "macos")]
use i18n::menu_labels;
use services::agent::{AgentRegistry, AgentRunController};
use services::app_settings::AppSettingsStore;
use services::connector::ConnectorController;
use services::remote::RemoteRegistry;
use services::watcher::FsWatchController;
use services::wiki::WikiIndexState;
use std::sync::Arc;
#[cfg(target_os = "macos")]
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager};

#[cfg(target_os = "macos")]
fn build_menu(app: &tauri::AppHandle, lang: &str) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let labels = menu_labels(lang);

    // Appears under the app name menu on macOS (e.g. "Agentero").
    let settings = MenuItemBuilder::with_id("settings", labels.settings)
        .accelerator("CmdOrCtrl+,")
        .build(app)?;

    let new_window = MenuItemBuilder::with_id("new_window", labels.new_window)
        .accelerator("CmdOrCtrl+N")
        .build(app)?;

    let open_vault = MenuItemBuilder::with_id("open_vault", labels.open_vault)
        .accelerator("CmdOrCtrl+O")
        .build(app)?;

    let create_vault = MenuItemBuilder::with_id("create_vault", labels.create_vault)
        .accelerator("CmdOrCtrl+Shift+N")
        .build(app)?;

    let refresh_tree = MenuItemBuilder::with_id("refresh_tree", labels.refresh_tree)
        .accelerator("CmdOrCtrl+R")
        .build(app)?;

    // Smart Close (⌘W): frontend closes the active tab first; with no tabs, closes the window.
    // Must not use PredefinedMenuItem::CloseWindow — that would steal ⌘W before the renderer.
    let close = MenuItemBuilder::with_id("close_tab_or_window", labels.close)
        .accelerator("CmdOrCtrl+W")
        .build(app)?;

    let toggle_sidebar = MenuItemBuilder::with_id("toggle_sidebar", labels.toggle_sidebar)
        .accelerator("CmdOrCtrl+Alt+S")
        .build(app)?;

    let toggle_chat = MenuItemBuilder::with_id("toggle_chat", labels.toggle_chat)
        .accelerator("CmdOrCtrl+L")
        .build(app)?;

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
        .item(&toggle_chat)
        .build()?;

    let window_submenu = SubmenuBuilder::new(app, labels.window)
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

/// Rebuild and install the native application menu for the given locale.
/// macOS-only: other platforms have no native window menu (actions live in the
/// React title bar + keyboard shortcuts), so this is a no-op there.
#[tauri::command]
fn set_locale(app: tauri::AppHandle, locale: String) -> Result<(), error::AppError> {
    #[cfg(target_os = "macos")]
    {
        let menu =
            build_menu(&app, &locale).map_err(|e| error::AppError::internal(e.to_string()))?;
        app.set_menu(menu)
            .map_err(|e| error::AppError::internal(e.to_string()))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&app, &locale);
    }
    Ok(())
}

fn build_log_plugin() -> tauri_plugin_log::Builder {
    use tauri_plugin_log::{Target, TargetKind};

    let default_level = if cfg!(debug_assertions) {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    };
    let agent_level = if cfg!(debug_assertions) {
        log::LevelFilter::Trace
    } else {
        log::LevelFilter::Info
    };

    let mut builder = tauri_plugin_log::Builder::new()
        .level(default_level)
        .level_for("agentero_lib::services::agent", agent_level)
        .level_for("agentero::op", log::LevelFilter::Info)
        .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
        .max_file_size(5_000_000)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
        .clear_targets()
        .target(Target::new(TargetKind::Stdout))
        .target(Target::new(TargetKind::LogDir {
            file_name: Some("agentero".into()),
        }));

    // Dev: also mirror into the webview console (frontend calls attachConsole).
    if cfg!(debug_assertions) {
        builder = builder.target(Target::new(TargetKind::Webview));
    }

    builder
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(build_log_plugin().build())
        .manage(AppSettingsStore::load())
        .manage(AgentRegistry::load())
        .manage(AgentRunController::new())
        .manage(services::agent::PermissionGate::new())
        .manage(WikiIndexState::new())
        .manage(FsWatchController::new())
        .manage(Arc::new(ConnectorController::new()))
        .manage(Arc::new(RemoteRegistry::new()))
        .invoke_handler(tauri::generate_handler![
            commands::settings::settings_get,
            commands::settings::settings_set,
            commands::settings::settings_path,
            commands::settings::host_identity,
            commands::agent::agent_list_agents,
            commands::agent::agent_list_templates,
            commands::agent::agent_list_skills,
            commands::agent::agent_scan_catalog,
            commands::agent::agent_upsert_agent,
            commands::agent::agent_ensure_catalog,
            commands::agent::agent_remove_agent,
            commands::agent::agent_set_default,
            commands::agent::agent_set_enabled,
            commands::agent::agent_set_proxy,
            commands::agent::agent_discover,
            commands::agent::agent_probe,
            commands::agent::agent_probe_catalog,
            commands::agent::agent_open_install_terminal,
            commands::agent::agent_run_once,
            commands::agent::agent_list_sessions,
            commands::agent::agent_load_session,
            commands::agent::agent_cancel_run,
            commands::agent::agent_respond_permission,
            commands::agent::agent_warm,
            commands::graph::graph_get_backlinks,
            commands::graph::graph_get_graph,
            commands::graph::graph_rebuild,
            commands::vault::vault_create,
            commands::vault::vault_ensure,
            commands::vault::vault_authorize,
            commands::remote::remote_connect,
            commands::remote::remote_disconnect,
            commands::remote::remote_status,
            commands::remote::remote_vault_ensure,
            commands::remote::remote_list,
            commands::remote::remote_stat,
            commands::remote::remote_read_text,
            commands::remote::remote_write_text,
            commands::remote::remote_read_bytes,
            commands::remote::remote_mkdir,
            commands::remote::remote_remove,
            commands::remote::remote_write_bytes,
            commands::remote::remote_paper_list,
            commands::remote::remote_paper_get,
            commands::remote::remote_paper_delete,
            commands::remote::remote_paper_rescan,
            commands::remote::remote_paper_set_tags,
            commands::remote::remote_paper_set_is_read,
            commands::remote::remote_cache_file,
            commands::remote::remote_cache_stats,
            commands::remote::remote_cache_clear,
            commands::remote::remote_agent_discover,
            commands::remote::remote_agent_scan,
            commands::remote::remote_agent_probe,
            commands::remote::remote_agent_open_install_terminal,
            commands::remote::remote_host_identity,
            commands::terminal::path_open_in_terminal,
            commands::trash::path_trash,
            commands::trash::path_untrash,
            commands::trash::path_list_trash,
            commands::trash::path_restore_item,
            commands::trash::path_purge_item,
            commands::trash::path_purge_trash,
            commands::window::window_new,
            commands::window::settings_window_open,
            commands::translate::translate_text,
            commands::lookup::lookup_import,
            commands::lookup::lookup_translator_config,
            commands::lookup::paper_download_assets,
            commands::lookup::paper_import_local_pdf,
            commands::lookup::paper_stage_import_file,
            commands::lookup::paper_parse_body,
            commands::lookup::paper_export,
            commands::lookup::paper_import,
            commands::paper::paper_get,
            commands::paper::paper_list,
            commands::paper::paper_delete,
            commands::paper::paper_move,
            commands::paper::paper_set_is_read,
            commands::paper::paper_set_tags,
            commands::paper::paper_rescan,
            commands::search::vault_search,
            commands::zotero::zotero_scan,
            commands::zotero::zotero_migrate,
            commands::watcher::fs_watch_start,
            commands::watcher::fs_watch_stop,
            commands::connector::connector_get_status,
            commands::connector::connector_set_enabled,
            commands::connector::connector_set_vault,
            commands::connector::connector_set_parent_dir,
            commands::connector::connector_set_port,
            set_locale,
        ])
        .setup(|app| {
            // Non-macOS windows are frameless (custom caption buttons in React);
            // strip native decorations before the window is shown to avoid a flash.
            #[cfg(not(target_os = "macos"))]
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_decorations(false);
            }
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
            }
            // Native menu is macOS-only; the renderer re-syncs the locale on mount.
            #[cfg(target_os = "macos")]
            {
                let menu = build_menu(app.handle(), "en")?;
                app.set_menu(menu)?;
            }
            // Ensure registry is loaded early.
            let _ = app.state::<AgentRegistry>();
            let _ = app.state::<WikiIndexState>();
            let connector = app.state::<Arc<ConnectorController>>();
            connector.set_app_handle(app.handle().clone());
            let remote = app.state::<Arc<RemoteRegistry>>();
            connector.set_remote_registry(Arc::clone(&remote));
            log::info!(
                target: "agentero::op",
                "op start app_ready debug={}",
                cfg!(debug_assertions)
            );
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == "new_window" {
                if let Err(e) = commands::window::window_new(app.clone()) {
                    log::error!(target: "agentero::op", "op end window_new ok=false error={e}");
                }
                return;
            }
            let _ = app.emit(id, ());
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window.state::<FsWatchController>().stop(window.label());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                app.state::<Arc<ConnectorController>>().stop();
            }
        });
}
