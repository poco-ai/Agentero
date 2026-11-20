// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(status) =
        agentero_lib::features::paper::import::pdf_parse::try_run_pdf_parse_worker()
    {
        std::process::exit(status);
    }
    agentero_lib::run()
}
