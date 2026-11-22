//! Integration tests for agentero research CLI (offline; no Translator).

use assert_cmd::cargo::cargo_bin_cmd;
use predicates::prelude::*;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::tempdir;

fn agentero() -> assert_cmd::Command {
    // Cargo bin name is `agentero-cli` (avoids colliding with the GUI bin).
    cargo_bin_cmd!("agentero-cli")
}

fn create_vault(dir: &Path) -> PathBuf {
    let home = dir.parent().unwrap_or(dir).join(".test-home");
    fs::create_dir_all(&home).unwrap();
    agentero()
        .env("HOME", &home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .args(["vault", "create", dir.to_str().unwrap(), "--json"])
        .assert()
        .success()
        .stdout(predicate::str::contains("\"outcome\":\"created\""));
    home
}

/// Minimal PDF (200x100 pt pages, Helvetica 12) with a real xref table, so
/// PDFium loads it without reconstruction. One page per entry, text drawn at
/// 20,60 in PDF space.
fn tiny_pdf_pages(texts: &[&str]) -> Vec<u8> {
    // 1 catalog, 2 page tree, 3 font, then (page, contents) pairs from 4.
    let first_page_obj = 4;
    let kids: Vec<String> = (0..texts.len())
        .map(|i| format!("{} 0 R", first_page_obj + i * 2))
        .collect();

    let mut objects = vec![
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        format!(
            "<< /Type /Pages /Kids [{}] /Count {} >>",
            kids.join(" "),
            texts.len()
        ),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
    ];
    for (i, text) in texts.iter().enumerate() {
        let contents_obj = first_page_obj + i * 2 + 1;
        objects.push(format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents {contents_obj} 0 R \
              /Resources << /Font << /F1 3 0 R >> >> >>"
        ));
        let content = format!("BT /F1 12 Tf 20 60 Td ({text}) Tj ET\n");
        objects.push(format!(
            "<< /Length {} >>\nstream\n{content}endstream",
            content.len()
        ));
    }

    let mut out = String::from("%PDF-1.4\n");
    let mut offsets = Vec::with_capacity(objects.len());
    for (i, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.push_str(&format!("{} 0 obj\n{body}\nendobj\n", i + 1));
    }
    let xref_at = out.len();
    out.push_str(&format!("xref\n0 {}\n", objects.len() + 1));
    out.push_str("0000000000 65535 f \n");
    for offset in &offsets {
        out.push_str(&format!("{offset:010} 00000 n \n"));
    }
    out.push_str(&format!(
        "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n",
        objects.len() + 1
    ));
    out.into_bytes()
}

fn invoke(vault: &Path, args: &[&str], success: bool) -> Value {
    let home = vault.parent().unwrap().join(".test-home");
    let output = agentero()
        .env("HOME", &home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .args(["--json", "--no-input", "--vault", vault.to_str().unwrap()])
        .args(args)
        .output()
        .unwrap();
    assert_eq!(
        output.status.success(),
        success,
        "{args:?}: {} / {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(if success {
        &output.stdout
    } else {
        &output.stderr
    })
    .unwrap()
}
fn ok(v: &Path, a: &[&str]) -> Value {
    invoke(v, a, true)
}
fn fail(v: &Path, a: &[&str]) -> Value {
    invoke(v, a, false)
}
fn paper(v: &Path) {
    fs::create_dir_all(v.join("papers/demo")).unwrap();
    seed_paper(v, "papers/demo", "demo", "Demo Paper");
}
#[test]
fn vault_create_and_list() {
    let tmp = tempdir().unwrap();
    let vault = tmp.path().join("v");
    let _home = create_vault(&vault);

    assert!(vault.join("papers").is_dir());
    assert!(vault.join(".agentero").join("catalog.sqlite").is_file());
    assert!(vault.join("AGENTS.md").is_file());
    assert!(vault.join(".agents/skills/agentero-cli/SKILL.md").is_file());
    assert!(vault.join(".agents/skills/paper-reader/SKILL.md").is_file());
    assert!(vault
        .join(".agents/skills/idea-evaluator/SKILL.md")
        .is_file());
    assert!(vault
        .join(".agents/skills/deep-research/SKILL.md")
        .is_file());
    assert!(vault.join(".agents/skills/README.md").is_file());

    let listed = ok(&vault, &["vault", "list"]);
    assert!(listed["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["path"]
            .as_str()
            .and_then(|p| Path::new(p).canonicalize().ok())
            == vault.canonicalize().ok()));
}

#[test]
fn help_and_tool_inventory_agree_with_the_command_tree() {
    let tmp = tempdir().unwrap();
    let v = tmp.path().join("v");
    create_vault(&v);
    let tree = ok(&v, &["help"]);
    let cmds = tree["commands"].as_array().unwrap();
    assert_eq!(cmds.iter().filter(|c| !c["result"].is_null()).count(), 72);
    for op in cmds {
        let mut words: Vec<_> = op["path"].as_str().unwrap().split_whitespace().collect();
        words.push("--help");
        agentero()
            .args(words)
            .assert()
            .success()
            .stdout(predicate::str::contains("Usage:"));
    }
    let inventory = ok(
        &v,
        &[
            "mcp",
            "tools",
            "--allow-vault",
            v.to_str().unwrap(),
            "--allow",
            "write",
            "--allow",
            "online",
        ],
    );
    let tools = inventory["tools"].as_array().unwrap();
    for command in cmds.iter().filter(|cmd| cmd["tool"].is_string()) {
        let name = &command["tool"];
        let schema = &tools.iter().find(|t| &t["name"] == name).unwrap()["inputSchema"];
        let mut fields = std::collections::HashSet::new();
        for arg in command["args"].as_array().unwrap() {
            if arg["binding"]["decode"] == "omit" {
                continue;
            }
            let field = arg["binding"]["field"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| arg["name"].as_str().unwrap().replace('-', "_"));
            assert!(
                schema["properties"].get(&field).is_some(),
                "{name} does not accept {field}"
            );
            fields.insert(field);
        }
        for required in schema["required"].as_array().into_iter().flatten() {
            assert!(
                fields.contains(required.as_str().unwrap()),
                "{name} CLI is missing {required}"
            );
        }
    }
}
#[test]
fn paper_crud_tags_read_state_revisions_and_metadata_sidecar() {
    let tmp = tempdir().unwrap();
    let v = tmp.path().join("v");
    create_vault(&v);
    assert_eq!(ok(&v, &["paper", "list"])["items"], serde_json::json!([]));
    assert!(fail(&v, &["paper", "get", "missing"])["error"]["code"].is_string());
    paper(&v);
    set_tags_json(&v, "papers/demo", r#"[{"name":"legacy","color":"red"}]"#);
    let original = ok(&v, &["paper", "get", "demo"]);
    let rev = original["revision"].as_str().unwrap();
    let updated = ok(
        &v,
        &[
            "paper",
            "update",
            "demo",
            "--title",
            "A new title",
            "--author",
            "Jane",
            "--venue",
            "Science",
            "--date",
            "2025-03-02",
            "--state",
            "read",
            "--if-revision",
            rev,
        ],
    );
    assert_eq!(updated["authors"][0], "Jane");
    assert_eq!(updated["state"], "read");
    let sidecar: Value =
        serde_json::from_slice(&fs::read(v.join("papers/demo/metadata.json")).unwrap()).unwrap();
    assert_eq!(sidecar["title"], "A new title");
    assert_eq!(
        fail(
            &v,
            &[
                "paper",
                "update",
                "demo",
                "--title",
                "stale",
                "--if-revision",
                rev
            ]
        )["error"]["code"],
        "revision_conflict"
    );
    ok(&v, &["paper", "tag", "add", "demo", "methods"]);
    let selected = ok(
        &v,
        &["paper", "list", "--tag", "methods", "--state", "read"],
    );
    assert_eq!(selected["items"][0]["id"], "demo");
    assert!(selected["items"][0].get("abstract").is_none());
    assert!(ok(&v, &["paper", "tag", "list"])
        .to_string()
        .contains("methods"));
    ok(&v, &["paper", "tag", "remove", "demo", "methods"]);
    let row = ok(&v, &["paper", "get", "demo"]);
    ok(
        &v,
        &[
            "paper",
            "tag",
            "set",
            "demo",
            "--clear",
            "--if-revision",
            row["revision"].as_str().unwrap(),
        ],
    );
    assert!(ok(&v, &["paper", "list", "--tag", "methods"])["items"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(fail(&v, &["paper", "note", "fetch", "demo"])["error"]["code"].is_string());
}
#[test]
fn paper_move_updates_filesystem_catalog_and_wiki() {
    let tmp = tempdir().unwrap();
    let vault = tmp.path().join("v");
    create_vault(&vault);
    fs::create_dir_all(vault.join("papers/inbox/demo")).unwrap();
    fs::create_dir_all(vault.join("papers/archive")).unwrap();
    seed_paper(&vault, "papers/inbox/demo", "demo", "Demo");
    fs::write(vault.join("papers/inbox/demo/NOTES.md"), "# Demo\n").unwrap();
    fs::create_dir_all(vault.join("notes")).unwrap();
    fs::write(
        vault.join("notes/source.md"),
        "[[papers/inbox/demo/NOTES]]\n",
    )
    .unwrap();

    let to = "papers/archive/demo";
    let from = "papers/inbox/demo";
    assert_eq!(
        ok(&vault, &["file", "move", from, to, "--dry-run"])["preview"],
        true
    );
    assert!(vault.join(from).is_dir());
    fail(&vault, &["file", "move", from, "../escape"]);
    ok(&vault, &["file", "move", from, to]);
    assert_eq!(
        fs::read_to_string(vault.join("notes/source.md")).unwrap(),
        "[[papers/archive/demo/NOTES]]\n"
    );
    assert_eq!(ok(&vault, &["paper", "get", "demo"])["path"], to);
    fs::create_dir_all(vault.join(from)).unwrap();
    fail(&vault, &["file", "move", to, from]);
}
#[test]
fn paper_cross_vault_organize_preserves_records_and_files() {
    let tmp = tempdir().unwrap();
    let src = tmp.path().join("src");
    let dst = tmp.path().join("dst");
    create_vault(&src);
    create_vault(&dst);
    paper(&src);
    fs::write(src.join("papers/demo/NOTES.md"), "# demo").unwrap();
    ok(&src, &["paper", "link", "demo", "papers/collection"]);
    assert!(src.join("papers/collection/demo/NOTES.md").is_file());
    ok(
        &src,
        &[
            "paper",
            "copy",
            "demo",
            "--to-vault",
            dst.to_str().unwrap(),
            "--into",
            "papers/copied",
        ],
    );
    assert!(dst.join("papers/copied/demo/NOTES.md").is_file());
    let third = tmp.path().join("third");
    create_vault(&third);
    ok(
        &src,
        &[
            "file",
            "move",
            "papers/demo",
            "papers/archive/demo",
            "--to-vault",
            third.to_str().unwrap(),
        ],
    );
    assert!(!src.join("papers/demo").exists());
    assert_eq!(
        ok(&third, &["paper", "get", "demo"])["path"],
        "papers/archive/demo"
    );
}
#[test]
fn remove_restore_and_purge_confirm_actual_files() {
    let tmp = tempdir().unwrap();
    let v = tmp.path().join("v");
    create_vault(&v);
    fs::write(v.join("notes/a.md"), "keep me").unwrap();
    ok(&v, &["file", "remove", "notes/a.md", "--dry-run"]);
    assert!(v.join("notes/a.md").is_file());
    let removed = ok(&v, &["file", "remove", "notes/a.md"]);
    let id = removed["items"][0]["id"].as_str().unwrap();
    assert!(!v.join("notes/a.md").exists());
    assert_eq!(ok(&v, &["file", "trash", "list"])["items"][0]["id"], id);
    ok(&v, &["file", "trash", "restore", id]);
    assert_eq!(fs::read_to_string(v.join("notes/a.md")).unwrap(), "keep me");
    let removed = ok(&v, &["file", "remove", "notes/a.md"]);
    let id = removed["items"][0]["id"].as_str().unwrap();
    fail(&v, &["file", "trash", "purge", id]);
    ok(&v, &["file", "trash", "purge", id, "--dry-run"]);
    ok(&v, &["file", "trash", "purge", id, "--yes"]);
    assert!(ok(&v, &["file", "trash", "list"])["items"]
        .as_array()
        .unwrap()
        .is_empty());
}
#[test]
fn doctor_wiki_check_reports_semantic_issues_and_honors_file_scope() {
    let tmp = tempdir().unwrap();
    let vault = tmp.path().join("v");
    create_vault(&vault);
    fs::create_dir_all(vault.join("notes/a")).unwrap();
    fs::create_dir_all(vault.join("notes/b")).unwrap();
    fs::write(vault.join("notes/Target.md"), "# Existing\n").unwrap();
    fs::write(vault.join("notes/a/Topic.md"), "# A\n").unwrap();
    fs::write(vault.join("notes/b/Topic.md"), "# B\n").unwrap();
    fs::write(vault.join("notes/Clean.md"), "[[Target]]\n").unwrap();
    let broken_source = "[[Target]]\n[[Missing]]\n[[Topic]]\n[[Target#Gone]]\n";
    fs::write(vault.join("notes/Broken.md"), broken_source).unwrap();
    fs::create_dir_all(vault.join("papers/demo")).unwrap();
    fs::write(
        vault.join("papers/demo/PAPER.md"),
        "[web](chat.openai.com)\n[[MissingFromPaper]]\n",
    )
    .unwrap();

    let clean = ok(
        &vault,
        &[
            "vault",
            "check",
            "--area",
            "links",
            "--under",
            "notes/Clean.md",
        ],
    );
    assert_eq!(clean["ok"], true);
    let broken = fail(
        &vault,
        &[
            "vault",
            "check",
            "--area",
            "links",
            "--under",
            "notes/Broken.md",
        ],
    );
    let detail = &broken["error"]["details"]["findings"][0]["details"];
    for key in ["resolved", "missing", "ambiguous", "invalidFragment"] {
        assert_eq!(detail["counts"][key], 1);
    }
    assert_eq!(detail["issues"].as_array().unwrap().len(), 3);
    assert_eq!(
        fs::read_to_string(vault.join("notes/Broken.md")).unwrap(),
        broken_source
    );
    ok(
        &vault,
        &[
            "vault",
            "check",
            "--area",
            "links",
            "--under",
            "papers/demo/PAPER.md",
        ],
    );
}
#[test]
fn doctor_alias_fix_is_confirmed_preserves_content_and_is_idempotent() {
    let tmp = tempdir().unwrap();
    let vault = tmp.path().join("v");
    create_vault(&vault);

    let notes_path = vault.join("papers/demo/NOTES.md");
    fs::create_dir_all(notes_path.parent().unwrap()).unwrap();
    let original = concat!(
        "---\n",
        "title: Keep this value\n",
        "aliases:\n",
        "  - \"Custom Alias\"\n",
        "# keep this comment\n",
        "tags: [nlp, important]\n",
        "---\n",
        "# Demo\n\n",
        "Body sentinel.\n",
    );
    fs::write(&notes_path, original).unwrap();
    seed_paper(&vault, "papers/demo", "demo", "Attention Is All You Need");

    let chinese_notes_path = vault.join("papers/zh/NOTES.md");
    fs::create_dir_all(chinese_notes_path.parent().unwrap()).unwrap();
    let chinese_original = "# 中文笔记\n\n正文保持不变。\n";
    fs::write(&chinese_notes_path, chinese_original).unwrap();
    seed_paper(&vault, "papers/zh", "zh", "一种新的研究方法");
    set_paper_authors_and_year(&vault, "papers/zh", r#"["张三"]"#, 2024);

    let preview = ok(&vault, &["vault", "repair", "aliases"]);
    assert!(preview.to_string().contains("AIAYN"));
    assert!(preview.to_string().contains("张三 2024"));
    assert_eq!(fs::read_to_string(&notes_path).unwrap(), original);
    ok(&vault, &["vault", "repair", "aliases", "--apply"]);
    let updated = fs::read_to_string(&notes_path).unwrap();
    assert!(updated.contains("  - \"Custom Alias\"\n"));
    assert!(updated.contains("  - \"Attention Is All You Need\"\n"));
    assert!(updated.contains("  - \"AIAYN\"\n"));
    assert!(updated.contains("title: Keep this value\n"));
    assert!(updated.contains("# keep this comment\n"));
    assert!(updated.contains("tags: [nlp, important]\n"));
    assert!(updated.ends_with("# Demo\n\nBody sentinel.\n"));

    let chinese_updated = fs::read_to_string(&chinese_notes_path).unwrap();
    assert!(chinese_updated.contains("  - \"一种新的研究方法\"\n"));
    assert!(chinese_updated.contains("  - \"张三 2024\"\n"));
    assert!(chinese_updated.ends_with(chinese_original));

    ok(&vault, &["vault", "repair", "aliases", "--apply"]);
    assert_eq!(fs::read_to_string(&notes_path).unwrap(), updated);
    assert_eq!(
        fs::read_to_string(&chinese_notes_path).unwrap(),
        chinese_updated
    );
}
/// Minimal catalog seed without Translator (mirrors papers table columns used by list/get).
fn seed_paper(vault: &Path, path: &str, id: &str, title: &str) {
    use std::process::Command;
    // Prefer embedding via agentero_lib in a helper binary — for tests, call sqlite3 if present,
    // else use a tiny Rust approach: write through the same ensure_catalog by invoking a one-off.
    // We use the `agentero` crate isn't linked in tests, so open with rusqlite via shell to the CLI's
    // dependency is awkward. Use `sqlite3` CLI if available; otherwise write SQL with a small rustc —
    // simplest: use the fact that catalog is created and insert with `rusqlite` as a build-dep.
    //
    // assert_cmd tests cannot depend on agentero_lib easily without [dev-dependencies] path.
    // Add rusqlite as dev-dep... already only assert_cmd. Use std::process + python?
    // Fastest robust approach: add agentero_lib as dev-dependency — already transitive.
    // We'll use raw SQL via the `sqlite3` binary, with fallback to writing a metadata-only approach.
    let db = vault.join(".agentero").join("catalog.sqlite");
    let now = "2020-01-01T00:00:00.000Z";
    let sql = format!(
        "INSERT INTO papers (path, id, type, title, authors_json, tags_json, status, added_at, updated_at, is_read)
         VALUES ('{path}', '{id}', 'article', '{title}', '[]', '[]', 'completed', '{now}', '{now}', 0);"
    );
    let status = Command::new("sqlite3").arg(&db).arg(&sql).status();
    if status.map(|s| s.success()).unwrap_or(false) {
        return;
    }
    // Fallback: use Python sqlite3 stdlib
    let py = format!(
        r#"import sqlite3; c=sqlite3.connect(r"{db}"); c.execute({sql:?}); c.commit()"#,
        db = db.display(),
        sql = sql
    );
    let status = Command::new("python3").args(["-c", &py]).status().unwrap();
    assert!(status.success(), "failed to seed catalog");
}

fn set_tags_json(vault: &Path, path: &str, tags_json: &str) {
    use std::process::Command;
    let db = vault.join(".agentero").join("catalog.sqlite");
    let sql = format!(
        "UPDATE papers SET tags_json = '{tags_json}' WHERE path = '{path}';",
        tags_json = tags_json.replace('\'', "''"),
        path = path.replace('\'', "''"),
    );
    let status = Command::new("sqlite3").arg(&db).arg(&sql).status();
    if status.map(|s| s.success()).unwrap_or(false) {
        return;
    }
    let py = format!(
        r#"import sqlite3; c=sqlite3.connect(r"{db}"); c.execute("UPDATE papers SET tags_json = ? WHERE path = ?", ({tags:?}, {path:?})); c.commit()"#,
        db = db.display(),
        tags = tags_json,
        path = path,
    );
    let status = Command::new("python3").args(["-c", &py]).status().unwrap();
    assert!(status.success(), "failed to update tags");
}

fn set_paper_authors_and_year(vault: &Path, path: &str, authors_json: &str, year: i32) {
    use std::process::Command;
    let db = vault.join(".agentero").join("catalog.sqlite");
    let sql = format!(
        "UPDATE papers SET authors_json = '{authors_json}', year = {year} WHERE path = '{path}';",
        authors_json = authors_json.replace('\'', "''"),
        path = path.replace('\'', "''"),
    );
    let status = Command::new("sqlite3").arg(&db).arg(&sql).status();
    if status.map(|s| s.success()).unwrap_or(false) {
        return;
    }
    let py = format!(
        r#"import sqlite3; c=sqlite3.connect(r"{db}"); c.execute("UPDATE papers SET authors_json = ?, year = ? WHERE path = ?", ({authors:?}, {year}, {path:?})); c.commit()"#,
        db = db.display(),
        authors = authors_json,
        path = path,
    );
    let status = Command::new("python3").args(["-c", &py]).status().unwrap();
    assert!(status.success(), "failed to update paper metadata");
}

#[test]
fn layout_list_and_mark_add_region() {
    let tmp = tempdir().unwrap();
    let vault = tmp.path().join("v");
    create_vault(&vault);

    let paper = vault.join("papers").join("demo");
    fs::create_dir_all(paper.join("source")).unwrap();
    fs::write(paper.join("NOTES.md"), "# Demo\n").unwrap();
    // Region geometry is normalized; the CLI measures the page with the PDF
    // engine before writing highlight annotations.
    fs::write(
        paper.join("demo.pdf"),
        tiny_pdf_pages(&[
            "Table 1 baseline results",
            "Figure 3 attention heads",
            "Equation one follows here",
        ]),
    )
    .unwrap();
    seed_paper(&vault, "papers/demo", "demo", "Demo Paper");

    fail(&vault, &["paper", "regions", "demo"]);
    let index = serde_json::json!({
        "schemaVersion": 1,
        "source": {
            "mode": "sidebar",
            "from": "layout.json",
            "generatedAt": "2026-01-01T00:00:00.000Z",
            "minScore": 0.3
        },
        "items": [
            {
                "id": "figure-3",
                "stableKey": "p2:figure:Figure 3: Heads",
                "kind": "image",
                "section": "figure",
                "page": 2,
                "pageIndex": 1,
                "bbox": { "x": 0.1, "y": 0.2, "w": 0.5, "h": 0.3 },
                "score": 0.95,
                "title": "Figure 3: Heads",
                "layoutRegionId": "raw-fig-3"
            },
            {
                "id": "table-1",
                "stableKey": "p1:table:Table 1",
                "kind": "table",
                "section": "table",
                "page": 1,
                "pageIndex": 0,
                "bbox": { "x": 0.05, "y": 0.1, "w": 0.9, "h": 0.2 },
                "score": 0.88,
                "title": "Table 1",
                "layoutRegionId": "raw-tab-1"
            },
            {
                "id": "formula-p3-abc",
                "stableKey": "p3:formula:0.2_0.4_0.4_0.05",
                "kind": "formula",
                "section": "formula",
                "page": 3,
                "pageIndex": 2,
                "bbox": { "x": 0.2, "y": 0.4, "w": 0.4, "h": 0.05 },
                "score": 0.8,
                "layoutRegionId": "raw-eq-1"
            }
        ]
    });
    fs::write(
        paper.join("source").join("layout-index.json"),
        format!("{}\n", serde_json::to_string_pretty(&index).unwrap()),
    )
    .unwrap();

    let found = ok(&vault, &["paper", "regions", "demo", "--page", "2"]);
    assert_eq!(found["items"][0]["region"], "figure-3");
    let ask = ok(
        &vault,
        &[
            "annotation",
            "add",
            "demo",
            "--region",
            "figure-3",
            "--kind",
            "ask",
            "--question",
            "Why these heads?",
        ],
    );
    assert!(ask.to_string().contains("Why these heads?"));
    let translated = ok(
        &vault,
        &[
            "annotation",
            "add",
            "demo",
            "--quote",
            "Figure 3 attention heads",
            "--kind",
            "translate",
            "--language",
            "zh",
            "--translation",
            "注意力头",
        ],
    );
    assert!(translated.to_string().contains("注意力头"));
    let out = ok(
        &vault,
        &[
            "annotation",
            "add",
            "demo",
            "--region",
            "table-1",
            "--comment",
            "from region",
        ],
    );
    assert!(out.to_string().contains("from region"));
}
#[test]
fn layout_list_section_from_raw_layout() {
    let tmp = tempdir().unwrap();
    let vault = tmp.path().join("v");
    create_vault(&vault);

    let paper = vault.join("papers").join("demo");
    fs::create_dir_all(paper.join("source")).unwrap();
    fs::write(paper.join("NOTES.md"), "# Demo\n").unwrap();
    fs::write(
        paper.join("demo.pdf"),
        tiny_pdf_pages(&["Page one", "Page two"]),
    )
    .unwrap();
    seed_paper(&vault, "papers/demo", "demo", "Demo Paper");

    let index = serde_json::json!({
        "schemaVersion": 1,
        "source": {"mode": "sidebar", "from": "layout.json", "generatedAt": "2026-01-01T00:00:00.000Z", "minScore": 0.3},
        "items": [
            {"id":"figure-1","stableKey":"a","kind":"image","section":"figure","page":2,"pageIndex":1,"bbox":{"x":0.1,"y":0.2,"w":0.5,"h":0.3},"score":0.9,"title":"Figure 1","layoutRegionId":"raw-fig-1"}
        ]
    });
    fs::write(
        paper.join("source").join("layout-index.json"),
        format!("{}\n", serde_json::to_string_pretty(&index).unwrap()),
    )
    .unwrap();

    let raw = serde_json::json!({
        "schemaVersion": 3,
        "source": {"mode": "embedpdf-layout", "generatedAt": "2026-01-01T00:00:00.000Z"},
        "regions": [
            {"id":"h1","pageIndex":0,"kind":"header","score":0.95,"bbox":{"x":0.1,"y":0.1,"w":0.8,"h":0.05},"title":"1 Introduction"},
            {"id":"h2","pageIndex":1,"kind":"header","score":0.92,"bbox":{"x":0.1,"y":0.1,"w":0.8,"h":0.05},"title":"2 Method"}
        ]
    });
    fs::write(
        paper.join("source").join("layout.json"),
        format!("{}\n", serde_json::to_string_pretty(&raw).unwrap()),
    )
    .unwrap();

    let result = ok(&vault, &["paper", "regions", "demo", "--kind", "section"]);
    assert_eq!(result["items"].as_array().unwrap().len(), 2);
}
#[test]
fn mark_add_quote_locates_text_and_writes_annotation() {
    let tmp = tempdir().unwrap();
    let vault = tmp.path().join("v");
    create_vault(&vault);

    let paper = vault.join("papers").join("attn");
    fs::create_dir_all(&paper).unwrap();
    fs::write(paper.join("NOTES.md"), "# Attn\n").unwrap();
    fs::write(
        paper.join("attn.pdf"),
        tiny_pdf_pages(&["Attention is all you need", "We propose a novel mechanism"]),
    )
    .unwrap();
    seed_paper(&vault, "papers/attn", "attn", "Attention");

    let added = ok(
        &vault,
        &[
            "annotation",
            "add",
            "attn",
            "--quote",
            "novel mechanism",
            "--comment",
            "核心贡献",
            "--mark-color",
            "green",
        ],
    );
    let id = added["items"][0]["id"].as_str().unwrap();
    let items: Value = serde_json::from_str(
        &fs::read_to_string(paper.join("marks").join("annotations.json")).unwrap(),
    )
    .unwrap();
    let anno = &items.as_array().unwrap()[0]["annotation"];
    assert_eq!(anno["id"], id);
    assert_eq!(anno["pageIndex"], 1); // second page
    assert_eq!(anno["contents"], "核心贡献");
    assert_eq!(anno["strokeColor"], "#86efac"); // HIGHLIGHT_HEX.green
    let seg = &anno["segmentRects"][0];
    let x = seg["origin"]["x"].as_f64().unwrap();
    let y = seg["origin"]["y"].as_f64().unwrap();
    // Text is drawn at 20,60 in PDF space on a 100pt page → top-left y ≈ 28.
    assert!(x > 10.0 && x < 200.0, "x {x}");
    assert!(y > 10.0 && y < 50.0, "y {y}");

    fail(
        &vault,
        &[
            "annotation",
            "add",
            "attn",
            "--quote",
            "this text is absent",
        ],
    );
    let fetched = ok(&vault, &["annotation", "get", "attn", "--", id]);
    let u = ok(
        &vault,
        &[
            "annotation",
            "update",
            "attn",
            "--comment",
            "updated",
            "--if-revision",
            fetched["revision"].as_str().unwrap(),
            "--",
            id,
        ],
    );
    assert_eq!(u["comment"], "updated");
    fail(
        &vault,
        &[
            "annotation",
            "remove",
            "attn",
            "--if-revision",
            "stale",
            "--",
            id,
        ],
    );
    ok(
        &vault,
        &[
            "annotation",
            "remove",
            "attn",
            "--if-revision",
            u["revision"].as_str().unwrap(),
            "--",
            id,
        ],
    );
    assert!(ok(&vault, &["annotation", "list", "attn"])["items"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_ne!(
        fail(&vault, &["annotation", "get", "attn", "--", "-abc"])["error"]["code"],
        "usage"
    );
}
#[test]
fn import_pdf_single_and_batch() {
    let tmp = tempdir().unwrap();
    let vault = tmp.path().join("v");
    create_vault(&vault);

    let pdf_bytes = tiny_pdf_pages(&["Attention is all you need"]);
    let pdf1_path = tmp.path().join("attention-paper.pdf");
    fs::write(&pdf1_path, &pdf_bytes).unwrap();

    let pdf2_path = tmp.path().join("bert-paper.pdf");
    fs::write(&pdf2_path, &pdf_bytes).unwrap();

    let one = ok(
        &vault,
        &[
            "paper",
            "import",
            "pdf",
            pdf1_path.to_str().unwrap(),
            "--no-recognize",
        ],
    );
    assert_eq!(one["items"].as_array().unwrap().len(), 1);
    let many = ok(
        &vault,
        &[
            "paper",
            "import",
            "pdf",
            pdf1_path.to_str().unwrap(),
            pdf2_path.to_str().unwrap(),
            "--into",
            "papers/batch",
            "--no-recognize",
        ],
    );
    assert_eq!(many["items"].as_array().unwrap().len(), 2);
    for item in many["items"].as_array().unwrap() {
        assert!(vault.join(item["path"].as_str().unwrap()).is_dir());
    }
}
