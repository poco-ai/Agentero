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
    self as sync_config, SyncBackendConfig, SyncBackendKind, VaultSyncConfig,
};
use agentero_core::features::sync::lock::SyncLock;
use agentero_core::features::sync::snapshot::SyncScope;
use agentero_core::features::sync::{engine, local};

use serde_json::{json, Value};

use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BackendKind {
    S3,
    Webdav,
    Git,
}

#[derive(Debug)]
pub struct ConfigureArgs {
    /// Initialize or join the experimental ordinary-PUT WebDAV journal in a dedicated directory.
    pub webdav_journal: bool,
    /// Backend store: `s3` (default), `webdav`, or `git`.
    pub backend: BackendKind,
    /// S3-compatible endpoint, e.g. https://<account>.r2.cloudflarestorage.com
    pub endpoint: Option<String>,
    /// S3 region (default us-east-1; R2/MinIO accept any).
    pub region: Option<String>,
    /// Bucket name.
    pub bucket: Option<String>,
    /// Optional key prefix inside the bucket (multiple vaults per bucket).
    pub prefix: Option<String>,
    /// WebDAV directory URL, e.g. https://dav.jianguoyun.com/dav/agentero/
    pub webdav_url: Option<String>,
    /// WebDAV username.
    pub webdav_username: Option<String>,
    /// Git remote URL or local path (uses the system credential helper / SSH).
    pub git_remote: Option<String>,
    /// Git branch to sync (default main).
    pub git_branch: Option<String>,
    /// Allow a non-loopback `http://` Git remote (`true` or `false`).
    /// The token travels in cleartext; only for a trusted intranet.
    pub git_allow_insecure_http: Option<String>,
    /// Absolute PEM CA bundle for a self-signed HTTPS Git remote.
    pub git_ssl_ca_info: Option<String>,
    /// Opt in to degraded sync for WebDAV stores that ignore conditional writes
    /// (`true` or `false`): publish lock + plain HEAD PUT. Conflict copies and
    /// resurrected deletions are possible; every device sharing the store must
    /// opt in separately.
    pub allow_degraded_sync: Option<String>,
    /// Bulky asset categories to keep out of sync (comma list of
    /// pdf,source,attachments). Notes, sidecars and marks always sync.
    pub exclude: Vec<String>,
}

/// Resolve the `sync.json` entry for a vault dir: the desktop Host keys
/// entries by the path string its frontend passed, which can differ in
/// normalization from CLI resolution (symlinks, `/private` on macOS). Match
/// by canonical path so both sides keep sharing one entry.
fn binding_for(dir: &Path) -> (String, Option<VaultSyncConfig>) {
    let key = dir.to_string_lossy().to_string();
    if let Some(binding) = sync_config::get(&key) {
        return (key, Some(binding));
    }
    let want = agentero_core::fs::canonicalize_best_effort(dir);
    for (stored, binding) in sync_config::list_all() {
        if agentero_core::fs::canonicalize_best_effort(Path::new(&stored)) == want {
            return (stored, Some(binding));
        }
    }
    (key, None)
}

/// Primary backend of the vault binding; the CLI drives the authoritative side
/// (mirrors are published by whichever pass runs, see `sync now`).
fn entry_for(dir: &Path) -> (String, Option<SyncBackendConfig>) {
    let (key, binding) = binding_for(dir);
    (key, binding.map(|binding| binding.primary))
}

fn sync_not_configured() -> CliError {
    CliError::new(
        "sync_not_configured",
        "sync is not configured (run `agentero sync connect --help`)",
        ExitCode::Business,
    )
}

/// Short backend name used by all CLI JSON payloads.
fn backend_label(backend: SyncBackendKind) -> &'static str {
    match backend {
        SyncBackendKind::S3 => "s3",
        SyncBackendKind::Webdav => "webdav",
        SyncBackendKind::Git => "git",
        SyncBackendKind::Agentero => "agentero",
    }
}

/// Human-readable remote of one binding (never contains a secret).
fn location_of(cfg: &SyncBackendConfig) -> String {
    match cfg.backend {
        SyncBackendKind::S3 => format!("{}/{}", cfg.endpoint, cfg.bucket),
        SyncBackendKind::Webdav => cfg.webdav_url.clone(),
        SyncBackendKind::Git => cfg.git_remote.clone(),
        SyncBackendKind::Agentero => cfg.agentero_api.clone(),
    }
}

fn status(vault: &Path, globals: &GlobalOpts) -> Result<Value, CliError> {
    let (key, cfg) = entry_for(vault);
    let binding = binding_for(vault).1;
    let meta = local::read_meta(vault)?;
    let style = globals.style;

    // Mirrors are read-only copies; they have their own state and errors.
    let mirrors: Vec<Value> = binding
        .as_ref()
        .map(|binding| {
            binding
                .mirrors
                .iter()
                .map(|mirror| {
                    let state = engine::mirror_state(vault, mirror);
                    json!({
                        "backend": backend_label(mirror.backend),
                        "location": location_of(mirror),
                        "lastSyncAt": state.last_sync_at,
                        "lastVersion": state.last_version,
                        "lastError": state.last_error,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let mut v = json!({
        "vault": key,
        "configured": cfg.is_some(),
        "lastSyncAt": meta.last_sync_at,
        "lastVersion": meta.last_version,
        "lastError": meta.last_error,
        "mirrors": mirrors,
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
    if let Some(binding) = &binding {
        for (index, mirror) in binding.mirrors.iter().enumerate() {
            let state = engine::mirror_state(vault, mirror);
            let target = format!("{} {}", backend_label(mirror.backend), location_of(mirror));
            let detail = match (&state.last_error, &state.last_sync_at) {
                (Some(error), _) => format!("{} ({})", style.error_label("failed"), error),
                (None, Some(at)) => format!("{} v{}", style.dim(at), state.last_version),
                (None, None) => style.dim("never published").to_string(),
            };
            lines.push(format!(
                "{} {} {target} — {detail}",
                style.key("mirror"),
                index + 1
            ));
        }
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
    credentials: Option<&Value>,
) -> Result<Value, CliError> {
    let lock = SyncLock::acquire(vault)?;
    let (key, existing) = entry_for(vault);
    let mut cfg = assemble_config(args, existing, globals, credentials)?.normalized();
    sync_config::hydrate_agentero(&mut cfg);
    cfg.validate().map_err(|e| {
        // Non-interactive callers cannot fill a missing secret via prompt;
        // point them at the secret channels explicitly.
        CliError::with_details(
            "sync_config_invalid",
            e.to_string(),
            json!({
                "secrets": "use --credentials-input FILE (or - for stdin)"
            }),
            ExitCode::Business,
        )
    })?;
    if args.webdav_journal {
        engine::configure_webdav_journal(&lock, &cfg).await?;
        cfg.conditional_writes = false;
    } else {
        cfg.conditional_writes = engine::test_connection(vault, &cfg).await?;
    }
    sync_config::set(&key, VaultSyncConfig::new(cfg.clone()))?;

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
            } else if args.webdav_journal {
                "unused (WebDAV journal)"
            } else if cfg.allow_degraded_sync {
                "no (degraded sync enabled)"
            } else if cfg.backend == SyncBackendKind::Webdav {
                "no (requires a WebDAV journal or degraded sync)"
            } else {
                "no (sync blocked)"
            }
        ));
        obj.insert("lines".into(), json!(lines));
    }
    Ok(v)
}

mod credentials;

fn stored_credentials(cfg: &SyncBackendConfig) -> Result<Option<Value>, CliError> {
    let (backend, target, identity) = match cfg.backend {
        SyncBackendKind::S3 => ("s3", cfg.endpoint.as_str(), cfg.bucket.as_str()),
        SyncBackendKind::Webdav => (
            "webdav",
            cfg.webdav_url.as_str(),
            cfg.webdav_username.as_str(),
        ),
        _ => return Ok(None),
    };
    credentials::read(backend, target, identity)
        .map_err(|_| CliError::usage("invalid sync credential JSON in the system credential store"))
}

/// Build the config from flags on top of the existing binding (if any);
/// Resolve secrets from explicit input, the OS store, a saved binding, or a TTY.
fn assemble_config(
    args: &ConfigureArgs,
    existing: Option<SyncBackendConfig>,
    globals: &GlobalOpts,
    credentials: Option<&Value>,
) -> Result<SyncBackendConfig, CliError> {
    let region = args.region.as_deref().unwrap_or("us-east-1");
    let default_endpoint = format!(
        "https://s3.{region}.{}",
        if region.starts_with("cn-") {
            "amazonaws.com.cn"
        } else {
            "amazonaws.com"
        }
    );
    let endpoint = args
        .endpoint
        .as_deref()
        .unwrap_or(&default_endpoint)
        .trim_end_matches('/');
    let reuse = existing
        .as_ref()
        .is_some_and(|previous| match args.backend {
            BackendKind::S3 => {
                previous.backend == SyncBackendKind::S3
                    && endpoint == previous.endpoint.trim_end_matches('/')
                    && args.bucket.as_deref() == Some(&previous.bucket)
            }
            BackendKind::Webdav => {
                previous.backend == SyncBackendKind::Webdav
                    && args.webdav_url.as_deref().map(|x| x.trim_end_matches('/'))
                        == Some(previous.webdav_url.trim_end_matches('/'))
                    && args
                        .webdav_username
                        .as_ref()
                        .is_none_or(|u| u == &previous.webdav_username)
            }
            BackendKind::Git => previous.backend == SyncBackendKind::Git,
        });
    let mut cfg = existing.filter(|_| reuse).unwrap_or_default();
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
    if matches!(args.backend, BackendKind::S3) {
        cfg.endpoint = endpoint.to_owned();
    }
    if matches!(args.backend, BackendKind::S3) && !reuse && args.endpoint.is_some() {
        cfg.force_path_style = true;
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
    if let Some(v) = &args.allow_degraded_sync {
        cfg.allow_degraded_sync = parse_bool_flag("allow-degraded-sync", v)?;
    }
    if let Some(v) = &args.git_ssl_ca_info {
        cfg.git_ssl_ca_info = v.clone();
    }
    let from_store = if credentials.is_none() {
        stored_credentials(&cfg)?
    } else {
        None
    };
    if let Some(credentials) = credentials.or(from_store.as_ref()) {
        let field = |key: &str| {
            credentials
                .get(key)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| CliError::usage(format!("missing credential field {key}")))
        };
        match args.backend {
            BackendKind::S3 => {
                cfg.access_key = field("access_key")?;
                cfg.secret_key = field("secret_key")?;
                cfg.session_token = credentials
                    .get("session_token")
                    .map(|v| {
                        v.as_str()
                            .map(str::to_owned)
                            .ok_or_else(|| CliError::usage("session_token must be a string"))
                    })
                    .transpose()?;
            }
            BackendKind::Webdav => cfg.webdav_password = field("password")?,
            BackendKind::Git => {
                return Err(CliError::usage("git uses the system credential helper"))
            }
        }
    }
    if !args.exclude.is_empty() {
        cfg.scope = scope_from_excludes(&args.exclude)?;
    }

    // Prompt for missing secrets only on an interactive TTY; `--json` and
    // pipes never prompt — the gap then surfaces as a validate() error that
    // points at the supported credential inputs.
    if prompt::allows_interactive(globals) {
        match cfg.backend {
            SyncBackendKind::S3 => {
                if cfg.access_key.trim().is_empty() {
                    cfg.access_key = inquire::Password::new("S3 access key id")
                        .without_confirmation()
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

async fn test(vault: &Path) -> Result<Value, CliError> {
    let _lock = SyncLock::acquire(vault)?;
    let (_, cfg) = entry_for(vault);
    let cfg = cfg.ok_or_else(sync_not_configured)?;
    let conditional = engine::test_connection(vault, &cfg).await?;
    Ok(json!({
        "ok": true,
        "conditionalWrites": conditional,
    }))
}

async fn now(
    vault: &Path,
    selection: Option<&str>,
    progress_flag: bool,
    globals: &GlobalOpts,
) -> Result<Value, CliError> {
    let lock = SyncLock::acquire(vault)?;
    let (_, binding) = binding_for(vault);
    let binding = binding.ok_or_else(sync_not_configured)?;

    let show_progress =
        !globals.quiet && (progress_flag || !matches!(globals.format, OutputFormat::Json));
    let progress = move |phase: &str, current: usize, total: usize| {
        if show_progress {
            eprintln!("sync: {phase} {current}/{total}");
        }
    };

    let outcome = match selection.map(str::trim).filter(|s| !s.is_empty()) {
        None | Some("all") => engine::sync_all_locked(&lock, &binding, &progress, None).await?,
        Some("primary") => engine::sync_vault_locked(&lock, &binding.primary, &progress).await?,
        Some(value) => {
            let index = value
                .parse::<usize>()
                .ok()
                .filter(|n| *n >= 1 && *n <= binding.mirrors.len())
                .ok_or_else(|| {
                    CliError::usage(format!(
                        "unknown backend '{value}' (use all, primary, or a mirror index 1..{})",
                        binding.mirrors.len()
                    ))
                })?;
            engine::publish_mirror(vault, &binding.mirrors[index - 1], &progress).await?
        }
    };
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

async fn overwrite(
    vault: &Path,
    direction: engine::OverwriteDirection,
    progress_flag: bool,
    globals: &GlobalOpts,
) -> Result<Value, CliError> {
    let (_, cfg) = entry_for(vault);
    let cfg = cfg.ok_or_else(sync_not_configured)?;
    let preview = engine::overwrite_preview(vault, &cfg, direction).await?;
    let style = globals.style;
    let summary = match direction {
        engine::OverwriteDirection::RemoteToLocal => format!(
            "remote overwrites local: delete {} local-only file(s), download/restore {} file(s) (remote version {})",
            preview.will_delete_local, preview.will_download, preview.remote_version
        ),
        engine::OverwriteDirection::LocalToRemote => format!(
            "local overwrites remote: upload {} blob(s), drop {} remote-only file(s) from the manifest (remote version {})",
            preview.will_upload, preview.will_remove_remote, preview.remote_version
        ),
    };
    eprintln!("{}", style.key(&summary));
    let message = match direction {
        engine::OverwriteDirection::RemoteToLocal => {
            "Apply remote-over-local overwrite? Divergent local files are discarded without copies."
        }
        engine::OverwriteDirection::LocalToRemote => {
            "Apply local-over-remote overwrite? Remote changes are superseded (old manifests stay on the store)."
        }
    };
    if !prompt::confirm(globals, message, false)? {
        return Err(CliError::needs_confirmation("overwrite cancelled"));
    }
    let lock = SyncLock::acquire(vault)?;
    let show_progress = progress_flag || !matches!(globals.format, OutputFormat::Json);
    let progress = move |phase: &str, current: usize, total: usize| {
        if show_progress {
            eprintln!("sync: {phase} {current}/{total}");
        }
    };
    let outcome = engine::overwrite_locked(&lock, &cfg, direction, &progress).await?;
    let mut v = serde_json::to_value(&outcome)?;
    if let Some(obj) = v.as_object_mut() {
        obj.insert(
            "direction".into(),
            json!(match direction {
                engine::OverwriteDirection::RemoteToLocal => "remoteToLocal",
                engine::OverwriteDirection::LocalToRemote => "localToRemote",
            }),
        );
        obj.insert("preview".into(), serde_json::to_value(&preview)?);
        let lines = vec![format!(
            "{} version={} up={} down={} deleted-local={} removed-remote={}",
            style.ok("overwritten"),
            outcome.version,
            outcome.uploaded,
            outcome.downloaded,
            outcome.deleted_local,
            outcome.removed_remote,
        )];
        obj.insert("lines".into(), json!(lines));
    }
    Ok(v)
}

fn disconnect(vault: &Path, globals: &GlobalOpts) -> Result<Value, CliError> {
    let lock = SyncLock::acquire(vault)?;
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
    sync_config::disconnect(&key, &lock)?;
    Ok(json!({ "disconnected": key }))
}

pub async fn dispatch(route: &str, a: &Value, g: &GlobalOpts) -> Result<Value, CliError> {
    use crate::dispatch::{input_text, string, strings};
    let vault = resolve_vault(g)?;
    let state = || -> Result<Value, CliError> {
        let value = status(&vault, g)?;
        let (_, cfg) = entry_for(&vault);
        let (backend, location) = cfg
            .as_ref()
            .map(|c| (backend_label(c.backend).to_string(), location_of(c)))
            .unzip();
        Ok(json!({
            "backend": backend,
            "location": location,
            "last_run": value["lastSyncAt"],
            "mirrors": value["mirrors"],
        }))
    };
    match route {
        "sync status" => return state(),
        "sync test" => {
            test(&vault).await?;
            return Ok(json!({"ok":true,"checks":[{"outcome":"passed","id":"connection"}]}));
        }
        "sync run" => {
            let selected = a.get("backend").and_then(|v| v.as_str());
            let r = now(&vault, selected, false, g).await?;
            return Ok(
                json!({"uploaded":r["uploaded"],"downloaded":r["downloaded"],"conflicts":r["conflictCopies"],"errors":[]}),
            );
        }
        "sync disconnect" => {
            disconnect(&vault, g)?;
            return Ok(
                json!({"changed":true,"preview":false,"items":[{"outcome":"disconnected"}]}),
            );
        }
        "sync overwrite" => {
            let direction = match string(a, "direction") {
                Some("remote-to-local") | Some("remoteToLocal") => {
                    engine::OverwriteDirection::RemoteToLocal
                }
                Some("local-to-remote") | Some("localToRemote") => {
                    engine::OverwriteDirection::LocalToRemote
                }
                _ => {
                    return Err(CliError::usage(
                        "direction must be remote-to-local or local-to-remote",
                    ))
                }
            };
            let r = overwrite(&vault, direction, false, g).await?;
            return Ok(json!({
                "changed": true,
                "preview": false,
                "direction": r["direction"],
                "version": r["version"],
                "uploaded": r["uploaded"],
                "downloaded": r["downloaded"],
                "deleted_local": r["deletedLocal"],
                "removed_remote": r["removedRemote"],
                "impact": r["preview"],
            }));
        }
        _ => {}
    }
    let flags = ConfigureArgs {
        backend: match route {
            "sync connect s3" => BackendKind::S3,
            "sync connect git" => BackendKind::Git,
            "sync connect webdav" => BackendKind::Webdav,
            _ => return Err(CliError::usage("unknown sync operation")),
        },
        webdav_journal: a["journal"] == true,
        endpoint: string(a, "endpoint").map(str::to_owned),
        region: string(a, "region").map(str::to_owned),
        bucket: string(a, "bucket").map(str::to_owned),
        prefix: string(a, "prefix").map(str::to_owned),
        webdav_url: string(a, "url").map(str::to_owned),
        webdav_username: string(a, "username").map(str::to_owned),
        git_remote: string(a, "remote").map(str::to_owned),
        git_branch: string(a, "branch").map(str::to_owned),
        git_allow_insecure_http: a["allow_insecure_http"].as_bool().map(|v| v.to_string()),
        git_ssl_ca_info: string(a, "ca_file").map(str::to_owned),
        allow_degraded_sync: a["allow_degraded_sync"].as_bool().map(|v| v.to_string()),
        exclude: strings(a, "exclude"),
    };
    let supplied = string(a, "credentials_input")
        .map(|p| serde_json::from_str::<Value>(&input_text(p)?).map_err(CliError::from))
        .transpose()?;
    configure(&vault, &flags, g, supplied.as_ref()).await?;
    state()
}
