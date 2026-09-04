//! Sync credentials — XDG `agentero/sync.json`, keyed by vault root path.
//!
//! Secrets stay outside the vault (the vault itself is what gets synced).
//! The secret key is masked with `*` on the way to the WebView, mirroring the
//! translate API-key convention.

use crate::core::error::AppError;
use crate::core::paths;
use crate::features::settings::{is_translate_api_key_mask, mask_translate_api_key};
use crate::integration::sync::snapshot::SyncScope;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncBackendConfig {
    /// S3-compatible endpoint, e.g. `https://<account>.r2.cloudflarestorage.com`.
    pub endpoint: String,
    #[serde(default = "default_region")]
    pub region: String,
    pub bucket: String,
    /// Optional key prefix inside the bucket (multiple vaults per bucket).
    #[serde(default)]
    pub prefix: String,
    pub access_key: String,
    pub secret_key: String,
    /// `{endpoint}/{bucket}/key` instead of `{bucket}.{endpoint}/key`.
    /// Path style works with R2 / MinIO / AWS alike, so it is the default.
    #[serde(default = "default_true")]
    pub force_path_style: bool,
    /// Automatic background sync: once on scheduler start (vault open), after
    /// 30s of vault quiet, and every `interval_minutes`.
    #[serde(default = "default_true")]
    pub auto_sync: bool,
    #[serde(default = "default_interval_minutes")]
    pub interval_minutes: u32,
    /// Connection-test probe result: `false` for backends whose PutObject
    /// rejects conditional headers (e.g. Aliyun OSS, 400 NotImplemented).
    /// Sync then degrades to plain PUTs; the runtime fallback re-detects.
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

/// Interval choices offered by the settings UI; anything else snaps to 30.
pub const INTERVAL_CHOICES: &[u32] = &[15, 30, 60];

impl SyncBackendConfig {
    pub fn validate(&self) -> Result<(), AppError> {
        if self.endpoint.trim().is_empty()
            || self.bucket.trim().is_empty()
            || self.access_key.trim().is_empty()
            || self.secret_key.trim().is_empty()
        {
            return Err(AppError::message(
                "endpoint, bucket, access key and secret key are required",
            ));
        }
        let url = url::Url::parse(self.endpoint.trim())
            .map_err(|_| AppError::message("endpoint is not a valid URL"))?;
        let host = url.host_str().unwrap_or_default();
        let loopback = host == "localhost"
            || host == "127.0.0.1"
            || host.trim_start_matches('[').trim_end_matches(']') == "::1";
        if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
            return Err(AppError::message(
                "endpoint must use https (plain http is only allowed for localhost)",
            ));
        }
        Ok(())
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
        if !INTERVAL_CHOICES.contains(&self.interval_minutes) {
            self.interval_minutes = default_interval_minutes();
        }
        self
    }

    /// Copy with the secret key replaced by a same-length `*` mask.
    pub fn masked(&self) -> Self {
        let mut out = self.clone();
        out.secret_key = mask_translate_api_key(&out.secret_key);
        out
    }

    /// Restore the previous secret when the UI echoes the mask back.
    pub fn merge_mask(&mut self, previous: Option<&Self>) {
        if is_translate_api_key_mask(&self.secret_key) {
            self.secret_key = previous.map(|p| p.secret_key.clone()).unwrap_or_default();
        }
    }
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
    crate::core::fs::json_store_with(
        &path,
        &SyncConfigFile { vaults },
        &crate::core::fs::AtomicOpts::OWNER_ONLY,
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
}
