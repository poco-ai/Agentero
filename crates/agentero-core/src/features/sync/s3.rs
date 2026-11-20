//! Minimal S3-compatible client — exactly what sync needs and nothing more:
//! GET / PUT (with conditional writes) / ListObjectsV2, signed with SigV4.
//! Implements the [`RemoteStore`] contract; retry/error plumbing is shared
//! in `store.rs`.
//!
//! Conditional writes are mandatory; never retry as an unconditional PUT.

use crate::error::AppError;
use crate::features::sync::config::SyncBackendConfig;
use crate::features::sync::store::{
    check, etag_of, send_with_retries, PutCondition, PutOutcome, RemoteStore,
};
use crate::http;
use chrono::Utc;
use sha2::{Digest, Sha256};

pub struct S3Client {
    http: reqwest::Client,
    /// `scheme://host[:port]` after bucket placement (virtual-host or path style).
    base_url: String,
    host: String,
    /// `/bucket` for path style, `` for virtual-host style.
    base_path: String,
    /// Normalized `prefix/` (or empty) prepended to every object key.
    key_prefix: String,
    region: String,
    access_key: String,
    secret_key: String,
    session_token: Option<String>,
}

impl S3Client {
    pub fn new(cfg: &SyncBackendConfig) -> Result<Self, AppError> {
        let url = url::Url::parse(&cfg.endpoint)
            .map_err(|e| AppError::message(format!("invalid endpoint: {e}")))?;
        let scheme = url.scheme().to_string();
        let mut host = url
            .host_str()
            .ok_or_else(|| AppError::message("endpoint has no host"))?
            .to_string();
        if let Some(port) = url.port() {
            host = format!("{host}:{port}");
        }
        let base_path = if cfg.force_path_style {
            format!("/{}", cfg.bucket)
        } else {
            host = format!("{}.{host}", cfg.bucket);
            String::new()
        };
        let key_prefix = if cfg.prefix.is_empty() {
            String::new()
        } else {
            format!("{}/", cfg.prefix)
        };
        Ok(Self {
            http: http::client_builder()
                .build()
                .map_err(|e| AppError::message(e.to_string()))?,
            base_url: format!("{scheme}://{host}"),
            host,
            base_path,
            key_prefix,
            region: cfg.region.clone(),
            access_key: cfg.access_key.clone(),
            secret_key: cfg.secret_key.clone(),
            session_token: cfg.session_token.clone(),
        })
    }

    /// DELETE an object. 404 counts as success (idempotent cleanup).
    async fn delete(&self, key: &str) -> Result<(), AppError> {
        let resp = self.send("DELETE", key, &[], None, Vec::new()).await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(());
        }
        check(resp, "DELETE", key).await.map(|_| ())
    }

    /// List up to `max` keys under `prefix` (relative to the configured
    /// prefix). Used by the connection test (`ensure_root`) and by GC.
    async fn list(&self, prefix: &str, max: u32) -> Result<Vec<String>, AppError> {
        let full_prefix = format!("{}{prefix}", self.key_prefix);
        let query = [
            ("list-type".to_string(), "2".to_string()),
            ("max-keys".to_string(), max.to_string()),
            ("prefix".to_string(), full_prefix.clone()),
        ];
        let resp = self.send("GET", "", &query, None, Vec::new()).await?;
        let resp = check(resp, "LIST", &full_prefix).await?;
        let body = resp
            .text()
            .await
            .map_err(|e| AppError::message(e.to_string()))?;
        // Keys are our own ASCII-safe layout; a full XML parser is overkill.
        let mut keys = Vec::new();
        let mut rest = body.as_str();
        while let Some(start) = rest.find("<Key>") {
            let tail = &rest[start + 5..];
            let Some(end) = tail.find("</Key>") else {
                break;
            };
            keys.push(tail[..end].to_string());
            rest = &tail[end..];
        }
        Ok(keys)
    }

    /// Sign and send one request. `key` empty → bucket-level request.
    async fn send(
        &self,
        method: &str,
        key: &str,
        query: &[(String, String)],
        extra_header: Option<(&str, String)>,
        body: Vec<u8>,
    ) -> Result<reqwest::Response, AppError> {
        let uri = if key.is_empty() {
            format!("{}/", self.base_path)
        } else {
            format!("{}/{}{key}", self.base_path, self.key_prefix)
        };
        let now = Utc::now();
        let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
        let date = now.format("%Y%m%d").to_string();
        let payload_hash = hex::encode(Sha256::digest(&body));

        let mut sorted_query: Vec<(String, String)> = query.to_vec();
        sorted_query.sort();
        let canonical_query = sorted_query
            .iter()
            .map(|(k, v)| format!("{}={}", uri_encode(k), uri_encode(v)))
            .collect::<Vec<_>>()
            .join("&");

        let mut headers = format!(
            "host:{}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n",
            self.host
        );
        let mut signed_headers = String::from("host;x-amz-content-sha256;x-amz-date");
        if let Some(token) = &self.session_token {
            headers.push_str(&format!("x-amz-security-token:{token}\n"));
            signed_headers.push_str(";x-amz-security-token");
        }
        let canonical_request = format!(
            "{method}\n{uri}\n{canonical_query}\n{headers}\n{signed_headers}\n{payload_hash}"
        );
        let scope = format!("{date}/{}/s3/aws4_request", self.region);
        let string_to_sign = format!(
            "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
            hex::encode(Sha256::digest(canonical_request.as_bytes()))
        );
        let k_date = hmac_sha256(
            format!("AWS4{}", self.secret_key).as_bytes(),
            date.as_bytes(),
        );
        let k_region = hmac_sha256(&k_date, self.region.as_bytes());
        let k_service = hmac_sha256(&k_region, b"s3");
        let k_signing = hmac_sha256(&k_service, b"aws4_request");
        let signature = hex::encode(hmac_sha256(&k_signing, string_to_sign.as_bytes()));
        let authorization = format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
            self.access_key
        );

        let url = if canonical_query.is_empty() {
            format!("{}{uri}", self.base_url)
        } else {
            format!("{}{uri}?{canonical_query}", self.base_url)
        };
        let method = method
            .parse::<reqwest::Method>()
            .map_err(|e| AppError::message(e.to_string()))?;
        let extra = extra_header.map(|(name, value)| (name, value.clone()));
        // Transport-level retries live in `send_with_retries`; every sync
        // operation is idempotent (see its doc comment).
        send_with_retries(&method, &url, || {
            let mut req = self
                .http
                .request(method.clone(), url.clone())
                .header("x-amz-date", amz_date.clone())
                .header("x-amz-content-sha256", payload_hash.clone())
                .header("authorization", authorization.clone());
            if let Some(token) = &self.session_token {
                req = req.header("x-amz-security-token", token);
            }
            if let Some((name, value)) = &extra {
                req = req.header(*name, value.clone());
            }
            if !body.is_empty() || method == reqwest::Method::PUT {
                req = req.body(body.clone());
            }
            req
        })
        .await
    }
}

impl RemoteStore for S3Client {
    /// Bucket access check via a one-key listing.
    async fn ensure_root(&self) -> Result<(), AppError> {
        self.list("", 1).await.map(|_| ())
    }

    /// GET an object. `None` on 404; otherwise `(body, etag)`.
    async fn get(&self, key: &str) -> Result<Option<(Vec<u8>, String)>, AppError> {
        let resp = self.send("GET", key, &[], None, Vec::new()).await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let resp = check(resp, "GET", key).await?;
        let etag = etag_of(&resp);
        let body = resp
            .bytes()
            .await
            .map_err(|e| AppError::message(format!("GET {key}: {e}")))?;
        Ok(Some((body.to_vec(), etag)))
    }

    async fn put(
        &self,
        key: &str,
        body: Vec<u8>,
        condition: PutCondition,
    ) -> Result<PutOutcome, AppError> {
        let resp = self
            .send("PUT", key, &[], condition.header()?, body)
            .await?;
        if resp.status() == reqwest::StatusCode::PRECONDITION_FAILED {
            return Ok(PutOutcome::PreconditionFailed);
        }
        check(resp, "PUT", key).await?;
        Ok(PutOutcome::Ok)
    }

    async fn probe_conditional_writes(&self) -> Result<bool, AppError> {
        let key = format!(".sync-probe-{}", uuid::Uuid::new_v4().simple());
        let result = super::store::probe_conditions(self, &key).await;
        let cleanup = self.delete(&key).await;
        result.and_then(|supported| cleanup.map(|_| supported))
    }
}

/// AWS canonical URI encoding (unreserved chars pass through).
fn uri_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// HMAC-SHA256 (RFC 2104). Hand-rolled to reuse the crate's sha2 without
/// pulling a digest-version-matched `hmac` dependency.
fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for i in 0..64 {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(data);
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner);
    outer.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 4231 test case 2 (short key, "what do ya want for nothing?").
    #[test]
    fn hmac_sha256_matches_rfc_4231() {
        let out = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(
            hex::encode(out),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    /// RFC 4231 test case 3 (key/data of 0xaa/0xdd bytes).
    #[test]
    fn hmac_sha256_matches_rfc_4231_binary() {
        let out = hmac_sha256(&[0xaa; 20], &[0xdd; 50]);
        assert_eq!(
            hex::encode(out),
            "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe"
        );
    }

    #[test]
    fn uri_encode_escapes_reserved() {
        assert_eq!(uri_encode("a-b_c.d~e"), "a-b_c.d~e");
        assert_eq!(uri_encode("a b/c"), "a%20b%2Fc");
    }
}
