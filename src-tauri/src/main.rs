// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    if agentero_plugin_host::is_plugin_worker_arg(std::env::args().nth(1).as_deref()) {
        std::process::exit(agentero_plugin_host::worker_main());
    }
    if let Some(status) =
        agentero_lib::features::paper::import::pdf_parse::try_run_pdf_parse_worker()
    {
        std::process::exit(status);
    }
    if let Some(status) = agentero_lib::integration::context_mcp::try_run_context_mcp() {
        std::process::exit(status);
    }
    if let Some(status) = agentero_lib::integration::delegate_mcp::try_run_delegate_mcp() {
        std::process::exit(status);
    }
    agentero_lib::run()
}
