//! Minimal WebDAV client — exactly what sync needs and nothing more: GET /
//! conditional PUT / DELETE / MKCOL, over Basic auth (works with Nutstore
//! app passwords, Nextcloud app tokens and NAS deployments alike).
//! Implements the [`RemoteStore`] contract; retry/error plumbing is shared
//! in `store.rs`.
//!
//! The HEAD protocol requires conditional writes. The opt-in journal writes
//! immutable records and blobs with plain PUT in a separate store.

use crate::error::AppError;
use crate::features::sync::config::{normalize_webdav_url, SyncBackendConfig};
use crate::features::sync::store::{
    check, etag_of, send_with_retries, LockOutcome, PutCondition, PutOutcome, RemoteStore,
    PUBLISH_LOCK_TTL_SECS,
};
use crate::http;
use std::collections::{BTreeSet, HashSet};
use std::sync::Mutex;

const PROPFIND_BODY: &[u8] = br#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>"#;

// A provider may return 750 rows including the collection itself with no
// continuation marker. The boundary applies to each directory independently.
pub(super) const JOURNAL_LIST_LIMIT: usize = 749;

/// Lock listing asks for the server clock (`getlastmodified`) so arbitration
/// never depends on client clock skew.
const PROPFIND_LOCKS_BODY: &[u8] = br#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>"#;

pub struct WebdavClient {
    http: reqwest::Client,
    /// `scheme://host[:port]` of the configured server directory URL.
    origin: String,
    /// Directory path segments below the origin, e.g. `["dav", "agentero"]`.
    dir: Vec<String>,
    username: String,
    password: String,
    /// Directory paths (decoded, `dav/agentero/blobs`) known to exist this
    /// session — WebDAV needs an explicit MKCOL before the first PUT into
    /// a directory, and the layout only ever uses a handful of them.
    known_dirs: Mutex<HashSet<String>>,
}

impl WebdavClient {
    pub(super) async fn journal_put(&self, key: &str, body: Vec<u8>) -> Result<(), AppError> {
        self.ensure_parent_dirs(key).await?;
        let response = self
            .send(reqwest::Method::PUT, &self.url_for(key), &[], body)
            .await?;
        check(response, "PUT", key).await.map(|_| ())
    }

    /// Only the successful creator of this collection may initialize vault.json.
    pub(super) async fn create_journal(&self) -> Result<(), AppError> {
        if !self.list_collection("").await?.is_empty() {
            return Err(AppError::message(
                "initialize the WebDAV journal in an empty directory",
            ));
        }
        let url = format!("{}/", self.url_for("manifests"));
        let response = self.send(method("MKCOL")?, &url, &[], Vec::new()).await?;
        if response.status() != reqwest::StatusCode::CREATED {
            return Err(AppError::message(format!(
                "journal initialization did not acquire the collection ({})",
                response.status()
            )));
        }
        Ok(())
    }

    pub(super) async fn list_journal_records(&self) -> Result<BTreeSet<String>, AppError> {
        let invalid = || AppError::message("unexpected WebDAV journal entry");
        let mut records = BTreeSet::new();
        for bucket in self.list_collection("manifests").await? {
            if bucket.len() != 1 || !bucket.bytes().all(lower_hex) {
                return Err(invalid());
            }
            for name in self.list_collection(&format!("manifests/{bucket}")).await? {
                let id = name
                    .strip_suffix(".json")
                    .filter(|id| {
                        id.starts_with(&bucket) && id.len() == 64 && id.bytes().all(lower_hex)
                    })
                    .ok_or_else(invalid)?;
                records.insert(id.to_owned());
            }
        }
        Ok(records)
    }

    pub(super) async fn test_journal(&self) -> Result<(), AppError> {
        self.list_journal_records().await?;
        let key = format!(".sync-probe-{}", uuid::Uuid::new_v4().simple());
        self.journal_put(&key, b"journal".to_vec()).await?;
        let read = self.get(&key).await;
        self.delete(&key).await?;
        if read?.is_none_or(|(body, _)| body != b"journal") {
            return Err(AppError::message(
                "WebDAV journal probe could not read its upload",
            ));
        }
        Ok(())
    }

    pub(super) async fn journal_record(
        &self,
        key: &str,
        limit: usize,
    ) -> Result<Vec<u8>, AppError> {
        let response = self
            .send(reqwest::Method::GET, &self.url_for(key), &[], Vec::new())
            .await?;
        read_limited(check(response, "GET", key).await?, limit).await
    }

    async fn list_collection(&self, key: &str) -> Result<BTreeSet<String>, AppError> {
        let url = format!("{}/", self.url_for(key).trim_end_matches('/'));
        let response = self
            .send(
                method("PROPFIND")?,
                &url,
                &[("Depth", "1".into())],
                PROPFIND_BODY.to_vec(),
            )
            .await?;
        if response.status() != reqwest::StatusCode::MULTI_STATUS {
            return Err(AppError::message(format!(
                "incomplete WebDAV listing ({})",
                response.status()
            )));
        }
        let bytes = read_limited(response, 4 * 1024 * 1024).await?;
        collection_entries(&url, &bytes)
    }

    pub fn new(cfg: &SyncBackendConfig) -> Result<Self, AppError> {
        // `normalized()` only runs on save; re-normalize so configs persisted
        // before the Jianguoyun-root expansion exist are healed on read.
        let url = url::Url::parse(&normalize_webdav_url(&cfg.webdav_url))
            .map_err(|e| AppError::message(format!("invalid WebDAV URL: {e}")))?;
        // `scheme://host[:port]` without the path or query.
        let origin = url[..url::Position::BeforePath].to_string();
        let dir = url
            .path()
            .split('/')
            .filter(|s| !s.is_empty())
            .map(percent_decode)
            .collect();
        Ok(Self {
            http: http::client_builder()
                .build()
                .map_err(|e| AppError::message(e.to_string()))?,
            origin,
            dir,
            username: cfg.webdav_username.trim().to_string(),
            password: cfg.webdav_password.clone(),
            known_dirs: Mutex::new(HashSet::new()),
        })
    }

    /// DELETE an object. 404 counts as success (idempotent cleanup).
    async fn delete(&self, key: &str) -> Result<(), AppError> {
        let resp = self
            .send(method("DELETE")?, &self.url_for(key), &[], Vec::new())
            .await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(());
        }
        check(resp, "DELETE", key).await.map(|_| ())
    }

    /// Decoded directory paths from the origin down to the configured dir.
    fn dir_paths(&self) -> Vec<String> {
        let mut out = Vec::with_capacity(self.dir.len());
        let mut acc = String::new();
        for seg in &self.dir {
            if !acc.is_empty() {
                acc.push('/');
            }
            acc.push_str(seg);
            out.push(acc.clone());
        }
        out
    }

    /// Create every not-yet-known directory of `dirs` (ancestors first).
    async fn mkcol_dirs(&self, dirs: &[String]) -> Result<(), AppError> {
        let mkcol = method("MKCOL")?;
        for dir in dirs {
            if dir.is_empty() || self.dir_known(dir) {
                continue;
            }
            // Trailing slash: the canonical collection form.
            let url = format!("{}/", self.url_for_dir(dir));
            let resp = self.send(mkcol.clone(), &url, &[], Vec::new()).await?;
            let status = resp.status();
            if status.is_success()
                || status == reqwest::StatusCode::METHOD_NOT_ALLOWED
                || status == reqwest::StatusCode::FORBIDDEN
            {
                // 405 = exists. 403 = exists but protected (Nutstore answers
                // MKCOL on its `/dav` root with OperationNotAllowed); a truly
                // read-only location fails loudly on the next PUT instead.
                if let Ok(mut set) = self.known_dirs.lock() {
                    set.insert(dir.clone());
                }
                continue;
            }
            return check(resp, "MKCOL", dir).await.map(|_| ());
        }
        Ok(())
    }

    async fn ensure_parent_dirs(&self, key: &str) -> Result<(), AppError> {
        let segs: Vec<&str> = key.split('/').filter(|s| !s.is_empty()).collect();
        let mut dirs = self.dir_paths();
        let mut acc = dirs.last().cloned().unwrap_or_default();
        for seg in &segs[..segs.len().saturating_sub(1)] {
            if acc.is_empty() {
                acc = (*seg).to_string();
            } else {
                acc = format!("{acc}/{seg}");
            }
            dirs.push(acc.clone());
        }
        // The longest needed directory existing implies its ancestors do too.
        if dirs.last().map(|d| self.dir_known(d)).unwrap_or(true) {
            return Ok(());
        }
        self.mkcol_dirs(&dirs).await
    }

    fn remember_dirs(&self, dirs: &[String]) {
        if let Ok(mut set) = self.known_dirs.lock() {
            set.extend(dirs.iter().cloned());
        }
    }

    fn dir_known(&self, dir: &str) -> bool {
        self.known_dirs
            .lock()
            .map(|set| set.contains(dir))
            .unwrap_or(false)
    }

    /// URL of the configured server directory (collection form).
    fn dir_url(&self) -> String {
        format!("{}/", self.url_for_dir(&self.dir.join("/")))
    }

    /// URL of a decoded directory path relative to the origin.
    fn url_for_dir(&self, dir: &str) -> String {
        let mut url = self.origin.clone();
        for seg in dir.split('/').filter(|s| !s.is_empty()) {
            url.push('/');
            url.push_str(&encode_path_segment(seg));
        }
        url
    }

    /// URL of a store key (`blobs/ab/<sha>` → origin + dir + segments).
    fn url_for(&self, key: &str) -> String {
        let mut url = self.url_for_dir(&self.dir.join("/"));
        for seg in key.split('/').filter(|s| !s.is_empty()) {
            url.push('/');
            url.push_str(&encode_path_segment(seg));
        }
        url
    }

    /// Send one authenticated request; transport-level retries live in
    /// `send_with_retries`.
    async fn send(
        &self,
        method: reqwest::Method,
        url: &str,
        headers: &[(&str, String)],
        body: Vec<u8>,
    ) -> Result<reqwest::Response, AppError> {
        send_with_retries(&method, url, || {
            let mut req = self
                .http
                .request(method.clone(), url)
                .basic_auth(&self.username, Some(&self.password));
            for (name, value) in headers {
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

impl RemoteStore for WebdavClient {
    /// Connection test: PROPFIND the configured directory, creating it (and
    /// its parents) when missing so users can point at one that does not
    /// exist yet. Auth failures surface as errors from `check`.
    async fn ensure_root(&self) -> Result<(), AppError> {
        let resp = self
            .send(
                method("PROPFIND")?,
                &self.dir_url(),
                &[("Depth", "0".to_string())],
                PROPFIND_BODY.to_vec(),
            )
            .await?;
        match resp.status() {
            reqwest::StatusCode::MULTI_STATUS => {
                self.remember_dirs(&self.dir_paths());
                Ok(())
            }
            reqwest::StatusCode::NOT_FOUND => self.mkcol_dirs(&self.dir_paths()).await,
            _ => check(resp, "PROPFIND", &self.dir.join("/"))
                .await
                .map(|_| ()),
        }
    }

    /// GET an object. `None` on 404; otherwise `(body, etag)`.
    async fn get(&self, key: &str) -> Result<Option<(Vec<u8>, String)>, AppError> {
        let resp = self
            .send(method("GET")?, &self.url_for(key), &[], Vec::new())
            .await?;
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
        self.ensure_parent_dirs(key).await?;
        let headers: Vec<(&str, String)> = condition.header()?.into_iter().collect();
        let resp = self
            .send(method("PUT")?, &self.url_for(key), &headers, body)
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

    /// Joplin-style soft lock: PUT this device's lock file, list `locks/`,
    /// and let deterministic arbitration (oldest live lock wins, ties by
    /// device id) decide the holder. Only needs PUT + PROPFIND — both work
    /// on servers that ignore conditional headers (fnOS built-in WebDAV).
    async fn try_acquire_publish_lock(&self, device_id: &str) -> Result<LockOutcome, AppError> {
        let key = lock_key(device_id)?;
        self.ensure_parent_dirs(&key).await?;
        let body = serde_json::to_vec(&LockInfo {
            device_id: device_id.to_string(),
            acquired_at: crate::time::now_rfc3339_millis(),
        })?;
        self.put(&key, body, PutCondition::Unconditional).await?;
        let listed = self.list_locks().await;
        let candidates = match listed {
            Ok(c) => c,
            Err(e) => {
                // Cannot arbitrate without a listing; leave no lock behind.
                let _ = self.delete(&key).await;
                return Err(e);
            }
        };
        let now = chrono::Utc::now().timestamp();
        match arbitrate_locks(&candidates, now, PUBLISH_LOCK_TTL_SECS) {
            Some(winner) if winner == device_id => Ok(LockOutcome::Acquired),
            _ => {
                let _ = self.delete(&key).await;
                Ok(LockOutcome::Busy)
            }
        }
    }

    async fn release_publish_lock(&self, device_id: &str) -> Result<(), AppError> {
        self.delete(&lock_key(device_id)?).await
    }
}

/// One lock file's arbitration evidence: device id plus its timestamp in
/// server-clock seconds (PROPFIND `getlastmodified`), falling back to the
/// lock content's `acquiredAt` when the server omits the property.
struct LockCandidate {
    device_id: String,
    ts: i64,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LockInfo {
    device_id: String,
    acquired_at: String,
}

/// Lock files live at `locks/<deviceId>.json`; the id is a persisted UUID,
/// but validate anyway so a hostile value cannot escape the directory.
fn lock_key(device_id: &str) -> Result<String, AppError> {
    if device_id.is_empty()
        || device_id.len() > 64
        || !device_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(AppError::message("invalid sync device id"));
    }
    Ok(format!("locks/{device_id}.json"))
}

/// Deterministic winner among live locks: oldest timestamp first, ties by
/// lexicographic device id. Expired locks are ignored. Pure so arbitration
/// is unit-testable without HTTP.
fn arbitrate_locks(candidates: &[LockCandidate], now: i64, ttl: i64) -> Option<String> {
    candidates
        .iter()
        .filter(|c| now.saturating_sub(c.ts) < ttl && c.ts <= now.saturating_add(ttl))
        .min_by(|a, b| a.ts.cmp(&b.ts).then_with(|| a.device_id.cmp(&b.device_id)))
        .map(|c| c.device_id.clone())
}

impl WebdavClient {
    /// PROPFIND Depth:1 over `locks/`, reduced to arbitration candidates.
    async fn list_locks(&self) -> Result<Vec<LockCandidate>, AppError> {
        let url = format!("{}/", self.url_for("locks"));
        let resp = self
            .send(
                method("PROPFIND")?,
                &url,
                &[("Depth", "1".to_string())],
                PROPFIND_LOCKS_BODY.to_vec(),
            )
            .await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(Vec::new());
        }
        let resp = check(resp, "PROPFIND", "locks").await?;
        let xml = resp
            .text()
            .await
            .map_err(|e| AppError::message(format!("PROPFIND locks: {e}")))?;
        let mut out = Vec::new();
        let doc = roxmltree::Document::parse(&xml)
            .map_err(|e| AppError::message(format!("PROPFIND locks: invalid XML: {e}")))?;
        for response in doc.descendants().filter(|n| n.has_tag_name("response")) {
            let href = response
                .children()
                .find(|n| n.has_tag_name("href"))
                .and_then(|n| n.text())
                .unwrap_or_default();
            // The collection itself and anything but lock files are noise.
            if href.ends_with('/') {
                continue;
            }
            let name = percent_decode(href.rsplit('/').find(|s| !s.is_empty()).unwrap_or_default());
            let Some(device_id) = name.strip_suffix(".json") else {
                continue;
            };
            if lock_key(device_id).is_err() {
                continue;
            }
            let mtime = response
                .descendants()
                .find(|n| n.has_tag_name("getlastmodified"))
                .and_then(|n| n.text())
                .and_then(parse_http_date);
            let ts = match mtime {
                Some(ts) => ts,
                None => {
                    // Server omits getlastmodified: fall back to the lock's
                    // own content timestamp (client clock; documented risk).
                    let key = format!("locks/{name}");
                    match self.get(&key).await? {
                        Some((bytes, _)) => serde_json::from_slice::<LockInfo>(&bytes)
                            .ok()
                            .and_then(|info| {
                                chrono::DateTime::parse_from_rfc3339(&info.acquired_at).ok()
                            })
                            .map(|dt| dt.timestamp())
                            .unwrap_or(0),
                        None => continue,
                    }
                }
            };
            out.push(LockCandidate {
                device_id: device_id.to_string(),
                ts,
            });
        }
        Ok(out)
    }
}

/// IMF-fixdate (`Sun, 06 Nov 1994 08:49:37 GMT`) as RFC 4918 requires;
/// RFC 2822 (`+0000`) as a lenient second chance.
fn parse_http_date(value: &str) -> Option<i64> {
    let value = value.trim();
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(value, "%a, %d %b %Y %H:%M:%S GMT") {
        return Some(dt.and_utc().timestamp());
    }
    chrono::DateTime::parse_from_rfc2822(value)
        .ok()
        .map(|dt| dt.timestamp())
}

async fn read_limited(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, AppError> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| AppError::message(e.to_string()))?
    {
        if chunk.len() > limit - bytes.len() {
            return Err(AppError::message("WebDAV journal response too large"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn lower_hex(b: u8) -> bool {
    matches!(b, b'0'..=b'9' | b'a'..=b'f')
}

fn collection_entries(url: &str, bytes: &[u8]) -> Result<BTreeSet<String>, AppError> {
    let invalid = || AppError::message("incomplete WebDAV directory listing");
    let document = roxmltree::Document::parse(std::str::from_utf8(bytes).map_err(|_| invalid())?)
        .map_err(|_| invalid())?;
    let root = document.root_element();
    let base = url::Url::parse(url).map_err(|_| invalid())?;
    let dav = |tag| ("DAV:", tag);
    if !root.has_tag_name(dav("multistatus")) {
        return Err(invalid());
    }
    let mut names = BTreeSet::new();
    let mut saw_self = false;
    for row in root.children().filter(|n| n.is_element()) {
        if !row.has_tag_name(dav("response")) {
            return Err(invalid());
        }
        let href = row
            .children()
            .find(|n| n.has_tag_name(dav("href")))
            .and_then(|n| n.text())
            .ok_or_else(invalid)?;
        let target = base.join(href).map_err(|_| invalid())?;
        if target.origin() != base.origin()
            || target.query().is_some()
            || target.fragment().is_some()
        {
            return Err(invalid());
        }
        let kind = row
            .children()
            .filter(|n| n.has_tag_name(dav("propstat")))
            .find_map(|stat| {
                let status = stat
                    .children()
                    .find(|n| n.has_tag_name(dav("status")))?
                    .text()?;
                if status.split_whitespace().nth(1) != Some("200") {
                    return None;
                }
                stat.children()
                    .find(|n| n.has_tag_name(dav("prop")))?
                    .children()
                    .find(|n| n.has_tag_name(dav("resourcetype")))
            })
            .ok_or_else(invalid)?;
        if target.path().trim_end_matches('/') == base.path().trim_end_matches('/') {
            if saw_self || !kind.children().any(|n| n.has_tag_name(dav("collection"))) {
                return Err(invalid());
            }
            saw_self = true;
        } else {
            let name = target
                .path()
                .trim_end_matches('/')
                .strip_prefix(base.path())
                .filter(|s| !s.is_empty() && !s.contains('/'))
                .ok_or_else(invalid)?;
            if !names.insert(name.to_owned()) {
                return Err(invalid());
            }
        }
    }
    // Nutstore can cap a successful multistatus at 750 rows including self.
    // Without a continuation guarantee this prototype refuses the entire pass.
    if !saw_self {
        return Err(invalid());
    }
    if names.len() >= JOURNAL_LIST_LIMIT {
        return Err(AppError::message(
            "WebDAV directory listing may be truncated at 750 rows",
        ));
    }
    Ok(names)
}

fn method(name: &str) -> Result<reqwest::Method, AppError> {
    reqwest::Method::from_bytes(name.as_bytes()).map_err(|e| AppError::message(e.to_string()))
}

/// Percent-encode one path segment (unreserved chars pass through; `/` is
/// never part of a segment here, but encoding it keeps hostile manifest
/// paths from escaping the directory). Kept separate from the S3 client's
/// SigV4 canonical encoder: same charset today, different specs to follow.
fn encode_path_segment(s: &str) -> String {
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

/// Percent-decode a path segment: `Url::parse` hands us already-encoded
/// input, so `new` normalizes back to raw segments for symmetric encoding.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |b: u8| (b as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client(url: &str) -> WebdavClient {
        WebdavClient::new(&SyncBackendConfig {
            backend: crate::features::sync::config::SyncBackendKind::Webdav,
            webdav_url: url.into(),
            webdav_username: "u".into(),
            webdav_password: "p".into(),
            ..SyncBackendConfig::default()
        })
        .unwrap()
    }

    #[test]
    fn parses_origin_and_dir_segments() {
        let c = client("https://dav.jianguoyun.com/dav/agentero/");
        assert_eq!(c.origin, "https://dav.jianguoyun.com");
        assert_eq!(c.dir, vec!["dav".to_string(), "agentero".to_string()]);
        assert_eq!(
            c.url_for("HEAD"),
            "https://dav.jianguoyun.com/dav/agentero/HEAD"
        );
        assert_eq!(
            c.url_for("blobs/ab/hash"),
            "https://dav.jianguoyun.com/dav/agentero/blobs/ab/hash"
        );
    }

    #[test]
    fn jianguoyun_root_url_is_expanded_to_the_reserved_folder() {
        let c = client("https://dav.jianguoyun.com/dav/");
        assert_eq!(c.dir, vec!["dav".to_string(), "agentero".to_string()]);
        assert_eq!(
            c.url_for("vault.json"),
            "https://dav.jianguoyun.com/dav/agentero/vault.json"
        );
    }

    #[test]
    fn server_root_url_has_no_dir_segments() {
        let c = client("https://example.com");
        assert!(c.dir.is_empty());
        assert_eq!(c.url_for("HEAD"), "https://example.com/HEAD");
    }

    #[test]
    fn port_and_ipv6_loopback_survive_origin_parsing() {
        let c = client("http://127.0.0.1:5005/agentero");
        assert_eq!(c.origin, "http://127.0.0.1:5005");
        let c = client("http://[::1]:5005/agentero");
        assert_eq!(c.origin, "http://[::1]:5005");
    }

    #[test]
    fn segments_are_percent_encoded() {
        let c = client("https://example.com/my dir");
        assert_eq!(c.url_for("a b"), "https://example.com/my%20dir/a%20b");
    }

    #[test]
    fn encode_path_segment_escapes_reserved() {
        assert_eq!(encode_path_segment("a-b_c.d~e"), "a-b_c.d~e");
        assert_eq!(encode_path_segment("a b/c"), "a%20b%2Fc");
    }
}
