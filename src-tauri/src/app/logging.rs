//! Tauri log plugin configuration.

pub fn build_log_plugin() -> tauri_plugin_log::Builder {
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
        .level_for("agentero_lib::features::agent", agent_level)
        .level_for("agentero::op", log::LevelFilter::Info)
        // Third-party crates flood Debug with per-token / per-frame
        // traces (html5ever parsing, rustls handshakes); keep dev readable.
        .level_for("html5ever", log::LevelFilter::Error)
        .level_for("rustls", log::LevelFilter::Info)
        .level_for("reqwest", log::LevelFilter::Info)
        .level_for("selectors", log::LevelFilter::Warn)
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
