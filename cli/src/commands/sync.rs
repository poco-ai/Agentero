//! `agentero sync *` — vault cloud sync (S3/R2, WebDAV) without the desktop
//! app. Shares the desktop engine (`agentero_core::features::sync`), so the
//! merge, conflict-copy and failure-recovery semantics are identical on both
//! sides, and the same XDG `sync.json` binding is used.
//!
//! Secrets never appear on argv or in logs: they come from the environment
//! (`AGENTERO_SYNC_*`), a TTY prompt, or `--stdin` JSON, and every output is
//! masked (`*`) via `SyncBackendConfig::masked`.

use crate::error::{CliError, ExitCode};
use crate::output::OutputFormat;
use crate::prompt;
use crate::resolve::{resolve_vault, GlobalOpts};
use agentero_core::features::sync::config::{
    self as sync_config, SyncBackendConfig, SyncBackendKind,
};
use agentero_core::features::sync::snapshot::SyncScope;
use agentero_core::features::sync::{engine, local};
use clap::{Args, Subcommand, ValueEnum};
use serde_json::{json, Value};
use std::io::{stdin, Read};
use std::path::Path;

const ENV_ACCESS_KEY: &str = "AGENTERO_SYNC_ACCESS_KEY";
const ENV_SECRET_KEY: &str = "AGENTERO_SYNC_SECRET_KEY";
const ENV_WEBDAV_PASSWORD: &str = "AGENTERO_SYNC_WEBDAV_PASSWORD";

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub(crate) enum BackendKind {
    S3,
    Webdav,
    Git,
}

#[derive(Debug, Subcommand)]
#[allow(clippy::large_enum_variant)]
pub enum SyncCmd {
    /// Show the vault's sync binding and last-pass info.
    Status,
    /// Bind the vault to an S3/WebDAV store (validate + connection test first).
    Configure(ConfigureArgs),
    /// Re-test the stored binding (credentials, bucket, conditional writes).
    Test,
    /// Run one bidirectional sync pass now.
    Now {
        /// Print progress lines to stderr while the pass runs (text mode
        /// prints them by default; stdout stays machine-readable either way).
        #[arg(long = "progress")]
        progress: bool,
    },
    /// Remove the binding and local sync state (remote data stays untouched).
    Disconnect,
}

#[derive(Debug, Args)]
pub struct ConfigureArgs {
    /// Backend store: `s3` (default), `webdav`, or `git`.
    #[arg(long = "backend", value_enum, default_value = "s3")]
    pub backend: BackendKind,
    /// S3-compatible endpoint, e.g. https://<account>.r2.cloudflarestorage.com
    #[arg(long = "endpoint", value_name = "URL")]
    pub endpoint: Option<String>,
    /// S3 region (default us-east-1; R2/MinIO accept any).
    #[arg(long = "region", value_name = "REGION")]
    pub region: Option<String>,
    /// Bucket name.
    #[arg(long = "bucket", value_name = "NAME")]
    pub bucket: Option<String>,
    /// Optional key prefix inside the bucket (multiple vaults per bucket).
    #[arg(long = "prefix", value_name = "PREFIX")]
    pub prefix: Option<String>,
    /// WebDAV directory URL, e.g. https://dav.jianguoyun.com/dav/agentero/
    #[arg(long = "webdav-url", value_name = "URL")]
    pub webdav_url: Option<String>,
    /// WebDAV username.
    #[arg(long = "webdav-username", value_name = "NAME")]
    pub webdav_username: Option<String>,
    /// Git remote URL or local path (uses the system credential helper / SSH).
    #[arg(long = "git-remote", value_name = "URL")]
    pub git_remote: Option<String>,
    /// Git branch to sync (default main).
    #[arg(long = "git-branch", value_name = "BRANCH")]
    pub git_branch: Option<String>,
    /// Allow a non-loopback `http://` Git remote (`true` or `false`).
    /// The token travels in cleartext; only for a trusted intranet.
    #[arg(long = "git-allow-insecure-http", value_name = "BOOL")]
    pub git_allow_insecure_http: Option<String>,
    /// Absolute PEM CA bundle for a self-signed HTTPS Git remote.
    #[arg(long = "git-ssl-ca", value_name = "PATH")]
    pub git_ssl_ca_info: Option<String>,
    /// Bulky asset categories to keep out of sync (comma list of
    /// pdf,source,attachments). Notes, sidecars and marks always sync.
    #[arg(long = "exclude", value_name = "LIST", value_delimiter = ',')]
    pub exclude: Vec<String>,
    /// Read the full config JSON (camelCase, incl. secrets) from stdin.
    /// For scripts: keeps credentials out of argv and shell history.
    #[arg(long = "stdin")]
    pub stdin_cfg: bool,
}

pub async fn run(cmd: SyncCmd, globals: &GlobalOpts) -> Result<Value, CliError> {
    let vault = resolve_vault(globals)?;
    match cmd {
        SyncCmd::Status => status(&vault, globals),
        SyncCmd::Configure(args) => configure(&vault, &args, globals).await,
        SyncCmd::Test => test(&vault).await,
        SyncCmd::Now { progress } => now(&vault, progress, globals).await,
        SyncCmd::Disconnect => disconnect(&vault, globals),
    }
}

/// Resolve the `sync.json` entry for a vault dir: the desktop Host keys
/// entries by the path string its frontend passed, which can differ in
/// normalization from CLI resolution (symlinks, `/private` on macOS). Match
/// by canonical path so both sides keep sharing one entry.
fn entry_for(dir: &Path) -> (String, Option<SyncBackendConfig>) {
    let key = dir.to_string_lossy().to_string();
    if let Some(cfg) = sync_config::get(&key) {
        return (key, Some(cfg));
    }
    let want = agentero_core::fs::canonicalize_best_effort(dir);
    for (stored, cfg) in sync_config::list_all() {
        if agentero_core::fs::canonicalize_best_effort(Path::new(&stored)) == want {
            return (stored, Some(cfg));
        }
    }
    (key, None)
}

fn sync_not_configured() -> CliError {
    CliError::new(
        "sync_not_configured",
        "sync is not configured (run `agentero sync configure`)",
        ExitCode::Business,
    )
}

fn status(vault: &Path, globals: &GlobalOpts) -> Result<Value, CliError> {
    let (key, cfg) = entry_for(vault);
    let meta = local::read_meta(vault);
    let style = globals.style;

    let mut v = json!({
        "vault": key,
        "configured": cfg.is_some(),
        "lastSyncAt": meta.last_sync_at,
        "lastVersion": meta.last_version,
        "lastError": meta.last_error,
    });

    let mut lines = Vec::new();
    match &cfg {
        Some(cfg) => {
            let target = match cfg.backend {
                SyncBackendKind::S3 => format!("s3 {} / {}", cfg.endpoint, cfg.bucket),
                SyncBackendKind::Webdav => format!("webdav {}", cfg.webdav_url),
                SyncBackendKind::Git => {
                    format!("git {} ({})", cfg.git_remote, cfg.git_branch)
                }
                SyncBackendKind::Agentero => {
                    format!("agentero {} ({})", cfg.agentero_subject, cfg.agentero_api)
                }
            };
            lines.push(format!("{} {target}", style.key("backend")));
            if !cfg.prefix.trim().is_empty() {
                lines.push(format!("{} {}", style.key("prefix"), cfg.prefix));
            }
        }
        None => lines.push(
            style
                .dim("not configured (`agentero sync configure`)")
                .to_string(),
        ),
    }
    match &meta.last_sync_at {
        Some(at) => lines.push(format!(
            "{} {at} ({})",
            style.key("last sync"),
            style.dim(&format!("version {}", meta.last_version))
        )),
        None => lines.push(style.dim("never synced").to_string()),
    }
    if let Some(err) = &meta.last_error {
        lines.push(format!("{} {err}", style.error_label("last error:")));
    }
    if let (Some(obj), Some(cfg)) = (v.as_object_mut(), cfg) {
        obj.insert("config".into(), serde_json::to_value(cfg.masked())?);
    }
    if let Some(obj) = v.as_object_mut() {
        obj.insert("lines".into(), json!(lines));
    }
    Ok(v)
}

async fn configure(
    vault: &Path,
    args: &ConfigureArgs,
    globals: &GlobalOpts,
) -> Result<Value, CliError> {
    let (key, existing) = entry_for(vault);
    let mut cfg = if args.stdin_cfg {
        read_config_stdin()?
    } else {
        assemble_config(args, existing.clone(), globals)?
    };
    // A `*`-masked secret echoed back (e.g. a status payload pasted into
    // stdin JSON) restores the stored value instead of overwriting it.
    cfg.merge_mask(existing.as_ref());
    cfg = cfg.normalized();
    sync_config::hydrate_agentero(&mut cfg);
    cfg.validate().map_err(|e| {
        // Non-interactive callers cannot fill a missing secret via prompt;
        // point them at the secret channels explicitly.
        CliError::with_details(
            "sync_config_invalid",
            e.to_string(),
            json!({
                "secrets": format!(
                    "pass secrets via {ENV_ACCESS_KEY} / {ENV_SECRET_KEY} / {ENV_WEBDAV_PASSWORD}, a TTY prompt, or `--stdin` JSON (never argv)"
                )
            }),
            ExitCode::Business,
        )
    })?;
    cfg.conditional_writes = engine::test_connection(vault, &cfg).await?;
    sync_config::set(&key, cfg.clone())?;

    let style = globals.style;
    let mut v = json!({
        "vault": key,
        "configured": true,
        "config": serde_json::to_value(cfg.masked())?,
        "conditionalWrites": cfg.conditional_writes,
    });
    if let Some(obj) = v.as_object_mut() {
        let target = match cfg.backend {
            SyncBackendKind::S3 => format!("{}/{}", cfg.endpoint, cfg.bucket),
            SyncBackendKind::Webdav => cfg.webdav_url.clone(),
            SyncBackendKind::Git => {
                format!("{} ({})", cfg.git_remote, cfg.git_branch)
            }
            SyncBackendKind::Agentero => format!("{} ({})", cfg.agentero_subject, cfg.agentero_api),
        };
        let mut lines = vec![format!("{} {target}", style.key("configured"))];
        lines.push(format!(
            "{} {}",
            style.key("conditional writes"),
            if cfg.conditional_writes {
                "yes"
            } else {
                "no (degraded to plain PUT)"
            }
        ));
        obj.insert("lines".into(), json!(lines));
    }
    Ok(v)
}

/// Build the config from flags on top of the existing binding (if any);
/// secrets come from the environment or a TTY prompt, never from argv.
fn assemble_config(
    args: &ConfigureArgs,
    existing: Option<SyncBackendConfig>,
    globals: &GlobalOpts,
) -> Result<SyncBackendConfig, CliError> {
    let mut cfg = existing.unwrap_or_default();
    cfg.backend = match args.backend {
        BackendKind::S3 => SyncBackendKind::S3,
        BackendKind::Webdav => SyncBackendKind::Webdav,
        BackendKind::Git => SyncBackendKind::Git,
    };
    if let Some(v) = &args.endpoint {
        cfg.endpoint = v.clone();
    }
    if let Some(v) = &args.region {
        cfg.region = v.clone();
    }
    if let Some(v) = &args.bucket {
        cfg.bucket = v.clone();
    }
    if let Some(v) = &args.prefix {
        cfg.prefix = v.clone();
    }
    if let Some(v) = &args.webdav_url {
        cfg.webdav_url = v.clone();
    }
    if let Some(v) = &args.webdav_username {
        cfg.webdav_username = v.clone();
    }
    if let Some(v) = &args.git_remote {
        cfg.git_remote = v.clone();
    }
    if let Some(v) = &args.git_branch {
        cfg.git_branch = v.clone();
    }
    if let Some(v) = &args.git_allow_insecure_http {
        cfg.git_allow_insecure_http = parse_bool_flag("git-allow-insecure-http", v)?;
    }
    if let Some(v) = &args.git_ssl_ca_info {
        cfg.git_ssl_ca_info = v.clone();
    }
    if let Some(v) = env_non_empty(ENV_ACCESS_KEY) {
        cfg.access_key = v;
    }
    if let Some(v) = env_non_empty(ENV_SECRET_KEY) {
        cfg.secret_key = v;
    }
    if let Some(v) = env_non_empty(ENV_WEBDAV_PASSWORD) {
        cfg.webdav_password = v;
    }
    if !args.exclude.is_empty() {
        cfg.scope = scope_from_excludes(&args.exclude)?;
    }

    // Prompt for missing secrets only on an interactive TTY; `--json` and
    // pipes never prompt — the gap then surfaces as a validate() error that
    // points at the env / stdin options.
    if prompt::allows_interactive(globals) {
        match cfg.backend {
            SyncBackendKind::S3 => {
                if cfg.access_key.trim().is_empty() {
                    cfg.access_key = inquire::Text::new("S3 access key id")
                        .prompt()
                        .map_err(prompt_failed)?;
                }
                if cfg.secret_key.trim().is_empty() {
                    cfg.secret_key = inquire::Password::new("S3 secret access key")
                        .without_confirmation()
                        .prompt()
                        .map_err(prompt_failed)?;
                }
            }
            SyncBackendKind::Webdav => {
                if cfg.webdav_password.is_empty() {
                    cfg.webdav_password = inquire::Password::new("WebDAV password (app password)")
                        .without_confirmation()
                        .prompt()
                        .map_err(prompt_failed)?;
                }
            }
            // System credential helper / SSH agent only; the app never asks
            // for or stores a Git secret.
            SyncBackendKind::Git => {}
            // Official cloud uses AGENTERO_SYNC_TOKEN, never a prompt.
            SyncBackendKind::Agentero => {}
        }
    }
    Ok(cfg)
}

fn prompt_failed(e: inquire::InquireError) -> CliError {
    CliError::message(format!("prompt failed: {e}"))
}

fn parse_bool_flag(name: &str, value: &str) -> Result<bool, CliError> {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(CliError::message(format!("{name} must be true or false"))),
    }
}

fn env_non_empty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn scope_from_excludes(exclude: &[String]) -> Result<SyncScope, CliError> {
    let mut scope = SyncScope::all();
    for item in exclude {
        match item.trim() {
            "pdf" => scope.pdf = false,
            "source" => scope.source = false,
            "attachments" => scope.attachments = false,
            other => {
                return Err(CliError::usage(format!(
                    "unknown scope category '{other}' (expected pdf | source | attachments)"
                )))
            }
        }
    }
    Ok(scope)
}

fn read_config_stdin() -> Result<SyncBackendConfig, CliError> {
    let mut raw = String::new();
    stdin()
        .read_to_string(&mut raw)
        .map_err(|e| CliError::usage(format!("failed to read config from stdin: {e}")))?;
    serde_json::from_str(&raw)
        .map_err(|e| CliError::usage(format!("invalid config JSON on stdin: {e}")))
}

async fn test(vault: &Path) -> Result<Value, CliError> {
    let (_, cfg) = entry_for(vault);
    let cfg = cfg.ok_or_else(sync_not_configured)?;
    let conditional = engine::test_connection(vault, &cfg).await?;
    Ok(json!({
        "ok": true,
        "conditionalWrites": conditional,
    }))
}

async fn now(vault: &Path, progress_flag: bool, globals: &GlobalOpts) -> Result<Value, CliError> {
    let (_, cfg) = entry_for(vault);
    let cfg = cfg.ok_or_else(sync_not_configured)?;

    let show_progress = progress_flag || !matches!(globals.format, OutputFormat::Json);
    let progress = move |phase: &str, current: usize, total: usize| {
        if show_progress {
            eprintln!("sync: {phase} {current}/{total}");
        }
    };

    let outcome = engine::sync_vault_locked(vault, &cfg, &progress).await?;
    let style = globals.style;
    let mut v = serde_json::to_value(&outcome)?;
    if let Some(obj) = v.as_object_mut() {
        let mut lines = vec![format!(
            "{} version={} up={} down={} deleted-local={} removed-remote={}",
            style.ok("synced"),
            outcome.version,
            outcome.uploaded,
            outcome.downloaded,
            outcome.deleted_local,
            outcome.removed_remote,
        )];
        for copy in &outcome.conflict_copies {
            lines.push(format!("{} {copy}", style.error_label("conflict copy:")));
        }
        obj.insert("lines".into(), json!(lines));
    }
    Ok(v)
}

fn disconnect(vault: &Path, globals: &GlobalOpts) -> Result<Value, CliError> {
    let (key, cfg) = entry_for(vault);
    if cfg.is_none() {
        return Err(sync_not_configured());
    }
    let message = format!(
        "Remove the sync binding for {key} and forget local sync state? Remote data stays untouched."
    );
    if !prompt::confirm(globals, &message, false)? {
        return Err(CliError::needs_confirmation("disconnect cancelled"));
    }
    sync_config::remove(&key)?;
    local::clear(vault);
    Ok(json!({ "disconnected": key }))
}
