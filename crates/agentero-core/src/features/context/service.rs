//! Regression cases from the scoped context tools, exercised through the live CLI evidence service.
use super::*;
use crate::features::{
    evidence::{execute_scoped, resolve_citation},
    paper::catalog::papers::{self, PaperRecord},
};
use serde_json::{json, Value};
use std::fs;

fn vault_with_paper() -> (tempfile::TempDir, ContextGrant, PaperRecord) {
    let dir = tempfile::tempdir().unwrap();
    let paper_dir = dir.path().join("papers/attention");
    fs::create_dir_all(paper_dir.join("source")).unwrap();
    fs::write(paper_dir.join("paper.pdf"), b"%PDF").unwrap();
    let notes = format!(
            "# Notes\n\n{}\n\nThe unique token is scaled-dot-product attention in the middle of the note.\n\n{}FAR-END-MARKER",
            "HEAD-SENTINEL ".repeat(40),
            "x".repeat(4_000)
        );
    fs::write(paper_dir.join("NOTES.md"), notes).unwrap();
    fs::write(
            paper_dir.join("PAPER.md"),
            "# 2.1 Model Architecture\n\nThe encoder stack is described here.\n\nFULL-BODY-SENTINEL and a great deal of extra prose that should not appear in a metadata read.\n",
        )
        .unwrap();
    fs::write(
            paper_dir.join("source/layout.json"),
            r#"{
              "regions": [
                {"id":"h1","pageIndex":1,"kind":"section_header","title":"2.1 Model Architecture","text":"2.1 Model Architecture","bbox":{"x":0,"y":0,"w":1,"h":0.1}},
                {"id":"p1","pageIndex":1,"kind":"text","text":"The encoder stack is six identical layers.","bbox":{"x":0,"y":0.2,"w":1,"h":0.2}},
                {"id":"h2","pageIndex":1,"kind":"section_header","title":"3 Experiments","text":"3 Experiments","bbox":{"x":0,"y":0.5,"w":1,"h":0.1}},
                {"id":"p2","pageIndex":2,"kind":"text","text":"Page three talks about training.","bbox":{"x":0,"y":0,"w":1,"h":0.2}}
              ]
            }"#,
        )
        .unwrap();
    fs::write(
            paper_dir.join("source/agentero-cite.json"),
            r#"{
              "schemaVersion": 1,
              "source": {"mode":"bib","generatedAt":"t","fingerprint":"fp"},
              "citations": [
                {
                  "id": "vaswani",
                  "metadata": {"title": "Attention Is All You Need", "year": 2017, "doi": "10.1/attn"},
                  "source": "bib",
                  "status": "resolved",
                  "localMatch": {"paperPath": "papers/other", "matchBy": "title"}
                },
                {
                  "id": "bare",
                  "metadata": {"title": "No Locator"},
                  "source": "bib",
                  "status": "resolved"
                }
              ]
            }"#,
        )
        .unwrap();
    fs::create_dir_all(dir.path().join(".agentero")).unwrap();
    fs::write(
            dir.path().join(".agentero/citing-scan.json"),
            r#"{
              "schemaVersion": 1,
              "generatedAt": "t",
              "seeds": {
                "papers/attention": {
                  "s2Id": "s2",
                  "citationCount": 2,
                  "fetchedAt": "t",
                  "citing": [
                    {"s2Id":"c1","title":"A Follow-up","date":"2024-01-01","doi":"10.9/follow","citationCount":3},
                    {"s2Id":"c2","title":"Unlocated citer","citationCount":1}
                  ]
                }
              }
            }"#,
        )
        .unwrap();
    let mut record = PaperRecord::local_pdf("attention".into(), "Attention Is All You Need".into())
        .at_path("papers/attention");
    record.abstract_text = Some("We propose the Transformer.".into());
    record.authors = vec!["Vaswani".into()];
    record.year = Some(2017);
    let stored = papers::upsert_paper(dir.path(), &record).unwrap();
    let grant = ContextGrant {
        schema_version: GRANT_SCHEMA_VERSION,
        session_id: "s".into(),
        vault_path: dir.path().display().to_string(),
        fingerprint: "fp".into(),
        allowed: vec![AllowedSource {
            kind: AllowedSourceKind::Paper,
            path: "papers/attention".into(),
            paper_id: Some("attention".into()),
            title: Some(stored.title.clone()),
        }],
        budget: ContextBudget::default(),
        mode: ContextMode::ReadOnly,
    };

    (dir, grant, stored)
}

fn grant_at(dir: &std::path::Path, rel: &str, kind: AllowedSourceKind) -> ContextGrant {
    ContextGrant {
        schema_version: GRANT_SCHEMA_VERSION,
        session_id: "s".into(),
        vault_path: dir.display().to_string(),
        fingerprint: "fp".into(),
        allowed: vec![AllowedSource {
            kind,
            path: rel.into(),
            paper_id: None,
            title: None,
        }],
        budget: ContextBudget::default(),
        mode: ContextMode::ReadOnly,
    }
}
fn read(grant: &ContextGrant, args: Value) -> Value {
    execute_scoped(grant, "evidence_read", args, 0).unwrap().0
}

#[test]
fn search_returns_a_card_not_the_note_body() {
    let (dir, grant, _) = vault_with_paper();
    let (out, _, uris) = execute_scoped(
        &grant,
        "evidence_search",
        json!({"query":"scaled-dot-product","limit":3}),
        0,
    )
    .unwrap();
    assert!(out["items"][0]["excerpt"]
        .as_str()
        .unwrap()
        .contains("scaled-dot-product"));
    assert!(!out.to_string().contains("FAR-END-MARKER"));
    assert!(out["items"].as_array().unwrap().iter().all(|c| c["excerpt"]
        .as_str()
        .unwrap()
        .chars()
        .count()
        <= 280));
    assert_eq!(
        resolve_citation(dir.path(), &uris[0]).unwrap().0,
        "papers/attention/NOTES.md"
    );
}
#[test]
fn tex_full_section_and_search_supersede_old_ocr() {
    let (dir, grant, paper) = vault_with_paper();
    let source = dir.path().join(&paper.path).join("source");
    fs::write(source.join("main.tex"),r"\documentclass{article}\begin{document}\section{Introduction}\input{intro}\section{Method}\input{method}\end{document}").unwrap();
    fs::write(source.join("intro.tex"), "TEX-INTRO-SENTINEL").unwrap();
    fs::write(source.join("method.tex"), "TEX-METHOD-SENTINEL $x^2$.").unwrap();
    let full = read(&grant, json!({"source":paper.path,"part":"body"}))["text"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(full.contains("TEX-METHOD-SENTINEL") && !full.contains("FULL-BODY-SENTINEL"));
    let section = read(
        &grant,
        json!({"source":paper.path,"section":"Introduction"}),
    );
    assert!(section["text"]
        .as_str()
        .unwrap()
        .contains("TEX-INTRO-SENTINEL"));
    assert!(!section["text"]
        .as_str()
        .unwrap()
        .contains("TEX-METHOD-SENTINEL"));
    assert!(!execute_scoped(
        &grant,
        "evidence_search",
        json!({"query":"TEX-METHOD-SENTINEL"}),
        0
    )
    .unwrap()
    .0["items"]
        .as_array()
        .unwrap()
        .is_empty());
}
#[test]
fn directory_grant_searches_notes_and_lists_names() {
    let dir = tempfile::tempdir().unwrap();
    let _ = papers::list_all(dir.path()).unwrap();
    fs::create_dir_all(dir.path().join("notes")).unwrap();
    fs::write(
        dir.path().join("notes/idea.md"),
        "the token is directory-needle",
    )
    .unwrap();
    let grant = grant_at(dir.path(), "notes", AllowedSourceKind::Directory);
    let found = execute_scoped(
        &grant,
        "evidence_search",
        json!({"query":"directory-needle"}),
        0,
    )
    .unwrap()
    .0;
    assert_eq!(found["items"][0]["source"], "notes/idea.md");
    let listed = read(&grant, json!({"source":"notes"}));
    assert_eq!(listed["entries"][0]["name"], "idea.md");
    assert!(!listed.to_string().contains("directory-needle"));
    assert!(read(
        &grant,
        json!({"source":"notes/idea.md","quote":"directory-needle"})
    )["text"]
        .as_str()
        .unwrap()
        .contains("directory-needle"));
}
#[test]
fn excerpt_finds_a_quote_past_the_full_text_cap() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("long.md"),
        format!("{} LATE-QUOTE-MARKER", "x".repeat(20_000)),
    )
    .unwrap();
    let grant = grant_at(dir.path(), "long.md", AllowedSourceKind::File);
    let out = read(
        &grant,
        json!({"source":"long.md","quote":"LATE-QUOTE-MARKER"}),
    );
    let text = out["text"].as_str().unwrap();
    assert!(text.contains("LATE-QUOTE-MARKER") && text.chars().count() <= 4000);
}
#[test]
fn capped_read_stops_at_max_bytes() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("big.txt"),
        format!("{}TAIL-MARKER", "a".repeat(512 * 1024)),
    )
    .unwrap();
    let grant = grant_at(dir.path(), "big.txt", AllowedSourceKind::File);
    let out = read(&grant, json!({"source":"big.txt","max_chars":1000}));
    assert_eq!(out["text"], "a".repeat(1000));
    assert!(out["next_cursor"].is_string());
}
#[test]
fn read_defaults_to_metadata_and_refuses_other_papers() {
    let (dir, grant, paper) = vault_with_paper();
    let meta = read(&grant, json!({"source":paper.path}));
    assert!(meta["text"]
        .as_str()
        .unwrap()
        .contains("We propose the Transformer."));
    assert!(meta["text"].as_str().unwrap().contains("Vaswani"));
    assert!(!meta.to_string().contains("FULL-BODY-SENTINEL"));
    fs::create_dir_all(dir.path().join("papers/other")).unwrap();
    assert!(execute_scoped(&grant, "evidence_read", json!({"source":"papers/other"}), 0).is_err());
}
#[test]
fn read_opens_section_and_page_without_dumping_the_paper() {
    let (dir, grant, paper) = vault_with_paper();
    let section = read(
        &grant,
        json!({"source":paper.path,"section":"2.1 Model Architecture"}),
    );
    assert!(section["text"].as_str().unwrap().contains("encoder stack"));
    assert!(!section["text"].as_str().unwrap().contains("3 Experiments"));
    let (page, _, uris) = execute_scoped(
        &grant,
        "evidence_read",
        json!({"source":paper.path,"pages":[3]}),
        0,
    )
    .unwrap();
    assert!(page["text"]
        .as_str()
        .unwrap()
        .contains("Page three talks about training"));
    let (_, loc) = resolve_citation(dir.path(), &uris[0]).unwrap();
    assert_eq!(loc["page"], 3);
}
#[test]
fn relations_use_the_sidecar_and_citing_cache() {
    let (dir, grant, paper) = vault_with_paper();
    fs::create_dir_all(dir.path().join("papers/other")).unwrap();
    let refs = execute_scoped(&grant, "paper_relations", json!({"paper":paper.path}), 0)
        .unwrap()
        .0;
    assert!(refs.to_string().contains("Attention Is All You Need"));
    assert!(refs.to_string().contains("No Locator"));
    assert!(refs["items"][0]["paper"].is_null());
    let cited = execute_scoped(
        &grant,
        "paper_relations",
        json!({"paper":paper.path,"direction":"cited-by"}),
        0,
    )
    .unwrap()
    .0;
    assert!(cited.to_string().contains("A Follow-up"));
    assert!(cited.to_string().contains("Unlocated citer"));
    assert!(cited["items"][0]["paper"].is_null());
}
#[test]
fn cited_by_uses_a_catalog_match_instead_of_the_seed() {
    let (dir, mut grant, paper) = vault_with_paper();
    fs::create_dir_all(dir.path().join("papers/follow")).unwrap();
    let mut follow =
        PaperRecord::local_pdf("follow".into(), "A Follow-up".into()).at_path("papers/follow");
    follow.doi = Some("10.9/follow".into());
    papers::upsert_paper(dir.path(), &follow).unwrap();
    grant.allowed.push(AllowedSource {
        kind: AllowedSourceKind::Paper,
        path: follow.path.clone(),
        paper_id: None,
        title: None,
    });
    let (cited, _, sources) = execute_scoped(
        &grant,
        "paper_relations",
        json!({"paper":paper.path,"direction":"cited-by"}),
        0,
    )
    .unwrap();
    assert!(sources.iter().any(
        |s| crate::features::evidence::resolve_citation(dir.path(), s)
            .is_ok_and(|(path, _)| path == follow.path)
    ));
    let matched = cited["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["title"] == "A Follow-up")
        .unwrap();
    assert_eq!(matched["paper"], follow.path);
    assert_ne!(matched["paper"], paper.path);
}
