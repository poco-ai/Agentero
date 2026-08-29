//! Typed IPC contract (tauri-specta): keeps `src/lib/core/bindings.ts` in
//! sync with the Rust command signatures.
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
            crate::features::translate::commands::translate_text,
            crate::features::jobs::commands::job_parse_refs_enqueue,
            crate::features::jobs::commands::job_parse_body_enqueue,
            crate::features::jobs::commands::job_layout_analyze_enqueue,
            crate::features::jobs::commands::job_download_assets_enqueue,
            crate::features::jobs::commands::job_reconcile_paper,
            crate::features::jobs::commands::job_reconcile_vault,
            crate::features::jobs::commands::job_papers_needing_assets,
            crate::features::jobs::commands::job_focus_paper,
            crate::features::jobs::commands::job_cancel,
            crate::features::jobs::commands::job_report,
            crate::features::jobs::commands::job_list,
        ])
        // `job:offer` / `job:changed` payloads are emitted via `app.emit`
        // (plain events, not tauri-specta events); register their types so
        // the frontend can consume them from bindings.ts.
        .typ::<crate::features::jobs::JobOfferPayload>()
        .typ::<crate::features::jobs::JobChangedPayload>();

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
