#[cfg(test)]
mod acp_live {
    use crate::features::agent::acp::permission_response;
    use crate::features::agent::list_acp_sessions;
    use crate::features::agent::models::{AgentDescriptor, AgentTemplate, CatalogAcpStatus};
    use crate::features::agent::registry::discovery::resolve_command;
    use crate::features::agent::registry::templates::{catalog_templates, interactive_cli};
    use crate::features::agent::AgentRegistry;
    use agent_client_protocol::schema::v1::{
        PermissionOption, PermissionOptionId, PermissionOptionKind, RequestPermissionOutcome,
        RequestPermissionRequest, ToolCallUpdate, ToolCallUpdateFields,
    };
    use std::collections::{HashMap, HashSet};

    fn desc(
        id: &str,
        name: &str,
        template: AgentTemplate,
        command: &str,
        args: Vec<String>,
    ) -> AgentDescriptor {
        AgentDescriptor {
            id: id.into(),
            name: name.into(),
            template,
            command: command.into(),
            args,
            env: HashMap::new(),
            available: true,
            last_error: None,
            last_probe_ok: None,
            last_probe_agent_name: None,
            last_probe_error: None,
            last_probed_at: None,
        }
    }

    #[test]
    fn interactive_cli_tracks_the_host_cli() {
        let cats = catalog_templates();
        let find = |id: &str| cats.iter().find(|entry| entry.id == id).expect("template");
        // Most agents expose the same binary as the "installed" badge.
        assert_eq!(interactive_cli(find("codex-acp")).as_deref(), Some("codex"));
        assert_eq!(interactive_cli(find("pi")).as_deref(), Some("pi"));
        // Dsh needs an explicit profile; `tui` is the shipped interactive one.
        assert_eq!(
            interactive_cli(find("dsh")).as_deref(),
            Some("dsh --profile tui")
        );
        // Antigravity's CLI is `agy`; the managed `.par` is ACP-only.
        if let Some(antigravity) = cats.iter().find(|entry| entry.id == "antigravity-acp") {
            assert_eq!(interactive_cli(antigravity).as_deref(), Some("agy"));
        }
        // ZCode ships no user-facing CLI, so the terminal action is hidden.
        assert_eq!(interactive_cli(find("zcode")), None);
    }

    #[test]
    fn catalog_has_common_agents() {
        let cats = catalog_templates();
        let ids: Vec<_> = cats.iter().map(|c| c.id.as_str()).collect();
        assert!(ids.contains(&"opencode"));
        assert!(ids.contains(&"claude-acp"));
        assert!(ids.contains(&"codex-acp"));
        assert!(ids.contains(&"hermes"));
        assert!(!ids.contains(&"antigravity"));
        assert_eq!(
            ids.contains(&"antigravity-acp"),
            !cfg!(all(target_os = "macos", target_arch = "x86_64"))
        );
        assert!(ids.contains(&"qodercli"));
        assert!(ids.contains(&"grok-build"));
        assert!(ids.contains(&"pi"));
        assert!(ids.contains(&"dsh"));
        assert!(ids.contains(&"kimi-code"));
        assert!(ids.contains(&"zcode"));
        assert!(ids.contains(&"minimax-code"));
        assert!(!ids.contains(&"custom"));
    }

    #[test]
    #[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
    fn antigravity_template_uses_the_official_server() {
        let agent = catalog_templates()
            .into_iter()
            .find(|entry| entry.id == "antigravity-acp")
            .expect("Antigravity template");
        assert!(agent.command.ends_with(if cfg!(windows) {
            "agy_acp_server.exe"
        } else {
            "agy_acp_server.par"
        }));
        assert_eq!(
            agent.args,
            if cfg!(target_os = "linux") {
                vec!["--uid="]
            } else {
                vec![]
            }
        );
        // Detect the server itself, not the desktop app or the retired adapter.
        assert!(agent.detect_command.is_none());
        assert!(crate::features::agent::registry::lifecycle::supports_lifecycle(&agent.id));
    }

    #[test]
    fn zcode_template_uses_the_acp_adapter() {
        let zcode = catalog_templates()
            .into_iter()
            .find(|entry| entry.id == "zcode")
            .expect("ZCode template");
        assert_eq!(zcode.command, "zcode-acp-server");
        assert_eq!(zcode.args, vec!["server".to_string()]);
        // The adapter discovers the desktop app's zcode.cjs itself, so the
        // "installed" badge tracks the adapter rather than a host `zcode` CLI.
        assert_eq!(zcode.detect_command.as_deref(), Some("zcode-acp-server"));
        assert!(zcode.install_command.is_some());
    }

    #[test]
    fn codex_template_uses_the_acp_adapter() {
        let codex = catalog_templates()
            .into_iter()
            .find(|entry| entry.id == "codex-acp")
            .expect("Codex template");

        assert_eq!(codex.command, "codex-acp");
        assert_eq!(codex.args, Vec::<String>::new());
        assert_eq!(codex.detect_command.as_deref(), Some("codex"));
        assert_eq!(codex.login_command.as_deref(), Some("codex login"));
    }

    #[test]
    fn oauth_templates_define_login_commands() {
        let cats = catalog_templates();
        let claude = cats
            .iter()
            .find(|entry| entry.id == "claude-acp")
            .expect("Claude template");
        let codex = cats
            .iter()
            .find(|entry| entry.id == "codex-acp")
            .expect("Codex template");

        assert_eq!(claude.login_command.as_deref(), Some("claude auth login"));
        assert_eq!(codex.login_command.as_deref(), Some("codex login"));
    }

    #[test]
    fn pi_template_uses_the_acp_adapter() {
        let pi = catalog_templates()
            .into_iter()
            .find(|entry| entry.id == "pi")
            .expect("Pi template");

        assert_eq!(pi.command, "pi-acp");
        assert_eq!(pi.args, Vec::<String>::new());
        assert_eq!(pi.detect_command.as_deref(), Some("pi"));
    }

    #[test]
    fn hermes_template_uses_native_acp() {
        let cats = catalog_templates();
        let hermes = cats
            .iter()
            .find(|entry| entry.id == "hermes")
            .expect("Hermes template");
        assert_eq!(hermes.command, "hermes");
        assert_eq!(hermes.args, vec!["acp".to_string()]);
        assert_eq!(hermes.detect_command.as_deref(), Some("hermes"));
    }

    #[test]
    fn kimi_template_uses_native_acp() {
        let kimi = catalog_templates()
            .into_iter()
            .find(|entry| entry.id == "kimi-code")
            .expect("Kimi Code template");
        assert_eq!(kimi.command, "kimi");
        assert_eq!(kimi.args, vec!["acp".to_string()]);
        assert_eq!(kimi.detect_command.as_deref(), Some("kimi"));
    }

    #[test]
    fn minimax_template_uses_native_acp() {
        let minimax = catalog_templates()
            .into_iter()
            .find(|entry| entry.id == "minimax-code")
            .expect("MiniMax Code template");
        assert_eq!(minimax.command, "mcode");
        assert_eq!(minimax.args, vec!["acp".to_string()]);
        assert_eq!(minimax.detect_command.as_deref(), Some("mcode"));
        assert_eq!(minimax.login_command.as_deref(), Some("mcode login"));
    }

    /// grok-build must not detect or launch through `npx`: `npx` resolves on any
    /// machine with Node, so the row looked installed and the Settings auto-probe
    /// spawned `npx @xai-official/grok@<pinned>`, downloading the agent unasked.
    #[test]
    fn grok_template_uses_the_native_cli_not_npx() {
        let grok = catalog_templates()
            .into_iter()
            .find(|entry| entry.id == "grok-build")
            .expect("Grok Build template");
        assert_eq!(grok.command, "grok");
        assert_eq!(grok.args, vec!["agent".to_string(), "stdio".to_string()]);
        assert_eq!(grok.detect_command.as_deref(), Some("grok"));
    }

    #[test]
    fn no_catalog_template_resolves_through_npx() {
        for tmpl in catalog_templates() {
            assert_ne!(tmpl.command, "npx", "{} launches via npx", tmpl.id);
            assert_ne!(
                tmpl.detect_command.as_deref(),
                Some("npx"),
                "{} detects via npx",
                tmpl.id
            );
        }
    }

    #[test]
    fn permission_requests_are_cancelled_unless_yolo_is_enabled() {
        let request = RequestPermissionRequest::new(
            "session",
            ToolCallUpdate::new("tool-call", ToolCallUpdateFields::new()),
            vec![
                PermissionOption::new(
                    "reject-once",
                    "Reject once",
                    PermissionOptionKind::RejectOnce,
                ),
                PermissionOption::new(
                    "allow-always",
                    "Allow always",
                    PermissionOptionKind::AllowAlways,
                ),
                PermissionOption::new("allow-once", "Allow once", PermissionOptionKind::AllowOnce),
            ],
        );

        assert!(matches!(
            permission_response(&request, false).outcome,
            RequestPermissionOutcome::Cancelled
        ));
        assert!(matches!(
            permission_response(&request, true).outcome,
            RequestPermissionOutcome::Selected(selected)
                if selected.option_id == PermissionOptionId::new("allow-once")
        ));
    }

    #[test]
    fn scan_catalog_reflects_local_binaries() {
        let reg = AgentRegistry::load();
        let scan = reg.scan_catalog().expect("scan");
        for e in &scan.entries {
            eprintln!(
                "catalog {} binary={} acp_cmd={} status={:?} path={:?}",
                e.template_id,
                e.binary_available,
                e.acp_command_available,
                e.acp_status,
                e.resolved_path
            );
        }
        let by_id = |id: &str| {
            scan.entries
                .iter()
                .find(|e| e.template_id == id)
                .unwrap_or_else(|| panic!("missing catalog entry {id}"))
        };
        if resolve_command("opencode").is_some() {
            assert!(by_id("opencode").binary_available);
            assert_ne!(by_id("opencode").acp_status, CatalogAcpStatus::Missing);
        }
        if resolve_command("claude").is_some() {
            assert!(by_id("claude-acp").binary_available);
        }
        if resolve_command("hermes").is_some() {
            assert!(by_id("hermes").binary_available);
            assert_ne!(by_id("hermes").acp_status, CatalogAcpStatus::Missing);
        }
        if resolve_command("qodercli").is_some() {
            assert!(by_id("qodercli").binary_available);
            assert_ne!(by_id("qodercli").acp_status, CatalogAcpStatus::Missing);
        }
        if resolve_command("grok").is_some() {
            assert!(by_id("grok-build").binary_available);
            assert_ne!(by_id("grok-build").acp_status, CatalogAcpStatus::Missing);
        } else {
            // Must stay Missing without the CLI: `acpCommandAvailable` gates the
            // Settings auto-probe, and probing would npm-download the agent.
            assert!(!by_id("grok-build").binary_available);
            assert_eq!(by_id("grok-build").acp_status, CatalogAcpStatus::Missing);
        }
        if resolve_command("codex").is_some() {
            assert!(by_id("codex-acp").binary_available);
        }
    }

    /// #338: codex-acp pages `session/list` over a global time window and filters
    /// by cwd inside each page, so the Host must walk the cursor rather than show
    /// only the first page.
    #[tokio::test]
    async fn codex_acp_session_list_walks_cursor_pages() {
        if resolve_command("codex-acp").is_none() {
            eprintln!("skip: codex-acp not on PATH");
            return;
        }
        let d = desc(
            "test-codex-acp",
            "Codex",
            AgentTemplate::CodexAcp,
            "codex-acp",
            vec![],
        );
        let vault = std::env::current_dir().expect("cwd");
        let cwd =
            crate::features::agent::acp::client::agent_spawn_cwd(None, vault.to_str()).unwrap();
        let result = list_acp_sessions(&d, cwd.clone(), None, None)
            .await
            .expect("session/list must succeed");
        assert!(result.supported, "codex-acp advertises session.list");
        eprintln!(
            "codex-acp sessions for {}: {}",
            cwd.display(),
            result.sessions.len()
        );
        let mut seen = HashSet::new();
        for s in &result.sessions {
            assert!(
                seen.insert(s.session_id.clone()),
                "duplicate session {}",
                s.session_id
            );
            assert_eq!(s.cwd, cwd.to_string_lossy(), "agent must filter by cwd");
        }
    }
}

#[cfg(test)]
mod tool_payload {
    use crate::features::agent::acp::updates::{cap_tool_payload, TOOL_PAYLOAD_MAX_BYTES};
    use serde_json::{json, Value};

    #[test]
    fn small_payloads_pass_through_unchanged() {
        assert_eq!(cap_tool_payload(None), None);
        let small = json!({ "questions": [{ "question": "Proceed?" }] });
        assert_eq!(cap_tool_payload(Some(small.clone())), Some(small));
    }

    #[test]
    fn oversized_string_is_truncated_with_marker() {
        let big = "x".repeat(TOOL_PAYLOAD_MAX_BYTES * 4);
        let capped = cap_tool_payload(Some(Value::String(big.clone()))).unwrap();
        let Value::String(text) = capped else {
            panic!("expected string payload");
        };
        assert!(text.len() < big.len() / 2, "payload must shrink");
        assert!(
            text.starts_with(&"x".repeat(1024)),
            "head must be preserved"
        );
        assert!(text.contains("truncated"), "marker must be present");
    }

    #[test]
    fn oversized_object_falls_back_to_json_head() {
        let big = json!({ "fileText": "y".repeat(TOOL_PAYLOAD_MAX_BYTES * 2) });
        let capped = cap_tool_payload(Some(big)).unwrap();
        let Value::String(text) = capped else {
            panic!("expected string payload");
        };
        assert!(text.starts_with("{\"fileText\":"));
        assert!(text.contains("truncated"));
        assert!(text.len() <= TOOL_PAYLOAD_MAX_BYTES + 128);
    }

    #[test]
    fn truncation_respects_char_boundaries() {
        // Multi-byte chars across the cut point must not panic.
        let big = "汉".repeat(TOOL_PAYLOAD_MAX_BYTES);
        let capped = cap_tool_payload(Some(Value::String(big))).unwrap();
        let Value::String(text) = capped else {
            panic!("expected string payload");
        };
        assert!(text.contains("truncated"));
    }
}

#[cfg(test)]
mod list_sessions_paging {
    use crate::features::agent::session::{
        list_sessions_page_done, LIST_SESSIONS_BUDGET, LIST_SESSIONS_MAX, LIST_SESSIONS_MAX_PAGES,
    };
    use std::time::Duration;

    #[test]
    fn exhausted_cursor_stops() {
        assert!(list_sessions_page_done(
            None,
            Some("2026-08-10T00:00:00Z"),
            3,
            1,
            Duration::ZERO
        ));
    }

    #[test]
    fn empty_page_with_a_fresh_cursor_keeps_paging() {
        // #338: codex-acp pages globally and filters by cwd, so a page holding
        // zero sessions for this vault still has more results behind it.
        assert!(!list_sessions_page_done(
            Some("2026-08-05T00:00:00Z"),
            Some("2026-08-10T00:00:00Z"),
            0,
            7,
            Duration::ZERO
        ));
    }

    #[test]
    fn stalled_cursor_stops() {
        let same = "2026-08-10T00:00:00Z";
        assert!(list_sessions_page_done(
            Some(same),
            Some(same),
            1,
            2,
            Duration::ZERO
        ));
    }

    #[test]
    fn caps_stop_the_walk() {
        let next = Some("2026-08-05T00:00:00Z");
        let prev = Some("2026-08-10T00:00:00Z");
        assert!(list_sessions_page_done(
            next,
            prev,
            LIST_SESSIONS_MAX,
            1,
            Duration::ZERO
        ));
        assert!(list_sessions_page_done(
            next,
            prev,
            0,
            LIST_SESSIONS_MAX_PAGES,
            Duration::ZERO
        ));
        assert!(list_sessions_page_done(
            next,
            prev,
            0,
            1,
            LIST_SESSIONS_BUDGET
        ));
    }
}
