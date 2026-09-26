//! Integration tests for agentero CLI MVP (offline; no Translator).

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
        .args(["vault", "create", dir.to_str().unwrap(), "--json"])
        .assert()
        .success()
        .stdout(predicate::str::contains("\"ok\":true"));
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

#[test]
fn vault_create_and_list() {
    let tmp = tempdir().unwrap();
    let vault = tmp.path().join("v");
    let home = create_vault(&vault);

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

    let list = agentero()
        .env("HOME", &home)
        .args(["vault", "list", "--json"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: Value = serde_json::from_slice(&list).unwrap();
    assert_eq!(v["ok"], true);
    let vaults = v["data"]["vaults"].as_array().unwrap();
    assert!(
        vaults
            .iter()
            .any(|entry| entry["path"].as_str().unwrap().contains("v")),
        "vault list should contain the newly created vault"
    );
}

#[test]
fn describe_lists_ops_and_resolves_one() {
    let listed = agentero()
        .args(["describe", "--json"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: Value = serde_json::from_slice(&listed).unwrap();
    assert_eq!(v["ok"], true);
    let ops = v["data"]["ops"].as_array().unwrap();
    assert!(ops.iter().any(|o| o["id"] == "paper.list"));
    assert!(ops.iter().any(|o| o["id"] == "layout.list"));
    assert!(ops.iter().any(|o| o["mcpTool"] == "paper_list"));

    let one = agentero()
        .args(["describe", "paper.list", "--json"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: Value = serde_json::from_slice(&one).unwrap();
    assert_eq!(v["ok"], true);
    assert_eq!(v["data"]["id"], "paper.list");
    assert_eq!(v["data"]["cli"], "agentero paper list");
    assert!(v["data"]["input"].is_object());
    assert!(v["data"]["output"].is_object());
    assert!(!v["data"]["examples"].as_array().unwrap().is_empty());

    let by_mcp = agentero()
        .args(["describe", "paper_list", "--json"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: Value = serde_json::from_slice(&by_mcp).unwrap();
    assert_eq!(v["data"]["id"], "paper.list");

    let bad = agentero()
        .args(["describe", "no.such.op", "--json"])
        .assert()
        .failure()
        .get_output()
        .stdout
        .clone();
    let v: Value = serde_json::from_slice(&bad).unwrap();
    assert_eq!(v["ok"], false);
    assert_eq!(v["error"]["code"], "usage");
}

#[test]
fn paper_list_empty_and_set_read_not_found() {
    let tmp = tempdir().unwrap();
    let vault = tmp.path().join("v");
    create_vault(&vault);

    let out = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "list",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["ok"], true);
    assert!(v["data"].as_array().unwrap().is_empty());

    agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "get",
            "nope",
            "--json",
        ])
        .assert()
        .failure()
        .stdout(predicate::str::contains("paper_not_found"));
}

#[test]
fn paper_crud_catalog_only() {
    let tmp = tempdir().unwrap();
    let vault = tmp.path().join("v");
    create_vault(&vault);

    // Seed a catalog row via service path: write minimal paper folder + use SQL through second create
    // Insert via agentero is only import (network). Seed with direct SQLite for unit-ish coverage.
    let paper = vault.join("papers").join("demo");
    fs::create_dir_all(&paper).unwrap();
    fs::write(paper.join("NOTES.md"), "# Demo\n").unwrap();

    // Use `agentero` only for operations that hit services — seed with rusqlite in-process via
    // creating through vault is enough if we call paper list after manual catalog upsert.
    // Here we shell out to a tiny approach: open catalog and insert like Host would.
    seed_paper(&vault, "papers/demo", "demo", "Demo Paper");

    let list = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "list",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: Value = serde_json::from_slice(&list).unwrap();
    assert_eq!(v["data"].as_array().unwrap().len(), 1);
    assert_eq!(v["data"][0]["id"], "demo");

    let get = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "get",
            "demo",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: Value = serde_json::from_slice(&get).unwrap();
    assert_eq!(v["data"]["paper"]["title"], "Demo Paper");
    assert!(v["data"]["assets"]["notesMd"].as_bool().unwrap());
    assert_eq!(v["data"]["assets"]["marksDir"], false);
    let reads = v["data"]["suggestedReads"].as_array().unwrap();
    assert!(reads
        .iter()
        .any(|r| r.as_str() == Some("papers/demo/NOTES.md")));

    // Reader marks dir → assets.marksDir + suggestedReads / paths
    fs::create_dir_all(paper.join("marks")).unwrap();
    fs::write(
        paper.join("marks").join("hl-1.json"),
        r#"{"version":1,"kind":"highlight","id":"hl-1"}"#,
    )
    .unwrap();

    let get_marks = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "get",
            "demo",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: Value = serde_json::from_slice(&get_marks).unwrap();
    assert!(v["data"]["assets"]["marksDir"].as_bool().unwrap());
    let reads = v["data"]["suggestedReads"].as_array().unwrap();
    assert!(reads
        .iter()
        .any(|r| r.as_str() == Some("papers/demo/marks")));

    let paths = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "paths",
            "demo",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: Value = serde_json::from_slice(&paths).unwrap();
    let path_list = v["data"].as_array().unwrap();
    assert!(path_list
        .iter()
        .any(|p| p.as_str() == Some("papers/demo/NOTES.md")));
    assert!(path_list
        .iter()
        .any(|p| p.as_str() == Some("papers/demo/marks")));

    agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "set-read",
            "demo",
            "--json",
        ])
        .assert()
        .success();

    let get2 = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "get",
            "papers/demo",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: Value = serde_json::from_slice(&get2).unwrap();
    assert_eq!(v["data"]["paper"]["is_read"], true);

    // Tags: replace → list filter → add → rm → tag list inventory
    agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "tag",
            "set",
            "demo",
            "nlp",
            "survey",
            "--json",
        ])
        .assert()
        .success();

    let tagged = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "list",
            "--tag",
            "NLP",
            "--full",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: Value = serde_json::from_slice(&tagged).unwrap();
    assert_eq!(v["data"].as_array().unwrap().len(), 1);
    assert_eq!(v["data"][0]["tags"][0], "nlp");
    assert_eq!(v["data"][0]["tags"][1], "survey");

    let no_tag = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "list",
            "--tag",
            "missing",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: Value = serde_json::from_slice(&no_tag).unwrap();
    assert!(v["data"].as_array().unwrap().is_empty());

    agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "tag",
            "add",
            "demo",
            "draft",
            "--json",
        ])
        .assert()
        .success();
    agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "tag",
            "rm",
            "demo",
            "survey",
            "--json",
        ])
        .assert()
        .success();

    let get_tags = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "get",
            "demo",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: Value = serde_json::from_slice(&get_tags).unwrap();
    let tags = v["data"]["paper"]["tags"].as_array().unwrap();
    assert!(tags.iter().any(|t| t.as_str() == Some("nlp")));
    assert!(tags.iter().any(|t| t.as_str() == Some("draft")));
    assert!(!tags.iter().any(|t| t.as_str() == Some("survey")));

    agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "tag",
            "add",
            "demo",
            "colored:red",
            "colon:name",
            "--json",
        ])
        .assert()
        .success();
    let colored = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "get",
            "demo",
            "--all",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let colored: Value = serde_json::from_slice(&colored).unwrap();
    let tags = colored["data"]["paper"]["tags"].as_array().unwrap();
    assert!(tags
        .iter()
        .any(|t| t["name"] == "colored" && t["color"] == "red"));
    assert!(tags.iter().any(|t| t.as_str() == Some("colon:name")));

    set_tags_json(
        &vault,
        "papers/demo",
        r#"["nlp","draft",{"name":"@zotero:imported"},{"name":"Computer Science - Machine Learning"}]"#,
    );
    let hidden = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "list",
            "--tag",
            "@zotero:imported",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let hidden: Value = serde_json::from_slice(&hidden).unwrap();
    assert!(hidden["data"].as_array().unwrap().is_empty());

    let all = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "list",
            "--tag",
            "@zotero:imported",
            "--all",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let all: Value = serde_json::from_slice(&all).unwrap();
    assert_eq!(all["data"].as_array().unwrap().len(), 1);

    let arxiv_hidden = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "list",
            "--tag",
            "Computer Science - Machine Learning",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let arxiv_hidden: Value = serde_json::from_slice(&arxiv_hidden).unwrap();
    assert!(arxiv_hidden["data"].as_array().unwrap().is_empty());

    let arxiv_all = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "list",
            "--tag",
            "Computer Science - Machine Learning",
            "--all",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let arxiv_all: Value = serde_json::from_slice(&arxiv_all).unwrap();
    assert_eq!(arxiv_all["data"].as_array().unwrap().len(), 1);

    let tags_idx = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "tag",
            "list",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: Value = serde_json::from_slice(&tags_idx).unwrap();
    let items = v["data"]["items"].as_array().unwrap();
    assert!(items
        .iter()
        .any(|it| { it["tag"].as_str() == Some("nlp") && it["count"].as_u64() == Some(1) }));
    assert!(items
        .iter()
        .any(|it| { it["tag"].as_str() == Some("draft") && it["count"].as_u64() == Some(1) }));
    assert!(!items
        .iter()
        .any(|it| it["tag"].as_str() == Some("Computer Science - Machine Learning")));
    assert!(!items
        .iter()
        .any(|it| it["tag"].as_str() == Some("@zotero:imported")));

    // clear requires --clear (empty args alone is a usage error)
    agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "tag",
            "set",
            "demo",
            "--json",
        ])
        .assert()
        .failure();
    agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "tag",
            "set",
            "demo",
            "--clear",
            "--json",
        ])
        .assert()
        .success();

    // Delete moves the paper to the recycle bin (desktop can restore it).
    // CLI no longer exposes trash management commands.
    agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "delete",
            "papers/demo",
            "--json",
        ])
        .assert()
        .success();
    assert!(!paper.exists());

    let list2 = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "list",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: Value = serde_json::from_slice(&list2).unwrap();
    assert_eq!(v["data"].as_array().unwrap().len(), 0);
}

#[test]
fn paper_list_json_slim_by_default_fields_and_full() {
    let tmp = tempdir().unwrap();
    let vault = tmp.path().join("v");
    create_vault(&vault);
    seed_paper(&vault, "papers/demo", "demo", "Demo Paper");

    // Default: only id/path/title, compact single line (token-cheap for agents).
    let out = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "list",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    assert_eq!(String::from_utf8_lossy(&out).trim().lines().count(), 1);
    let v: Value = serde_json::from_slice(&out).unwrap();
    let row = &v["data"][0];
    let mut keys: Vec<&str> = row
        .as_object()
        .unwrap()
        .keys()
        .map(|k| k.as_str())
        .collect();
    keys.sort();
    assert_eq!(keys, ["id", "path", "title"]);

    // --fields adds requested keys on top of id/path/title.
    let out = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "list",
            "--fields",
            "status,is_read",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: Value = serde_json::from_slice(&out).unwrap();
    let row = &v["data"][0];
    assert_eq!(row["status"], "completed");
    assert_eq!(row["is_read"], false);

    // --full restores the whole PaperRecord.
    let out = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "list",
            "--full",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: Value = serde_json::from_slice(&out).unwrap();
    assert!(v["data"][0]["added_at"].as_str().is_some());

    // Unknown field → usage error.
    agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "list",
            "--fields",
            "nope",
            "--json",
        ])
        .assert()
        .failure()
        .stdout(predicate::str::contains("unknown field"));

    // --pretty opts back into indented JSON.
    agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "--pretty",
            "paper",
            "list",
            "--json",
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains("\"ok\": true"));
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

    agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "move",
            "papers/inbox/demo",
            "papers/archive",
            "--json",
        ])
        .assert()
        .success();

    assert!(!vault.join("papers/inbox/demo").exists());
    assert!(vault.join("papers/archive/demo").is_dir());
    assert_eq!(
        fs::read_to_string(vault.join("notes/source.md")).unwrap(),
        "[[papers/archive/demo/NOTES]]\n"
    );
    agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "move",
            "papers/archive/demo",
            "papers/archive",
            "--json",
        ])
        .assert()
        .success();
    let listed = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "list",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let listed: Value = serde_json::from_slice(&listed).unwrap();
    assert_eq!(listed["data"][0]["path"], "papers/archive/demo");
}

/// Cross-vault paper move: vault-prefixed paths migrate the directory and catalog record.
#[test]
fn paper_move_cross_vault_migrates_directory_and_catalog() {
    let tmp = tempdir().unwrap();
    let src = tmp.path().join("src");
    let dst = tmp.path().join("dst");
    create_vault(&src);
    create_vault(&dst);
    fs::create_dir_all(src.join("papers/inbox/demo")).unwrap();
    seed_paper(&src, "papers/inbox/demo", "demo", "Demo");

    agentero()
        .args([
            "paper",
            "move",
            src.join("papers/inbox/demo").to_str().unwrap(),
            dst.join("papers/archive").to_str().unwrap(),
            "--json",
        ])
        .assert()
        .success();

    assert!(!src.join("papers/inbox/demo").exists());
    assert!(dst.join("papers/archive/demo").is_dir());

    let src_list = agentero()
        .args(["--vault", src.to_str().unwrap(), "paper", "list", "--json"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let src_list: Value = serde_json::from_slice(&src_list).unwrap();
    assert!(src_list["data"].as_array().unwrap().is_empty());

    let dst_list = agentero()
        .args(["--vault", dst.to_str().unwrap(), "paper", "list", "--json"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let dst_list: Value = serde_json::from_slice(&dst_list).unwrap();
    assert_eq!(dst_list["data"][0]["path"], "papers/archive/demo");
    assert_eq!(dst_list["data"][0]["id"], "demo");
}

/// #166: create missing destination parent, reject conflict and path escape.
#[test]
fn paper_move_creates_parent_rejects_conflict_and_escape() {
    let tmp = tempdir().unwrap();
    let vault = tmp.path().join("v");
    create_vault(&vault);
    fs::create_dir_all(vault.join("papers/inbox/demo")).unwrap();
    seed_paper(&vault, "papers/inbox/demo", "demo", "Demo");

    // Missing dest parent is created.
    agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "move",
            "papers/inbox/demo",
            "papers/new-shelf",
            "--json",
        ])
        .assert()
        .success();
    assert!(vault.join("papers/new-shelf/demo").is_dir());
    assert!(vault.join("papers/new-shelf").is_dir());
    let listed = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "list",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let listed: Value = serde_json::from_slice(&listed).unwrap();
    assert_eq!(listed["data"][0]["path"], "papers/new-shelf/demo");

    // Conflict: destination already occupied.
    fs::create_dir_all(vault.join("papers/other/demo")).unwrap();
    seed_paper(&vault, "papers/other/demo", "other", "Other");
    agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "move",
            "papers/other/demo",
            "papers/new-shelf",
            "--json",
        ])
        .assert()
        .failure()
        .stdout(predicate::str::contains("already exists"));

    // Escape: destination must stay under papers/.
    agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "move",
            "papers/new-shelf/demo",
            "notes",
            "--json",
        ])
        .assert()
        .failure()
        .stdout(predicate::str::contains("papers/"));
}

#[test]
fn open_path_shorthand_and_explicit_dry_run() {
    let tmp = tempdir().unwrap();
    let dir = tmp.path().join("research");
    fs::create_dir_all(&dir).unwrap();

    let out = agentero()
        .env("AGENTERO_OPEN_DRY_RUN", "1")
        .args(["open", dir.to_str().unwrap(), "--json"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["ok"], true);
    assert_eq!(v["data"]["dryRun"], true);
    assert!(v["data"]["url"]
        .as_str()
        .unwrap()
        .starts_with("agentero://open?path="));

    // Shorthand rewrite: bare directory path → open
    let out2 = agentero()
        .env("AGENTERO_OPEN_DRY_RUN", "1")
        .args([dir.to_str().unwrap(), "--json"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v2: Value = serde_json::from_slice(&out2).unwrap();
    assert_eq!(v2["ok"], true);
    assert_eq!(v2["data"]["dryRun"], true);

    agentero()
        .env("AGENTERO_OPEN_DRY_RUN", "1")
        .args(["open", "/no/such/agentero/path", "--json"])
        .assert()
        .failure()
        .stdout(predicate::str::contains("does not exist"));
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

    let clean = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "doctor",
            "wiki",
            "notes/Clean.md",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let clean: Value = serde_json::from_slice(&clean).unwrap();
    assert_eq!(clean["ok"], true);
    assert_eq!(clean["data"]["checkedFiles"], 1);
    assert_eq!(clean["data"]["counts"]["resolved"], 1);
    assert!(clean["data"]["issues"].as_array().unwrap().is_empty());

    let broken = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "doctor",
            "wiki",
            "notes/Broken.md",
            "--json",
        ])
        .assert()
        .failure()
        .get_output()
        .stdout
        .clone();
    let broken: Value = serde_json::from_slice(&broken).unwrap();
    assert_eq!(broken["ok"], false);
    assert_eq!(broken["error"]["code"], "wikilink_check_failed");
    assert_eq!(broken["error"]["details"]["checkedFiles"], 1);
    assert_eq!(broken["error"]["details"]["counts"]["resolved"], 1);
    assert_eq!(broken["error"]["details"]["counts"]["missing"], 1);
    assert_eq!(broken["error"]["details"]["counts"]["ambiguous"], 1);
    assert_eq!(broken["error"]["details"]["counts"]["invalidFragment"], 1);
    assert_eq!(
        broken["error"]["details"]["issues"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(
        fs::read_to_string(vault.join("notes/Broken.md")).unwrap(),
        broken_source
    );

    let paper = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "doctor",
            "wiki",
            "papers/demo/PAPER.md",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let paper: Value = serde_json::from_slice(&paper).unwrap();
    assert_eq!(paper["data"]["checkedFiles"], 0);
    assert!(paper["data"]["issues"].as_array().unwrap().is_empty());
}

#[test]
fn delete_files_requires_yes() {
    let tmp = tempdir().unwrap();
    let vault = tmp.path().join("v");
    create_vault(&vault);
    let paper = vault.join("papers").join("x");
    fs::create_dir_all(&paper).unwrap();
    seed_paper(&vault, "papers/x", "x", "X");

    agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "paper",
            "delete",
            "papers/x",
            "--files",
            "--json",
        ])
        .assert()
        .failure()
        .stdout(predicate::str::contains("needs_confirmation"));

    agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "-y",
            "paper",
            "delete",
            "papers/x",
            "--files",
            "--json",
        ])
        .assert()
        .success();
    assert!(!paper.exists());
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

    let check = agentero()
        .args(["--vault", vault.to_str().unwrap(), "doctor", "--json"])
        .assert()
        .failure()
        .get_output()
        .stdout
        .clone();
    let check: Value = serde_json::from_slice(&check).unwrap();
    assert_eq!(check["error"]["code"], "doctor_issues");
    let candidates = check["error"]["details"]["aliases"]["candidates"]
        .as_array()
        .unwrap();
    let english = candidates
        .iter()
        .find(|candidate| candidate["path"] == "papers/demo/NOTES.md")
        .unwrap();
    assert_eq!(english["titleAlias"], "Attention Is All You Need");
    assert_eq!(english["shortAlias"], "AIAYN");
    assert_eq!(english["currentAliases"][0], "Custom Alias");
    let chinese = candidates
        .iter()
        .find(|candidate| candidate["path"] == "papers/zh/NOTES.md")
        .unwrap();
    assert_eq!(chinese["titleAlias"], "一种新的研究方法");
    assert_eq!(chinese["shortAlias"], "张三 2024");
    assert_eq!(fs::read_to_string(&notes_path).unwrap(), original);
    assert_eq!(
        fs::read_to_string(&chinese_notes_path).unwrap(),
        chinese_original
    );

    let confirmation = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "doctor",
            "fix",
            "aliases",
            "--json",
        ])
        .assert()
        .code(4)
        .get_output()
        .stdout
        .clone();
    let confirmation: Value = serde_json::from_slice(&confirmation).unwrap();
    assert_eq!(confirmation["error"]["code"], "needs_confirmation");
    assert_eq!(fs::read_to_string(&notes_path).unwrap(), original);

    let repaired = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "--yes",
            "doctor",
            "fix",
            "aliases",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let repaired: Value = serde_json::from_slice(&repaired).unwrap();
    let updated_paths = repaired["data"]["updatedPaths"].as_array().unwrap();
    assert_eq!(updated_paths.len(), 2);
    assert!(updated_paths
        .iter()
        .any(|path| path == "papers/demo/NOTES.md"));
    assert!(updated_paths
        .iter()
        .any(|path| path == "papers/zh/NOTES.md"));

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

    agentero()
        .args(["--vault", vault.to_str().unwrap(), "doctor", "--json"])
        .assert()
        .success()
        .stdout(predicate::str::contains("\"ok\":true"));

    let rerun = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "--yes",
            "doctor",
            "fix",
            "aliases",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let rerun: Value = serde_json::from_slice(&rerun).unwrap();
    assert!(rerun["data"]["updatedPaths"].as_array().unwrap().is_empty());
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

    // Missing index → structured error
    let missing = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "layout",
            "list",
            "papers/demo",
            "--json",
        ])
        .assert()
        .failure()
        .get_output()
        .stdout
        .clone();
    let missing: Value = serde_json::from_slice(&missing).unwrap();
    assert_eq!(missing["ok"], false);
    assert_eq!(missing["error"]["code"], "layout_index_missing");

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

    let listed = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "layout",
            "list",
            "demo",
            "--kind",
            "figure",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let listed: Value = serde_json::from_slice(&listed).unwrap();
    assert_eq!(listed["ok"], true);
    let items = listed["data"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["id"], "figure-3");
    assert_eq!(items[0]["page"], 2);

    let formulas = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "layout",
            "list",
            "demo",
            "--kind",
            "formula",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let formulas: Value = serde_json::from_slice(&formulas).unwrap();
    assert_eq!(formulas["data"]["items"].as_array().unwrap().len(), 1);

    let got = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "layout",
            "get",
            "demo",
            "figure-3",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let got: Value = serde_json::from_slice(&got).unwrap();
    assert_eq!(got["data"]["item"]["title"], "Figure 3: Heads");

    let added = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "mark",
            "add",
            "demo",
            "--region",
            "figure-3",
            "--comment",
            "核心图",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let added: Value = serde_json::from_slice(&added).unwrap();
    assert_eq!(added["ok"], true);
    assert_eq!(added["data"]["kind"], "highlight");
    let ids = added["data"]["ids"].as_array().unwrap();
    assert_eq!(ids.len(), 1);
    let mark_id = ids[0].as_str().unwrap().to_string();

    // Highlights/批注 are EmbedPDF annotations, not per-id mark files.
    let annotations_path = paper.join("marks").join("annotations.json");
    assert!(annotations_path.is_file());
    assert!(!paper
        .join("marks")
        .join(format!("{mark_id}.json"))
        .is_file());
    let items: Value =
        serde_json::from_str(&fs::read_to_string(&annotations_path).unwrap()).unwrap();
    let items = items.as_array().unwrap();
    assert_eq!(items.len(), 1);
    let anno = &items[0]["annotation"];
    assert_eq!(anno["id"], mark_id.as_str());
    assert_eq!(anno["type"], 9); // PdfAnnotationSubtype.HIGHLIGHT
    assert_eq!(anno["pageIndex"], 1); // region page 2
    assert_eq!(anno["contents"], "核心图");
    assert_eq!(anno["custom"]["quote"], "Figure 3: Heads");
    assert_eq!(anno["custom"]["paletteKey"], "yellow");
    let seg = &anno["segmentRects"][0];
    // bbox x 0.1 of a 200pt page, y 0.2 of 100pt.
    assert!((seg["origin"]["x"].as_f64().unwrap() - 20.0).abs() < 0.5);
    assert!((seg["origin"]["y"].as_f64().unwrap() - 20.0).abs() < 0.5);
    assert!((seg["size"]["width"].as_f64().unwrap() - 100.0).abs() < 0.5);

    let marks = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "mark",
            "list",
            "demo",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let marks: Value = serde_json::from_slice(&marks).unwrap();
    assert_eq!(marks["data"]["count"], 1);

    agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "-y",
            "mark",
            "delete",
            "demo",
            &mark_id,
            "--json",
        ])
        .assert()
        .success();
    let after: Value =
        serde_json::from_str(&fs::read_to_string(&annotations_path).unwrap()).unwrap();
    assert!(after.as_array().unwrap().is_empty());
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

    let sections = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "layout",
            "list",
            "demo",
            "--kind",
            "section",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let sections: Value = serde_json::from_slice(&sections).unwrap();
    assert_eq!(sections["ok"], true);
    let items = sections["data"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["id"], "h1");
    assert_eq!(items[0]["title"], "1 Introduction");
    assert_eq!(items[0]["page"], 1);
    assert_eq!(items[1]["id"], "h2");
    assert_eq!(sections["data"]["counts"]["section"], 2);

    let mixed = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "layout",
            "list",
            "demo",
            "--kind",
            "figure",
            "--kind",
            "section",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let mixed: Value = serde_json::from_slice(&mixed).unwrap();
    let mixed_items = mixed["data"]["items"].as_array().unwrap();
    assert_eq!(mixed_items.len(), 3);
    assert_eq!(mixed_items[0]["id"], "h1");
    assert_eq!(mixed_items[1]["id"], "h2");
    assert_eq!(mixed_items[2]["id"], "figure-1");
}

/// The Agent path: a plain sentence becomes a highlight with engine-resolved
/// geometry, and a comment rides along as the 批注 body.
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

    let added = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "mark",
            "add",
            "attn",
            "--quote",
            "propose a novel mechanism",
            "--comment",
            "核心贡献",
            "--mark-color",
            "green",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let added: Value = serde_json::from_slice(&added).unwrap();
    assert_eq!(added["ok"], true);
    let id = added["data"]["ids"][0].as_str().unwrap().to_string();

    let items: Value = serde_json::from_str(
        &fs::read_to_string(paper.join("marks").join("annotations.json")).unwrap(),
    )
    .unwrap();
    let anno = &items.as_array().unwrap()[0]["annotation"];
    assert_eq!(anno["id"], id.as_str());
    assert_eq!(anno["pageIndex"], 1); // second page
    assert_eq!(anno["contents"], "核心贡献");
    assert_eq!(anno["strokeColor"], "#86efac"); // HIGHLIGHT_HEX.green
    let seg = &anno["segmentRects"][0];
    let x = seg["origin"]["x"].as_f64().unwrap();
    let y = seg["origin"]["y"].as_f64().unwrap();
    // Text is drawn at 20,60 in PDF space on a 100pt page → top-left y ≈ 28.
    assert!(x > 10.0 && x < 200.0, "x {x}");
    assert!(y > 10.0 && y < 50.0, "y {y}");

    // A quote that is not in the PDF must fail loudly and write nothing.
    let missing = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "mark",
            "add",
            "attn",
            "--quote",
            "this sentence does not exist anywhere",
            "--json",
        ])
        .assert()
        .failure()
        .get_output()
        .stdout
        .clone();
    let missing: Value = serde_json::from_slice(&missing).unwrap();
    assert_eq!(missing["ok"], false);
    assert_eq!(missing["error"]["code"], "mark_locate_failed");

    // Comment updates land on the annotation, not a sibling file.
    agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "mark",
            "update",
            "attn",
            &id,
            "--comment",
            "改过的批注",
            "--json",
        ])
        .assert()
        .success();
    let items: Value = serde_json::from_str(
        &fs::read_to_string(paper.join("marks").join("annotations.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        items.as_array().unwrap()[0]["annotation"]["contents"],
        "改过的批注"
    );
}

/// Mark ids are nanoids and that alphabet includes `-`, so ~1 in 64 starts with
/// a hyphen. Those must reach the command instead of tripping clap's flag
/// parsing: expect a business `mark_not_found` (exit 1), never usage (exit 2).
#[test]
fn mark_id_starting_with_hyphen_is_not_parsed_as_a_flag() {
    let tmp = tempdir().unwrap();
    let vault = tmp.path().join("v");
    create_vault(&vault);

    let paper = vault.join("papers").join("demo");
    fs::create_dir_all(paper.join("marks")).unwrap();
    fs::write(paper.join("NOTES.md"), "# Demo\n").unwrap();
    seed_paper(&vault, "papers/demo", "demo", "Demo Paper");

    let out = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "-y",
            "mark",
            "delete",
            "demo",
            "-gnlmmSEJc",
            "--json",
        ])
        .assert()
        .failure()
        .code(1)
        .get_output()
        .stdout
        .clone();
    let out: Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(out["ok"], false);
    assert_eq!(out["error"]["code"], "mark_not_found");
    assert_eq!(out["error"]["details"]["id"], "-gnlmmSEJc");
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

    // 1. Single PDF import with default parent
    let out = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "import",
            "pdf",
            pdf1_path.to_str().unwrap(),
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["ok"], true);
    let papers = v["data"]["papers"].as_array().unwrap();
    assert_eq!(papers.len(), 1);
    let p1 = &papers[0];
    assert_eq!(p1["id"], "attention-paper");
    assert_eq!(p1["path"], "papers/attention-paper");
    assert_eq!(p1["pdf"], true);
    assert!(vault
        .join("papers/attention-paper/attention-paper.pdf")
        .is_file());
    assert!(vault.join("papers/attention-paper/NOTES.md").is_file());

    // 2. Batch import to subfolder with --no-recognize
    let out = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "import",
            "pdf",
            pdf2_path.to_str().unwrap(),
            "--parent",
            "papers/nlp",
            "--no-recognize",
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["ok"], true);
    let papers = v["data"]["papers"].as_array().unwrap();
    assert_eq!(papers.len(), 1);
    let p2 = &papers[0];
    assert_eq!(p2["id"], "bert-paper");
    assert_eq!(p2["path"], "papers/nlp/bert-paper");
    assert!(vault.join("papers/nlp/bert-paper/bert-paper.pdf").is_file());
    assert!(vault.join("papers/nlp/bert-paper/NOTES.md").is_file());

    // 3. Error case: file not found
    let bogus = tmp.path().join("nonexistent.pdf");
    let out = agentero()
        .args([
            "--vault",
            vault.to_str().unwrap(),
            "import",
            "pdf",
            bogus.to_str().unwrap(),
            "--json",
        ])
        .assert()
        .failure()
        .get_output()
        .stdout
        .clone();
    let v: Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["ok"], false);
    assert_eq!(v["error"]["code"], "import_failed");
}
