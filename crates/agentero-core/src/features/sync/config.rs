//! Sync credentials — XDG `agentero/sync.json`, keyed by vault root path.
//!
//! Secrets stay outside the vault (the vault itself is what gets synced).
//! The secret key is masked with `*` on the way to the WebView, mirroring the
//! translate API-key convention.

use crate::error::AppError;
use crate::features::sync::snapshot::SyncScope;
use crate::paths;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Which remote storage backend a vault syncs through. Legacy `sync.json`
/// entries without the field deserialize as [`SyncBackendKind::S3`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum SyncBackendKind {
    #[default]
    S3,
    Webdav,
    Git,
    /// Official Agentero cloud. The login token is attached at sync time and
    /// is never written to `sync.json`.
    Agentero,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncBackendConfig {
    /// Backend discriminator; S3 fields or WebDAV fields apply accordingly.
    #[serde(default)]
    pub backend: SyncBackendKind,
    /// S3-compatible endpoint, e.g. `https://<account>.r2.cloudflarestorage.com`.
    #[serde(default)]
    pub endpoint: String,
    #[serde(default = "default_region")]
    pub region: String,
    #[serde(default)]
    pub bucket: String,
    /// Optional key prefix inside the bucket (multiple vaults per bucket).
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub access_key: String,
    #[serde(default)]
    pub secret_key: String,
    /// `{endpoint}/{bucket}/key` instead of `{bucket}.{endpoint}/key`.
    /// Path style works with R2 / MinIO / AWS alike, so it is the default.
    #[serde(default = "default_true")]
    pub force_path_style: bool,
    /// WebDAV server directory, e.g. `https://dav.jianguoyun.com/dav/agentero/`.
    #[serde(default)]
    pub webdav_url: String,
    #[serde(default)]
    pub webdav_username: String,
    /// Masked (`*`) on the way to the WebView, like the S3 secret key.
    #[serde(default)]
    pub webdav_password: String,
    /// Git remote URL or local path. Credentials are never stored here; the
    /// system credential helper / SSH agent is used.
    #[serde(default)]
    pub git_remote: String,
    /// Branch to sync. Defaults to `main`; the vault's current branch must
    /// already match when it is an existing repository.
    #[serde(default = "default_git_branch")]
    pub git_branch: String,
    /// `user` or `organization`. Official cloud only.
    #[serde(default = "default_agentero_subject")]
    pub agentero_subject: String,
    /// Organization id when [`Self::agentero_subject`] is `organization`.
    #[serde(default)]
    pub agentero_org_id: String,
    /// API origin, for example `https://api.agentero.app`. No trailing slash.
    #[serde(default)]
    pub agentero_api: String,
    /// Session bearer. Not serialized; the host fills it from the keychain.
    #[serde(skip)]
    #[specta(skip)]
    pub agentero_token: String,
    /// Automatic background sync: once on scheduler start (vault open), after
    /// 30s of vault quiet, and every `interval_minutes`.
    #[serde(default = "default_true")]
    pub auto_sync: bool,
    #[serde(default = "default_interval_minutes")]
    pub interval_minutes: u32,
    /// Connection-test probe result: `false` for backends whose PUT rejects
    /// or ignores conditional headers (e.g. Aliyun OSS 400 NotImplemented,
    /// most WebDAV servers). Sync then degrades to plain PUTs.
    #[serde(default = "default_true")]
    pub conditional_writes: bool,
    /// Which bulky paper assets (PDF / LaTeX source / attachments) take part
    /// in sync. Notes, sidecars and marks always sync. Default: everything.
    #[serde(default)]
    pub scope: SyncScope,
}

fn default_region() -> String {
    "us-east-1".into()
}

fn default_true() -> bool {
    true
}

fn default_interval_minutes() -> u32 {
    30
}

fn default_git_branch() -> String {
    "main".into()
}

fn default_agentero_subject() -> String {
    "user".into()
}

/// Fill an official-cloud config from the environment when the host did not
/// attach a session. Empty values are left alone.
pub fn hydrate_agentero(cfg: &mut SyncBackendConfig) {
    if cfg.backend != SyncBackendKind::Agentero {
        return;
    }
    if cfg.agentero_token.trim().is_empty() {
        if let Ok(token) = std::env::var("AGENTERO_SYNC_TOKEN") {
            let token = token.trim().to_string();
            if !token.is_empty() {
                cfg.agentero_token = token;
            }
        }
    }
    if cfg.agentero_api.trim().is_empty() {
        if let Ok(api) = std::env::var("AGENTERO_SYNC_API") {
            let api = api.trim().trim_end_matches('/').to_string();
            if !api.is_empty() {
                cfg.agentero_api = api;
            }
        }
    }
}

/// Interval choices offered by the settings UI; anything else snaps to 30.
pub const INTERVAL_CHOICES: &[u32] = &[15, 30, 60];

/// Replace a non-empty secret with the same number of `*` characters (same
/// convention as the desktop translate API-key mask).
fn mask_secret(secret: &str) -> String {
    let n = secret.trim().chars().count();
    if n == 0 {
        String::new()
    } else {
        "*".repeat(n)
    }
}

/// True when a value came back from [`SyncBackendConfig::masked`] (all `*`).
fn is_masked_secret(value: &str) -> bool {
    let t = value.trim();
    !t.is_empty() && t.chars().all(|c| c == '*')
}

impl SyncBackendConfig {
    pub fn validate(&self) -> Result<(), AppError> {
        match self.backend {
            SyncBackendKind::S3 => {
                if self.endpoint.trim().is_empty()
                    || self.bucket.trim().is_empty()
                    || self.access_key.trim().is_empty()
                    || self.secret_key.trim().is_empty()
                {
                    return Err(AppError::message(
                        "endpoint, bucket, access key and secret key are required",
                    ));
                }
                require_https("endpoint", &self.endpoint)
            }
            SyncBackendKind::Webdav => {
                if self.webdav_url.trim().is_empty()
                    || self.webdav_username.trim().is_empty()
                    || self.webdav_password.is_empty()
                {
                    return Err(AppError::message(
                        "server url, username and password are required",
                    ));
                }
                require_https("server url", &self.webdav_url)
            }
            SyncBackendKind::Git => {
                validate_git_remote(&self.git_remote)?;
                validate_branch(&self.git_branch)
            }
            SyncBackendKind::Agentero => {
                if self.agentero_subject != "user" && self.agentero_subject != "organization" {
                    return Err(AppError::message(
                        "cloud sync target must be a personal or team space",
                    ));
                }
                if self.agentero_subject == "organization" && self.agentero_org_id.trim().is_empty()
                {
                    return Err(AppError::message("choose a team to sync to"));
                }
                if self.agentero_token.trim().is_empty() {
                    return Err(AppError::message("sign in to use Agentero cloud sync"));
                }
                require_https("api", &self.agentero_api)
            }
        }
    }

    pub fn normalized(mut self) -> Self {
        self.endpoint = self.endpoint.trim().trim_end_matches('/').to_string();
        self.region = self.region.trim().to_string();
        if self.region.is_empty() {
            self.region = default_region();
        }
        self.bucket = self.bucket.trim().to_string();
        self.prefix = self.prefix.trim().trim_matches('/').to_string();
        self.access_key = self.access_key.trim().to_string();
        self.secret_key = self.secret_key.trim().to_string();
        self.webdav_url = normalize_webdav_url(&self.webdav_url);
        self.webdav_username = self.webdav_username.trim().to_string();
        self.webdav_password = self.webdav_password.trim().to_string();
        self.git_remote = self.git_remote.trim().to_string();
        self.git_branch = self.git_branch.trim().to_string();
        if self.git_branch.is_empty() {
            self.git_branch = default_git_branch();
        }
        self.agentero_api = self.agentero_api.trim().trim_end_matches('/').to_string();
        self.agentero_subject = self.agentero_subject.trim().to_string();
        if self.agentero_subject.is_empty() {
            self.agentero_subject = default_agentero_subject();
        }
        self.agentero_org_id = self.agentero_org_id.trim().to_string();
        self.agentero_token = self.agentero_token.trim().to_string();
        if self.backend == SyncBackendKind::Git {
            // Git is a full-vault mirror; the partial scope filter has no
            // meaning there (and is hidden in the settings UI).
            self.scope = SyncScope::all();
        }
        if !INTERVAL_CHOICES.contains(&self.interval_minutes) {
            self.interval_minutes = default_interval_minutes();
        }
        self
    }

    /// Copy with the secrets replaced by a same-length `*` mask.
    pub fn masked(&self) -> Self {
        let mut out = self.clone();
        out.secret_key = mask_secret(&out.secret_key);
        out.webdav_password = mask_secret(&out.webdav_password);
        out.agentero_token.clear();
        out
    }

    /// Restore the previous secret when the UI echoes the mask back.
    pub fn merge_mask(&mut self, previous: Option<&Self>) {
        if is_masked_secret(&self.secret_key) {
            self.secret_key = previous.map(|p| p.secret_key.clone()).unwrap_or_default();
        }
        if is_masked_secret(&self.webdav_password) {
            self.webdav_password = previous
                .map(|p| p.webdav_password.clone())
                .unwrap_or_default();
        }
    }

    /// Which remote store this config points at, for local state that must not
    /// survive being repointed at a different one. Carries no secret: the value
    /// is only ever compared, and callers hash it before it reaches the vault.
    pub fn remote_identity(&self) -> String {
        match self.backend {
            SyncBackendKind::S3 => format!(
                "s3|{}|{}|{}|{}",
                self.endpoint, self.bucket, self.prefix, self.access_key
            ),
            SyncBackendKind::Webdav => format!(
                "webdav|{}|{}",
                normalize_webdav_url(&self.webdav_url),
                self.webdav_username
            ),
            SyncBackendKind::Git => {
                format!("git|{}|{}", self.git_remote.trim(), self.git_branch.trim())
            }
            SyncBackendKind::Agentero => format!(
                "agentero|{}|{}|{}",
                self.agentero_api, self.agentero_subject, self.agentero_org_id
            ),
        }
    }
}

/// Folder the app uses when the user points at Jianguoyun's WebDAV root.
const JIANGUOYUN_ROOT_FOLDER: &str = "agentero";

/// Normalize a user-entered WebDAV directory URL (trailing slashes trimmed).
///
/// Jianguoyun's WebDAV root (`https://dav.jianguoyun.com/dav/`) lists the
/// account tree but refuses file creation inside it — every PUT answers 404
/// ObjectNotFound — and that root address is exactly what the provider's
/// docs tell users to copy. Map it onto a dedicated folder under the root so
/// the paste-the-official-address path just works. Fixed name + pure
/// function: every device (and every app version) resolves the same
/// directory. Idempotent, so applying it on top of an already-expanded URL
/// is a no-op.
pub(crate) fn normalize_webdav_url(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    let Ok(mut url) = url::Url::parse(trimmed) else {
        return trimmed.to_string();
    };
    if url.host_str() == Some("dav.jianguoyun.com") && url.path() == "/dav" {
        url.set_path(&format!("/dav/{JIANGUOYUN_ROOT_FOLDER}"));
        return url.to_string();
    }
    trimmed.to_string()
}

/// https only, plain http reserved for loopback development servers.
fn require_https(label: &str, raw: &str) -> Result<(), AppError> {
    let url = url::Url::parse(raw.trim())
        .map_err(|_| AppError::message(format!("{label} is not a valid URL")))?;
    if url.scheme() != "https"
        && !(url.scheme() == "http" && is_loopback_host(url.host_str().unwrap_or_default()))
    {
        return Err(AppError::message(format!(
            "{label} must use https (plain http is only allowed for localhost)"
        )));
    }
    Ok(())
}

fn is_loopback_host(host: &str) -> bool {
    host == "localhost"
        || host == "127.0.0.1"
        || host.trim_start_matches('[').trim_end_matches(']') == "::1"
}

/// Git remotes cannot carry secrets in `sync.json`. Allow the transports the
/// system git binary understands without a custom remote helper.
fn validate_git_remote(raw: &str) -> Result<(), AppError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(AppError::message("repository url is required"));
    }
    if value.starts_with('-') || value.chars().any(char::is_control) {
        return Err(AppError::message("repository url is invalid"));
    }
    if value.contains("://") {
        if value.chars().any(char::is_whitespace) {
            return Err(AppError::message("repository url is invalid"));
        }
        let url = url::Url::parse(value)
            .map_err(|_| AppError::message("repository url is not a valid URL"))?;
        match url.scheme() {
            "https" | "http" => {
                if url.host_str().is_none() {
                    return Err(AppError::message("repository url has no host"));
                }
                if url.scheme() == "http"
                    && !is_loopback_host(url.host_str().unwrap_or_default())
                {
                    return Err(AppError::message(
                        "repository url must use https (plain http is only allowed for localhost)",
                    ));
                }
                if !url.username().is_empty() || url.password().is_some() {
                    return Err(AppError::message(
                        "repository url must not embed credentials; use the system Git credential helper or SSH",
                    ));
                }
            }
            "ssh" => {
                if url.host_str().is_none() {
                    return Err(AppError::message("repository url has no host"));
                }
                if url.password().is_some() {
                    return Err(AppError::message(
                        "repository url must not embed a password; use the SSH agent",
                    ));
                }
            }
            "file" => {
                url.to_file_path()
                    .map_err(|_| AppError::message("repository url is not a valid file URL"))?;
            }
            other => {
                return Err(AppError::message(format!(
                    "repository url scheme '{other}' is not supported (use https, ssh, file, or a local path)"
                )))
            }
        }
        return Ok(());
    }
    // A local bare repo / NAS mount is a valid Git remote and keeps the
    // headless tests offline. Absolute paths may contain spaces.
    if Path::new(value).is_absolute() {
        return Ok(());
    }
    if is_scp_like_git_remote(value) {
        return Ok(());
    }
    Err(AppError::message(
        "repository url must be an absolute path, file:// URL, https/ssh URL, or git@host:path",
    ))
}

fn is_scp_like_git_remote(value: &str) -> bool {
    if value.chars().any(char::is_whitespace) {
        return false;
    }
    let Some((user_host, path)) = value.split_once(':') else {
        return false;
    };
    if path.is_empty() {
        return false;
    }
    let Some((user, host)) = user_host.rsplit_once('@') else {
        return false;
    };
    !user.is_empty() && !host.is_empty() && !host.contains(':')
}

fn validate_branch(raw: &str) -> Result<(), AppError> {
    let branch = raw.trim();
    let invalid = branch.is_empty()
        || branch == "HEAD"
        || branch == "@"
        || branch.starts_with('-')
        || branch.starts_with('/')
        || branch.ends_with('/')
        || branch.ends_with('.')
        || branch.ends_with(".lock")
        || branch.contains("..")
        || branch.contains("@{")
        || branch.contains("//")
        || branch
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || "~^:?*[\\".contains(c))
        || branch
            .split('/')
            .any(|component| component.is_empty() || component.starts_with('.'));
    if invalid {
        return Err(AppError::message(format!(
            "invalid Git branch name: {branch}"
        )));
    }
    Ok(())
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct SyncConfigFile {
    #[serde(default)]
    vaults: HashMap<String, SyncBackendConfig>,
}

fn config_path() -> PathBuf {
    paths::agentero_config_dir().join("sync.json")
}

fn read_all() -> HashMap<String, SyncBackendConfig> {
    let path = config_path();
    let Ok(raw) = fs::read_to_string(&path) else {
        return HashMap::new();
    };
    match serde_json::from_str::<SyncConfigFile>(&raw) {
        Ok(file) => file.vaults,
        Err(e) => {
            log::warn!(target: "agentero::sync", "invalid sync.json: {e}");
            HashMap::new()
        }
    }
}

/// All configured vaults (used at app start / exit to drive auto sync).
pub fn list_all() -> HashMap<String, SyncBackendConfig> {
    read_all()
}

fn write_all(vaults: HashMap<String, SyncBackendConfig>) -> Result<(), AppError> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    // Owner-only (0o600 on Unix): this file holds S3 credentials.
    crate::fs::json_store_with(
        &path,
        &SyncConfigFile { vaults },
        &crate::fs::AtomicOpts::OWNER_ONLY,
    )
}

pub fn get(vault_path: &str) -> Option<SyncBackendConfig> {
    read_all().remove(vault_path)
}

pub fn set(vault_path: &str, config: SyncBackendConfig) -> Result<(), AppError> {
    let mut all = read_all();
    all.insert(vault_path.to_string(), config);
    write_all(all)
}

pub fn remove(vault_path: &str) -> Result<(), AppError> {
    let mut all = read_all();
    if all.remove(vault_path).is_some() {
        write_all(all)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_config_without_auto_sync_fields_gets_defaults() {
        let cfg: SyncBackendConfig = serde_json::from_str(
            r#"{"endpoint":"http://x","region":"r","bucket":"b","prefix":"",
                "accessKey":"a","secretKey":"s","forcePathStyle":true}"#,
        )
        .unwrap();
        assert!(cfg.auto_sync);
        assert_eq!(cfg.interval_minutes, 30);
        assert!(cfg.scope.is_all());
    }

    #[test]
    fn legacy_config_without_backend_field_stays_s3() {
        let cfg: SyncBackendConfig = serde_json::from_str(
            r#"{"endpoint":"https://x","bucket":"b","accessKey":"a","secretKey":"s"}"#,
        )
        .unwrap();
        assert_eq!(cfg.backend, SyncBackendKind::S3);
    }

    #[test]
    fn webdav_config_roundtrips() {
        let cfg = SyncBackendConfig {
            backend: SyncBackendKind::Webdav,
            webdav_url: "https://dav.jianguoyun.com/dav/agentero/".into(),
            webdav_username: "u@example.com".into(),
            webdav_password: "secret".into(),
            ..SyncBackendConfig::default()
        };
        let raw = serde_json::to_string(&cfg).unwrap();
        assert!(raw.contains(r#""backend":"webdav""#));
        let back: SyncBackendConfig = serde_json::from_str(&raw).unwrap();
        assert_eq!(back, cfg);
    }

    #[test]
    fn webdav_secrets_are_masked_and_merged_back() {
        let mut cfg = SyncBackendConfig {
            backend: SyncBackendKind::Webdav,
            webdav_url: "https://dav.example.com/dav/".into(),
            webdav_username: "u".into(),
            webdav_password: "hunter2".into(),
            ..SyncBackendConfig::default()
        };
        let masked = cfg.masked();
        assert_eq!(masked.webdav_password, "*******");
        assert_eq!(cfg.webdav_password, "hunter2");
        let previous = cfg.clone();
        cfg.webdav_password = masked.webdav_password;
        cfg.merge_mask(Some(&previous));
        assert_eq!(cfg.webdav_password, "hunter2");
    }

    #[test]
    fn validate_branches_by_backend() {
        let webdav = SyncBackendConfig {
            backend: SyncBackendKind::Webdav,
            webdav_url: "https://dav.example.com/dav/".into(),
            webdav_username: "u".into(),
            webdav_password: "p".into(),
            ..SyncBackendConfig::default()
        };
        assert!(webdav.validate().is_ok());
        // S3 fields stay empty: the S3 rules must not apply to a WebDAV config.
        assert!(webdav.normalized().validate().is_ok());
        let mut webdav = SyncBackendConfig {
            backend: SyncBackendKind::Webdav,
            webdav_url: "https://dav.example.com/dav/".into(),
            webdav_username: "u".into(),
            webdav_password: "p".into(),
            ..SyncBackendConfig::default()
        };
        webdav.webdav_url = "http://dav.example.com/dav/".into();
        assert!(webdav.validate().is_err());
        webdav.webdav_url = "http://127.0.0.1:5005/agentero".into();
        assert!(webdav.validate().is_ok());
        webdav.webdav_username = String::new();
        assert!(webdav.validate().is_err());

        let mut s3 = SyncBackendConfig {
            endpoint: "https://example.r2.cloudflarestorage.com".into(),
            bucket: "b".into(),
            access_key: "a".into(),
            secret_key: "s".into(),
            ..SyncBackendConfig::default()
        };
        assert!(s3.validate().is_ok());
        // WebDAV fields stay empty: WebDAV rules must not apply to an S3 config.
        s3.endpoint = "http://example.com".into();
        assert!(s3.validate().is_err());
        s3.endpoint = "not a url".into();
        assert!(s3.validate().is_err());
    }

    #[test]
    fn normalized_snaps_unknown_interval_to_default() {
        let mut cfg = SyncBackendConfig {
            endpoint: "http://x/".into(),
            interval_minutes: 7,
            ..SyncBackendConfig::default()
        };
        cfg = cfg.normalized();
        assert_eq!(cfg.interval_minutes, 30);
        assert_eq!(cfg.endpoint, "http://x");
        cfg.interval_minutes = 60;
        assert_eq!(cfg.normalized().interval_minutes, 60);
    }

    #[test]
    fn jianguoyun_webdav_root_maps_to_the_reserved_folder() {
        for raw in [
            "https://dav.jianguoyun.com/dav",
            "https://dav.jianguoyun.com/dav/",
            "  https://dav.jianguoyun.com/dav///  ",
        ] {
            let effective = normalize_webdav_url(raw);
            assert_eq!(effective, "https://dav.jianguoyun.com/dav/agentero");
            // Idempotent: re-saving the expanded address must not move data.
            assert_eq!(normalize_webdav_url(&effective), effective);
        }
        let cfg = SyncBackendConfig {
            backend: SyncBackendKind::Webdav,
            webdav_url: "https://dav.jianguoyun.com/dav/".into(),
            ..SyncBackendConfig::default()
        };
        assert_eq!(
            cfg.normalized().webdav_url,
            "https://dav.jianguoyun.com/dav/agentero"
        );
    }

    #[test]
    fn webdav_url_normalization_touches_nothing_else() {
        for (raw, expected) in [
            (
                "https://dav.jianguoyun.com/dav/agentero/",
                "https://dav.jianguoyun.com/dav/agentero",
            ),
            (
                "https://dav.jianguoyun.com/dav/%E8%B5%84%E6%96%99",
                "https://dav.jianguoyun.com/dav/%E8%B5%84%E6%96%99",
            ),
            (
                "https://cloud.example.com/dav/",
                "https://cloud.example.com/dav",
            ),
            ("https://dav.jianguoyun.com/", "https://dav.jianguoyun.com"),
            (
                "http://127.0.0.1:5005/agentero/",
                "http://127.0.0.1:5005/agentero",
            ),
        ] {
            assert_eq!(normalize_webdav_url(raw), expected, "raw: {raw}");
        }
    }

    #[test]
    fn validate_requires_https_except_loopback() {
        let mut cfg = SyncBackendConfig {
            endpoint: "https://example.r2.cloudflarestorage.com".into(),
            bucket: "b".into(),
            access_key: "a".into(),
            secret_key: "s".into(),
            ..SyncBackendConfig::default()
        };
        assert!(cfg.validate().is_ok());
        cfg.endpoint = "http://example.com".into();
        assert!(cfg.validate().is_err());
        cfg.endpoint = "http://127.0.0.1:9000".into();
        assert!(cfg.validate().is_ok());
        cfg.endpoint = "http://localhost:9000".into();
        assert!(cfg.validate().is_ok());
        cfg.endpoint = "not a url".into();
        assert!(cfg.validate().is_err());
    }

    fn git_config(remote: &str, branch: &str) -> SyncBackendConfig {
        SyncBackendConfig {
            backend: SyncBackendKind::Git,
            git_remote: remote.into(),
            git_branch: branch.into(),
            ..SyncBackendConfig::default()
        }
    }

    #[test]
    fn git_config_roundtrips_defaults_and_normalizes() {
        let cfg: SyncBackendConfig = serde_json::from_str(r#"{"backend":"git"}"#).unwrap();
        assert_eq!(cfg.backend, SyncBackendKind::Git);
        assert_eq!(cfg.git_branch, "main");
        assert!(cfg.git_remote.is_empty());

        let cfg = git_config("  https://github.com/u/papers.git  ", "").normalized();
        assert_eq!(cfg.git_remote, "https://github.com/u/papers.git");
        assert_eq!(cfg.git_branch, "main");
        assert!(cfg.scope.is_all());
        assert_eq!(
            cfg.remote_identity(),
            "git|https://github.com/u/papers.git|main"
        );
    }

    #[test]
    fn agentero_token_is_not_persisted_and_requires_sign_in() {
        let cfg = SyncBackendConfig {
            backend: SyncBackendKind::Agentero,
            agentero_api: "https://api.agentero.app".into(),
            agentero_token: "secret-token".into(),
            ..SyncBackendConfig::default()
        }
        .normalized();
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(!json.contains("secret-token"));
        assert!(json.contains("agentero"));
        assert!(cfg.validate().is_ok());
        let mut signed_out = cfg.clone();
        signed_out.agentero_token.clear();
        assert!(signed_out.validate().is_err());
        assert_eq!(
            cfg.remote_identity(),
            "agentero|https://api.agentero.app|user|"
        );
    }

    #[test]
    fn git_remote_validation_accepts_supported_transports() {
        let local = std::env::temp_dir().join("papers.git");
        let local_slash = local.to_string_lossy().replace('\\', "/");
        let file_url = if local_slash.starts_with('/') {
            format!("file://{local_slash}")
        } else {
            format!("file:///{local_slash}")
        };
        let remotes = [
            "https://github.com/u/papers.git".to_string(),
            "ssh://git@example.com/u/papers.git".to_string(),
            "git@github.com:u/papers.git".to_string(),
            file_url,
            local.to_string_lossy().into_owned(),
            "http://127.0.0.1:9000/papers.git".to_string(),
        ];
        for remote in &remotes {
            assert!(
                git_config(remote, "main").validate().is_ok(),
                "remote {remote:?} should be accepted"
            );
        }
    }

    #[test]
    fn git_remote_validation_rejects_secrets_and_helpers() {
        for remote in [
            "https://user:secret@github.com/u/papers.git",
            "https://user@github.com/u/papers.git",
            "ssh://git:secret@example.com/u/papers.git",
            "ext::sh -c echo",
            "git://github.com/u/papers.git",
            "http://example.com/papers.git",
            "relative/path",
            "-uhttps://github.com/u/papers.git",
            "",
        ] {
            assert!(
                git_config(remote, "main").validate().is_err(),
                "remote {remote:?} must be rejected"
            );
        }
    }

    #[test]
    fn git_branch_validation_rejects_invalid_refs() {
        for branch in [
            "",
            "HEAD",
            "@",
            "-main",
            "/main",
            "main/",
            "main.",
            "main.lock",
            "a..b",
            "a@{b",
            "a//b",
            "a b",
            ".main",
            "a/.b",
            "a\\b",
            "a~b",
        ] {
            assert!(
                git_config("https://example.com/r.git", branch)
                    .validate()
                    .is_err(),
                "branch {branch:?} must be rejected"
            );
        }
        for branch in ["main", "feature/sync", "release-2026.10"] {
            assert!(
                git_config("https://example.com/r.git", branch)
                    .validate()
                    .is_ok(),
                "branch {branch:?} should be accepted"
            );
        }
    }

    #[test]
    fn git_config_forces_full_scope() {
        let mut cfg = git_config("https://example.com/r.git", "main");
        cfg.scope = SyncScope {
            pdf: false,
            source: false,
            attachments: false,
        };
        assert!(cfg.normalized().scope.is_all());
    }
}
