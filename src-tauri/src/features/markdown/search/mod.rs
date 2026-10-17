//! Host command shell for shared Markdown search.

pub use agentero_core::features::markdown::search::*;
pub mod commands;

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::Path};

    fn write(dir: &Path, rel: &str, body: &str) {
        let p = dir.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    /// Quantified regression guard for the async command migration: build a
    /// few-hundred-file vault, record the direct-call timing baseline, then run
    /// the identical search through `run_blocking` (the async command path) and
    /// assert the heavy IO executed off the calling thread — on Windows the
    /// calling thread of a sync command is the UI message pump.
    #[test]
    fn vault_search_runs_off_the_calling_thread_with_timing_baseline() {
        let root =
            std::env::temp_dir().join(format!("agentero-search-bench-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        const FILES: usize = 300;
        for i in 0..FILES {
            let needle = if i % 3 == 0 { "transformer" } else { "cats" };
            write(
                &root,
                &format!("notes/note-{i}.md"),
                &format!(
                    "# Note {i}\n\nBody line about {needle}.\n{}\n",
                    "filler line for realistic file size.\n".repeat(40)
                ),
            );
        }

        // Baseline: direct implementation call on this thread.
        let started = std::time::Instant::now();
        let direct = vault_search(VaultSearchArgs {
            vault_path: root.to_string_lossy().to_string(),
            query: "transformer".into(),
            limit: Some(200),
            ..Default::default()
        })
        .expect("direct search");
        let direct_ms = started.elapsed().as_millis();
        eprintln!(
            "bench vault_search direct: files={FILES} hits={} truncated={} elapsed_ms={direct_ms}",
            direct.hits.len(),
            direct.truncated
        );
        assert_eq!(direct.hits.len(), 100, "every third file matches");

        // Async command path: same work, must run on a blocking-pool thread.
        let caller = std::thread::current().id();
        let vault_path = root.to_string_lossy().to_string();
        let result = tauri::async_runtime::block_on(crate::core::blocking::run_blocking(
            move || {
                let worker = std::thread::current();
                let off_thread = worker.id() != caller;
                let started = std::time::Instant::now();
                let out = vault_search(VaultSearchArgs {
                    vault_path,
                    query: "transformer".into(),
                    limit: Some(200),
                    ..Default::default()
                })
                .expect("blocking search");
                eprintln!(
                    "bench vault_search run_blocking: worker id={:?} name={:?} hits={} elapsed_ms={}",
                    worker.id(),
                    worker.name(),
                    out.hits.len(),
                    started.elapsed().as_millis()
                );
                crate::core::error::ApiResult::ok((off_thread, out.hits.len()))
            },
        ));
        let (off_thread, hits) = result.data.expect("search result data");
        assert!(
            off_thread,
            "vault_search must execute on the blocking pool, not the calling thread"
        );
        assert_eq!(hits, direct.hits.len(), "same results through both paths");
        let command = tauri::async_runtime::block_on(commands::vault_search(VaultSearchArgs {
            vault_path: root.to_string_lossy().to_string(),
            query: "transformer".into(),
            limit: Some(200),
            ..Default::default()
        }));
        assert_eq!(
            serde_json::to_value(command.data.expect("desktop command result")).unwrap(),
            serde_json::to_value(direct).unwrap(),
            "desktop command preserves the shared search result"
        );
        let _ = fs::remove_dir_all(&root);
    }
}
