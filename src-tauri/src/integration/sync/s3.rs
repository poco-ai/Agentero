//! Minimal S3-compatible client — exactly what sync needs and nothing more:
//! GET / PUT (with conditional writes) / ListObjectsV2, signed with SigV4.
//!
//! Hand-rolled on reqwest + sha2 to avoid the AWS SDK dependency tree. The
//! sync protocol prefers `If-Match` / `If-None-Match` PUTs (S3, R2 and MinIO
//! all support them); backends that reject conditional writes with 400
//! NotImplemented (e.g. Aliyun OSS PutObject) are detected and degraded to
//! plain PUTs, trading strict concurrency safety for availability.

use crate::core::error::AppError;
use crate::core::http;
use crate::integration::sync::config::SyncBackendConfig;
use chrono::Utc;
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};

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
    /// Seeded from the persisted probe result; flipped off at runtime when a
    /// conditional PUT comes back 400 NotImplemented.
    conditional_writes: AtomicBool,
}

pub enum PutCondition {
    /// Create-only (`If-None-Match: *`).
    IfNoneMatch,
    /// Replace-only when unchanged (`If-Match: <etag>`).
    IfMatch(String),
}

#[derive(Debug, PartialEq, Eq)]
pub enum PutOutcome {
    Ok,
    /// The conditional write lost a race (412) — caller decides how to retry.
    PreconditionFailed,
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
            conditional_writes: AtomicBool::new(cfg.conditional_writes),
        })
    }

    /// Whether conditional writes are (still) assumed to work.
    pub fn supports_conditional_writes(&self) -> bool {
        self.conditional_writes.load(Ordering::Relaxed)
    }

    /// GET an object. `None` on 404; otherwise `(body, etag)`.
    pub async fn get(&self, key: &str) -> Result<Option<(Vec<u8>, String)>, AppError> {
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

    pub async fn put(
        &self,
        key: &str,
        body: Vec<u8>,
        condition: PutCondition,
    ) -> Result<PutOutcome, AppError> {
        let cond = if self.supports_conditional_writes() {
            match &condition {
                PutCondition::IfNoneMatch => Some(("If-None-Match", "*".to_string())),
                PutCondition::IfMatch(etag) => Some(("If-Match", etag.clone())),
            }
        } else {
            None
        };
        let resp = self
            .send(
                "PUT",
                key,
                &[],
                cond.as_ref().map(|(n, v)| (*n, v.clone())),
                body.clone(),
            )
            .await?;
        if resp.status() == reqwest::StatusCode::PRECONDITION_FAILED
            || resp.status() == reqwest::StatusCode::CONFLICT
        {
            return Ok(PutOutcome::PreconditionFailed);
        }
        if cond.is_some() && resp.status() == reqwest::StatusCode::BAD_REQUEST {
            let detail: String = resp
                .text()
                .await
                .unwrap_or_default()
                .chars()
                .take(300)
                .collect();
            if is_not_implemented(&detail) {
                // Backend (e.g. Aliyun OSS) does not implement conditional
                // writes: remember it for this client and retry as a plain
                // PUT. Blobs/manifests are content-addressed (idempotent);
                // the HEAD CAS degrades to GET → PUT, converging via the
                // engine's merge retries instead of atomic swap.
                log::warn!(
                    target: "agentero::sync",
                    "PUT {key}: backend lacks conditional writes; degrading to plain PUT"
                );
                self.conditional_writes.store(false, Ordering::Relaxed);
                let resp = self.send("PUT", key, &[], None, body).await?;
                check(resp, "PUT", key).await?;
                return Ok(PutOutcome::Ok);
            }
            return Err(AppError::message(format!("PUT {key}: 400 {detail}")));
        }
        check(resp, "PUT", key).await?;
        Ok(PutOutcome::Ok)
    }

    /// DELETE an object. 404 counts as success (idempotent cleanup).
    pub async fn delete(&self, key: &str) -> Result<(), AppError> {
        let resp = self.send("DELETE", key, &[], None, Vec::new()).await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(());
        }
        check(resp, "DELETE", key).await.map(|_| ())
    }

    /// Probe conditional-write support with a throwaway key before the first
    /// real sync: PUT it with `If-None-Match: *`, then clean up. `Ok(false)`
    /// when the backend answers 400 NotImplemented; unexpected answers fail
    /// open (the runtime fallback in `put` still catches them).
    pub async fn probe_conditional_writes(&self) -> Result<bool, AppError> {
        let key = format!(".sync-probe-{}", uuid::Uuid::new_v4().simple());
        let resp = self
            .send(
                "PUT",
                &key,
                &[],
                Some(("If-None-Match", "*".to_string())),
                Vec::new(),
            )
            .await?;
        let status = resp.status();
        if status.is_success() {
            if let Err(e) = self.delete(&key).await {
                log::warn!(target: "agentero::sync", "probe cleanup {key}: {e}");
            }
            return Ok(true);
        }
        if status == reqwest::StatusCode::BAD_REQUEST {
            let detail = resp.text().await.unwrap_or_default();
            if is_not_implemented(&detail) {
                return Ok(false);
            }
        }
        log::warn!(
            target: "agentero::sync",
            "conditional-write probe inconclusive ({status}); assuming supported"
        );
        Ok(true)
    }

    /// List up to `max` keys under `prefix` (relative to the configured
    /// prefix). Used as the connection test and by GC.
    pub async fn list(&self, prefix: &str, max: u32) -> Result<Vec<String>, AppError> {
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

        let canonical_request = format!(
            "{method}\n{uri}\n{canonical_query}\nhost:{}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n\nhost;x-amz-content-sha256;x-amz-date\n{payload_hash}",
            self.host
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
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature={signature}",
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

        // Every sync operation is idempotent (content-addressed blobs with
        // If-None-Match, CAS'd HEAD), so transient transport errors — stale
        // pooled connections, momentary container/port blips — are retried
        // instead of failing the whole pass.
        let mut last_err = None;
        let extra = extra_header.map(|(name, value)| (name, value.clone()));
        for attempt in 0..3u32 {
            if attempt > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(200 * attempt as u64)).await;
            }
            let mut req = self
                .http
                .request(method.clone(), url.clone())
                .header("x-amz-date", amz_date.clone())
                .header("x-amz-content-sha256", payload_hash.clone())
                .header("authorization", authorization.clone());
            if let Some((name, value)) = &extra {
                req = req.header(*name, value.clone());
            }
            if !body.is_empty() || method == reqwest::Method::PUT {
                req = req.body(body.clone());
            }
            match req.send().await {
                Ok(resp) => return Ok(resp),
                Err(e) if e.is_connect() || e.is_request() => {
                    log::warn!(
                        target: "agentero::sync",
                        "{method} {key} attempt {}: {e}",
                        attempt + 1
                    );
                    last_err = Some(e);
                }
                Err(e) => {
                    return Err(AppError::message(format!(
                        "{method} {key}: {}",
                        error_chain(&e)
                    )));
                }
            }
        }
        let e = last_err.expect("loop sets last_err before exiting");
        Err(AppError::message(format!(
            "{method} {key}: {}",
            error_chain(&e)
        )))
    }
}

/// reqwest's `Display` stops at the first source; walk the chain so transport
/// failures surface their real cause (connection reset, timeout, …).
fn error_chain(err: &reqwest::Error) -> String {
    let mut out = err.to_string();
    let mut source = std::error::Error::source(err);
    while let Some(s) = source {
        out.push_str(&format!(": {s}"));
        source = s.source();
    }
    out
}

/// OSS-style rejection of conditional headers: `400` with
/// `<Code>NotImplemented</Code>`. These PUTs carry no extra headers besides
/// the conditional one, so any NotImplemented implicates it; degrading on a
/// false positive is harmless (plain PUTs still work).
fn is_not_implemented(body: &str) -> bool {
    body.contains("NotImplemented")
}

async fn check(
    resp: reqwest::Response,
    op: &str,
    key: &str,
) -> Result<reqwest::Response, AppError> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let detail: String = body.chars().take(300).collect();
    Err(AppError::message(format!("{op} {key}: {status} {detail}")))
}

fn etag_of(resp: &reqwest::Response) -> String {
    resp.headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string()
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

    #[test]
    fn is_not_implemented_matches_oss_body() {
        let oss = r#"<Error><Code>NotImplemented</Code>
            <Message>A header you provided implies functionality that is not implemented.</Message>
            <Header>If-None-Match</Header></Error>"#;
        assert!(is_not_implemented(oss));
        assert!(!is_not_implemented(
            "<Error><Code>AccessDenied</Code></Error>"
        ));
    }
}
