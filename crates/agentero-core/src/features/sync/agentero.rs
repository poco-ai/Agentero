//! Official Agentero cloud. The client sends relative object keys and a login
//! bearer; the server owns the bucket prefix, the quota, and tenant isolation.

use crate::error::AppError;
use crate::features::sync::config::SyncBackendConfig;
use crate::features::sync::local;
use crate::features::sync::store::{
    check, etag_of, send_with_retries, PutCondition, PutOutcome, RemoteStore,
};
use crate::http;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use tokio::sync::Mutex;

pub struct AgenteroClient {
    http: reqwest::Client,
    api: String,
    token: String,
    subject: String,
    org_id: String,
    vault: PathBuf,
    server_id: Mutex<Option<String>>,
}

#[derive(Deserialize)]
struct ApiOk<T> {
    data: Option<T>,
}

#[derive(Deserialize)]
struct VaultRef {
    id: String,
}

impl AgenteroClient {
    pub fn new(cfg: &SyncBackendConfig, vault: &Path) -> Result<Self, AppError> {
        if cfg.agentero_token.trim().is_empty() {
            return Err(AppError::message("sign in to use Agentero cloud sync"));
        }
        if cfg.agentero_api.trim().is_empty() {
            return Err(AppError::message("cloud sync api is not configured"));
        }
        Ok(Self {
            http: http::client_builder()
                .build()
                .map_err(|e| AppError::message(e.to_string()))?,
            api: cfg.agentero_api.trim().trim_end_matches('/').to_string(),
            token: cfg.agentero_token.clone(),
            subject: cfg.agentero_subject.clone(),
            org_id: cfg.agentero_org_id.clone(),
            vault: vault.to_path_buf(),
            server_id: Mutex::new(None),
        })
    }

    fn auth(&self, builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        builder.bearer_auth(&self.token)
    }

    async fn server_id(&self) -> Result<String, AppError> {
        let mut guard = self.server_id.lock().await;
        if let Some(id) = guard.as_ref() {
            return Ok(id.clone());
        }
        let id = self.register().await?;
        *guard = Some(id.clone());
        Ok(id)
    }

    async fn register(&self) -> Result<String, AppError> {
        let vault_id = local::ensure_vault_id(&self.vault)?;
        let name = self
            .vault
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("Vault");
        let mut body = serde_json::json!({
            "vaultId": vault_id,
            "name": name,
            "subject": self.subject,
        });
        if self.subject == "organization" {
            body["subjectId"] = serde_json::Value::String(self.org_id.clone());
        }
        let url = format!("{}/api/sync/vaults", self.api);
        let resp = send_with_retries(&reqwest::Method::POST, &url, || {
            self.auth(self.http.post(&url).json(&body))
        })
        .await?;
        if resp.status().as_u16() == 401 {
            return Err(AppError::message("sign in to use Agentero cloud sync"));
        }
        let resp = check(resp, "register", "vault").await?;
        let parsed: ApiOk<VaultRef> = resp
            .json()
            .await
            .map_err(|e| AppError::message(format!("register vault: {e}")))?;
        parsed
            .data
            .map(|vault| vault.id)
            .ok_or_else(|| AppError::message("register vault: empty response"))
    }

    fn object_url(&self, id: &str, key: &str) -> String {
        format!("{}/api/sync/vaults/{id}/objects/{key}", self.api)
    }
}

impl RemoteStore for AgenteroClient {
    async fn ensure_root(&self) -> Result<(), AppError> {
        self.server_id().await?;
        Ok(())
    }

    async fn get(&self, key: &str) -> Result<Option<(Vec<u8>, String)>, AppError> {
        let id = self.server_id().await?;
        let url = self.object_url(&id, key);
        let resp = send_with_retries(&reqwest::Method::GET, &url, || {
            self.auth(self.http.get(&url))
        })
        .await?;
        let status = resp.status().as_u16();
        if status == 404 {
            return Ok(None);
        }
        if status == 401 {
            return Err(AppError::message("sign in to use Agentero cloud sync"));
        }
        let resp = check(resp, "get", key).await?;
        let etag = etag_of(&resp);
        let body = resp
            .bytes()
            .await
            .map_err(|e| AppError::message(format!("get {key}: {e}")))?
            .to_vec();
        Ok(Some((body, etag)))
    }

    async fn put(
        &self,
        key: &str,
        body: Vec<u8>,
        condition: PutCondition,
    ) -> Result<PutOutcome, AppError> {
        let id = self.server_id().await?;
        let url = self.object_url(&id, key);
        let condition_header = condition.header()?;
        let resp = send_with_retries(&reqwest::Method::PUT, &url, || {
            let mut req = self.http.put(&url).body(body.clone());
            if let Some((header, value)) = &condition_header {
                req = req.header(*header, value);
            }
            self.auth(req)
        })
        .await?;
        let status = resp.status().as_u16();
        if status == 412 || status == 409 {
            return Ok(PutOutcome::PreconditionFailed);
        }
        if status == 401 {
            return Err(AppError::message("sign in to use Agentero cloud sync"));
        }
        check(resp, "put", key).await?;
        Ok(PutOutcome::Ok)
    }

    async fn probe_conditional_writes(&self) -> Result<bool, AppError> {
        // The API always honors If-Match / If-None-Match. A probe object would
        // not be on the relative-key allowlist.
        Ok(true)
    }
}
