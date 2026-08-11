//! Application assembly: plugins, managed state, setup, and event wiring.

mod handlers;
mod logging;
pub mod menu;

use crate::features::agent::{AgentRegistry, AgentRunController};
#[cfg(not(target_os = "ios"))]
use crate::features::connector::ConnectorController;
#[cfg(not(target_os = "ios"))]
use crate::features::remote::RemoteRegistry;
use crate::features::settings::AppSettingsStore;
#[cfg(not(target_os = "ios"))]
use crate::features::watcher::FsWatchController;
use crate::features::wiki::{ExternalRenameRepairStore, WikiIndexState};
#[cfg(not(target_os = "ios"))]
use std::sync::Arc;
#[cfg(not(target_os = "ios"))]
use tauri::Emitter;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Both ring and aws-lc-rs backends exist in the dependency tree; rustls
    // panics at connect time unless a process-wide default is installed.
    let _ = rustls::crypto::ring::default_provider().install_default();
    // Persist panics for the next-launch diagnostics report (no-op without a
    // compiled-in telemetry endpoint).
    crate::features::telemetry::install_panic_hook();
    let mut builder = tauri::Builder::default();

    // Single-instance must be the first plugin so second-instance argv (deep
    // links on Windows/Linux) is forwarded before other plugins run.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            crate::features::open_request::handle_argv_urls(app, &argv);
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }));
    }

    builder = builder
        .register_asynchronous_uri_scheme_protocol("agentero-arxiv", |_ctx, request, responder| {
            crate::features::arxiv_proxy::handle(request, responder);
        })
        .register_asynchronous_uri_scheme_protocol("agentero-model", |_ctx, request, responder| {
            crate::features::layout_model::handle_model_uri(request, responder);
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(logging::build_log_plugin().build());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }

    #[cfg(not(target_os = "ios"))]
    {
        builder = builder.plugin(tauri_plugin_shell::init());
    }

    builder = builder
        .manage(AppSettingsStore::load())
        .manage(AgentRegistry::load())
        .manage(AgentRunController::new())
        .manage(crate::features::agent::AgentWarmGate::new())
        .manage(crate::features::agent::PermissionGate::new())
        .manage(crate::features::agent::ElicitationGate::new())
        .manage(crate::features::agent::AskUserGate::new())
        .manage(crate::features::bridge::BridgeController::new())
        .manage(crate::features::bridge::BridgeClientController::new())
        .manage(crate::features::jobs::JobCenter::new())
        .manage(crate::features::catalog::CapsCache::new())
        .manage(WikiIndexState::new())
        .manage(crate::features::doctor::DoctorDirtyPathsState::default())
        .manage(ExternalRenameRepairStore::new())
        .manage(crate::features::open_request::PendingVaultOpen::new());

    #[cfg(not(target_os = "ios"))]
    {
        builder = builder
            .manage(FsWatchController::new())
            .manage(Arc::new(ConnectorController::new()))
            .manage(Arc::new(RemoteRegistry::new()));
    }

    builder = handlers::attach_handlers(builder);

    #[cfg(not(target_os = "ios"))]
    {
        builder = builder.on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                // The HTML boot shell is ready now; reveal it while React hydrates.
                // On Linux/GTK, calling show() on an already-visible window can
                // corrupt the native titlebar hit-test (buttons become dead until
                // a resize/double-click). Only show if currently hidden.
                let win = webview.window();
                if !win.is_visible().unwrap_or(false) {
                    let _ = win.show();
                }
            }
        });
    }

    builder = builder.setup(|app| {
        let settings_store = app.state::<AppSettingsStore>();
        let agents = app.state::<AgentRegistry>();
        let mut settings = settings_store
            .get()
            .map(|result| result.settings)
            .unwrap_or_default();
        // Migrate the old Agent-only proxy once into the shared network setting.
        if !settings.network_proxy_enabled {
            if let Ok((enabled, url)) = agents.proxy_settings() {
                if enabled {
                    settings.network_proxy_enabled = true;
                    settings.network_proxy_url = url;
                    let _ = settings_store.set(settings.clone());
                }
            }
        }
        crate::features::network::configure_proxy(
            settings.network_proxy_enabled,
            &settings.network_proxy_url,
        )?;
        let _ = agents.set_proxy(
            settings.network_proxy_enabled,
            settings.network_proxy_url.clone(),
        );
        // Prefetch PP-DocLayoutV3 into XDG as fixed background-task id
        // (`layout-model`); frontend maps `layout-model:task` into the panel.
        crate::features::layout_model::spawn_background_download(app.handle().clone());
        // Native menu is macOS-only; the renderer re-syncs the locale on mount.
        #[cfg(target_os = "macos")]
        {
            let menu = menu::build_menu(app.handle(), "en")?;
            app.set_menu(menu)?;
        }
        // Ensure registry is loaded early.
        let _ = app.state::<AgentRegistry>();
        let _ = app.state::<WikiIndexState>();
        let _ = app.state::<crate::features::doctor::DoctorDirtyPathsState>();
        let _ = app.state::<ExternalRenameRepairStore>();
        #[cfg(not(target_os = "ios"))]
        {
            let connector = app.state::<Arc<ConnectorController>>();
            connector.set_app_handle(app.handle().clone());
            let remote = app.state::<Arc<RemoteRegistry>>();
            connector.set_remote_registry(Arc::clone(&remote));
        }
        log::info!(
            target: "agentero::op",
            "op start app_ready debug={}",
            cfg!(debug_assertions)
        );
        crate::features::telemetry::commands::spawn_startup_report(app.handle().clone());

        // Desktop deep links: cold start + runtime open URLs.
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        {
            use tauri_plugin_deep_link::DeepLinkExt;
            // Linux / Windows dev: associate schemes with the current executable.
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            {
                if let Err(e) = app.deep_link().register_all() {
                    log::warn!(target: "agentero::op", "deep_link register_all failed: {e}");
                }
            }
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                let list: Vec<String> = urls.into_iter().map(|u| u.to_string()).collect();
                crate::features::open_request::handle_deep_link_urls(app.handle(), &list);
            }
            // Dev / direct spawn: CLI may pass agentero://… as argv when the
            // OS scheme is not registered (common with `tauri dev`).
            let argv: Vec<String> = std::env::args().collect();
            crate::features::open_request::handle_argv_urls(app.handle(), &argv);
            // Consume a request file left by `agentero open` before we listened.
            if let Some(path) = crate::features::open_request::take_cli_open_request_file() {
                let _ = crate::features::open_request::handle_open_path(app.handle(), &path);
            }
            crate::features::open_request::spawn_cli_open_request_watcher(app.handle().clone());
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let list: Vec<String> = event.urls().into_iter().map(|u| u.to_string()).collect();
                crate::features::open_request::handle_deep_link_urls(&handle, &list);
            });
        }

        Ok(())
    });

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        builder = builder.on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == "close_tab_or_window" {
                // Cmd+W is app-global on macOS. When Settings is focused, close
                // that native window instead of forwarding the command to the
                // main renderer, where it would close the active document tab.
                if let Some(settings) =
                    app.get_webview_window(crate::features::window::commands::SETTINGS_WINDOW_LABEL)
                {
                    if settings.is_focused().unwrap_or(false) {
                        let _ = settings.close();
                        return;
                    }
                }
            }
            if id == "new_window" {
                // `window_new` is async so webview creation never runs inside this
                // main-thread menu callback (see its doc comment).
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = crate::features::window::commands::window_new(app).await {
                        log::error!(target: "agentero::op", "op end window_new ok=false error={e}");
                    }
                });
                return;
            }
            let _ = app.emit(id, ());
        });
    }

    #[cfg(not(target_os = "ios"))]
    {
        builder = builder.on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window.state::<FsWatchController>().stop(window.label());
                if window.label() == crate::features::window::commands::SETTINGS_WINDOW_LABEL {
                    let _ = window.app_handle().emit("settings_window_closed", ());
                }
                if let Some(view) =
                    crate::features::window::commands::feature_view_from_label(window.label())
                {
                    let _ = window
                        .app_handle()
                        .emit("feature_window_closed", serde_json::json!({ "view": view }));
                }
            }
        });
    }

    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            let _ = &app;
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                #[cfg(not(target_os = "ios"))]
                app.state::<Arc<ConnectorController>>().stop();
            }
            // ExitRequested can be cancelled, so only the final Exit marks the
            // session end for the next-launch telemetry report.
            if matches!(event, tauri::RunEvent::Exit) {
                crate::features::telemetry::commands::record_exit(app);
            }
        });
}
