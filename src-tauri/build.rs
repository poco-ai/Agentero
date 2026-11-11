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
    forward_build_env();
}

/// Variables baked into the binary at compile time and read via `option_env!`.
const BUILD_ENV_KEYS: &[&str] = &[
    "AGENTERO_POSTHOG_KEY",
    "AGENTERO_POSTHOG_SURVEY_ID",
    "AGENTERO_POSTHOG_SURVEY_KIND_ID",
    "AGENTERO_POSTHOG_SURVEY_MESSAGE_ID",
    "AGENTERO_POSTHOG_SURVEY_CONTACT_ID",
    "AGENTERO_BUILTIN_BASE_URL",
    "AGENTERO_BUILTIN_API_KEY",
    "AGENTERO_BUILTIN_TRANSLATE_MODEL",
    "AGENTERO_BUILTIN_EMBEDDING_MODEL",
    "AGENTERO_BUILTIN_OCR_MODEL",
];

/// Forward the build-time variables to `rustc`. An explicit env var wins;
/// otherwise fall back to the repo-root `.env` (gitignored). Absent both, the
/// consumer compiles out: telemetry is disabled and the built-in provider
/// reports itself unavailable.
///
/// `rerun-if-env-changed` is what makes this correct — cargo does not otherwise
/// observe env changes, so a rotated key would silently keep the stale binary.
fn forward_build_env() {
    let manifest_dir = PathBuf::from(
        env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by Cargo"),
    );
    let dotenv = manifest_dir.join("../.env");
    for key in BUILD_ENV_KEYS {
        println!("cargo:rerun-if-env-changed={key}");
    }
    println!("cargo:rerun-if-changed={}", dotenv.display());
    if BUILD_ENV_KEYS.iter().all(|key| env::var(key).is_ok()) {
        return;
    }
    let Ok(content) = fs::read_to_string(&dotenv) else {
        return;
    };
    for key in BUILD_ENV_KEYS {
        if env::var(key).is_ok() {
            continue;
        }
        let prefix = format!("{key}=");
        let Some(value) = content.lines().find_map(|line| {
            line.trim()
                .strip_prefix(prefix.as_str())
                .map(str::trim)
                .filter(|v| !v.is_empty())
        }) else {
            continue;
        };
        println!("cargo:rustc-env={key}={value}");
    }
}
