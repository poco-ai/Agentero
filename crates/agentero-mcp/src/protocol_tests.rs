//! Existing protocol regressions, exercised against the published research tool interface.
use crate::{interface::ResearchServer, tools_list, McpController, McpHost, Permissions};
use agentero_core::features::catalog::papers::{self, PaperRecord};
use agentero_core::ops::execute::run_local;
use rmcp::{
    model::{CallToolRequestParams, CallToolResult},
    service::{RoleClient, RunningService},
    ServiceExt,
};
use serde_json::{json, Value};
use std::{fs, path::Path, sync::Arc};

struct Writer;
impl McpHost for Writer {
    fn permissions(&self) -> Permissions {
        Permissions {
            write: true,
            full_text: true,
            ..Default::default()
        }
    }
}
fn fixture(root: &Path) {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/mcp-search");
    for rel in [
        "papers/alpha/PAPER.md",
        "papers/alpha/NOTES.md",
        "papers/alpha/source/layout.json",
        "papers/beta/PAPER.md",
        "papers/beta/NOTES.md",
    ] {
        let target = root.join(rel);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::copy(fixture.join(rel), target).unwrap();
    }
    let row = PaperRecord::local_pdf("alpha".into(), "Alpha Title".into()).at_path("papers/alpha");
    papers::upsert_paper(root, &row).unwrap();
}
async fn call(client: &RunningService<RoleClient, ()>, name: &str, args: Value) -> CallToolResult {
    client
        .call_tool(
            CallToolRequestParams::new(name.to_owned())
                .with_arguments(args.as_object().unwrap().clone()),
        )
        .await
        .unwrap()
}

#[test]
fn tool_schemas_match_the_grants_and_annotate_read_effects() {
    let basic = tools_list(Permissions::default()).tools;
    assert_eq!(basic.len(), 13);
    assert!(basic
        .iter()
        .all(|t| t.annotations.as_ref().and_then(|a| a.read_only_hint) == Some(true)));
    let online = tools_list(Permissions {
        online: true,
        ..Default::default()
    })
    .tools;
    assert_eq!(online.len(), 14);
    assert!(online.iter().any(|tool| tool.name == "paper_discover"));
    let writes = tools_list(Permissions {
        write: true,
        ..Default::default()
    })
    .tools;
    assert_eq!(writes.len(), 28);
    assert!(!writes.iter().any(|tool| tool.name == "paper_import"));
    let all = tools_list(Permissions::all()).tools;
    assert_eq!(all.len(), 30);
    for t in all {
        assert!(t.output_schema.is_some());
        assert_eq!(t.input_schema.get("type"), Some(&json!("object")));
    }
}

#[tokio::test]
async fn evidence_and_paper_updates_round_trip_over_the_protocol() {
    let vault = tempfile::tempdir().unwrap();
    fixture(vault.path());
    let ctrl = Arc::new(McpController::new());
    ctrl.set_vault(Some(vault.path().to_string_lossy().into_owned()));
    let (server_io, client_io) = tokio::io::duplex(65536);
    let backend = ctrl.clone();
    let task =
        tokio::spawn(async move { ResearchServer::new(backend).serve(server_io).await.unwrap() });
    let mut client = ().serve(client_io).await.unwrap();
    let mut server = task.await.unwrap();
    let peer = client.peer_info().unwrap();
    let info = peer.server_info.as_ref().unwrap();
    assert_eq!(info.name, "agentero");
    assert!(info.icons.as_ref().unwrap()[0]
        .src
        .starts_with("data:image/png;base64,"));
    let listed = client.list_all_tools().await.unwrap();
    assert!(!listed.iter().any(|t| t.name == "file_write"));
    let denied = call(
        &client,
        "file_write",
        json!({"path":"notes/x.md","content":"x"}),
    )
    .await;
    assert_eq!(denied.is_error, Some(true));
    assert!(!vault.path().join("notes/x.md").exists());
    let selected = call(&client, "vault_list", json!({}))
        .await
        .structured_content
        .unwrap();
    let vault_id = &selected["items"][0]["id"];
    assert!(vault_id.as_str().unwrap().starts_with("v-"));
    assert!(selected["items"][0].get("path").is_none());
    let hits = call(
        &client,
        "evidence_search",
        json!({"query":"Transformer attention","vault":vault_id}),
    )
    .await
    .structured_content
    .unwrap();
    assert!(!hits["items"].as_array().unwrap().is_empty());
    let bounded = hits["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["kind"] == "body")
        .unwrap();
    let replay = call(&client, "evidence_read", json!({"source":bounded["cite"]}))
        .await
        .structured_content
        .unwrap();
    assert_eq!(replay["text"], bounded["excerpt"]);
    assert!(replay["next_cursor"].is_null());
    let expanded = client
        .call_tool(
            CallToolRequestParams::new("evidence_read").with_arguments(
                json!({"source":bounded["cite"],"pages":[1]})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        )
        .await;
    assert!(
        expanded.is_err(),
        "A citation cannot be combined with page selection"
    );
    let stripped = call(
        &client,
        "evidence_read",
        json!({"source":"papers/alpha","pages":[2]}),
    )
    .await;
    assert_eq!(stripped.is_error, Some(true));
    ctrl.set_host(Arc::new(Writer));
    for (args, expected) in [
        (
            json!({"path":"assets/图.png","content":"AP+A","encoding":"base64"}),
            vec![0, 255, 128],
        ),
        (
            json!({"path":"drafts/main.tex","content":"hello"}),
            b"hello".to_vec(),
        ),
        (
            json!({"path":"drafts/main.tex","content":" world","mode":"append","request_id":"tail"}),
            b"hello world".to_vec(),
        ),
    ] {
        let result = call(&client, "file_write", args.clone())
            .await
            .structured_content
            .unwrap();
        assert_eq!(result["bytes"], expected.len());
        assert_eq!(
            fs::read(vault.path().join(args["path"].as_str().unwrap())).unwrap(),
            expected
        );
    }
    assert_eq!(
        call(
            &client,
            "file_write",
            json!({"path":"invalid/out.bin","encoding":"base64","content":"bad!"})
        )
        .await
        .is_error,
        Some(true)
    );
    assert!(!vault.path().join("invalid").exists());
    let filtered = call(
        &client,
        "evidence_search",
        json!({"query":"Transformer attention","in":["papers/alpha"],"kind":["body"]}),
    )
    .await
    .structured_content
    .unwrap();
    let passages = filtered["items"].as_array().unwrap();
    assert!(passages
        .iter()
        .all(|v| v["source"].as_str().unwrap().starts_with("papers/alpha")));
    assert!(passages.iter().any(|v| v["locator"]["page"] == 2));
    let alien = call(
        &client,
        "paper_list",
        json!({"vault":"/arbitrary/local/vault"}),
    )
    .await;
    assert_eq!(alien.is_error, Some(true));
    let page = call(
        &client,
        "evidence_read",
        json!({"source":"papers/alpha","pages":[2]}),
    )
    .await
    .structured_content
    .unwrap();
    assert!(page["text"]
        .as_str()
        .unwrap()
        .contains("Transformer attention"));
    assert_eq!(
        call(
            &client,
            "evidence_read",
            json!({"source":"papers/alpha","pages":[9999]})
        )
        .await
        .is_error,
        Some(true)
    );
    let first = call(&client, "paper_get", json!({"paper":"alpha"}))
        .await
        .structured_content
        .unwrap();
    let args = json!({"paper":"alpha","title":"Updated title","venue":"NeurIPS","date":"2024-12","doi":"10.1234/demo","author":["Alice","Bob"],"if_revision":first["revision"]});
    let changed = call(&client, "paper_update", args.clone())
        .await
        .structured_content
        .unwrap();
    assert_eq!(changed["authors"], json!(["Alice", "Bob"]));
    assert_eq!(changed["venue"], "NeurIPS");
    assert_eq!(
        call(&client, "paper_update", args).await.is_error,
        Some(true)
    );
    let file: Value =
        serde_json::from_slice(&fs::read(vault.path().join("papers/alpha/metadata.json")).unwrap())
            .unwrap();
    assert_eq!(file["doi"], "10.1234/demo");
    assert_eq!(file["title"], "Updated title");
    client.close().await.unwrap();
    server.close().await.unwrap();
}

#[tokio::test]
async fn row_operations_are_the_only_path_for_existing_research_tables() {
    let table = r#"{
  "format": "agentero-table",
  "version": 1,
  "id": "t1",
  "name": "Measurements",
  "kind": "result",
  "revision": 3,
  "idPrefix": "EXP",
  "nextSequence": 3,
  "fields": [
    {"id":"sample","name":"Sample","type":"text","unit":"","options":[]},
    {"id":"capacity","name":"Capacity","type":"number","unit":"mAh","options":[]}
  ],
  "rows": [
    {"id":"r1","registryId":"EXP-0001","actor":"human","createdAt":"2026-11-07T00:00:00.000Z","updatedAt":"2026-11-07T00:00:00.000Z","values":{"sample":"A","capacity":1}},
    {"id":"r2","registryId":"EXP-0002","archivedAt":"2026-11-07T01:00:00.000Z","values":{"sample":"old"}}
  ]
}"#;

    let tmp = tempfile::tempdir().unwrap();
    let vault = tmp.path();
    let path = "lab/results.table.json";
    let create = json!({"path":path,"content":table});
    let initial = run_local(vault, "file_write", create, None).await.unwrap();
    let replace = run_local(
        vault,
        "file_write",
        json!({"path":path,"content":table,"mode":"replace","if_revision":initial["revision"]}),
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(replace.code(), "use_table_ops");
    let rows = run_local(vault, "table_query", json!({"path":path}), None)
        .await
        .unwrap();
    assert_eq!(rows["items"].as_array().unwrap().len(), 1);
    let op = json!({"path":path,"if_revision":rows["revision"],"request_id":"update-1","cells":[{"id":"EXP-0001","field":"Capacity","value":5}]});
    let changed = run_local(vault, "table_patch", op.clone(), None)
        .await
        .unwrap();
    assert_eq!(changed["changed_rows"], json!(["EXP-0001"]));
    assert_eq!(
        run_local(vault, "table_patch", op.clone(), None)
            .await
            .unwrap(),
        changed
    );
    let mut conflict = op;
    conflict["cells"][0]["value"] = json!(6);
    assert_eq!(
        run_local(vault, "table_patch", conflict, None)
            .await
            .unwrap_err()
            .code(),
        "idempotency_conflict"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn search_stays_inside_the_selected_vault() {
    let vault = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret.md"), "needle outside").unwrap();
    std::os::unix::fs::symlink(outside.path(), vault.path().join("linked")).unwrap();
    fs::create_dir_all(vault.path().join("draft.pdf")).unwrap();
    fs::write(vault.path().join("draft.pdf/note.md"), "needle inside").unwrap();
    let result = run_local(
        vault.path(),
        "evidence_search",
        json!({"query":"needle"}),
        None,
    )
    .await
    .unwrap();
    let items = result["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["source"], "draft.pdf/note.md");
}

#[test]
fn search_uses_the_blocking_pool_without_stalling_the_runtime() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    let (release, wait) = std::sync::mpsc::channel();
    let (ready, started) = std::sync::mpsc::channel();
    let blocker = runtime.spawn_blocking(move || {
        ready.send(()).unwrap();
        wait.recv().unwrap();
    });
    started.recv().unwrap();
    let vault = tempfile::tempdir().unwrap();
    fs::write(vault.path().join("test.md"), "needle test material").unwrap();
    runtime.block_on(async move {
        let search = tokio::spawn(async move {
            run_local(
                vault.path(),
                "evidence_search",
                json!({"query":"needle"}),
                None,
            )
            .await
            .unwrap()
        });
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        let queued = !search.is_finished();
        release.send(()).unwrap();
        blocker.await.unwrap();
        assert!(queued);
        assert_eq!(search.await.unwrap()["items"].as_array().unwrap().len(), 1);
    });
}
