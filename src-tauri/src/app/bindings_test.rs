//! Typed IPC contract (tauri-specta): keeps `src/lib/core/bindings.ts` in
//! sync with the Rust command signatures.
//!
//! Coverage: every command registered for desktop in `app::handlers`
//! (`common_commands!` + the desktop-only extras) is collected here, and every
//! event emitted on desktop is declared in `app::events_contract` (44 events;
//! `event_name` matches the emit literal, emit sites unchanged). The iOS-only
//! bridge client commands (`integration::bridge::client_commands`) and client
//! events (`bridge:status` / `bridge:progress` / `bridge:pair-pending`) are
//! intentionally excluded: they are registered/emitted only in the iOS branch
//! of `attach_handlers` / `integration::bridge::client`, and their
//! `bridge_status` collides by command name with the desktop host
//! `bridge_status`.
//!
//! By default this only verifies the committed file matches the Rust
//! signatures without overwriting it, so `cargo test` does not dirty the
//! working tree. To regenerate, run:
//! `AGENTERO_UPDATE_BINDINGS=1 cargo test -p agentero export_typescript_bindings`

use std::path::Path;

#[test]
fn export_typescript_bindings() {
    let builder = tauri_specta::Builder::<tauri::Wry>::new()
        .commands(tauri_specta::collect_commands![
            crate::features::system::settings::commands::settings_get,
            crate::features::system::settings::commands::settings_set,
            crate::features::system::settings::commands::network_system_proxy,
            crate::features::system::settings::commands::list_system_fonts,
            crate::features::system::settings::commands::easy_scholar_probe,
            crate::features::system::settings::commands::easy_scholar_get_rank,
            crate::features::system::builtin::builtin_provider_status,
            crate::features::paper::analyze::layout::model_assets::commands::layout_model_status,
            crate::features::paper::analyze::layout::hosted::commands::layout_remote_analyze_pdf,
            crate::features::paper::analyze::layout::hosted::commands::layout_remote_probe,
            crate::features::agent::commands::agent_list_agents,
            crate::features::agent::commands::agent_list_skills,
            crate::features::agent::commands::agent_scan_catalog,
            crate::features::agent::commands::agent_check_catalog_updates,
            crate::features::agent::commands::agent_upsert_agent,
            crate::features::agent::commands::agent_ensure_catalog,
            crate::features::agent::commands::agent_remove_agent,
            crate::features::agent::commands::agent_set_default,
            crate::features::agent::commands::agent_set_enabled,
            crate::features::agent::commands::agent_set_user_agent,
            crate::features::agent::commands::agent_probe,
            crate::features::agent::commands::agent_probe_catalog,
            crate::features::agent::commands::doctor_check_host,
            crate::features::agent::commands::doctor_install_node,
            crate::features::agent::commands::doctor_check_agents,
            crate::features::agent::commands::doctor_open_agent_login_terminal,
            crate::features::system::network::commands::doctor_check_network,
            crate::features::agent::commands::agent_cancel_run,
            crate::features::jobs::commands::job_parse_refs_enqueue,
            crate::features::jobs::commands::job_parse_body_enqueue,
            crate::features::jobs::commands::job_layout_analyze_enqueue,
            crate::features::jobs::commands::job_download_assets_enqueue,
            crate::features::jobs::commands::job_import_enqueue,
            crate::features::jobs::commands::job_connector_sync_enqueue,
            crate::features::jobs::commands::job_citing_scan_enqueue,
            crate::features::jobs::commands::job_library_io_enqueue,
            crate::features::jobs::commands::job_metadata_refresh_enqueue,
            crate::features::jobs::commands::job_model_download_enqueue,
            crate::features::jobs::commands::job_paper_assets_status,
            crate::features::jobs::commands::job_reconcile_paper,
            crate::features::jobs::commands::job_reconcile_vault,
            crate::features::jobs::commands::job_papers_needing_assets,
            crate::features::jobs::commands::job_focus_paper,
            crate::features::jobs::commands::job_cancel,
            crate::features::jobs::commands::job_report,
            crate::features::jobs::commands::job_list,
            crate::features::jobs::commands::clear_parse_results,
            crate::features::jobs::commands::clear_and_reparse,
            crate::features::agent::commands::agent_respond_permission,
            crate::features::agent::commands::agent_respond_elicitation,
            crate::features::agent::commands::agent_respond_ask_user,
            crate::features::agent::commands::agent_resolve_citation,
            crate::features::markdown::wiki::commands::graph_get_backlinks,
            crate::features::markdown::wiki::commands::wiki_resolve,
            crate::features::markdown::wiki::commands::wiki_embed_read,
            crate::features::markdown::wiki::commands::wiki_search,
            crate::features::markdown::wiki::commands::wiki_rename_heading,
            crate::features::markdown::wiki::commands::graph_rebuild,
            crate::features::markdown::wiki::commands::wiki_cache_rebuild,
            crate::features::vault::doctor::commands::doctor_check,
            crate::features::vault::doctor::commands::doctor_apply_aliases,
            crate::features::vault::doctor::commands::doctor_ignore_aliases,
            crate::features::vault::doctor::commands::doctor_set_dirty_paths,
            crate::features::vault::doctor::commands::doctor_plan_wikilinks,
            crate::features::vault::doctor::commands::doctor_apply_wikilinks,
            crate::features::vault::doctor::commands::doctor_apply_visual_marks,
            crate::features::vault::doctor::commands::doctor_fix_catalog_duplicates,
            crate::features::vault::commands::vault_create,
            crate::features::vault::commands::vault_ensure,
            crate::app::vault_session::fs_scope::vault_allow_fs_scope::<tauri::Wry>,
            crate::app::vault_session::lifecycle::vault_release,
            crate::features::vault::commands::vault_tree_build,
            crate::features::vault::commands::vault_tree_children,
            crate::features::vault::rename::commands::wiki_move,
            crate::features::vault::rename::commands::wiki_external_rename_preview,
            crate::features::vault::rename::commands::wiki_apply_external_rename_repair,
            crate::features::vault::trash::commands::path_trash,
            crate::features::vault::trash::commands::path_list_trash,
            crate::features::vault::trash::commands::path_restore_item,
            crate::features::vault::trash::commands::path_purge_item,
            crate::features::vault::trash::commands::path_purge_trash,
            crate::features::translate::commands::translate_text,
            crate::features::paper::import::commands::lookup_import_batch,
            crate::features::paper::import::commands::skill_install,
            crate::features::paper::import::commands::skill_discard,
            crate::features::paper::import::commands::paper_download_assets,
            crate::features::paper::import::commands::paper_import_local_pdf,
            crate::features::paper::import::commands::paper_parse_body,
            crate::features::paper::import::commands::paper_resolve_identifier,
            crate::features::paper::import::commands::paper_stage_import_file,
            crate::features::paper::import::commands::notes_template_seed,
            crate::features::paper::zotero::commands::paper_export,
            crate::features::paper::zotero::commands::paper_import,
            crate::features::paper::analyze::refs::commands::paper_refs_parse,
            crate::features::paper::analyze::refs::commands::paper_refs_list,
            crate::features::paper::analyze::refs::commands::library_citing_scan,
            crate::features::paper::discovery::coolpapers::commands::paper_coolpapers_notes,
            crate::features::paper::discovery::coolpapers::commands::paper_coolpapers_import,
            crate::features::paper::catalog::commands::paper_open_bundle,
            crate::features::paper::catalog::commands::paper_get,
            crate::features::paper::catalog::commands::paper_list,
            crate::features::paper::catalog::commands::paper_move,
            crate::features::paper::catalog::commands::paper_repath,
            crate::features::paper::catalog::commands::paper_set_is_read,
            crate::features::paper::catalog::commands::paper_update_meta,
            crate::features::paper::catalog::commands::paper_set_tags,
            crate::features::paper::catalog::commands::paper_rescan,
            crate::features::paper::catalog::commands::paper_page_counts,
            crate::features::paper::catalog::commands::paper_set_page_counts,
            crate::features::paper::catalog::commands::paper_reading_activity_batch,
            crate::features::markdown::search::commands::vault_search,
            crate::core::usage::commands::activity_record_events,
            crate::core::usage::commands::usage_list,
            crate::core::usage::commands::usage_summary,
            crate::core::usage::commands::usage_clear,
            crate::app::logging::logs_clear,
            crate::features::paper::discovery::feeds::commands::feeds_list,
            crate::features::paper::discovery::feeds::commands::feeds_add,
            crate::features::paper::discovery::feeds::commands::feeds_remove,
            crate::features::paper::discovery::feeds::commands::feeds_rename,
            crate::features::paper::discovery::feeds::commands::feeds_refresh,
            crate::features::paper::discovery::feeds::commands::feeds_items,
            crate::features::paper::discovery::feeds::commands::feeds_mark_imported,
            crate::features::paper::discovery::scratch::plaza_scratch_prepare,
            crate::features::paper::discovery::scratch::plaza_scratch_stats,
            crate::features::paper::discovery::scratch::plaza_scratch_clear,
            crate::features::paper::discovery::feeds::commands::feeds_set_pinned,
            crate::features::paper::discovery::feeds::commands::feeds_resolve_body,
            crate::features::paper::discovery::recommend::commands::recommend_arxiv,
            crate::features::paper::discovery::recommend::commands::recommend_arxiv_last,
            crate::features::paper::discovery::recommend::commands::probe_embedding,
            crate::app::menu::set_locale,
            crate::integration::bridge::commands::bridge_start,
            crate::integration::bridge::commands::bridge_stop,
            crate::integration::bridge::commands::bridge_status,
            crate::integration::bridge::commands::bridge_offer,
            crate::integration::bridge::commands::bridge_pair_respond,
            crate::integration::bridge::commands::bridge_devices,
            crate::integration::bridge::commands::bridge_revoke_device,
            crate::features::agent::commands::agent_run_tool_lifecycle,
            crate::features::agent::commands::agent_run_partial_uninstall,
            crate::features::agent::commands::agent_lifecycle_cancel,
            crate::features::agent::commands::agent_tool_uninstall_info,
            crate::features::agent::commands::agent_run_once,
            crate::features::agent::commands::agent_list_sessions,
            crate::features::agent::commands::agent_load_session,
            crate::features::agent::commands::agent_warm,
            crate::integration::remote::commands::remote_connect,
            crate::integration::remote::commands::remote_ssh_config_hosts,
            crate::integration::remote::commands::remote_disconnect,
            crate::integration::remote::commands::remote_vault_ensure,
            crate::integration::remote::commands::remote_list,
            crate::integration::remote::commands::remote_read_text,
            crate::integration::remote::commands::remote_write_text,
            crate::integration::remote::commands::remote_mkdir,
            crate::integration::remote::commands::remote_remove,
            crate::integration::remote::commands::remote_write_bytes,
            crate::integration::remote::commands::remote_paper_list,
            crate::integration::remote::commands::remote_paper_get,
            crate::integration::remote::commands::remote_paper_rescan,
            crate::integration::remote::commands::remote_paper_set_tags,
            crate::integration::remote::commands::remote_paper_set_is_read,
            crate::integration::remote::commands::remote_cache_file,
            crate::integration::remote::commands::remote_cache_stats,
            crate::integration::remote::commands::remote_cache_clear,
            crate::features::agent::commands::remote_agent_scan,
            crate::features::agent::commands::remote_agent_probe,
            crate::features::agent::commands::remote_agent_open_install_terminal,
            crate::app::terminal::commands::path_open_in_terminal,
            crate::app::window::commands::window_new,
            crate::app::window::commands::settings_window_open,
            crate::app::window::commands::feature_window_open,
            crate::app::window::commands::doc_window_open,
            crate::features::paper::zotero::commands::zotero_scan,
            crate::features::paper::zotero::commands::zotero_migrate,
            crate::features::paper::zotero::sync::commands::zotero_sync,
            crate::integration::sync::commands::sync_get_status,
            crate::integration::sync::commands::sync_configure,
            crate::integration::sync::commands::sync_disconnect,
            crate::integration::sync::commands::sync_now,
            crate::integration::sync::commands::sync_scope_sizes,
            crate::features::vault::watcher::commands::fs_watch_start,
            crate::features::vault::watcher::commands::fs_watch_stop,
            crate::integration::connector::commands::connector_get_status,
            crate::integration::connector::commands::connector_set_enabled,
            crate::integration::connector::commands::connector_set_vault,
            crate::integration::connector::commands::connector_set_parent_dir,
            crate::integration::connector::commands::connector_set_port,
            crate::integration::mcp::commands::mcp_get_status,
            crate::integration::mcp::commands::mcp_set_enabled,
            crate::integration::mcp::commands::mcp_set_port,
            crate::integration::mcp::commands::mcp_set_vault,
            crate::integration::mcp::commands::mcp_set_parent_dir,
            crate::integration::mcp::commands::mcp_tunnel_status,
            crate::integration::mcp::commands::mcp_tunnel_start,
            crate::integration::mcp::commands::mcp_tunnel_stop,
            crate::app::open_request::commands::vault_open_take_pending,
            crate::features::cli_install::commands::cli_install_status::<tauri::Wry>,
            crate::features::cli_install::commands::cli_install_command::<tauri::Wry>,
            crate::features::cli_install::commands::cli_uninstall_command::<tauri::Wry>,
            crate::app::finder_service::commands::finder_service_status::<tauri::Wry>,
            crate::app::finder_service::commands::finder_service_install::<tauri::Wry>,
            crate::app::finder_service::commands::finder_service_uninstall::<tauri::Wry>,
            crate::features::pdf::export::commands::export_system_cjk_font,
            crate::features::web::commands::web_proxy_allow_host,
            crate::features::compile::detect_latex_engines,
            crate::features::compile::clean_latex_aux_files,
            crate::features::compile::chktex_lint,
            crate::features::compile::root::resolve_latex_root,
            crate::features::jobs::commands::job_latex_compile_enqueue,
        ])
        // Desktop event surface (see `app::events_contract`): emit sites keep
        // using `app.emit("<literal>", payload)`; the wrappers/mirrors there
        // carry `event_name` matching each literal so `events.*` in
        // bindings.ts listens on the same wire names.
        .events(tauri_specta::collect_events![
            crate::app::events_contract::JobOfferEvent,
            crate::app::events_contract::JobChangedEvent,
            crate::app::events_contract::JobCompletedEvent,
            crate::app::events_contract::JobFailedEvent,
            crate::app::events_contract::MenuInvokedEvent,
            crate::app::events_contract::VaultOpenRequestEvent,
            crate::app::events_contract::VaultOpenErrorEvent,
            crate::app::events_contract::WindowClosedEvent,
            crate::app::events_contract::VaultFileChangedEvent,
            crate::app::events_contract::SettingsChangedEvent,
            crate::app::events_contract::JobProgressEvent,
            crate::app::events_contract::LayoutRemoteProgressEvent,
            crate::app::events_contract::AgentLifecycleProgressEvent,
            crate::app::events_contract::AgentRegistryChangedEvent,
            crate::app::events_contract::AskUserRequestEvt,
            crate::app::events_contract::ElicitationRequestEvt,
            crate::app::events_contract::PermissionRequestEvt,
            crate::app::events_contract::AgentModelsEvt,
            crate::app::events_contract::AgentCollaborationEvt,
            crate::app::events_contract::AgentEffortEvt,
            crate::app::events_contract::AgentFastModeEvt,
            crate::app::events_contract::AgentCommandsEvt,
            crate::app::events_contract::AgentToolEvt,
            crate::app::events_contract::AgentPlanEvt,
            crate::app::events_contract::AgentUsageEvt,
            crate::app::events_contract::AgentSessionInfoEvt,
            crate::app::events_contract::AgentFailedEvt,
            crate::app::events_contract::AgentStatusEvt,
            crate::app::events_contract::AgentStreamEvt,
            crate::app::events_contract::AgentCompletedEvent,
            crate::app::events_contract::BridgeHostStatusEvent,
            crate::app::events_contract::BridgePairRequestEvent,
            crate::app::events_contract::ConnectorStatusEvent,
            crate::app::events_contract::ConnectorItemSavedEvent,
            crate::app::events_contract::ConnectorProgressEvent,
            crate::app::events_contract::ConnectorErrorEvent,
            crate::app::events_contract::McpStatusEvent,
            crate::app::events_contract::McpTunnelStatusEvent,
            crate::app::events_contract::SyncStateEvent,
            crate::app::events_contract::SyncProgressEvent,
            crate::app::events_contract::PaperImportedEvent,
            crate::app::events_contract::PaperAssetsReadyEvent,
            crate::app::events_contract::PaperRenamedEventPayload,
            crate::app::events_contract::CompileLogEvent,
        ])
        // Tauri IPC serializes `i64`/`u64`/`usize` through serde_json as JSON
        // numbers, which the frontend already parses as JS `number` via the
        // untyped `invokeApi` path. Emitting TS `number` mirrors that existing
        // runtime behavior (values stay well under 2^53 in practice).
        .dangerously_cast_bigints_to_number();

    let out_path = Path::new("../src/lib/core/bindings.ts");
    let update = std::env::var("AGENTERO_UPDATE_BINDINGS").is_ok();

    if update {
        builder
            .export(specta_typescript::Typescript::default(), out_path)
            .expect("export typescript bindings");
        return;
    }

    let temp_dir = std::env::temp_dir().join(format!("agentero-bindings-{}", std::process::id()));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let temp_path = temp_dir.join("bindings.ts");
    builder
        .export(specta_typescript::Typescript::default(), &temp_path)
        .expect("export typescript bindings to temp");

    let expected = std::fs::read_to_string(&temp_path).expect("read temp bindings");
    let actual = std::fs::read_to_string(out_path).expect("read committed bindings");
    let _ = std::fs::remove_dir_all(&temp_dir);

    fn normalize(s: &str) -> String {
        s.chars()
            .filter(|c| !c.is_whitespace())
            .map(|c| if c == ';' { ',' } else { c })
            .collect()
    }

    assert_eq!(
        normalize(&expected),
        normalize(&actual),
        "bindings.ts is out of sync with Rust command signatures; rerun with AGENTERO_UPDATE_BINDINGS=1"
    );
}
