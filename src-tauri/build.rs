use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    // Unit-test binaries link the full Tauri stack, which statically imports
    // `TaskDialogIndirect` — exported only by comctl32 v6. tauri-build's
    // manifest resource reaches bin targets only (`rustc-link-arg-bins`), so
    // without this every `cargo test` binary starts without a manifest, the
    // loader binds comctl32 v5 and the process dies with
    // STATUS_ENTRYPOINT_NOT_FOUND before any test runs. /MANIFESTDEPENDENCY
    // makes the MSVC linker embed the Common-Controls v6 dependency; for bins
    // it merges into the manifest tauri-build already provided. GNU toolchains
    // need a different (windres) mechanism and are excluded here.
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        println!(
            "cargo::rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' \
             name='Microsoft.Windows.Common-Controls' version='6.0.0.0' \
             publicKeyToken='6595b64144ccf1df' language='*' processorArchitecture='*'"
        );
    }
    if env::var_os("CARGO_FEATURE_DESKTOP").is_some() {
        tauri_build::build();
    }
    forward_posthog_key();
}

/// Bake the PostHog project API key into the binary at compile time.
/// An explicit `AGENTERO_POSTHOG_KEY` env var wins; otherwise fall back to
/// the repo-root `.env` (gitignored). Absent both, telemetry compiles out.
fn forward_posthog_key() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let dotenv = manifest_dir.join("../.env");
    println!("cargo:rerun-if-env-changed=AGENTERO_POSTHOG_KEY");
    println!("cargo:rerun-if-changed={}", dotenv.display());
    if env::var("AGENTERO_POSTHOG_KEY").is_ok() {
        return;
    }
    let Ok(content) = fs::read_to_string(&dotenv) else {
        return;
    };
    for line in content.lines() {
        let Some(value) = line
            .trim()
            .strip_prefix("AGENTERO_POSTHOG_KEY=")
            .map(str::trim)
            .filter(|v| !v.is_empty())
        else {
            continue;
        };
        println!("cargo:rustc-env=AGENTERO_POSTHOG_KEY={value}");
        return;
    }
}
